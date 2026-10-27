"""Audit owned-window cuts against exact, time-consistent stored ASR overlap.

No model is loaded. Agreement between two recognition windows is processing
evidence, not a human transcript or proof of acoustic accuracy.
"""

import argparse
from collections import Counter
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_engines import Paraformer
from asr_metrics import normalize_text, timing_issues
from asr_segments import POSTPROCESS_VERSION, join_units, join_windows, lexical_units, owned_units, partial_document


def recovered_units(checkpoint):
    """Replay the pure adapter on saved responses; fail if any evidence is absent."""
    raw, window = checkpoint['raw'], checkpoint['window']
    duration = window['decodeEndMs'] - window['decodeStartMs']

    def saved_alignment(audio, text):
        values = [item['alignmentFallback']['result'] for item in raw if 'alignmentFallback' in item]
        if len(values) != 1:
            raise ValueError('A required stored CTC response is missing/ambiguous')
        return values[0]

    adapter = Paraformer.__new__(Paraformer)
    adapter.model = SimpleNamespace(generate=lambda **_: raw)
    adapter.models, adapter.device = {}, 'cpu'
    adapter.aligner = SimpleNamespace(align=saved_alignment)
    adapter.timestamp_contract = 'stored-output-replay-only'
    result = adapter.transcribe(range(duration * 16))
    units = lexical_units(result['timedUnits'], duration)
    if owned_units(units, window) != checkpoint['units']:
        raise ValueError('Reconstructed owned units differ from the actual checkpoint')
    return [{**unit, 'startMs': unit['startMs'] + window['decodeStartMs'],
             'endMs': unit['endMs'] + window['decodeStartMs']} for unit in units]


def characters(units):
    return [{'char': char, 'startMs': unit['startMs'], 'endMs': unit['endMs']}
            for unit in units for char in normalize_text(unit['text'])]


def cut_index(chars, seam):
    before = [item['startMs'] + item['endMs'] < 2 * seam for item in chars]
    cut = sum(before)
    if before != [True] * cut + [False] * (len(chars) - cut):
        raise ValueError('Ownership is not a contiguous cut in this window')
    return cut


def audit_pair(left, right, seam, right_char_adjustment, margin_ms):
    a = [c for c in characters(left) if abs((c['startMs'] + c['endMs']) / 2 - seam) <= margin_ms]
    b = [c for c in characters(right) if abs((c['startMs'] + c['endMs']) / 2 - seam) <= margin_ms]
    text_a, text_b = ''.join(c['char'] for c in a), ''.join(c['char'] for c in b)
    left_cut, right_cut = cut_index(a, seam), cut_index(b, seam)
    candidates = [block for block in SequenceMatcher(a=text_a, b=text_b, autojunk=False).get_matching_blocks()
                  if block.size >= 4 and block.a <= left_cut <= block.a + block.size
                  and block.b <= right_cut <= block.b + block.size]
    if len(candidates) != 1:
        return {'agreementStatus': 'no-exact-context'}
    block = candidates[0]
    length, common = block.size, text_b[block.b:block.b + block.size]
    if text_a.find(common) != text_a.rfind(common) or text_b.find(common) != text_b.rfind(common):
        return {'agreementStatus': 'ambiguous-repeated-context', 'commonText': common}
    x, y = left_cut - block.a, right_cut - block.b
    if not 0 <= x <= length or not 0 <= y <= length:
        return {'agreementStatus': 'cut-outside-shared-text', 'commonText': common}
    deltas = [abs(c['startMs'] + c['endMs'] - d['startMs'] - d['endMs']) / 2
              for c, d in zip(a[block.a:block.a + length], b[block.b:block.b + length])]
    if max(deltas) > 1000:
        return {'agreementStatus': 'time-inconsistent-context', 'commonText': common,
                'maxPairedMidpointDeltaMs': max(deltas)}
    effective_right = y + right_char_adjustment
    if not 0 <= effective_right <= length:
        raise ValueError('Deduplication exceeds the agreed context')
    return {
        'agreementStatus': ('agreed-text-lost' if x < effective_right else
                            'agreed-text-duplicated' if x > effective_right else 'agreed-text-preserved'),
        'commonText': common, 'leftCutCharacter': x, 'rightCutCharacter': y,
        'deduplicatedCharacters': max(0, right_char_adjustment),
        'recoveredCharacters': max(0, -right_char_adjustment), 'maxPairedMidpointDeltaMs': max(deltas),
        'missingAgreedText': common[x:effective_right] if x < effective_right else '',
        'duplicatedAgreedText': common[effective_right:x] if x > effective_right else '',
        'selectedText': common[:x] + common[effective_right:],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-report', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--prospective', action='store_true', help='Apply current stitching to old stored outputs without model inference')
    args = parser.parse_args()
    app_path = Path(args.app_report).resolve()
    app = json.loads(app_path.read_text(encoding='utf-8'))
    if app['status'] != 'passed' or app['engine'] != 'paraformer':
        raise ValueError('Expected a completed real Paraformer application run')
    with Path(app['sourceAudio']).open('rb') as stream:
        audio_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    candidates = []
    for path in (Path(app['data']) / 'cache/asr/jobs').glob('*/manifest.json'):
        manifest = json.loads(path.read_text(encoding='utf-8'))
        if manifest['audioHash'] == audio_hash and manifest['startMs'] == 0:
            candidates.append((path, manifest))
    if len(candidates) != 1:
        raise ValueError('Expected one final full-source checkpoint group')
    path, manifest = candidates[0]
    checkpoints = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(path.parent.glob('chunk-*.json'))]
    expected = (manifest['endMs'] + manifest['configuration']['chunkMs'] - 1) // manifest['configuration']['chunkMs']
    if len(checkpoints) != expected:
        raise ValueError('Incomplete source checkpoints')
    recovered = [recovered_units(checkpoint) for checkpoint in checkpoints]
    new_policy = args.prospective or manifest['configuration']['postprocessVersion'] >= 3
    if manifest['configuration']['postprocessVersion'] >= 3:
        for checkpoint, context in zip(checkpoints, recovered):
            if checkpoint['contextUnits'] != context:
                raise ValueError('Saved context differs from reconstructed native evidence')
    assembled, rows = [], []
    for index, checkpoint in enumerate(checkpoints):
        following = checkpoint['units']
        if new_policy:
            combined, issues = join_windows(assembled, following, recovered[index - 1] if index else None,
                                             recovered[index], checkpoint['window']['startMs'],
                                             manifest['configuration']['overlapMs'])
        else:
            combined, issues = join_units(assembled, following)
        if index:
            seam = checkpoint['window']['startMs']
            removed = next((issue['units'] for issue in issues if issue['code'] == 'BOUNDARY_REPEAT_DEDUPLICATED'), 0)
            effective = combined[len(assembled):]
            adjustment = len(normalize_text(''.join(u['text'] for u in following))) - len(normalize_text(''.join(u['text'] for u in effective)))
            row = {'chunk': index, 'seamMs': seam, 'issues': issues,
                   'leftTail': assembled[-8:], 'rightHead': following[:8],
                   'intervalOverlapMs': max(0, assembled[-1]['endMs'] - following[removed]['startMs'])
                   if assembled and len(following) > removed else None,
                   **audit_pair(recovered[index - 1], recovered[index], seam, adjustment,
                                manifest['configuration']['overlapMs'])}
            rows.append(row)
        assembled = combined
    document = partial_document(audio_hash, 0, manifest['endMs'], assembled)
    if timing_issues(document['segments'], manifest['endMs']):
        raise ValueError('The reconstructed document has invalid media coordinates')
    report = {'status': 'prospective-stored-output-replay' if args.prospective else 'audited',
              'sourcePostprocessVersion': manifest['configuration']['postprocessVersion'],
              'targetPostprocessVersion': POSTPROCESS_VERSION if args.prospective else manifest['configuration']['postprocessVersion'],
              'appReport': str(app_path), 'audioHash': audio_hash,
              'checkpointManifest': str(path), 'configuration': manifest['configuration'],
              'harnessSha256': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                               for name in ('audit_asr_overlaps.py', 'asr_segments.py', 'asr_engines.py')},
              'reconstructedCheckpoints': len(recovered), 'boundaries': len(rows),
              'agreementCounts': dict(Counter(row['agreementStatus'] for row in rows)),
              'issueCounts': dict(Counter(issue['code'] for row in rows for issue in row['issues'])),
              'scope': 'Unique exact matching block of at least four normalized letters/numbers covering both ownership cuts within the shared +/-2 second context; every paired midpoint within 1000 ms. Stored-output agreement only, not audio/human quality. No warnings suppressed.',
              'rows': rows}
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if args.prospective:
        exported = target.with_name(target.stem + '.generated.json')
        exported.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        report['generatedDocument'] = str(exported)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('status', 'reconstructedCheckpoints', 'boundaries', 'agreementCounts', 'issueCounts')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
