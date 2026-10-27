"""Developer-side builder. End users only extract the component and select component.json."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from component_bundle import BundleWriter, archive_bundle, requirements
from asr_runtime import load_local_models


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', required=True)
    parser.add_argument('--python-zip', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--archive')
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    source = json.loads((directory / 'embedded-python.json').read_text(encoding='utf-8'))
    if sys.version.split()[0] != source['version'] or sys.platform != 'win32' or platform.machine().upper() != 'AMD64':
        raise ValueError('Build with the evaluated Windows x64 Python 3.12.10 environment')
    config_path = Path(args.component).resolve(strict=True)
    config = json.loads(config_path.read_text(encoding='utf-8'))
    paths = {key: (config_path.parent / config[key]).resolve(strict=True)
             for key in ['python', 'models', 'ffmpeg', 'ffprobe', 'cache' if config['version'] == 1 else 'resources']}
    if paths['python'] != Path(sys.executable).resolve():
        raise ValueError('Use the interpreter specified by the prepared component')
    lock = requirements(directory / 'requirements-evaluation.txt')
    models = load_local_models(paths['models'])
    pins = json.loads((directory / 'evaluation-models.json').read_text(encoding='utf-8'))['models']
    for name, pin in pins.items():
        model = models.get(name, {})
        if model.get('repository') != pin['repository'] or model.get('revision') != pin['revision'] or not Path(model.get('path', '')).is_dir():
            raise ValueError(f'Prepare the pinned local model first: {name}')
    output = Path(args.output).resolve()
    sources = [Path(sys.prefix).resolve(), paths['cache' if config['version'] == 1 else 'resources'],
               *[Path(model['path']) for model in models.values()]]
    if any(output == root or output.is_relative_to(root) for root in sources):
        raise ValueError('Component output must be separate from its input environment and models')
    writer = BundleWriter(output)
    writer.embedded_python(args.python_zip, source)
    print('Vendoring the exact evaluated dependency versions', flush=True)
    versions = writer.vendor_packages(lock)
    portable_models = {}
    for name, pin in pins.items():
        print(f'Copying model {name}', flush=True)
        writer.model(models[name]['path'], name)
        portable_models[name] = {**pin, 'path': 'models/' + name}
    resource_root = paths['cache' if config['version'] == 1 else 'resources']
    for name in ['abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt']:
        writer.copy(resource_root / 'nltk/tokenizers/punkt_tab/english' / name,
                    'resources/nltk/tokenizers/punkt_tab/english/' + name)
    for name in ['ffmpeg', 'ffprobe']:
        writer.copy(paths[name], f'tools/{name}.exe')
    tools_root = paths['ffmpeg'].parent.parent
    for name in ['LICENSE', 'README.txt']:
        if (tools_root / name).is_file():
            writer.copy(tools_root / name, 'tools/' + name)
    writer.copy(directory / 'requirements-evaluation.txt', 'dependency-versions.txt')
    writer.copy(directory / 'evaluation-models.json', 'model-revisions.json')
    writer.write('README.txt', '听读可选转写组件（Windows x64）\n\n解压整个文件夹后，在听读的“缓存与任务 → 选择组件配置”选择本目录的 component.json。\n无需安装 Python、Node.js、pip 或激活虚拟环境。普通播放不需要此组件。\n模型和程序资源保留在这里，任务缓存写入应用用户数据目录。任务期间不下载模型。\n移动文件夹后请重新选择配置。CPU 可直接选择；GPU 需要兼容的 NVIDIA 驱动。\n请保留依赖随附的许可证和模型说明。\n')
    manifest = writer.finish(source, versions, portable_models)
    report = {'status': 'built', 'createdAt': datetime.now(timezone.utc).isoformat(),
              'directory': str(output), 'files': len(manifest['files']), 'bytes': manifest['bytes']}
    if args.archive:
        print('Creating the separate optional ZIP64 component archive', flush=True)
        report['archive'] = archive_bundle(output, args.archive)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
