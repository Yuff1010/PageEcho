"""Opt-in published Mandarin audiobook sources for actual-format/long-input tests.

Files retain the publisher's encoding. Neither the book text nor an ASR output
is accepted as a manually verified transcript for these recordings.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import uuid

ITEM = 'call_to_arms_jl_librivox'
CATALOG = 'https://librivox.org/call-to-arms-by-xun-lu/'
FILES = [
    ('calltoarms_01_lu.mp3', 11135278, '6610707ef6ddbd7373a9a8e7f0abcff473e5c7d2', '125bf4f65baf666fa8b3b013438a6f4d', '《呐喊》自序'),
    ('calltoarms_06_lu.mp3', 4208942, '4d27b7e3691f30076d3f72e5d11bce30f330d046', 'a284f268bc8edee002d12ae1ccfe5864', '一件小事'),
    ('calltoarms_10_lu.mp3', 41505070, '73bfa18755553270d21ea824fa0eb732bdcaba20', 'f9db4e4788e071dc4855b9419d1ed6ff', '阿Q正传，第一部分'),
    ('chinesecallToArms_librivox.m4b', 134170229, '0d9cc554084ec293a717d68d2265cbcd343d0488', '352a85db7ab40a6358812c6555132feb', '《呐喊》整书'),
]


def hashes(path):
    values = {name: hashlib.new(name) for name in ('sha256', 'sha1', 'md5')}
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            for value in values.values():
                value.update(block)
    return {name: value.hexdigest() for name, value in values.items()}


def obtain(root, entry, download):
    name, size, sha1, md5, title = entry
    target = root / name
    url = f'https://archive.org/download/{ITEM}/{name}'
    if not target.exists():
        if not download:
            raise ValueError(f'Missing {name}; --download explicitly fetches the pinned published source')
        temporary = root / f'{name}.{uuid.uuid4()}.part'
        received = 0
        try:
            with urllib.request.urlopen(url, timeout=30) as response, temporary.open('xb') as output:
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > size:
                        raise ValueError('Download exceeds the pinned file size')
                    output.write(block)
            result = hashes(temporary)
            if received != size or result['sha1'] != sha1 or result['md5'] != md5:
                raise ValueError('Publisher file size/digests differ from the pinned source')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    result = hashes(target)
    if target.stat().st_size != size or result['sha1'] != sha1 or result['md5'] != md5:
        raise ValueError(f'Cached published source changed: {name}')
    print(json.dumps({'stage': 'source-verified', 'name': name, 'bytes': size}), flush=True)
    return {'name': name, 'title': title, 'sourcePath': str(target), 'sizeBytes': size,
            'modifiedAt': target.stat().st_mtime_ns / 1000000, 'url': url, **result,
            'category': 'published-mandarin-narration', 'referenceTranscript': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--output', default='cache/asr-evaluation/audiobook-source')
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    tracks = []
    for entry in FILES:
        track = obtain(root, entry, args.download)
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        metadata = json.loads(subprocess.run([
            args.ffprobe, '-v', 'error', '-show_entries',
            'format=format_name,duration:stream=index,codec_type,codec_name,profile,sample_rate,channels:chapter=id,start_time,end_time:chapter_tags=title',
            '-of', 'json', track['sourcePath'],
        ], capture_output=True, text=True, encoding='utf-8', check=True, timeout=30, **flags).stdout)
        duration_ms = round(float(metadata['format']['duration']) * 1000)
        if duration_ms <= 0 or not any(stream['codec_type'] == 'audio' for stream in metadata['streams']):
            raise ValueError('Expected a real audio stream and duration')
        tracks.append({**track, 'durationMs': duration_ms, 'probe': metadata})
    report = {'version': 1, 'preparedAt': datetime.now(timezone.utc).isoformat(), 'status': 'prepared',
              'catalog': CATALOG, 'archiveItem': f'https://archive.org/details/{ITEM}',
              'metadataUrl': f'https://archive.org/metadata/{ITEM}',
              'license': 'Public Domain Mark 1.0 on the publisher archive item; LibriVox labels recordings public domain in the USA',
              'licenseUrl': 'https://creativecommons.org/publicdomain/mark/1.0/',
              'attribution': 'Lu Xun, Call to Arms; read in Chinese by Jing Li; LibriVox, 2012',
              'selection': 'original published chapter 01, short chapter 06, longer chapter 10, and whole-book M4B; no transcoding/renaming to supply missing formats',
              'referencePolicy': 'no human audio transcript or speech boundaries verified; do not compute audiobook accuracy/CER from written book text or model output',
              'tracks': tracks}
    (root / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'prepared', 'tracks': len(tracks), 'manifest': str(root / 'manifest.json')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
