import errno
import hashlib
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

from asr_jobs import JobError, JobPipeline, assembled_document, atomic_json, parse_request
from asr_segments import (
    fingerprint, join_units, lexical_units, owned_units, partial_document,
    punctuate_units, reading_segments, windows,
)
from asr_worker import WorkerService
from asr_engines import AlignmentError


def unit(text, start, end):
    return {'text': text, 'startMs': start, 'endMs': end}


def request(path, **overrides):
    return {'protocolVersion': 1, 'type': 'submit', 'jobId': str(uuid.uuid4()), 'attempt': 1,
            'audioPath': str(path), 'audioHash': hashlib.sha256(path.read_bytes()).hexdigest(),
            'range': {'startMs': 0, 'endMs': 10000}, **overrides}


class SegmentTest(unittest.TestCase):
    def test_context_ownership_preserves_cross_boundary_word_and_original_offset(self):
        plan = list(windows(30000, 42000, 5000, 2000))
        self.assertEqual([(w['decodeStartMs'], w['decodeEndMs']) for w in plan],
                         [(30000, 37000), (33000, 42000), (38000, 42000)])
        left = owned_units([unit('名字', 4800, 5300)], plan[0])
        right = owned_units([unit('名字', 1800, 2300)], plan[1])
        self.assertEqual(left, [])
        self.assertEqual(right, [unit('名字', 34800, 35300)])
        doc = partial_document('a' * 64, 30000, 40000, right)
        self.assertEqual(doc['segments'][0]['startMs'], 34800)
        self.assertEqual(doc['coverage'][0], {'startMs': 30000, 'endMs': 40000})

    def test_overlap_dedupes_equal_words_but_keeps_actual_repetition(self):
        left = [unit('你', 4800, 5050), unit('好', 5050, 5250)]
        right = [unit('你', 4820, 5060), unit('好', 5070, 5270), unit('吗', 5300, 5500)]
        merged, issues = join_units(left, right)
        self.assertEqual(''.join(x['text'] for x in merged), '你好吗')
        self.assertEqual(issues[0]['units'], 2)
        repeated, issues = join_units(left, [unit('你', 5300, 5500), unit('好', 5500, 5700)])
        self.assertEqual(''.join(x['text'] for x in repeated), '你好你好')
        self.assertEqual(issues, [])

    def test_conflicting_overlap_keeps_both_texts_in_valid_segment(self):
        merged, issues = join_units([unit('王。', 4700, 5150)], [unit('汪。', 5000, 5300)])
        self.assertEqual(issues[0]['code'], 'BOUNDARY_CONFLICT')
        self.assertEqual(reading_segments(merged), [
            {'id': 'asr-4700-0', 'startMs': 4700, 'endMs': 5300, 'text': '王。汪。'}])

    def test_punctuation_only_changes_display_and_never_native_anchors(self):
        units = [unit('甲', 100, 300), unit('乙', 300, 500), unit('明', 900, 1100), unit('天', 1100, 1300)]
        restored = punctuate_units(units, '甲乙，明天。')
        self.assertEqual([(x['startMs'], x['endMs']) for x in restored], [(100, 300), (300, 500), (900, 1100), (1100, 1300)])
        self.assertEqual([s['text'] for s in reading_segments(restored)], ['甲乙，', '明天。'])
        with self.assertRaises(ValueError):
            punctuate_units(units, '甲丙，明天。')
        with self.assertRaises(ValueError):
            punctuate_units([unit('hello', 1, 20)], 'hel,lo')
        self.assertEqual(punctuate_units([unit("can't", 1, 20), unit('C++', 20, 40)], "can't C++。"),
                         [unit("can't ", 1, 20), unit('C++。', 20, 40)])
        with self.assertRaises(ValueError):
            punctuate_units([unit('C++', 1, 20)], 'C。')

    def test_unaligned_and_outside_model_times_fail_without_clipping(self):
        for invalid in [[unit('甲', None, None)], [unit('甲', 0, 1030)], [unit('甲', 30, 30)]]:
            with self.assertRaises(ValueError):
                lexical_units(invalid, 1000)
        self.assertEqual(lexical_units([unit('甲', 1, 100), unit('。', None, None)], 1000), [unit('甲。', 1, 100)])

    def test_key_is_stable_and_changes_for_audio_model_or_parameters(self):
        self.assertEqual(fingerprint({'x': 1, 'y': 2}), fingerprint({'y': 2, 'x': 1}))
        baseline = {'hash': 'a', 'model': 'rev1', 'chunkMs': 30000, 'version': 1}
        for key, value in [('hash', 'b'), ('model', 'rev2'), ('chunkMs', 10000), ('version', 2)]:
            self.assertNotEqual(fingerprint(baseline), fingerprint({**baseline, key: value}))


class Decoder:
    def __init__(self):
        self.calls = []

    def duration_ms(self, *_):
        return 10000

    def decode(self, path, window, canceled):
        self.calls.append(window)
        return [0] * ((window['decodeEndMs'] - window['decodeStartMs']) * 16)


class Engine:
    def __init__(self):
        self.calls = 0
        self.fail_on = None
        self.entered = None
        self.release = None

    def transcribe(self, audio):
        self.calls += 1
        if self.entered:
            self.entered.set()
            self.release.wait(5)
        if self.calls == self.fail_on:
            raise JobError('ENGINE_FAILED', 'expected fixture failure')
        return {'recognitionText': '甲乙', 'timedUnits': [unit('甲', 100, 300), unit('乙', 300, 600)], 'raw': {'fixture': True}}


class Punctuation:
    def restore(self, text):
        return text + '。'


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='听读 worker ')
        self.root = Path(self.temporary.name)
        self.audio = self.root / '音频 source.bin'
        self.audio.write_bytes(b'known audio version')
        self.engine = Engine()
        self.decoder = Decoder()
        self.pipeline = JobPipeline(self.root / 'cache', {'model': 'one'}, self.decoder,
                                    lambda: self.engine, Punctuation, 5000, 2000)
        self.events = []

    def tearDown(self):
        self.temporary.cleanup()

    def run_job(self, value=None):
        return self.pipeline.run(value or request(self.audio), threading.Event(),
                                 lambda kind, **data: self.events.append({'type': kind, **data}))

    def priority_fixture(self):
        self.decoder.duration_ms = lambda *_: 30000
        def transcribe(audio):
            self.engine.calls += 1
            if self.engine.calls == self.engine.fail_on:
                raise JobError('ENGINE_FAILED', 'expected fixture failure')
            window = self.decoder.calls[-1]
            offset = window['startMs'] - window['decodeStartMs']
            return {'recognitionText': '甲。', 'timedUnits': [unit('甲。', offset + 100, offset + 600)],
                    'punctuationRestored': True, 'raw': {'index': window['index']}}
        self.engine.transcribe = transcribe

    def test_priority_generates_target_then_forward_and_fills_earlier_holes_without_false_prefix(self):
        self.priority_fixture()
        result = self.run_job(request(self.audio, range={'startMs': 0, 'endMs': 30000}, priorityMs=16000))
        self.assertEqual([window['index'] for window in self.decoder.calls], [3, 4, 5, 0, 1, 2])
        partials = [event for event in self.events if event['type'] == 'partial']
        self.assertEqual(partials[0]['document']['coverage'], [{'startMs': 15000, 'endMs': 20000}])
        self.assertEqual([event['processedUntilMs'] for event in partials], [0, 0, 0, 5000, 10000, 30000])
        self.assertEqual(partials[3]['document']['coverage'], [
            {'startMs': 0, 'endMs': 5000}, {'startMs': 15000, 'endMs': 30000}])
        first_segment = partials[0]['document']['segments'][0]
        self.assertIn(first_segment, result['document']['segments'])
        self.assertEqual(result['document']['coverage'], [{'startMs': 0, 'endMs': 30000}])

    def test_priority_changes_and_restart_reuse_absolute_chunks_and_same_cache_identity(self):
        self.priority_fixture()
        value = request(self.audio, range={'startMs': 0, 'endMs': 30000}, priorityMs=16000)
        self.engine.fail_on = 2
        with self.assertRaises(JobError):
            self.run_job(value)
        initial = next(event for event in self.events if event['type'] == 'partial')
        self.events.clear()
        self.decoder.calls.clear()
        result = self.run_job({**value, 'attempt': 2, 'priorityMs': 5000})
        self.assertEqual(result['cacheKey'], initial['cacheKey'])
        self.assertEqual(result['cacheHits'], 1)
        self.assertEqual([window['index'] for window in self.decoder.calls], [1, 2, 4, 5, 0])
        self.assertEqual(next(event for event in self.events if event['type'] == 'partial')['document'], initial['document'])
        self.decoder.calls.clear()
        self.assertEqual(self.run_job({**value, 'priorityMs': 25000})['cacheHits'], 6)
        self.assertEqual(self.decoder.calls, [])

    def test_backward_priority_is_applied_between_chunks_without_restarting_inference(self):
        self.priority_fixture()
        priority = [20000]
        def emit(kind, **fields):
            self.events.append({'type': kind, **fields})
            if kind == 'partial' and fields['completedChunks'] == 1:
                priority[0] = 5000
        self.pipeline.run(request(self.audio, range={'startMs': 0, 'endMs': 30000}),
                          threading.Event(), emit, lambda: priority[0])
        self.assertEqual([window['index'] for window in self.decoder.calls], [4, 1, 2, 3, 5, 0])

    def test_priority_control_ignores_old_attempt_and_never_uncancels_a_job(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        observed = []
        class Pipeline:
            def run(self, value, canceled, emit, priority):
                entered.set()
                release.wait(2)
                observed.append(priority())
                return {}
        def output(event):
            self.events.append(event)
            if event['type'] in ('result', 'canceled'):
                finished.set()
        service = WorkerService(Pipeline(), output)
        value = request(self.audio, priorityMs=1000)
        identity = {key: value[key] for key in ['protocolVersion', 'jobId', 'attempt']}
        service.dispatch(value)
        try:
            self.assertTrue(entered.wait(2))
            service.dispatch({**identity, 'type': 'prioritize', 'attempt': 2, 'positionMs': 9000})
            service.dispatch({**identity, 'type': 'prioritize', 'positionMs': 7000})
            service.dispatch({**identity, 'type': 'cancel'})
            service.dispatch({**identity, 'type': 'prioritize', 'positionMs': 8000})
            release.set()
            self.assertTrue(finished.wait(2))
            self.assertEqual(observed, [7000])
            self.assertEqual(self.events[-1]['type'], 'canceled')
            self.assertEqual(len([event for event in self.events if event['type'] == 'priority-accepted']), 1)
        finally:
            release.set()
            service.close()

    def test_disconnected_runs_keep_gaps_and_join_repeated_words_only_after_neighbor_finishes(self):
        plan = list(windows(0, 15000, 5000, 2000))
        saved = {
            0: {'units': [unit('你。', 4800, 5100)], 'contextUnits': [], 'issues': []},
            2: {'units': [unit('你。', 10100, 10400)], 'contextUnits': [], 'issues': []},
        }
        document, prefix, _ = assembled_document('a' * 64, plan, saved, 0)
        self.assertEqual(prefix, 5000)
        self.assertEqual(document['coverage'], [{'startMs': 0, 'endMs': 5000}, {'startMs': 10000, 'endMs': 15000}])
        self.assertEqual([segment['text'] for segment in document['segments']], ['你。'])
        saved[1] = {'units': [unit('你。', 5300, 5500)], 'contextUnits': [], 'issues': []}
        complete, prefix, _ = assembled_document('a' * 64, plan, saved, 0)
        self.assertEqual(prefix, 15000)
        self.assertEqual(''.join(segment['text'] for segment in complete['segments']), '你。你。你。')

    def test_engine_supplied_punctuation_is_not_sent_through_a_second_restoration_pass(self):
        self.engine.transcribe = lambda audio: {
            'recognitionText': '甲，乙。', 'timedUnits': [unit('甲，', 100, 300), unit('乙。', 300, 600)],
            'raw': {'fixture': 'already punctuated'}, 'punctuationRestored': True,
        }
        self.pipeline = JobPipeline(self.root / 'punctuation-cache', {'model': 'native-punctuation'}, self.decoder,
                                    lambda: self.engine, lambda: self.fail('punctuation must not be applied twice'), 10000, 0)
        result = self.run_job()
        self.assertEqual(''.join(item['text'] for item in result['document']['segments']), '甲，乙。')
        self.assertEqual(self.run_job()['document'], result['document'])

    def test_realignment_warning_and_original_raw_survive_checkpoint_replay(self):
        transcribe = self.engine.transcribe

        def realigned(audio):
            return {**transcribe(audio), 'alignmentFallback': True, 'raw': {'nativeEndMs': 7050, 'ctc': 'actual result'}}

        self.engine.transcribe = realigned
        result = self.run_job()
        self.assertEqual([issue for issue in result['issues'] if issue['code'] == 'NATIVE_REALIGNED'], [
            {'code': 'NATIVE_REALIGNED', 'atMs': 0}, {'code': 'NATIVE_REALIGNED', 'atMs': 5000}])
        import json
        checkpoint = self.root / 'cache' / result['cacheKey'] / 'chunk-000000.json'
        self.assertEqual(json.loads(checkpoint.read_text(encoding='utf-8'))['raw']['nativeEndMs'], 7050)
        replay = self.run_job()
        self.assertEqual(replay['cacheHits'], 2)
        self.assertEqual(replay['issues'], result['issues'])

    def test_failed_ctc_alignment_preserves_the_saved_prefix_and_can_retry(self):
        transcribe = self.engine.transcribe

        def fail_second(audio):
            result = transcribe(audio)
            if self.engine.calls == 2:
                raise AlignmentError('missing character time')
            return result

        self.engine.transcribe = fail_second
        with self.assertRaises(JobError) as failure:
            self.run_job()
        self.assertEqual(failure.exception.code, 'ALIGNMENT_FAILED')
        self.assertEqual([item['processedUntilMs'] for item in self.events if item['type'] == 'partial'], [5000])
        self.assertEqual(self.run_job()['cacheHits'], 1)

    def test_checkpoints_survive_failure_then_retry_reuses_finished_chunk(self):
        self.engine.fail_on = 2
        with self.assertRaises(JobError):
            self.run_job()
        self.assertEqual(len([event for event in self.events if event['type'] == 'partial']), 1)
        result = self.run_job()
        self.assertEqual(result['cacheHits'], 1)
        self.assertEqual(len(self.decoder.calls), 3)
        self.assertEqual(result['document']['coverage'], [{'startMs': 0, 'endMs': 10000}])
        self.pipeline.engine_factory = lambda: self.fail('cache reuse must not load a model')
        self.pipeline.engine = None
        self.assertEqual(self.run_job()['cacheHits'], 2)

    def test_corrupt_checkpoint_is_recomputed_and_wrong_source_hash_is_rejected(self):
        first = self.run_job()
        checkpoint = self.root / 'cache' / first['cacheKey'] / 'chunk-000000.json'
        checkpoint.write_text('{bad json', encoding='utf8')
        self.assertEqual(self.run_job()['cacheHits'], 1)
        with self.assertRaisesRegex(JobError, '音频版本'):
            self.run_job(request(self.audio, audioHash='b' * 64))

    def test_disk_full_during_checkpoint_preserves_prefix_and_retry_reuses_it(self):
        write_bytes = Path.write_bytes

        def fail_second_chunk(path, data):
            if path.name.startswith('chunk-000001.json.'):
                write_bytes(path, data[:20])
                raise OSError(errno.ENOSPC, 'injected disk full')
            return write_bytes(path, data)

        with patch.object(Path, 'write_bytes', fail_second_chunk):
            with self.assertRaises(JobError) as failure:
                self.run_job()
        self.assertEqual(failure.exception.code, 'DISK_FULL')
        self.assertEqual([e['processedUntilMs'] for e in self.events if e['type'] == 'partial'], [5000])
        self.assertFalse(list((self.root / 'cache').glob('*/*.tmp')))
        result = self.run_job()
        self.assertEqual(result['cacheHits'], 1)
        self.assertEqual(result['processedUntilMs'], 10000)

    def test_read_only_or_failed_replace_keeps_existing_checkpoint(self):
        target = self.root / 'checkpoint.json'
        atomic_json(target, {'saved': True})
        previous = target.read_bytes()
        for number, code in [(errno.EACCES, 'CACHE_UNWRITABLE'), (errno.EROFS, 'CACHE_UNWRITABLE'),
                             (errno.ENOSPC, 'DISK_FULL'), (errno.EIO, 'CACHE_WRITE_FAILED')]:
            with patch.object(Path, 'replace', side_effect=OSError(number, 'injected replacement failure')):
                with self.assertRaises(JobError) as failure:
                    atomic_json(target, {'saved': False})
            self.assertEqual(failure.exception.code, code)
            self.assertEqual(target.read_bytes(), previous)
            self.assertFalse(list(self.root.glob('*.tmp')))

    def test_moved_audio_fails_with_last_prefix_intact_then_restored_path_reuses_cache(self):
        value = request(self.audio)
        moved = self.audio.with_name('moved.bin')

        def emit(kind, **data):
            self.events.append({'type': kind, **data})
            if kind == 'partial':
                self.audio.rename(moved)

        with self.assertRaises(JobError) as failure:
            self.pipeline.run(value, threading.Event(), emit)
        self.assertEqual(failure.exception.code, 'FILE_UNAVAILABLE')
        self.assertEqual(self.events[-1]['processedUntilMs'], 5000)
        moved.rename(self.audio)
        self.assertEqual(self.run_job(value)['cacheHits'], 1)

    def test_protocol_rejects_extra_paths_nan_boolean_and_invalid_attempts(self):
        for changes in [{'protocolVersion': True}, {'attempt': True}, {'attempt': 0}, {'unexpected': 'path'},
                        {'range': {'startMs': float('nan'), 'endMs': None}}, {'audioPath': 'relative.wav'}]:
            with self.assertRaises(JobError):
                parse_request(request(self.audio, **changes))
        self.assertEqual(parse_request(request(self.audio))['type'], 'submit')

    def test_cancel_is_responsive_during_inference_and_suppresses_late_results(self):
        self.engine.entered, self.engine.release = threading.Event(), threading.Event()
        service = WorkerService(self.pipeline, self.events.append)
        value = request(self.audio)
        service.dispatch(value)
        try:
            self.assertTrue(self.engine.entered.wait(2))
            service.dispatch({key: value[key] for key in ['protocolVersion', 'jobId', 'attempt']} | {'type': 'cancel'})
            self.assertEqual(self.events[-1]['type'], 'cancel-accepted')
            self.engine.release.set()
            service.close()
            self.assertEqual(self.events[-1]['type'], 'canceled')
            self.assertFalse(any(event['type'] in ('partial', 'result') for event in self.events))
            self.assertFalse(list((self.root / 'cache').glob('*/chunk-*.json')))
        finally:
            self.engine.release.set()
            service.close()


if __name__ == '__main__':
    unittest.main()
