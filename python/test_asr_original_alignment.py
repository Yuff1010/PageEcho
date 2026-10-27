"""Protocol and safety gates only; real model controls are reported separately."""

from copy import deepcopy
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

from asr_jobs import JobError
from asr_original_alignment import (
    acoustic_evidence, align_confirmed, candidate_occurrences, edit_path, empty_evidence, lexical_characters,
    parse_request, quality_reasons,
)


def request():
    return {'protocolVersion': 1, 'requestId': 'request-1', 'audioPath': str(Path(__file__).resolve()),
            'audioHash': 'a' * 64, 'device': 'cpu', 'range': {'startMs': 1000, 'endMs': 2000}, 'text': '甲乙。'}


class Scalar:
    def __init__(self, value):
        self.value = value

    def exp(self):
        return math.exp(self.value)


class Scores:
    def __init__(self, values):
        self.values = values

    def max(self):
        return Scalar(max(self.values))


class Emission:
    def __init__(self, values):
        self.values = [[math.log(value) for value in row] for row in values]
        self.shape = (len(values), len(values[0]))

    def __getitem__(self, item):
        row, column = item
        if isinstance(row, slice):
            return Scores([value[column] for value in self.values[row]])
        return Scalar(self.values[row][column])

    def argmax(self, _dimension):
        return SimpleNamespace(tolist=lambda: [max(range(len(row)), key=row.__getitem__) for row in self.values])


def aligned():
    return {'segments': [{'chars': [{'char': '甲', 'start': 0, 'end': 0.5, 'score': 0.9},
                                    {'char': '乙', 'start': 0.5, 'end': 1, 'score': 0.8}]}]}


DICTIONARY = {'<pad>': 0, '甲': 1, '乙': 2, '丙': 3, '|': 4}
GOOD = Emission([[0.01, 0.96, 0.01, 0.01, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01],
                 [0.01, 0.01, 0.96, 0.01, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01]])


class OriginalAlignmentTests(unittest.TestCase):
    def test_input_bounds_are_strict_and_device_is_never_inferred(self):
        self.assertEqual(parse_request(request()), request())
        invalid = []
        for key, value in [('protocolVersion', True), ('device', 'auto'), ('audioHash', 'a' * 63),
                           ('audioPath', 'https://example.test/audio.wav'), ('text', ''), ('text', '甲' * 1001),
                           ('text', '\ud800')]:
            item = request()
            item[key] = value
            invalid.append(item)
        invalid += [{**request(), 'unexpected': True}, {**request(), 'range': {'startMs': 1, 'endMs': 60002}},
                    {**request(), 'range': {'startMs': False, 'endMs': 100}},
                    {**request(), 'range': {'startMs': 0, 'endMs': float('inf')}}]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(JobError):
                parse_request(item)

    def test_utf16_offsets_preserve_original_punctuation_and_astral_letters(self):
        chars = lexical_characters('“甲”，𠀀 A。')
        self.assertEqual([(value['text'], value['textStart'], value['textEnd']) for value in chars],
                         [('甲', 1, 2), ('𠀀', 4, 6), ('A', 7, 8)])
        self.assertEqual(chars[-1]['token'], 'a')

    def test_unknown_vocabulary_is_rejected_before_inference_with_unknown_metrics_null(self):
        aligner = SimpleNamespace(metadata={'dictionary': DICTIONARY},
                                  align_with_evidence=lambda *_: self.fail('must not force wildcard path'))
        result = align_confirmed(aligner, [0.1] * 16000, '甲龘')
        self.assertEqual(result['characters'], [])
        self.assertEqual(result['reasons'][0]['code'], 'UNSUPPORTED_CHARACTERS')
        self.assertIsNone(result['evidence']['freePathEditDistance'])
        self.assertIsNone(result['evidence']['confidence'])

    def test_native_character_times_are_offset_without_redistribution_or_punctuation_times(self):
        calls = []
        aligner = SimpleNamespace(metadata={'dictionary': DICTIONARY}, align_with_evidence=lambda audio, text:
                                  calls.append(text) or (aligned(), GOOD))
        result = align_confirmed(aligner, [0.1] * 16000, '甲，乙。', 4200)
        self.assertEqual(calls, ['甲乙'])
        self.assertEqual(result['reasons'], [])
        self.assertEqual([(value['text'], value['startMs'], value['endMs']) for value in result['characters']],
                         [('甲', 4200, 4700), ('乙', 4700, 5200)])
        self.assertEqual([value['textStart'] for value in result['characters']], [0, 2])

    def test_full_forced_path_and_high_native_scores_cannot_override_wrong_unforced_audio_evidence(self):
        wrong = Emission([[0.01, 0.01, 0.01, 0.96, 0.01]] * 4)
        aligner = SimpleNamespace(metadata={'dictionary': DICTIONARY}, align_with_evidence=lambda *_: (aligned(), wrong))
        result = align_confirmed(aligner, [0.1] * 16000, '甲乙')
        self.assertEqual(result['characters'], [])
        self.assertEqual(result['evidence']['characterCoverage'], 1)
        self.assertIn('TEXT_AUDIO_MISMATCH', [value['code'] for value in result['reasons']])

    def test_missing_outside_overlapping_or_nonfinite_native_times_are_rejected_without_clipping(self):
        for change in ({'start': -0.01}, {'end': 1.1}, {'start': float('nan')}, {'end': None},
                       {'start': 0.49, 'end': 0.8}, {'start': 0.5001, 'end': 0.5002}):
            value = deepcopy(aligned())
            value['segments'][0]['chars'][1].update(change)
            before = deepcopy(value)
            output, evidence, reasons = acoustic_evidence([0.1] * 16000, '甲乙', {'dictionary': DICTIONARY}, value, GOOD)
            self.assertTrue(reasons)
            self.assertLess(evidence['characterCoverage'], 1)
            self.assertLess(len(output), 2)
            if not isinstance(change.get('start'), float) or not math.isnan(change['start']):
                self.assertEqual(value, before)

    def test_silence_and_missing_characters_are_explicitly_rejected(self):
        evidence = {**empty_evidence(2), 'audioRms': 0, 'freePathCharacters': 0}
        codes = {value['code'] for value in quality_reasons(evidence)}
        self.assertEqual(codes, {'NO_SPEECH', 'MISSING_CHARACTER_TIMES'})

    def test_word_delimiter_is_not_an_unspoken_character_and_neighbor_context_is_outside_target_span(self):
        delimiter = Emission([[0.01, 0.96, 0.01, 0.01, 0.01], [0.01, 0.01, 0.01, 0.01, 0.96],
                             [0.01, 0.01, 0.96, 0.01, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01]])
        _, evidence, _ = acoustic_evidence([0.1] * 16000, '甲乙', {'dictionary': DICTIONARY}, aligned(), delimiter)
        self.assertEqual(evidence['freePathEditDistance'], 0)
        self.assertEqual(evidence['maxUnexplainedPosterior'], 0)

    def test_neighboring_speech_outside_native_target_span_does_not_reject_the_confirmed_subsequence(self):
        values = Emission([[0.01, 0.01, 0.01, 0.96, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01],
                           [0.01, 0.96, 0.01, 0.01, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01],
                           [0.01, 0.01, 0.96, 0.01, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01],
                           [0.01, 0.01, 0.01, 0.96, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01]])
        native = aligned()
        native['segments'][0]['chars'][0].update(start=0.25, end=0.5)
        native['segments'][0]['chars'][1].update(start=0.5, end=0.75)
        _, evidence, issues = acoustic_evidence([0.1] * 16000, '甲乙', {'dictionary': DICTIONARY}, native, values)
        self.assertEqual(issues, [])
        self.assertEqual(evidence['freePathEditDistance'], 0)
        self.assertEqual(evidence['candidateOccurrences'], 1)
        self.assertEqual(quality_reasons(evidence), [])

    def test_multiple_exact_target_occurrences_are_rejected_instead_of_picking_an_arbitrary_repeat(self):
        repeated = Emission([[0.01, 0.96, 0.01, 0.01, 0.01], [0.01, 0.01, 0.96, 0.01, 0.01],
                              [0.96, 0.01, 0.01, 0.01, 0.01], [0.01, 0.96, 0.01, 0.01, 0.01],
                              [0.01, 0.01, 0.96, 0.01, 0.01], [0.96, 0.01, 0.01, 0.01, 0.01]])
        _, evidence, _ = acoustic_evidence([0.1] * 16000, '甲乙', {'dictionary': DICTIONARY}, aligned(), repeated)
        self.assertEqual(evidence['candidateOccurrences'], 2)
        self.assertIn('AMBIGUOUS_TARGET', [value['code'] for value in quality_reasons(evidence)])

    def test_edit_path_separates_internal_extra_speech_from_supported_alternative_spelling(self):
        self.assertEqual(edit_path(list('甲乙'), list('甲丙乙')), (1, [1]))
        self.assertEqual(edit_path(list('甲乙'), list('甲丙')), (1, []))
        self.assertEqual(edit_path(list('甲乙'), list('甲')), (1, []))

    def test_near_identical_repeated_context_is_not_mistaken_for_a_unique_target(self):
        self.assertEqual(candidate_occurrences(list('甲乙丙丁'), list('甲乙丙丁')), 1)
        self.assertEqual(candidate_occurrences(list('甲乙丙丁'), list('甲乙丙丁戊')), 1)
        self.assertEqual(candidate_occurrences(list('甲乙丙丁'), list('甲乙丙丁甲乙戊丁')), 2)
        self.assertEqual(candidate_occurrences(list('甲乙丙丁'), list('戊戊戊戊')), 0)


if __name__ == '__main__':
    unittest.main()
