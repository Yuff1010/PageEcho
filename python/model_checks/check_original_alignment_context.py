"""Bounded real long-reference/context diagnostics for confirmed originals."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asr_runtime import configure_cache, configure_offline_network, load_local_models, protect_worker_process
from asr_jobs import FFmpegDecoder
from asr_original_alignment import align_confirmed, THRESHOLDS


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--supplement', action='store_true')
    args = parser.parse_args()
    protect_worker_process()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    component_path = Path(args.component).resolve()
    component = json.loads(component_path.read_text(encoding='utf-8'))
    assets = {key: (component_path.parent / component[key]).resolve()
              for key in ('models', 'resources', 'ffmpeg', 'ffprobe')}
    configure_offline_network()
    configure_cache(output / 'cache', assets['ffmpeg'].parent, assets['resources'])
    import os
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import numpy as np
    import torch
    from asr_engines import ChineseCTCAligner
    torch.set_num_threads(4)
    aligner = ChineseCTCAligner(load_local_models(assets['models']), 'cuda')
    decoder = FFmpegDecoder(assets['ffmpeg'], assets['ffprobe'])
    manifest = root / 'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json'
    continuous_samples = json.loads(manifest.read_text(encoding='utf-8'))['samples']
    continuous = continuous_samples[0]
    studio_path = root / 'cache/asr-evaluation/public-reference/aishell3-studio/manifest.json'
    studio = json.loads(studio_path.read_text(encoding='utf-8'))['samples']
    report = {'status': 'running', 'preparedAt': datetime.now(timezone.utc).isoformat(),
              'device': 'cuda', 'thresholds': THRESHOLDS, 'cases': [],
              'longSelection': 'all 8 publisher human turns from the first frozen continuous sample; each with up to 250ms context; no result filtering',
              'contextSelection': 'two previously supported calibration utterances, full text and interior target substrings in unchanged complete audio; contextual feasibility only, not a new accuracy denominator',
              'manifestHashes': {str(path): digest(path) for path in (manifest, studio_path)},
              'qualityScope': 'human utterance endpoints are not phoneme boundaries; model support/rejection and context controls only'}
    (output / 'sources').mkdir()
    for name in ('asr_original_alignment.py', 'asr_engines.py', 'asr_ctc.py'):
        shutil.copyfile(root / 'python' / name, output / 'sources' / name)
    shutil.copyfile(__file__, output / 'sources' / Path(__file__).name)
    target = output / 'report.json'

    def run(identity, audio, text, offset, fields):
        result = align_confirmed(aligner, audio, text, offset)
        item = {'id': identity, 'text': text, 'offsetMs': offset, 'samples': len(audio),
                'audioPcmFloat32Sha256': hashlib.sha256(audio.tobytes()).hexdigest(), **fields,
                'result': result}
        if not result['reasons']:
            chars = result['characters']
            assert chars and all(offset <= value['startMs'] < value['endMs'] <= offset + len(audio) / 16 + 1 for value in chars)
            assert all(left['endMs'] <= right['startMs'] for left, right in zip(chars, chars[1:]))
            if 'reference' in fields:
                item['coarseHumanBoundaryDeltaMs'] = {
                    'start': chars[0]['startMs'] - fields['reference']['startMs'],
                    'end': chars[-1]['endMs'] - fields['reference']['endMs']}
        report['cases'].append(item)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        print(json.dumps({'id': identity, 'evidence': result['evidence'], 'reasons': result['reasons']}, ensure_ascii=False), flush=True)

    source = Path(continuous['path'])
    if digest(source) != continuous['audioHash']:
        raise ValueError('Frozen continuous audio changed')
    for reference in ([] if args.supplement else continuous['reference']):
        start = max(0, math.floor(reference['startMs'] - 250))
        end = min(continuous['durationMs'], math.ceil(reference['endMs'] + 250))
        audio = decoder.decode(source, {'decodeStartMs': start, 'decodeEndMs': end}, threading.Event())
        run(reference['id'], audio, reference['text'], start,
            {'category': 'human-long-reference', 'audioPath': str(source), 'audioHash': continuous['audioHash'], 'reference': reference})
    # First source-order adjacent supported turns whose unchanged continuous
    # span reaches 20s. This is a vocabulary/duration selection, not a score filter.
    supported = continuous_samples[2]
    references = supported['reference'][:2]
    text = ''.join(value['text'] for value in references)
    path = Path(supported['path'])
    if digest(path) != supported['audioHash']:
        raise ValueError('Frozen supported continuous audio changed')
    start = max(0, math.floor(references[0]['startMs'] - 250))
    end = math.ceil(references[-1]['endMs'] + 250)
    audio = decoder.decode(path, {'decodeStartMs': start, 'decodeEndMs': end}, threading.Event())
    run('continuous-supported-first-two-turns', audio, text, start,
        {'category': 'human-supported-20s-reference', 'audioPath': str(path), 'audioHash': supported['audioHash'],
         'reference': {'startMs': references[0]['startMs'], 'endMs': references[-1]['endMs'], 'turns': references},
         'selection': 'first adjacent pair in frozen source order with all lexical chars in dictionary and >=20s span; no text/audio edit'})
    context_cases = [('SSB17110076', ('放音乐世界第一等', '世界第一等', '音乐世界第一')),
                     ('SSB17110153', ('放音乐我真的受伤了', '我真的受伤'))]
    for source_id, texts in context_cases:
        sample = next(value for value in studio if value['id'].endswith(source_id))
        path = Path(sample['path'])
        if digest(path) != sample['audioHash']:
            raise ValueError('Frozen studio audio changed')
        audio = decoder.decode(path, {'decodeStartMs': 0, 'decodeEndMs': sample['durationMs']}, threading.Event())
        for index, text in enumerate(() if args.supplement else texts):
            run(source_id + '-' + str(index), audio, text, 0,
                {'category': 'neighbor-context', 'audioPath': str(path), 'audioHash': sample['audioHash'],
                 'publishedFullText': sample['reference'][0]['text']})
        if source_id == 'SSB17110076':
            repeated = np.concatenate((audio, np.zeros(4800, dtype=np.float32), audio))
            run(source_id + '-repeated', repeated, texts[0], 0,
                {'category': 'ambiguous-repeat', 'modification': 'same original twice with 300ms silence; controlled ambiguity, not natural reference'})
    report['summary'] = {}
    for category in ('human-long-reference', 'human-supported-20s-reference', 'neighbor-context', 'ambiguous-repeat'):
        values = [item for item in report['cases'] if item['category'] == category]
        report['summary'][category] = {'total': len(values), 'accepted': sum(not item['result']['reasons'] for item in values)}
    report['sourceHashes'] = {path.name: digest(path) for path in (output / 'sources').iterdir()}
    report['status'] = 'compared'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'summary': report['summary'], 'report': str(target)}), flush=True)


if __name__ == '__main__':
    main()
