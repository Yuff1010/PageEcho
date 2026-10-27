"""Thread forwarding, default cache identity, and post-model readback contracts."""

import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from asr_engines import Paraformer, WhisperX, ChinesePunctuation
from asr_jobs import FFmpegDecoder
from asr_resources import (
    THREAD_ENVIRONMENT, configure_cpu_environment, configure_torch_threads,
    execution_resources, verify_torch_threads, ResourceCheckedEngine, ResourceCheckedPunctuation,
)
from asr_segments import POSTPROCESS_VERSION, fingerprint
from asr_worker import WorkerService, build_pipeline


class Torch:
    def __init__(self):
        self.threads, self.interop = 8, 8
        self.set_interop_calls = []
        self.cuda = SimpleNamespace(is_available=lambda: False)

    def get_num_threads(self):
        return self.threads

    def get_num_interop_threads(self):
        return self.interop

    def set_num_threads(self, value):
        self.threads = value

    def set_num_interop_threads(self, value):
        self.set_interop_calls.append(value)
        self.interop = value

    def manual_seed(self, _value):
        pass


class ResourceTests(unittest.TestCase):
    def test_environment_has_one_budget_before_any_ml_dependency_is_needed(self):
        with patch.dict(os.environ, {'OMP_NUM_THREADS': '12'}, clear=True):
            configure_cpu_environment(2)
            self.assertEqual({name: os.environ[name] for name in THREAD_ENVIRONMENT},
                             {name: '2' for name in THREAD_ENVIRONMENT})
            self.assertIsNone(execution_resources(2)['torchThreads'])
            for invalid in (0, 3, 5, True, '1'):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    configure_cpu_environment(invalid)

    def test_low_budgets_set_interop_once_but_default_four_keeps_its_original_interop_policy(self):
        for threads in (1, 2, 4):
            torch = Torch()
            with self.subTest(threads=threads), patch.dict('sys.modules', {'torch': torch}):
                resources = configure_torch_threads(threads)
                configure_torch_threads(threads)
                self.assertEqual(resources['torchThreads'], threads)
                self.assertEqual(torch.set_interop_calls, [1] if threads < 4 else [])
                self.assertEqual(resources['torchInteropThreads'], 1 if threads < 4 else 8)

    def test_a_model_resetting_threads_to_four_is_detected_instead_of_silently_hidden(self):
        torch = Torch()
        with patch.dict('sys.modules', {'torch': torch}):
            configure_torch_threads(1)
            publish = []
            engine = ResourceCheckedEngine(SimpleNamespace(transcribe=lambda _:
                torch.set_num_threads(4) or {'unchanged': 'model result'}), 1, publish.append)
            with self.assertRaisesRegex(RuntimeError, 'changed.*thread budget'):
                engine.transcribe([0])
            self.assertEqual(torch.get_num_threads(), 4)
            self.assertEqual(len(publish), 1, 'failed inference readback must not publish a fake effective one')
            with self.assertRaises(RuntimeError):
                verify_torch_threads(1)

    def test_punctuation_inference_also_verifies_the_effective_global_torch_budget(self):
        torch = Torch()
        with patch.dict('sys.modules', {'torch': torch}):
            configure_torch_threads(2)
            punctuation = ResourceCheckedPunctuation(SimpleNamespace(restore=lambda _:
                torch.set_num_threads(4) or '甲。'), 2, lambda _: None)
            with self.assertRaises(RuntimeError):
                punctuation.restore('甲')

    def test_every_adapter_passes_the_selected_budget_to_its_actual_model_loader(self):
        models = {name: {'path': name} for name in ('paraformer', 'vad', 'punctuation', 'whisper', 'alignment')}
        for threads in (1, 2, 4):
            calls = []
            funasr = SimpleNamespace(AutoModel=lambda **kwargs:
                                     calls.append(kwargs) or SimpleNamespace(model=object()))
            whisperx = SimpleNamespace(load_model=lambda *_, **kwargs: calls.append(kwargs) or object(),
                                       load_align_model=lambda **_: (object(), {}))
            with self.subTest(threads=threads), patch.dict('sys.modules', {'funasr': funasr, 'whisperx': whisperx}), \
                    patch('asr_engines.configure_paraformer_timestamps', return_value='pinned'), \
                    patch('asr_engines.ctc_alignment_function', return_value=object()):
                Paraformer(models, 'cpu', cpu_threads=threads)
                self.assertEqual(calls[-1]['ncpu'], threads)
                ChinesePunctuation(models, cpu_threads=threads)
                self.assertEqual(calls[-1]['ncpu'], threads)
                WhisperX(models, 'cpu', 'int8', 1, cpu_threads=threads)
                self.assertEqual(calls[-1]['threads'], threads)
                self.assertEqual(calls[-1]['compute_type'], 'int8')

    def test_ffmpeg_preserves_default_command_and_low_profiles_limit_only_decode_resources(self):
        class Captured(Exception):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            ffmpeg, ffprobe = Path(temporary) / 'ffmpeg.exe', Path(temporary) / 'ffprobe.exe'
            ffmpeg.touch()
            ffprobe.touch()
            commands = []
            def capture(command, _canceled):
                commands.append(command)
                raise Captured()
            with patch('asr_jobs.run_decoder', side_effect=capture):
                for threads in (4, 1, 2):
                    decoder = FFmpegDecoder(ffmpeg, ffprobe, cpu_threads=threads)
                    with self.assertRaises(Captured):
                        decoder.decode('source.wav', {'decodeStartMs': 1000, 'decodeEndMs': 31000}, None)
            baseline = [str(ffmpeg.resolve()), '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-ss', '1.0', '-protocol_whitelist', 'file,pipe', '-i', 'source.wav',
                        '-t', '30.0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
                        '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1']
            self.assertEqual(commands[0], baseline)
            for threads, command in zip((1, 2), commands[1:]):
                self.assertEqual(command[:5] + command[9:], baseline)
                self.assertEqual(command[5:9], ['-threads', str(threads), '-filter_threads', str(threads)])


class WorkerBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.pinned = json.loads(Path(__file__).with_name('evaluation-models.json').read_text(encoding='utf-8'))['models']
        self.models = {key: {**value, 'path': str(self.root / key)} for key, value in self.pinned.items()}
        for entry in self.models.values():
            Path(entry['path']).mkdir()
        for name in ('ffmpeg', 'ffprobe'):
            (self.root / name).touch()
        self.args = SimpleNamespace(cache=str(self.root / 'cache'), resources=str(self.root),
                                    models='models.json', engine='paraformer', device='cpu', compute='int8',
                                    ffmpeg=str(self.root / 'ffmpeg'), ffprobe=str(self.root / 'ffprobe'),
                                    chunk_ms=30000, overlap_ms=2000)
        self.torch = Torch()
        self.patches = [patch.dict(os.environ, {}, clear=True), patch.dict('sys.modules', {'torch': self.torch}),
                        patch('asr_worker.configure_cache', return_value=self.root),
                        patch('asr_worker.configure_offline_network'),
                        patch('asr_worker.load_local_models', return_value=self.models),
                        patch('asr_worker.importlib.metadata.version', return_value='fixture'),
                        patch('asr_worker.hash_file', return_value='a' * 64),
                        patch('asr_worker.sys.version', '3.13.9 (fixture)')]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def test_implicit_and_explicit_four_keep_the_legacy_configuration_and_cache_fingerprint(self):
        pipeline = build_pipeline(self.args)
        versions = {name: 'fixture' for name in ('torch', 'torchaudio', 'funasr', 'whisperx', 'faster-whisper',
                                                'pyannote.audio', 'ctranslate2', 'transformers', 'numpy', 'nltk')}
        from asr_ctc import CTC_ALIGNMENT_CONTRACT
        from asr_compat import PARAFORMER_TIMESTAMP_CONTRACT
        legacy = {'engine': 'paraformer', 'device': 'cpu', 'computeType': 'float32', 'batchSize': 1,
                  'threads': 4, 'language': 'zh', 'versions': versions,
                  'models': {key: self.pinned[key] for key in ('paraformer', 'vad', 'punctuation', 'alignment')},
                  'python': '3.13.9', 'offlineNetwork': 'python-loopback-only-ffmpeg-file-pipe-v1',
                  'punctuationPolicy': 'engine-surface-once-v1', 'ctcAlignmentObjective': CTC_ALIGNMENT_CONTRACT,
                  'ffmpegSha256': 'a' * 64, 'ffprobeSha256': 'a' * 64,
                  'timestampAdapter': PARAFORMER_TIMESTAMP_CONTRACT, 'nativeTimestampFallback': 'zh-ctc-no-interpolation-v1',
                  'sentenceResource': {name: 'a' * 64 for name in ('abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt')},
                  'chunkMs': 30000, 'overlapMs': 2000, 'postprocessVersion': POSTPROCESS_VERSION, 'transcriptVersion': 1}
        self.assertEqual(pipeline.configuration, legacy)
        self.assertEqual(fingerprint(pipeline.configuration), fingerprint(legacy))
        self.args.cpu_threads = 4
        self.assertEqual(build_pipeline(self.args).configuration, legacy)
        self.assertNotIn('executionResources', pipeline.configuration)
        for threads in (1, 2):
            self.args.cpu_threads = threads
            low = build_pipeline(self.args)
            self.assertEqual(low.configuration, {**legacy, 'threads': threads})
            self.assertNotEqual(fingerprint(low.configuration), fingerprint(legacy))

    def test_loaded_model_and_terminal_protocol_read_back_the_selected_budget_outside_semantic_config(self):
        for threads in (1, 2, 4):
            self.args.cpu_threads = threads
            calls = []
            def model(_models, _device, cpu_threads):
                calls.append(cpu_threads)
                # Simulates the actual FunASR setting its constructor ncpu.
                self.torch.set_num_threads(cpu_threads)
                return SimpleNamespace(transcribe=lambda _: {'raw': 'unchanged'})
            with self.subTest(threads=threads), patch('asr_engines.Paraformer', side_effect=model):
                pipeline = build_pipeline(self.args)
                self.assertIsNone(pipeline.execution_resources['torchThreads'])
                engine = pipeline.engine_factory()
                self.assertEqual(engine.transcribe([0]), {'raw': 'unchanged'})
                self.assertEqual(calls, [threads])
                self.assertEqual(pipeline.execution_resources['torchThreads'], threads)
                output = []
                service = WorkerService(pipeline, output.append)
                service.emit('result', jobId='job', attempt=1)
                self.assertEqual(output[-1]['executionResources']['torchThreads'], threads)
                self.assertNotIn('executionResources', pipeline.configuration)

    def test_a_loader_ignoring_low_ncpu_is_rejected_after_load(self):
        self.args.cpu_threads = 1
        def incorrect_model(*_args, **_kwargs):
            self.torch.set_num_threads(4)
            return SimpleNamespace(transcribe=lambda _: {})
        with patch('asr_engines.Paraformer', side_effect=incorrect_model):
            pipeline = build_pipeline(self.args)
            with self.assertRaises(RuntimeError):
                pipeline.engine_factory()


if __name__ == '__main__':
    unittest.main()
