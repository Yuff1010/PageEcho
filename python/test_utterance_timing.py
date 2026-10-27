"""Conditional timing must expose selection and never fabricate native anchors."""

import copy
import unittest

from utterance_timing import compare_runs, endpoint_rows, endpoint_statistics, occurrences


class UtteranceTimingTests(unittest.TestCase):
    def setUp(self):
        self.text = 'abcdefghijkl'
        self.reference = [{'id': 'a', 'text': self.text, 'startMs': 90, 'endMs': 240}]
        self.units = [{'text': char, 'startMs': 100 + index * 10, 'endMs': 110 + index * 10}
                      for index, char in enumerate(self.text)]

    def test_exact_native_edges_preserve_signed_errors_and_unicode_normalization(self):
        self.reference[0]['text'] = 'ＡＢＣＤＥＦＧＨＩＪＫＬ。'
        row = endpoint_rows(self.reference, self.units, 2000)[0]
        self.assertEqual(row['status'], 'matched')
        self.assertEqual((row['startErrorMs'], row['endErrorMs']), (10, -20))
        self.assertEqual((row['firstUnitIndex'], row['lastUnitIndex']), (0, 11))

    def test_repeated_reference_or_hypothesis_does_not_choose_a_location(self):
        reference = self.reference + [{**self.reference[0], 'id': 'b'}]
        self.assertEqual([row['reason'] for row in endpoint_rows(reference, self.units, 2000)], ['ambiguous-reference'] * 2)
        repeated = self.units + [{**unit, 'startMs': unit['startMs'] + 300, 'endMs': unit['endMs'] + 300} for unit in self.units]
        self.assertEqual(endpoint_rows(self.reference, repeated, 2000)[0]['reason'], 'ambiguous-hypothesis')
        self.assertEqual(occurrences('a' * 13, 'a' * 12), [0, 1])

    def test_inside_word_boundary_is_excluded_instead_of_interpolated(self):
        for text in ('x' + self.text, self.text + 'x', 'x' + self.text + 'y'):
            row = endpoint_rows(self.reference, [{'text': text, 'startMs': 100, 'endMs': 300}], 2000)[0]
            self.assertEqual(row['reason'], 'inside-indivisible-unit')
            self.assertNotIn('startErrorMs', row)

    def test_missing_or_short_turns_remain_visible_and_no_matches_is_null(self):
        reference = self.reference + [{'id': 'short', 'text': 'ab', 'startMs': 300, 'endMs': 400}]
        rows = endpoint_rows(reference, [], 2000)
        self.assertEqual([row['reason'] for row in rows], ['text-not-exact', 'short-reference'])
        stats = endpoint_statistics([])
        self.assertEqual(stats['start']['count'], 0)
        self.assertIsNone(stats['start']['p95AbsoluteMs'])
        self.assertIsNone(stats['end']['medianAbsoluteMs'])

    def test_large_errors_are_measured_without_distance_selection(self):
        self.reference[0].update(startMs=1500, endMs=1800)
        row = endpoint_rows(self.reference, self.units, 2000)[0]
        self.assertEqual(row['status'], 'matched')
        self.assertEqual(row['startErrorMs'], -1400)
        self.assertEqual(row['endErrorMs'], -1580)

    def test_invalid_native_or_human_times_and_duplicate_ids_fail(self):
        bad_units = copy.deepcopy(self.units)
        bad_units[0]['endMs'] = bad_units[0]['startMs']
        with self.assertRaises(ValueError):
            endpoint_rows(self.reference, bad_units, 2000)
        with self.assertRaises(ValueError):
            endpoint_rows(self.reference * 2, self.units, 2000)
        self.reference[0]['endMs'] = float('nan')
        with self.assertRaises(ValueError):
            endpoint_rows(self.reference, self.units, 2000)

    def test_p95_is_nearest_rank_and_median_is_not_a_zero_default(self):
        rows = [{'startErrorMs': value, 'endErrorMs': -value} for value in range(1, 21)]
        stats = endpoint_statistics(rows)
        self.assertEqual(stats['start']['medianAbsoluteMs'], 10.5)
        self.assertEqual(stats['start']['p95AbsoluteMs'], 19)
        self.assertEqual(stats['end']['medianSignedMs'], -10.5)

    def test_common_subset_preserves_full_coverage_and_worker_failures(self):
        first = {'manifestSha256': 'same', 'engine': 'paraformer', 'device': 'cuda', 'samples': [{'id': 'sample', 'turns': [
            {'id': 'a', 'status': 'matched', 'startErrorMs': 10, 'endErrorMs': -10},
            {'id': 'b', 'status': 'matched', 'startErrorMs': 500, 'endErrorMs': -500},
            {'id': 'c', 'status': 'excluded', 'reason': 'text-not-exact'}]}]}
        second = copy.deepcopy(first)
        second['engine'] = 'whisperx'
        second['samples'][0]['turns'][1] = {'id': 'b', 'status': 'excluded', 'reason': 'worker-not-completed'}
        result = compare_runs([first, second])
        self.assertEqual(result['commonTurns'], [{'sampleId': 'sample', 'turnId': 'a'}])
        self.assertEqual(first['timing']['matchedTurns'], 2)
        self.assertEqual(first['timing']['expectedTurns'], 3)
        self.assertEqual(first['timing']['conditional']['start']['maxAbsoluteMs'], 500)
        self.assertEqual(first['timing']['commonAcrossAllRuns']['start']['maxAbsoluteMs'], 10)
        self.assertEqual(second['timing']['excludedReasons']['worker-not-completed'], 1)
        with self.assertRaises(ValueError):
            compare_runs([first, copy.deepcopy(first)])
        second['manifestSha256'] = 'different'
        with self.assertRaises(ValueError):
            compare_runs([first, second])


if __name__ == '__main__':
    unittest.main()
