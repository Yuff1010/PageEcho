"""Opt-in numerical CTC checks with the component's Torch, without model weights."""

import itertools
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asr_runtime import configure_cache, configure_offline_network
configure_cache('cache/asr-evaluation/ctc-math-checks')
configure_offline_network()

import torch
import whisperx.alignment as native
from asr_ctc import _blank_relative_trellis, ctc_alignment_function


def complete_path(emission, tokens):
    trellis = _blank_relative_trellis(native.get_trellis, emission, tokens, 0)
    return native.backtrack(trellis, emission, tokens, 0)


def path_positions(path, tokens):
    return tuple(min(point.time_index for point in path if point.token_index == index)
                 for index in range(len(tokens)))


def path_score(emission, tokens, positions):
    labels = dict(zip(positions, tokens))
    return sum(float(emission[frame, labels.get(frame, 0)]) for frame in range(len(emission)))


class CTCObjectiveChecks(unittest.TestCase):
    def test_prefix_maximum_can_finish_early_but_complete_likelihood_selects_the_stronger_token(self):
        emission = torch.tensor([[.8, .19, .01], [.05, .01, .94], [.05, .01, .94],
                                 [.1, .89, .01], [.9, .05, .05]]).log()
        original = native.backtrack(native.get_trellis(emission, [1]), emission, [1])
        corrected = complete_path(emission, [1])
        self.assertEqual(path_positions(original, [1]), (0,))
        self.assertEqual(path_positions(corrected, [1]), (3,))
        self.assertGreater(path_score(emission, [1], (3,)), path_score(emission, [1], (0,)))

    def test_matches_exhaustive_complete_waveform_paths_for_several_token_counts(self):
        generator = torch.Generator().manual_seed(20983)
        for frames in (3, 5, 8):
            for tokens in ([1], [1, 2], [1, 1, 2]):
                for _ in range(8):
                    emission = torch.log_softmax(torch.randn(frames, 3, generator=generator), dim=-1)
                    before = emission.clone()
                    expected = max(path_score(emission, tokens, positions)
                                   for positions in itertools.combinations(range(frames), len(tokens)))
                    path = complete_path(emission, tokens)
                    self.assertIsNotNone(path)
                    actual = path_score(emission, tokens, path_positions(path, tokens))
                    self.assertAlmostEqual(actual, expected, places=4)
                    self.assertTrue(torch.equal(before, emission), 'emission evidence must not change')

    def test_trailing_silence_does_not_force_the_last_character_to_the_audio_end(self):
        emission = torch.tensor([[.8, .19, .01], [.05, .01, .94], [.05, .01, .94],
                                 [.1, .89, .01], [.9, .05, .05]]).log()
        trailing = torch.tensor([[.999, .0005, .0005]] * 9).log()
        extended = torch.cat((emission, trailing))
        self.assertEqual(path_positions(complete_path(extended, [1]), [1]), (3,))

    def test_real_component_binding_does_not_mutate_native_functions(self):
        original_align, original_trellis = native.align, native.get_trellis
        selected = ctc_alignment_function()
        self.assertIsNot(selected, original_align)
        self.assertIs(native.align, original_align)
        self.assertIs(native.get_trellis, original_trellis)
        self.assertIs(original_align.__globals__['get_trellis'], original_trellis)
        self.assertIs(ctc_alignment_function(), selected)

    def test_a_long_equal_scoring_blank_tail_chooses_the_first_complete_endpoint(self):
        emission = torch.tensor([[.05, .0001, .9499]] * 1500).log()
        emission[500] = torch.tensor([.1, .8999, .0001]).log()
        path = complete_path(emission, [1])
        self.assertEqual(path_positions(path, [1]), (500,))
        self.assertEqual(path[-1].time_index, 500)


if __name__ == '__main__':
    unittest.main()
