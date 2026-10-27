"""Cancelable decoding, versioned checkpoints and progressive transcript jobs."""

import errno
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

from asr_metrics import timing_issues
from asr_engines import AlignmentError
from asr_segments import (
    POSTPROCESS_VERSION, fingerprint, join_windows, lexical_units, owned_units,
    partial_document, punctuate_units, windows,
    alignment_text,
)

MAX_JSON_BYTES = 16 * 1024 * 1024


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def check_cancel(canceled):
    if canceled.is_set():
        raise JobError('CANCELED', '转写已取消。')


def parse_request(value):
    if not isinstance(value, dict) or type(value.get('protocolVersion')) is not int or value.get('protocolVersion') != 1:
        raise JobError('INVALID_REQUEST', '不支持的转写协议。')
    kind = value.get('type')
    expected = {'protocolVersion', 'type', 'jobId', 'attempt'}
    if kind == 'submit':
        expected |= {'audioPath', 'audioHash', 'range'}
        if 'priorityMs' in value:
            expected.add('priorityMs')
    elif kind == 'prioritize':
        expected.add('positionMs')
    elif kind not in ('cancel',):
        raise JobError('INVALID_REQUEST', '不支持的转写请求。')
    if set(value) != expected:
        raise JobError('INVALID_REQUEST', '转写请求字段无效。')
    try:
        if uuid.UUID(value['jobId']).version != 4:
            raise ValueError('Invalid UUID')
    except (ValueError, TypeError, AttributeError):
        raise JobError('INVALID_REQUEST', '任务 ID 无效。') from None
    if type(value['attempt']) is not int or not 1 <= value['attempt'] <= 100000:
        raise JobError('INVALID_REQUEST', '任务重试序号无效。')
    position = value.get('priorityMs') if kind == 'submit' else value.get('positionMs')
    if (kind == 'prioritize' or 'priorityMs' in value) and (type(position) is not int or not 0 <= position <= 3.6e10):
        raise JobError('INVALID_REQUEST', '字幕优先位置无效。')
    if kind == 'submit':
        audio_hash, media_range = value['audioHash'], value['range']
        if not isinstance(audio_hash, str) or len(audio_hash) != 64 or any(c not in '0123456789abcdef' for c in audio_hash):
            raise JobError('INVALID_REQUEST', '音频版本无效。')
        if not isinstance(value['audioPath'], str) or '\0' in value['audioPath'] or not Path(value['audioPath']).is_absolute():
            raise JobError('INVALID_REQUEST', '音频路径需要由主进程提供。')
        if not isinstance(media_range, dict) or set(media_range) != {'startMs', 'endMs'}:
            raise JobError('INVALID_REQUEST', '转写范围无效。')
        start, end = media_range['startMs'], media_range['endMs']
        if type(start) is not int or not 0 <= start < 3.6e10 or (end is not None and (type(end) is not int or not start < end <= 3.6e10)):
            raise JobError('INVALID_REQUEST', '转写范围无效。')
    return value


def atomic_json(path, value):
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > MAX_JSON_BYTES:
        raise JobError('RESULT_TOO_LARGE', '文稿或分块超过 16 MiB，请缩小处理范围。')
    temporary = path.with_name(f'{path.name}.{uuid.uuid4()}.tmp')
    try:
        temporary.write_bytes(encoded)
        temporary.replace(path)
    except OSError as error:
        raise cache_error(error) from error
    finally:
        # Remove only this attempt's temporary file; an existing checkpoint survives.
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def cache_error(error):
    if error.errno in (errno.ENOSPC, getattr(errno, 'EDQUOT', errno.ENOSPC)) or getattr(error, 'winerror', None) in (39, 112):
        return JobError('DISK_FULL', '缓存所在磁盘空间不足，请释放空间后重试；此前完成的片段已保留。')
    if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return JobError('CACHE_UNWRITABLE', '无法写入转写缓存，请检查用户数据目录的写入权限后重试。')
    return JobError('CACHE_WRITE_FAILED', '转写缓存写入失败，请检查磁盘和用户数据目录后重试。')


def make_cache_directory(path):
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise cache_error(error) from error


def hash_file(path, canceled):
    hasher = hashlib.sha256()
    try:
        with path.open('rb') as source:
            while True:
                check_cancel(canceled)
                block = source.read(1024 * 1024)
                if not block:
                    break
                hasher.update(block)
    except OSError as error:
        raise JobError('FILE_UNAVAILABLE', '无法读取本地文件，请检查文件是否被移动或访问权限。') from error
    return hasher.hexdigest()


def file_version(path):
    try:
        info = path.stat()
    except OSError as error:
        raise JobError('FILE_UNAVAILABLE', '音频文件无法读取，请恢复文件原路径后重试或重新导入。') from error
    if not path.is_file() or not info.st_size:
        raise JobError('FILE_UNAVAILABLE', '音频文件无法读取。')
    return (info.st_size, info.st_mtime_ns)


def run_decoder(command, canceled, timeout=60):
    check_cancel(canceled)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0)
    started = time.monotonic()
    try:
        while True:
            check_cancel(canceled)
            if time.monotonic() - started > timeout:
                raise JobError('DECODE_TIMEOUT', '音频解码超时，可以重试。')
            try:
                output, error = process.communicate(timeout=0.1)
                if process.returncode:
                    raise JobError('DECODE_FAILED', '音频无法解码，请检查编码或重新导入。')
                return output
            except subprocess.TimeoutExpired:
                continue
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()


class FFmpegDecoder:
    def __init__(self, ffmpeg, ffprobe, cpu_threads=4):
        from asr_resources import validate_cpu_threads
        self.cpu_threads = validate_cpu_threads(cpu_threads)
        self.ffmpeg, self.ffprobe = str(Path(ffmpeg).resolve()), str(Path(ffprobe).resolve())
        if not Path(self.ffmpeg).is_file() or not Path(self.ffprobe).is_file():
            raise JobError('RUNTIME_UNAVAILABLE', '未找到 FFmpeg / ffprobe，请先配置转写组件。')

    def duration_ms(self, path, canceled):
        output = run_decoder([self.ffprobe, '-v', 'error', '-show_entries', 'format=duration',
                              '-of', 'json', '-protocol_whitelist', 'file,pipe', str(path)], canceled)
        duration = round(float(json.loads(output)['format']['duration']) * 1000)
        if not 0 < duration <= 3.6e10:
            raise JobError('DECODE_FAILED', '音频时长无效。')
        return duration

    def decode(self, path, window, canceled):
        duration = window['decodeEndMs'] - window['decodeStartMs']
        output = run_decoder([
            self.ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error',
            *(['-threads', str(self.cpu_threads), '-filter_threads', str(self.cpu_threads)]
              if self.cpu_threads < 4 else []),
            '-ss', str(window['decodeStartMs'] / 1000), '-protocol_whitelist', 'file,pipe', '-i', str(path),
            '-t', str(duration / 1000), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
            '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1',
        ], canceled)
        if not output or len(output) % 2 or len(output) > duration * 32 + 32:
            raise JobError('DECODE_FAILED', '解码片段大小无效。')
        import numpy as np
        return np.frombuffer(output, dtype='<i2').astype(np.float32) / 32768


def assembled_document(audio_hash, plan, checkpoints, overlap_ms):
    """Join adjacent completed windows only; unknown holes remain uncovered.

    Boundary-spanning sentences wait for their neighboring core instead of
    clipping native word times or declaring an unprocessed gap covered.
    """
    groups = []
    for window in plan:
        if window['index'] not in checkpoints:
            continue
        if not groups or groups[-1][-1]['index'] + 1 != window['index']:
            groups.append([])
        groups[-1].append(window)
    coverage, segments, issues = [], [], []
    prefix = plan[0]['startMs']
    for group in groups:
        units, context = [], None
        first, last = group[0]['startMs'], group[-1]['endMs']
        for window in group:
            checkpoint = checkpoints[window['index']]
            units, boundary = join_windows(units, checkpoint['units'], context,
                                           checkpoint['contextUnits'], window['startMs'], overlap_ms)
            context = checkpoint['contextUnits']
            issues.extend(checkpoint['issues'] + boundary)
        coverage.append({'startMs': first, 'endMs': last})
        if first == prefix:
            prefix = last
        document = partial_document(audio_hash, first, last, units)
        for segment in document['segments']:
            if segment['startMs'] < first or segment['endMs'] > last:
                continue
            identity = {key: segment[key] for key in ['startMs', 'endMs', 'text']}
            segments.append({**segment, 'id': f"asr-{segment['startMs']}-{fingerprint(identity)[:16]}"})
    return {'version': 1, 'audioHash': audio_hash, 'kind': 'transcript',
            'coverage': coverage, 'segments': segments}, prefix, issues


class JobPipeline:
    def __init__(self, cache, configuration, decoder, engine_factory, punctuation_factory,
                 chunk_ms=30000, overlap_ms=2000):
        self.cache = Path(cache).resolve()
        make_cache_directory(self.cache)
        self.configuration = {**configuration, 'chunkMs': chunk_ms, 'overlapMs': overlap_ms,
                              'postprocessVersion': POSTPROCESS_VERSION, 'transcriptVersion': 1}
        self.decoder, self.engine_factory = decoder, engine_factory
        self.punctuation_factory = punctuation_factory
        self.chunk_ms, self.overlap_ms = chunk_ms, overlap_ms
        self.engine, self.punctuation = None, None

    def run(self, request, canceled, emit, priority=None):
        path = Path(request['audioPath'])
        emit('progress', stage='validating', processedUntilMs=request['range']['startMs'])
        before = file_version(path)
        if hash_file(path, canceled) != request['audioHash'] or file_version(path) != before:
            raise JobError('FILE_CHANGED', '音频版本已变化，请重新导入后转写。')
        duration = self.decoder.duration_ms(path, canceled)
        start = request['range']['startMs']
        end = request['range']['endMs'] if request['range']['endMs'] is not None else duration
        if not 0 <= start < end <= duration:
            raise JobError('INVALID_RANGE', '转写范围超出音频时长。')
        key = fingerprint({'audioHash': request['audioHash'], 'configuration': self.configuration,
                           'startMs': start, 'endMs': end})
        directory = self.cache / key
        make_cache_directory(directory)
        atomic_json(directory / 'manifest.json', {
            'version': 1, 'audioHash': request['audioHash'], 'configuration': self.configuration,
            'startMs': start, 'endMs': end,
        })
        plan = list(windows(start, end, self.chunk_ms, self.overlap_ms))
        checkpoints, hits = {}, 0
        # Scheduling never changes the whole-range fingerprint or absolute window IDs.
        # Load the saved set first so resumed snapshots retain every cached coverage run.
        for window in plan:
            check_cancel(canceled)
            checkpoint = self.load_checkpoint(directory / f"chunk-{window['index']:06d}.json", key, window)
            if checkpoint:
                checkpoints[window['index']] = checkpoint
                hits += 1

        def snapshot():
            document, prefix, issues = assembled_document(request['audioHash'], plan, checkpoints, self.overlap_ms)
            if len(document['segments']) > 100000 or timing_issues(document['segments'], end):
                raise JobError('ALIGNMENT_FAILED', '生成区间无效，已保留此前完成的片段。')
            check_cancel(canceled)
            emit('partial', document=document, processedUntilMs=prefix,
                 cacheKey=key, completedChunks=len(checkpoints), totalChunks=len(plan),
                 cacheHits=hits, issues=issues)
            return document, prefix, issues

        document, prefix, all_issues = None, start, []
        if checkpoints:
            document, prefix, all_issues = snapshot()
        while len(checkpoints) < len(plan):
            check_cancel(canceled)
            position = priority() if priority else request.get('priorityMs', start)
            position = min(max(position, start), end - 1)
            target_index = min(len(plan) - 1, (position - start) // self.chunk_ms)
            remaining = [window for window in plan if window['index'] not in checkpoints]
            window = min(remaining, key=lambda item: (item['index'] - target_index) % len(plan))
            if file_version(path) != before:
                raise JobError('FILE_CHANGED', '音频在转写期间发生变化，请重新导入。')
            target = directory / f"chunk-{window['index']:06d}.json"
            emit('progress', stage='decoding', processedUntilMs=prefix, chunk=window['index'])
            audio = self.decoder.decode(path, window, canceled)
            check_cancel(canceled)
            if self.engine is None:
                emit('progress', stage='loading', processedUntilMs=prefix)
                self.engine = self.engine_factory()
            check_cancel(canceled)
            emit('progress', stage='recognizing', processedUntilMs=prefix, chunk=window['index'])
            try:
                result = self.engine.transcribe(audio)
            except AlignmentError as error:
                raise JobError('ALIGNMENT_FAILED', '模型重新对齐仍有缺失或无效时间，已保留此前完成的片段。') from error
            check_cancel(canceled)
            try:
                units = lexical_units(result['timedUnits'], round(len(audio) / 16))
            except ValueError as error:
                raise JobError('ALIGNMENT_FAILED', '模型时间戳无效，已保留此前完成的片段。') from error
            if alignment_text(result['recognitionText']) != alignment_text(''.join(unit['text'] for unit in units)):
                raise JobError('ALIGNMENT_FAILED', '部分识别文字缺少时间戳，已保留此前完成的片段。')
            issues = []
            if result.get('alignmentFallback'):
                issues.append({'code': 'NATIVE_REALIGNED', 'atMs': window['startMs']})
            if units and not result.get('punctuationRestored'):
                if self.punctuation is None:
                    emit('progress', stage='punctuation', processedUntilMs=prefix)
                    self.punctuation = self.punctuation_factory()
                check_cancel(canceled)
                try:
                    units = punctuate_units(units, self.punctuation.restore(''.join(unit['text'] for unit in units)))
                except ValueError:
                    issues.append({'code': 'PUNCTUATION_REJECTED', 'atMs': window['startMs']})
            selected = owned_units(units, window)
            context = [{**unit, 'startMs': unit['startMs'] + window['decodeStartMs'],
                        'endMs': unit['endMs'] + window['decodeStartMs']} for unit in units]
            check_cancel(canceled)
            if file_version(path) != before:
                raise JobError('FILE_CHANGED', '音频在转写期间发生变化，请重新导入。')
            checkpoint = {'version': 1, 'cacheKey': key, 'window': window, 'units': selected,
                          'contextUnits': context, 'issues': issues, 'raw': result['raw']}
            atomic_json(target, checkpoint)
            checkpoints[window['index']] = checkpoint
            document, prefix, all_issues = snapshot()
        check_cancel(canceled)
        if file_version(path) != before or hash_file(path, canceled) != request['audioHash']:
            raise JobError('FILE_CHANGED', '音频在转写期间发生变化，请重新导入。')
        return {'document': document, 'processedUntilMs': end, 'durationMs': duration,
                'cacheKey': key, 'cacheHits': hits, 'totalChunks': len(plan), 'issues': all_issues}

    def load_checkpoint(self, path, key, window):
        try:
            if path.stat().st_size > MAX_JSON_BYTES:
                return None
            value = json.loads(path.read_bytes())
            if value['version'] != 1 or value['cacheKey'] != key or value['window'] != window:
                return None
            # Revalidate cached native ranges and ownership before reusing text.
            units = lexical_units(value['units'], window['decodeEndMs'])
            context = lexical_units(value['contextUnits'], window['decodeEndMs'])
            if (any(unit['startMs'] < window['decodeStartMs'] for unit in units + context)
                    or len(units) != len(value['units']) or len(context) != len(value['contextUnits']) or owned_units([
                {**unit, 'startMs': unit['startMs'] - window['decodeStartMs'],
                 'endMs': unit['endMs'] - window['decodeStartMs']} for unit in context
            ], window) != units or not isinstance(value['issues'], list)):
                return None
            return value
        except (OSError, ValueError, TypeError, KeyError):
            return None
