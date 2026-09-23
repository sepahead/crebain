"""Actual guardian custody for bounded synthetic multi-socket children."""

import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from crebain_ncp_sensors import _process


ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
ORDERLY = """
import json,os,socket,sys
channels=[socket.socket(fileno=fd) for fd in json.loads(sys.argv[-1])]
for channel in channels: channel.sendall(b'R')
for channel in channels:
    assert channel.recv(1)==b''
    channel.close()
os.write(2,b'all selected channels closed')
"""


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("owned family process condition timed out")
        time.sleep(0.01)


class FamilyProcessTests(unittest.TestCase):
    def make(self, count=2, *, code=ORDERLY, seconds=10):
        return _process._Process([sys.executable, "-I", "-S", "-B", "-c", code], ENV, Path.cwd(),
                                 deadline=time.monotonic() + seconds, _cleanup_grace=2, _family_endpoints=count)

    def ready(self, process):
        for reader, _ in process.streams:
            with selectors.DefaultSelector() as selector:
                selector.register(reader, selectors.EVENT_READ)
                self.assertTrue(selector.select(3))
                self.assertEqual(reader.read(1), b"R")

    def test_two_and_sixteen_real_channels_close_independently_then_reap_their_owner(self):
        for count in (2, 16):
            with self.subTest(count=count):
                process = self.make(count)
                try:
                    self.ready(process)
                    process.close_endpoint(0)
                    self.assertIsNone(process._guard.poll())
                    with self.assertRaises(_process.ProcessError):
                        process.close_endpoint(count)
                finally:
                    process.close(healthy=True)
                self.assertEqual(process.exit["schema"], "crebain.family-process-exit.v1")
                self.assertEqual(process.exit["endpoint_count"], count)
                self.assertTrue(process.exit["cleanup_confirmed"])
                self.assertFalse(process.exit["forced"])
                self.assertEqual(process.diagnostics, b"all selected channels closed")
                self.assertFalse(process.directory.exists())

    def test_absolute_deadline_shuts_down_all_guardian_duplicates_while_host_wrappers_remain_live(self):
        process = self.make(16, seconds=0.5)
        self.ready(process)
        wait_for(lambda: (process.directory / "exit.json").exists())
        with self.assertRaises(BaseExceptionGroup):
            process.close(healthy=True)
        self.assertEqual(process.exit["reason"], "deadline")
        self.assertTrue(process.exit["cleanup_confirmed"])
        self.assertEqual(process.exit["endpoint_count"], 16)
        self.assertFalse(process.directory.exists())

    def test_roster_rejection_precedes_any_child_or_socket_and_partial_wrappers_are_closed(self):
        for count in (1, 17, True, -1):
            with self.subTest(count=count), patch.object(_process.subprocess, "Popen") as spawn, \
                    patch.object(_process.socket, "socketpair") as pair:
                with self.assertRaises(_process.ProcessError):
                    self.make(count)
                spawn.assert_not_called()
                pair.assert_not_called()
        pairs = []
        original_pair = _process.socket.socketpair
        original_makefile = _process.socket.socket.makefile
        calls = 0
        failure = OSError("injected second endpoint wrapper failure")

        def pair():
            result = original_pair()
            pairs.append(result)
            return result

        def makefile(selected, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise failure
            return original_makefile(selected, *args, **kwargs)

        with patch.object(_process.socket, "socketpair", side_effect=pair), \
                patch.object(_process.socket.socket, "makefile", makefile), \
                patch.object(_process.subprocess, "Popen") as spawn:
            with self.assertRaises(OSError) as raised:
                self.make()
            self.assertIs(raised.exception, failure)
            spawn.assert_not_called()
        self.assertEqual(len(pairs), 2)
        self.assertTrue(all(sock.fileno() == -1 for pair in pairs for sock in pair))

    def test_family_diagnostic_retention_has_its_own_bound_and_unchanged_overflow_ceiling(self):
        for size in (100000, 1100000):
            with self.subTest(size=size):
                code = ORDERLY.replace("for channel in channels:\n    assert", f"os.write(2,b'x'*{size})\nfor channel in channels:\n    assert")
                process = self.make(code=code)
                self.ready(process)
                if size > 1048576:
                    wait_for(lambda: (process.directory / "exit.json").exists())
                    with self.assertRaises(BaseExceptionGroup):
                        process.close(healthy=True)
                    self.assertEqual(process.exit["reason"], "output_limit")
                    self.assertTrue(process.diagnostics_truncated)
                    self.assertEqual(len(process.diagnostics), 131072)
                else:
                    process.close(healthy=True)
                    self.assertFalse(process.diagnostics_truncated)
                    self.assertEqual(len(process.diagnostics), size + len(b"all selected channels closed"))

    def test_caller_exit_closes_all_sixteen_channels_without_observer_signals(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state, marker = root / "state.json", root / "retired"
            producer = ORDERLY + f"\nfrom pathlib import Path; Path({str(marker)!r}).write_text('retired')\n"
            script = f"""
import importlib.util,json,os,pathlib,sys,time
spec=importlib.util.spec_from_file_location('family_process_under_test',{_process.__file__!r})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
process=module._Process([sys.executable,'-I','-S','-B','-c',{producer!r}],{ENV!r},pathlib.Path.cwd(),deadline=time.monotonic()+3,_cleanup_grace=2,_family_endpoints=16)
pathlib.Path({str(state)!r}).write_text(json.dumps({{'directory':str(process.directory)}}))
os._exit(0)
"""
            caller = subprocess.Popen([sys.executable, "-I", "-S", "-B", "-c", script], env=ENV,
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                wait_for(state.exists)
                _, stderr = caller.communicate(timeout=5)
                self.assertEqual(caller.returncode, 0, stderr.decode())
                wait_for(marker.exists)
                directory = Path(json.loads(state.read_text())["directory"])
                wait_for(lambda: not directory.exists())
            finally:
                if caller.poll() is None:
                    caller.kill()  # Only the directly owned test caller, if setup failed.
                    caller.wait(timeout=3)
                caller.stderr.close()


if __name__ == "__main__":
    unittest.main()
