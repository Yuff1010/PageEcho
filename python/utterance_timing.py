"""Post-hoc conditional utterance endpoints, never inferred phoneme timestamps."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from statistics import median

from asr_metrics import normalize_text
from asr_segments import lexical_units
from continuous_reference import load_continuous_manifest
from continuous_summary import reconstructed_documents, score
from public_reference import digest


MIN_CHARACTERS = 12
PROTOCOL = {
    'version': 1,
    'scope': 'Post-hoc cached-output diagnostic on human utterance endpoints; not phoneme timing, audiobook acceptance or a blind benchmark.',
    'normalization': 'NFKC and casefold, letters/numbers only; no numeric, homophone or reference-text replacement.',
    'selection': 'Complete turns with at least 12 normalized characters, unique exact occurrence in both full-clip reference and hypothesis streams; no timing-distance filter.',
    'boundaries': 'Both edges must coincide with whole native lexical-unit edges; no splitting, interpolation or sentence-union timestamps.',
    'coverage': 'Retain every human turn including recognition failures, short/ambiguous/missing text and indivisible unit edges. Conditional metrics omit these rows explicitly.',
    'quantiles': 'Median and nearest-rank P95 of absolute endpoint error; signed error = model minus human. Empty subsets have null statistics.',
    'comparison': 'Report each run subset and the exact same sample/turn intersection across every supplied run. Full-cohort CER is independent of timing selection.',
}


def occurrences(haystack, needle):
    """Count overlapping matches too: repetition must not select an arbitrary edge."""
    found, offset = [], 0
    while needle:
        offset = haystack.find(needle, offset)
        if offset < 0:
            break
        found.append(offset)
        offset += 1
    return found


def endpoint_rows(reference, units, duration_ms):
    if len({turn['id'] for turn in reference}) != len(reference):
        raise ValueError('Duplicate human turn identifiers')
    if lexical_units(units, duration_ms) != units:
        raise ValueError('Expected unchanged native lexical units')
    expected = ''.join(normalize_text(turn['text']) for turn in reference)
    actual, starts, ends = '', {}, {}
    for index, unit in enumerate(units):
        starts[len(actual)] = index
        actual += normalize_text(unit['text'])
        ends[len(actual)] = index
    rows = []
    for turn in reference:
        text = normalize_text(turn['text'])
        row = {'id': turn['id'], 'referenceText': turn['text'], 'referenceCharacters': len(text),
               'referenceStartMs': turn['startMs'], 'referenceEndMs': turn['endMs']}
        rows.append(row)
        if not all(type(turn[key]) in (int, float) and math.isfinite(turn[key]) for key in ('startMs', 'endMs')) or not 0 <= turn['startMs'] < turn['endMs'] <= duration_ms:
            raise ValueError('Invalid human endpoint')
        reason = None
        matches = occurrences(actual, text)
        if len(text) < MIN_CHARACTERS:
            reason = 'short-reference'
        elif len(occurrences(expected, text)) != 1:
            reason = 'ambiguous-reference'
        elif not matches:
            reason = 'text-not-exact'
        elif len(matches) != 1:
            reason = 'ambiguous-hypothesis'
        elif matches[0] not in starts or matches[0] + len(text) not in ends:
            reason = 'inside-indivisible-unit'
        if reason:
            row.update(status='excluded', reason=reason)
            continue
        first, last = starts[matches[0]], ends[matches[0] + len(text)]
        start, end = units[first]['startMs'], units[last]['endMs']
        row.update(status='matched', firstUnitIndex=first, lastUnitIndex=last,
                   hypothesisCharacterOffset=matches[0], startMs=start, endMs=end,
                   startErrorMs=start - turn['startMs'], endErrorMs=end - turn['endMs'])
    return rows


def endpoint_statistics(rows):
    result = {}
    for endpoint in ('start', 'end'):
        signed = [row[f'{endpoint}ErrorMs'] for row in rows]
        absolute = sorted(abs(value) for value in signed)
        result[endpoint] = {'count': len(signed),
                            'medianSignedMs': median(signed) if signed else None,
                            'medianAbsoluteMs': median(absolute) if signed else None,
                            'p95AbsoluteMs': absolute[math.ceil(.95 * len(absolute)) - 1] if signed else None,
                            'maxAbsoluteMs': max(absolute) if signed else None}
    return result


def summarize_run(path):
    path = Path(path).resolve()
    run = json.loads(path.read_text(encoding='utf-8'))
    if run['referenceKind'] != 'human-continuous' or run['status'] not in ('passed', 'failed'):
        raise ValueError('Expected a terminal continuous-reference worker report')
    manifest = load_continuous_manifest(run['manifestPath'])
    if digest(run['manifestPath']) != run['manifestSha256']:
        raise ValueError('Human reference changed after inference')
    samples = {sample['id']: sample for sample in manifest['samples']}
    if len(run['samples']) != len(samples) or {sample['id'] for sample in run['samples']} != set(samples):
        raise ValueError('Worker report omits or duplicates fixed cohort samples')
    result = {'report': str(path), 'reportSha256': digest(path), 'manifestSha256': run['manifestSha256'],
              'engine': run['engine'], 'device': run['device'], 'executionStatus': run['status'],
              'configuration': run['configuration'], 'samples': []}
    for measured in run['samples']:
        sample = samples[measured['id']]
        if measured['audioHash'] != sample['audioHash']:
            raise ValueError('Worker audio identity differs from the fixed reference')
        row = {'id': sample['id'], 'status': measured['status']}
        result['samples'].append(row)
        if measured['status'] != 'completed':
            row['turns'] = [{**turn, 'status': 'excluded', 'reason': 'worker-not-completed'} for turn in sample['reference']]
            continue
        if measured['cacheHits'] != 0 or measured['replayCacheHits'] != measured['totalChunks'] or measured['durationMs'] != sample['durationMs']:
            raise ValueError('Fresh inference/replay or duration evidence is missing')
        document, _, units = reconstructed_documents(path.parent, run, measured, sample, include_units=True)
        checkpoint_group = path.parent / 'cache/asr/jobs' / measured['cacheKey']
        row['inputSha256'] = {'transcript': digest(path.parent / measured['transcript']),
                              'checkpoints': {item.name: digest(item) for item in sorted(checkpoint_group.glob('*.json'))}}
        if normalize_text(''.join(unit['text'] for unit in units)) != normalize_text(''.join(segment['text'] for segment in document['segments'])):
            raise ValueError('Native unit text differs from the actual reading document')
        row['turns'] = endpoint_rows(sample['reference'], units, sample['durationMs'])
        row['wholeReference'] = score(sample['reference'], document, [])['wholeReference']
    complete = [sample for sample in result['samples'] if sample['status'] == 'completed']
    if len(complete) == len(samples) and not run.get('restartCheckpointReused'):
        raise ValueError('Whole-cohort restart replay is missing')
    characters = sum(sample['wholeReference']['referenceCharacters'] for sample in complete)
    edits = sum(sample['wholeReference']['editDistance'] for sample in complete)
    result['recognition'] = {'completedSamples': len(complete), 'expectedSamples': len(samples),
                             'completedReferenceCharacters': characters, 'completedEditDistance': edits,
                             'completedOnlyCER': edits / characters if characters else None,
                             'corpusCER': edits / characters if characters and len(complete) == len(samples) else None}
    return result


def compare_runs(runs):
    if not runs or len({run['manifestSha256'] for run in runs}) != 1:
        raise ValueError('Comparison requires one identical fixed reference')
    if len({(run['engine'], run['device']) for run in runs}) != len(runs):
        raise ValueError('Duplicate engine/device runs would distort the common subset')
    indexes = [{(sample['id'], turn['id']): turn for sample in run['samples'] for turn in sample['turns']} for run in runs]
    cohort = set(indexes[0])
    if any(set(index) != cohort for index in indexes):
        raise ValueError('Comparison cohorts differ')
    common = set.intersection(*[{key for key, row in index.items() if row['status'] == 'matched'} for index in indexes])
    for run, index in zip(runs, indexes):
        matched = [row for row in index.values() if row['status'] == 'matched']
        run['timing'] = {'matchedTurns': len(matched), 'expectedTurns': len(cohort),
                         'coverage': len(matched) / len(cohort) if cohort else None,
                         'excludedReasons': dict(Counter(row['reason'] for row in index.values() if row['status'] != 'matched')),
                         'conditional': endpoint_statistics(matched),
                         'commonAcrossAllRuns': endpoint_statistics([index[key] for key in sorted(common)])}
    return {'status': 'audited', 'createdAt': datetime.now(timezone.utc).isoformat(), 'protocol': PROTOCOL,
            'scoringSourcesSha256': {name: digest(Path(__file__).with_name(name)) for name in
                                    ('utterance_timing.py', 'continuous_summary.py', 'continuous_reference.py', 'asr_metrics.py', 'asr_segments.py')},
            'commonTurns': [{'sampleId': sample, 'turnId': turn} for sample, turn in sorted(common)], 'runs': runs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = compare_runs([summarize_run(path) for path in args.reports])
    target = Path(args.output).resolve()
    if target.exists():
        raise ValueError('Preserve existing audit evidence; choose a new output file')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'runs': len(result['runs']), 'commonTurns': len(result['commonTurns']), 'output': str(target)}), flush=True)


if __name__ == '__main__':
    main()
