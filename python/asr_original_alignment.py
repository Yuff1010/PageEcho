"""One confirmed-original alignment request; fixed local resources, no ASR.

Stdout is a single JSON result/error. Quality scores are model diagnostics,
never calibrated probabilities or human boundary accuracy.
"""

import argparse
from contextlib import redirect_stdout
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import threading
import time
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))

from asr_ctc import CTC_ALIGNMENT_CONTRACT
from asr_jobs import FFmpegDecoder, JobError, hash_file
from asr_runtime import configure_cache, configure_offline_network, load_local_models, protect_worker_process
from asr_resources import CPU_THREAD_CHOICES, configure_cpu_environment, configure_torch_threads, verify_torch_threads

CONTRACT = 'original-ctc-support-v1'
QUALITY_POLICY = 'confirmed-original-acoustic-gate-v1'
MAX_REQUEST_BYTES = 65536
# Selected against the frozen 58-reference/control diagnostics; see the
# published full denominator and known internal-deletion miss. These are
# experimental model-support floors, never human accuracy probabilities.
THRESHOLDS = {'minAudioRms': 0.0001, 'minTokenPosterior': 0.02,
              'maxFreePathErrorRate': 0.35, 'maxUnexplainedPosterior': 0.3}


def lexical_characters(text):
    result, offset = [], 0
    for char in text:
        end = offset + len(char.encode('utf-16-le')) // 2
        if unicodedata.category(char)[0] in ('L', 'N'):
            result.append({'text': char, 'token': char.lower(), 'textStart': offset, 'textEnd': end})
        offset = end
    return result


def empty_evidence(count):
    return {'lexicalCharacters': count, 'timedCharacters': 0, 'characterCoverage': 0,
            'audioRms': None, 'freePathCharacters': None, 'freePathEditDistance': None,
            'freePathErrorRate': None, 'minTokenPosterior': None, 'meanTokenPosterior': None,
            'maxUnexplainedPosterior': None, 'minCharScore': None, 'meanCharScore': None,
            'candidateOccurrences': None, 'confidence': None}


def parse_request(value):
    allowed = {'protocolVersion', 'requestId', 'audioPath', 'audioHash', 'device', 'range', 'text'}
    if (not isinstance(value, dict) or set(value) != allowed
            or type(value.get('protocolVersion')) is not int or value['protocolVersion'] != 1):
        raise JobError('INVALID_REQUEST', '原文对齐请求格式无效。')
    if not isinstance(value['requestId'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value['requestId']):
        raise JobError('INVALID_REQUEST', '原文对齐请求标识无效。')
    if (not isinstance(value['audioHash'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['audioHash'])
            or value['device'] not in ('cpu', 'cuda')
            or not isinstance(value['audioPath'], str) or not Path(value['audioPath']).is_absolute()):
        raise JobError('INVALID_REQUEST', '原文对齐音频身份或设备无效。')
    span = value['range']
    if (not isinstance(span, dict) or set(span) != {'startMs', 'endMs'}
            or any(type(span[key]) is not int for key in span)
            or not 0 <= span['startMs'] < span['endMs'] <= 36000000000
            or span['endMs'] - span['startMs'] > 60000):
        raise JobError('INVALID_REQUEST', '每次原文对齐范围必须大于零且不超过 60 秒。')
    text = value['text']
    if (not isinstance(text, str) or not 1 <= len(text) <= 1000
            or any(unicodedata.category(char) in ('Cc', 'Cs') and char not in '\r\n\t' for char in text)):
        raise JobError('INVALID_REQUEST', '每次原文对齐需要 1–1000 字的已确认原文。')
    return value


def reason(code, message):
    return {'code': code, 'message': message}


def edit_path(expected, actual):
    """Global lexical edit path; distinguish extra speech from substitutions.

    A supported alternative spelling is checked by per-target posterior, not
    mislabelled as an extra uttered character. Insertions remain unexplained.
    """
    rows = [list(range(len(actual) + 1))]
    for i, token in enumerate(expected, 1):
        row = [i]
        for j, other in enumerate(actual, 1):
            row.append(min(rows[-1][j] + 1, row[j - 1] + 1, rows[-1][j - 1] + (token != other)))
        rows.append(row)
    i, j, extras = len(expected), len(actual), []
    while i or j:
        if i and j and rows[i][j] == rows[i - 1][j - 1] + (expected[i - 1] != actual[j - 1]):
            i, j = i - 1, j - 1
        elif j and rows[i][j] == rows[i][j - 1] + 1:
            extras.append(j - 1)
            j -= 1
        else:
            i -= 1
    return rows[-1][-1], extras


def candidate_occurrences(expected, actual):
    """Count up to two disjoint semiglobal target candidates in context.

    Near-identical repeated speech must not look unique just because the free
    CTC path misspells one copy. Overlapping endpoints of one occurrence merge.
    """
    limit = math.floor(len(expected) * THRESHOLDS['maxFreePathErrorRate'])
    rows = [[0] * (len(actual) + 1)]
    for i, token in enumerate(expected, 1):
        row = [i]
        for j, other in enumerate(actual, 1):
            row.append(min(rows[-1][j] + 1, row[j - 1] + 1, rows[-1][j - 1] + (token != other)))
        rows.append(row)
    endpoints = [(distance, end) for end, distance in enumerate(rows[-1]) if distance <= limit]
    if not endpoints:
        return 0
    if len(actual) < 2 * (len(expected) - limit):
        return 1
    spans = []
    for _distance, end in sorted(endpoints):
        i, j = len(expected), end
        while i:
            if j and rows[i][j] == rows[i - 1][j - 1] + (expected[i - 1] != actual[j - 1]):
                i, j = i - 1, j - 1
            elif j and rows[i][j] == rows[i][j - 1] + 1:
                j -= 1
            else:
                i -= 1
        if all(end <= first or j >= last for first, last in spans):
            spans.append((j, end))
            if len(spans) == 2:
                return 2
    return 1


def acoustic_evidence(audio, text, metadata, aligned, emission):
    """Inspect native char times and the same, unforced CTC logits.

    Projecting native times back to emission frames is solely for evidence;
    no returned time is inferred, clipped, stretched, or interpolated.
    """
    duration = len(audio) / 16000
    rms = math.sqrt(math.fsum(float(value) ** 2 for value in audio) / len(audio))
    return emission_evidence(duration, rms, text, metadata, aligned, emission)


def emission_evidence(duration, rms, text, metadata, aligned, emission):
    expected = lexical_characters(text)
    dictionary = metadata['dictionary']
    chars = [char for segment in aligned.get('segments', []) for char in segment.get('chars', []) or []]
    evidence = {**empty_evidence(len(expected)),
                'audioRms': rms}
    issues, output, peaks, scores = [], [], [], []
    if len(chars) != len(expected) or ''.join(char.get('char', '') for char in chars) != ''.join(char['token'] for char in expected):
        return output, evidence, [reason('MISSING_CHARACTER_TIMES', '声学对齐未完整返回已确认原文的字符。')]
    previous = 0
    frames = int(emission.shape[0])
    for source, char in zip(expected, chars):
        start, end, score = char.get('start'), char.get('end'), char.get('score')
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end, score)):
            issues.append(reason('MISSING_CHARACTER_TIMES', '部分字符缺少真实声学时间或评分。'))
            continue
        if (not 0 <= start < end <= duration or start < previous or not 0 <= score <= 1
                or round(start * 1000) >= round(end * 1000)):
            issues.append(reason('INVALID_CHARACTER_TIMES', '原生字符时间越界、重叠或为空，未作裁剪。'))
            continue
        previous = end
        first, last = round(start / duration * frames), round(end / duration * frames)
        if not 0 <= first < last <= frames:
            issues.append(reason('INVALID_CHARACTER_TIMES', '原生字符时间没有对应声学帧。'))
            continue
        peak = float(emission[first:last, dictionary[source['token']]].max().exp())
        peaks.append(peak)
        scores.append(score)
        output.append({key: source[key] for key in ('text', 'textStart', 'textEnd')} | {
            'startMs': round(start * 1000), 'endMs': round(end * 1000), 'score': score})
    evidence['timedCharacters'] = len(output)
    evidence['characterCoverage'] = len(output) / len(expected) if expected else 0
    if issues or not output:
        return output, evidence, issues or [reason('MISSING_CHARACTER_TIMES', '没有可用字符时间。')]
    # Only inspect unforced tokens inside the native target span. Neighbouring
    # speech in the bounded context is not itself a mismatch with the target.
    first = round(chars[0]['start'] / duration * frames)
    last = round(chars[-1]['end'] / duration * frames)
    blank = dictionary.get('[pad]', dictionary.get('<pad>', 0))
    inverse = {code: token for token, code in dictionary.items()}
    indices = emission.argmax(-1).tolist()
    complete_free, previous_token = [], None
    for token in indices:
        if token != previous_token and token != blank and inverse.get(token) != '|':
            complete_free.append(inverse.get(token, '?'))
        previous_token = token
    expected_tokens = [char['token'] for char in expected]
    occurrences = candidate_occurrences(expected_tokens, complete_free)
    free, free_scores, previous_token = [], [], None
    for index in range(first, last):
        token = indices[index]
        lexical = token != blank and inverse.get(token) != '|'
        if token != previous_token and lexical:
            free.append(inverse.get(token, '?'))
            free_scores.append(float(emission[index, token].exp()))
        elif token == previous_token and lexical:
            free_scores[-1] = max(free_scores[-1], float(emission[index, token].exp()))
        previous_token = token
    distance, extras = edit_path(expected_tokens, free)
    evidence.update({'freePathCharacters': len(free), 'freePathEditDistance': distance,
                     'freePathErrorRate': distance / len(expected),
                     'minTokenPosterior': min(peaks), 'meanTokenPosterior': sum(peaks) / len(peaks),
                     'maxUnexplainedPosterior': max((free_scores[index] for index in extras), default=0),
                     'minCharScore': min(scores), 'meanCharScore': sum(scores) / len(scores),
                     'candidateOccurrences': occurrences,
                     'confidence': min(peaks)})
    return output, evidence, []


def quality_reasons(evidence):
    reasons = []
    if ((evidence['audioRms'] is not None and evidence['audioRms'] < THRESHOLDS['minAudioRms'])
            or evidence['freePathCharacters'] == 0):
        reasons.append(reason('NO_SPEECH', '该范围没有足够的可验证语音证据。'))
    if evidence['characterCoverage'] != 1:
        reasons.append(reason('MISSING_CHARACTER_TIMES', '已确认原文未获得完整字符覆盖。'))
    if evidence['minTokenPosterior'] is not None and evidence['minTokenPosterior'] < THRESHOLDS['minTokenPosterior']:
        reasons.append(reason('LOW_ACOUSTIC_SUPPORT', '部分原文字符缺少足够声学支持，保留原人工同步点。'))
    if ((evidence['freePathErrorRate'] is not None and evidence['freePathErrorRate'] > THRESHOLDS['maxFreePathErrorRate'])
            or (evidence['maxUnexplainedPosterior'] is not None
                and evidence['maxUnexplainedPosterior'] > THRESHOLDS['maxUnexplainedPosterior'])):
        reasons.append(reason('TEXT_AUDIO_MISMATCH', '声学证据与该段原文不一致，可能漏读、改读或包含额外语音。'))
    if (evidence.get('candidateOccurrences') or 0) > 1:
        reasons.append(reason('AMBIGUOUS_TARGET', '上下文中该段文字出现多次，无法可靠确定本次同步位置。'))
    return reasons


def align_confirmed(aligner, audio, text, offset_ms=0):
    sources = lexical_characters(text)
    unsupported = sorted({source['text'] for source in sources if source['token'] not in aligner.metadata['dictionary']})
    if unsupported:
        return {'characters': [], 'evidence': {**empty_evidence(len(sources)), 'unsupportedCharacters': unsupported},
                'reasons': [reason('UNSUPPORTED_CHARACTERS', '模型词表不支持部分原文字符，未使用通配字符替代。')]}
    if not sources:
        return {'characters': [], 'evidence': empty_evidence(0),
                'reasons': [reason('NO_LEXICAL_TEXT', '该原文段落没有可对齐的文字。')]}
    if len(audio) < 400:
        return {'characters': [], 'evidence': empty_evidence(len(sources)),
                'reasons': [reason('AUDIO_TOO_SHORT', '所选音频短于模型有效输入，未填充或制造字符时间。')]}
    aligned, emission = aligner.align_with_evidence(audio, ''.join(source['token'] for source in sources))
    chars, evidence, reasons = acoustic_evidence(audio, text, aligner.metadata, aligned, emission)
    reasons.extend(quality_reasons(evidence))
    return {'characters': [{**char, 'startMs': offset_ms + char['startMs'], 'endMs': offset_ms + char['endMs']}
                           for char in chars] if not reasons else [],
            'evidence': evidence, 'reasons': reasons, 'nativeAlignment': aligned}


def run_request(args, request):
    cpu_threads = getattr(args, 'cpu_threads', 4)
    configure_cpu_environment(cpu_threads)
    configure_offline_network()
    configure_cache(args.cache, Path(args.ffmpeg).parent, args.resources)
    import os
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    models = load_local_models(args.models)
    pinned = json.loads(Path(__file__).with_name('evaluation-models.json').read_text(encoding='utf-8'))['models']['alignment']
    if any(models['alignment'][key] != pinned[key] for key in ('repository', 'revision')) or not Path(models['alignment']['path']).is_dir():
        raise JobError('RUNTIME_UNAVAILABLE', '中文对齐模型版本与固定组件不符。')
    path, canceled = Path(request['audioPath']), threading.Event()
    if not path.is_file() or hash_file(path, canceled) != request['audioHash']:
        raise JobError('FILE_CHANGED', '音频身份已变化，未对齐或采用结果。')
    decoder = FFmpegDecoder(args.ffmpeg, args.ffprobe, cpu_threads=cpu_threads)
    if request['range']['endMs'] > decoder.duration_ms(path, canceled) + 1:
        raise JobError('INVALID_REQUEST', '原文对齐范围超出原媒体。')
    audio = decoder.decode(path, {'decodeStartMs': request['range']['startMs'],
                                 'decodeEndMs': request['range']['endMs']}, canceled)
    if abs(len(audio) / 16 - (request['range']['endMs'] - request['range']['startMs'])) > 2:
        raise JobError('DECODE_FAILED', '原媒体未完整解码所选上下文，未缩放时间。')
    import torch
    if request['device'] == 'cuda' and not torch.cuda.is_available():
        raise JobError('RUNTIME_UNAVAILABLE', '明确选择的 CUDA 当前不可用，未自动切换设备。')
    configure_torch_threads(cpu_threads)
    from asr_engines import ChineseCTCAligner
    aligner = ChineseCTCAligner(models, request['device'])
    verify_torch_threads(cpu_threads)
    result = align_confirmed(aligner, audio, request['text'], request['range']['startMs'])
    resources = verify_torch_threads(cpu_threads)
    if hash_file(path, canceled) != request['audioHash']:
        raise JobError('FILE_CHANGED', '对齐期间音频身份已变化，结果未采用。')
    result.pop('nativeAlignment', None)
    accepted = not result['reasons']
    return {'protocolVersion': 1, 'type': 'result', 'requestId': request['requestId'],
            'status': 'accepted' if accepted else 'rejected', 'audioHash': request['audioHash'], 'range': request['range'],
            'textSha256': hashlib.sha256(request['text'].encode('utf-8')).hexdigest(), 'contract': CONTRACT,
            'ctcContract': CTC_ALIGNMENT_CONTRACT, 'qualityPolicy': QUALITY_POLICY,
            'thresholds': THRESHOLDS, 'device': request['device'], **result,
            'executionResources': resources,
            **({'startMs': result['characters'][0]['startMs'], 'endMs': result['characters'][-1]['endMs'],
                'confidence': result['evidence']['minTokenPosterior']} if accepted else {})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('models', 'resources', 'ffmpeg', 'ffprobe', 'cache'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--cpu-threads', type=int, choices=CPU_THREAD_CHOICES, default=4)
    args = parser.parse_args()
    identity = None
    started = time.perf_counter()
    try:
        protect_worker_process()
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not raw or len(raw) > MAX_REQUEST_BYTES:
            raise JobError('INVALID_REQUEST', '原文对齐请求为空或超过 64 KiB。')
        request = parse_request(json.loads(raw))
        identity = request['requestId']
        with redirect_stdout(sys.stderr):
            result = run_request(args, request)
        result['elapsedMs'] = round((time.perf_counter() - started) * 1000)
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        result = {'protocolVersion': 1, 'type': 'error', 'requestId': identity,
                  'code': error.code if isinstance(error, JobError) else 'ALIGNMENT_FAILED',
                  'message': str(error) if isinstance(error, JobError) else '原文声学对齐未完成，原人工同步点保留。'}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
