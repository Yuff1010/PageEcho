"""Independent seam fixtures, including lost ownership and genuine repetition."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid

from asr_jobs import JobPipeline
from asr_segments import join_windows, owned_units, reading_segments
from asr_metrics import timing_issues


def unit(text, start, end):
    return {'text': text, 'startMs': start, 'endMs': end}


def owned(context, start, end, offset):
    return owned_units([{**u, 'startMs': u['startMs'] - offset, 'endMs': u['endMs'] - offset} for u in context],
                       {'startMs': start, 'endMs': end, 'decodeStartMs': offset})


def seam(left, right):
    return join_windows(owned(left, 0, 5000, 0), owned(right, 5000, 10000, 3000), left, right, 5000, 2000)


def gap_contexts():
    left = [unit('甲', 4000, 4200), unit('乙', 4200, 4400), unit('丙', 4400, 4600),
            unit('丁', 4900, 5200), unit('戊', 5200, 5400), unit('己', 5400, 5600)]
    right = [unit('甲', 4000, 4200), unit('乙', 4200, 4400), unit('丙', 4400, 4600),
             unit('丁', 4800, 5100), unit('戊', 5100, 5300), unit('己', 5300, 5500)]
    return left, right


class OverlapTests(unittest.TestCase):
    def test_restores_an_agreed_character_excluded_by_both_independent_midpoint_cuts(self):
        left, right = gap_contexts()
        saved = deepcopy((left, right))
        self.assertEqual(''.join(u['text'] for u in owned(left, 0, 5000, 0)), '甲乙丙')
        self.assertEqual(''.join(u['text'] for u in owned(right, 5000, 10000, 3000)), '戊己')
        merged, issues = seam(left, right)
        self.assertEqual(''.join(u['text'] for u in merged), '甲乙丙丁戊己')
        self.assertEqual(merged[3], unit('丁', 4800, 5100), 'use a stored native unit, no new timing')
        self.assertEqual(issues, [{'code': 'BOUNDARY_TEXT_RECOVERED', 'atMs': 5000, 'units': 1}])
        self.assertEqual((left, right), saved)

    def test_adjacent_genuine_repeated_characters_are_not_collapsed_when_ranges_overlap(self):
        left = [unit('甲', 4000, 4200), unit('乙', 4200, 4400), unit('丙', 4800, 5050),
                unit('丙', 5050, 5250), unit('丁', 5250, 5450), unit('戊', 5450, 5650)]
        right = [unit('甲', 4000, 4200), unit('乙', 4200, 4400), unit('丙', 4820, 5060),
                 unit('丙', 4900, 5100), unit('丁', 5100, 5300), unit('戊', 5300, 5500)]
        merged, issues = seam(left, right)
        self.assertEqual(''.join(u['text'] for u in merged), '甲乙丙丙丁戊')
        self.assertEqual(issues, [{'code': 'BOUNDARY_CONFLICT', 'atMs': 4900}])

    def test_two_owners_of_the_same_agreed_occurrence_are_deduplicated(self):
        left, right = gap_contexts()
        left[2] = unit('丙', 4800, 5100)
        left[3] = unit('丁', 5100, 5300)
        right[2] = unit('丙', 4900, 5300)
        right[3] = unit('丁', 5300, 5500)
        right[4] = unit('戊', 5500, 5700)
        right[5] = unit('己', 5700, 5900)
        merged, issues = seam(left, right)
        self.assertEqual(''.join(u['text'] for u in merged), '甲乙丙丁戊己')
        self.assertEqual(merged[2], left[2])
        self.assertEqual(issues[0], {'code': 'BOUNDARY_REPEAT_DEDUPLICATED', 'atMs': 5000, 'units': 1})

    def test_a_partial_indivisible_word_is_left_for_review_without_inventing_char_times(self):
        left, right = gap_contexts()
        left[3] = unit('丁', 4700, 4900)
        right = right[:3] + [unit('丁戊', 4700, 5100), unit('己', 5300, 5500)]
        merged, issues = seam(left, right)
        self.assertEqual(''.join(u['text'] for u in merged), '甲乙丙丁己')
        self.assertTrue(any(i['code'] == 'BOUNDARY_CONTEXT_UNRESOLVED' for i in issues))
        self.assertFalse(any(u['text'] == '戊' and u['startMs'] == 4700 for u in merged))

    def test_restoration_keeps_an_overlapping_native_interval_instead_of_clipping_its_start(self):
        left, right = gap_contexts()
        left[2] = unit('丙。', 4900, 4980)
        left[3] = unit('丁', 4980, 5140)
        right[3] = unit('丁', 4890, 5100)
        merged, issues = seam(left, right)
        self.assertEqual(''.join(u['text'] for u in merged), '甲乙丙。丁戊己')
        self.assertEqual(merged[3], right[3])
        self.assertTrue(any(i['code'] == 'BOUNDARY_TEXT_RECOVERED' for i in issues))
        self.assertTrue(any(i['code'] == 'BOUNDARY_CONFLICT' for i in issues))
        self.assertEqual(timing_issues(reading_segments(merged), 10000), [])

    def test_a_backward_native_range_unions_all_affected_reading_segments_without_reordering_text(self):
        units = [unit('甲。', 100, 200), unit('乙。', 200, 300), unit('丙。', 300, 400), unit('丁。', 150, 450)]
        self.assertEqual(reading_segments(units), [
            {'id': 'asr-100-0', 'startMs': 100, 'endMs': 450, 'text': '甲。乙。丙。丁。'}])

    def test_a_repeated_context_cannot_be_used_as_a_unique_recovery_anchor(self):
        left = [unit(c, 4200 + i * 160, 4360 + i * 160) for i, c in enumerate('甲乙丙丁戊甲乙丙丁戊')]
        right = [unit(c, 4500 + i * 160, 4660 + i * 160) for i, c in enumerate('甲乙丙丁戊')]
        before = owned(left, 0, 5000, 0) + owned(right, 5000, 10000, 3000)
        merged, issues = seam(left, right)
        self.assertEqual(merged, before)
        self.assertTrue(any(i['code'] == 'BOUNDARY_CONTEXT_UNRESOLVED' for i in issues))


class OverlapCacheTests(unittest.TestCase):
    def test_recovered_text_and_warning_survive_replay_and_invalid_context_recomputes(self):
        left, right = gap_contexts()
        with tempfile.TemporaryDirectory(prefix='听读 overlap ') as folder:
            root = Path(folder)
            source = root / 'audio.bin'
            source.write_bytes(b'independent seam fixture')

            class Decoder:
                calls = 0
                offset = None

                def duration_ms(self, *args):
                    return 10000

                def decode(self, path, window, canceled):
                    self.calls += 1
                    self.offset = window['decodeStartMs']
                    return range((window['decodeEndMs'] - self.offset) * 16)

            decoder = Decoder()

            class Engine:
                def transcribe(self, audio):
                    context = left if decoder.offset == 0 else right
                    return {'recognitionText': ''.join(u['text'] for u in context), 'punctuationRestored': True,
                            'timedUnits': [{**u, 'startMs': u['startMs'] - decoder.offset,
                                            'endMs': u['endMs'] - decoder.offset} for u in context],
                            'raw': {'fixture': 'whole contexts'}}

            def punctuation():
                raise AssertionError('already punctuated')

            pipeline = JobPipeline(root / 'cache', {'model': 'fixture'}, decoder, Engine, punctuation, 5000, 2000)
            request = {'protocolVersion': 1, 'type': 'submit', 'jobId': str(uuid.uuid4()), 'attempt': 1,
                       'audioPath': str(source), 'audioHash': hashlib.sha256(source.read_bytes()).hexdigest(),
                       'range': {'startMs': 0, 'endMs': 10000}}
            result = pipeline.run(request, threading.Event(), lambda *args, **kwargs: None)
            self.assertEqual(''.join(s['text'] for s in result['document']['segments']), '甲乙丙丁戊己')
            self.assertEqual(result['cacheHits'], 0)
            replay = pipeline.run({**request, 'attempt': 2}, threading.Event(), lambda *args, **kwargs: None)
            self.assertEqual(replay['document'], result['document'])
            self.assertEqual(replay['issues'], result['issues'])
            self.assertEqual(replay['cacheHits'], 2)
            checkpoint = root / 'cache' / result['cacheKey'] / 'chunk-000001.json'
            for attempt, mutation in enumerate(('out-of-range', 'different-ownership', 'missing-context'), 3):
                stored = json.loads(checkpoint.read_text(encoding='utf-8'))
                if mutation == 'out-of-range':
                    stored['contextUnits'][0]['endMs'] = 11000
                elif mutation == 'different-ownership':
                    stored['contextUnits'][-1]['text'] = '庚'
                else:
                    del stored['contextUnits']
                checkpoint.write_text(json.dumps(stored), encoding='utf-8')
                repaired = pipeline.run({**request, 'attempt': attempt}, threading.Event(), lambda *args, **kwargs: None)
                self.assertEqual(repaired['cacheHits'], 1)
                self.assertEqual(repaired['document'], result['document'])
            self.assertEqual(decoder.calls, 5)


if __name__ == '__main__':
    unittest.main()
