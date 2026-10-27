"""Opt-in AISHELL-4 reference preparation; downloaded data never enters source control.

This is a small diagnostic subset, not the official AISHELL evaluation protocol.
The fixed recording and annotation are selected before any model is run.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import urllib.request
import uuid
import wave

REVISION = 'aada72727856313b19d4a030383c426364931dbf'
RECORDING = 'S_R004S03C01'
ASSETS = {
    'flac': (235113956, 'c21ce5ce455b87926ca6b486431db2889de5d14be91b55f8cffea31cd94c1262', 'wav'),
    'TextGrid': (75321, 'ca515d60e370362aebbf481c465dadc0b8f0f0dc6eeb125845edd09f17cee3d3', 'TextGrid'),
}


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verified_asset(directory, extension, allow_download):
    size, expected, folder = ASSETS[extension]
    target = directory / f'{RECORDING}.{extension}'
    url = f'https://huggingface.co/datasets/AISHELL/AISHELL-4/resolve/{REVISION}/test/{folder}/{target.name}'
    if target.exists():
        if target.stat().st_size != size or digest(target) != expected:
            raise ValueError(f'Existing asset failed its pinned hash: {target.name}')
        return target, url
    if not allow_download:
        raise ValueError(f'Missing {target.name}; use --download to fetch the pinned public asset')
    temporary = target.with_name(f'{target.name}.{uuid.uuid4()}.part')
    received = 0
    try:
        with urllib.request.urlopen(url, timeout=30) as response, temporary.open('xb') as output:
            while block := response.read(1024 * 1024):
                received += len(block)
                if received > size:
                    raise ValueError('Download exceeds pinned asset size')
                output.write(block)
        if received != size or digest(temporary) != expected:
            raise ValueError('Download failed its pinned size/SHA-256')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, url


def textgrid_intervals(text):
    """Read numeric/string/flag data from the pinned Praat interval TextGrid.

    Supports long/short text, doubled quotes and ! comments. Point tiers,
    binary files and malformed/ambiguous annotations are deliberately refused.
    """
    tokens = []
    scanner = re.compile(r'"(?:""|[^"])*"|![^\r\n]*|[^\s]+')
    for match in scanner.finditer(text.lstrip('\ufeff')):
        value = match.group()
        if value.startswith('!'):
            continue
        if value.startswith('"'):
            if len(value) < 2 or not value.endswith('"'):
                raise ValueError('Unterminated TextGrid string')
            tokens.append(value[1:-1].replace('""', '"'))
        elif value in ('<exists>', '<absent>'):
            tokens.append(value)
        elif re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', value):
            tokens.append(float(value))
    cursor = iter(tokens)

    def take_number():
        value = next(cursor)
        if not isinstance(value, float) or not math.isfinite(value):
            raise ValueError('Expected a finite TextGrid number')
        return value

    def count():
        value = take_number()
        if not value.is_integer() or not 0 <= value <= 100000:
            raise ValueError('Invalid TextGrid count')
        return int(value)

    try:
        if next(cursor) != 'ooTextFile' or next(cursor) != 'TextGrid':
            raise ValueError('Expected a text TextGrid')
        start, end = take_number(), take_number()
        if start != 0 or end <= start or next(cursor) != '<exists>':
            raise ValueError('Invalid TextGrid time domain')
        intervals, speakers = [], set()
        for _ in range(count()):
            if next(cursor) != 'IntervalTier':
                raise ValueError('Only interval tiers are supported')
            speaker = next(cursor)
            if not isinstance(speaker, str) or not speaker or speaker in speakers:
                raise ValueError('Invalid/duplicate speaker tier')
            speakers.add(speaker)
            if take_number() != start or take_number() != end:
                raise ValueError('Tier and recording domains disagree')
            previous = start
            for index in range(count()):
                left, right, value = take_number(), take_number(), next(cursor)
                if not isinstance(value, str) or left != previous or not left < right <= end:
                    raise ValueError('Invalid/non-adjacent TextGrid intervals')
                previous = right
                if value.strip():
                    intervals.append({'id': f'{speaker}-{index + 1}', 'speaker': speaker,
                                      'startMs': left * 1000, 'endMs': right * 1000, 'text': value})
            if previous != end:
                raise ValueError('Incomplete tier time domain')
        if list(cursor):
            raise ValueError('Trailing TextGrid data')
        return end * 1000, sorted(intervals, key=lambda item: (item['startMs'], item['speaker']))
    except StopIteration:
        raise ValueError('Truncated TextGrid') from None


def select_reference_turns(intervals, duration_ms, per_speaker=3):
    """First eligible three turns per speaker, selected without model output.

    Keep audible filler words; remove only the explicit <sil> marker. Reject
    other event/uncertainty markup and every crop intersecting another turn.
    """
    counts, selected = {}, []
    for item in intervals:
        text = item['text'].replace('<sil>', '')
        characters = ''.join(char for char in text if char.isalnum())
        if re.search(r'[<>&]', text) or not 12 <= len(characters) <= 200:
            continue
        if not 2000 <= item['endMs'] - item['startMs'] <= 15000:
            continue
        speaker = item['speaker']
        if counts.get(speaker, 0) >= per_speaker:
            continue
        others = [other for other in intervals if other is not item]
        if any(other['startMs'] < item['endMs'] and other['endMs'] > item['startMs'] for other in others):
            continue
        previous_end = max((other['endMs'] for other in others if other['endMs'] <= item['startMs']), default=0)
        following_start = min((other['startMs'] for other in others if other['startMs'] >= item['endMs']), default=duration_ms)
        start = max(0, math.floor(item['startMs']) - 250, math.ceil(previous_end))
        end = min(math.floor(duration_ms), math.ceil(item['endMs']) + 250, math.floor(following_start))
        if start > item['startMs'] or end < item['endMs']:
            continue
        if any(other is not item and other['startMs'] < end and other['endMs'] > start for other in intervals):
            continue
        selected.append({**item, 'text': text, 'cropStartMs': start, 'cropEndMs': end})
        counts[speaker] = counts.get(speaker, 0) + 1
    if set(counts) != {item['speaker'] for item in intervals} or min(counts.values()) != per_speaker:
        raise ValueError('Not enough eligible isolated reference turns for every speaker')
    return selected


def load_reference_manifest(path):
    """Verify the diagnostic's original assets and every derived audio version."""
    path = Path(path).resolve()
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or not isinstance(manifest.get('samples'), list) or not manifest['samples']:
        raise ValueError('Invalid reference manifest')
    source = manifest['source']
    if (source['revision'] != REVISION or source['audioSha256'] != ASSETS['flac'][1]
            or source['annotationSha256'] != ASSETS['TextGrid'][1]):
        raise ValueError('Unexpected reference source version')
    verified_asset(path.parent, 'flac', False)
    annotation, _ = verified_asset(path.parent, 'TextGrid', False)
    domain, intervals = textgrid_intervals(annotation.read_text(encoding='utf-8-sig'))
    expected_turns = select_reference_turns(intervals, domain)
    if len(manifest['samples']) != len(expected_turns):
        raise ValueError('Reference selection changed')
    ids = set()
    for sample, turn in zip(manifest['samples'], expected_turns):
        if sample['id'] in ids or not re.fullmatch(r'[a-zA-Z0-9-]+', sample['id']):
            raise ValueError('Duplicate/invalid sample ID')
        ids.add(sample['id'])
        if digest(sample['path']) != sample['audioHash']:
            raise ValueError('Reference audio hash changed')
        with wave.open(sample['path'], 'rb') as audio:
            if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 16000, 2):
                raise ValueError('Reference audio format changed')
            duration = audio.getnframes() / 16
        if len(sample['reference']) != 1:
            raise ValueError('Only isolated single-turn references are supported')
        item = sample['reference'][0]
        if not 0 <= item['startMs'] < item['endMs'] <= duration or not item['text'].strip():
            raise ValueError('Invalid human reference time/text')
        if (sample['offsetMs'] != 0 or sample['id'] != f"aishell4-{turn['id']}" or sample['speaker'] != turn['speaker']
                or sample['sourceOffsetMs'] != turn['cropStartMs']
                or abs(duration - (turn['cropEndMs'] - turn['cropStartMs'])) > 0.1
                or item != {'id': turn['id'], 'startMs': turn['startMs'] - turn['cropStartMs'],
                            'endMs': turn['endMs'] - turn['cropStartMs'], 'text': turn['text']}):
            raise ValueError('Reference text, boundary or selection differs from the pinned human annotation')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--output', default='cache/asr-evaluation/public-reference/aishell4')
    args = parser.parse_args()
    directory = Path(args.output).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    source, audio_url = verified_asset(directory, 'flac', args.download)
    annotation, annotation_url = verified_asset(directory, 'TextGrid', args.download)
    duration, intervals = textgrid_intervals(annotation.read_text(encoding='utf-8-sig'))
    turns = select_reference_turns(intervals, duration)
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if __import__('os').name == 'nt' else {}
    probe = json.loads(subprocess.run([args.ffprobe, '-v', 'error', '-show_entries',
                                      'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', str(source)],
                                     check=True, capture_output=True, text=True, timeout=30, **flags).stdout)
    if abs(float(probe['format']['duration']) * 1000 - duration) > 100:
        raise ValueError('Recording and annotation durations disagree')
    samples = []
    for turn in turns:
        target = directory / f"turn-{turn['id']}.wav"
        start, end = turn['cropStartMs'], turn['cropEndMs']
        subprocess.run([args.ffmpeg, '-v', 'error', '-nostdin', '-y', '-ss', str(start / 1000), '-i', str(source),
                        '-t', str((end - start) / 1000), '-af', 'pan=mono|c0=c0', '-ar', '16000', '-c:a', 'pcm_s16le', str(target)],
                       check=True, capture_output=True, timeout=30, **flags)
        samples.append({'id': f"aishell4-{turn['id']}", 'audioHash': digest(target), 'path': str(target),
                        'offsetMs': 0, 'sourceOffsetMs': start, 'speaker': turn['speaker'],
                        'category': 'human-far-field-isolated-turn',
                        'reference': [{'id': turn['id'], 'startMs': turn['startMs'] - start,
                                       'endMs': turn['endMs'] - start, 'text': turn['text']}],
                        'referenceType': 'published human utterance annotation; not phoneme-level alignment'})
    output = {'version': 1, 'preparedAt': datetime.now(timezone.utc).isoformat(),
              'source': {'dataset': 'AISHELL-4', 'recording': RECORDING, 'revision': REVISION,
                         'audioUrl': audio_url, 'annotationUrl': annotation_url,
                         'audioSha256': ASSETS['flac'][1], 'annotationSha256': ASSETS['TextGrid'][1],
                         'durationMs': duration, 'path': str(source), 'probe': probe,
                         'license': 'CC BY-SA 4.0 per OpenSLR 111; HF metadata says Apache-2.0',
                         'licenseSource': 'https://www.openslr.org/111/',
                         'attribution': 'Yihui Fu et al., AISHELL-4, Interspeech 2021; Beijing Shell Shell Technology Co.,Ltd',
                         'modifications': 'channel 0 only, mono PCM16 16 kHz; selected turns with up to 250 ms context, limited by neighboring annotations'},
              'selection': 'first three eligible turns per speaker in source-time order; 2–15 s, 12–200 letters/numbers; no other labeled turn intersects the crop; context limited to labeled silence; only <sil> removed, other markup excluded',
              'qualityScope': 'small diagnostic subset, not official corpus CER; model training-set overlap unknown; far-field meeting turns are not clean audiobook narration',
              'samples': samples}
    (directory / 'manifest.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'prepared', 'samples': len(samples), 'speakers': sorted({item['speaker'] for item in samples}),
                      'manifest': str(directory / 'manifest.json')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
