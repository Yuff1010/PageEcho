"""Score continuous human references and replay legacy stitching on identical ASR.

Turn-local edits use one minimum-edit alignment to the whole reference; they
are not phoneme timing errors or per-character human timestamp measurements.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
import json
from pathlib import Path

from asr_metrics import character_error_rate, normalize_text, timing_issues
from asr_jobs import assembled_document
from asr_segments import fingerprint, join_units, join_windows, lexical_units, owned_units, partial_document, windows
from continuous_reference import load_continuous_manifest
from public_reference import digest


def turn_edits(reference, hypothesis):
    expected = ''.join(normalize_text(turn['text']) for turn in reference)
    hypothesis = normalize_text(hypothesis)
    owners = [turn['id'] for turn in reference for _ in normalize_text(turn['text'])]
    if not expected or len({turn['id'] for turn in reference}) != len(reference):
        raise ValueError('Expected nonempty, uniquely identified reference turns')
    matrix = [list(range(len(hypothesis) + 1))]
    for i, char in enumerate(expected, 1):
        row = [i]
        for j, other in enumerate(hypothesis, 1):
            row.append(min(matrix[-1][j] + 1, row[-1] + 1, matrix[-1][j - 1] + (char != other)))
        matrix.append(row)
    counts = {turn['id']: Counter() for turn in reference}
    i, j = len(expected), len(hypothesis)
    while i or j:
        if i and j and expected[i - 1] == hypothesis[j - 1] and matrix[i][j] == matrix[i - 1][j - 1]:
            i, j = i - 1, j - 1
        elif i and j and matrix[i][j] == matrix[i - 1][j - 1] + 1:
            counts[owners[i - 1]]['substitutions'] += 1
            i, j = i - 1, j - 1
        elif i and matrix[i][j] == matrix[i - 1][j] + 1:
            counts[owners[i - 1]]['deletions'] += 1
            i -= 1
        else:
            # Insertions belong to the following reference character, EOF to last.
            counts[owners[min(i, len(owners) - 1)]]['insertions'] += 1
            j -= 1
    rows = [{'id': turn['id'], 'referenceCharacters': len(normalize_text(turn['text'])),
             **{kind: counts[turn['id']][kind] for kind in ('substitutions', 'deletions', 'insertions')}} for turn in reference]
    for row in rows:
        row['editDistance'] = row['substitutions'] + row['deletions'] + row['insertions']
    if sum(row['editDistance'] for row in rows) != matrix[-1][-1]:
        raise ValueError('Turn allocation does not match whole-sample edits')
    return rows


def score(reference, document, seam_ms):
    expected = ''.join(turn['text'] for turn in reference)
    actual = ''.join(segment['text'] for segment in document['segments'])
    accuracy = character_error_rate(expected, actual)
    turns = turn_edits(reference, actual)
    by_id = {turn['id']: turn for turn in turns}
    seam_turns = [{'seamMs': seam, 'turnIds': [turn['id'] for turn in reference
                                            if turn['startMs'] + 250 < seam < turn['endMs'] - 250]}
                  for seam in seam_ms]
    ids = {identifier for seam in seam_turns for identifier in seam['turnIds']}
    selected = [by_id[identifier] for identifier in ids]
    characters = sum(turn['referenceCharacters'] for turn in selected)
    edits = sum(turn['editDistance'] for turn in selected)
    return {'wholeReference': accuracy, 'turns': turns, 'turnInteriorSeams': seam_turns,
            'seamCrossingTurns': {'uniqueTurns': len(ids), 'referenceCharacters': characters,
                                 'editDistance': edits, 'cer': edits / characters if characters else None}}


def reconstructed_documents(directory, run, measured, sample, *, include_units=False, checkpoint_root=None):
    configuration = run['configuration']
    key = fingerprint({'audioHash': sample['audioHash'], 'configuration': configuration,
                       'startMs': 0, 'endMs': sample['durationMs']})
    if measured['cacheKey'] != key:
        raise ValueError('Stored cache key differs from this sample and worker configuration')
    group = (Path(checkpoint_root) if checkpoint_root is not None else directory / 'cache/asr') / 'jobs' / key
    manifest = json.loads((group / 'manifest.json').read_text(encoding='utf-8'))
    if manifest != {'version': 1, 'audioHash': sample['audioHash'], 'configuration': configuration,
                    'startMs': 0, 'endMs': sample['durationMs']}:
        raise ValueError('Checkpoint ownership differs from the reference')
    plan = list(windows(0, sample['durationMs'], configuration['chunkMs'], configuration['overlapMs']))
    if measured['totalChunks'] != len(plan) or len(list(group.glob('chunk-*.json'))) != len(plan):
        raise ValueError('Missing continuous source chunks')
    current, legacy, issues, previous = [], [], [], None
    checkpoints = {}
    for window in plan:
        checkpoint = json.loads((group / f"chunk-{window['index']:06d}.json").read_text(encoding='utf-8'))
        if checkpoint['cacheKey'] != key or checkpoint['window'] != window:
            raise ValueError('Checkpoint window changed')
        checkpoints[window['index']] = checkpoint
        context = lexical_units(checkpoint['contextUnits'], window['decodeEndMs'])
        if (context != checkpoint['contextUnits'] or any(unit['startMs'] < window['decodeStartMs'] for unit in context) or
                owned_units([{**unit, 'startMs': unit['startMs'] - window['decodeStartMs'],
                              'endMs': unit['endMs'] - window['decodeStartMs']} for unit in context], window) != checkpoint['units']):
            raise ValueError('Full context or ownership differs from native checkpoint data')
        current, boundary_issues = join_windows(current, checkpoint['units'], previous, context,
                                               window['startMs'], configuration['overlapMs'])
        legacy, _ = join_units(legacy, checkpoint['units'])
        previous = context
        issues.extend(checkpoint['issues'] + boundary_issues)
    current_document = partial_document(sample['audioHash'], 0, sample['durationMs'], current)
    saved = json.loads((directory / measured['transcript']).read_text(encoding='utf-8'))
    if current_document != saved:
        # Historical cohorts used sequence IDs from partial_document; current
        # production assembly derives stable IDs from actual segment content.
        # Reconstruct the full alternate document from validated checkpoints,
        # never accept arbitrary saved IDs or copy saved text/times into it.
        assembled, prefix, assembled_issues = assembled_document(
            sample['audioHash'], plan, checkpoints, configuration['overlapMs'])
        if prefix == sample['durationMs'] and assembled_issues == issues:
            current_document = assembled
    if current_document != saved or issues != measured['issues'] or timing_issues(saved['segments'], sample['durationMs']):
        raise ValueError('Reconstructed document/warnings differ from the actual worker outcome')
    documents = (saved, partial_document(sample['audioHash'], 0, sample['durationMs'], legacy))
    return (*documents, current) if include_units else documents


def summarize(path):
    path = Path(path).resolve()
    run = json.loads(path.read_text(encoding='utf-8'))
    if run['referenceKind'] != 'human-continuous' or run['status'] not in ('passed', 'failed'):
        raise ValueError('Expected a terminal continuous human-reference run')
    manifest = load_continuous_manifest(run['manifestPath'])
    if digest(run['manifestPath']) != run['manifestSha256']:
        raise ValueError('Reference manifest changed after the model run')
    expected = {sample['id']: sample for sample in manifest['samples']}
    if len(run['samples']) != len(expected) or {sample['id'] for sample in run['samples']} != set(expected):
        raise ValueError('The worker report omits or duplicates a required sample')
    result = {'report': str(path), 'reportSha256': digest(path), 'engine': run['engine'], 'device': run['device'],
              'executionStatus': run['status'], 'samples': []}
    for measured in run['samples']:
        sample = expected[measured['id']]
        if measured['audioHash'] != sample['audioHash']:
            raise ValueError('Worker input differs from the fixed reference')
        row = {'id': sample['id'], 'status': measured['status'], 'speakers': sample['speakers'],
               'durationMs': sample['durationMs'], 'referenceTurns': len(sample['reference'])}
        result['samples'].append(row)
        if measured['status'] != 'completed':
            row.update(error=measured.get('error'), code=measured.get('code'))
            continue
        if (measured['cacheHits'] != 0 or measured['replayCacheHits'] != measured['totalChunks'] or
                measured['durationMs'] != sample['durationMs']):
            raise ValueError('Fresh-run identity or cache replay check is missing')
        actual, legacy = reconstructed_documents(path.parent, run, measured, sample)
        actual_text = normalize_text(''.join(segment['text'] for segment in actual['segments']))
        legacy_text = normalize_text(''.join(segment['text'] for segment in legacy['segments']))
        changes = [{'operation': tag, 'legacyCharacterOffset': i, 'actualCharacterOffset': k,
                    'legacy': legacy_text[i:j], 'actual': actual_text[k:l]}
                   for tag, i, j, k, l in SequenceMatcher(a=legacy_text, b=actual_text, autojunk=False).get_opcodes() if tag != 'equal']
        row.update(actual=score(sample['reference'], actual, sample['speechSeamsMs']),
                   legacyReplay=score(sample['reference'], legacy, sample['speechSeamsMs']),
                   processingTextChanges=changes,
                   issueCounts=dict(Counter(issue['code'] for issue in measured['issues'])),
                   generationMs=measured['generationMs'], firstReadablePartialMs=measured['firstReadablePartialMs'],
                   chunks=measured['totalChunks'])
    completed = [sample for sample in result['samples'] if sample['status'] == 'completed']
    for policy in ('actual', 'legacyReplay'):
        characters = sum(sample[policy]['wholeReference']['referenceCharacters'] for sample in completed)
        edits = sum(sample[policy]['wholeReference']['editDistance'] for sample in completed)
        seam_chars = sum(sample[policy]['seamCrossingTurns']['referenceCharacters'] for sample in completed)
        seam_edits = sum(sample[policy]['seamCrossingTurns']['editDistance'] for sample in completed)
        result[policy] = {'completedSamples': len(completed), 'expectedSamples': len(expected),
                          'referenceCharacters': characters, 'editDistance': edits,
                          'completedOnlyCER': edits / characters if characters else None,
                          'corpusCER': edits / characters if characters and len(completed) == len(expected) else None,
                          'seamCrossingTurnCharacters': seam_chars, 'seamCrossingTurnEdits': seam_edits,
                          'seamCrossingTurnCER': seam_edits / seam_chars if seam_chars and len(completed) == len(expected) else None}
    if len(completed) == len(expected) and not run.get('restartCheckpointReused'):
        raise ValueError('Successful whole cohort lacks the worker restart replay')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = {'status': 'summarized', 'createdAt': datetime.now(timezone.utc).isoformat(),
              'scoringSourcesSha256': {name: digest(Path(__file__).with_name(name)) for name in
                                      ('continuous_summary.py', 'continuous_reference.py', 'asr_metrics.py', 'asr_segments.py')},
              'scope': 'Three disjoint continuous spans, one already-used AISHELL-4 recording, 25 human turns; no official corpus or audiobook/default-engine accuracy claim.',
              'turnEditPolicy': 'One global minimum-edit alignment; ties substitution, deletion, insertion. Insertions use the following reference character, EOF the last turn. Seam scores include entire labeled turns crossing cuts, deduplicated by turn ID; no inferred per-character human times.',
              'legacyPolicy': 'Legacy midpoint ownership and temporal suffix deduplication on the exact same current recognition windows, not a separate old-version inference.',
              'runs': [summarize(path) for path in args.reports]}
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'runs': len(result['runs']), 'output': str(target)}), flush=True)


if __name__ == '__main__':
    main()
