"""JSONL worker. Stdout is protocol-only; models never write the app database."""

import argparse
import importlib.metadata
import json
import os
import queue
from pathlib import Path
import sys
import threading
import time
import traceback

# Embeddable Python deliberately excludes the script directory from its isolated path.
# This path is the application's own fixed worker directory, never the caller's cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_jobs import JobError, JobPipeline, FFmpegDecoder, MAX_JSON_BYTES, parse_request, hash_file, cache_error
from asr_runtime import configure_cache, load_local_models, protect_worker_process, configure_offline_network
from asr_resources import (
    CPU_THREAD_CHOICES, configure_cpu_environment, configure_torch_threads,
    execution_resources, ResourceCheckedEngine, ResourceCheckedPunctuation,
)


def protocol_lines(stream):
    """Avoid holding a Windows CRT stdin lock while native DLLs initialize.

    A single reader peeks the anonymous pipe owned by the parent; os.read is
    called only with bytes already available. Other platforms can
    read their pipe normally. The protocol reader has a strict 1 MiB bound.
    """
    buffered = bytearray()
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        peek = kernel.PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                         wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        peek.restype = wintypes.BOOL
        handle = msvcrt.get_osfhandle(stream.fileno())
    while True:
        if os.name == 'nt':
            available = wintypes.DWORD()
            if not peek(handle, None, 0, None, ctypes.byref(available), None):
                if ctypes.get_last_error() in (109, 232, 233):
                    break
                raise OSError(ctypes.get_last_error(), 'Cannot read parent protocol pipe')
            if not available.value:
                time.sleep(0.025)
                continue
            block = os.read(stream.fileno(), min(65536, available.value))
        else:
            block = os.read(stream.fileno(), 65536)
        if not block:
            break
        buffered.extend(block)
        while b'\n' in buffered:
            line, _, tail = buffered.partition(b'\n')
            if len(line) > 1024 * 1024:
                raise JobError('INVALID_REQUEST', '转写请求超过 1 MiB。')
            buffered = bytearray(tail)
            yield bytes(line)
        if len(buffered) > 1024 * 1024:
            raise JobError('INVALID_REQUEST', '转写请求超过 1 MiB。')
    if buffered:
        yield bytes(buffered)


class WorkerService:
    def __init__(self, pipeline, output, run_on_main=False):
        self.pipeline, self.output = pipeline, output
        self.lock = threading.RLock()
        self.active = None
        self.run_on_main = run_on_main
        self.pending = queue.Queue()

    def emit(self, kind, **fields):
        value = {'protocolVersion': 1, 'type': kind, **fields}
        resources = getattr(self.pipeline, 'execution_resources', None)
        if resources is not None:
            value['executionResources'] = resources
        if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) > MAX_JSON_BYTES:
            raise JobError('RESULT_TOO_LARGE', '转写消息超过 16 MiB。')
        with self.lock:
            self.output(value)

    def dispatch(self, value):
        request = parse_request(value)
        with self.lock:
            identity = {'jobId': request['jobId'], 'attempt': request['attempt']}
            if request['type'] == 'cancel':
                if self.active and self.active['identity'] == identity:
                    self.active['canceled'].set()
                    self.emit('cancel-accepted', **identity)
                else:
                    self.emit('error', **identity, code='NOT_RUNNING', message='这个任务当前未运行。')
                return
            if request['type'] == 'prioritize':
                if self.active and self.active['identity'] == identity and not self.active['canceled'].is_set():
                    self.active['priorityMs'] = request['positionMs']
                    self.emit('priority-accepted', **identity, positionMs=request['positionMs'])
                return
            if self.active:
                self.emit('error', **identity, code='BUSY', message='转写进程正在处理另一个任务。')
                return
            canceled = threading.Event()
            thread = None if self.run_on_main else threading.Thread(target=self.run, args=(request, canceled), daemon=False)
            self.active = {'identity': identity, 'canceled': canceled, 'thread': thread,
                           'priorityMs': request.get('priorityMs', request['range']['startMs'])}
            self.emit('accepted', **identity)
            if thread:
                thread.start()
            else:
                self.pending.put((request, canceled))

    def run(self, request, canceled):
        identity = {'jobId': request['jobId'], 'attempt': request['attempt']}
        def priority():
            with self.lock:
                return self.active['priorityMs'] if self.active and self.active['identity'] == identity else request['range']['startMs']
        try:
            result = self.pipeline.run(request, canceled, lambda kind, **fields: self.emit(kind, **identity, **fields), priority)
            terminal = {'type': 'result', **result}
        except JobError as error:
            terminal = {'type': 'canceled'} if error.code == 'CANCELED' else {
                'type': 'error', 'code': error.code, 'message': str(error)}
        except Exception:
            traceback.print_exc(file=sys.stderr)
            terminal = {'type': 'error', 'code': 'ENGINE_FAILED', 'message': '转写进程未完成任务，可以重试。'}
        with self.lock:
            # Cancellation that arrived between computation and terminal output wins.
            if canceled.is_set():
                terminal = {'type': 'canceled'}
            self.active = None
            self.emit(terminal.pop('type'), **identity, **terminal)

    def close(self):
        with self.lock:
            active = self.active
            if active:
                active['canceled'].set()
        if active and active['thread']:
            active['thread'].join()


def build_pipeline(args):
    cpu_threads = getattr(args, 'cpu_threads', 4)
    configure_cpu_environment(cpu_threads)
    configure_offline_network()
    try:
        root = configure_cache(args.cache, resources=args.resources)
    except OSError as error:
        raise cache_error(error) from error
    # Runtime tasks use local components only; setup/download is a separate command.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    models = load_local_models(args.models)
    keys = ['whisper', 'alignment', 'punctuation'] if args.engine == 'whisperx' else ['paraformer', 'vad', 'punctuation', 'alignment']
    pinned = json.loads(Path(__file__).with_name('evaluation-models.json').read_text(encoding='utf-8'))['models']
    for key in keys:
        if (models[key]['repository'] != pinned[key]['repository'] or
                models[key]['revision'] != pinned[key]['revision'] or not Path(models[key]['path']).is_dir()):
            raise JobError('RUNTIME_UNAVAILABLE', '模型版本与当前转写组件不符，请先准备模型。')
    versions = {name: importlib.metadata.version(name) for name in [
        'torch', 'torchaudio', 'funasr', 'whisperx', 'faster-whisper', 'pyannote.audio',
        'ctranslate2', 'transformers', 'numpy', 'nltk',
    ]}
    from asr_ctc import CTC_ALIGNMENT_CONTRACT
    configuration = {
        'engine': args.engine, 'device': args.device,
        'computeType': args.compute if args.engine == 'whisperx' else 'float32',
        'batchSize': 1, 'threads': cpu_threads, 'language': 'zh', 'versions': versions,
        'models': {key: pinned[key] for key in keys},
        'python': sys.version.split()[0],
        'offlineNetwork': 'python-loopback-only-ffmpeg-file-pipe-v1',
        'punctuationPolicy': 'engine-surface-once-v1',
        'ctcAlignmentObjective': CTC_ALIGNMENT_CONTRACT,
        'ffmpegSha256': hash_file(Path(args.ffmpeg), threading.Event()),
        'ffprobeSha256': hash_file(Path(args.ffprobe), threading.Event()),
    }
    if args.engine == 'paraformer':
        from asr_compat import PARAFORMER_TIMESTAMP_CONTRACT
        configuration['timestampAdapter'] = PARAFORMER_TIMESTAMP_CONTRACT
        configuration['nativeTimestampFallback'] = 'zh-ctc-no-interpolation-v1'
    if args.engine == 'whisperx':
        from asr_engines import WHISPERX_AUDIO_BOUNDS_CONTRACT
        configuration['alignmentAudioBounds'] = WHISPERX_AUDIO_BOUNDS_CONTRACT
    if args.engine in ('whisperx', 'paraformer'):
        resource = (Path(args.resources).resolve() if args.resources else root) / 'nltk/tokenizers/punkt_tab/english'
        configuration['sentenceResource'] = {
            name: hash_file(resource / name, threading.Event())
            for name in ['abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt']
        }

    def engine_factory():
        import torch
        from asr_engines import Paraformer, WhisperX
        configure_torch_threads(cpu_threads)
        torch.manual_seed(0)
        if args.device == 'cuda' and not torch.cuda.is_available():
            raise JobError('RUNTIME_UNAVAILABLE', 'CUDA 不可用，请选择 CPU 配置后重试。')
        if args.engine == 'whisperx':
            from nltk.data import load
            try:
                load('tokenizers/punkt_tab/english.pickle')
            except LookupError:
                raise JobError('RUNTIME_UNAVAILABLE', '缺少断句资源，请先运行模型准备命令。') from None
            engine = WhisperX(models, args.device, args.compute, 1, cpu_threads=cpu_threads)
            return ResourceCheckedEngine(engine, cpu_threads, publish_resources)
        try:
            engine = Paraformer(models, args.device, cpu_threads=cpu_threads)
            return ResourceCheckedEngine(engine, cpu_threads, publish_resources)
        except ValueError as error:
            raise JobError('RUNTIME_UNAVAILABLE', 'Paraformer 实现与固定组件不符，请使用完整离线组件包或重新准备固定依赖。') from error

    def punctuation_factory():
        from asr_engines import ChinesePunctuation
        punctuation = ChinesePunctuation(models, cpu_threads=cpu_threads)
        return ResourceCheckedPunctuation(punctuation, cpu_threads, publish_resources)

    def publish_resources(value):
        pipeline.execution_resources = value

    pipeline = JobPipeline(root / 'jobs', configuration,
                           FFmpegDecoder(args.ffmpeg, args.ffprobe, cpu_threads=cpu_threads),
                           engine_factory, punctuation_factory, args.chunk_ms, args.overlap_ms)
    pipeline.execution_resources = execution_resources(cpu_threads)
    return pipeline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--models', required=True)
    parser.add_argument('--resources')
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--engine', choices=['whisperx', 'paraformer'], required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], required=True)
    parser.add_argument('--compute', choices=['float16', 'int8_float16', 'int8'], required=True)
    parser.add_argument('--chunk-ms', type=int, default=30000)
    parser.add_argument('--overlap-ms', type=int, default=2000)
    parser.add_argument('--cpu-threads', type=int, choices=CPU_THREAD_CHOICES, default=4)
    args = parser.parse_args()
    if not 5000 <= args.chunk_ms <= 60000 or not 0 <= args.overlap_ms <= 5000:
        parser.error('Invalid chunk configuration')
    if args.device == 'cpu' and args.compute != 'int8':
        parser.error('CPU jobs require int8 configuration')
    protocol_output = sys.stdout
    # Some libraries print during imports, model loading and inference.
    sys.stdout = sys.stderr

    def output(value):
        protocol_output.write(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n')
        protocol_output.flush()

    try:
        try:
            protect_worker_process()
        except OSError as error:
            raise JobError('RUNTIME_UNAVAILABLE', '无法建立转写子进程回收机制，请检查 Windows 运行环境后重试。') from error
        pipeline = build_pipeline(args)
    except JobError as error:
        output({'protocolVersion': 1, 'type': 'fatal', 'code': error.code, 'message': str(error)})
        return 1
    except Exception:
        traceback.print_exc(file=sys.stderr)
        output({'protocolVersion': 1, 'type': 'fatal', 'code': 'RUNTIME_UNAVAILABLE',
                'message': '转写组件未就绪，请检查 Python、模型和 FFmpeg 配置。'})
        return 1
    # Native NumPy/PyTorch DLL initialization stays on the main thread. The
    # protocol reader remains responsive while main performs model operations.
    service = WorkerService(pipeline, output, run_on_main=True)
    service.emit('ready', configuration=pipeline.configuration)
    def read_requests():
        try:
            for line in protocol_lines(sys.stdin.buffer):
                try:
                    value = json.loads(line.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
                    service.dispatch(value)
                except (ValueError, UnicodeDecodeError, JobError) as error:
                    service.emit('error', jobId=None, attempt=None,
                                 code=getattr(error, 'code', 'INVALID_REQUEST'), message='转写请求无效。')
        except (OSError, JobError):
            traceback.print_exc(file=sys.stderr)
        finally:
            service.close()
            service.pending.put(None)

    reader = threading.Thread(target=read_requests, daemon=True)
    reader.start()
    try:
        while True:
            pending = service.pending.get()
            if pending is None:
                break
            service.run(*pending)
    finally:
        service.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
