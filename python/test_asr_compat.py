"""Exercise the alpha/peak contract without importing Torch/FunASR/models."""

import unittest

from asr_compat import (
    FUNASR_1416_MODULE_SHA256, PARAFORMER_TIMESTAMP_CONTRACT,
    _bind_corrected_timestamp_call,
)


def ts_prediction_lfr6_standard(us_alphas, us_peaks, char_list, vad_offset=0, upsample_rate=1):
    # Distinct payloads make reversed arguments observable, without making up times.
    return us_alphas, us_peaks, char_list, vad_offset, upsample_rate


class PinnedParaformer:
    def inference(self, peaks, alphas, characters, offset=0):
        return ts_prediction_lfr6_standard(peaks, alphas, characters, vad_offset=offset, upsample_rate=1)


class CompatibilityTests(unittest.TestCase):
    def test_only_the_selected_instance_passes_alpha_and_peaks_in_declared_order(self):
        first, untouched = PinnedParaformer(), PinnedParaformer()
        alphas, peaks, text = [0.2, 0.8, 0.4], [0, 1, 0], ['甲', '乙']
        original_method = PinnedParaformer.inference
        state = _bind_corrected_timestamp_call(first, '1.4.16', FUNASR_1416_MODULE_SHA256)
        self.assertEqual(state, PARAFORMER_TIMESTAMP_CONTRACT)
        result = first.inference(peaks, alphas, text, offset=30000)
        self.assertIs(result[0], alphas)
        self.assertIs(result[1], peaks)
        self.assertIs(result[2], text)
        self.assertEqual(result[3:], (30000, 1))
        self.assertIs(PinnedParaformer.inference, original_method)
        self.assertIs(untouched.inference(peaks, alphas, text)[0], peaks)
        self.assertIs(ts_prediction_lfr6_standard, original_method.__globals__['ts_prediction_lfr6_standard'])
        self.assertEqual(_bind_corrected_timestamp_call(first, '1.4.16', FUNASR_1416_MODULE_SHA256), state)
        self.assertIs(first.inference(peaks, alphas, text)[0], alphas, 'repeated initialization must not swap twice')

    def test_unknown_code_at_the_affected_version_is_rejected_and_other_versions_are_not_patched(self):
        model = PinnedParaformer()
        with self.assertRaisesRegex(ValueError, 'differs'):
            _bind_corrected_timestamp_call(model, '1.4.16', '0' * 64)
        self.assertNotIn('inference', model.__dict__)
        self.assertEqual(_bind_corrected_timestamp_call(model, 'next-release', 'unknown'), 'native')
        self.assertNotIn('inference', model.__dict__)


if __name__ == '__main__':
    unittest.main()
