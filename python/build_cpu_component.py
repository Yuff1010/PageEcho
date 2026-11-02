"""Developer-only offline CPU component builder; never installs into an environment.

The CLI accepts only the patched 0.8.0-sec.1 base and official cp312 Windows CPU wheels.
It copies all retained distributions and complete replacement wheels, including
licenses and static libraries. No CUDA DLL removal or pip resolution is used.
"""

import argparse
import base64
import csv
from datetime import datetime, timezone
import email
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import stat
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from component_bundle import BLOCK, BundleWriter, archive_bundle, checksum, requirements, safe_relative, verify_bundle


BASE_MANIFEST_SHA256 = '1672902d73ed14c47e07d022e2794b12d40474a3b7aa5abb7a93274a0ff50b47'
BASE_VERSION = '0.8.0-sec.1'
SITE = 'python/Lib/site-packages/'
CPU_WHEELS = {
    'torch': {'version': '2.8.0+cpu', 'oldVersion': '2.8.0+cu128',
              'filename': 'torch-2.8.0+cpu-cp312-cp312-win_amd64.whl', 'bytes': 619352539,
              'sha256': '2be20b2c05a0cce10430cc25f32b689259640d273232b2de357c35729132256d'},
    'torchaudio': {'version': '2.8.0+cpu', 'oldVersion': '2.8.0+cu128',
                   'filename': 'torchaudio-2.8.0+cpu-cp312-cp312-win_amd64.whl', 'bytes': 2495725,
                   'sha256': '9b302192b570657c1cc787a4d487ae4bbb7f2aab1c01b1fcc46757e7f86f391e'},
    'torchvision': {'version': '0.23.0+cpu', 'oldVersion': '0.23.0+cu128',
                    'filename': 'torchvision-0.23.0+cpu-cp312-cp312-win_amd64.whl', 'bytes': 1600844,
                    'sha256': 'a651ccc540cf4c87eb988730c59c2220c52b57adc276f044e7efb9830fa65a1d'},
}
ENGINE_ROLES = {
    'paraformer': ['paraformer', 'vad', 'punctuation', 'alignment'],
    'whisperx': ['whisper', 'punctuation', 'alignment'],
    'both': ['paraformer', 'vad', 'punctuation', 'whisper', 'alignment'],
}
REGENERATED = {'component.json', 'models.json', 'bundle-manifest.json',
               'dependency-versions.txt', 'README.txt', 'component-security.json'}


def portable_name(value):
    path = safe_relative(value).as_posix()
    if path != value or len(path) > 2000 or any(ord(char) < 32 for char in path):
        raise ValueError('Non-canonical component path')
    for part in path.split('/'):
        if not part or part.endswith(('.', ' ')) or re.search(r'[<>"|?*]', part) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I):
            raise ValueError('Unsafe Windows component path')
    return path


def wheel_record(value):
    # The official torchvision Windows wheel uses backslashes in RECORD only;
    # its ZIP entries are canonical POSIX paths. Never normalize ZIP entry names.
    return portable_name(value.replace('\\', '/'))


def parse_record(data, record_name):
    result, seen = {}, set()
    for row in csv.reader(io.StringIO(data.decode('utf-8'))):
        if len(row) != 3:
            raise ValueError('Invalid wheel RECORD row')
        name = wheel_record(row[0])
        if name.casefold() in seen:
            raise ValueError('Duplicate wheel RECORD path')
        seen.add(name.casefold())
        if name == record_name:
            if row[1] or row[2]:
                raise ValueError('RECORD must not claim its own hash')
            result[name] = None
            continue
        if not row[1].startswith('sha256=') or not row[2].isdigit():
            raise ValueError('Every wheel file needs a SHA256 and size')
        encoded = row[1][7:]
        try:
            digest = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        except ValueError as error:
            raise ValueError('Invalid RECORD SHA256') from error
        if len(digest) != 32:
            raise ValueError('Invalid RECORD SHA256 length')
        result[name] = {'bytes': int(row[2]), 'sha256': digest.hex()}
    return result


def inspect_wheel(path, name, pin):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or path.stat().st_size != pin['bytes'] or checksum(path) != pin['sha256']:
        raise ValueError(f'Official CPU wheel SHA/size mismatch: {name}')
    dist_info = f'{name}-{pin["version"]}.dist-info'
    record_name = dist_info + '/RECORD'
    with zipfile.ZipFile(path) as package:
        entries, names = {}, set()
        for entry in package.infolist():
            filename = portable_name(entry.filename[:-1] if entry.is_dir() else entry.filename)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if filename.casefold() in names or entry.flag_bits & 1 or mode not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('Unsafe, duplicate or encrypted CPU wheel entry')
            names.add(filename.casefold())
            if entry.is_dir():
                if entry.file_size:
                    raise ValueError('Non-empty wheel directory')
                continue
            if '.data' in filename.split('/')[0]:
                raise ValueError('This pinned builder does not relocate wheel .data schemes')
            entries[filename] = entry
        for required in [record_name, dist_info + '/METADATA', dist_info + '/WHEEL']:
            if required not in entries or entries[required].file_size > 4 * 1024 * 1024:
                raise ValueError('Missing or oversized wheel distribution metadata')
        metadata = email.message_from_bytes(package.read(dist_info + '/METADATA'))
        wheel = email.message_from_bytes(package.read(dist_info + '/WHEEL'))
        if metadata['Name'].lower().replace('-', '_') != name or metadata['Version'] != pin['version'] or wheel.get_all('Tag') != ['cp312-cp312-win_amd64'] or wheel['Root-Is-Purelib'] != 'false':
            raise ValueError('CPU wheel identity/ABI mismatch')
        records = parse_record(package.read(record_name), record_name)
        if set(records) != set(entries):
            raise ValueError('CPU wheel RECORD does not cover its complete archive')
        for filename, expected in records.items():
            if expected is not None and expected['bytes'] != entries[filename].file_size:
                raise ValueError('CPU wheel RECORD size mismatch')
    return {'path': path, 'distInfo': dist_info, 'records': records,
            'files': len(entries), 'bytes': sum(entry.file_size for entry in entries.values())}


def distribution_files(base, inventory, name, old_version):
    record_path = f'{SITE}{name}-{old_version}.dist-info/RECORD'
    if record_path not in inventory:
        raise ValueError(f'Missing original distribution RECORD: {name}')
    result = set()
    for row in csv.reader(io.StringIO((base / record_path).read_text(encoding='utf-8'))):
        if len(row) != 3:
            raise ValueError('Invalid original distribution RECORD')
        name_in_record = row[0].replace('\\', '/')
        if name_in_record.startswith('../../Scripts/'):
            continue  # The original portable bundle excludes environment console wrappers.
        path = portable_name(name_in_record)
        if '__pycache__' in path.split('/') or path.endswith(('.pyc', '.pyo')):
            continue
        target = SITE + path
        if target not in inventory:
            raise ValueError(f'Original recorded package file is absent: {target}')
        result.add(target)
    if not result or record_path not in result:
        raise ValueError('Original distribution inventory is incomplete')
    return result


def copy_verified(writer, base, entry):
    writer.copy(base / entry['path'], entry['path'])
    if writer.files[entry['path'].casefold()] != entry:
        raise ValueError(f'Original file changed after verification: {entry["path"]}')


def write_wheel(writer, name, pin, inspected):
    path = inspected['path']
    # Recheck before extraction; never trust a mutable sidecar verified-wheels.json.
    before = path.stat()
    if before.st_size != pin['bytes'] or checksum(path) != pin['sha256']:
        raise ValueError('CPU wheel changed after inspection')
    with zipfile.ZipFile(path) as package:
        for relative, expected in inspected['records'].items():
            output_name = SITE + relative
            if output_name.casefold() in writer.files:
                raise ValueError('Replacement wheel collides with a retained distribution')
            entry = package.getinfo(relative)
            _, target = writer.target(output_name)
            digest, size = hashlib.sha256(), 0
            with package.open(entry) as source, target.open('xb') as output:
                for block in iter(lambda: source.read(BLOCK), b''):
                    size += len(block)
                    if size > entry.file_size:
                        raise ValueError('CPU wheel expanded beyond its declared size')
                    output.write(block)
                    digest.update(block)
            actual = {'path': output_name, 'bytes': size, 'sha256': digest.hexdigest()}
            if size != entry.file_size or (expected is not None and (size != expected['bytes'] or actual['sha256'] != expected['sha256'])):
                raise ValueError(f'CPU wheel file RECORD checksum mismatch: {name}/{relative}')
            writer.files[output_name.casefold()] = actual
            writer.bytes += size
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('CPU wheel changed during extraction')


def build_cpu_component(base, wheel_directory, output, version, engine='both', archive=None,
                        *, base_manifest_sha256=BASE_MANIFEST_SHA256, wheel_pins=CPU_WHEELS,
                        cpu_lock=None, evaluation_lock=None):
    """Injectable small synthetic pins are for tests; the CLI never accepts them."""
    base, wheel_directory, output = Path(base).resolve(strict=True), Path(wheel_directory).resolve(strict=True), Path(output).resolve()
    if engine not in ENGINE_ROLES or not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+-]{0,99}', version):
        raise ValueError('Invalid component version or engine')
    if output.exists() or any(output == root or output.is_relative_to(root) or root.is_relative_to(output) for root in [base, wheel_directory]):
        raise ValueError('CPU component output must be new and separate from all inputs')
    if archive is not None:
        archive = Path(archive).resolve()
        if archive.exists() or archive.with_name(archive.name + '.partial').exists() or archive.is_relative_to(output) or any(archive.is_relative_to(root) for root in [base, wheel_directory]):
            raise ValueError('CPU archive must be new and outside input/output directories')
    directory = Path(__file__).resolve().parent
    cpu_lock = Path(cpu_lock or directory / 'requirements-cpu.txt')
    evaluation_lock = Path(evaluation_lock or directory / 'requirements-evaluation.txt')
    manifest_path = base / 'bundle-manifest.json'
    if checksum(manifest_path) != base_manifest_sha256:
        raise ValueError('Original bundle manifest is not the trusted pinned base')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('platform') != 'win-amd64' or manifest.get('packages') != requirements(evaluation_lock):
        raise ValueError('Original runtime package lock does not match the evaluated base')
    expected_versions = {**manifest['packages'], **{name: pin['version'] for name, pin in wheel_pins.items()}}
    if requirements(cpu_lock) != expected_versions:
        raise ValueError('CPU lock must change exactly the three pinned package versions')
    inventory, names = {}, set()
    for entry in manifest['files']:
        path = portable_name(entry['path'])
        if path.casefold() in names:
            raise ValueError('Original manifest has aliased files')
        names.add(path.casefold())
        inventory[path] = entry
    print('Verifying every original component file; no model is loaded', flush=True)
    original_verified = verify_bundle(base)
    removed, distributions = set(), []
    for name, pin in wheel_pins.items():
        if manifest['packages'].get(name) != pin['oldVersion']:
            raise ValueError('Original distribution version mismatch')
        owned = distribution_files(base, inventory, name, pin['oldVersion'])
        if removed & owned:
            raise ValueError('Original replacement distributions overlap')
        removed.update(owned)
        distributions.append({'name': name, 'oldVersion': pin['oldVersion'], 'files': len(owned),
                              'bytes': sum(inventory[path]['bytes'] for path in owned)})
    inspected = {}
    for name, pin in wheel_pins.items():
        print(f'Verifying official CPU wheel {name}', flush=True)
        inspected[name] = inspect_wheel(wheel_directory / pin['filename'], name, pin)
    roles = ENGINE_ROLES[engine]
    source_models = json.loads((base / 'models.json').read_text(encoding='utf-8'))
    if source_models.get('version') != 1 or not isinstance(source_models.get('models'), dict):
        raise ValueError('Invalid original model manifest')
    models = {}
    for role in roles:
        model = source_models['models'].get(role)
        if not isinstance(model, dict) or set(model) != {'repository', 'revision', 'path'} or model['path'] != f'models/{role}':
            raise ValueError('Original model identity/path mismatch')
        models[role] = dict(model)
    selected = [entry for entry in manifest['files'] if entry['path'] not in removed
                and entry['path'] not in REGENERATED
                and (not entry['path'].startswith('models/') or entry['path'].split('/')[1] in roles)]
    estimated = sum(entry['bytes'] for entry in selected) + sum(info['bytes'] for info in inspected.values())
    # ZIP may compress poorly; reserve the full payload again when requested.
    if shutil.disk_usage(output.parent).free < estimated * (2 if archive is not None else 1) + 64 * 1024 * 1024:
        raise ValueError('Insufficient free space for the independent CPU component')
    writer = BundleWriter(output)
    try:
        for entry in selected:
            copy_verified(writer, base, entry)
        for name, pin in wheel_pins.items():
            print(f'Copying complete official CPU wheel {name}', flush=True)
            write_wheel(writer, name, pin, inspected[name])
        wheel_sources = []
        for name, pin in wheel_pins.items():
            filename = pin['filename'].replace('+', '%2B')
            wheel_sources.append({'name': name, 'version': pin['version'], 'filename': pin['filename'],
                                  'bytes': pin['bytes'], 'sha256': pin['sha256'],
                                  'index': f'https://download.pytorch.org/whl/cpu/{name}/',
                                  'url': f'https://download-r2.pytorch.org/whl/cpu/{filename}#sha256={pin["sha256"]}'})
        resource_profile = {'version': 1, 'componentVersion': version, 'baseComponentVersion': BASE_VERSION,
                            'devices': ['cpu'], 'engines': ['paraformer', 'whisperx'] if engine == 'both' else [engine],
                            'runtime': 'official-pytorch-cpu-complete-wheels-v1', 'baseManifestSha256': base_manifest_sha256,
                            'cpuWheels': wheel_sources}
        writer.json('runtime-profile.json', resource_profile)
        if (base / 'component-security.json').is_file():
            security = json.loads((base / 'component-security.json').read_text(encoding='utf-8'))
            security['componentVersion'] = version
            writer.json('component-security.json', security)
        writer.json('build-provenance.json', {**resource_profile, 'builtAt': datetime.now(timezone.utc).isoformat(),
                    'originalVerified': original_verified, 'removedDistributions': distributions,
                    'builderSha256': checksum(__file__), 'cpuLockSha256': checksum(cpu_lock)})
        writer.copy(cpu_lock, 'dependency-versions.txt')
        writer.write('README.txt', '听读离线 CPU 转写组件（Windows x64 / Python 3.12）\n\n'
                     f'组件版本 {version}，基于已校验的 {BASE_VERSION} 完整组件。只支持 CPU，不支持 CUDA。\n'
                     'Torch、Torchaudio、Torchvision 完整替换为固定版本官方 CPU wheels；其余依赖版本保持原样。\n'
                     '保留 wheel 的许可证、原生库与静态 .lib 文件；全部模型版本约 9.16 GB，未声称是极小运行时。\n'
                     '选择 component.json 配置；任务期间不下载模型。公开组件更新源尚未配置。\n'
                     '请保留模型、依赖许可证与 runtime-profile.json 来源记录。\n')
        completed = writer.finish(manifest['python'], expected_versions, models)
        print('Verifying the complete new CPU component', flush=True)
        verified = verify_bundle(output)
        report = {'status': 'built', 'componentVersion': version, 'baseVersion': BASE_VERSION,
                  'output': str(output), 'engine': engine, 'devices': ['cpu'], 'files': verified['files'],
                  'bytes': verified['bytes'], 'baseManifestSha256': base_manifest_sha256,
                  'manifestSha256': checksum(output / 'bundle-manifest.json'),
                  'packages': completed['packages'], 'removedDistributions': distributions,
                  'cpuWheels': wheel_sources, 'builderSha256': checksum(__file__), 'cpuLockSha256': checksum(cpu_lock)}
        if archive is not None:
            print('Creating the independent CPU ZIP64 archive', flush=True)
            report['archive'] = archive_bundle(output, archive)
        return report
    except BaseException:
        # Never leave a failed output looking like a complete install candidate.
        (output / 'BUILDING.json').write_text('{"complete":false,"failed":true}\n', encoding='utf-8')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    parser.add_argument('--wheels', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--engine', choices=list(ENGINE_ROLES), default='both')
    parser.add_argument('--archive')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    report_path = Path(args.report).resolve()
    if report_path.exists() or not report_path.parent.is_dir():
        raise ValueError('Build report target must be new')
    report = build_cpu_component(args.base, args.wheels, args.output, args.version, args.engine, args.archive)
    with report_path.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
