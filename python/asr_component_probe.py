"""Offline, bounded prerequisite check. Does not load weights or run inference."""

import argparse
import contextlib
import importlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_runtime import configure_cache, configure_offline_network, load_local_models, protect_worker_process


MODEL_FILES = {
    'paraformer': ['model.pt', 'config.yaml', 'configuration.json', 'am.mvn', 'tokens.json', 'seg_dict'],
    'vad': ['model.pt', 'config.yaml', 'configuration.json', 'am.mvn'],
    'punctuation': ['model.pt', 'config.yaml', 'configuration.json', 'tokens.json'],
    'whisper': ['model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json', 'vocabulary.json'],
    'alignment': ['config.json', 'preprocessor_config.json', 'vocab.json', 'special_tokens_map.json'],
}


def unavailable(result, problems):
    result['issues'].extend(problems)
    result['capabilities'] = [
        {'engine': engine, 'device': device, 'available': False, 'message': '；'.join(problems)[:950]}
        for engine in ['whisperx', 'paraformer'] for device in ['cpu', 'cuda']
    ]
    result['ready'] = False
    return result


def check(args):
    protect_worker_process()
    configure_offline_network()
    issues, common = [], []
    result = {
        'level': 'imports-and-files', 'pythonVersion': platform.python_version(),
        'cudaName': None, 'freeBytes': None, 'issues': issues, 'capabilities': [],
    }
    try:
        cache = configure_cache(args.cache, str(Path(args.ffmpeg).parent), args.resources)
        result['freeBytes'] = shutil.disk_usage(cache).free
        with tempfile.TemporaryFile(dir=cache) as handle:
            handle.write(b'component check')
        if result['freeBytes'] < 512 * 1024 * 1024:
            common.append('用户缓存目录可用空间不足 512 MiB，请先释放空间。')
    except Exception as error:
        common.append(f'缓存目录不可写或空间不可用：{type(error).__name__}')
    if common:
        return unavailable(result, common)
    for label, executable in [('FFmpeg', args.ffmpeg), ('ffprobe', args.ffprobe)]:
        try:
            value = subprocess.run([executable, '-version'], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=5, check=True, creationflags=0x08000000 if sys.platform == 'win32' else 0)
            if label.lower().encode() not in value.stdout[:256].lower():
                raise ValueError('Unexpected binary')
        except Exception as error:
            common.append(f'{label} 无法运行：{type(error).__name__}')
    if common:
        return unavailable(result, common)

    model_errors = {}
    try:
        models = load_local_models(args.models)
        pinned_path = Path(__file__).with_name('evaluation-models.json')
        pinned = json.loads(pinned_path.read_text(encoding='utf-8'))['models']
        for name, filenames in MODEL_FILES.items():
            problems = []
            entry = models.get(name, {})
            if entry.get('repository') != pinned[name]['repository'] or entry.get('revision') != pinned[name]['revision']:
                problems.append('模型版本与当前应用不一致')
            directory = Path(entry.get('path', '__missing_component_model__'))
            for filename in filenames:
                path = directory / filename
                if not path.is_file() or path.stat().st_size <= 0:
                    problems.append(f'缺少 {filename}')
            if name == 'alignment' and not any((directory / filename).is_file() and (directory / filename).stat().st_size > 0
                                               for filename in ['pytorch_model.bin', 'model.safetensors']):
                problems.append('缺少对齐模型权重')
            model_errors[name] = problems
    except Exception as error:
        models = {}
        common.append(f'模型清单不可用：{type(error).__name__}')

    modules, import_errors = {}, {}
    for module in ['torch', 'torchaudio', 'funasr', 'ctranslate2', 'whisperx.asr', 'whisperx.alignment', 'transformers', 'nltk']:
        try:
            modules[module] = importlib.import_module(module)
        except Exception as error:
            import_errors[module] = f'{module} 无法加载（{type(error).__name__}），请重新选择完整组件或修复原生运行库。'
    cuda = False
    if 'torch' in modules:
        try:
            cuda = bool(modules['torch'].cuda.is_available())
            if cuda:
                result['cudaName'] = str(modules['torch'].cuda.get_device_name(0))[:300]
        except Exception:
            cuda = False
    sentence_errors = []
    resource = (Path(args.resources) if args.resources else Path(args.cache)) / 'nltk/tokenizers/punkt_tab/english'
    for filename in ['abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt']:
        if not (resource / filename).is_file():
            sentence_errors.append(f'缺少断句资源 {filename}')
    # A present pyannote package alone is not proof that its bundled VAD weights exist.
    if 'whisperx.asr' in modules:
        package = Path(modules['whisperx.asr'].__file__).parent
        if not (package / 'assets/pytorch_model.bin').is_file():
            sentence_errors.append('缺少 WhisperX 内置 VAD 权重')
    for engine in ['whisperx', 'paraformer']:
        required_models = ['whisper', 'alignment', 'punctuation'] if engine == 'whisperx' else ['paraformer', 'vad', 'punctuation', 'alignment']
        required_modules = ['torch', 'torchaudio', 'transformers', 'nltk', 'funasr', 'whisperx.alignment'] + (
            ['ctranslate2', 'whisperx.asr'] if engine == 'whisperx' else ['funasr'])
        engine_errors = common + [import_errors[module] for module in required_modules if module in import_errors]
        for name in required_models:
            engine_errors.extend(f'{name}：{message}' for message in model_errors.get(name, ['模型缺失']))
        engine_errors.extend(message for message in sentence_errors if engine == 'whisperx' or '断句资源' in message)
        for device in ['cpu', 'cuda']:
            problems = list(engine_errors)
            if device == 'cuda' and not cuda:
                problems.append('没有检测到可用 NVIDIA CUDA 设备，可选择 CPU。')
            if engine == 'whisperx' and 'ctranslate2' in modules and (device == 'cpu' or cuda):
                try:
                    compute = 'int8' if device == 'cpu' else 'int8_float16'
                    if compute not in modules['ctranslate2'].get_supported_compute_types(device):
                        problems.append(f'当前设备不支持 {compute} 计算。')
                except Exception as error:
                    problems.append(f'计算设备检查失败：{type(error).__name__}')
            result['capabilities'].append({'engine': engine, 'device': device,
                                           'available': not problems,
                                           'message': '依赖、文件和设备检查通过；尚未加载权重或验证识别质量。' if not problems else '；'.join(problems)[:950]})
    issues.extend(common)
    issues.extend(f'{name}：{"；".join(problems)}' for name, problems in model_errors.items() if problems)
    issues.extend(import_errors.values())
    result['ready'] = any(item['available'] for item in result['capabilities'])
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['models', 'cache', 'ffmpeg', 'ffprobe']:
        parser.add_argument(f'--{name}', required=True)
    parser.add_argument('--resources')
    with contextlib.redirect_stdout(sys.stderr):
        answer = check(parser.parse_args())
    print(json.dumps(answer, ensure_ascii=False), flush=True)
