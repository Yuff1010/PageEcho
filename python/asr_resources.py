"""Explicit child-process CPU thread budgets, separate from model quality."""

import os

CPU_THREAD_CHOICES = (1, 2, 4)
THREAD_ENVIRONMENT = ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS')


def validate_cpu_threads(value):
    if type(value) is not int or value not in CPU_THREAD_CHOICES:
        raise ValueError('CPU threads must be 1, 2, or 4')
    return value


def configure_cpu_environment(cpu_threads=4):
    """Call before importing NumPy/Torch/FunASR/CTranslate2 in this child."""
    validate_cpu_threads(cpu_threads)
    for name in THREAD_ENVIRONMENT:
        os.environ[name] = str(cpu_threads)


def execution_resources(cpu_threads=4, torch_module=None):
    validate_cpu_threads(cpu_threads)
    return {'requestedCpuThreads': cpu_threads,
            'torchThreads': int(torch_module.get_num_threads()) if torch_module is not None else None,
            'torchInteropThreads': int(torch_module.get_num_interop_threads()) if torch_module is not None else None,
            'environmentThreads': {name: os.environ.get(name) for name in THREAD_ENVIRONMENT}}


def configure_torch_threads(cpu_threads=4):
    validate_cpu_threads(cpu_threads)
    import torch
    torch.set_num_threads(cpu_threads)
    # Preserve the original default-four interop policy. A low-resource worker
    # is a new process, and configures interop before the first model operation.
    if cpu_threads < 4 and torch.get_num_interop_threads() != 1:
        torch.set_num_interop_threads(1)
    return verify_torch_threads(cpu_threads)


def verify_torch_threads(cpu_threads=4):
    import torch
    actual = execution_resources(cpu_threads, torch)
    if actual['torchThreads'] != cpu_threads or (cpu_threads < 4 and actual['torchInteropThreads'] != 1):
        raise RuntimeError('A loaded model changed the requested CPU thread budget')
    return actual


class ResourceCheckedEngine:
    """Read back after inference too: FunASR can reconfigure global Torch."""

    def __init__(self, engine, cpu_threads, publish):
        self.engine, self.cpu_threads, self.publish = engine, cpu_threads, publish
        publish(verify_torch_threads(cpu_threads))

    def transcribe(self, audio):
        result = self.engine.transcribe(audio)
        self.publish(verify_torch_threads(self.cpu_threads))
        return result


class ResourceCheckedPunctuation:
    def __init__(self, model, cpu_threads, publish):
        self.model, self.cpu_threads, self.publish = model, cpu_threads, publish
        publish(verify_torch_threads(cpu_threads))

    def restore(self, text):
        result = self.model.restore(text)
        self.publish(verify_torch_threads(self.cpu_threads))
        return result
