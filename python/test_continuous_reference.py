"""Metadata-only selection invariants; no download or model dependency."""

import unittest

from continuous_reference import clean_text, eligible_windows, select_windows


def turn(identifier, speaker, start, end, text='甲乙丙丁戊己庚辛壬癸' * 8):
    return {'id': identifier, 'speaker': speaker, 'startMs': start, 'endMs': end, 'text': text}


def annotated_groups():
    items = []
    for group, offset in enumerate((1000, 121000, 241000)):
        for index in range(5):
            speaker = 'A' if group == 0 else ('A' if index % 2 == 0 else 'B') if group == 1 else 'B'
            items.append(turn(f'{group}-{index}', speaker, offset + index * 20000, offset + index * 20000 + 18000))
    return items


class ContinuousSelectionTests(unittest.TestCase):
    def test_earliest_roles_are_disjoint_and_include_speech_crossing_multiple_seams(self):
        chosen = select_windows(annotated_groups(), 350000)
        self.assertEqual([item['role'] for item in chosen], ['solo-first', 'dialogue-first', 'solo-other'])
        self.assertEqual(chosen[0]['sourceStartMs'], 750)
        self.assertEqual(chosen[0]['speakers'], ['A'])
        self.assertEqual(chosen[1]['speakers'], ['A', 'B'])
        self.assertEqual(chosen[2]['speakers'], ['B'])
        for item in chosen:
            self.assertTrue(90000 <= item['sourceEndMs'] - item['sourceStartMs'] <= 120000)
            self.assertGreaterEqual(len(item['speechSeamsMs']), 2)
        for first, second in zip(chosen, chosen[1:]):
            self.assertLessEqual(first['sourceEndMs'], second['sourceStartMs'])

    def test_overlap_and_partial_turns_cannot_be_hidden_to_create_an_eligible_window(self):
        items = annotated_groups()[:5]
        items.append(turn('overlap', 'B', 2000, 98500))
        items.sort(key=lambda item: (item['startMs'], item['speaker']))
        self.assertEqual(list(eligible_windows(items, 110000)), [])
        with self.assertRaisesRegex(ValueError, 'not relaxed'):
            select_windows(items, 110000)

    def test_cuts_in_silence_or_at_turn_edges_do_not_satisfy_speech_seams(self):
        items = [turn(str(index), 'A', index * 30000, index * 30000 + 10000) for index in range(4)]
        self.assertEqual(list(eligible_windows(items, 130000)), [])

    def test_only_the_explicit_silence_marker_is_removed_and_audible_fillers_remain(self):
        self.assertEqual(clean_text('嗯<sil>这个呃例子'), '嗯这个呃例子')
        self.assertIsNone(clean_text('这个<noise>例子'))
        self.assertIsNone(clean_text('这个&不确定'))


if __name__ == '__main__':
    unittest.main()
