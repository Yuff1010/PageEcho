"""Prepare/verify continuous, human-transcribed multi-window AISHELL-4 clips.

Selection uses only the pinned annotation, before ASR. Audio remains continuous:
channel 0, mono PCM16/16 kHz, no concatenation, inserted silence or denoising.
"""

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import subprocess
import uuid
import wave

from asr_metrics import normalize_text
from public_reference import ASSETS, RECORDING, REVISION, digest, textgrid_intervals, verified_asset

SELECTION = ('first eligible solo, first disjoint multi-speaker window, then first disjoint solo with another speaker; '
             'source-time order, 90-120 s including up to 250 ms edge context; no intersecting/partial turns or '
             'markup except <sil>; at least 180 normalized characters and two 30-second cuts inside labeled speech by 250 ms')


def clean_text(text):
    text = text.replace('<sil>', '')
    return None if re.search(r'[<>&]', text) else text


def eligible_windows(intervals, duration_ms):
    for index, first in enumerate(intervals):
        start = max(0, math.floor(first['startMs']) - 250)
        for last in intervals[index:]:
            if last['endMs'] - start < 90000:
                continue
            if last['endMs'] - start > 120000:
                break
            next_start = min((turn['startMs'] for turn in intervals if turn['startMs'] >= last['endMs']), default=duration_ms)
            end = min(math.ceil(last['endMs']) + 250, math.floor(next_start), math.floor(duration_ms))
            turns = [turn for turn in intervals if turn['startMs'] < end and turn['endMs'] > start]
            if (not 90000 <= end - start <= 120000 or
                    any(turn['startMs'] < start or turn['endMs'] > end or clean_text(turn['text']) is None for turn in turns) or
                    any(b['startMs'] < a['endMs'] for a, b in zip(turns, turns[1:]))):
                continue
            seams = [seam for seam in range(start + 30000, end, 30000)
                     if any(turn['startMs'] + 250 < seam < turn['endMs'] - 250 for turn in turns)]
            if len(seams) < 2 or len(normalize_text(''.join(clean_text(turn['text']) for turn in turns))) < 180:
                continue
            yield {'sourceStartMs': start, 'sourceEndMs': end, 'turns': turns,
                   'speakers': sorted({turn['speaker'] for turn in turns}),
                   'speechSeamsMs': [seam - start for seam in seams]}
            break


def select_windows(intervals, duration_ms):
    candidates = list(eligible_windows(intervals, duration_ms))
    selected = []

    def disjoint(candidate):
        return all(candidate['sourceEndMs'] <= old['sourceStartMs'] or candidate['sourceStartMs'] >= old['sourceEndMs']
                   for old in selected)

    for role in ('solo-first', 'dialogue-first', 'solo-other'):
        matches = [candidate for candidate in candidates if disjoint(candidate) and
                   (len(candidate['speakers']) >= 2 if role == 'dialogue-first' else len(candidate['speakers']) == 1) and
                   (role != 'solo-other' or candidate['speakers'] != selected[0]['speakers'])]
        if not matches:
            raise ValueError(f'No eligible continuous reference for {role}; selection rules are not relaxed')
        selected.append({**matches[0], 'role': role})
    return selected


def expected_sample(candidate):
    start, end = candidate['sourceStartMs'], candidate['sourceEndMs']
    return {'id': f"continuous-{candidate['role']}", 'sourceOffsetMs': start, 'durationMs': end - start,
            'speaker': '+'.join(candidate['speakers']), 'speakers': candidate['speakers'],
            'category': 'human-continuous-speaker-turns' if len(candidate['speakers']) > 1 else 'human-continuous-solo',
            'speechSeamsMs': candidate['speechSeamsMs'],
            'reference': [{'id': turn['id'], 'speaker': turn['speaker'], 'startMs': turn['startMs'] - start,
                           'endMs': turn['endMs'] - start, 'text': clean_text(turn['text'])} for turn in candidate['turns']]}


def load_continuous_manifest(path):
    path = Path(path).resolve()
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or manifest.get('referenceKind') != 'human-continuous' or manifest.get('selection') != SELECTION:
        raise ValueError('Unexpected continuous reference contract')
    source = manifest['source']
    if (source['revision'] != REVISION or source['audioSha256'] != ASSETS['flac'][1] or
            source['annotationSha256'] != ASSETS['TextGrid'][1]):
        raise ValueError('Continuous reference source changed')
    root = Path(source['path']).parent
    verified_asset(root, 'flac', False)
    annotation, _ = verified_asset(root, 'TextGrid', False)
    domain, intervals = textgrid_intervals(annotation.read_text(encoding='utf-8-sig'))
    expected = [expected_sample(candidate) for candidate in select_windows(intervals, domain)]
    if len(manifest['samples']) != len(expected):
        raise ValueError('Continuous selection length changed')
    for sample, selected in zip(manifest['samples'], expected):
        if any(sample.get(key) != value for key, value in selected.items()):
            raise ValueError('Continuous selection, transcript or human boundaries changed')
        if digest(sample['path']) != sample['audioHash']:
            raise ValueError('Continuous audio version changed')
        with wave.open(sample['path'], 'rb') as audio:
            if ((audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 16000, 2) or
                    abs(audio.getnframes() / 16 - sample['durationMs']) > 0.1):
                raise ValueError('Continuous audio format/duration changed')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default='cache/asr-evaluation/public-reference/aishell4')
    parser.add_argument('--output', default='cache/asr-evaluation/public-reference/aishell4-continuous')
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    args = parser.parse_args()
    root, output = Path(args.source).resolve(), Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = output / 'manifest.json'
    if target.exists():
        checked = load_continuous_manifest(target)
        print(json.dumps({'status': 'verified-existing', 'samples': len(checked['samples']), 'manifest': str(target)}), flush=True)
        return
    source, audio_url = verified_asset(root, 'flac', False)
    annotation, annotation_url = verified_asset(root, 'TextGrid', False)
    duration, intervals = textgrid_intervals(annotation.read_text(encoding='utf-8-sig'))
    chosen = select_windows(intervals, duration)
    samples = []
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    for candidate in chosen:
        sample = expected_sample(candidate)
        destination = output / f"{sample['id']}.wav"
        temporary = output / f'{uuid.uuid4()}.part.wav'
        try:
            subprocess.run([args.ffmpeg, '-nostdin', '-v', 'error', '-n',
                            '-ss', str(sample['sourceOffsetMs'] / 1000), '-protocol_whitelist', 'file,pipe', '-i', str(source),
                            '-t', str(sample['durationMs'] / 1000), '-af', 'pan=mono|c0=c0', '-ar', '16000',
                            '-c:a', 'pcm_s16le', str(temporary)], check=True, capture_output=True, timeout=60, **flags)
            if destination.exists():
                if digest(destination) != digest(temporary):
                    raise ValueError('Existing derived audio differs; use a new output directory')
            else:
                temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        samples.append({**sample, 'path': str(destination), 'audioHash': digest(destination)})
    legacy = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['source']
    manifest = {'version': 1, 'referenceKind': 'human-continuous', 'preparedAt': datetime.now(timezone.utc).isoformat(),
                'selection': SELECTION, 'source': {**legacy, 'path': str(source), 'audioUrl': audio_url,
                                                  'annotationUrl': annotation_url,
                                                  'modifications': 'continuous source spans, channel 0, mono PCM16/16 kHz; no concatenation, silence insertion or denoising'},
                'qualityScope': 'three disjoint spans from one already-used far-field recording, not official corpus protocol or clean audiobook quality; training overlap unknown; human utterance endpoints are not phoneme labels',
                'samples': samples, 'tools': {'ffmpeg': str(Path(args.ffmpeg).resolve()), 'ffprobe': str(Path(args.ffprobe).resolve())}}
    temporary = output / f'{uuid.uuid4()}.manifest.tmp'
    try:
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        load_continuous_manifest(temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({'status': 'prepared', 'manifest': str(target), 'sha256': digest(target),
                      'samples': [{key: sample[key] for key in ('id', 'sourceOffsetMs', 'durationMs', 'speakers', 'speechSeamsMs')}
                                  for sample in samples]}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
