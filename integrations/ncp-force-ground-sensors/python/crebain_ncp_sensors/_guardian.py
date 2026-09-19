"""Independent lifetime owner for one trusted producer and its cleanup chain.

Run with Python -I -S. Application imports and caller threads never run here.
Socket shutdown preserves the existing Rust, Bun, and Node retirement owners.
Emergency termination of Rust cannot confirm renderer-family retirement.
"""

import argparse
import errno
import json
import math
import os
from pathlib import Path
import resource
import selectors
import shutil
import socket
import subprocess
import sys
import time


LOG_BYTES = 65_536
OUTPUT_BYTES = 1_048_576


def _limits():
    os.umask(0o077)
    for kind, ceiling in (
        (resource.RLIMIT_CPU, 600),
        (resource.RLIMIT_FSIZE, 64 * 1024**2),
        (resource.RLIMIT_NOFILE, 1024),
        (resource.RLIMIT_CORE, 0),
    ):
        ceiling = min(
            value for value in (ceiling, *resource.getrlimit(kind))
            if value != resource.RLIM_INFINITY
        )
        resource.setrlimit(kind, (ceiling, ceiling))


def _emit(row):
    try:
        os.write(sys.stdout.fileno(), (json.dumps(row, separators=(",", ":")) + "\n").encode())
    except BrokenPipeError:
        pass  # The lifetime pipe, not a diagnostic reader, owns the session.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--service-fd", required=True, type=int)
    parser.add_argument("--host-fd", required=True, type=int)
    args = parser.parse_args()
    path = Path(args.spec)
    with path.open("rb") as source:
        raw = source.read(65_537)
    if len(raw) > 65_536:
        raise ValueError("bounded launch specification required")
    spec = json.loads(raw)
    if (
        type(spec) is not dict
        or set(spec) != {"command", "cwd", "environment", "deadline", "cleanup_grace"}
        or type(spec["deadline"]) not in (int, float)
        or not math.isfinite(spec["deadline"])
        or not 0 < spec["deadline"] - time.monotonic() <= 600
        or type(spec["cleanup_grace"]) not in (int, float)
        or not 0 < spec["cleanup_grace"] <= 205
    ):
        raise ValueError("invalid launch deadline or cleanup grace")
    channel = socket.socket(fileno=args.host_fd)
    child = subprocess.Popen(
        spec["command"], cwd=spec["cwd"], env=spec["environment"],
        stdin=args.service_fd, stdout=args.service_fd, stderr=subprocess.PIPE,
        close_fds=True, start_new_session=True, preexec_fn=_limits,
        bufsize=0,
    )
    os.close(args.service_fd)
    reason = "producer_exit"
    stopping = None
    owner_gone = False
    forced = False
    channel_closed = False
    observed = retained = 0
    _emit({"schema": "crebain.sensor-process-start.v1", "pid": child.pid})
    try:
        with selectors.DefaultSelector() as selector, (path.parent / "stderr.log").open("xb") as log:
            selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "lifetime")
            selector.register(child.stderr, selectors.EVENT_READ, "stderr")
            os.set_blocking(child.stderr.fileno(), False)
            while child.poll() is None:
                now = time.monotonic()
                if stopping is None and now >= spec["deadline"]:
                    reason = "deadline"
                    stopping = now
                if stopping is not None:
                    # This descriptor shares the host socket, even if its caller
                    # still holds another reference. No peer can keep it open.
                    if not channel_closed:
                        try:
                            channel.shutdown(socket.SHUT_RDWR)
                        except OSError as error:
                            if error.errno != errno.ENOTCONN:
                                raise
                        channel_closed = True
                    if now - stopping >= spec["cleanup_grace"]:
                        forced = True
                        break
                for key, _ in selector.select(0.05):
                    if key.data == "lifetime":
                        value = os.read(sys.stdin.fileno(), 1)
                        if not value:
                            owner_gone = True
                            selector.unregister(sys.stdin.fileno())
                        if stopping is None:
                            reason = "owner_lost" if not value else "owner_shutdown"
                            stopping = time.monotonic()
                    else:
                        value = os.read(child.stderr.fileno(), LOG_BYTES)
                        if not value:
                            selector.unregister(child.stderr)
                            continue
                        observed += len(value)
                        selected = value[:max(0, LOG_BYTES - retained)]
                        log.write(selected)
                        retained += len(selected)
                        if observed > OUTPUT_BYTES and stopping is None:
                            reason = "output_limit"
                            stopping = time.monotonic()
            # Drain available diagnostics only. A descendant retaining stderr
            # cannot extend the session by withholding pipe EOF.
            while observed <= OUTPUT_BYTES:
                try:
                    value = os.read(child.stderr.fileno(), LOG_BYTES)
                except BlockingIOError:
                    break
                if not value:
                    break
                observed += len(value)
                selected = value[:max(0, LOG_BYTES - retained)]
                log.write(selected)
                retained += len(selected)
                if observed > OUTPUT_BYTES and stopping is None:
                    reason = "output_limit"
                    stopping = time.monotonic()
    finally:
        channel.close()
        if child.poll() is None:
            forced = True
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        child.stderr.close()
        row = {
            "schema": "crebain.sensor-process-exit.v1", "pid": child.pid,
            "returncode": child.returncode, "reason": reason, "forced": forced,
            "diagnostics_bytes": observed,
            "diagnostics_truncated": observed > LOG_BYTES,
            "cleanup_confirmed": not forced and child.returncode == 0,
        }
        (path.parent / "exit.json").write_text(json.dumps(row) + "\n", encoding="utf-8")
        _emit(row)
        if owner_gone and row["cleanup_confirmed"]:
            shutil.rmtree(path.parent)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
