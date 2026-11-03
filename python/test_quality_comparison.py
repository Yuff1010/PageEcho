import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('quality_comparison', Path(__file__).resolve().parent.parent / 'scripts/compare-quality-reference.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class QualityComparisonTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {'schemaVersion': 1, 'novelQualityAcceptance': 'pending-human-review', 'datasets': []}
        self.summaries = []
        for kind in ('studio', 'continuous', 'film'):
            dataset = {'id': kind, 'samples': 2, 'referenceCharacters': 10, 'manifestSha256': kind * 8, 'profiles': []}
            self.snapshot['datasets'].append(dataset)
            for engine in ('paraformer', 'whisperx'):
                for device in ('cpu', 'cuda'):
                    dataset['profiles'].append({'engine': engine, 'device': device, 'completedSamples': 2,
                                                'editDistance': 2, 'cer': 0.2, 'reportSha256': 'baseline'})
                    self.summaries.append((kind, {'engine': engine, 'device': device,
                        'manifestSha256': dataset['manifestSha256'], 'expectedSamples': 2,
                        'executionStatus': 'passed', 'scoredSamples': 2, 'scoredReferenceCharacters': 10,
                        'editDistance': 2, 'corpusCER': 0.2, 'completedOnlyCER': 0.2}))

    def test_exact_complete_matrix_is_comparable_but_never_implies_book_quality_acceptance(self):
        result = comparison.compare_quality(self.snapshot, self.summaries)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['comparison'], 'unchanged')
        self.assertEqual(result['comparedProfiles'], 12)
        self.assertEqual(result['expectedSampleResults'], 24)
        self.assertEqual(result['qualityAcceptance'], 'not-determined')
        self.assertEqual(result['novelQualityAcceptance'], 'pending-human-review')

    def test_cer_increase_is_explicit_and_does_not_get_canceled_by_an_improved_profile(self):
        self.summaries[0][1].update(editDistance=3, corpusCER=0.3)
        self.summaries[1][1].update(editDistance=0, corpusCER=0.0)
        result = comparison.compare_quality(self.snapshot, self.summaries)
        self.assertEqual(result['comparison'], 'contains-increases')
        self.assertEqual(sum(row['status'] == 'increased' for row in result['profiles']), 1)
        self.assertEqual(sum(row['status'] == 'decreased' for row in result['profiles']), 1)

    def test_missing_or_failed_profiles_keep_original_denominators_and_no_full_cer(self):
        for changes in ({'executionStatus': 'failed'}, {'scoredSamples': 1},
                        {'scoredReferenceCharacters': 5}, {'corpusCER': None}):
            with self.subTest(changes=changes):
                rows = copy.deepcopy(self.summaries)
                rows[0][1].update(changes)
                result = comparison.compare_quality(self.snapshot, rows[:-1])
                self.assertEqual(result['status'], 'incomplete')
                self.assertEqual(result['comparison'], 'not-comparable')
                self.assertEqual(result['expectedSampleResults'], 24)
                for row in result['profiles']:
                    if row['status'] in ('incomplete', 'missing'):
                        self.assertIsNone(row['currentCER'])

    def test_changed_reference_duplicate_profile_or_inconsistent_metrics_cannot_be_compared(self):
        for changes in ({'manifestSha256': 'other'}, {'expectedSamples': 1},
                        {'editDistance': 99}, {'corpusCER': float('nan')}, {'corpusCER': True}):
            with self.subTest(changes=changes):
                rows = copy.deepcopy(self.summaries)
                rows[0][1].update(changes)
                with self.assertRaises(ValueError):
                    comparison.compare_quality(self.snapshot, rows)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            comparison.compare_quality(self.snapshot, [*self.summaries, self.summaries[0]])
        self.snapshot['datasets'][0]['profiles'].pop()
        with self.assertRaisesRegex(ValueError, 'twelve profiles'):
            comparison.compare_quality(self.snapshot, self.summaries)

    def test_continuous_profile_uses_actual_stitching_instead_of_better_legacy_or_subgroup_scores(self):
        native = {'report': 'fixture.json', 'reportSha256': 'fixed', 'engine': 'paraformer',
                  'device': 'cpu', 'executionStatus': 'passed',
                  'actual': {'expectedSamples': 3, 'completedSamples': 3, 'referenceCharacters': 100,
                             'editDistance': 20, 'corpusCER': 0.2, 'completedOnlyCER': 0.2,
                             'seamCrossingTurnCER': 0.01},
                  'legacyReplay': {'editDistance': 1, 'corpusCER': 0.01}}
        row = comparison.continuous_profile(native, {'manifestSha256': 'source'})
        self.assertEqual(row['editDistance'], 20)
        self.assertEqual(row['corpusCER'], 0.2)
        self.assertEqual(row['scoredReferenceCharacters'], 100)
        self.assertEqual(row['manifestSha256'], 'source')

    def test_profile_labels_must_match_checkpoint_configuration_before_scoring(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'report.json'
            for changes in ({'engine': 'whisperx'}, {'device': 'cuda'},
                            {'configuration': None}, {'deviceRequested': 'cuda'}):
                with self.subTest(changes=changes):
                    report = {'referenceKind': 'human-film-text', 'engine': 'paraformer', 'device': 'cpu',
                              'configuration': {'engine': 'paraformer', 'device': 'cpu'}}
                    report.update(changes)
                    path.write_text(json.dumps(report), encoding='utf-8')
                    with patch('film_summary.summarize') as score:
                        summaries, errors = comparison.native_summaries([path], None)
                    score.assert_not_called()
                    self.assertEqual(summaries, [])
                    self.assertEqual(len(errors), 1)
                    result = comparison.compare_quality(self.snapshot, summaries)
                    self.assertEqual(result['status'], 'incomplete')
                    self.assertEqual(result['comparedProfiles'], 0)

    def test_failed_validation_subprocess_is_incomplete_instead_of_a_cer_increase(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'report.json'
            path.write_text(json.dumps({'referenceKind': 'human-film-text', 'engine': 'paraformer', 'device': 'cpu',
                                       'configuration': {'engine': 'paraformer', 'device': 'cpu'}}), encoding='utf-8')
            for failure in (subprocess.CalledProcessError(3, ['synthetic-validator']),
                            subprocess.TimeoutExpired(['synthetic-validator'], 1)):
                with self.subTest(failure=type(failure).__name__):
                    with patch('film_summary.summarize', side_effect=failure):
                        summaries, errors = comparison.native_summaries([path], None)
                    self.assertEqual(len(errors), 1)
                    self.assertEqual(errors[0]['type'], type(failure).__name__)
                    result = comparison.compare_quality(self.snapshot, summaries)
                    self.assertEqual(result['comparison'], 'not-comparable')
                    self.assertEqual(comparison.exit_code(result), 2)
