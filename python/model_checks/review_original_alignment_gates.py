"""Re-score saved real emissions/native paths, without re-running inference."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asr_original_alignment import CONTRACT, QUALITY_POLICY, THRESHOLDS, emission_evidence, quality_reasons


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def audit_provenance(source, original, score_path, output):
    """Correct metadata only; preserve previously published quality verbatim."""
    score = json.loads(score_path.read_text(encoding='utf-8'))
    if score['sourceReportSha256'] != digest(source) or len(score['cases']) != len(original['cases']):
        raise ValueError('Score report does not bind the supplied original real-model report')
    provenance_keys = {'nativeAlignmentInSourceReport', 'emissionSha256', 'emissionScope', 'emissionSourceCase'}

    def quality_digest(value):
        cases = [{key: item for key, item in case.items() if key not in provenance_keys}
                 for case in value['cases']]
        values = {'cases': cases, 'summary': value['summary'], 'thresholds': value['thresholds']}
        return hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True,
                                         separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()

    before = quality_digest(score)
    corrected, native_count, unsupported = 0, 0, {}
    origins = {}
    for index, (case, raw) in enumerate(zip(score['cases'], original['cases'])):
        if any(case.get(key) != raw.get(key) for key in ('id', 'control', 'fold', 'text', 'textSha256', 'samples')):
            raise ValueError('Source-case identity or ordering changed')
        native = 'nativeAlignment' in raw['result']
        corrected += case.get('nativeAlignmentInSourceReport') != native
        case['nativeAlignmentInSourceReport'] = native
        if native:
            native_count += 1
            path = source.parent / (case['id'] + '-emission.pt')
            if not path.is_file():
                raise ValueError('Saved acoustic emission is missing: ' + str(path))
            saved_hash = digest(path)
            if case['emissionSha256'] != saved_hash:
                raise ValueError('Saved emission hash changed')
            origins.setdefault(case['id'], {'sourceCaseIndex': index, 'id': case['id'], 'control': case['control']})
            case['emissionScope'] = 'shared-source-waveform; retained from the first inferred control for this input audio'
            case['emissionSourceCase'] = origins[case['id']]
        else:
            case['emissionSha256'] = None
            case['emissionScope'] = None
            case['emissionSourceCase'] = None
        if any(reason['code'] == 'UNSUPPORTED_CHARACTERS' for reason in raw['result']['reasons']):
            unsupported[case['control']] = unsupported.get(case['control'], 0) + 1
    after = quality_digest(score)
    if before != after:
        raise AssertionError('Provenance correction changed quality/identity/denominator fields')
    output.mkdir(parents=True, exist_ok=False)
    # Keep the exact score-producer snapshot; the separate audit snapshot
    # explains metadata corrections without pretending to re-run that producer.
    shutil.copytree(score_path.parent / 'sources', output / 'sources')
    (output / 'audit-sources').mkdir()
    shutil.copyfile(__file__, output / 'audit-sources' / Path(__file__).name)
    score['provenanceAudit'] = {
        'status': 'passed', 'checkedAt': datetime.now(timezone.utc).isoformat(),
        'scoreReport': str(score_path), 'scoreReportSha256': digest(score_path),
        'auditScriptSha256': digest(Path(__file__)), 'correctedNativeFlags': corrected,
        'nativeAlignmentCases': native_count, 'earlyRejectedCases': len(score['cases']) - native_count,
        'unsupportedByControl': unsupported, 'qualityFieldsUnchanged': True,
        'qualitySha256Before': before, 'qualitySha256After': after,
        'newInference': False,
        'emissionScope': 'input-only emission files are shared across controls; an early rejected case never claims the shared emission as its own inference',
    }
    target = output / 'report.json'
    target.write_text(json.dumps(score, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(target), 'audit': score['provenanceAudit']}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', required=True)
    parser.add_argument('--component', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--audit-existing', help='Correct provenance metadata in this prior score report without rescoring')
    args = parser.parse_args()
    source = Path(args.report).resolve()
    original = json.loads(source.read_text(encoding='utf-8'))
    if original['status'] != 'compared' or not original['componentUnchanged']:
        raise ValueError('Expected completed, unchanged-component real-model report')
    output = Path(args.output).resolve()
    if args.audit_existing:
        audit_provenance(source, original, Path(args.audit_existing).resolve(), output)
        return
    output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    component = Path(args.component).resolve()
    resources = json.loads(component.read_text(encoding='utf-8'))
    models_path = component.parent / resources['models']
    models = json.loads(models_path.read_text(encoding='utf-8'))
    vocabulary_path = models_path.parent / models['models']['alignment']['path'] / 'vocab.json'
    vocabulary = {key.lower(): value for key, value in json.loads(vocabulary_path.read_text(encoding='utf-8')).items()}
    # Loading tensors only needs Torch, no model/WhisperX weights or networking.
    import torch
    report = {'status': 'rescored', 'preparedAt': datetime.now(timezone.utc).isoformat(),
              'sourceReport': str(source), 'sourceReportSha256': digest(source),
              'contract': CONTRACT, 'qualityPolicy': QUALITY_POLICY, 'thresholds': THRESHOLDS,
              'componentUnchangedInSourceRun': True, 'vocabularySha256': digest(vocabulary_path),
              'newInference': False, 'selection': original['selection'], 'folds': original['folds'],
              'qualityScope': original['qualityScope'],
              'selectionRationale': 'Nonzero free-path error tolerance retains supported alternative spellings; each target still needs posterior support. Internal-deletion miss is retained and disclosed rather than forcing zero-edit acceptance.',
              'cases': [], 'summary': {}}
    (output / 'sources').mkdir()
    for name in ('asr_original_alignment.py', 'asr_engines.py', 'asr_ctc.py'):
        shutil.copyfile(root / 'python' / name, output / 'sources' / name)
    shutil.copyfile(__file__, output / 'sources' / Path(__file__).name)
    for item in original['cases']:
        result = item['result']
        if 'nativeAlignment' in result:
            path = source.parent / (item['id'] + '-emission.pt')
            emission = torch.load(path, map_location='cpu', weights_only=True)
            _, evidence, reasons = emission_evidence(item['samples'] / 16000, result['evidence']['audioRms'],
                                                    item['text'], {'dictionary': vocabulary},
                                                    result['nativeAlignment'], emission)
            reasons += quality_reasons(evidence)
            emission_hash = digest(path)
        else:
            evidence, reasons, emission_hash = result['evidence'], result['reasons'], None
        report['cases'].append({key: value for key, value in item.items() if key != 'result'} | {
            'accepted': not reasons, 'evidence': evidence, 'reasons': reasons,
            'emissionSha256': emission_hash, 'nativeAlignmentInSourceReport': 'nativeAlignment' in result})
    for fold in ('all', 'calibration', 'holdout', 'control'):
        groups = {}
        for item in report['cases']:
            if fold != 'all' and item['fold'] != fold:
                continue
            group = groups.setdefault(item['control'], {'total': 0, 'accepted': 0, 'rejected': 0})
            group['total'] += 1
            group['accepted' if item['accepted'] else 'rejected'] += 1
        report['summary'][fold] = groups
    report['sourceHashes'] = {path.name: digest(path) for path in (output / 'sources').iterdir()}
    target = output / 'report.json'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(target), 'summary': report['summary'], 'thresholds': THRESHOLDS}), flush=True)


if __name__ == '__main__':
    main()
