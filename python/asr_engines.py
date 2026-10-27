"""Real model adapters shared by offline evaluation and the job worker."""

import time
import re
import math
import unicodedata
from asr_metrics import timing_issues
from asr_compat import configure_paraformer_timestamps
from asr_ctc import ctc_alignment_function
from asr_resources import validate_cpu_threads
from asr_segments import alignment_text, lexical_units, punctuate_units, SENTENCE_PUNCTUATION


class AlignmentError(ValueError):
    pass


WHISPERX_AUDIO_BOUNDS_CONTRACT = 'whisperx-decoded-audio-bounds-v1'


def bounded_alignment_input(segments, audio_samples):
    """Align against the actual decoded crop, retaining raw recognition evidence.

    VAD end times can extend past the final sample. WhisperX slices the actual
    audio but uses the declared span to scale frame positions, so that mismatch
    can produce out-of-audio character times. Bound the input before running
    the acoustic alignment; never clip or rescale its returned character times.
    """
    duration = audio_samples / 16000
    result = []
    for segment in segments:
        start, end = segment.get('start'), segment.get('end')
        if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end))
                or not 0 <= start < duration or not start < end):
            raise AlignmentError('WhisperX recognition span has no valid decoded audio interval')
        result.append({**segment, 'end': min(end, duration)})
    return result


def aligned_output(aligned):
    segments, units = [], []
    for sentence in aligned['segments']:
        segments.append({'startMs': round(sentence['start'] * 1000),
                         'endMs': round(sentence['end'] * 1000), 'text': sentence['text']})
        for char in sentence.get('chars', []) or []:
            units.append({'text': char['char'],
                          'startMs': round(char['start'] * 1000) if 'start' in char else None,
                          'endMs': round(char['end'] * 1000) if 'end' in char else None})
    return segments, units


class ChineseCTCAligner:
    def __init__(self, models, device):
        import whisperx
        self.whisperx, self.device = whisperx, device
        self.align_function = ctc_alignment_function()
        self.model, self.metadata = whisperx.load_align_model(
            language_code='zh', device=device, model_name=models['alignment']['path'], model_cache_only=True,
        )
        self.original_model_path = models['alignment']['path']

    def align(self, audio, text):
        return self.align_function(
            [{'start': 0.0, 'end': len(audio) / 16000, 'text': text}], self.model, self.metadata,
            audio, self.device, return_char_alignments=True, interpolate_method='ignore', print_progress=False,
        )

    def align_with_evidence(self, audio, text):
        """Use the same pinned path, retaining its unforced emission evidence.

        This is opt-in for confirmed-original verification. Existing ASR paths
        keep their adapters and defaults unchanged. Nothing re-runs recognition
        or modifies the model, emission, text, or character times.
        """
        import torch
        from transformers import AutoFeatureExtractor
        if not hasattr(self, 'original_extractor'):
            self.original_extractor = AutoFeatureExtractor.from_pretrained(
                self.original_model_path, local_files_only=True)
        emissions = []
        model = self.model
        extractor, device = self.original_extractor, self.device

        class Capture:
            def __call__(self, *args, **kwargs):
                # The fixed model prescribes zero-mean/unit-variance feature
                # extraction. This opt-in helper uses the complete waveform;
                # existing recognition/fallback callers remain unchanged.
                batch = extractor(args[0][0].detach().cpu().numpy(), sampling_rate=16000, return_tensors='pt')
                inputs = batch.input_values.to(device)
                mask = {'attention_mask': batch.attention_mask.to(device)} if 'attention_mask' in batch else {}
                result = model(inputs, **mask)
                emissions.append(torch.log_softmax(result.logits[0], dim=-1).detach().cpu())
                return result

        if self.metadata['type'] != 'huggingface':
            raise AlignmentError('Original alignment requires the pinned Chinese HuggingFace CTC model')
        aligned = self.align_function(
            [{'start': 0.0, 'end': len(audio) / 16000, 'text': text}], Capture(), self.metadata,
            audio, self.device, return_char_alignments=True, interpolate_method='ignore', print_progress=False,
        )
        if len(emissions) != 1:
            raise AlignmentError('Expected one complete-waveform CTC emission')
        if not bool(torch.isfinite(emissions[0]).all()):
            raise AlignmentError('The CTC emission contains nonfinite acoustic evidence')
        return aligned, emissions[0]


class Paraformer:
    def __init__(self, models, device, cpu_threads=4):
        validate_cpu_threads(cpu_threads)
        from funasr import AutoModel
        self.model = AutoModel(
            model=models['paraformer']['path'],
            vad_model=models['vad']['path'],
            punc_model=models['punctuation']['path'],
            device='cuda:0' if device == 'cuda' else 'cpu',
            ncpu=cpu_threads, disable_update=True, disable_pbar=True, trust_remote_code=False,
        )
        self.timestamp_contract = configure_paraformer_timestamps(self.model.model)
        self.models, self.device, self.aligner = models, device, None

    def transcribe(self, audio):
        started = time.perf_counter()
        raw = self.model.generate(
            input=audio, fs=16000, batch_size_s=60,
            sentence_timestamp=True, output_timestamp=True,
        )
        elapsed = time.perf_counter() - started
        segments, units = [], []
        unit_mapping_valid = True
        for result in raw:
            for sentence in result.get('sentence_info', []):
                segments.append({'startMs': int(sentence['start']), 'endMs': int(sentence['end']), 'text': sentence['text']})
            text = ''.join(char for char in unicodedata.normalize('NFKC', result.get('text', ''))
                           if unicodedata.category(char)[0] in ('L', 'N'))
            timestamps = result.get('timestamp', [])
            tokens = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)*|[0-9]+|[^\W\s]", result.get('text', ''))
            if len(text) == len(timestamps):
                units.extend({'text': char, 'startMs': int(span[0]), 'endMs': int(span[1])}
                             for char, span in zip(text, timestamps))
            elif len(tokens) == len(timestamps):
                units.extend({'text': token, 'startMs': int(span[0]), 'endMs': int(span[1])}
                             for token, span in zip(tokens, timestamps))
            else:
                unit_mapping_valid = False
        recognized_text = ''.join(result.get('text', '') for result in raw)
        duration_ms = round(len(audio) / 16)
        native_issues = timing_issues(segments, duration_ms)
        try:
            native_units = lexical_units(units, duration_ms)
            native_valid = (unit_mapping_valid and not native_issues
                            and alignment_text(recognized_text) == alignment_text(''.join(unit['text'] for unit in units))
                            and (not recognized_text.strip() or bool(segments)))
            if native_valid:
                units = punctuate_units(native_units, recognized_text)
        except ValueError:
            native_valid = False
        fallback, alignment_ms = False, None
        if recognized_text.strip() and not native_valid:
            align_started = time.perf_counter()
            if self.aligner is None:
                self.aligner = ChineseCTCAligner(self.models, self.device)
            aligned = self.aligner.align(audio, recognized_text)
            alignment_ms = (time.perf_counter() - align_started) * 1000
            try:
                segments, units = aligned_output(aligned)
                lexical_units(units, duration_ms)
                if (not units or timing_issues(segments, duration_ms)
                        or alignment_text(recognized_text) != alignment_text(''.join(unit['text'] for unit in units))):
                    raise ValueError('CTC alignment did not cover the recognized text')
            except (KeyError, TypeError, ValueError, OverflowError) as error:
                raise AlignmentError('Paraformer CTC realignment has missing or invalid character times') from error
            raw = [dict(item) for item in raw]
            raw[0]['alignmentFallback'] = {'method': 'zh-ctc-no-interpolation-v1', 'result': aligned}
            unit_mapping_valid, fallback = True, True
        return {
            'raw': raw, 'segments': segments, 'timedUnits': units,
            'recognitionText': recognized_text,
            'unitMappingValid': unit_mapping_valid,
            'recognitionMs': elapsed * 1000, 'alignmentMs': alignment_ms,
            'firstAvailableResultMs': elapsed * 1000 + (alignment_ms or 0),
            'alignmentFallback': fallback, 'nativeTimingIssues': native_issues,
            'punctuationRestored': True,
            'timingMethod': (f'Paraformer {self.timestamp_contract}; invalid native times use local Chinese CTC, no interpolation'
                             if fallback else f'native Paraformer timestamps ({self.timestamp_contract})'),
        }


class WhisperX:
    def __init__(self, models, device, compute_type, batch_size, cpu_threads=4):
        validate_cpu_threads(cpu_threads)
        import whisperx
        self.whisperx, self.device = whisperx, device
        self.align_function = ctc_alignment_function()
        self.batch_size = batch_size
        self.model = whisperx.load_model(
            models['whisper']['path'], device=device, language='zh',
            compute_type=compute_type,
            download_root=None, local_files_only=True, threads=cpu_threads,
            vad_method='pyannote',
        )
        self.aligner, self.metadata = whisperx.load_align_model(
            language_code='zh', device=device, model_name=models['alignment']['path'],
            model_cache_only=True,
        )

    def transcribe(self, audio):
        started = time.perf_counter()
        raw = self.model.transcribe(audio, batch_size=self.batch_size, language='zh')
        recognized = time.perf_counter()
        alignment_input = bounded_alignment_input(raw['segments'], len(audio))
        aligned = self.align_function(
            alignment_input, self.aligner, self.metadata, audio, self.device,
            return_char_alignments=True, print_progress=False,
        )
        finished = time.perf_counter()
        segments, units = aligned_output(aligned)
        recognized_text = ''.join(segment['text'] for segment in raw['segments'])
        return {
            'raw': {'recognition': raw, 'alignmentInput': alignment_input, 'alignment': aligned},
            'recognitionText': recognized_text,
            'segments': segments, 'timedUnits': units, 'unitMappingValid': True,
            'recognitionMs': (recognized - started) * 1000,
            'alignmentMs': (finished - recognized) * 1000,
            'firstAvailableResultMs': (finished - started) * 1000,
            'timingMethod': 'WhisperX Chinese CTC on bounded decoded audio, whole-waveform likelihood, nearest interpolation default; raw char times retained',
            'punctuationRestored': any(char in SENTENCE_PUNCTUATION for char in recognized_text),
        }


class ChinesePunctuation:
    """Insert punctuation on CPU without changing the recognized letters."""

    def __init__(self, models, cpu_threads=4):
        validate_cpu_threads(cpu_threads)
        from funasr import AutoModel
        self.model = AutoModel(
            model=models['punctuation']['path'], device='cpu', ncpu=cpu_threads,
            disable_update=True, disable_pbar=True, trust_remote_code=False,
        )

    def restore(self, text):
        result = self.model.generate(input=text)
        return result[0]['text'] if result else text

