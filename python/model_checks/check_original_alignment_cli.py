"""Actual fixed-script CPU/CUDA JSON protocol smoke, not a quality benchmark."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import wave


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


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
    manifest_path = root / 'cache/asr-evaluation/public-reference/aishell3-studio/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    # Already-supported calibration input is deliberate: smoke proves the
    # fixed script/runtime/protocol, and is not an extra accuracy denominator.
    sample = next(value for value in manifest['samples'] if value['id'] == 'aishell3-SSB17110159')
    if digest(sample['path']) != sample['audioHash']:
        raise ValueError('Frozen positive audio changed')
    silence = output / 'silence.wav'
    with wave.open(str(silence), 'wb') as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(b'\0' * 32000 * 3)
    request = {'protocolVersion': 1, 'requestId': 'correct-cuda', 'audioPath': sample['path'],
               'audioHash': sample['audioHash'], 'device': 'cuda',
               'range': {'startMs': 0, 'endMs': sample['durationMs']}, 'text': sample['reference'][0]['text']}
    cases = [('correct-cuda', {}, 'accepted'),
             ('wrong-cuda', {'text': '今天我们一起去火车站买票'}, 'rejected'),
             ('silence-cuda', {'audioPath': str(silence), 'audioHash': digest(silence),
                               'range': {'startMs': 0, 'endMs': 3000}}, 'rejected'),
             ('correct-cpu', {'device': 'cpu'}, 'accepted'),
             ('unsupported-cuda', {'text': '呃太平洋商业中心'}, 'rejected'),
             ('changed-identity', {'audioHash': '0' * 64}, 'error')]
    report = {'status': 'running', 'preparedAt': datetime.now(timezone.utc).isoformat(),
              'component': str(component_path), 'manifest': str(manifest_path), 'manifestSha256': digest(manifest_path),
              'scope': 'actual fixed-script protocol with previously supported calibration audio; no new quality estimate', 'runs': []}
    (output / 'sources').mkdir()
    for name in ('asr_original_alignment.py', 'asr_engines.py', 'asr_ctc.py', 'asr_jobs.py', 'asr_runtime.py'):
        shutil.copyfile(root / 'python' / name, output / 'sources' / name)
    shutil.copyfile(__file__, output / 'sources' / Path(__file__).name)
    # Recheck the exact component/model files protected by the prior controls.
    protected = json.loads((root / 'cache/optimization/original-acoustic-full-controls-2026-10-23/report.json').read_text(encoding='utf-8'))['componentFilesBefore']
    report['componentFilesBefore'] = {path: digest(path) for path in protected}
    for name, changes, expected in cases:
        value = {**request, **changes, 'requestId': name}
        command = [str(assets['python']), '-B', '-X', 'utf8', str(root / 'python/asr_original_alignment.py')]
        for key in ('models', 'resources', 'ffmpeg', 'ffprobe'):
            command += ['--' + key, str(assets[key])]
        command += ['--cache', str(output / 'cache' / name)]
        encoded = json.dumps(value, ensure_ascii=False) + '\n'
        (output / (name + '.request.json')).write_text(encoded, encoding='utf-8')
        process = subprocess.run(command, input=encoded, text=True, encoding='utf-8',
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, cwd=str(root))
        (output / (name + '.stdout.jsonl')).write_text(process.stdout, encoding='utf-8')
        (output / (name + '.stderr.log')).write_text(process.stderr, encoding='utf-8')
        lines = process.stdout.strip().splitlines()
        assert len(lines) == 1, (name, process.stdout, process.stderr)
        result = json.loads(lines[0])
        assert result['protocolVersion'] == 1 and result['requestId'] == name
        assert result['type'] == 'error' if expected == 'error' else result['status'] == expected
        if expected != 'error':
            assert result['audioHash'] == value['audioHash'] and result['range'] == value['range']
            assert result['textSha256'] == hashlib.sha256(value['text'].encode('utf-8')).hexdigest()
            assert result['contract'] == 'original-ctc-support-v1'
            if expected == 'accepted':
                assert result['characters'] and result['startMs'] < result['endMs']
                for char in result['characters']:
                    text_slice = value['text'].encode('utf-16-le')[char['textStart'] * 2:char['textEnd'] * 2].decode('utf-16-le')
                    assert text_slice == char['text']
                    assert value['range']['startMs'] <= char['startMs'] < char['endMs'] <= value['range']['endMs']
            else:
                assert result['characters'] == [] and 'startMs' not in result and 'endMs' not in result
        else:
            assert result['code'] == 'FILE_CHANGED'
        report['runs'].append({'id': name, 'command': command, 'returnCode': process.returncode,
                               'result': result, 'expected': expected, 'passed': True})
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'id': name, 'status': result.get('status', result['type']), 'elapsedMs': result.get('elapsedMs'),
                          'reasons': result.get('reasons')}), flush=True)
    report['componentFilesAfter'] = {path: digest(path) for path in protected}
    report['componentUnchanged'] = report['componentFilesAfter'] == report['componentFilesBefore'] == protected
    report['sourceHashes'] = {path.name: digest(path) for path in (output / 'sources').iterdir()}
    report['status'] = 'passed' if report['componentUnchanged'] else 'failed'
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'report': str(output / 'report.json')}), flush=True)


if __name__ == '__main__':
    main()
