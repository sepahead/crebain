#!/usr/bin/env python3
"""Bounded no-follow file helpers for managed-simulation authoring scripts."""

from __future__ import annotations

import json
import math
import os
import select
import signal
import stat
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Mapping, NoReturn, Sequence


MAX_RECIPE_BYTES = 64 * 1024
MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024
MAX_SCHEMA_BYTES = 1024 * 1024
PROCESS_IO_CHUNK_BYTES = 64 * 1024
PROCESS_TERMINATION_GRACE_SECONDS = 0.25
PROCESS_KILL_WAIT_SECONDS = 1.0
PROCESS_GROUP_OBSERVATION_SECONDS = 0.5


class ManagedSimulationSubprocessError(RuntimeError):
    """Bounded child failure with already-capped diagnostics."""

    def __init__(self, message: str, *, stdout: bytes, stderr: bytes) -> None:
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr


@dataclass(frozen=True)
class BoundedProcessResult:
    """Complete bounded observation of one direct child."""

    args: tuple[str, ...]
    returncode: int
    stdout: bytes
    stderr: bytes


class BoundedProcess:
    """Own one process session with concurrent capped output drains."""

    def __init__(
        self,
        command: Sequence[str | os.PathLike[str]],
        *,
        cwd: Path | str | None = None,
        env: Mapping[str, str] | None = None,
        stdin_pipe: bool,
        max_input_bytes: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
        label: str,
    ) -> None:
        if os.name != "posix":
            raise ManagedSimulationSubprocessError(
                f"{label} requires POSIX process-session containment",
                stdout=b"",
                stderr=b"",
            )
        normalized = tuple(os.fspath(value) for value in command)
        if not normalized or any(not value for value in normalized):
            raise ValueError("bounded process command must be nonempty")
        for name, value in (
            ("input", max_input_bytes),
            ("stdout", max_stdout_bytes),
            ("stderr", max_stderr_bytes),
        ):
            if type(value) is not int or value < 0:
                raise ValueError(f"bounded process {name} limit is invalid")
        self.command = normalized
        self.label = label
        self.max_input_bytes = max_input_bytes
        self.max_stdout_bytes = max_stdout_bytes
        self.max_stderr_bytes = max_stderr_bytes
        self._condition = threading.Condition()
        self._stdout = bytearray()
        self._stderr = bytearray()
        self._stdout_total = 0
        self._stderr_total = 0
        self._input_total = 0
        self._stdout_eof = False
        self._stderr_eof = False
        self._failure: str | None = None
        self._containment_failure: str | None = None
        self._closing = False
        self._finished = False
        self._abort_lock = threading.Lock()
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self.process = subprocess.Popen(
            list(normalized),
            cwd=os.fspath(cwd) if cwd is not None else None,
            env=dict(env) if env is not None else None,
            stdin=subprocess.PIPE if stdin_pipe else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            close_fds=True,
            start_new_session=True,
        )
        self.process_group_id = self.process.pid
        if self.process.stdout is None or self.process.stderr is None:
            self.abort()
            raise ManagedSimulationSubprocessError(
                f"{label} output pipes are unavailable",
                stdout=b"",
                stderr=b"",
            )
        self._stdout_thread = self._start_reader(
            self.process.stdout,
            stream_name="stdout",
        )
        self._stderr_thread = self._start_reader(
            self.process.stderr,
            stream_name="stderr",
        )

    @staticmethod
    def _remaining(deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if not math.isfinite(deadline) or remaining <= 0:
            return 0.0
        return remaining

    def _start_reader(self, stream: BinaryIO, *, stream_name: str) -> threading.Thread:
        thread = threading.Thread(
            target=self._drain_stream,
            args=(stream, stream_name),
            name=f"managed-simulation-{stream_name}-drain-{self.process.pid}",
            daemon=True,
        )
        thread.start()
        return thread

    def _drain_stream(self, stream: BinaryIO, stream_name: str) -> None:
        descriptor = stream.fileno()
        target = self._stdout if stream_name == "stdout" else self._stderr
        limit = (
            self.max_stdout_bytes if stream_name == "stdout" else self.max_stderr_bytes
        )
        try:
            while True:
                chunk = os.read(descriptor, PROCESS_IO_CHUNK_BYTES)
                if not chunk:
                    break
                overflow = False
                with self._condition:
                    total = (
                        self._stdout_total
                        if stream_name == "stdout"
                        else self._stderr_total
                    )
                    available = max(0, limit - total)
                    target.extend(chunk[:available])
                    total += len(chunk)
                    if stream_name == "stdout":
                        self._stdout_total = total
                    else:
                        self._stderr_total = total
                    if total > limit and self._failure is None:
                        self._failure = (
                            f"{self.label} {stream_name} exceeded {limit} bytes"
                        )
                        overflow = True
                    self._condition.notify_all()
                if overflow:
                    self._signal_group(signal.SIGKILL)
                    break
        except OSError as error:
            with self._condition:
                if not self._closing and self._failure is None:
                    self._failure = f"{self.label} {stream_name} drain failed: {error}"
                self._condition.notify_all()
        finally:
            with self._condition:
                if stream_name == "stdout":
                    self._stdout_eof = True
                else:
                    self._stderr_eof = True
                self._condition.notify_all()

    def _signal_group(self, process_signal: int) -> None:
        try:
            os.killpg(self.process_group_id, process_signal)
        except ProcessLookupError:
            pass
        except OSError as error:
            with self._condition:
                if self._failure is None:
                    self._failure = f"{self.label} process-group signal failed: {error}"
                self._condition.notify_all()

    def _group_exists(self) -> bool:
        try:
            os.killpg(self.process_group_id, 0)
        except ProcessLookupError:
            return False
        except OSError:
            return True
        return True

    def _captured(self) -> tuple[bytes, bytes]:
        with self._condition:
            return bytes(self._stdout), bytes(self._stderr)

    def _error(self, message: str) -> ManagedSimulationSubprocessError:
        stdout, stderr = self._captured()
        with self._condition:
            containment_failure = self._containment_failure
        if containment_failure is not None and containment_failure not in message:
            message = f"{message}; {containment_failure}"
        return ManagedSimulationSubprocessError(
            message,
            stdout=stdout,
            stderr=stderr,
        )

    def _raise_if_failed(self) -> None:
        with self._condition:
            failure = self._failure
        if failure is not None:
            self.abort()
            raise self._error(failure)

    def write_all(self, payload: bytes, *, deadline: float) -> None:
        """Write exact bytes without blocking beyond one absolute deadline."""

        if not isinstance(payload, bytes):
            raise TypeError("bounded process input must be bytes")
        if self.process.stdin is None or self.process.stdin.closed:
            raise self._error(f"{self.label} input pipe is unavailable")
        if self._input_total + len(payload) > self.max_input_bytes:
            self.abort()
            raise self._error(
                f"{self.label} input exceeded {self.max_input_bytes} bytes"
            )
        try:
            descriptor = self.process.stdin.fileno()
            os.set_blocking(descriptor, False)
        except (OSError, ValueError) as error:
            self.abort()
            raise self._error(f"{self.label} input setup failed: {error}") from error
        view = memoryview(payload)
        while view:
            self._raise_if_failed()
            remaining = self._remaining(deadline)
            if remaining <= 0:
                self.abort()
                raise self._error(f"{self.label} input deadline expired")
            if self.process.poll() is not None:
                self.abort()
                raise self._error(f"{self.label} exited before input completed")
            try:
                writable = select.select([], [descriptor], [], min(remaining, 0.05))[1]
            except (OSError, ValueError) as error:
                self.abort()
                raise self._error(f"{self.label} input poll failed: {error}") from error
            if not writable:
                continue
            try:
                written = os.write(descriptor, view)
            except BlockingIOError:
                continue
            except BrokenPipeError as error:
                self.abort()
                raise self._error(f"{self.label} closed its input early") from error
            except OSError as error:
                self.abort()
                raise self._error(
                    f"{self.label} input write failed: {error}"
                ) from error
            if written <= 0:
                self.abort()
                raise self._error(f"{self.label} input write made no progress")
            self._input_total += written
            view = view[written:]

    def close_stdin(self) -> None:
        if self.process.stdin is not None and not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError as error:
                with self._condition:
                    if not self._closing and self._failure is None:
                        self._failure = f"{self.label} input close failed: {error}"
                    self._condition.notify_all()

    def read_exact(self, length: int, *, deadline: float) -> bytes:
        """Read exact stdout bytes under the caller's absolute deadline."""

        if type(length) is not int or length < 0:
            raise ValueError("bounded process read length is invalid")
        with self._condition:
            while len(self._stdout) < length:
                if self._failure is not None:
                    failure = self._failure
                    break
                if self._stdout_eof:
                    failure = f"{self.label} closed stdout before the expected bytes"
                    break
                remaining = self._remaining(deadline)
                if remaining <= 0:
                    failure = f"{self.label} output deadline expired"
                    break
                self._condition.wait(timeout=min(remaining, 0.05))
            else:
                output = bytes(self._stdout[:length])
                del self._stdout[:length]
                return output
        self.abort()
        raise self._error(failure)

    def send_signal(self, process_signal: int) -> None:
        """Signal the complete owned process group."""

        with self._condition:
            if self._finished:
                raise self._error(f"{self.label} process session is already terminal")
        self._signal_group(process_signal)

    def wait(self, *, deadline: float) -> BoundedProcessResult:
        """Wait once, drain both outputs, and reject surviving descendants."""

        self.close_stdin()
        self._raise_if_failed()
        remaining = self._remaining(deadline)
        if remaining <= 0:
            self.abort()
            raise self._error(f"{self.label} process deadline expired")
        try:
            returncode = self.process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as error:
            self.abort()
            raise self._error(f"{self.label} process deadline expired") from error
        with self._condition:
            while not (self._stdout_eof and self._stderr_eof):
                if self._failure is not None:
                    break
                remaining = self._remaining(deadline)
                if remaining <= 0:
                    break
                self._condition.wait(timeout=min(remaining, 0.05))
            failure = self._failure
            streams_complete = self._stdout_eof and self._stderr_eof
        if failure is not None:
            self.abort()
            raise self._error(failure)
        if not streams_complete:
            self.abort()
            raise self._error(
                f"{self.label} descendants retained output pipes after child exit"
            )
        if self._group_exists():
            self.abort()
            raise self._error(f"{self.label} descendants survived direct-child exit")
        with self._condition:
            self._finished = True
            self._condition.notify_all()
        self._close_streams()
        stdout, stderr = self._captured()
        return BoundedProcessResult(
            args=self.command,
            returncode=returncode,
            stdout=stdout,
            stderr=stderr,
        )

    def abort(self) -> None:
        """Terminate, reap, and close the complete owned process session."""

        with self._abort_lock:
            if self._finished:
                self._close_streams()
                return
            with self._condition:
                self._closing = True
                self._condition.notify_all()
            self.close_stdin()
            self._signal_group(signal.SIGTERM)
            grace_deadline = time.monotonic() + PROCESS_TERMINATION_GRACE_SECONDS
            while self.process.poll() is None and time.monotonic() < grace_deadline:
                time.sleep(0.01)
            if self.process.poll() is None or self._group_exists():
                self._signal_group(signal.SIGKILL)
            try:
                self.process.wait(timeout=PROCESS_KILL_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    self.process.kill()
                except OSError:
                    pass
                try:
                    self.process.wait(timeout=PROCESS_KILL_WAIT_SECONDS)
                except subprocess.TimeoutExpired:
                    with self._condition:
                        self._containment_failure = (
                            f"{self.label} direct child could not be reaped"
                        )
            observation_deadline = time.monotonic() + PROCESS_GROUP_OBSERVATION_SECONDS
            while self._group_exists() and time.monotonic() < observation_deadline:
                self._signal_group(signal.SIGKILL)
                time.sleep(0.01)
            if self._group_exists():
                with self._condition:
                    self._containment_failure = (
                        f"{self.label} process group survived forced termination"
                    )
            with self._condition:
                self._finished = True
                self._condition.notify_all()
            self._close_streams()

    def _close_streams(self) -> None:
        with self._condition:
            self._closing = True
            self._condition.notify_all()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except OSError:
                    pass
        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=PROCESS_GROUP_OBSERVATION_SECONDS)


def run_bounded_process(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    input_bytes: bytes | None,
    timeout_seconds: float,
    max_input_bytes: int,
    max_stdout_bytes: int,
    max_stderr_bytes: int,
    label: str,
) -> BoundedProcessResult:
    """Run one child with concurrent drains and one absolute work deadline."""

    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
    ):
        raise ValueError("bounded process timeout must be finite and positive")
    deadline = time.monotonic() + float(timeout_seconds)
    session = BoundedProcess(
        command,
        cwd=cwd,
        env=env,
        stdin_pipe=input_bytes is not None,
        max_input_bytes=max_input_bytes,
        max_stdout_bytes=max_stdout_bytes,
        max_stderr_bytes=max_stderr_bytes,
        label=label,
    )
    try:
        if input_bytes is not None:
            session.write_all(input_bytes, deadline=deadline)
            session.close_stdin()
        return session.wait(deadline=deadline)
    except BaseException:
        session.abort()
        raise


def reject(reason: str) -> NoReturn:
    raise SystemExit(reason)


def safe_relative(value: Any) -> PurePosixPath:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        reject("package path is not a nonempty POSIX string")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        reject(f"package path is unsafe: {value}")
    if str(relative) != value:
        reject(f"package path is not canonical: {value}")
    return relative


def open_regular(source: Path, max_bytes: int) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source, flags)
    except OSError as error:
        reject(f"source cannot be opened without following links: {source}: {error}")
    observed = os.fstat(descriptor)
    if (
        not stat.S_ISREG(observed.st_mode)
        or observed.st_uid != os.geteuid()
        or observed.st_nlink != 1
        or observed.st_size <= 0
        or observed.st_size > max_bytes
    ):
        os.close(descriptor)
        reject(f"source is not a bounded owner-controlled regular file: {source}")
    return descriptor, observed


def same_file_observation(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_uid,
        before.st_nlink,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_uid,
        after.st_nlink,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )


def read_regular_observed(source: Path, max_bytes: int) -> tuple[bytes, os.stat_result]:
    descriptor, observed = open_regular(source, max_bytes)
    with os.fdopen(descriptor, "rb", closefd=True) as handle:
        payload = handle.read(observed.st_size + 1)
        after = os.fstat(handle.fileno())
    if len(payload) != observed.st_size or not same_file_observation(observed, after):
        reject(f"source changed while it was read: {source}")
    return payload, observed


def read_regular(source: Path, max_bytes: int) -> bytes:
    payload, _observed = read_regular_observed(source, max_bytes)
    return payload


def decode_json_object(payload: bytes, *, label: str) -> dict[str, Any]:
    def closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                reject(f"JSON contains a duplicate member: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        reject(f"JSON contains a non-finite number: {value}")

    try:
        document = json.loads(
            payload,
            object_pairs_hook=closed_object,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        reject(f"source is not strict JSON: {label}: {error}")
    if not isinstance(document, dict):
        reject("JSON root must be an object")
    return document


def load_json_object(source: Path, max_bytes: int = MAX_RECIPE_BYTES) -> dict[str, Any]:
    payload = read_regular(source, max_bytes)
    return decode_json_object(payload, label=str(source))


def copy_regular(source: Path, destination: Path, mode: int, max_bytes: int) -> None:
    source_descriptor, observed = open_regular(source, max_bytes)
    source_open = True
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists() or destination.is_symlink():
        os.close(source_descriptor)
        reject(f"destination already exists: {destination}")
    destination_descriptor: int | None = None
    temporary: Path | None = None
    temporary_identity: tuple[int, int] | None = None
    published = False
    complete = False
    copied = 0
    try:
        destination_descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
        )
        temporary = Path(raw_temporary)
        temporary_observation = os.fstat(destination_descriptor)
        if (
            not stat.S_ISREG(temporary_observation.st_mode)
            or temporary_observation.st_uid != os.geteuid()
            or temporary_observation.st_nlink != 1
        ):
            reject(f"copy temporary file is not owner-controlled: {destination}")
        temporary_identity = (
            temporary_observation.st_dev,
            temporary_observation.st_ino,
        )
        while copied < observed.st_size:
            chunk = os.read(
                source_descriptor, min(1024 * 1024, observed.st_size - copied)
            )
            if not chunk:
                reject(f"source changed while it was copied: {source}")
            view = memoryview(chunk)
            while view:
                written = os.write(destination_descriptor, view)
                if written <= 0:
                    reject(f"destination write made no progress: {destination}")
                copied += written
                view = view[written:]
        if os.read(source_descriptor, 1):
            reject(f"source grew while it was copied: {source}")
        after = os.fstat(source_descriptor)
        if not same_file_observation(observed, after):
            reject(f"source changed while it was copied: {source}")
        if copied != observed.st_size:
            reject(f"source copy length changed: {source}")
        os.fchmod(destination_descriptor, mode)
        os.fsync(destination_descriptor)
        os.close(destination_descriptor)
        destination_descriptor = None
        os.close(source_descriptor)
        source_open = False
        try:
            os.link(temporary, destination, follow_symlinks=False)
        except OSError as error:
            reject(
                f"destination cannot publish without replacement: {destination}: {error}"
            )
        published = True
        temporary.unlink()
        temporary = None
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        directory_descriptor = os.open(destination.parent, directory_flags)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
        complete = True
    finally:
        if source_open:
            os.close(source_descriptor)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        if temporary is not None and temporary_identity is not None:
            try:
                temporary_observation = temporary.lstat()
                if (
                    stat.S_ISREG(temporary_observation.st_mode)
                    and (
                        temporary_observation.st_dev,
                        temporary_observation.st_ino,
                    )
                    == temporary_identity
                ):
                    temporary.unlink()
            except FileNotFoundError:
                pass
        if published and not complete and temporary_identity is not None:
            try:
                destination_observation = destination.lstat()
                if (
                    stat.S_ISREG(destination_observation.st_mode)
                    and (
                        destination_observation.st_dev,
                        destination_observation.st_ino,
                    )
                    == temporary_identity
                ):
                    destination.unlink()
            except FileNotFoundError:
                pass


def write_new_regular(
    path: Path,
    payload: bytes,
    *,
    label: str,
    fail: Callable[[str], NoReturn] = reject,
) -> None:
    descriptor: int | None = None
    temporary: Path | None = None
    temporary_identity: tuple[int, int] | None = None
    published = False
    complete = False
    try:
        descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary = Path(raw_temporary)
        observed = os.fstat(descriptor)
        if (
            not stat.S_ISREG(observed.st_mode)
            or observed.st_uid != os.geteuid()
            or observed.st_nlink != 1
        ):
            fail(f"{label} temporary file is not owner-controlled")
        temporary_identity = (observed.st_dev, observed.st_ino)
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                fail(f"{label} write made no progress")
            written += count
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        try:
            os.link(temporary, path, follow_symlinks=False)
        except OSError as error:
            fail(f"{label} cannot publish without replacement: {error}")
        published = True
        temporary.unlink()
        temporary = None
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        directory_descriptor = os.open(path.parent, directory_flags)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
        complete = True
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary is not None and temporary_identity is not None:
            try:
                observed = temporary.lstat()
                if (
                    stat.S_ISREG(observed.st_mode)
                    and (observed.st_dev, observed.st_ino) == temporary_identity
                ):
                    temporary.unlink()
            except FileNotFoundError:
                pass
        if published and not complete and temporary_identity is not None:
            try:
                observed = path.lstat()
                if (
                    stat.S_ISREG(observed.st_mode)
                    and (observed.st_dev, observed.st_ino) == temporary_identity
                ):
                    path.unlink()
            except FileNotFoundError:
                pass


def absolute_without_resolving_leaf(path: Path) -> Path:
    return Path(os.path.abspath(path))
