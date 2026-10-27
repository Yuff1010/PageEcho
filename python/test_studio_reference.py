import unittest

from studio_reference import expected_reference, parse_content


class StudioReferenceTests(unittest.TestCase):
    def test_human_characters_are_kept_and_pinyin_is_not_scored_as_text(self):
        value = parse_content('SSB00090030.wav\t碗 wan2 碗 wan3 香 xiang1\n'.encode())
        self.assertEqual(value['SSB00090030.wav'], {'text': '碗碗香', 'pinyin': ['wan2', 'wan3', 'xiang1']})

    def test_short_number_reference_is_not_filtered_or_rewritten(self):
        rows = parse_content('SSB00090179.wav\t一 yi1\n'.encode())
        row = expected_reference('SSB00090179.wav', {**rows['SSB00090179.wav'], 'speaker': 'SSB0009', 'entry': 'published.wav'})
        self.assertEqual(row['reference'], [{'id': 'SSB00090179', 'text': '一'}])
        self.assertEqual(row['category'], 'numeric-characters-only')
        self.assertNotIn('startMs', row['reference'][0])

    def test_duplicate_utterance_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            parse_content(('SSB00090179.wav\t一 yi1\n' * 2).encode())

    def test_missing_pair_or_unexpected_token_is_not_silently_removed(self):
        for payload in ('一', '一 yi1 leftover', '一 missingtone', 'abc abc1', '一 yi1 #3 p3'):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_content(f'SSB00090179.wav\t{payload}\n'.encode())

    def test_filename_cannot_be_a_path(self):
        with self.assertRaises(ValueError):
            parse_content('../elsewhere.wav\t一 yi1\n'.encode())


if __name__ == '__main__':
    unittest.main()
