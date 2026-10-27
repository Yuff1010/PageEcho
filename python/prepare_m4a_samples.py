"""Opt-in original published M4A narration for player compatibility checks.

These English recordings provide format evidence, not Chinese ASR references.
Publisher size/SHA-1/MD5 are pinned; no transcoding or extension changes occur.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request
import uuid

from prepare_audiobook_samples import hashes

SOURCES = [
    {
        'item': 'AudiobookSample', 'name': 'Audiobook Sample.m4a',
        'title': 'Audiobook Sample', 'creator': 'Nicolette Chinomona',
        'sizeBytes': 2865118, 'sha1': '0b38928d98ee8aeedf8571f236fbb2d70269d13f',
        'md5': '92cd205cba2fa4b7f5235af283d511c5',
        'publisherLicenseUrl': 'http://creativecommons.org/publicdomain/mark/1.0/',
    },
    {
        'item': 'HardSpeed', 'name': 'HardSpeed.m4a',
        'title': 'Hard Speed', 'creator': 'Chris Uphues; read by Mike Fleming',
        'sizeBytes': 98713356, 'sha1': 'cfe23a88ff5fc750eee5012460d3bb5f3fdc1f22',
        'md5': '4b6387d259143c24b585f3ad56686c00',
        'publisherLicenseUrl': 'http://creativecommons.org/publicdomain/zero/1.0/',
    },
]


def obtain(root, source, download):
    target = root / source['name']
    url = f"https://archive.org/download/{source['item']}/{urllib.parse.quote(source['name'])}"
    if not target.exists():
        if not download:
            raise ValueError(f'Missing {target.name}; use --download for the pinned source')
        temporary = root / f'{target.name}.{uuid.uuid4()}.part'
        received = 0
        try:
            with urllib.request.urlopen(url, timeout=30) as response, temporary.open('xb') as output:
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > source['sizeBytes']:
                        raise ValueError('Download exceeds publisher file size')
                    output.write(block)
            actual = hashes(temporary)
            if received != source['sizeBytes'] or any(actual[key] != source[key] for key in ('sha1', 'md5')):
                raise ValueError('Download differs from pinned publisher size/digests')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    actual = hashes(target)
    if target.stat().st_size != source['sizeBytes'] or any(actual[key] != source[key] for key in ('sha1', 'md5')):
        raise ValueError(f'Cached source changed: {target.name}')
    return {**source, **actual, 'sourcePath': str(target), 'url': url,
            'metadataUrl': f"https://archive.org/metadata/{source['item']}",
            'catalog': f"https://archive.org/details/{source['item']}",
            'category': 'published-english-narration', 'referenceTranscript': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--output', default='cache/asr-evaluation/m4a-source')
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    tracks = []
    for source in SOURCES:
        track = obtain(root, source, args.download)
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        probe = json.loads(subprocess.run([
            args.ffprobe, '-v', 'error', '-show_entries',
            'format=format_name,duration:stream=index,codec_type,codec_name,profile,sample_rate,channels:chapter=id,start_time,end_time:chapter_tags=title',
            '-of', 'json', track['sourcePath'],
        ], capture_output=True, text=True, encoding='utf-8', check=True, timeout=30, **flags).stdout)
        duration_ms = round(float(probe['format']['duration']) * 1000)
        if duration_ms <= 0 or not any(stream['codec_type'] == 'audio' for stream in probe['streams']):
            raise ValueError('Expected a real audio stream with a positive duration')
        tracks.append({**track, 'durationMs': duration_ms, 'probe': probe})
        print(json.dumps({'stage': 'source-verified', 'name': track['name'],
                          'durationMs': duration_ms, 'streams': probe['streams']}), flush=True)
    manifest = {'version': 1, 'preparedAt': datetime.now(timezone.utc).isoformat(),
                'status': 'prepared', 'catalog': 'https://archive.org/details/HardSpeed',
                'selection': 'original publisher M4A uploads, unchanged encoding and extensions',
                'referencePolicy': 'English format checks only; no Chinese ASR or human quality claim',
                'tracks': tracks}
    path = root / 'manifest.json'
    if path.exists():
        existing = json.loads(path.read_text(encoding='utf-8'))
        manifest['preparedAt'] = existing.get('preparedAt')
        if existing != manifest:
            raise ValueError('Existing manifest differs; preserve it and choose another output directory')
    else:
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'prepared', 'manifest': str(path)}), flush=True)


if __name__ == '__main__':
    main()
