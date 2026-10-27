import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from build_cpu_component import build_cpu_component, CPU_WHEELS, inspect_wheel, SITE
from component_bundle import BundleWriter, checksum, verify_bundle


class CpuComponentBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cpu bundle 中文 ')
        self.root = Path(self.temporary.name)
        self.base, self.wheels = self.root / 'base', self.root / 'wheels'
        self.wheels.mkdir()
        writer = BundleWriter(self.base)
        writer.write('python/python.exe', 'interpreter fixture; never executed')
        writer.write('tools/ffmpeg.exe', 'ffmpeg fixture')
        writer.write('tools/ffprobe.exe', 'ffprobe fixture')
        writer.write('resources/nltk/data.txt', 'resource bytes')
        writer.write(SITE + 'retained/keep_cuda_named_resource.txt', 'preserve exact nonreplacement bytes')
        packages = {'retained': '1.0'}
        for name, pin in CPU_WHEELS.items():
            packages[name] = pin['oldVersion']
            owned = {f'{name}/lib/old_cuda.dll': 'old distribution file',
                     f'{name}-{pin["oldVersion"]}.dist-info/METADATA': f'Name: {name}\nVersion: {pin["oldVersion"]}\n'}
            if name == 'torch':
                owned['functorch/old_only.py'] = '# remove by ownership, not only torch prefix'
                owned['torchgen/old_only.py'] = '# remove by ownership'
            record_path = f'{name}-{pin["oldVersion"]}.dist-info/RECORD'
            for path, value in owned.items():
                writer.write(SITE + path, value)
            # Like pip's installed RECORD, include an environment console entry
            # and pycache which the portable base deliberately did not copy.
            rows = [[path, '', ''] for path in owned]
            rows += [[record_path, '', ''], ['../../Scripts/tool.exe', '', ''], [f'{name}/__pycache__/x.pyc', '', '']]
            buffer = io.StringIO(); csv.writer(buffer, lineterminator='\n').writerows(rows)
            writer.write(SITE + record_path, buffer.getvalue())
        models = {}
        for role in ['paraformer', 'vad', 'punctuation', 'whisper', 'alignment']:
            writer.write('models/' + role + '/model.bin', f'original {role}')
            models[role] = {'repository': 'fixture/' + role, 'revision': 'a' * 40, 'path': 'models/' + role}
        writer.finish({'version': '3.12.10'}, packages, models)
        self.base_sha = checksum(self.base / 'bundle-manifest.json')
        self.base_hashes = {str(path.relative_to(self.base)): checksum(path) for path in self.base.rglob('*') if path.is_file()}
        self.evaluation_lock, self.cpu_lock = self.root / 'old.txt', self.root / 'cpu.txt'
        self.evaluation_lock.write_text(''.join(f'{key}=={value}\n' for key, value in packages.items()), encoding='utf-8')
        self.cpu_lock.write_text(''.join(f'{key}=={CPU_WHEELS[key]["version"] if key in CPU_WHEELS else value}\n' for key, value in packages.items()), encoding='utf-8')
        self.pins = {name: dict(pin) for name, pin in CPU_WHEELS.items()}
        for name in self.pins:
            self.make_wheel(name)

    def tearDown(self):
        self.temporary.cleanup()

    def make_wheel(self, name, *, bad_record=False, bad_abi=False, extra=None):
        pin = self.pins[name]
        info = f'{name}-{pin["version"]}.dist-info'
        files = {name + '/lib/cpu.dll': b'complete official-style CPU library',
                 info + '/METADATA': f'Name: {name}\nVersion: {pin["version"]}\n'.encode(),
                 info + '/WHEEL': f'Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: {"cp311-cp311-win_amd64" if bad_abi else "cp312-cp312-win_amd64"}\n'.encode(),
                 info + '/licenses/LICENSE': b'preserve the complete license',
                 name + '/lib/complete_static.lib': b'preserve even large development artifacts'}
        if name == 'torch':
            files['functorch/new_only.py'] = b'# new complete CPU distribution'
            files['torchgen/new_only.py'] = b'# new complete CPU distribution'
        if extra:
            files.update(extra)
        rows = []
        for path, value in files.items():
            digest = base64.urlsafe_b64encode(hashlib.sha256(value).digest()).decode().rstrip('=')
            if bad_record and path.endswith('cpu.dll'):
                digest = base64.urlsafe_b64encode(b'0' * 32).decode().rstrip('=')
            # The actual official torchvision wheel uses Windows RECORD separators.
            rows.append([path.replace('/', '\\') if name == 'torchvision' else path, 'sha256=' + digest, str(len(value))])
        record_path = info + '/RECORD'
        rows.append([record_path.replace('/', '\\') if name == 'torchvision' else record_path, '', ''])
        buffer = io.StringIO(); csv.writer(buffer, lineterminator='\n').writerows(rows)
        files[record_path] = buffer.getvalue().encode()
        path = self.wheels / pin['filename']
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as package:
            for key, value in files.items():
                package.writestr(key, value)
        pin.update(bytes=path.stat().st_size, sha256=checksum(path))

    def build(self, output, **kwargs):
        return build_cpu_component(self.base, self.wheels, output, '0.7.1-cpu.1',
                                   base_manifest_sha256=self.base_sha, wheel_pins=self.pins,
                                   cpu_lock=self.cpu_lock, evaluation_lock=self.evaluation_lock, **kwargs)

    def test_full_cpu_distributions_replace_old_owned_files_and_preserve_every_other_byte(self):
        output = self.root / 'cpu'
        report = self.build(output)
        self.assertEqual(verify_bundle(output)['bytes'], report['bytes'])
        self.assertFalse((output / (SITE + 'torch/lib/old_cuda.dll')).exists())
        self.assertFalse((output / (SITE + 'functorch/old_only.py')).exists())
        self.assertTrue((output / (SITE + 'functorch/new_only.py')).is_file())
        for name, pin in self.pins.items():
            self.assertEqual(report['packages'][name], pin['version'])
            self.assertTrue((output / (SITE + name + '/lib/complete_static.lib')).is_file())
            self.assertTrue((output / (SITE + f'{name}-{pin["version"]}.dist-info/licenses/LICENSE')).is_file())
        self.assertEqual((output / (SITE + 'retained/keep_cuda_named_resource.txt')).read_bytes(), (self.base / (SITE + 'retained/keep_cuda_named_resource.txt')).read_bytes())
        profile = json.loads((output / 'runtime-profile.json').read_text(encoding='utf-8'))
        self.assertEqual(profile['devices'], ['cpu'])
        self.assertEqual(profile['componentVersion'], '0.7.1-cpu.1')
        config = json.loads((output / 'component.json').read_text(encoding='utf-8'))
        self.assertEqual(set(config), {'version', 'python', 'models', 'resources', 'ffmpeg', 'ffprobe'})
        self.assertEqual(self.base_hashes, {str(path.relative_to(self.base)): checksum(path) for path in self.base.rglob('*') if path.is_file()})

    def test_model_profile_selection_remains_a_complete_independent_bundle_and_new_zip(self):
        output, archive = self.root / 'cpu-pf', self.root / 'cpu-pf.zip'
        report = self.build(output, engine='paraformer', archive=archive)
        models = json.loads((output / 'models.json').read_text(encoding='utf-8'))['models']
        self.assertEqual(set(models), {'paraformer', 'vad', 'punctuation', 'alignment'})
        self.assertFalse((output / 'models/whisper').exists())
        self.assertEqual(report['archive']['sha256'], checksum(archive))
        with zipfile.ZipFile(archive) as package:
            self.assertIsNone(package.testzip())
            self.assertIn('runtime-profile.json', package.namelist())
        with self.assertRaisesRegex(ValueError, 'new|separate'):
            self.build(output)

    def test_untrusted_base_wheel_or_extra_lock_change_is_rejected_before_output(self):
        path = self.wheels / self.pins['torch']['filename']
        path.write_bytes(path.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'SHA/size'):
            self.build(self.root / 'bad-wheel')
        self.assertFalse((self.root / 'bad-wheel').exists())
        self.make_wheel('torch')
        self.cpu_lock.write_text(self.cpu_lock.read_text().replace('retained==1.0', 'retained==2.0'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'exactly'):
            self.build(self.root / 'bad-lock')
        (self.base / 'models/paraformer/model.bin').write_text('tampered', encoding='utf-8')
        self.cpu_lock.write_text(self.cpu_lock.read_text().replace('retained==2.0', 'retained==1.0'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.build(self.root / 'bad-base')

    def test_record_hash_failure_leaves_building_marker_and_never_a_complete_candidate(self):
        self.make_wheel('torch', bad_record=True)
        output = self.root / 'failed'
        with self.assertRaisesRegex(ValueError, 'RECORD checksum'):
            self.build(output)
        self.assertTrue((output / 'BUILDING.json').is_file())
        self.assertFalse((output / 'bundle-manifest.json').exists())
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            verify_bundle(output)

    def test_fixed_windows_abi_and_safe_wheel_paths_are_required(self):
        self.make_wheel('torchaudio', bad_abi=True)
        with self.assertRaisesRegex(ValueError, 'ABI'):
            inspect_wheel(self.wheels / self.pins['torchaudio']['filename'], 'torchaudio', self.pins['torchaudio'])
        self.make_wheel('torchaudio', extra={'../outside.exe': b'never extract'})
        with self.assertRaises(ValueError):
            inspect_wheel(self.wheels / self.pins['torchaudio']['filename'], 'torchaudio', self.pins['torchaudio'])
        self.assertFalse((self.root / 'outside.exe').exists())


if __name__ == '__main__':
    unittest.main()
