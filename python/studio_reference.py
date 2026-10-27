"""Pinned original AISHELL-3 sample: all published test WAVs, human text only.

This is quiet scripted speech, including short entities and number strings.
No human speech/phoneme timestamps are supplied or inferred.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
import uuid
import wave

ARCHIVE_URL = 'https://aishell-3.oss-cn-beijing.aliyuncs.com/AISHELL-3-Sample.rar'
ARCHIVE_SIZE = 75587143
ARCHIVE_SHA256 = '4879c25bc00da3477e34ae2d8fd0496112835958f63fb18a4e2f7ed8753c0343'
ARCHIVE_MD5 = 'b810013b026719c0f4ff58b15a250601'
ANNOTATION = 'AISHELL-3-Sample/test/content.txt'
SELECTION = 'all original WAV entries in the publisher sample test/ split, sorted by utterance ID; no duration, text-length or ASR-result filtering'
REFERENCE_TYPE = 'published manually transcribed utterance text; no human timestamps'


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def verify_archive(path):
    path = Path(path).resolve()
    if path.stat().st_size != ARCHIVE_SIZE or digest(path) != ARCHIVE_SHA256:
        raise ValueError('Publisher AISHELL-3 sample archive changed')
    return path


def obtain_archive(path, download):
    path = Path(path).resolve()
    if not path.exists():
        if not download:
            raise ValueError('Missing publisher archive; --download explicitly fetches the pinned sample')
        temporary = path.with_name(f'{path.name}.{uuid.uuid4()}.part')
        try:
            received = 0
            with urllib.request.urlopen(ARCHIVE_URL, timeout=30) as response, temporary.open('xb') as output:
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > ARCHIVE_SIZE:
                        raise ValueError('Publisher sample exceeds pinned size')
                    output.write(block)
            verify_archive(temporary)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return verify_archive(path)


def run(command, maximum=16 * 1024 * 1024):
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    result = subprocess.run([str(value) for value in command], capture_output=True, check=True, timeout=30, **flags).stdout
    if len(result) > maximum:
        raise ValueError('Unexpectedly large source member/decoded sample')
    return result


def member(reader, archive, name):
    return run([reader, '-xOf', archive, name])


def parse_content(content):
    rows = {}
    for line in content.decode('utf-8-sig').splitlines():
        if not line.strip():
            continue
        filename, payload = line.split('\t', 1)
        if not re.fullmatch(r'SSB\d{8}\.wav', filename) or filename in rows:
            raise ValueError('Duplicate/invalid studio utterance filename')
        tokens = payload.split()
        if not tokens or len(tokens) % 2:
            raise ValueError('Expected paired Chinese-character and pinyin annotations')
        text = tokens[::2]
        if (any(not re.fullmatch(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]', char) for char in text) or
                any(not re.fullmatch(r'[a-zA-ZüÜv:]+[0-5]', phone) for phone in tokens[1::2])):
            raise ValueError('Unexpected human annotation token; do not silently remove it')
        rows[filename] = {'text': ''.join(text), 'pinyin': tokens[1::2]}
    return rows


def source_rows(reader, archive):
    listing = run([reader, '-tf', archive]).decode('utf-8').splitlines()
    annotation = member(reader, archive, ANNOTATION)
    labels = parse_content(annotation)
    entries = {}
    for name in listing:
        match = re.fullmatch(r'AISHELL-3-Sample/test/(SSB\d{4})/(SSB\d{8}\.wav)', name)
        if not match:
            continue
        speaker, filename = match.groups()
        if not filename.startswith(speaker) or filename in entries:
            raise ValueError('Studio entry speaker/identity is inconsistent')
        entries[filename] = {'entry': name, 'speaker': speaker, **labels[filename]}
    if not entries or set(entries) != set(labels):
        raise ValueError('Published test WAVs and human annotation do not match exactly')
    return annotation, [(name, entries[name]) for name in sorted(entries)]


def pcm(ffmpeg, path):
    return run([ffmpeg, '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
                '-i', path, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'])


def duration_ms(ffprobe, path):
    probe = json.loads(run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path]))
    return round(float(probe['format']['duration']) * 1000)


def expected_reference(filename, row):
    identifier = filename.removesuffix('.wav')
    return {'id': f'aishell3-{identifier}', 'speaker': row['speaker'], 'originalEntry': row['entry'],
            'reference': [{'id': identifier, 'text': row['text']}], 'pinyin': row['pinyin'],
            'referenceType': REFERENCE_TYPE, 'offsetMs': 0,
            'category': 'numeric-characters-only' if re.fullmatch('[一二三四五六七八九十百千万亿零〇幺两洞拐勾]+', row['text']) else 'other-scripted-studio'}


def load_studio_manifest(path):
    path = Path(path).resolve()
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if (manifest.get('version') != 1 or manifest.get('referenceKind') != 'human-studio-text' or
            manifest.get('selection') != SELECTION or manifest['source'].get('archiveSha256') != ARCHIVE_SHA256):
        raise ValueError('Unexpected studio reference contract/source')
    archive = verify_archive(manifest['source']['archivePath'])
    tools = manifest['tools']
    for name in ('ffmpeg', 'ffprobe'):
        if digest(tools[name]['path']) != tools[name]['sha256']:
            raise ValueError('Studio preparation tool changed')
    annotation, rows = source_rows(tools['archiveReader'], archive)
    if hashlib.sha256(annotation).hexdigest() != manifest['source']['annotationSha256'] or len(manifest['samples']) != len(rows):
        raise ValueError('Studio reference annotation/selection changed')
    for sample, (filename, row) in zip(manifest['samples'], rows):
        if any(sample.get(key) != value for key, value in expected_reference(filename, row).items()):
            raise ValueError('Studio human text, identity or selection changed')
        original = path.parent / 'original' / filename
        target = path.parent / 'pcm16' / filename
        if (Path(sample['sourcePath']).resolve() != original or Path(sample['path']).resolve() != target or
                digest(original) != hashlib.sha256(member(tools['archiveReader'], archive, row['entry'])).hexdigest() or
                digest(original) != sample['sourceSha256'] or digest(target) != sample['audioHash']):
            raise ValueError('Studio original/normalized audio version changed')
        expected_pcm = pcm(tools['ffmpeg']['path'], original)
        with wave.open(str(target), 'rb') as audio:
            if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth(), audio.getcomptype()) != (1, 16000, 2, 'NONE'):
                raise ValueError('Studio derived audio format changed')
            if audio.readframes(audio.getnframes()) != expected_pcm or audio.getnframes() != sample['frames']:
                raise ValueError('Studio audio is not the pinned full-utterance resample')
        if duration_ms(tools['ffprobe']['path'], target) != sample['durationMs']:
            raise ValueError('Studio media duration changed')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--archive')
    parser.add_argument('--archive-reader', default=str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/tar.exe'))
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--output', default='cache/asr-evaluation/public-reference/aishell3-studio')
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / 'manifest.json'
    if path.exists():
        manifest = load_studio_manifest(path)
        print(json.dumps({'status': 'verified-existing', 'samples': len(manifest['samples']), 'manifest': str(path)}), flush=True)
        return
    if any((root / name).exists() for name in ('original', 'pcm16')):
        raise ValueError('Incomplete studio assets already exist; preserve them and choose a new output directory')
    archive = obtain_archive(args.archive or root / 'AISHELL-3-Sample.rar', args.download)
    reader = str(Path(args.archive_reader).resolve())
    ffmpeg, ffprobe = str(Path(args.ffmpeg).resolve()), str(Path(args.ffprobe).resolve())
    annotation, rows = source_rows(reader, archive)
    (root / 'original').mkdir(exist_ok=True)
    (root / 'pcm16').mkdir(exist_ok=True)
    samples = []
    for filename, row in rows:
        original, target = root / 'original' / filename, root / 'pcm16' / filename
        original.write_bytes(member(reader, archive, row['entry']))
        converted = pcm(ffmpeg, original)
        with wave.open(str(target), 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            audio.writeframes(converted)
        samples.append({**expected_reference(filename, row), 'sourcePath': str(original), 'sourceSha256': digest(original),
                        'path': str(target), 'audioHash': digest(target), 'frames': len(converted) // 2,
                        'durationMs': duration_ms(ffprobe, target)})
    manifest = {'version': 1, 'referenceKind': 'human-studio-text', 'preparedAt': datetime.now(timezone.utc).isoformat(),
                'selection': SELECTION, 'source': {'dataset': 'AISHELL-3 publisher sample test split',
                'archiveUrl': ARCHIVE_URL, 'archivePath': str(archive), 'archiveSha256': ARCHIVE_SHA256,
                'archiveSizeBytes': ARCHIVE_SIZE, 'archiveMd5': ARCHIVE_MD5,
                'annotationEntry': ANNOTATION, 'annotationSha256': hashlib.sha256(annotation).hexdigest(),
                'publisherPage': 'https://www.aishelltech.com/newsitem/278532347',
                'paper': 'https://www.isca-archive.org/interspeech_2021/shi21c_interspeech.pdf',
                'licenseSources': ['https://www.openslr.org/93/', 'https://www.aishelltech.com/aishell_3'],
                'licenseNotes': 'OpenSLR says Apache-2.0; publisher page also lists CC BY-NC-SA 4.0; local diagnostic assets only, excluded from app distribution'},
                'tools': {'archiveReader': reader, 'ffmpeg': {'path': ffmpeg, 'sha256': digest(ffmpeg)},
                          'ffprobe': {'path': ffprobe, 'sha256': digest(ffprobe)}},
                'qualityScope': 'short studio speech/text diagnostic, not audiobook/acting/phoneme-time ground truth; model training overlap unknown; number rendering is not normalized',
                'samples': samples}
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    load_studio_manifest(path)
    print(json.dumps({'status': 'prepared', 'samples': len(samples), 'speakers': sorted({row['speaker'] for row in samples}),
                      'durationMs': sum(row['durationMs'] for row in samples), 'manifest': str(path)}), flush=True)


if __name__ == '__main__':
    main()
