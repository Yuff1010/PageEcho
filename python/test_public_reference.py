"""Reference selection tests use invented text, no dataset/network/models."""

import unittest

from public_reference import select_reference_turns, textgrid_intervals
from reference_summary import aggregate, error_operations


class ReferenceTests(unittest.TestCase):
    def test_error_breakdown_keeps_fillers_and_agrees_with_minimum_edit_distance(self):
        self.assertEqual(error_operations('嗯甲乙丙丁', '甲乙丙丁')['deletedCharacters'], {'嗯': 1})
        self.assertEqual(error_operations('abcd', 'ad')['deletions'], 2)
        self.assertEqual(error_operations('ab', 'ac')['substitutions'], 1)
        self.assertEqual(error_operations('ab', 'abz')['insertions'], 1)

    def test_a_successful_subset_cannot_turn_failed_references_into_zero_error(self):
        summary = aggregate([{'accuracy': {'referenceCharacters': 20, 'editDistance': 1}}], 2)
        self.assertIsNone(summary['corpusCER'])
        self.assertEqual(summary['completedOnlyCER'], 0.05)
        self.assertEqual(summary['scoredReferenceCharacters'], 20)
        self.assertEqual(aggregate([], 2)['completedOnlyCER'], None)

    def test_long_format_preserves_speaker_time_and_escaped_quote(self):
        text = '''File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 3
tiers? <exists>
size = 1
item []:
  item [1]:
    class = "IntervalTier"
    name = "speaker-a"
    xmin = 0
    xmax = 3
    intervals: size = 2
    intervals [1]:
      xmin = 0
      xmax = 1.25
      text = ""
    intervals [2]:
      xmin = 1.25
      xmax = 3
      text = "她说""你好!""。"
'''
        duration, items = textgrid_intervals(text)
        self.assertEqual(duration, 3000)
        self.assertEqual(items, [{'id': 'speaker-a-2', 'speaker': 'speaker-a',
                                  'startMs': 1250, 'endMs': 3000, 'text': '她说"你好!"。'}])

    def test_short_format_ignores_comments_but_refuses_corrupt_domains(self):
        text = '"ooTextFile"\n"TextGrid"\n0 3 <exists> 1\n"IntervalTier" "a"\n0 3 2\n0 1 "" ! 99 "ignore"\n1 3 "你好"'
        self.assertEqual(textgrid_intervals(text)[1][0]['text'], '你好')
        for corrupt in (text.replace('1 3 "你好"', '0.5 3 "你好"'), text + '\n4', text[:-1]):
            with self.assertRaises(ValueError):
                textgrid_intervals(corrupt)

    def test_selection_rejects_core_overlap_and_uncertain_text_then_limits_context(self):
        def turn(identity, speaker, left, right, text='嗯这是用于验证选择规则的文字。'):
            return {'id': identity, 'speaker': speaker, 'startMs': left, 'endMs': right, 'text': text}
        items = [
            turn('a-overlap', 'a', 1000, 5000), turn('b-overlap', 'b', 4000, 7000),
            turn('a-unclear', 'a', 9000, 12000, '<%>这是不能当成完整参考的内容。'),
            turn('a-good', 'a', 20000, 24000, '嗯这是<sil>用于验证选择规则的文字。'),
            turn('b-good', 'b', 24050, 28000),
            turn('a-later', 'a', 30000, 34000),
        ]
        chosen = select_reference_turns(items, 40000, per_speaker=1)
        self.assertEqual([item['id'] for item in chosen], ['a-good', 'b-good'])
        self.assertTrue(chosen[0]['text'].startswith('嗯'))
        self.assertNotIn('<sil>', chosen[0]['text'])
        self.assertEqual((chosen[0]['cropStartMs'], chosen[0]['cropEndMs']), (19750, 24050))
        self.assertEqual((chosen[1]['cropStartMs'], chosen[1]['cropEndMs']), (24000, 28250))
        for item in chosen:
            self.assertFalse(any(other['id'] != item['id'] and other['startMs'] < item['cropEndMs']
                                 and other['endMs'] > item['cropStartMs'] for other in items))
        with self.assertRaises(ValueError):
            select_reference_turns(items, 40000, per_speaker=3)


if __name__ == '__main__':
    unittest.main()
