"""Narrow per-instance compatibility for the pinned FunASR timestamp call.

FunASR 1.4.16's published wheel reverses alpha/peak positional arguments.
Upstream fix: 1878d61dbe8942587acb1f5543ec77dc1ca1e73c (#3716).
Clone only this model instance's inference globals; leave the installed files,
module helper, CIF tensors, recognition text and returned times untouched.
"""

import hashlib
import importlib
import importlib.metadata
from pathlib import Path
from types import FunctionType, MethodType

PARAFORMER_TIMESTAMP_CONTRACT = 'funasr-1878d61-alpha-peak-v1'
FUNASR_1416_MODULE_SHA256 = 'c7c1da94015ef48ea2d25a493fb272378c3f9ec9893cf1d638caedb74ef33d0e'


def _bind_corrected_timestamp_call(model, version, source_sha256):
    if version != '1.4.16':
        return 'native'
    if source_sha256 != FUNASR_1416_MODULE_SHA256:
        raise ValueError('FunASR 1.4.16 Paraformer source differs from the pinned wheel')
    bound = model.inference
    original = bound.__func__
    if getattr(original, '_ralb_timestamp_contract', None) == PARAFORMER_TIMESTAMP_CONTRACT:
        return PARAFORMER_TIMESTAMP_CONTRACT
    native = original.__globals__['ts_prediction_lfr6_standard']

    def corrected(peaks, alphas, char_list, **kwargs):
        return native(us_alphas=alphas, us_peaks=peaks, char_list=char_list, **kwargs)

    namespace = {**original.__globals__, 'ts_prediction_lfr6_standard': corrected}
    patched = FunctionType(original.__code__, namespace, original.__name__, original.__defaults__, original.__closure__)
    patched.__kwdefaults__ = original.__kwdefaults__
    patched._ralb_timestamp_contract = PARAFORMER_TIMESTAMP_CONTRACT
    model.inference = MethodType(patched, model)
    return PARAFORMER_TIMESTAMP_CONTRACT


def configure_paraformer_timestamps(model):
    version = importlib.metadata.version('funasr')
    if version != '1.4.16':
        return 'native'
    module = importlib.import_module('funasr.models.paraformer.model')
    if type(model) is not module.Paraformer:
        raise ValueError('Expected the pinned plain Paraformer implementation')
    source_sha256 = hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
    return _bind_corrected_timestamp_call(model, version, source_sha256)
