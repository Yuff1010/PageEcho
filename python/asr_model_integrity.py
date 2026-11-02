"""Verify publisher-pinned model bytes before passing them to native loaders.

This blocks substituted model/config files. It is not a sandbox for vulnerable
frameworks or a guarantee against a malicious process running as the same user.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat


def verify_file(target, pin_file, label):
    if not isinstance(pin_file, dict) or type(pin_file.get('bytes')) is not int or pin_file['bytes'] <= 0 \
            or not re.fullmatch(r'[0-9a-f]{64}', str(pin_file.get('sha256', ''))):
        raise ValueError('模型校验记录无效。')
    before = target.stat()
    identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    if not stat.S_ISREG(before.st_mode) or before.st_size != pin_file['bytes']:
        raise ValueError(f'{label} 模型大小与发布方不符。')
    with target.open('rb') as stream:
        handle_before = os.fstat(stream.fileno())
        if identity(handle_before) != identity(before):
            raise ValueError('模型文件在打开时已变化。')
        digest = hashlib.sha256()
        size = 0
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            size += len(block)
            if size > pin_file['bytes']:
                raise ValueError('模型文件在校验过程中增长。')
            digest.update(block)
        after = os.fstat(stream.fileno())
    path_after = target.stat()
    # Windows path stat and fstat have different ctime semantics. Compare ctime
    # only within one API, while always hashing all bytes and checking identity.
    if identity(before) != identity(after) or identity(path_after) != identity(before) \
            or handle_before.st_ctime_ns != after.st_ctime_ns or before.st_ctime_ns != path_after.st_ctime_ns \
            or size != pin_file['bytes'] or digest.hexdigest() != pin_file['sha256']:
        raise ValueError(f'{label} 模型校验失败，已停止加载，请重新安装组件。')


def verify_model_integrity(models, roles, manifest_path=None, runtime_root=None):
    path = Path(manifest_path) if manifest_path else Path(__file__).with_name('asr-model-integrity.json')
    if path.stat().st_size > 128 * 1024:
        raise ValueError('模型校验清单过大，请重新安装完整主程序。')
    encoded = path.read_bytes()
    expected = json.loads(encoded)
    if expected.get('version') != 1 or not isinstance(expected.get('models'), dict):
        raise ValueError('模型校验清单无效，请重新安装完整主程序。')
    for role in roles:
        pin, model = expected['models'].get(role), models.get(role)
        if not isinstance(pin, dict) or not isinstance(model, dict) or any(
                model.get(key) != pin.get(key) for key in ('repository', 'revision')):
            raise ValueError(f'{role} 模型身份与发布方固定版本不符。')
        files = pin.get('files')
        if not isinstance(files, dict) or not 1 <= len(files) <= 128:
            raise ValueError('模型校验清单无效。')
        root = Path(model.get('path', '')).resolve(strict=True)
        if not root.is_dir():
            raise ValueError(f'{role} 模型目录缺失。')
        names = list(root.iterdir())
        if len(names) != len(files) or {entry.name for entry in names} != set(files):
            raise ValueError(f'{role} 模型包含缺失或未经发布方固定的文件，请重新安装组件。')
        for name, pin_file in files.items():
            if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or name in ('.', '..'):
                raise ValueError('模型校验路径无效。')
            # HF snapshots may use ordinary file links to their immutable blob
            # store; the resolved bytes still need the publisher's full digest.
            verify_file(root / name, pin_file, f'{role}/{name}')
    if 'whisper' in roles:
        # Pyannote loads this bundled pickle checkpoint outside models/*. Check
        # the actual interpreter's site directory before importing WhisperX.
        name = 'whisperx/assets/pytorch_model.bin'
        assets = expected.get('runtimeFiles')
        if not isinstance(assets, dict) or set(assets) != {name}:
            raise ValueError('缺少内置 VAD 模型的发布方校验记录。')
        if runtime_root:
            runtime = Path(runtime_root)
        else:
            spec = importlib.util.find_spec('whisperx')
            if not spec or not spec.origin:
                raise ValueError('找不到 WhisperX 内置 VAD 模型。')
            runtime = Path(spec.origin).resolve(strict=True).parent.parent
        verify_file(runtime / name, assets[name], 'WhisperX VAD')
    return hashlib.sha256(encoded).hexdigest()
