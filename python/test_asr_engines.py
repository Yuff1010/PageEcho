"""Alignment fallback contracts, using no model dependencies or downloads."""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from asr_engines import AlignmentError, ChineseCTCAligner, Paraformer, WhisperX, bounded_alignment_input


def native(end=1050):
    return [{'text': '甲乙。', 'timestamp': [[100, 300], [600, end]],
             'sentence_info': [{'start': 100, 'end': end, 'text': '甲乙。'}]}]


def aligned(missing=False):
    return {'segments': [{'start': 0.1, 'end': 0.8, 'text': '甲乙。', 'chars': [
        {'char': '甲', 'start': 0.1, 'end': 0.3},
        {'char': '乙', **({} if missing else {'start': 0.6, 'end': 0.8})}, {'char': '。'},
    ]}]}


def engine(raw):
    value = Paraformer.__new__(Paraformer)
    value.model = SimpleNamespace(generate=lambda **_: raw)
    value.models, value.device, value.aligner, value.timestamp_contract = {}, 'cpu', None, 'fixture'
    return value


class EngineTests(unittest.TestCase):
    def test_native_surface_punctuation_and_name_case_are_preserved_on_real_anchors(self):
        raw = [{'text': 'Q甲，乙。', 'timestamp': [[100, 200], [200, 400], [600, 800]],
                'sentence_info': [{'start': 100, 'end': 800, 'text': 'Q甲，乙。'}]}]
        with patch('asr_engines.ChineseCTCAligner', side_effect=AssertionError('unnecessary realignment')):
            result = engine(raw).transcribe([0] * 16000)
        self.assertEqual(''.join(item['text'] for item in result['timedUnits']), 'Q甲，乙。')
        self.assertTrue(result['punctuationRestored'])
        self.assertEqual([(item['startMs'], item['endMs']) for item in result['timedUnits']], [(100, 200), (200, 400), (600, 800)])

    def test_valid_native_times_do_not_load_an_aligner(self):
        raw = native(800)
        with patch('asr_engines.ChineseCTCAligner', side_effect=AssertionError('unnecessary model load')):
            result = engine(raw).transcribe([0] * 16000)
        self.assertFalse(result['alignmentFallback'])
        self.assertIs(result['raw'], raw)
        self.assertEqual(result['timedUnits'][-1]['endMs'], 800)

    def test_invalid_native_times_use_actual_ctc_units_and_keep_original_evidence(self):
        raw, value = native(), engine(native())
        aligner = SimpleNamespace(align=lambda audio, text: aligned())
        with patch('asr_engines.ChineseCTCAligner', return_value=aligner) as factory:
            result = value.transcribe([0] * 16000)
            value.transcribe([0] * 16000)
        self.assertEqual(factory.call_count, 1, 'reuse the lazily loaded aligner')
        self.assertTrue(result['alignmentFallback'])
        self.assertEqual(result['recognitionText'], '甲乙。')
        self.assertEqual(result['timedUnits'][-2]['endMs'], 800)
        self.assertEqual(result['raw'][0]['timestamp'], raw[0]['timestamp'])
        self.assertEqual(result['raw'][0]['timestamp'][-1][1], 1050, 'native evidence must not be clipped')
        self.assertEqual(result['raw'][0]['alignmentFallback']['result'], aligned())
        value.aligner = SimpleNamespace(align=lambda audio, text: aligned(missing=True))
        with self.assertRaises(AlignmentError):
            value.transcribe([0] * 16000)
        for malformed in ({'segments': [{'start': float('nan'), 'end': 0.8, 'text': '甲乙。'}]},
                          {'segments': [{'end': 0.8, 'text': '甲乙。'}]}):
            value.aligner = SimpleNamespace(align=lambda audio, text: malformed)
            with self.assertRaises(AlignmentError):
                value.transcribe([0] * 16000)

    def test_ctc_fallback_is_bounded_to_the_supplied_audio_and_disables_interpolation(self):
        value = ChineseCTCAligner.__new__(ChineseCTCAligner)
        calls = []
        value.align_function = lambda *args, **kwargs: calls.append((args, kwargs))
        value.device, value.model, value.metadata = 'cpu', object(), {}
        value.align([0] * 16000, '甲乙。')
        self.assertEqual(calls[0][0][0], [{'start': 0.0, 'end': 1.0, 'text': '甲乙。'}])
        self.assertEqual(calls[0][1]['interpolate_method'], 'ignore')
        self.assertTrue(calls[0][1]['return_char_alignments'])

    def test_whisper_recognition_end_is_bounded_before_acoustic_alignment(self):
        raw = {'segments': [{'start': 0.233, 'end': 1.617, 'text': '甲乙。', 'avg_logprob': -0.2}]}
        value = WhisperX.__new__(WhisperX)
        value.model = SimpleNamespace(transcribe=lambda *args, **kwargs: raw)
        value.batch_size, value.device, value.aligner, value.metadata = 1, 'cpu', object(), {}
        calls = []
        value.align_function = lambda *args, **kwargs: calls.append((args, kwargs)) or aligned()
        result = value.transcribe([0] * 25600)
        self.assertEqual(raw['segments'][0]['end'], 1.617, 'original VAD span must survive')
        self.assertEqual(calls[0][0][0], [{'start': 0.233, 'end': 1.6, 'text': '甲乙。', 'avg_logprob': -0.2}])
        self.assertEqual(result['raw']['recognition'], raw)
        self.assertEqual(result['raw']['alignmentInput'], calls[0][0][0])
        self.assertEqual(result['timedUnits'][0]['startMs'], 100)
        self.assertEqual(result['timedUnits'][1]['endMs'], 800)
        self.assertEqual(result['recognitionText'], '甲乙。')

    def test_alignment_input_preserves_valid_spans_text_and_sample_accurate_end(self):
        raw = [{'start': 0.125, 'end': 0.75, 'text': '甲'}, {'start': 0.8, 'end': 1.1, 'text': '乙'}]
        result = bounded_alignment_input(raw, 16001)
        self.assertEqual(result[0], raw[0])
        self.assertIsNot(result[0], raw[0])
        self.assertEqual(result[1]['end'], 16001 / 16000)
        self.assertEqual(raw[1]['end'], 1.1)
        self.assertEqual(bounded_alignment_input([], 16000), [])

    def test_invalid_recognition_intervals_are_rejected_without_inventing_spans(self):
        for start, end in ((-0.01, 0.8), (1.0, 1.1), (0.4, 0.4), (0.5, 0.2), (0.0, float('inf')), (float('nan'), 0.8), (None, 0.8), (False, 0.8)):
            with self.subTest(start=start, end=end), self.assertRaises(AlignmentError):
                bounded_alignment_input([{'start': start, 'end': end, 'text': '甲'}], 16000)

    def test_bounding_inputs_never_clips_invalid_returned_character_times(self):
        value = WhisperX.__new__(WhisperX)
        value.model = SimpleNamespace(transcribe=lambda *args, **kwargs: {'segments': [{'start': 0.0, 'end': 1.02, 'text': '甲'}]})
        value.batch_size, value.device, value.aligner, value.metadata = 1, 'cpu', object(), {}
        value.align_function = lambda *args, **kwargs: {'segments': [{'start': 0.9, 'end': 1.02, 'text': '甲', 'chars': [{'char': '甲', 'start': 0.9, 'end': 1.02}]}]}
        result = value.transcribe([0] * 16000)
        self.assertEqual(result['timedUnits'], [{'text': '甲', 'startMs': 900, 'endMs': 1020}])
        from asr_segments import lexical_units
        with self.assertRaises(ValueError):
            lexical_units(result['timedUnits'], 1000)


if __name__ == '__main__':
    unittest.main()
