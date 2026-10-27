"""Protocol fault fixture, used only by Node tests. No model simulation in app."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import os

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
from asr_runtime import protect_worker_process
protect_worker_process()

parser = argparse.ArgumentParser()
parser.add_argument('--models')
parser.add_argument('--cpu-threads', type=int, default=4)
args, _ = parser.parse_known_args()
configuration = json.loads(Path(args.models).read_text(encoding='utf8'))
mode = configuration['mode']
lock = threading.Lock()


def emit(value):
    if mode in ('resources', 'bad-resources'):
        value['executionResources'] = {
            'requestedCpuThreads': args.cpu_threads,
            'torchThreads': None if value['type'] == 'ready' else (4 if mode == 'bad-resources' else args.cpu_threads),
            'torchInteropThreads': 1,
        }
    with lock:
        print(json.dumps({'protocolVersion': 1, **value}, ensure_ascii=False), flush=True)


def snapshot(request):
    start = request['range']['startMs']
    end = request['range']['endMs'] or 10000
    return {'document': {'version': 1, 'audioHash': request['audioHash'], 'kind': 'transcript',
                         'coverage': [{'startMs': start, 'endMs': end}],
                         'segments': [{'id': 's1', 'startMs': start, 'endMs': end, 'text': '中文片段。'}]},
            'processedUntilMs': end, 'durationMs': end, 'cacheKey': 'a' * 64,
            'cacheHits': 0, 'totalChunks': 1, 'issues': []}


if mode == 'slow-start':
    time.sleep(3)
if mode in ('fatal-cache', 'fatal-invalid'):
    emit({'type': 'fatal', 'code': 'CACHE_UNWRITABLE',
          'message': '无法写入转写缓存，请检查用户数据目录的写入权限后重试。' if mode == 'fatal-cache' else []})
    sys.exit(1)
emit({'type': 'ready', 'configuration': {'fixture': True}})
pending = None
for line in sys.stdin:
    value = json.loads(line)
    identity = {key: value[key] for key in ['jobId', 'attempt']}
    if value['type'] == 'cancel':
        if mode == 'late':
            emit({'type': 'canceled', **identity})
        continue
    if value['type'] == 'prioritize':
        emit({'type': 'priority-accepted', **identity, 'positionMs': value['positionMs']})
        if mode == 'priority-gaps' and pending:
            result = {**snapshot(pending), 'totalChunks': 2}
            emit({'type': 'partial', **identity, **result, 'completedChunks': 2})
            emit({'type': 'result', **identity, **result})
            pending = None
        continue
    emit({'type': 'progress', **identity, 'stage': 'recognizing', 'processedUntilMs': value['range']['startMs']})
    if mode == 'corrupt':
        print('not json', flush=True)
        continue
    if mode in ('hang', 'crash-with-child'):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(configuration['pidFile']).write_text(str(child.pid), encoding='utf8')
        if mode == 'hang':
            continue
    if mode == 'late' and value['attempt'] == 1:
        continue
    if mode == 'late':
        stale = {**identity, 'attempt': 1}
        emit({'type': 'partial', **stale, **snapshot(value), 'completedChunks': 1})
        emit({'type': 'result', **stale, **snapshot(value)})
    if mode in ('priority-gaps', 'false-prefix'):
        result = {**snapshot(value), 'totalChunks': 2}
        result['document']['coverage'][0]['startMs'] += 5000
        result['document']['segments'][0]['startMs'] += 5000
        if mode == 'priority-gaps':
            result['processedUntilMs'] = value['range']['startMs']
        emit({'type': 'partial', **identity, **result, 'completedChunks': 1})
        pending = value
        continue
    result = snapshot(value)
    if mode == 'wrong-hash':
        result['document']['audioHash'] = 'b' * 64
    emit({'type': 'partial', **identity, **result, 'completedChunks': 1})
    if mode in ('crash', 'crash-with-child'):
        os._exit(23)
    emit({'type': 'result', **identity, **result})
