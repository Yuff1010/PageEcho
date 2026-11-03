"""Compare exact existing human-reference cohorts without loading an ASR model.

The native summary functions validate source/checkpoint ownership and rescore.
An unchanged CER is a regression observation, never audiobook-quality acceptance.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'python'))
KINDS = {'human-studio-text': 'studio', 'human-continuous': 'continuous', 'human-film-text': 'film'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    path = Path(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Quality input exceeds 16 MiB')
    return json.loads(path.read_text(encoding='utf-8'))


def compare_quality(snapshot, summaries):
    """Pure comparison; the CLI first authenticates historical and native evidence."""
    if snapshot.get('schemaVersion') != 1 or not isinstance(snapshot.get('datasets'), list):
        raise ValueError('Invalid historical evidence snapshot')
    expected = {}
    for dataset in snapshot['datasets']:
        if dataset.get('id') not in KINDS.values():
            raise ValueError('Unknown historical reference cohort')
        for profile in dataset['profiles']:
            key = (dataset['id'], profile['engine'], profile['device'])
            if key in expected or profile['completedSamples'] != dataset['samples']:
                raise ValueError('Duplicate or incomplete historical profile')
            expected[key] = (dataset, profile)
    required = {(kind, engine, device) for kind in KINDS.values()
                for engine in ('paraformer', 'whisperx') for device in ('cpu', 'cuda')}
    if set(expected) != required:
        raise ValueError('Historical evidence must contain the exact twelve profiles')
    measured = {}
    for kind, summary in summaries:
        key = (kind, summary.get('engine'), summary.get('device'))
        if key not in expected or key in measured:
            raise ValueError('Unknown or duplicate current profile')
        dataset, _ = expected[key]
        if summary.get('manifestSha256') != dataset['manifestSha256']:
            raise ValueError('Current profile uses a different human reference manifest')
        if summary.get('expectedSamples') != dataset['samples']:
            raise ValueError('Current profile changed the sample denominator')
        measured[key] = summary
    rows = []
    for key in sorted(expected):
        dataset, baseline = expected[key]
        current = measured.get(key)
        row = {'dataset': key[0], 'engine': key[1], 'device': key[2],
               'expectedSamples': dataset['samples'], 'referenceCharacters': dataset['referenceCharacters'],
               'manifestSha256': dataset['manifestSha256'], 'baselineCER': baseline['cer'],
               'baselineEditDistance': baseline['editDistance'], 'baselineReportSha256': baseline['reportSha256'],
               'status': 'missing', 'currentCER': None, 'editDistanceDelta': None}
        rows.append(row)
        if current is None:
            continue
        row.update(report=current.get('report'), reportSha256=current.get('reportSha256'),
                   executionStatus=current.get('executionStatus'), scoredSamples=current.get('scoredSamples'),
                   scoredReferenceCharacters=current.get('scoredReferenceCharacters'),
                   completedOnlyCER=current.get('completedOnlyCER'), currentEditDistance=current.get('editDistance'))
        complete = (current.get('executionStatus') == 'passed' and
                    current.get('scoredSamples') == dataset['samples'] and
                    current.get('scoredReferenceCharacters') == dataset['referenceCharacters'] and
                    current.get('corpusCER') is not None)
        if not complete:
            row['status'] = 'incomplete'
            continue
        cer, edits = current['corpusCER'], current.get('editDistance')
        if isinstance(cer, bool) or not isinstance(cer, (int, float)) or not math.isfinite(cer) or cer < 0 \
                or type(edits) is not int or edits < 0 \
                or abs(cer - edits / dataset['referenceCharacters']) > 1e-12:
            raise ValueError('Current profile has inconsistent aggregate metrics')
        delta = edits - baseline['editDistance']
        row.update(status='increased' if delta > 0 else 'decreased' if delta < 0 else 'unchanged',
                   currentCER=cer, editDistanceDelta=delta, cerDelta=cer - baseline['cer'])
    complete = all(row['status'] not in ('missing', 'incomplete') for row in rows)
    return {'status': 'complete' if complete else 'incomplete',
            'comparison': ('contains-increases' if any(row['status'] == 'increased' for row in rows)
                           else 'unchanged' if all(row['status'] == 'unchanged' for row in rows)
                           else 'no-increases') if complete else 'not-comparable',
            'expectedProfiles': len(expected), 'expectedSampleResults': sum(row['expectedSamples'] for row in rows),
            'comparedProfiles': sum(row['status'] not in ('missing', 'incomplete') for row in rows),
            'novelQualityAcceptance': snapshot.get('novelQualityAcceptance', 'pending-human-review'),
            'qualityAcceptance': 'not-determined',
            'scope': 'Same fixed published human-reference cohorts and normalization only. CER changes are regression observations, not overall accuracy, human endpoint, default-engine, clean-device or audiobook acceptance. Missing and failed cohorts never receive full-corpus CER.',
            'profiles': rows}


def continuous_profile(summary, report):
    """Map the existing actual-stitch aggregate; never use legacy replay scores."""
    actual = summary['actual']
    return {**{key: summary[key] for key in ('report', 'reportSha256', 'engine', 'device', 'executionStatus')},
            'manifestSha256': report['manifestSha256'], 'expectedSamples': actual['expectedSamples'],
            'scoredSamples': actual['completedSamples'], 'scoredReferenceCharacters': actual['referenceCharacters'],
            'editDistance': actual['editDistance'], 'corpusCER': actual['corpusCER'],
            'completedOnlyCER': actual['completedOnlyCER']}


def native_summaries(paths, tool_overrides):
    from reference_summary import summarize as studio_summary
    from continuous_summary import summarize as continuous_summary
    from film_summary import summarize as film_summary
    summaries, errors = [], []
    for path in paths:
        try:
            report = read(path)
            kind = KINDS.get(report.get('referenceKind'))
            if kind is None:
                raise ValueError('Expected a published studio, continuous or film worker reference')
            configuration = report.get('configuration')
            if not isinstance(configuration, dict) or any(
                    report.get(key) != configuration.get(key) for key in ('engine', 'device')):
                raise ValueError('Profile engine/device differs from checkpoint configuration')
            if report.get('deviceRequested', report['device']) != report['device']:
                raise ValueError('Requested device differs from the measured profile')
            if kind == 'studio':
                summary = studio_summary(path, tool_overrides=tool_overrides)
            elif kind == 'continuous':
                summary = continuous_profile(continuous_summary(path), report)
            else:
                summary = film_summary(path)
            summaries.append((kind, summary))
        except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
            errors.append({'report': str(path), 'error': str(error), 'type': type(error).__name__})
    return summaries, errors


def exit_code(result):
    return 2 if result['status'] != 'complete' else 1 if result['comparison'] == 'contains-increases' else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='*', type=Path)
    parser.add_argument('--report-list', type=Path, help='JSON array of report paths, relative to this list or absolute')
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--ffprobe', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Existing comparison evidence must not be overwritten')
    if bool(args.ffmpeg) != bool(args.ffprobe):
        parser.error('Provide both --ffmpeg and --ffprobe, or neither')
    paths = list(args.reports)
    if args.report_list:
        values = read(args.report_list)
        if not isinstance(values, list) or any(not isinstance(value, str) or not value for value in values):
            raise ValueError('Report list must contain paths only')
        paths.extend((args.report_list.parent / value).resolve() for value in values)
    if len(paths) > 12 or len({path.resolve() for path in paths}) != len(paths):
        raise ValueError('Provide at most twelve distinct current reports')
    # This audits the shipped snapshot's original summaries, reports, audio,
    # checkpoints and reconstructed documents; it never runs inference.
    spec = importlib.util.spec_from_file_location('frozen_engine_audit', ROOT / 'scripts/audit-engine-reference.py')
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    snapshot, inventory = audit.build_snapshot()
    snapshot_path = ROOT / 'src/shared/engine-reference.json'
    if read(snapshot_path) != snapshot:
        raise ValueError('Shipped baseline differs from independently audited historical evidence')
    tools = {'ffmpeg': str(args.ffmpeg.resolve()), 'ffprobe': str(args.ffprobe.resolve())} if args.ffmpeg else None
    summaries, errors = native_summaries(paths, tools)
    result = compare_quality(snapshot, summaries)
    if errors:
        result.update(status='incomplete', comparison='not-comparable', validationErrors=errors)
    result.update(generatedAt=datetime.now(timezone.utc).isoformat(),
                  baselineSnapshotSha256=digest(snapshot_path), comparatorSha256=digest(__file__),
                  baselineAudit={'profiles': 12, 'sampleResults': len(inventory['documents']),
                                 'checkpoints': len(inventory['checkpoints'])},
                  sourceHashes={name: digest(ROOT / name) for name in (
                      'scripts/audit-engine-reference.py', 'python/reference_summary.py',
                      'python/continuous_summary.py', 'python/film_summary.py', 'python/asr_metrics.py',
                      'python/studio_reference.py', 'python/continuous_reference.py', 'python/chsims_reference.py')})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as target:
        target.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    code = exit_code(result)
    print(json.dumps({'status': result['status'], 'comparison': result['comparison'],
                      'profiles': result['comparedProfiles'], 'expectedProfiles': result['expectedProfiles'],
                      'output': str(args.output.resolve()), 'exitCode': code}, ensure_ascii=False))
    return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'error', 'error': str(error), 'type': type(error).__name__,
                          'exitCode': 2}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
