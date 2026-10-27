"""Human-turn score allocation without inventing character timestamps."""

import unittest

from continuous_summary import score, turn_edits


class ContinuousMetricsTests(unittest.TestCase):
    def setUp(self):
        self.reference = [{'id': 'first', 'text': '甲乙', 'startMs': 100, 'endMs': 40000},
                          {'id': 'second', 'text': '丙丁', 'startMs': 41000, 'endMs': 70000}]

    def test_deletion_remains_in_its_human_turn(self):
        rows = turn_edits(self.reference, '甲丙丁')
        self.assertEqual(rows[0]['deletions'], 1)
        self.assertEqual(rows[1]['editDistance'], 0)

    def test_boundary_insertion_has_an_explicit_following_turn_convention(self):
        rows = turn_edits(self.reference, '甲乙戊丙丁')
        self.assertEqual(rows[0]['editDistance'], 0)
        self.assertEqual(rows[1]['insertions'], 1)

    def test_a_turn_crossing_two_seams_is_scored_once_and_no_character_times_are_inferred(self):
        result = score(self.reference, {'segments': [{'text': '甲丙丁'}]}, [10000, 30000, 60000])
        self.assertEqual(result['wholeReference']['editDistance'], 1)
        self.assertEqual(result['seamCrossingTurns'], {'uniqueTurns': 2, 'referenceCharacters': 4, 'editDistance': 1, 'cer': .25})
        self.assertEqual([turn['turnIds'] for turn in result['turnInteriorSeams']], [['first'], ['first'], ['second']])


if __name__ == '__main__':
    unittest.main()
