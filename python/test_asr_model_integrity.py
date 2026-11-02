import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from asr_model_integrity import verify_model_integrity


class ModelIntegrityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.model = self.root / 'model'
        self.model.mkdir()
        self.weight = self.model / 'model.pt'
        self.weight.write_bytes(b'known fixture bytes')
        self.manifest = self.root / 'trusted.json'
        self.values = {'paraformer': {'repository': 'fixture/local', 'revision': 'fixed', 'path': str(self.model)}}
        self.expected = {'version': 1, 'models': {'paraformer': {
            'repository': 'fixture/local', 'revision': 'fixed',
            'files': {'model.pt': {'bytes': self.weight.stat().st_size,
                                  'sha256': hashlib.sha256(self.weight.read_bytes()).hexdigest()}}}}}
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps(self.expected), encoding='utf-8')

    def verify(self):
        return verify_model_integrity(self.values, ['paraformer'], self.manifest)

    def test_exact_bytes_are_verified_without_loading_pickle_or_a_model_framework(self):
        self.assertEqual(self.verify(), hashlib.sha256(self.manifest.read_bytes()).hexdigest())

    def test_windows_handle_and_path_ctime_semantics_do_not_reject_exact_bytes(self):
        import os
        original = os.fstat
        def handle_stat(fd):
            value = original(fd)
            fields = {name: getattr(value, name) for name in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
            fields['st_ctime_ns'] += 1
            return SimpleNamespace(**fields)
        with patch('asr_model_integrity.os.fstat', side_effect=handle_stat):
            self.assertEqual(self.verify(), hashlib.sha256(self.manifest.read_bytes()).hexdigest())

    def test_same_length_corruption_is_rejected(self):
        self.weight.write_bytes(b'unknown fixture byte')
        with self.assertRaisesRegex(ValueError, '校验失败|大小'):
            self.verify()

    def test_substituted_preferred_weights_or_configuration_cannot_bypass_fixed_files(self):
        for name in ('model.safetensors', 'config.json'):
            with self.subTest(name=name):
                path = self.model / name
                path.write_bytes(b'untrusted')
                with self.assertRaisesRegex(ValueError, '未经发布方固定'):
                    self.verify()
                path.unlink()

    def test_claiming_the_same_revision_does_not_make_unknown_bytes_trusted(self):
        self.weight.write_bytes(b'attack payload data')
        with self.assertRaises(ValueError):
            self.verify()
        self.values['paraformer']['revision'] = 'other'
        with self.assertRaisesRegex(ValueError, '身份'):
            self.verify()

    def test_unsafe_manifest_path_is_rejected(self):
        entry = self.expected['models']['paraformer']['files'].pop('model.pt')
        self.expected['models']['paraformer']['files']['../outside'] = entry
        self.save()
        with self.assertRaises(ValueError):
            self.verify()

    def test_bundled_pyannote_checkpoint_is_verified_before_whisperx_loading(self):
        self.values['whisper'] = self.values['paraformer']
        self.expected['models']['whisper'] = self.expected['models']['paraformer']
        asset = self.root / 'runtime/whisperx/assets/pytorch_model.bin'
        asset.parent.mkdir(parents=True)
        asset.write_bytes(b'known VAD')
        self.expected['runtimeFiles'] = {'whisperx/assets/pytorch_model.bin': {
            'bytes': 9, 'sha256': hashlib.sha256(asset.read_bytes()).hexdigest()}}
        self.save()
        verify_model_integrity(self.values, ['whisper'], self.manifest, self.root / 'runtime')
        package = asset.parent.parent / '__init__.py'
        package.touch()
        with patch('asr_model_integrity.importlib.util.find_spec', return_value=SimpleNamespace(origin=str(package))) as find:
            verify_model_integrity(self.values, ['whisper'], self.manifest)
            find.assert_called_once_with('whisperx')
        with patch('asr_model_integrity.importlib.util.find_spec', return_value=None):
            with self.assertRaisesRegex(ValueError, '找不到 WhisperX'):
                verify_model_integrity(self.values, ['whisper'], self.manifest)
        asset.write_bytes(b'other VAD')
        with self.assertRaisesRegex(ValueError, 'WhisperX VAD.*校验失败'):
            verify_model_integrity(self.values, ['whisper'], self.manifest, self.root / 'runtime')
        self.expected.pop('runtimeFiles')
        self.save()
        with self.assertRaisesRegex(ValueError, '内置 VAD'):
            verify_model_integrity(self.values, ['whisper'], self.manifest, self.root / 'runtime')
