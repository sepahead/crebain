"""Private process custody, independent of sensor and NCP semantics."""

import errno
import json
import os
from pathlib import Path
import selectors
import shutil
import socket
import subprocess
import sys
import tempfile
import time


CLEANUP_GRACE_S = 205


class ProcessError(RuntimeError):
    """Process startup or retirement did not establish its required state."""


def _row(stream, deadline):
    wire = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        while len(wire) < 4096:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise ProcessError("producer guardian receipt timed out")
            value = os.read(stream.fileno(), 1)
            if not value:
                raise ProcessError("producer guardian closed before its receipt")
            wire.extend(value)
            if value == b"\n":
                result = json.loads(wire)
                if type(result) is not dict:
                    raise ProcessError("producer guardian receipt is not an object")
                return result
    raise ProcessError("producer guardian receipt exceeds its limit")


class _Process:
    def __init__(self, command, environment, cwd, *, deadline, _cleanup_grace=CLEANUP_GRACE_S):
        if sys.platform not in {"darwin", "linux"}:
            raise ProcessError("the sensor launcher requires macOS or Linux")
        self._closed = False
        self._cleanup_error = None
        self._guard = self._socket = self._service = self._guard_stderr = None
        self.reader = self.writer = self.directory = self.pid = self.exit = None
        self.diagnostics = b""
        self.diagnostics_truncated = False
        self._cleanup_grace = _cleanup_grace
        try:
            self.directory = Path(tempfile.mkdtemp(prefix="crebain-sensors-"))
            self._socket, self._service = socket.socketpair()
            self.reader = self._socket.makefile("rb", buffering=0)
            self.writer = self._socket.makefile("wb", buffering=0)
            spec = self.directory / "launch.json"
            spec.write_text(json.dumps({
                "command": list(map(str, command)), "cwd": str(cwd),
                "environment": {**environment, "TMPDIR": str(self.directory)},
                "deadline": deadline, "cleanup_grace": _cleanup_grace,
            }), encoding="utf-8")
            self._guard_stderr = (self.directory / "guardian.log").open("xb")
            self._guard = subprocess.Popen(
                [sys.executable, "-I", "-S", "-B", str(Path(__file__).with_name("_guardian.py")),
                 "--spec", str(spec), "--service-fd", str(self._service.fileno()),
                 "--host-fd", str(self._socket.fileno())],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._guard_stderr,
                pass_fds=(self._service.fileno(), self._socket.fileno()),
                close_fds=True, bufsize=0,
                env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
            )
            self._service.close()
            self._service = None
            row = _row(self._guard.stdout, deadline)
            if (set(row) != {"schema", "pid"} or row["schema"] != "crebain.sensor-process-start.v1"
                    or type(row["pid"]) is not int or row["pid"] <= 0):
                raise ProcessError("invalid producer start receipt")
            self.pid = row["pid"]
        except BaseException as primary:
            try:
                self.close(healthy=False)
            except BaseException as cleanup:
                raise BaseExceptionGroup("producer startup and cleanup failed", [primary, cleanup])
            raise

    def close(self, *, healthy):
        if self._closed:
            if self._cleanup_error is not None:
                raise self._cleanup_error
            return
        self._closed = True
        errors = []

        def attempt(call):
            try:
                return call()
            except BaseException as error:
                errors.append(error)
                return None

        if self._socket is not None:
            # Unlike closing a makefile, this sends EOF despite shared references.
            def shutdown():
                try:
                    self._socket.shutdown(socket.SHUT_RDWR)
                except OSError as error:
                    if error.errno != errno.ENOTCONN:
                        raise
            attempt(shutdown)
        if self._service is not None:
            attempt(self._service.close)
        resolved = self._guard is None
        if self._guard is not None:
            guard = self._guard
            try:
                guard.stdin.write(b"S")
            except BrokenPipeError:
                pass
            except BaseException as error:
                errors.append(error)
            attempt(lambda: guard.wait(timeout=self._cleanup_grace + 5))
            if guard.poll() is None:
                errors.append(ProcessError(f"guardian retirement unresolved; retained {self.directory}"))
            else:
                row = attempt(lambda: _row(guard.stdout, time.monotonic() + 1))
                if row is not None and self.pid is None and row.get("schema") == "crebain.sensor-process-start.v1":
                    if set(row) == {"schema", "pid"} and type(row["pid"]) is int and row["pid"] > 0:
                        self.pid = row["pid"]
                        row = attempt(lambda: _row(guard.stdout, time.monotonic() + 1))
                valid = (
                    guard.returncode == 0 and row is not None and self.pid is not None
                    and set(row) == {"schema", "pid", "returncode", "reason", "forced",
                                    "diagnostics_bytes", "diagnostics_truncated", "cleanup_confirmed"}
                    and row["schema"] == "crebain.sensor-process-exit.v1"
                    and type(row["pid"]) is int and row["pid"] == self.pid
                    and type(row["returncode"]) is int and -127 <= row["returncode"] <= 255
                    and type(row["reason"]) is str
                    and row["reason"] in {"producer_exit", "deadline", "owner_lost", "owner_shutdown", "output_limit"}
                    and all(type(row[key]) is bool for key in ("forced", "diagnostics_truncated", "cleanup_confirmed"))
                    and type(row["diagnostics_bytes"]) is int and row["diagnostics_bytes"] >= 0
                    and row["diagnostics_truncated"] == (row["diagnostics_bytes"] > 65_536)
                    and row["cleanup_confirmed"] == (not row["forced"] and row["returncode"] == 0)
                )
                if valid:
                    self.exit = row
                    self.diagnostics_truncated = row["diagnostics_truncated"]
                    resolved = row["cleanup_confirmed"]
                    if not resolved:
                        errors.append(ProcessError(f"producer exited without confirmed family cleanup; retained {self.directory}"))
                    if healthy and (row["reason"] not in {"producer_exit", "owner_shutdown"}
                                    or row["diagnostics_bytes"] > 1_048_576):
                        errors.append(ProcessError("producer session exceeded its lifetime or output limit"))
                else:
                    errors.append(ProcessError(f"producer retirement receipt invalid; retained {self.directory}"))
            attempt(guard.stdin.close)
            attempt(guard.stdout.close)
        for stream in (self.reader, self.writer, self._socket, self._guard_stderr):
            if stream is not None:
                attempt(stream.close)
        if self.directory is not None:
            def diagnostics():
                path = self.directory / "stderr.log"
                if path.exists():
                    with path.open("rb") as stream:
                        self.diagnostics = stream.read(65_536)
            attempt(diagnostics)
            if resolved:
                attempt(lambda: shutil.rmtree(self.directory))
        if errors:
            self._cleanup_error = BaseExceptionGroup("producer cleanup failed", errors)
            raise self._cleanup_error
