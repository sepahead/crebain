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
    def __init__(self, command, environment, cwd, *, deadline, _cleanup_grace=CLEANUP_GRACE_S,
                 _family_endpoints=None):
        if sys.platform not in {"darwin", "linux"}:
            raise ProcessError("the sensor launcher requires macOS or Linux")
        self._closed = False
        self._cleanup_error = None
        self._guard = self._socket = self._service = self._guard_stderr = None
        self._sockets, self._services = [], []
        self.streams = []
        self._endpoint_shutdown = set()
        self._family = _family_endpoints is not None
        if self._family and (type(_family_endpoints) is not int or not 2 <= _family_endpoints <= 16):
            raise ProcessError("family requires 2–16 selected endpoints")
        self._endpoint_count = _family_endpoints if self._family else 1
        self._log_bytes = 131_072 if self._family else 65_536
        self._start_schema = "crebain.family-process-start.v1" if self._family else "crebain.sensor-process-start.v1"
        self._exit_schema = "crebain.family-process-exit.v1" if self._family else "crebain.sensor-process-exit.v1"
        self.reader = self.writer = self.directory = self.pid = self.exit = None
        self.diagnostics = b""
        self.diagnostics_truncated = False
        self._cleanup_grace = _cleanup_grace
        try:
            self.directory = Path(tempfile.mkdtemp(prefix="crebain-sensors-"))
            for _ in range(self._endpoint_count):
                host, service = socket.socketpair()
                self._sockets.append(host)
                self._services.append(service)
                # Append each wrapper immediately so partial construction can close it.
                self.streams.append([])
                self.streams[-1].append(host.makefile("rb", buffering=0))
                self.streams[-1].append(host.makefile("wb", buffering=0))
            self._socket, self._service = self._sockets[0], self._services[0]
            self.reader, self.writer = self.streams[0]
            selected_command = list(map(str, command))
            service_fds = [service.fileno() for service in self._services]
            host_fds = [host.fileno() for host in self._sockets]
            if self._family:
                selected_command.extend(("--service-fds-json", json.dumps(service_fds, separators=(",", ":"))))
            spec = self.directory / "launch.json"
            spec.write_text(json.dumps({
                "command": selected_command, "cwd": str(cwd),
                "environment": {**environment, "TMPDIR": str(self.directory)},
                "deadline": deadline, "cleanup_grace": _cleanup_grace,
            }), encoding="utf-8")
            self._guard_stderr = (self.directory / "guardian.log").open("xb")
            descriptors = (["--family-service-fds-json", json.dumps(service_fds),
                            "--family-host-fds-json", json.dumps(host_fds)] if self._family else
                           ["--service-fd", str(service_fds[0]), "--host-fd", str(host_fds[0])])
            self._guard = subprocess.Popen(
                [sys.executable, "-I", "-S", "-B", str(Path(__file__).with_name("_guardian.py")),
                 "--spec", str(spec), *descriptors],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._guard_stderr,
                pass_fds=tuple((*service_fds, *host_fds)),
                close_fds=True, bufsize=0,
                env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
            )
            for service in self._services:
                service.close()
            self._services.clear()
            self._service = None
            row = _row(self._guard.stdout, deadline)
            expected = {"schema", "pid"} | ({"endpoint_count"} if self._family else set())
            if (set(row) != expected or row["schema"] != self._start_schema
                    or (self._family and (type(row["endpoint_count"]) is not int or row["endpoint_count"] != self._endpoint_count))
                    or type(row["pid"]) is not int or row["pid"] <= 0):
                raise ProcessError("invalid producer start receipt")
            self.pid = row["pid"]
        except BaseException as primary:
            try:
                self.close(healthy=False)
            except BaseException as cleanup:
                raise BaseExceptionGroup("producer startup and cleanup failed", [primary, cleanup])
            raise

    def close_endpoint(self, slot):
        """Request real socket shutdown; this cannot substitute for the owner's EOF fact."""
        if type(slot) is not int or not 0 <= slot < self._endpoint_count:
            raise ProcessError("selected endpoint index required")
        if slot in self._endpoint_shutdown:
            return
        try:
            self._sockets[slot].shutdown(socket.SHUT_RDWR)
        except OSError as error:
            if error.errno != errno.ENOTCONN:
                raise
        self._endpoint_shutdown.add(slot)

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

        for slot in range(len(self._sockets)):
            # Shutdown reaches the guardian's duplicate even when wrappers remain live.
            attempt(lambda slot=slot: self.close_endpoint(slot))
        for service in self._services:
            attempt(service.close)
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
                start_fields = {"schema", "pid"} | ({"endpoint_count"} if self._family else set())
                if row is not None and self.pid is None and row.get("schema") == self._start_schema:
                    if (set(row) == start_fields and type(row["pid"]) is int and row["pid"] > 0
                            and (not self._family or (type(row["endpoint_count"]) is int and row["endpoint_count"] == self._endpoint_count))):
                        self.pid = row["pid"]
                        row = attempt(lambda: _row(guard.stdout, time.monotonic() + 1))
                valid = (
                    guard.returncode == 0 and row is not None and self.pid is not None
                    and set(row) == ({"schema", "pid", "returncode", "reason", "forced",
                                     "diagnostics_bytes", "diagnostics_truncated", "cleanup_confirmed"}
                                    | ({"endpoint_count"} if self._family else set()))
                    and row["schema"] == self._exit_schema
                    and (not self._family or (type(row["endpoint_count"]) is int and row["endpoint_count"] == self._endpoint_count))
                    and type(row["pid"]) is int and row["pid"] == self.pid
                    and type(row["returncode"]) is int and -127 <= row["returncode"] <= 255
                    and type(row["reason"]) is str
                    and row["reason"] in {"producer_exit", "deadline", "owner_lost", "owner_shutdown", "output_limit"}
                    and all(type(row[key]) is bool for key in ("forced", "diagnostics_truncated", "cleanup_confirmed"))
                    and type(row["diagnostics_bytes"]) is int and row["diagnostics_bytes"] >= 0
                    and row["diagnostics_truncated"] == (row["diagnostics_bytes"] > self._log_bytes)
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
        streams = [stream for pair in self.streams for stream in pair]
        for stream in (*streams, *self._sockets, self._guard_stderr):
            if stream is not None:
                attempt(stream.close)
        if self.directory is not None:
            def diagnostics():
                path = self.directory / "stderr.log"
                if path.exists():
                    with path.open("rb") as stream:
                        self.diagnostics = stream.read(self._log_bytes)
            attempt(diagnostics)
            if resolved:
                attempt(lambda: shutil.rmtree(self.directory))
        if errors:
            self._cleanup_error = BaseExceptionGroup("producer cleanup failed", errors)
            raise self._cleanup_error
