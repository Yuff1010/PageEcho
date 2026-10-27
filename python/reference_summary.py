"""Summarize real human-reference runs without treating failed samples as correct."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections import Counter
from asr_metrics import character_error_rate, normalize_text, timing_issues
from public_reference import digest, load_reference_manifest
from studio_reference import load_studio_manifest


def error_operations(reference, hypothesis):
    """One minimum-edit alignment; ties prefer substitution, deletion, insertion."""
    reference, hypothesis = normalize_text(reference), normalize_text(hypothesis)
    matrix = [list(range(len(hypothesis) + 1))]
    for i, expected in enumerate(reference, 1):
        row = [i]
        for j, actual in enumerate(hypothesis, 1):
            row.append(min(matrix[-1][j] + 1, row[-1] + 1, matrix[-1][j - 1] + (expected != actual)))
        matrix.append(row)
    i, j = len(reference), len(hypothesis)
    counts, deleted = Counter(), Counter()
    while i or j:
        if i and j and reference[i - 1] == hypothesis[j - 1] and matrix[i][j] == matrix[i - 1][j - 1]:
            i, j = i - 1, j - 1
        elif i and j and matrix[i][j] == matrix[i - 1][j - 1] + 1:
            counts['substitutions'] += 1
            i, j = i - 1, j - 1
        elif i and matrix[i][j] == matrix[i - 1][j] + 1:
            counts['deletions'] += 1
            deleted[reference[i - 1]] += 1
            i -= 1
        else:
            counts['insertions'] += 1
            j -= 1
    return {**{key: counts[key] for key in ('substitutions', 'deletions', 'insertions')},
            'deletedCharacters': dict(deleted)}


def aggregate(scores, expected_samples):
    characters = sum(item['accuracy']['referenceCharacters'] for item in scores)
    edits = sum(item['accuracy']['editDistance'] for item in scores)
    completed_only = edits / characters if characters else None
    return {'scoredSamples': len(scores), 'expectedSamples': expected_samples,
            'scoredReferenceCharacters': characters, 'editDistance': edits,
            'completedOnlyCER': completed_only,
            'corpusCER': completed_only if len(scores) == expected_samples else None}


def summarize(report_path):
    report_path = Path(report_path).resolve()
    report = json.loads(report_path.read_text(encoding='utf-8'))
    if report['status'] not in ('passed', 'failed'):
        raise ValueError('Only terminal runs may be summarized')
    adapter = 'referenceManifest' in report
    studio = report.get('referenceKind') == 'human-studio-text'
    if studio and adapter:
        raise ValueError('Studio reference requires an actual application-worker report')
    manifest_path = report['referenceManifest']['path'] if adapter else report['manifestPath']
    manifest = load_studio_manifest(manifest_path) if studio else load_reference_manifest(manifest_path)
    if adapter and digest(manifest_path) != report['referenceManifest']['sha256']:
        raise ValueError('Reference manifest changed after the benchmark')
    if (studio or 'manifestSha256' in report) and digest(manifest_path) != report.get('manifestSha256'):
        raise ValueError('Worker reference manifest changed after the benchmark')
    expected = {sample['id']: sample for sample in manifest['samples']}
    if len(report['samples']) != len(expected) or {sample['id'] for sample in report['samples']} != set(expected):
        raise ValueError('The report omits or duplicates a reference sample')
    scores, states, boundaries, durations, by_speaker = [], [], [], [], {}
    for sample in report['samples']:
        reference = expected[sample['id']]
        if sample['audioHash'] != reference['audioHash']:
            raise ValueError('Report audio version differs from the reference')
        if adapter:
            if sample['reference'] != reference['reference'] or len(sample['attempts']) != 1:
                raise ValueError('This summary requires the unchanged reference and one measured attempt')
            attempt = sample['attempts'][0]
            accuracy = attempt.get('accuracy')
            state = {'id': sample['id'], 'speaker': reference['speaker'], 'status': attempt['status'],
                     'timingIssues': attempt.get('timingIssues'), 'accuracy': accuracy,
                     'alignmentFallback': attempt.get('alignmentFallback', False)}
            boundaries.extend(attempt.get('coarseBoundaryComparison', {}).get('sentences', []))
            if accuracy:
                raw_path = report_path.parent / f"{sample['id']}-1.raw.json"
                raw = json.loads(raw_path.read_text(encoding='utf-8'))
                hypothesis = (''.join(item.get('text', '') for item in raw) if report['engine'] == 'paraformer'
                              else ''.join(item['text'] for item in raw['recognition']['segments']))
                text = ''.join(item['text'] for item in reference['reference'])
                if accuracy != character_error_rate(text, hypothesis):
                    raise ValueError('Stored accuracy does not match the original model output')
                state['rawSha256'] = digest(raw_path)
                state['errorOperations'] = error_operations(text, hypothesis)
                scores.append(state)
                durations.append((sample['durationMs'], attempt['recognitionMs'] + (attempt['alignmentMs'] or 0)))
        else:
            accuracy = None
            state = {'id': sample['id'], 'speaker': reference['speaker'], 'status': sample['status'],
                     'errorCode': sample.get('code'), 'error': sample.get('error'), 'accuracy': None,
                     'issues': sample.get('issues', [])}
            if sample['status'] == 'completed':
                if studio:
                    from continuous_summary import reconstructed_documents
                    document, _ = reconstructed_documents(report_path.parent, report, sample, reference)
                else:
                    document = json.loads((report_path.parent / sample['transcript']).read_text(encoding='utf-8'))
                if document['audioHash'] != reference['audioHash'] or timing_issues(document['segments'], sample['durationMs']):
                    raise ValueError('Invalid worker transcript')
                accuracy = character_error_rate(''.join(item['text'] for item in reference['reference']),
                                                ''.join(item['text'] for item in document['segments']))
                state['accuracy'] = accuracy
                state['errorOperations'] = error_operations(''.join(item['text'] for item in reference['reference']),
                                                           ''.join(item['text'] for item in document['segments']))
                scores.append(state)
        states.append(state)
        by_speaker.setdefault(reference['speaker'], []).append(state)
    matched = [item for item in boundaries if item.get('matched')]
    result = {'report': str(report_path), 'reportSha256': digest(report_path),
              'referenceKind': 'human-studio-text' if studio else 'human-isolated',
              'manifestSha256': digest(manifest_path),
              'kind': 'raw-model-adapter' if adapter else 'application-worker',
              'engine': report['engine'], 'device': report.get('deviceRequested', report.get('device')),
              'executionStatus': report['status'],
              **aggregate(scores, len(expected)),
              'perSpeaker': {speaker: aggregate([item for item in items if item['accuracy']], len(items))
                             for speaker, items in by_speaker.items()},
              'samples': states}
    if studio:
        result['perReferenceCategory'] = {
            category: aggregate([item for item in states if expected[item['id']]['category'] == category and item['accuracy']],
                                sum(sample['category'] == category for sample in manifest['samples']))
            for category in sorted({sample['category'] for sample in manifest['samples']})}
        result['referenceScope'] = 'all publisher sample test utterances; human text only, no human timing; canonical spelling/number rendering differences remain CER edits; training overlap unknown'
    deleted = Counter()
    for item in scores:
        deleted.update(item['errorOperations']['deletedCharacters'])
    result['errorOperations'] = {
        **{key: sum(item['errorOperations'][key] for item in scores) for key in ('substitutions', 'deletions', 'insertions')},
        'mostFrequentDeletedCharacters': deleted.most_common(10),
        'tiePolicy': 'one minimum-edit alignment; ties prefer substitution, deletion, insertion',
    }
    if adapter:
        result['nativeRealignedSamples'] = sum(item['alignmentFallback'] for item in states)
        result['invalidTimestampSamples'] = sum(bool(item['timingIssues']) for item in states)
        result['conditionalBoundaryComparison'] = {
            'exactMatchedTurns': len(matched), 'totalTurns': len(expected),
            'maxAbsStartDeltaMs': max((abs(item['startDeltaMs']) for item in matched), default=None),
            'maxAbsEndDeltaMs': max((abs(item['endDeltaMs']) for item in matched), default=None),
            'scope': 'published utterance endpoints, exact-text matches only; conditional selection, not global alignment error',
        }
        result['recognitionAlignmentRTF'] = sum(value[1] for value in durations) / sum(value[0] for value in durations) if durations else None
        result['loadMs'] = report['loadMs']
        result['totalProcessMs'] = report['totalProcessMs']
    else:
        result['nativeRealignedSamples'] = sum(any(issue['code'] == 'NATIVE_REALIGNED' for issue in item['issues']) for item in states)
        result['failedSamples'] = sum(item['status'] != 'completed' for item in states)
        result['failurePolicy'] = 'no full-subset CER when any sample fails; completed-only CER excludes failed reference characters'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    runs = [summarize(path) for path in args.reports]
    kinds = {run['referenceKind'] for run in runs}
    if len(kinds) != 1:
        raise ValueError('Summarize distinct reference cohorts separately')
    summary = {'status': 'summarized', 'createdAt': datetime.now(timezone.utc).isoformat(),
               'scope': ('40 original AISHELL-3 publisher test samples, two speakers; short dry-scripted speech, no audiobook/default-engine/phoneme-time or official corpus quality claim'
                         if kinds == {'human-studio-text'} else '15 isolated turns, 5 speakers, one AISHELL-4 meeting; no audiobook/default-engine or official corpus quality claim'),
               'runs': runs}
    Path(args.output).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': summary['status'], 'runs': len(summary['runs']), 'output': str(Path(args.output).resolve())}), flush=True)


if __name__ == '__main__':
    main()
