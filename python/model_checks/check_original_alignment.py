"""Real-model confirmed-text controls; fixed public-reference denominators.

Opt-in diagnostic. No downloads, ASR, component writes, or human accuracy claim.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import itertools
import json
from pathlib import Path
import shutil
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asr_runtime import configure_cache, configure_offline_network, load_local_models
from asr_jobs import FFmpegDecoder
from asr_original_alignment import align_confirmed, lexical_characters, THRESHOLDS


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cuda')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    component_path = Path(args.component).resolve()
    component = json.loads(component_path.read_text(encoding='utf-8'))
    assets = {key: (component_path.parent / component[key]).resolve()
              for key in ('models', 'resources', 'ffmpeg', 'ffprobe')}
    configure_offline_network()
    configure_cache(output / 'runtime-cache', assets['ffmpeg'].parent, assets['resources'])
    import os
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import numpy as np
    import torch
    from asr_engines import ChineseCTCAligner
    import whisperx.alignment
    torch.set_num_threads(4)
    models = load_local_models(assets['models'])
    protected = [component_path, assets['models'], Path(whisperx.alignment.__file__)]
    protected += sorted(Path(models['alignment']['path']).glob('*'))
    before = {str(path): digest(path) for path in protected if path.is_file()}
    (output / 'sources').mkdir()
    for name in ('asr_original_alignment.py', 'asr_engines.py', 'asr_ctc.py', 'asr_runtime.py', 'asr_jobs.py'):
        shutil.copyfile(root / 'python' / name, output / 'sources' / name)
    shutil.copyfile(__file__, output / 'sources' / Path(__file__).name)
    selections = [('chsims-film', 18), ('aishell3-studio', 40)]
    samples, manifests = [], []
    for directory, count in selections:
        path = root / 'cache/asr-evaluation/public-reference' / directory / 'manifest.json'
        document = json.loads(path.read_text(encoding='utf-8'))
        manifests.append({'path': str(path), 'sha256': digest(path), 'selection': document['selection'], 'count': count})
        for index, sample in enumerate(document['samples'][:count]):
            samples.append({**sample, 'text': ''.join(item['text'] for item in sample['reference']),
                            'fold': 'calibration' if index < (13 if directory == 'chsims-film' else 30) else 'holdout'})
    report = {'status': 'running', 'preparedAt': datetime.now(timezone.utc).isoformat(),
              'device': args.device, 'selection': 'all 18 CH-SIMS + all 40 AISHELL3 in frozen manifest order; no result filtering',
              'folds': 'first 13 film + first 30 studio calibration; remaining 5 film + 10 studio holdout',
              'manifests': manifests, 'componentFilesBefore': before,
              'sourceHashes': {path.name: digest(path) for path in (output / 'sources').iterdir()},
              'versions': {key: importlib.metadata.version(key) for key in ('torch', 'whisperx', 'transformers')},
              'qualityScope': 'controlled accept/reject diagnostic against publisher human text; no human phoneme times, audiobook quality, or calibrated accuracy',
              'thresholdsAtExecution': THRESHOLDS, 'cases': []}
    target = output / 'report.json'

    def save():
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')

    aligner = ChineseCTCAligner(models, args.device)
    native = aligner.align_with_evidence
    emission_path = None

    def traced(audio, text):
        aligned, emission = native(audio, text)
        if emission_path is not None and not emission_path.exists():
            torch.save(emission, emission_path)
        return aligned, emission

    aligner.align_with_evidence = traced
    decoder = FFmpegDecoder(assets['ffmpeg'], assets['ffprobe'])
    try:
        for sample in samples:
            source = Path(sample['path'])
            if digest(source) != sample['audioHash']:
                raise ValueError('Frozen source changed: ' + sample['id'])
            audio = decoder.decode(source, {'decodeStartMs': 0, 'decodeEndMs': sample['durationMs']}, threading.Event())
            original = sample['text']
            lexical = lexical_characters(original)
            middle = max(1, len(lexical) // 2)
            # Keep controls in vocabulary; changing/dropping words never changes audio.
            tokens = [item['text'] for item in lexical]
            wrong = ''.join(tokens[:middle] + list('火车') + tokens[middle + 2:])
            unspoken = ''.join(tokens[:middle] + list('火车') + tokens[middle:])
            variants = [('correct', original), ('wrong-word', wrong), ('unspoken-word', unspoken)]
            if len(tokens) >= 3:
                variants.append(('internal-extra-speech', ''.join(tokens[:middle] + tokens[middle + 1:])))
            for name, text in variants:
                emission_path = output / f"{sample['id']}-emission.pt"
                result = align_confirmed(aligner, audio, text)
                item = {'id': sample['id'], 'control': name, 'fold': sample['fold'],
                        'audioPath': str(source), 'audioHash': sample['audioHash'],
                        'text': text, 'textSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                        'samples': len(audio), 'referenceType': sample['referenceType'],
                        'result': result}
                report['cases'].append(item)
                save()
                print(json.dumps({'id': item['id'], 'control': name, 'evidence': result['evidence'],
                                  'reasons': [value['code'] for value in result['reasons']]}, ensure_ascii=False), flush=True)
        for name, audio in (('silence', np.zeros(48000, dtype=np.float32)),
                            ('white-noise', np.random.default_rng(20261023).normal(0, 0.03, 48000).astype(np.float32))):
            emission_path = output / f'{name}-emission.pt'
            result = align_confirmed(aligner, audio, '今天我们一起去公园散步')
            report['cases'].append({'id': name, 'control': name, 'fold': 'control',
                                    'audioPcmFloat32Sha256': hashlib.sha256(audio.tobytes()).hexdigest(),
                                    'samples': len(audio), 'text': '今天我们一起去公园散步', 'result': result})
            save()
        def passes(item, floor, max_error, max_extra):
            evidence = item['result']['evidence']
            return (evidence.get('characterCoverage') == 1 and (evidence.get('audioRms') or 0) >= 0.0001
                    and (evidence.get('freePathCharacters') or 0) > 0
                    and (evidence.get('minTokenPosterior') or 0) >= floor
                    and evidence.get('freePathErrorRate') is not None and evidence['freePathErrorRate'] <= max_error
                    and evidence.get('maxUnexplainedPosterior') is not None and evidence['maxUnexplainedPosterior'] <= max_extra)
        grid = []
        for floor, max_error, max_extra in itertools.product(
                (0.0000001, 0.000001, 0.00001, 0.0001, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2),
                (0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.35, 0.5),
                (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)):
            calibration = [item for item in report['cases'] if item['fold'] in ('calibration', 'control')]
            tp = sum(passes(item, floor, max_error, max_extra) for item in calibration if item['control'] == 'correct')
            fp = sum(passes(item, floor, max_error, max_extra) for item in calibration if item['control'] != 'correct')
            grid.append({'minTokenPosterior': floor, 'maxFreePathErrorRate': max_error,
                         'maxUnexplainedPosterior': max_extra, 'calibrationAcceptedCorrect': tp,
                         'calibrationAcceptedIncorrect': fp})
        # Lower false-accept count first, then correct acceptance; prefer strict
        # free-path and unexplained-token limits when acceptance counts tie.
        grid.sort(key=lambda value: (value['calibrationAcceptedIncorrect'], -value['calibrationAcceptedCorrect'],
                                    value['maxFreePathErrorRate'], value['maxUnexplainedPosterior'], -value['minTokenPosterior']))
        report['thresholdGrid'] = grid
        report['recommendedByCalibration'] = grid[0]
        candidate = grid[0]
        report['summary'] = {}
        for fold in ('calibration', 'holdout', 'control'):
            values = [item for item in report['cases'] if item['fold'] == fold]
            positives = [item for item in values if item['control'] == 'correct']
            negatives = [item for item in values if item['control'] != 'correct']
            check = lambda item: passes(item, candidate['minTokenPosterior'], candidate['maxFreePathErrorRate'], candidate['maxUnexplainedPosterior'])
            report['summary'][fold] = {'correctTotal': len(positives), 'correctAccepted': sum(map(check, positives)),
                                       'incorrectTotal': len(negatives), 'incorrectAccepted': sum(map(check, negatives))}
        report['componentFilesAfter'] = {str(path): digest(path) for path in protected if path.is_file()}
        report['componentUnchanged'] = report['componentFilesAfter'] == before
        report['status'] = 'compared' if report['componentUnchanged'] else 'failed'
    finally:
        save()
    print(json.dumps({'status': report['status'], 'summary': report.get('summary'),
                      'recommended': report.get('recommendedByCalibration'), 'report': str(target)}), flush=True)


if __name__ == '__main__':
    main()
