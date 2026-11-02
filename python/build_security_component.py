"""Patch publisher-pinned optional bundles into new directories; never modify inputs."""

import argparse
import base64
import csv
import email
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import stat
import zipfile

from component_bundle import BundleWriter, archive_bundle, checksum, requirements, verify_bundle
from build_cpu_component import copy_verified, distribution_files, portable_name, SITE, write_wheel


def inspect_patch_wheel(path, pin):
    path = Path(path).resolve(strict=True)
    if path.stat().st_size != pin['bytes'] or checksum(path) != pin['sha256']:
        raise ValueError('Patch wheel does not match the publisher-pinned official bytes')
    with zipfile.ZipFile(path) as package:
        entries, folded, total = {}, set(), 0
        for item in package.infolist():
            name = portable_name(item.filename.rstrip('/'))
            mode = stat.S_IFMT(item.external_attr >> 16)
            if name.casefold() in folded or item.flag_bits & 1 or mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('Duplicate, linked or encrypted patch wheel entry')
            folded.add(name.casefold())
            if item.is_dir():
                continue
            if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or '.data' in name.split('/')[0]:
                raise ValueError('Unsupported patch wheel layout')
            total += item.file_size
            if item.file_size > 128 * 1024**2 or total > 256 * 1024**2 or len(entries) > 100000:
                raise ValueError('Patch wheel exceeds bounded extraction limits')
            entries[name] = item
        metadata_names = [name for name in entries if name.count('/') == 1 and name.endswith('.dist-info/METADATA')]
        if len(metadata_names) != 1:
            raise ValueError('Patch wheel needs one distribution')
        dist_info = metadata_names[0].rsplit('/', 1)[0]
        record_name = dist_info + '/RECORD'
        for name in [metadata_names[0], dist_info + '/WHEEL', record_name]:
            if name not in entries or entries[name].file_size > 4 * 1024**2:
                raise ValueError('Missing or oversized patch wheel metadata')
        metadata = email.message_from_bytes(package.read(metadata_names[0]))
        wheel = email.message_from_bytes(package.read(dist_info + '/WHEEL'))
        canonical = lambda name: re.sub(r'[-_.]+', '-', name).lower()
        if canonical(metadata['Name']) != pin['name'] or metadata['Version'] != pin['version']:
            raise ValueError('Patch wheel package/version mismatch')
        tags = set(wheel.get_all('Tag', []))
        if not tags or not tags <= {'py3-none-any', 'py2-none-any', 'cp312-cp312-win_amd64'}:
            raise ValueError('Patch wheel is not compatible with the pinned Windows Python ABI')
        records = {}
        for row in csv.reader(io.StringIO(package.read(record_name).decode('utf-8'))):
            if len(row) != 3:
                raise ValueError('Invalid patch RECORD')
            name = portable_name(row[0].replace('\\', '/'))
            if name in records:
                raise ValueError('Duplicate patch RECORD path')
            if name == record_name:
                if row[1] or row[2]:
                    raise ValueError('RECORD cannot hash itself')
                records[name] = None
            else:
                if not row[1].startswith('sha256=') or not row[2].isdigit():
                    raise ValueError('Patch file needs SHA256 and size')
                encoded = row[1][7:]
                digest = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
                if len(digest) != 32:
                    raise ValueError('Invalid patch file digest')
                records[name] = {'bytes': int(row[2]), 'sha256': digest.hex()}
        if set(records) != set(entries):
            raise ValueError('Patch RECORD must cover every archive file')
        for name, record in records.items():
            if record is not None and entries[name].file_size != record['bytes']:
                raise ValueError('Patch RECORD size mismatch')
    return {'path': path, 'distInfo': dist_info, 'records': records, 'bytes': total, 'files': len(entries)}


def build_security_component(base, wheels, output, version, archive=None, *, pins=None, lock=None):
    source = Path(__file__).resolve().parent
    pins = pins or json.loads((source / 'security-component-wheels.json').read_text(encoding='utf-8'))
    base, wheels, output = Path(base).resolve(strict=True), Path(wheels).resolve(strict=True), Path(output).resolve()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+-]{0,99}', version):
        raise ValueError('Invalid new component version')
    if output.exists() or any(output == root or output.is_relative_to(root) or root.is_relative_to(output) for root in (base, wheels)):
        raise ValueError('Output must be new and separate from every input')
    if archive is not None:
        archive = Path(archive).resolve()
        if archive.exists() or archive.with_name(archive.name + '.partial').exists() or any(archive.is_relative_to(root) for root in (base, wheels, output)):
            raise ValueError('Archive must be new and outside input/output directories')
    manifest_hash = checksum(base / 'bundle-manifest.json')
    trusted = next((item for item in pins['bases'] if item['manifestSha256'] == manifest_hash), None)
    if trusted is None:
        raise ValueError('Component manifest is not a publisher-pinned base')
    manifest = json.loads((base / 'bundle-manifest.json').read_text(encoding='utf-8'))
    expected = dict(manifest['packages'])
    inventory = {entry['path']: entry for entry in manifest['files']}
    if len(inventory) != len(manifest['files']):
        raise ValueError('Duplicate base manifest paths')
    removed, inspected = set(), {}
    for pin in pins['wheels']:
        name = pin['name']
        if expected.get(name) != pin['oldVersion']:
            raise ValueError(f'Unrecognized original dependency: {name}')
        owned = distribution_files(base, inventory, name.replace('-', '_'), pin['oldVersion'])
        if removed & owned:
            raise ValueError('Replacement distributions overlap')
        removed.update(owned)
        expected[name] = pin['version']
        inspected[name] = inspect_patch_wheel(wheels / pin['filename'], pin)
    lock = Path(lock or source / ('requirements-cpu.txt' if trusted['profile'] == 'cpu' else 'requirements-evaluation.txt'))
    if requirements(lock) != expected:
        raise ValueError('Current lock must differ from the trusted base by exactly the approved security patches')
    print('Verifying the complete trusted input; models and old environments remain read-only', flush=True)
    verify_bundle(base)
    skip = removed | {'README.txt', 'dependency-versions.txt', 'component-security.json', 'runtime-profile.json'}
    retained = [entry for entry in manifest['files'] if entry['path'] not in skip]
    needed = sum(entry['bytes'] for entry in retained) + sum(item['bytes'] for item in inspected.values())
    output.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output.parent).free < needed * (2 if archive else 1) + 64 * 1024**2:
        raise ValueError('Insufficient free space for a separate patched component')
    writer = BundleWriter(output)
    for entry in retained:
        copy_verified(writer, base, entry)
    for pin in pins['wheels']:
        write_wheel(writer, pin['name'], pin, inspected[pin['name']])
    if 'runtime-profile.json' in inventory:
        profile = json.loads((base / 'runtime-profile.json').read_text(encoding='utf-8'))
        profile['securityPatchBaseComponentVersion'] = profile.get('componentVersion')
        profile['componentVersion'] = version
        writer.json('runtime-profile.json', profile)
    writer.copy(lock, 'dependency-versions.txt')
    writer.json('component-security.json', {
        'version': 1, 'componentVersion': version, 'baseId': trusted['id'],
        'baseManifestSha256': manifest_hash, 'patchedPackages': {item['name']: item['version'] for item in pins['wheels']},
        'remainingScope': 'Torch and Transformers engine-family advisories remain; only publisher-pinned model bytes may be loaded. This patch set is not a security certificate.'})
    writer.write('README.txt', f'听见书页 · PageEcho 可选转写组件 {version}\n\n从应用中选择 component.json，或按可信 ZIP 安装并检查后启用。\n安全更新了5项兼容依赖，原模型和其他依赖保持固定。普通播放不需要模型组件。\nTorch/Transformers 仍有待兼容升级的安全告警；不要使用未经发布方固定并校验的模型。\n保留整个目录和第三方许可，不修改原组件。\n')
    models = json.loads((base / 'models.json').read_text(encoding='utf-8'))['models']
    final = writer.finish(manifest['python'], expected, models)
    verified = verify_bundle(output)
    result = {'status': 'built-and-verified', 'version': version, 'profile': trusted['profile'],
              'output': str(output), 'manifestSha256': checksum(output / 'bundle-manifest.json'),
              'files': len(final['files']), 'bytes': verified['bytes'], 'baseUnchanged': checksum(base / 'bundle-manifest.json') == manifest_hash}
    if archive:
        result['archive'] = archive_bundle(output, archive)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('base', 'wheels', 'output', 'version'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--archive')
    args = parser.parse_args()
    print(json.dumps(build_security_component(args.base, args.wheels, args.output, args.version, args.archive), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
