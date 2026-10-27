"""Run real local ASR on the private sample manifest and the known TTS control.

No accuracy number is produced for a sample without a reference. Raw model
output stays in the ignored evaluation cache; exported times retain the source
audio offset. This is an offline benchmark, not the application's job worker.
"""

import argparse
import contextlib
import faulthandler
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import threading
import time
import traceback
import wave

# The embedded runtime excludes caller/script directories from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_metrics import (
    character_error_rate, normalize_text, reference_boundary_comparison,
    timing_issues, transcript_document,
)
from asr_runtime import configure_cache, configure_offline_network
from asr_engines import Paraformer, WhisperX
from public_reference import load_reference_manifest, digest


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def event(stage, **fields):
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=False), flush=True)


class ResourceMonitor:
    """Sample RSS (100 ms) and whole-device VRAM (1 s, includes other apps)."""

    def __enter__(self):
        import psutil
        import torch
        if torch.cuda.is_initialized():
            torch.cuda.reset_peak_memory_stats()
        self.process = psutil.Process()
        self.peak_rss = self.process.memory_info().rss
        self.gpu_samples = []
        self.stop = threading.Event()
        self.smi = shutil.which('nvidia-smi')
        if not self.smi and os.name == 'nt':
            candidate = Path(os.environ['SystemRoot']) / 'System32/nvidia-smi.exe'
            self.smi = str(candidate) if candidate.exists() else None
        self.rss_thread = threading.Thread(target=self.sample_rss, daemon=True)
        self.gpu_thread = threading.Thread(target=self.sample_gpu, daemon=True)
        self.rss_thread.start()
        self.gpu_thread.start()
        return self

    def sample_rss(self):
        while not self.stop.is_set():
            self.peak_rss = max(self.peak_rss, self.process.memory_info().rss)
            self.stop.wait(0.1)

    def sample_gpu(self):
        while self.smi and not self.stop.is_set():
            try:
                result = subprocess.run(
                    [self.smi, '--query-gpu=memory.used', '--format=csv,noheader,nounits', '-i', '0'],
                    capture_output=True, text=True, timeout=3,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                )
                if result.returncode == 0:
                    self.gpu_samples.append(int(result.stdout.strip()))
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
            self.stop.wait(1)

    def __exit__(self, *_):
        self.stop.set()
        self.rss_thread.join(timeout=4)
        self.gpu_thread.join(timeout=4)
        self.values = {
            'peakProcessRssBytes': self.peak_rss,
            'sampledPeakWholeGpuMiB': max(self.gpu_samples) if self.gpu_samples else None,
            'gpuSamples': len(self.gpu_samples),
            'gpuMetricScope': 'whole device, includes desktop and other apps; 1 second sampling',
        }
        import torch
        self.values['peakTorchAllocatedBytes'] = torch.cuda.max_memory_allocated() if torch.cuda.is_initialized() else None
        self.values['peakTorchReservedBytes'] = torch.cuda.max_memory_reserved() if torch.cuda.is_initialized() else None


def read_audio(path):
    import numpy as np
    with wave.open(str(path), 'rb') as audio:
        if audio.getnchannels() != 1 or audio.getframerate() != 16000 or audio.getsampwidth() != 2:
            raise ValueError('Evaluation input must be PCM16 mono 16000 Hz WAV')
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['paraformer', 'whisperx'], required=True)
    parser.add_argument('--device', choices=['cuda', 'cpu'], default='cuda')
    parser.add_argument('--cache', default='cache/asr-evaluation')
    parser.add_argument('--ffmpeg-directory')
    parser.add_argument('--repeats', type=int, choices=[1, 2], default=2)
    parser.add_argument('--control-only', action='store_true')
    parser.add_argument('--whisper-compute', choices=['float16', 'int8_float16', 'int8'])
    parser.add_argument('--whisper-batch-size', type=int, choices=[1, 2, 4], default=4)
    parser.add_argument('--diagnostic-stacks', action='store_true')
    parser.add_argument('--reference-manifest', help='Verified opt-in public human-reference subset; replaces TTS/song inputs')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    if args.diagnostic_stacks:
        faulthandler.dump_traceback_later(60, repeat=True, file=sys.stderr)
    root = configure_cache(args.cache, args.ffmpeg_directory)
    started = time.perf_counter()
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
    prefix = 'public-' if args.reference_manifest else ''
    output = root / 'runs' / f'{prefix}{stamp}-{args.engine}-{args.device}'
    output.mkdir(parents=True)
    compute_type = args.whisper_compute or ('float16' if args.device == 'cuda' else 'int8')
    batch_size = args.whisper_batch_size if args.device == 'cuda' else 1
    report = {'version': 1, 'status': 'running', 'startedAt': stamp, 'engine': args.engine, 'deviceRequested': args.device, 'samples': []}
    report['statusScope'] = 'execution and timestamp constraints only; passed does not assert text accuracy or model suitability'
    report['offlineNetworkPolicy'] = bool(args.offline)
    report['harnessSha256'] = {
        name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ['evaluate_asr.py', 'public_reference.py', 'asr_engines.py', 'asr_compat.py', 'asr_ctc.py', 'asr_segments.py', 'asr_metrics.py', 'asr_runtime.py']
    }
    report['configuration'] = {
        'whisperComputeType': compute_type if args.engine == 'whisperx' else None,
        'whisperBatchSize': batch_size if args.engine == 'whisperx' else None,
        'paraformerNativeTimestampsRequested': args.engine == 'paraformer',
        'partialStreaming': False,
    }
    target = output / 'report.json'
    write_json(target, report)
    try:
        if args.reference_manifest and args.control_only:
            raise ValueError('Use either --reference-manifest or --control-only')
        public = load_reference_manifest(args.reference_manifest) if args.reference_manifest else None
        if public:
            report['referenceManifest'] = {'path': str(Path(args.reference_manifest).resolve()),
                                           'sha256': digest(args.reference_manifest),
                                           'source': public['source'], 'selection': public['selection'],
                                           'qualityScope': public['qualityScope']}
        if args.offline:
            configure_offline_network()
        import torch
        import numpy as np
        torch.set_num_threads(4)
        torch.manual_seed(0)
        np.random.seed(0)
        if args.device == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('CUDA requested but unavailable; no silent CPU fallback')
        report['environment'] = {
            'python': platform.python_version(), 'platform': platform.platform(),
            'versions': {name: importlib.metadata.version(name) for name in [
                'torch', 'torchaudio', 'funasr', 'whisperx', 'transformers', 'ctranslate2',
                'faster-whisper', 'numpy', 'pyannote.audio', 'torchcodec',
            ]},
            'cuda': torch.version.cuda, 'gpu': torch.cuda.get_device_name(0) if args.device == 'cuda' else None,
            'threads': 4, 'seed': 0,
        }
        models = json.loads((root / 'models.json').read_text(encoding='utf-8'))['models']
        required = ['paraformer', 'vad', 'punctuation', 'alignment'] if args.engine == 'paraformer' else ['whisper', 'alignment']
        report['models'] = {key: models[key] for key in required}
        event('loading', engine=args.engine, device=args.device)
        with ResourceMonitor() as resources, contextlib.redirect_stdout(sys.stderr):
            load_started = time.perf_counter()
            engine = Paraformer(models, args.device) if args.engine == 'paraformer' else WhisperX(models, args.device, compute_type, batch_size)
            report['loadMs'] = (time.perf_counter() - load_started) * 1000
        report['loadResources'] = resources.values
        fixture = Path(__file__).resolve().parents[1] / 'tests/fixtures'
        reference = json.loads((fixture / 'reading-manual.json').read_text(encoding='utf-8'))
        audio_path = next(fixture.glob('*伴读样本.wav'))
        with audio_path.open('rb') as audio_file:
            if hashlib.file_digest(audio_file, 'sha256').hexdigest() != reference['audioHash']:
                raise ValueError('Control fixture hash changed')
        samples = [{
            'id': 'known-tts-control', 'audioHash': reference['audioHash'], 'path': str(audio_path),
            'offsetMs': 0, 'reference': reference['segments'], 'category': 'synthetic-single-speaker-control',
        }]
        if public:
            samples = public['samples']
        elif not args.control_only:
            manifest = json.loads((root / 'samples.json').read_text(encoding='utf-8'))
            samples += [{
                'id': f'song-{i + 1}', 'audioHash': sample['id'], 'path': sample['clip']['path'],
                'offsetMs': sample['clip']['startMs'], 'reference': None, 'category': sample['category'],
            } for i, sample in enumerate(manifest['samples'])]
        for sample in samples:
            if public and digest(sample['path']) != sample['audioHash']:
                raise ValueError('Reference audio changed before recognition')
            audio = read_audio(sample['path'])
            duration_ms = round(len(audio) / 16)
            entry = {**sample, 'durationMs': duration_ms, 'attempts': []}
            report['samples'].append(entry)
            for repetition in range(args.repeats):
                attempt = {'repeat': repetition + 1}
                entry['attempts'].append(attempt)
                event('recognizing', sample=sample['id'], repeat=repetition + 1)
                try:
                    with ResourceMonitor() as resources, contextlib.redirect_stdout(sys.stderr):
                        result = engine.transcribe(audio)
                    attempt.update({key: value for key, value in result.items() if key not in ['raw', 'segments', 'timedUnits', 'recognitionText']})
                    attempt['resources'] = resources.values
                    attempt['realTimeFactor'] = (result['recognitionMs'] + (result['alignmentMs'] or 0)) / duration_ms
                    attempt['segmentCount'] = len(result['segments'])
                    attempt['recognizedCharacters'] = len(normalize_text(result['recognitionText']))
                    attempt['qualityStatus'] = ('published-human-diagnostic' if public else 'known-control-only') if sample['reference'] else 'not-rated-no-reference'
                    attempt['timingIssues'] = timing_issues(result['segments'], duration_ms)
                    units = [unit for unit in result['timedUnits'] if normalize_text(unit['text'])]
                    attempt['timedUnitCount'] = sum(unit['startMs'] is not None and unit['endMs'] is not None for unit in units)
                    attempt['totalUnitCount'] = len(units)
                    stem = f"{sample['id']}-{repetition + 1}"
                    write_json(output / f'{stem}.raw.json', result['raw'])
                    if not attempt['timingIssues']:
                        document = transcript_document(sample['audioHash'], sample['offsetMs'], duration_ms, result['segments'])
                        write_json(output / f'{stem}.transcript.json', document)
                        attempt['transcript'] = f'{stem}.transcript.json'
                    if sample['reference']:
                        attempt['accuracy'] = character_error_rate(
                            ''.join(item['text'] for item in sample['reference']),
                            result['recognitionText'],
                        )
                        if result['unitMappingValid']:
                            attempt['coarseBoundaryComparison'] = reference_boundary_comparison(sample['reference'], units)
                            if public:
                                attempt['coarseBoundaryComparison']['referenceType'] = sample['referenceType']
                                attempt['coarseBoundaryComparison']['scope'] = 'exact-text matches only; report unmatched turns too; not a global alignment error estimate'
                    attempt['status'] = 'passed' if not attempt['timingIssues'] else 'invalid-timestamps'
                    event('sample-complete', sample=sample['id'], repeat=repetition + 1,
                          segments=attempt['segmentCount'], realTimeFactor=round(attempt['realTimeFactor'], 4), status=attempt['status'])
                except Exception as error:
                    attempt.update({'status': 'failed', 'error': f'{type(error).__name__}: {error}'})
                    traceback.print_exc(file=sys.stderr)
                    event('sample-failed', sample=sample['id'], repeat=repetition + 1, error=str(error))
                write_json(target, report)
            if public and digest(sample['path']) != sample['audioHash']:
                raise ValueError('Reference audio changed during recognition')
        report['status'] = 'passed' if all(attempt['status'] == 'passed' for sample in report['samples'] for attempt in sample['attempts']) else 'failed'
    except Exception as error:
        report.update({'status': 'failed', 'error': f'{type(error).__name__}: {error}'})
        traceback.print_exc(file=sys.stderr)
    report['totalProcessMs'] = (time.perf_counter() - started) * 1000
    write_json(target, report)
    event('finished', status=report['status'], report=str(target))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
