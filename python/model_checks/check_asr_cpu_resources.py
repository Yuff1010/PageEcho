"""Bounded real Paraformer CPU 4-vs-1 resource measurement; no ASR quality claim."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asr_jobs import FFmpegDecoder
from asr_resources import configure_cpu_environment
from asr_runtime import configure_cache


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run_worker(root, assets, output, sample, threads):
    import psutil
    directory = output / ('threads-' + str(threads))
    directory.mkdir()
    command = [str(assets['python']), '-B', '-X', 'utf8', str(root / 'python/asr_worker.py'),
               '--cache', str(directory / 'cache'), '--models', str(assets['models']),
               '--resources', str(assets['resources']), '--ffmpeg', str(assets['ffmpeg']),
               '--ffprobe', str(assets['ffprobe']), '--engine', 'paraformer', '--device', 'cpu',
               '--compute', 'int8', '--cpu-threads', str(threads)]
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONUNBUFFERED': '1'}
    started = time.perf_counter()
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, encoding='utf-8', cwd=str(root), env=env,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    process = psutil.Process(child.pid)
    events, messages = queue.Queue(), []
    errors = []
    stopped = threading.Event()
    sampling = {'peakTreeRssBytes': 0, 'peakWorkerRssBytes': 0, 'peakTreePrivateBytes': None,
                'peakWorkerOsThreads': 0, 'sampleCount': 0, 'observedCpuSecondsByProcess': {}}

    def stdout():
        with (directory / 'stdout.jsonl').open('w', encoding='utf-8') as stream:
            for line in child.stdout:
                stream.write(line)
                stream.flush()
                try:
                    value = json.loads(line)
                except ValueError:
                    events.put({'type': 'invalid-protocol', 'raw': line})
                    continue
                value['_observedWallMs'] = round((time.perf_counter() - started) * 1000)
                messages.append(value)
                events.put(value)

    def stderr():
        with (directory / 'stderr.log').open('w', encoding='utf-8') as stream:
            for line in child.stderr:
                stream.write(line)
                stream.flush()

    def sample_processes():
        with (directory / 'resources.jsonl').open('w', encoding='utf-8') as stream:
            while not stopped.is_set():
                try:
                    processes = [process, *process.children(recursive=True)]
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    break
                rows = []
                for item in processes:
                    try:
                        memory, cpu = item.memory_info(), item.cpu_times()
                        key = str(item.pid) + ':' + str(item.create_time())
                        cpu_seconds = cpu.user + cpu.system
                        sampling['observedCpuSecondsByProcess'][key] = cpu_seconds
                        rows.append({'pid': item.pid, 'name': item.name(), 'rssBytes': memory.rss,
                                     'privateBytes': getattr(memory, 'private', None), 'cpuSeconds': cpu_seconds,
                                     'osThreads': item.num_threads()})
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                sampling['peakTreeRssBytes'] = max(sampling['peakTreeRssBytes'], sum(item['rssBytes'] for item in rows))
                own = next((item for item in rows if item['pid'] == child.pid), None)
                if own:
                    sampling['peakWorkerRssBytes'] = max(sampling['peakWorkerRssBytes'], own['rssBytes'])
                    sampling['peakWorkerOsThreads'] = max(sampling['peakWorkerOsThreads'], own['osThreads'])
                if rows and all(item['privateBytes'] is not None for item in rows):
                    sampling['peakTreePrivateBytes'] = max(sampling['peakTreePrivateBytes'] or 0,
                                                         sum(item['privateBytes'] for item in rows))
                sampling['sampleCount'] += 1
                stream.write(json.dumps({'wallMs': round((time.perf_counter() - started) * 1000), 'processes': rows}) + '\n')
                stream.flush()
                stopped.wait(0.1)

    readers = [threading.Thread(target=stdout), threading.Thread(target=stderr), threading.Thread(target=sample_processes)]
    for reader in readers:
        reader.start()
    result = {'threads': threads, 'pid': child.pid, 'command': command, 'resourceSampling': sampling}

    def next_event(deadline):
        while time.perf_counter() < deadline:
            try:
                value = events.get(timeout=0.2)
            except queue.Empty:
                if child.poll() is not None:
                    raise RuntimeError('Worker exited before terminal event')
                continue
            if value['type'] in ('fatal', 'error', 'invalid-protocol'):
                raise RuntimeError(json.dumps(value, ensure_ascii=False))
            return value
        raise TimeoutError('Bounded CPU resource smoke exceeded its deadline')

    def worker_cpu():
        value = process.cpu_times()
        return value.user + value.system

    try:
        deadline = started + 180
        while True:
            value = next_event(deadline)
            if value['type'] == 'ready':
                result['configuration'] = value['configuration']
                assert value['configuration']['threads'] == threads
                assert 'executionResources' not in value['configuration']
                break
        request = {'protocolVersion': 1, 'type': 'submit', 'jobId': str(uuid.uuid4()), 'attempt': 1,
                   'audioPath': sample['path'], 'audioHash': sample['audioHash'],
                   'range': {'startMs': 0, 'endMs': 30000}, 'priorityMs': 0}
        (directory / 'request.json').write_text(json.dumps(request, ensure_ascii=False) + '\n', encoding='utf-8')
        submitted, initial_cpu = time.perf_counter(), worker_cpu()
        child.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
        child.stdin.flush()
        recognizing, recognizing_cpu = None, None
        while True:
            value = next_event(deadline)
            if value['type'] == 'progress' and value.get('stage') == 'recognizing':
                recognizing, recognizing_cpu = time.perf_counter(), worker_cpu()
            if value['type'] == 'result':
                result['coldResult'] = value
                result['submitToResultMs'] = round((time.perf_counter() - submitted) * 1000)
                result['spawnToResultMs'] = round((time.perf_counter() - started) * 1000)
                result['workerCpuSecondsSubmitToResult'] = worker_cpu() - initial_cpu
                result['workerCpuSecondsFromSpawnAtResult'] = worker_cpu()
                result['recognizingPhaseWallMs'] = round((time.perf_counter() - recognizing) * 1000) if recognizing is not None else None
                result['workerCpuSecondsRecognizingPhase'] = worker_cpu() - recognizing_cpu if recognizing_cpu is not None else None
                assert value['cacheHits'] == 0 and value['totalChunks'] == 1
                assert value['document']['coverage'] == [{'startMs': 0, 'endMs': 30000}]
                actual = value['executionResources']
                assert actual['requestedCpuThreads'] == threads and actual['torchThreads'] == threads
                if threads < 4:
                    assert actual['torchInteropThreads'] == 1
                result['actualExecutionResources'] = actual
                break
        time.sleep(1)
        result['idleOneSecondWorkerRssBytes'] = process.memory_info().rss
        # A complete cache replay adds no second model inference or decode.
        replay = {**request, 'jobId': str(uuid.uuid4())}
        replay_started, replay_events = time.perf_counter(), []
        child.stdin.write(json.dumps(replay, ensure_ascii=False) + '\n')
        child.stdin.flush()
        while True:
            value = next_event(deadline)
            replay_events.append(value)
            if value['type'] == 'result':
                result['cachedReplayMs'] = round((time.perf_counter() - replay_started) * 1000)
                assert value['cacheHits'] == 1 and value['cacheKey'] == result['coldResult']['cacheKey']
                assert value['document'] == result['coldResult']['document']
                assert not any(event.get('stage') in ('decoding', 'loading', 'recognizing') for event in replay_events)
                result['cachedReplayCacheHits'] = value['cacheHits']
                break
        result['status'] = 'passed'
    except Exception as error:
        result['status'], result['error'] = 'failed', str(error)
        errors.append(str(error))
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            if os.name == 'nt':
                subprocess.run(['taskkill.exe', '/PID', str(child.pid), '/T', '/F'], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                child.kill()
            child.wait(timeout=5)
        stopped.set()
        for reader in readers:
            reader.join(timeout=5)
        result['returnCode'] = child.returncode
        result['messages'] = messages
        result['ownedWorkerExited'] = not psutil.pid_exists(child.pid)
        (directory / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if errors:
        raise RuntimeError(errors[0])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    component_path = Path(args.component).resolve()
    component = json.loads(component_path.read_text(encoding='utf-8'))
    assets = {key: (component_path.parent / component[key]).resolve()
              for key in ('python', 'models', 'resources', 'ffmpeg', 'ffprobe')}
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    configure_cpu_environment(4)
    configure_cache(output / 'driver-cache', assets['ffmpeg'].parent, assets['resources'])
    manifest_path = root / 'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    sample = manifest['samples'][0]
    if digest(sample['path']) != sample['audioHash']:
        raise ValueError('Frozen source audio changed')
    (output / 'sources').mkdir()
    for path in (root / 'python').glob('asr_*.py'):
        shutil.copyfile(path, output / 'sources' / path.name)
    shutil.copyfile(root / 'python/evaluation-models.json', output / 'sources/evaluation-models.json')
    shutil.copyfile(__file__, output / 'sources' / Path(__file__).name)
    report = {'status': 'running', 'preparedAt': datetime.now(timezone.utc).isoformat(),
              'sourceManifest': str(manifest_path), 'manifestSha256': digest(manifest_path),
              'sample': {'id': sample['id'], 'path': sample['path'], 'audioHash': sample['audioHash'],
                         'range': {'startMs': 0, 'endMs': 30000}},
              'engine': 'paraformer', 'device': 'cpu', 'order': [4, 1],
              'scope': 'one 30s source, one new process per profile, fresh inference cache; OS file cache is not flushed, no statistical speed/quality claim',
              'cpuScope': 'worker process CPU seconds at observed stages; sampled child CPU/RSS include only observed descendants',
              'memoryScope': '100ms sampled RSS/private process-tree peaks; shared RSS pages may count more than once; sampling can miss spikes',
              'logicalCpus': os.cpu_count(), 'decoded': {}, 'runs': []}
    target = output / 'report.json'
    try:
        for threads in (4, 1):
            decoder = FFmpegDecoder(assets['ffmpeg'], assets['ffprobe'], cpu_threads=threads)
            audio = decoder.decode(Path(sample['path']), {'decodeStartMs': 0, 'decodeEndMs': 30000}, threading.Event())
            report['decoded'][str(threads)] = {'samples': len(audio), 'pcmFloat32Sha256': hashlib.sha256(audio.tobytes()).hexdigest()}
            run = run_worker(root, assets, output, sample, threads)
            report['runs'].append(run)
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps({'threads': threads, 'status': run['status'], 'actual': run['actualExecutionResources'],
                              'wallMs': run['submitToResultMs'], 'cpuSeconds': run['workerCpuSecondsSubmitToResult'],
                              'peakRssBytes': run['resourceSampling']['peakTreeRssBytes']}), flush=True)
        report['decodedPcmIdentical'] = report['decoded']['1'] == report['decoded']['4']
        report['documentsIdentical'] = report['runs'][0]['coldResult']['document'] == report['runs'][1]['coldResult']['document']
        report['cacheKeysDifferent'] = report['runs'][0]['coldResult']['cacheKey'] != report['runs'][1]['coldResult']['cacheKey']
        report['sourceHashes'] = {path.name: digest(path) for path in (output / 'sources').iterdir()}
        report['productionSourcesUnchangedDuringRun'] = all(digest(root / 'python' / name) == value for name, value in report['sourceHashes'].items()
                                                           if name.startswith('asr_') or name == 'evaluation-models.json')
        report['status'] = 'passed' if report['decodedPcmIdentical'] and report['cacheKeysDifferent'] and report['productionSourcesUnchangedDuringRun'] else 'failed'
    finally:
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'report': str(target), 'documentsIdentical': report.get('documentsIdentical')}), flush=True)


if __name__ == '__main__':
    main()
