import unittest

from asr_metrics import (
    character_error_rate,
    reference_boundary_comparison,
    timing_issues,
    transcript_document,
)


class MetricsTest(unittest.TestCase):
    def test_cer_chinese_substitution_deletion_insertion_and_punctuation(self):
        self.assertEqual(character_error_rate("甲，乙丙。", "甲丁丙")['editDistance'], 1)
        self.assertEqual(character_error_rate("甲乙丙", "甲丙")['editDistance'], 1)
        self.assertEqual(character_error_rate("甲", "甲乙丙")['cer'], 2)
        self.assertEqual(character_error_rate("ＡＢＣ１２", "abc12")['cer'], 0)
        with self.assertRaises(ValueError):
            character_error_rate("，", "甲")

    def test_offset_preserves_original_song_timeline(self):
        document = transcript_document("a" * 64, 30000, 60000, [
            {"startMs": 1200, "endMs": 4500, "text": " 第一段。 "},
            {"startMs": 58000, "endMs": 60000, "text": "末尾"},
        ])
        self.assertEqual(document['coverage'], [{"startMs": 30000, "endMs": 90000}])
        self.assertEqual(document['segments'][0]['startMs'], 31200)
        self.assertEqual(document['segments'][-1]['endMs'], 90000)
        self.assertEqual(document['segments'][0]['text'], '第一段。')

    def test_bad_alignment_is_reported_and_never_silently_clipped(self):
        segments = [{"startMs": 0, "endMs": 1000, "text": "甲"},
                    {"startMs": 999, "endMs": 1501, "text": "乙"}]
        self.assertEqual(len(timing_issues(segments, 1500)), 2)
        with self.assertRaises(ValueError):
            transcript_document("a" * 64, 0, 1500, segments)
        self.assertTrue(timing_issues([{"startMs": float('nan'), "endMs": 2}], 3))

    def test_boundary_matching_does_not_fabricate_times_for_wrong_words(self):
        result = reference_boundary_comparison([
            {"id": "a", "startMs": 1000, "endMs": 2000, "text": "甲乙。"},
            {"id": "b", "startMs": 3000, "endMs": 4000, "text": "丙丁。"},
        ], [{"text": "甲", "startMs": 1050, "endMs": 1300},
            {"text": "乙", "startMs": 1500, "endMs": 1900},
            {"text": "丙戊", "startMs": 3000, "endMs": 4000}])
        self.assertEqual(result['sentences'][0]['startDeltaMs'], 50)
        self.assertEqual(result['sentences'][0]['endDeltaMs'], -100)
        self.assertEqual(result['sentences'][1], {"id": "b", "matched": False})


if __name__ == '__main__':
    unittest.main()
