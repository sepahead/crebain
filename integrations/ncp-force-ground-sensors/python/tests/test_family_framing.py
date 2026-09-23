"""Actual selected Bun socket framing, without SDK or native execution authority."""

import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time
import unittest


@unittest.skipUnless(os.environ.get("CREBAIN_SENSOR_BUN") and os.environ.get("CREBAIN_SENSOR_BRIDGE"),
                     "explicit selected Bun and bridge required")
class FamilyFramingTests(unittest.TestCase):
    def run_frame(self, frame, *, fragmented=False, close_write=False):
        host, service = socket.socketpair()
        host.settimeout(3)
        bridge = Path(os.environ["CREBAIN_SENSOR_BRIDGE"]).with_name("family-framing.test-support.ts")
        child = subprocess.Popen([os.environ["CREBAIN_SENSOR_BUN"], "run", str(bridge)],
                                 stdin=service, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        service.close()
        try:
            if fragmented:
                for byte in frame[:4]:
                    host.sendall(bytes([byte]))
                    time.sleep(0.001)
                for offset in range(4, len(frame), 511):
                    host.sendall(frame[offset:offset + 511])
            elif frame:
                host.sendall(frame)
            if close_write:
                host.shutdown(socket.SHUT_WR)
            output, error = child.communicate(timeout=3)
            return child.returncode, output, error
        finally:
            host.close()
            if child.poll() is None:
                child.kill()  # Only this control's directly owned unreaped child.
                child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()

    def test_short_header_and_body_writes_preserve_minimum_and_exact_frame_bound(self):
        for size in (1, 8193, 65536):
            with self.subTest(size=size):
                payload = bytes(index % 251 for index in range(size))
                code, output, error = self.run_frame(struct.pack(">I", size) + payload, fragmented=True)
                self.assertEqual(code, 0, error.decode())
                self.assertEqual(json.loads(output), {"bytes": size, "sha256": hashlib.sha256(payload).hexdigest()})

    def test_empty_truncated_and_oversize_frames_never_publish_a_payload_digest(self):
        for raw in (b"", b"\0", struct.pack(">I", 5), struct.pack(">I", 5) + b"x",
                    struct.pack(">I", 0), struct.pack(">I", 65537)):
            with self.subTest(frame=raw):
                code, output, error = self.run_frame(raw, close_write=True)
                self.assertEqual(code, 1)
                self.assertEqual(output, b"")
                self.assertTrue(error)

    def test_silent_and_stalled_partial_body_keep_the_same_finite_deadline(self):
        for raw in (b"", struct.pack(">I", 65536) + b"x" * 8193):
            with self.subTest(size=len(raw)):
                started = time.monotonic()
                code, output, error = self.run_frame(raw)
                self.assertEqual(code, 1)
                self.assertEqual(output, b"")
                self.assertIn(b"Private family deadline", error)
                self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main()
