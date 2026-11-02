"""Component prerequisite behavior with tiny files and mocked native imports.

These tests never load model weights, start FFmpeg, inspect a real GPU, or change
the test process's network policy or cache environment.
"""

from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import asr_component_probe as probe


class ComponentProbeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='component probe fixture ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.resources = self.root / 'resources'
        self.sentence = self.resources / 'nltk/tokenizers/punkt_tab/english'
        self.sentence.mkdir(parents=True)
        for name in ['abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt']:
            (self.sentence / name).write_text('fixture', encoding='utf-8')
        self.whisper_package = self.root / 'whisperx'
        (self.whisper_package / 'assets').mkdir(parents=True)
        (self.whisper_package / 'assets/pytorch_model.bin').write_bytes(b'fixture vad')
        # These describe expected component artifacts independently of the probe's
        # implementation constants, so dropping a dependency cannot weaken tests.
        files = {
            'paraformer': ['model.pt', 'config.yaml', 'configuration.json', 'am.mvn', 'tokens.json', 'seg_dict'],
            'vad': ['model.pt', 'config.yaml', 'configuration.json', 'am.mvn'],
            'punctuation': ['model.pt', 'config.yaml', 'configuration.json', 'tokens.json'],
            'whisper': ['model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json', 'vocabulary.json'],
            'alignment': ['pytorch_model.bin', 'config.json', 'preprocessor_config.json', 'vocab.json', 'special_tokens_map.json'],
        }
        pinned = json.loads(Path(probe.__file__).with_name('evaluation-models.json').read_text(encoding='utf-8'))['models']
        models = {}
        for name, names in files.items():
            directory = self.root / 'models' / name
            directory.mkdir(parents=True)
            for filename in names:
                (directory / filename).write_bytes(b'fixture bytes, never loaded')
            models[name] = {**pinned[name], 'path': str(directory)}
        self.manifest = self.root / 'models.json'
        self.manifest.write_text(json.dumps({'version': 1, 'models': models}), encoding='utf-8')
        self.args = SimpleNamespace(cache=str(self.cache), models=str(self.manifest),
                                    resources=str(self.resources), ffmpeg='fixture-ffmpeg', ffprobe='fixture-ffprobe')
        self.cuda_available = False
        self.bad_imports = set()
        self.cuda_compute = {'int8_float16'}
        self.modules = {
            'torch': SimpleNamespace(cuda=SimpleNamespace(
                is_available=lambda: self.cuda_available, get_device_name=lambda _: 'Fixture NVIDIA GPU')),
            'ctranslate2': SimpleNamespace(get_supported_compute_types=lambda device: {'int8'} if device == 'cpu' else self.cuda_compute),
            'whisperx.asr': SimpleNamespace(__file__=str(self.whisper_package / 'asr.py')),
        }
        self.import_module = Mock(side_effect=self.import_fixture)
        self.tools = Mock(side_effect=lambda command, **_: SimpleNamespace(
            stdout=b'ffprobe fixture version' if 'ffprobe' in command[0] else b'ffmpeg fixture version'))
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(probe, 'protect_worker_process'))
        stack.enter_context(patch.object(probe, 'configure_offline_network'))
        self.security = stack.enter_context(patch.object(probe, 'component_security_issues', return_value=[]))
        self.configure_cache = stack.enter_context(patch.object(probe, 'configure_cache', return_value=self.cache))
        stack.enter_context(patch.object(probe, 'importlib', SimpleNamespace(import_module=self.import_module)))
        stack.enter_context(patch.object(probe.subprocess, 'run', self.tools))
        stack.enter_context(patch.object(probe.shutil, 'disk_usage', return_value=SimpleNamespace(free=2 * 1024**3)))

    def import_fixture(self, name):
        if name in self.bad_imports:
            raise ImportError(f'fixture missing {name}')
        return self.modules.get(name, SimpleNamespace())

    @staticmethod
    def capability(result, engine, device='cpu'):
        return next(value for value in result['capabilities'] if value['engine'] == engine and value['device'] == device)

    def test_complete_cpu_component_is_available_without_claiming_inference_or_cuda(self):
        result = probe.check(self.args)
        self.assertEqual(result['level'], 'imports-and-files')
        self.assertEqual(len(result['capabilities']), 4)
        for engine in ['whisperx', 'paraformer']:
            self.assertTrue(self.capability(result, engine)['available'])
            self.assertFalse(self.capability(result, engine, 'cuda')['available'])
            self.assertIn('尚未加载权重', self.capability(result, engine)['message'])
        self.assertTrue(result['ready'])

    def test_outdated_component_is_rejected_before_native_imports_or_tool_execution(self):
        self.security.return_value = ['转写组件需要安全更新，请安装新版组件，普通播放仍可使用。']
        result = probe.check(self.args)
        self.assertFalse(result['ready'])
        self.assertTrue(all(not entry['available'] for entry in result['capabilities']))
        self.assertIn('安全更新', result['issues'][0])
        self.import_module.assert_not_called()
        self.tools.assert_not_called()
        self.configure_cache.assert_not_called()

    def test_missing_punctuation_weights_blocks_whisper_and_paraformer(self):
        (self.root / 'models/punctuation/model.pt').unlink()
        result = probe.check(self.args)
        for engine in ['whisperx', 'paraformer']:
            value = self.capability(result, engine)
            self.assertFalse(value['available'])
            self.assertIn('punctuation', value['message'])
            self.assertIn('model.pt', value['message'])

    def test_missing_sentence_resources_blocks_both_worker_startup_paths(self):
        (self.sentence / 'ortho_context.tab').unlink()
        result = probe.check(self.args)
        for engine in ['whisperx', 'paraformer']:
            value = self.capability(result, engine)
            self.assertFalse(value['available'])
            self.assertIn('ortho_context.tab', value['message'])

    def test_paraformer_requires_whisper_alignment_for_its_ctc_fallback(self):
        self.bad_imports.add('whisperx.alignment')
        value = self.capability(probe.check(self.args), 'paraformer')
        self.assertFalse(value['available'])
        self.assertIn('whisperx.alignment', value['message'])

    def test_whisper_requires_funasr_for_chinese_punctuation(self):
        self.bad_imports.add('funasr')
        value = self.capability(probe.check(self.args), 'whisperx')
        self.assertFalse(value['available'])
        self.assertIn('funasr', value['message'])

    def test_a_native_torchaudio_import_failure_marks_every_profile_unavailable(self):
        self.bad_imports.add('torchaudio')
        result = probe.check(self.args)
        self.assertFalse(result['ready'])
        for value in result['capabilities']:
            self.assertFalse(value['available'])
            self.assertIn('torchaudio', value['message'])

    def test_whisper_vad_asset_is_required_without_unnecessarily_blocking_paraformer(self):
        (self.whisper_package / 'assets/pytorch_model.bin').unlink()
        result = probe.check(self.args)
        self.assertFalse(self.capability(result, 'whisperx')['available'])
        self.assertTrue(self.capability(result, 'paraformer')['available'])

    def test_cuda_requires_the_requested_compute_type_even_when_torch_sees_a_gpu(self):
        self.cuda_available = True
        self.cuda_compute = {'float32'}
        result = probe.check(self.args)
        self.assertEqual(result['cudaName'], 'Fixture NVIDIA GPU')
        self.assertFalse(self.capability(result, 'whisperx', 'cuda')['available'])
        self.assertIn('int8_float16', self.capability(result, 'whisperx', 'cuda')['message'])
        self.assertTrue(self.capability(result, 'paraformer', 'cuda')['available'])
        self.assertTrue(self.capability(result, 'whisperx', 'cpu')['available'])

    def test_unwritable_cache_returns_before_importing_ml_or_launching_tools(self):
        self.configure_cache.side_effect = PermissionError('fixture read-only cache')
        result = probe.check(self.args)
        self.assertFalse(result['ready'])
        self.assertTrue(all(not value['available'] for value in result['capabilities']))
        self.assertIn('缓存目录不可写', result['issues'][0])
        self.import_module.assert_not_called()
        self.tools.assert_not_called()

    def test_invalid_decoder_binary_returns_before_importing_ml(self):
        self.tools.side_effect = None
        self.tools.return_value = SimpleNamespace(stdout=b'fixture unrelated executable')
        result = probe.check(self.args)
        self.assertFalse(result['ready'])
        self.assertTrue(all(not value['available'] for value in result['capabilities']))
        self.import_module.assert_not_called()


if __name__ == '__main__':
    unittest.main()
