"""Offline transports are checked in a private subprocess; host networking is unchanged."""

from pathlib import Path
import subprocess
import sys
import unittest


class OfflineRuntimeTest(unittest.TestCase):
    def test_external_dns_tcp_udp_are_unavailable_while_loopback_ipc_still_works(self):
        code = r'''
import errno
import socket
from asr_runtime import configure_offline_network
configure_offline_network()
configure_offline_network()
for operation in (
    lambda: socket.getaddrinfo('example.invalid', 443),
    lambda: socket.gethostbyname('example.invalid'),
    lambda: socket.gethostbyaddr('203.0.113.1'),
    lambda: socket.getnameinfo(('203.0.113.1', 443), 0),
    lambda: socket.socket().connect(('203.0.113.1', 443)),
    lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'probe', ('203.0.113.1', 9)),
):
    try:
        operation()
    except OSError as error:
        assert error.errno == errno.ENETUNREACH, error
    else:
        raise AssertionError('External transport was not rejected')
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    with socket.create_connection(listener.getsockname(), timeout=2) as client:
        accepted, _ = listener.accept()
        with accepted:
            client.sendall(b'local ipc')
            assert accepted.recv(9) == b'local ipc'
print('offline transports verified')
'''
        result = subprocess.run([sys.executable, '-B', '-X', 'utf8', '-c', code],
                                cwd=Path(__file__).resolve().parent, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('offline transports verified', result.stdout)


if __name__ == '__main__':
    unittest.main()
