"""Offline component patch floor; this is not a complete vulnerability scanner."""

import importlib.metadata
import re


# These compatible patches were checked against the pinned engine dependency tree.
# Torch/Transformers engine-family advisories are tracked separately in the audit.
SECURITY_BASELINE = {
    'filelock': '4.2.1',
    'hydra-core': '1.3.8',
    'nltk': '3.10.4',
    'pillow': '13.0.0',
    'setuptools': '84.1.0',
}
SECURITY_CONTRACT = 'compatible-component-patch-floor-2026-11-02-v1'


def stable_version(value):
    # Reject prereleases/unknown forms instead of accidentally accepting a lower
    # security baseline. A local wheel tag or stable postrelease is permitted.
    if len(value) > 128:
        return None
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:\.post\d+)?(?:\+[A-Za-z0-9._-]+)?', value)
    return tuple(map(int, match.groups())) if match else None


def component_security_issues(version_reader=None):
    read_version = version_reader or importlib.metadata.version
    issues = []
    for name, minimum in SECURITY_BASELINE.items():
        try:
            installed = read_version(name)
        except importlib.metadata.PackageNotFoundError:
            issues.append(f'转写组件缺少 {name} 版本信息，请安装完整的安全更新组件。')
            continue
        except Exception:
            issues.append(f'无法核对转写组件 {name} 的版本，请重新检查完整组件。')
            continue
        parsed = stable_version(installed) if isinstance(installed, str) else None
        if parsed is None or parsed < stable_version(minimum):
            shown = str(installed)[:80]
            issues.append(f'转写组件 {name} 需要安全更新（当前 {shown}，至少 {minimum}）；请安装新版组件，普通播放仍可使用。')
    return issues
