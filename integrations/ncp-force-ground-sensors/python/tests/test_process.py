"""Real OS lifetime controls with synthetic children, without CREBAIN execution."""

import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from crebain_ncp_sensors import _process


ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
ORDERLY = "import os; os.write(1,b'R'); os.read(0,1); os.write(2,b'orderly shutdown');"


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("owned process condition timed out")
        time.sleep(0.02)


def gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


class ProcessTests(unittest.TestCase):
    def make(self, code=ORDERLY, *, timeout=10, grace=2):
        return _process._Process([sys.executable, "-I", "-S", "-B", "-c", code], ENV,
                                 Path.cwd(), deadline=time.monotonic() + timeout,
                                 _cleanup_grace=grace)

    def ready(self, process):
        with selectors.DefaultSelector() as selector:
            selector.register(process.reader, selectors.EVENT_READ)
            self.assertTrue(selector.select(5), "synthetic producer startup")
            self.assertEqual(process.reader.read(1), b"R")

    def test_orderly_shutdown_reaps_child_and_removes_scratch(self):
        process = self.make()
        try:
            self.ready(process)
        finally:
            process.close(healthy=True)
        self.assertTrue(process.exit["cleanup_confirmed"])
        self.assertFalse(process.exit["forced"])
        self.assertTrue(gone(process.pid))
        self.assertFalse(process.directory.exists())
        self.assertEqual(process.diagnostics, b"orderly shutdown")
        process.close(healthy=True)

    def test_deadline_shuts_down_socket_while_caller_keeps_writer(self):
        process = self.make(timeout=0.4)
        self.ready(process)
        wait_for(lambda: (process.directory / "exit.json").exists())
        with self.assertRaises(BaseExceptionGroup):
            process.close(healthy=True)
        self.assertEqual(process.exit["reason"], "deadline")
        self.assertTrue(process.exit["cleanup_confirmed"])
        self.assertTrue(gone(process.pid))
        self.assertFalse(process.directory.exists())

    def test_excessive_diagnostics_are_bounded_and_retire_channel(self):
        code = "import os; os.write(1,b'R'); os.write(2,b'x'*1_100_000); os.read(0,1)"
        process = self.make(code)
        self.ready(process)
        wait_for(lambda: (process.directory / "exit.json").exists())
        with self.assertRaises(BaseExceptionGroup):
            process.close(healthy=True)
        self.assertEqual(process.exit["reason"], "output_limit")
        self.assertEqual(len(process.diagnostics), 65_536)
        self.assertTrue(process.diagnostics_truncated)
        self.assertTrue(gone(process.pid))

    def test_immediate_child_exit_cannot_hide_excessive_diagnostics(self):
        code = "import os; os.write(1,b'R'); os.write(2,b'x'*1_048_577)"
        process = self.make(code)
        self.ready(process)
        wait_for(lambda: (process.directory / "exit.json").exists())
        with self.assertRaises(BaseExceptionGroup):
            process.close(healthy=True)
        self.assertEqual(process.exit["diagnostics_bytes"], 1_048_577)
        self.assertEqual(len(process.diagnostics), 65_536)
        self.assertTrue(process.diagnostics_truncated)
        self.assertTrue(gone(process.pid))

    def test_forced_direct_child_exit_stays_unresolved(self):
        code = "import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); os.write(1,b'R'); time.sleep(30)"
        process = self.make(code, grace=0.1)
        self.ready(process)
        try:
            with self.assertRaises(BaseExceptionGroup) as first:
                process.close(healthy=False)
            self.assertTrue(process.exit["forced"])
            self.assertFalse(process.exit["cleanup_confirmed"])
            self.assertTrue(gone(process.pid))
            self.assertTrue(process.directory.exists())
            with self.assertRaises(BaseExceptionGroup) as again:
                process.close(healthy=True)
            self.assertIs(first.exception, again.exception)
        finally:
            # This synthetic child creates no descendants. Its direct reap is
            # independently checked; removing its retained test log is safe.
            if gone(process.pid):
                import shutil
                shutil.rmtree(process.directory)

    def test_caller_loss_and_suspension_leave_guardian_effective(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                state, marker = root / "state.json", root / "retired"
                producer = ("import os,pathlib; os.read(0,1); "
                            f"pathlib.Path({str(marker)!r}).write_text('retired')")
                code = f"""
import importlib.util,json,os,pathlib,signal,sys,time
spec=importlib.util.spec_from_file_location('process_under_test',{_process.__file__!r})
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
process=module._Process([sys.executable,'-I','-S','-B','-c',{producer!r}],{ENV!r},pathlib.Path.cwd(),deadline=time.monotonic()+0.6,_cleanup_grace=2)
pathlib.Path({str(state)!r}).write_text(json.dumps({{'pid':process.pid,'directory':str(process.directory)}}))
if {stopped!r}:
    os.kill(os.getpid(),signal.SIGSTOP)
    try: process.close(healthy=False)
    except BaseException: pass
else:
    os._exit(0)
"""
                caller = subprocess.Popen([sys.executable, "-I", "-S", "-B", "-c", code],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=ENV)
                try:
                    wait_for(state.exists)
                    selected = json.loads(state.read_text())
                    wait_for(marker.exists)
                    wait_for(lambda: gone(selected["pid"]))
                    if stopped:
                        caller.send_signal(signal.SIGCONT)
                    stdout, stderr = caller.communicate(timeout=5)
                    self.assertEqual(caller.returncode, 0, stderr.decode())
                    wait_for(lambda: not Path(selected["directory"]).exists())
                finally:
                    if caller.poll() is None:
                        caller.send_signal(signal.SIGCONT)
                        caller.terminate()
                        caller.wait(timeout=5)
                    caller.stderr.close()


if __name__ == "__main__":
    unittest.main()
