"""Read-only long-audiobook lifecycle, media-clock and punctuation audit."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_metrics import timing_issues
from asr_segments import join_units, join_windows, reading_segments


def surface(text):
    return ''.join(char for char in unicodedata.normalize('NFKC', text).casefold() if not char.isspace())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-report', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--manifest', default='cache/asr-evaluation/audiobook-source/manifest.json')
    parser.add_argument('--duration-audit', default='cache/asr-evaluation/audiobook-source/mp3-duration-audit.json')
    args = parser.parse_args()
    app_report = Path(args.app_report).resolve()
    run = json.loads(app_report.read_text(encoding='utf-8'))
    if run['status'] != 'passed' or run['engine'] != 'paraformer':
        raise ValueError('Expected a completed Paraformer application run')
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8'))
    source = next(item for item in manifest['tracks'] if Path(item['sourcePath']) == Path(run['sourceAudio']))
    duration_audit = json.loads(Path(args.duration_audit).read_text(encoding='utf-8'))
    if duration_audit['sourceAudioHash'] != source['sha256'] or duration_audit['status'] != 'passed':
        raise ValueError('The decoded-duration audit is for a different input')
    with Path(source['sourcePath']).open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != source['sha256']:
            raise ValueError('Published source changed')
    data = Path(run['data'])
    db = sqlite3.connect((data / 'data/library.sqlite3').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        episodes = db.execute('SELECT duration_ms FROM episodes').fetchall()
        rows = [dict(row) for row in db.execute('SELECT id,audio_hash,engine,device,status,attempt,processed_until_ms,total_chunks,completed_chunks,cache_hits,issue_count,document_json FROM transcription_jobs ORDER BY rowid')]
    finally:
        db.close()
    if len(episodes) != 1:
        raise ValueError('Expected the isolated single-source acceptance library')
    media_duration = episodes[0]['duration_ms']
    if abs(media_duration - duration_audit['decodedDurationMs']) >= 1:
        raise ValueError('Player duration differs from independently counted decoded samples')
    end = round(media_duration)
    total_chunks = (end + 29999) // 30000
    completed = [row for row in rows if row['status'] == 'completed']
    if (len(completed) < 3 or not any(row['attempt'] > 1 and row['cache_hits'] > 0 for row in completed)
            or not any(row['status'] == 'canceled' for row in rows)):
        raise ValueError('Missing real restart/replay/cancellation lifecycle evidence')
    for row in completed:
        document = json.loads(row['document_json'])
        if (row['audio_hash'] != source['sha256'] or row['completed_chunks'] != total_chunks
                or row['processed_until_ms'] != end or document['coverage'] != [{'startMs': 0, 'endMs': end}]
                or timing_issues(document['segments'], end)):
            raise ValueError('Invalid long-source identity, progress or media coordinates')
    last = completed[-1]
    if last['cache_hits'] != 0:
        raise ValueError('Post-cleanup generation reused old checkpoints')
    candidates = []
    for path in (data / 'cache/asr/jobs').glob('*/manifest.json'):
        item = json.loads(path.read_text(encoding='utf-8'))
        if item['audioHash'] == source['sha256'] and item['startMs'] == 0 and item['endMs'] == end:
            candidates.append((path, item))
    if len(candidates) != 1:
        raise ValueError('Expected one post-cleanup complete cache group')
    path, cache_manifest = candidates[0]
    chunks = sorted(path.parent.glob('chunk-*.json'))
    if len(chunks) != total_chunks:
        raise ValueError('Missing completed source chunks')
    mismatches, realigned_chunks = [], 0
    assembled, issue_counts = [], Counter()
    previous_context = None
    for chunk in chunks:
        item = json.loads(chunk.read_text(encoding='utf-8'))
        if cache_manifest['configuration']['postprocessVersion'] >= 3:
            assembled, boundary_issues = join_windows(assembled, item['units'], previous_context,
                                                      item['contextUnits'], item['window']['startMs'],
                                                      cache_manifest['configuration']['overlapMs'])
            previous_context = item['contextUnits']
        else:
            assembled, boundary_issues = join_units(assembled, item['units'])
        issue_counts.update(issue['code'] for issue in item['issues'] + boundary_issues)
        realigned_chunks += any('alignmentFallback' in result for result in item['raw'])
        native = ''.join(result.get('text', '') for result in item['raw'])
        rendered = ''.join(unit['text'] for unit in item['units'])
        if rendered and surface(rendered) not in surface(native):
            mismatches.append({'chunk': chunk.name, 'nativePrefix': native[:100], 'renderedPrefix': rendered[:100]})
    document = json.loads(last['document_json'])
    if sum(issue_counts.values()) != last['issue_count']:
        raise ValueError('Reconstructed checkpoint warnings differ from the stored task count')
    if reading_segments(assembled) != document['segments']:
        raise ValueError('Reconstructed stitched document differs from the completed job')
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    exported = output.with_name(output.stem + '.generated.json')
    exported.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report = {
        'status': 'failed' if mismatches else 'passed', 'executionStatus': run['status'],
        'appReport': str(app_report), 'sourceAudio': run['sourceAudio'], 'audioHash': source['sha256'],
        'containerDurationMs': float(source['probe']['format']['duration']) * 1000,
        'decodedDurationMs': duration_audit['decodedDurationMs'], 'htmlMediaDurationMs': media_duration,
        'processedEndMs': end, 'chunks': total_chunks, 'segments': len(document['segments']),
        'punctuationPolicy': cache_manifest['configuration'].get('punctuationPolicy', 'legacy-repeat'),
        'ctcAlignmentObjective': cache_manifest['configuration'].get('ctcAlignmentObjective', 'legacy-prefix'),
        'realignedChunks': realigned_chunks,
        'issueCounts': dict(issue_counts),
        'nativeSurfaceScope': 'owned-unit text is a contiguous substring of native engine text after NFKC, casefold and whitespace removal; punctuation retained; not audio accuracy',
        'surfaceMismatchChunks': len(mismatches), 'surfaceMismatches': mismatches,
        'generatedDocument': str(exported), 'accuracyStatus': 'not-rated-no-human-transcript',
        'jobs': [{**row, 'document_json': None} for row in rows],
    }
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('status', 'chunks', 'segments', 'processedEndMs', 'surfaceMismatchChunks')}), flush=True)
    return 1 if mismatches else 0


if __name__ == '__main__':
    raise SystemExit(main())
