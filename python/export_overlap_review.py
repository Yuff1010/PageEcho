"""Export bounded original-audio excerpts and stored context for unresolved seams.

No speech is newly recognized, no reference transcript is inferred, and the
source/checkpoints are never overwritten. Outputs stay in the ignored cache.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import uuid
import wave

from audit_asr_overlaps import recovered_units
from public_reference import digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--overlap-report', required=True)
    parser.add_argument('--component', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    report_path = Path(args.overlap_report).resolve()
    report = json.loads(report_path.read_text(encoding='utf-8'))
    if report['status'] != 'audited':
        raise ValueError('Expected an actual completed-source audit, not a prospective replay')
    app = json.loads(Path(report['appReport']).read_text(encoding='utf-8'))
    source = Path(app['sourceAudio'])
    if digest(source) != report['audioHash']:
        raise ValueError('Original source changed')
    component_path = Path(args.component).resolve()
    component = json.loads(component_path.read_text(encoding='utf-8'))
    ffmpeg = (component_path.parent / component['ffmpeg']).resolve()
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
    output = Path(args.output).resolve() if args.output else Path('cache/asr-evaluation/overlap-review').resolve() / stamp
    output.mkdir(parents=True, exist_ok=False)
    group = Path(report['checkpointManifest']).parent
    manifest = json.loads((group / 'manifest.json').read_text(encoding='utf-8'))
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    rows = []
    for row in report['rows']:
        if (not any(issue['code'] == 'BOUNDARY_CONTEXT_UNRESOLVED' for issue in row['issues']) and
                row['agreementStatus'] not in ('no-exact-context', 'ambiguous-repeated-context', 'time-inconsistent-context',
                                              'agreed-text-lost', 'agreed-text-duplicated')):
            continue
        seam = row['seamMs']
        start, end = max(0, seam - 4000), min(manifest['endMs'], seam + 4000)
        target = output / f'boundary-{seam:07d}.wav'
        temporary = output / f'{uuid.uuid4()}.part.wav'
        try:
            subprocess.run([str(ffmpeg), '-nostdin', '-v', 'error', '-n', '-ss', str(start / 1000),
                            '-protocol_whitelist', 'file,pipe', '-i', str(source), '-t', str((end - start) / 1000),
                            '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(temporary)],
                           check=True, capture_output=True, timeout=30, **flags)
            with wave.open(str(temporary), 'rb') as audio:
                if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 16000, 2):
                    raise ValueError('Unexpected review excerpt encoding')
                if abs(audio.getnframes() / 16 - (end - start)) > .1:
                    raise ValueError('Unexpected review excerpt duration')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        contexts = {}
        for label, index in (('left', row['chunk'] - 1), ('right', row['chunk'])):
            checkpoint = json.loads((group / f'chunk-{index:06d}.json').read_text(encoding='utf-8'))
            units = [unit for unit in recovered_units(checkpoint)
                     if abs((unit['startMs'] + unit['endMs']) / 2 - seam) <= 2000]
            contexts[label] = {'text': ''.join(unit['text'] for unit in units), 'nativeUnits': units}
        rows.append({'seamMs': seam, 'sourceRange': {'startMs': start, 'endMs': end}, 'localSeamMs': seam - start,
                     'path': str(target), 'audioHash': digest(target), 'agreementStatus': row['agreementStatus'],
                     'issues': row['issues'], 'contexts': contexts, 'humanReference': None})
    result = {'status': 'needs-human-review', 'sourceAudio': str(source), 'sourceAudioHash': report['audioHash'],
              'sourceAudit': str(report_path), 'sourceAuditSha256': digest(report_path),
              'scope': 'Original source excerpts with channel/sample-format conversion only; no ASR rerun, inferred human transcript or timing score. Clip-local seam offsets explicitly recorded.',
              'excerpts': rows}
    target = output / 'manifest.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'excerpts': len(rows), 'manifest': str(target)}), flush=True)


if __name__ == '__main__':
    main()
