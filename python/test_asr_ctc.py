"""Private compatibility binding tests without importing models or Torch."""

import unittest
from unittest.mock import patch

from asr_ctc import CTC_ALIGNMENT_CONTRACT, WHISPERX_386_ALIGNMENT_SHA256, _bind_complete_alignment


def get_trellis(emission, tokens, blank_id=0):
    return 'native', emission, tokens, blank_id


def fixture_align(emission, tokens, blank_id=0, *, option='original'):
    return get_trellis(emission, tokens, blank_id), option


class CTCTests(unittest.TestCase):
    def test_only_the_returned_function_uses_the_complete_objective(self):
        original = fixture_align.__globals__['get_trellis']
        with patch('asr_ctc._blank_relative_trellis', return_value='complete') as operation:
            aligned = _bind_complete_alignment(fixture_align, '3.8.6', WHISPERX_386_ALIGNMENT_SHA256)
            self.assertEqual(aligned('audio', ['甲'], 7), ('complete', 'original'))
            operation.assert_called_once_with(original, 'audio', ['甲'], 7)
            self.assertEqual(aligned('audio', ['乙'], option='kept'), ('complete', 'kept'))
        self.assertIs(fixture_align.__globals__['get_trellis'], original)
        self.assertEqual(fixture_align('audio', ['甲']), (('native', 'audio', ['甲'], 0), 'original'))

    def test_a_different_implementation_is_not_silently_patched(self):
        for version, sha256 in [('3.8.6', '0' * 64), ('3.8.7', WHISPERX_386_ALIGNMENT_SHA256)]:
            with self.assertRaisesRegex(ValueError, 'differs'):
                _bind_complete_alignment(fixture_align, version, sha256)

    def test_the_same_function_cannot_be_normalized_twice(self):
        aligned = _bind_complete_alignment(fixture_align, '3.8.6', WHISPERX_386_ALIGNMENT_SHA256)
        self.assertEqual(aligned._ralb_ctc_contract, CTC_ALIGNMENT_CONTRACT)
        self.assertIs(_bind_complete_alignment(aligned, '3.8.6', WHISPERX_386_ALIGNMENT_SHA256), aligned)


if __name__ == '__main__':
    unittest.main()
