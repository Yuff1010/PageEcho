"""Opt-in, read-only process sampler for a known Electron acceptance-test PID."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--stop', required=True)
    parser.add_argument('--maximum-seconds', type=int, default=1200)
    args = parser.parse_args()
    import psutil
    root = psutil.Process(args.pid)
    identity = root.create_time()
    output = Path(args.output)
    stop = Path(args.stop)
    report = {'status': 'running', 'pid': args.pid, 'targetIntervalMs': 500,
              'rssScope': 'sum of sampled RSS for the supplied application PID and recursive descendants; shared pages can be counted more than once',
              'cpuScope': 'percent per logical CPU; one busy core is 100 percent',
              'gpuScope': 'whole device 0; includes desktop and other applications; polled at most once per second with command overhead',
              'peakSampledRssBytes': 0, 'peakSampledPythonRssBytes': 0,
              'peakWholeGpuMiB': None, 'gpuSamples': 0, 'samples': 0,
              'startedAt': datetime.now(timezone.utc).isoformat(), 'processes': {}}
    nvidia = Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/nvidia-smi.exe'
    started, next_gpu = time.monotonic(), 0
    known = {}
    with output.with_suffix('.jsonl').open('x', encoding='utf-8') as stream:
        while time.monotonic() - started < args.maximum_seconds:
            if stop.exists():
                report['status'] = 'completed'
                break
            try:
                if not root.is_running() or root.create_time() != identity:
                    report['status'] = 'target-exited'
                    break
                processes = [root, *root.children(recursive=True)]
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                report['status'] = 'target-unavailable'
                break
            rows = []
            for process in processes:
                try:
                    key = f'{process.pid}:{process.create_time()}'
                    if key not in known:
                        known[key] = process
                        process.cpu_percent()
                    else:
                        process = known[key]
                    name = process.name()
                    rss, cpu = process.memory_info().rss, process.cpu_percent()
                    row = {'pid': process.pid, 'name': name, 'rssBytes': rss, 'cpuPercentPerCore': cpu}
                    rows.append(row)
                    old = report['processes'].setdefault(key, {'pid': process.pid, 'name': name, 'peakSampledRssBytes': 0, 'peakSampledCpuPercentPerCore': 0})
                    old['peakSampledRssBytes'] = max(old['peakSampledRssBytes'], rss)
                    old['peakSampledCpuPercentPerCore'] = max(old['peakSampledCpuPercentPerCore'], cpu)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            report['peakSampledRssBytes'] = max(report['peakSampledRssBytes'], sum(row['rssBytes'] for row in rows))
            report['peakSampledPythonRssBytes'] = max(report['peakSampledPythonRssBytes'], sum(row['rssBytes'] for row in rows if row['name'].lower().startswith('python')))
            elapsed = time.monotonic() - started
            if elapsed >= next_gpu and nvidia.is_file():
                next_gpu = elapsed + 1
                try:
                    result = subprocess.run([str(nvidia), '--query-gpu=memory.used', '--format=csv,noheader,nounits', '-i', '0'], capture_output=True, text=True, timeout=2,
                                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                    if result.returncode == 0:
                        used = int(result.stdout.strip())
                        report['peakWholeGpuMiB'] = max(report['peakWholeGpuMiB'] or 0, used)
                        report['gpuSamples'] += 1
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            stream.write(json.dumps({'elapsedMs': round(elapsed * 1000), 'processes': rows}) + '\n')
            stream.flush()
            report['samples'] += 1
            time.sleep(0.5)
        else:
            report['status'] = 'time-limit'
    report['elapsedMs'] = round((time.monotonic() - started) * 1000)
    report['finishedAt'] = datetime.now(timezone.utc).isoformat()
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'samples': report['samples']}), flush=True)


if __name__ == '__main__':
    main()
