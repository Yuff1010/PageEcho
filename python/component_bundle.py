"""Build a relocatable optional ASR component, never a copied virtual environment."""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import time
import zipfile


BLOCK = 4 * 1024 * 1024


def checksum(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(BLOCK), b''):
            result.update(block)
    return result.hexdigest()


def safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or '\0' in value:
        raise ValueError('Invalid package path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('..', '.') for part in value.split('/')):
        raise ValueError('Package path escapes its root')
    return path


def requirements(path):
    packages = {}
    for raw in Path(path).read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or line.startswith('--extra-index-url '):
            continue
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s;]+)', line)
        if not match:
            raise ValueError(f'Unpinned requirement: {line}')
        name, version = match.groups()
        key = re.sub(r'[-_.]+', '-', name).lower()
        if key in packages:
            raise ValueError('Duplicate requirement')
        packages[key] = version
    return packages


class BundleWriter:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=False)
        self.files = {}
        self.bytes = 0
        self.last_progress = time.monotonic()
        (self.root / 'BUILDING.json').write_text('{"complete":false}', encoding='utf-8')

    def target(self, relative):
        name = safe_relative(relative).as_posix()
        target = self.root.joinpath(*PurePosixPath(name).parts)
        if not target.is_relative_to(self.root):
            raise ValueError('Invalid target')
        target.parent.mkdir(parents=True, exist_ok=True)
        return name, target

    def copy(self, source, relative):
        name, target = self.target(relative)
        if name.casefold() in self.files:
            return
        source = Path(source).resolve(strict=True)
        before = source.stat()
        if not source.is_file():
            raise ValueError('Bundle input must be a regular file')
        digest, size = hashlib.sha256(), 0
        with source.open('rb') as reader, target.open('xb') as writer:
            for block in iter(lambda: reader.read(BLOCK), b''):
                writer.write(block)
                digest.update(block)
                size += len(block)
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != before.st_size:
            raise ValueError('Bundle source changed while copying')
        self.files[name.casefold()] = {'path': name, 'bytes': size, 'sha256': digest.hexdigest()}
        self.bytes += size
        if time.monotonic() - self.last_progress > 5:
            print(f'Copied {len(self.files)} files, {self.bytes / 1024 ** 3:.2f} GiB', flush=True)
            self.last_progress = time.monotonic()

    def write(self, relative, content):
        name, target = self.target(relative)
        encoded = content.encode('utf-8')
        target.write_bytes(encoded)
        previous = self.files.get(name.casefold(), {}).get('bytes', 0)
        self.files[name.casefold()] = {'path': name, 'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()}
        self.bytes += len(encoded) - previous

    def json(self, relative, value):
        self.write(relative, json.dumps(value, ensure_ascii=False, indent=2) + '\n')

    def embedded_python(self, archive, source):
        if checksum(archive) != source['sha256']:
            raise ValueError('Embedded Python archive checksum does not match the pinned official artifact')
        with zipfile.ZipFile(archive) as package:
            for item in package.infolist():
                name = safe_relative(item.filename.rstrip('/'))
                if item.is_dir():
                    continue
                relative = 'python/' + name.as_posix()
                key, target = self.target(relative)
                with package.open(item) as reader, target.open('xb') as writer:
                    digest, size = hashlib.sha256(), 0
                    for block in iter(lambda: reader.read(BLOCK), b''):
                        writer.write(block)
                        digest.update(block)
                        size += len(block)
                self.files[key.casefold()] = {'path': key, 'bytes': size, 'sha256': digest.hexdigest()}
                self.bytes += size
        self.write('python/python312._pth', 'python312.zip\n.\nLib/site-packages\nimport site\n')

    def vendor_packages(self, lock):
        site = (Path(sys.prefix) / 'Lib/site-packages').resolve(strict=True)
        installed = {}
        for name, version in lock.items():
            distribution = importlib.metadata.distribution(name)
            if distribution.version != version:
                raise ValueError(f'Package version mismatch: {name} expected {version}, found {distribution.version}')
            base = Path(distribution.locate_file('')).resolve()
            if base != site:
                raise ValueError(f'Package is outside the selected environment: {name}')
            if distribution.files is None:
                raise ValueError(f'Missing installed file inventory: {name}')
            installed[name] = version
            for entry in distribution.files:
                source = Path(distribution.locate_file(entry)).resolve()
                if not source.is_relative_to(site):
                    # Console entry points embed developer-environment paths and are not used by the app.
                    continue
                relative = source.relative_to(site)
                if '__pycache__' in relative.parts or source.suffix in ('.pyc', '.pyo'):
                    continue
                self.copy(source, 'python/Lib/site-packages/' + relative.as_posix())
        return installed

    def model(self, source, name):
        source = Path(source).resolve(strict=True)
        if not source.is_dir():
            raise ValueError(f'Missing model: {name}')
        for folder, directories, files in os.walk(source, followlinks=False):
            if any((Path(folder) / child).is_symlink() for child in directories):
                raise ValueError('Linked model directories are not portable')
            for filename in sorted(files):
                path = Path(folder) / filename
                relative = path.relative_to(source)
                # HF snapshot files can be links to its blob store; copy bytes, never package links.
                self.copy(path, 'models/' + name + '/' + relative.as_posix())

    def finish(self, source, versions, models):
        self.json('component.json', {'version': 2, 'python': 'python/python.exe', 'models': 'models.json',
                                    'resources': 'resources', 'ffmpeg': 'tools/ffmpeg.exe', 'ffprobe': 'tools/ffprobe.exe'})
        self.json('models.json', {'version': 1, 'models': models})
        inventory = {'version': 1, 'platform': 'win-amd64', 'python': source, 'packages': versions,
                     'files': sorted(self.files.values(), key=lambda entry: entry['path']),
                     'bytes': self.bytes, 'complete': True}
        (self.root / 'bundle-manifest.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (self.root / 'BUILDING.json').unlink()
        return inventory


def verify_bundle(root):
    root = Path(root).resolve(strict=True)
    if (root / 'BUILDING.json').exists():
        raise ValueError('Incomplete component bundle')
    manifest = json.loads((root / 'bundle-manifest.json').read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or manifest.get('complete') is not True:
        raise ValueError('Invalid bundle manifest')
    expected, size = set(), 0
    for entry in manifest['files']:
        relative = safe_relative(entry['path'])
        target = root.joinpath(*relative.parts)
        if entry['path'].casefold() in expected or not target.resolve().is_relative_to(root) or target.is_symlink():
            raise ValueError('Invalid or linked bundle file')
        expected.add(entry['path'].casefold())
        if target.stat().st_size != entry['bytes'] or checksum(target) != entry['sha256']:
            raise ValueError(f'Component file checksum mismatch: {entry["path"]}')
        size += entry['bytes']
    actual = set()
    for folder, directories, files in os.walk(root, followlinks=False):
        if any((Path(folder) / child).is_symlink() for child in directories):
            raise ValueError('Linked bundle directory')
        for name in files:
            relative = (Path(folder) / name).relative_to(root).as_posix()
            if relative != 'bundle-manifest.json':
                actual.add(relative.casefold())
    if actual != expected or size != manifest['bytes']:
        raise ValueError('Unexpected or missing component files')
    return {'files': len(expected), 'bytes': size}


def archive_bundle(root, target):
    root, target = Path(root).resolve(), Path(target).resolve()
    if target.exists() or target.is_relative_to(root):
        raise ValueError('Archive target must be new and outside the component directory')
    # All assets were verified while copied; zipfile supplies per-entry CRC, plus an archive SHA below.
    temporary = target.with_name(target.name + '.partial')
    with zipfile.ZipFile(temporary, 'x', zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as package:
        for folder, directories, files in os.walk(root):
            directories.sort()
            for name in sorted(files):
                path = Path(folder) / name
                package.write(path, path.relative_to(root).as_posix())
    temporary.rename(target)
    return {'path': str(target), 'bytes': target.stat().st_size, 'sha256': checksum(target)}
