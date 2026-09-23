"""Actual Bun stdin regression, independent of world construction and GPU resources."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import unittest

from ncp_local import wire


class FramingControls(unittest.TestCase):
    def launch(self):
        helper = Path(os.environ["CREBAIN_CITY_BRIDGE"]).with_name(
            "framing.test-support.ts"
        )
        child = subprocess.Popen(
            [os.environ["CREBAIN_CITY_BUN"], "run", str(helper)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )

        def cleanup():
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
            try:
                child.wait(timeout=6)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

        self.addCleanup(cleanup)
        return child

    def test_full_maximum_frame_with_final_short_fragment_without_eof(self):
        child = self.launch()
        payload = b"x" * 65533 + b"end"
        child.stdin.write(len(payload).to_bytes(4, "big"))
        for start in range(0, 65533, 3071):
            fragment = payload[start : min(start + 3071, 65533)]
            child.stdin.write(fragment)
        child.stdin.write(payload[-3:])
        # stdin remains open: the last three bytes must suffice to produce the reply.
        result = json.loads(
            wire.read_local_frame(child.stdout, deadline=time.monotonic() + 6)
        )
        self.assertEqual(
            result, {"bytes": 65536, "sha256": hashlib.sha256(payload).hexdigest()}
        )
        self.assertEqual(child.wait(timeout=6), 0)

    def test_partial_frame_eof_is_failure_and_no_successful_reply(self):
        child = self.launch()
        child.stdin.write((50000).to_bytes(4, "big"))
        child.stdin.write(b"x" * 17003)
        child.stdin.close()
        self.assertIsNone(
            wire.read_local_frame(child.stdout, deadline=time.monotonic() + 6)
        )
        self.assertEqual(child.wait(timeout=6), 1)
        self.assertEqual(child.stderr.read(), b"Truncated city frame")


if __name__ == "__main__":
    unittest.main()
