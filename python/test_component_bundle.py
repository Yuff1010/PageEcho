import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

from asr_runtime import configure_cache, load_local_models
from component_bundle import BundleWriter, archive_bundle, requirements, safe_relative, verify_bundle


class PortableBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='asr portable ')
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def completed(self):
        writer = BundleWriter(self.root / 'component')
        writer.write('resource.txt', '原始资源')
        writer.finish({'version': 'fixture'}, {'fixture': '1'}, {})
        return writer.root

    def test_portable_paths_reject_absolute_drives_traversal_and_backslashes(self):
        self.assertEqual(str(safe_relative('models/chinese/weights.bin')), 'models/chinese/weights.bin')
        for path in ['', '../outside', '/absolute', 'C:/outside', 'folder/../outside', 'folder\\file', './file']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                safe_relative(path)

    def test_incomplete_tampered_and_unexpected_files_are_rejected(self):
        writer = BundleWriter(self.root / 'component')
        with self.assertRaises(ValueError):
            verify_bundle(writer.root)
        writer.write('resource.txt', 'original')
        writer.finish({'version': 'fixture'}, {}, {})
        self.assertEqual(verify_bundle(writer.root)['files'], 3)
        (writer.root / 'resource.txt').write_text('tampered', encoding='utf-8')
        with self.assertRaises(ValueError):
            verify_bundle(writer.root)
        (writer.root / 'resource.txt').write_text('original', encoding='utf-8')
        (writer.root / 'unexpected.txt').write_text('not inventoried', encoding='utf-8')
        with self.assertRaises(ValueError):
            verify_bundle(writer.root)

    def test_archive_can_be_extracted_to_a_new_path_and_verified(self):
        component = self.completed()
        archive = self.root / 'portable.zip'
        report = archive_bundle(component, archive)
        self.assertEqual(report['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        relocated = self.root / 'moved 中文'
        with zipfile.ZipFile(archive) as package:
            self.assertIsNone(package.testzip())
            package.extractall(relocated)
        self.assertEqual(verify_bundle(component), verify_bundle(relocated))
        config = json.loads((relocated / 'component.json').read_text(encoding='utf-8'))
        self.assertEqual(config['version'], 2)
        self.assertNotIn('cache', config)

    def test_embedding_archive_hash_is_required_before_extracting_any_file(self):
        archive = self.root / 'python.zip'
        with zipfile.ZipFile(archive, 'w') as package:
            package.writestr('../outside.txt', 'not allowed')
        writer = BundleWriter(self.root / 'component')
        with self.assertRaises(ValueError):
            writer.embedded_python(archive, {'sha256': '0' * 64})
        with self.assertRaises(ValueError):
            writer.embedded_python(archive, {'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
        self.assertFalse((self.root / 'outside.txt').exists())

    def test_requirement_versions_are_exact_and_unpinned_inputs_fail(self):
        lock = self.root / 'requirements.txt'
        lock.write_text('# comment\n--extra-index-url https://example.com\nTorch==2.8.0+cu128\npyannote.audio==4.0.7\n', encoding='utf-8')
        self.assertEqual(requirements(lock), {'torch': '2.8.0+cu128', 'pyannote-audio': '4.0.7'})
        lock.write_text('torch>=2\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            requirements(lock)

    def test_model_paths_are_manifest_relative_and_resources_are_separate_from_cache(self):
        models = self.root / 'models'
        models.mkdir()
        manifest = self.root / 'models.json'
        manifest.write_text(json.dumps({'version': 1, 'models': {'fixture': {'path': 'models', 'revision': 'fixed'}}}), encoding='utf-8')
        self.assertEqual(load_local_models(manifest)['fixture']['path'], str(models.resolve()))
        keys = ['HF_HOME', 'HF_HUB_CACHE', 'MODELSCOPE_CACHE', 'TORCH_HOME', 'NLTK_DATA', 'NUMBA_CACHE_DIR', 'MPLCONFIGDIR']
        previous = {key: os.environ.get(key) for key in keys}
        try:
            cache, resources = self.root / 'cache', self.root / 'immutable'
            configure_cache(cache, resources=resources)
            self.assertEqual(os.environ['NLTK_DATA'], str(resources.resolve() / 'nltk'))
            self.assertTrue((cache / 'numba').is_dir())
            self.assertFalse(resources.exists())
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == '__main__':
    unittest.main()
