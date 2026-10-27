"""Whole-waveform objective for the pinned WhisperX CTC path search.

The native endpoint maximizes a prefix likelihood and omits trailing blank
cost. Subtracting each row's cumulative blank cost gives the same optimum as
scoring the whole waveform, including trailing blanks. Every backtrack choice
within a row stays unchanged. No token, emission or returned time is rewritten.
The recurrence uses per-frame log odds against blank to avoid cancellation
when a long blank tail gives equal-scoring endpoints. Only this caller's align
function gets a private get_trellis binding.
"""

from functools import lru_cache
import hashlib
import importlib
import importlib.metadata
from pathlib import Path
from types import FunctionType

CTC_ALIGNMENT_CONTRACT = 'ctc-complete-waveform-logodds-v1'
WHISPERX_386_ALIGNMENT_SHA256 = 'cc3607dcc25e592ae218f74a6ca644d6ce1c77d9cee4672f01c751da8feb9aa7'


def _blank_relative_trellis(native, emission, tokens, blank_id=0):
    # This allocates a search matrix; the model emission evidence stays intact.
    relative = emission - emission[:, blank_id, None]
    return native(relative, tokens, blank_id)


def _bind_complete_alignment(native_align, version, source_sha256):
    if version != '3.8.6' or source_sha256 != WHISPERX_386_ALIGNMENT_SHA256:
        raise ValueError('CTC alignment implementation differs from the verified WhisperX 3.8.6 component')
    if getattr(native_align, '_ralb_ctc_contract', None) == CTC_ALIGNMENT_CONTRACT:
        return native_align
    native_trellis = native_align.__globals__['get_trellis']

    def corrected(emission, tokens, blank_id=0):
        return _blank_relative_trellis(native_trellis, emission, tokens, blank_id)

    namespace = {**native_align.__globals__, 'get_trellis': corrected}
    aligned = FunctionType(native_align.__code__, namespace, native_align.__name__,
                           native_align.__defaults__, native_align.__closure__)
    aligned.__kwdefaults__ = native_align.__kwdefaults__
    aligned._ralb_ctc_contract = CTC_ALIGNMENT_CONTRACT
    return aligned


@lru_cache(maxsize=1)
def ctc_alignment_function():
    module = importlib.import_module('whisperx.alignment')
    version = importlib.metadata.version('whisperx')
    sha256 = hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
    return _bind_complete_alignment(module.align, version, sha256)
