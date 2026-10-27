"""Keep evaluation downloads inside the chosen cache, separate from user Python."""

import os
import json
from pathlib import Path


DLL_HANDLES = []
WORKER_JOB = None
OFFLINE_NETWORK_ENABLED = False


def configure_offline_network():
    """Disable Python outbound transports in this local inference worker only.

    Loopback and local IPC remain available to ML multiprocessing. This is a
    process-local offline contract, not an OS firewall or a native-code sandbox.
    """
    global OFFLINE_NETWORK_ENABLED
    if OFFLINE_NETWORK_ENABLED:
        return
    import errno
    import ipaddress
    import socket
    import sys

    def local(host):
        if host is None or host in ('localhost', b'localhost'):
            return True
        try:
            value = host.decode('ascii') if isinstance(host, bytes) else host
            return ipaddress.ip_address(value).is_loopback
        except (ValueError, TypeError, UnicodeError):
            return False

    def audit(event, args):
        allowed = True
        if event in ('socket.connect', 'socket.sendto', 'socket.sendmsg'):
            transport, address = args[0], args[-1]
            if transport.family in (socket.AF_INET, socket.AF_INET6):
                allowed = address is None or (isinstance(address, tuple) and local(address[0]))
        elif event in ('socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr'):
            allowed = local(args[0])
        elif event == 'socket.getnameinfo':
            allowed = local(args[0][0])
        if not allowed:
            raise OSError(errno.ENETUNREACH, '本地转写处于离线模式，请先单独准备所需资源。')

    sys.addaudithook(audit)
    OFFLINE_NETWORK_ENABLED = True


def protect_worker_process():
    """Own descendants even if the Windows worker crashes before Node can cancel it.

    The unnamed job handle is non-inheritable and intentionally lives until OS
    process teardown. Closing the last handle kills all job members. Never call
    this in the application, builder, or preparation process.
    """
    global WORKER_JOB
    if os.name != 'nt' or WORKER_JOB is not None:
        return
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ('PerProcessUserTimeLimit', ctypes.c_longlong),
            ('PerJobUserTimeLimit', ctypes.c_longlong),
            ('LimitFlags', wintypes.DWORD),
            ('MinimumWorkingSetSize', ctypes.c_size_t),
            ('MaximumWorkingSetSize', ctypes.c_size_t),
            ('ActiveProcessLimit', wintypes.DWORD),
            ('Affinity', ctypes.c_size_t),
            ('PriorityClass', wintypes.DWORD),
            ('SchedulingClass', wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
            'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', IoCounters),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        error = ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(handle)
        raise error
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        error = ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(handle)
        raise error
    WORKER_JOB = handle


def configure_cache(root, ffmpeg_directory=None, resources=None):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    for name, subdirectory in {
        "HF_HOME": "huggingface",
        "HF_HUB_CACHE": "huggingface/hub",
        "MODELSCOPE_CACHE": "modelscope",
        "TORCH_HOME": "torch",
        "NLTK_DATA": "nltk",
        "NUMBA_CACHE_DIR": "numba",
        "MPLCONFIGDIR": "matplotlib",
    }.items():
        target = root / subdirectory
        target.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(target)
    if resources is not None:
        os.environ['NLTK_DATA'] = str(Path(resources).resolve() / 'nltk')
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    os.environ['PYANNOTE_METRICS_ENABLED'] = '0'
    os.environ['DO_NOT_TRACK'] = '1'
    os.environ['OTEL_SDK_DISABLED'] = 'true'
    os.environ['OTEL_TRACES_EXPORTER'] = 'none'
    os.environ['OTEL_METRICS_EXPORTER'] = 'none'
    os.environ['OTEL_LOGS_EXPORTER'] = 'none'
    if os.name == 'nt':
        import importlib.util

        spec = importlib.util.find_spec('torch')
        directories = [str(Path(spec.origin).parent / 'lib')] if spec else []
        if ffmpeg_directory:
            directories.append(str(Path(ffmpeg_directory).resolve()))
        for directory in directories:
            DLL_HANDLES.append(os.add_dll_directory(directory))
        os.environ['PATH'] = os.pathsep.join(directories + [os.environ.get('PATH', '')])
    return root


def load_local_models(manifest):
    """Resolve model paths against their manifest, independent of the caller's cwd."""
    path = Path(manifest).resolve()
    if path.stat().st_size > 65536:
        raise ValueError('Model manifest is too large')
    document = json.loads(path.read_text(encoding='utf-8'))
    if document.get('version') != 1 or not isinstance(document.get('models'), dict):
        raise ValueError('Invalid model manifest')
    models = {}
    for name, entry in document['models'].items():
        if not isinstance(entry, dict) or not isinstance(entry.get('path'), str):
            raise ValueError('Invalid local model path')
        target = Path(entry['path'])
        if not target.is_absolute():
            target = path.parent / target
        models[name] = {**entry, 'path': str(target.resolve())}
    return models
