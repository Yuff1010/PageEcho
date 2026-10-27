"""Compare unchanged and model-prescribed inputs on saved real recognition text.

Opt-in model diagnostic, not an accuracy benchmark or a replacement transcript.
The component, audio and original worker evidence are opened without changes.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import threading
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_runtime import configure_cache, configure_offline_network, load_local_models
from asr_jobs import FFmpegDecoder
from asr_ctc import CTC_ALIGNMENT_CONTRACT, ctc_alignment_function


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', required=True)
    parser.add_argument('--worker-report', required=True)
    parser.add_argument('--cpu', action='store_true')
    args = parser.parse_args()
    component_path = Path(args.component).resolve()
    component = json.loads(component_path.read_text(encoding='utf-8'))
    if component['version'] != 2:
        raise ValueError('This diagnostic requires the portable v2 component')
    assets = {key: (component_path.parent / component[key]).resolve()
              for key in ('models', 'resources', 'ffmpeg', 'ffprobe')}
    report_path = Path(args.worker_report).resolve()
    worker = json.loads(report_path.read_text(encoding='utf-8'))
    if worker['status'] != 'passed' or worker['configuration']['engine'] != 'whisperx':
        raise ValueError('Expected a terminal real WhisperX worker report')
    sample = worker['samples'][0]
    source = Path(sample['originalSourcePath'])
    with source.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != sample['audioHash']:
            raise ValueError('Original audio changed')
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
    output = Path('cache/asr-evaluation/ctc-diagnostics').resolve() / stamp
    output.mkdir(parents=True)
    configure_cache(output / 'cache', assets['ffmpeg'].parent, assets['resources'])
    configure_offline_network()
    import numpy as np
    import torch
    import whisperx
    import whisperx.alignment
    from transformers import AutoFeatureExtractor
    torch.set_num_threads(4)
    models = load_local_models(assets['models'])
    device = 'cpu' if args.cpu else 'cuda'
    model, metadata = whisperx.load_align_model(
        'zh', device, model_name=models['alignment']['path'], model_cache_only=True)
    extractor = AutoFeatureExtractor.from_pretrained(models['alignment']['path'], local_files_only=True)
    inverse = {code: char for char, code in metadata['dictionary'].items()}
    decoder = FFmpegDecoder(assets['ffmpeg'], assets['ffprobe'])
    cache_key = worker['runs'][0]['result']['cacheKey']
    chunks = sorted((report_path.parent / 'cache/asr/jobs' / cache_key).glob('chunk-*.json'))
    report = {'status': 'running', 'sourceWorker': str(report_path), 'audioHash': sample['audioHash'],
              'device': device, 'extractor': extractor.to_dict(), 'chunks': [],
              'ctcContract': CTC_ALIGNMENT_CONTRACT,
              'diagnosticSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'alignmentModuleSha256': hashlib.sha256(Path(whisperx.alignment.__file__).read_bytes()).hexdigest(),
              'qualityScope': 'same saved ASR text, model-span and CTC diagnostic only; no human timing/accuracy reference'}
    target = output / 'report.json'

    original_align = whisperx.alignment.align

    class InputProbe:
        def __init__(self, preprocess):
            self.preprocess, self.calls = preprocess, []

        def __call__(self, waveform):
            values = waveform
            mask = None
            if self.preprocess:
                batch = extractor(waveform.cpu().numpy(), sampling_rate=16000, return_tensors='pt')
                values = batch.input_values.to(device)
                mask = batch.attention_mask.to(device) if 'attention_mask' in batch else None
            result = model(values, **({'attention_mask': mask} if mask is not None else {}))
            indices = result.logits.argmax(-1)[0].tolist()
            collapsed, last = [], None
            for index in indices:
                if index != last and index != model.config.pad_token_id:
                    collapsed.append(inverse.get(index, '?'))
                last = index
            self.calls.append({'samples': waveform.shape[-1], 'frames': len(indices),
                               'inputMean': values.mean().item(), 'inputStd': values.std().item(),
                               'greedyCTC': ''.join(collapsed)})
            return result

    try:
        for path in chunks:
            chunk = json.loads(path.read_text(encoding='utf-8'))
            audio = decoder.decode(source, chunk['window'], threading.Event())
            raw = chunk['raw']['recognition']['segments']
            item = {'chunk': path.name, 'window': chunk['window'],
                    'samples': len(audio), 'durationSeconds': len(audio) / 16000,
                    'audioMean': float(np.mean(audio)), 'audioStd': float(np.std(audio)),
                    'audioPeak': float(np.max(np.abs(audio))), 'variants': []}
            report['chunks'].append(item)
            for name, preprocess, align_function in (
                    ('original-waveform', False, original_align),
                    ('model-feature-extractor', True, original_align),
                    ('complete-waveform-likelihood', False, ctc_alignment_function())):
                probe = InputProbe(preprocess)
                result = align_function(raw, probe, metadata, audio, device,
                                        return_char_alignments=True, interpolate_method='ignore', print_progress=False)
                variant = {'name': name, 'calls': probe.calls, 'alignment': result,
                           'unknownCharacters': sorted({char for segment in raw for char in segment['text']
                                                        if char.lower() not in metadata['dictionary'] and not char.isspace()}),
                           'spans': [{'start': seg['start'], 'end': seg['end'],
                                      'characters': sum(unicodedata.category(c)[0] in ('L', 'N') for c in seg['text'])}
                                     for seg in result['segments']]}
                item['variants'].append(variant)
                target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                print(json.dumps({'chunk': path.name, 'variant': name, 'spans': variant['spans']}), flush=True)
        report['status'] = 'compared'
    finally:
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'report': str(target)}), flush=True)


if __name__ == '__main__':
    main()
