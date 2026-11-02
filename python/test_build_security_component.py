import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from build_security_component import build_security_component, inspect_patch_wheel
from component_bundle import BundleWriter, checksum, verify_bundle


def record(files, name):
    stream = io.StringIO()
    writer = csv.writer(stream, lineterminator='\n')
    for path, data in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
        writer.writerow([path, 'sha256=' + digest, len(data)])
    writer.writerow([name, '', ''])
    return stream.getvalue().encode()


class SecurityBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base, self.wheels = self.root / 'base', self.root / 'wheels'
        self.wheels.mkdir()
        site = 'python/Lib/site-packages/'
        files = {'fixture/__init__.py': b'original',
                 'fixture-1.0.0.dist-info/METADATA': b'Name: fixture\nVersion: 1.0.0\n'}
        files['fixture-1.0.0.dist-info/RECORD'] = record(files, 'fixture-1.0.0.dist-info/RECORD')
        writer = BundleWriter(self.base)
        for path, data in files.items():
            writer.write(site + path, data.decode())
        writer.write('untouched-model.bin', 'synthetic model data')
        writer.write('dependency-versions.txt', 'fixture==1.0.0\n')
        writer.write('README.txt', 'old')
        writer.json('runtime-profile.json', {'componentVersion': 'fixture-1', 'devices': ['cpu']})
        writer.finish({'version': 'fixture'}, {'fixture': '1.0.0'}, {})
        self.lock = self.root / 'current.txt'
        self.lock.write_text('fixture==2.0.0\n')
        self.archive = self.wheels / 'fixture-2.0.0-py3-none-any.whl'
        files = {'fixture/__init__.py': b'patched',
                 'fixture-2.0.0.dist-info/METADATA': b'Name: fixture\nVersion: 2.0.0\n',
                 'fixture-2.0.0.dist-info/WHEEL': b'Wheel-Version: 1.0\nTag: py3-none-any\n',
                 'fixture-2.0.0.dist-info/licenses/LICENSE': b'fixture license'}
        files['fixture-2.0.0.dist-info/RECORD'] = record(files, 'fixture-2.0.0.dist-info/RECORD')
        with zipfile.ZipFile(self.archive, 'w') as package:
            for path, data in files.items():
                package.writestr(path, data)
        self.pin = {'name': 'fixture', 'oldVersion': '1.0.0', 'version': '2.0.0',
                    'filename': self.archive.name, 'bytes': self.archive.stat().st_size,
                    'sha256': checksum(self.archive)}
        self.pins = {'bases': [{'id': 'fixture-base', 'manifestSha256': checksum(self.base / 'bundle-manifest.json'), 'profile': 'cpu'}],
                     'wheels': [self.pin]}
        self.before = {str(path.relative_to(self.base)): checksum(path) for path in self.base.rglob('*') if path.is_file()}

    def build(self, output=None):
        return build_security_component(self.base, self.wheels, output or self.root / 'new', 'fixture-2', pins=self.pins, lock=self.lock)

    def test_patches_only_owned_package_preserving_models_licenses_and_old_bundle(self):
        report = self.build()
        output = Path(report['output'])
        self.assertEqual(report['status'], 'built-and-verified')
        self.assertEqual((output / 'python/Lib/site-packages/fixture/__init__.py').read_bytes(), b'patched')
        self.assertFalse((output / 'python/Lib/site-packages/fixture-1.0.0.dist-info').exists())
        self.assertTrue((output / 'python/Lib/site-packages/fixture-2.0.0.dist-info/licenses/LICENSE').is_file())
        profile = json.loads((output / 'runtime-profile.json').read_text())
        self.assertEqual(profile['componentVersion'], 'fixture-2')
        self.assertEqual(profile['securityPatchBaseComponentVersion'], 'fixture-1')
        self.assertEqual(profile['devices'], ['cpu'])
        self.assertEqual(checksum(output / 'untouched-model.bin'), self.before['untouched-model.bin'])
        self.assertEqual(self.before, {str(path.relative_to(self.base)): checksum(path) for path in self.base.rglob('*') if path.is_file()})
        verify_bundle(output)
        with self.assertRaisesRegex(ValueError, 'new and separate'):
            self.build(output)

    def test_unknown_base_wheel_corruption_and_lock_drift_fail_before_output_creation(self):
        (self.base / 'bundle-manifest.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'publisher-pinned'):
            self.build()
        self.assertFalse((self.root / 'new').exists())

    def test_corrupt_wheel_and_unapproved_lock_change_are_rejected(self):
        self.lock.write_text('fixture==3.0.0\n')
        with self.assertRaisesRegex(ValueError, 'exactly the approved'):
            self.build()
        with self.archive.open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'official bytes'):
            inspect_patch_wheel(self.archive, self.pin)

    def test_input_output_overlap_and_authenticated_unsafe_zip_paths_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'separate'):
            self.build(self.base / 'nested')
        with zipfile.ZipFile(self.archive, 'a') as package:
            package.writestr('../outside', b'untrusted')
        self.pin.update(bytes=self.archive.stat().st_size, sha256=checksum(self.archive))
        with self.assertRaises(ValueError):
            inspect_patch_wheel(self.archive, self.pin)
