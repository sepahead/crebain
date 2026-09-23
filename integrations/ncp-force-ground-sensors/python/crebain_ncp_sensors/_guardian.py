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


def _descriptor_roster(args):
    family = args.family_service_fds_json is not None or args.family_host_fds_json is not None
    if family:
        if args.service_fd is not None or args.host_fd is not None:
            raise ValueError("select one guardian channel construction")
        values = (args.family_service_fds_json, args.family_host_fds_json)
        if any(type(value) is not str or len(value) > 512 for value in values):
            raise ValueError("bounded paired family descriptor rosters required")
        service, host = map(json.loads, values)
        if (type(service) is not list or type(host) is not list or not 2 <= len(service) <= 16
                or len(service) != len(host)):
            raise ValueError("family descriptor roster extent")
    else:
        service, host = [args.service_fd], [args.host_fd]
    selected = service + host
    if (any(type(fd) is not int or fd < 3 for fd in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError("distinct transferred guardian descriptors required")
    return family, service, host


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--service-fd", type=int)
    parser.add_argument("--host-fd", type=int)
    parser.add_argument("--family-service-fds-json")
    parser.add_argument("--family-host-fds-json")
    args = parser.parse_args()
    family, service_fds, host_fds = _descriptor_roster(args)
    log_bytes = 131_072 if family else LOG_BYTES
    schema_prefix = "crebain.family-process" if family else "crebain.sensor-process"
    extra = {"endpoint_count": len(service_fds)} if family else {}
    spec_limit = 131_072 if family else 65_536
    path = Path(args.spec)
    with path.open("rb") as source:
        raw = source.read(spec_limit + 1)
    if len(raw) > spec_limit:
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
    channels = [socket.socket(fileno=fd) for fd in host_fds]
    if family and spec["command"][-2:] != ["--service-fds-json", json.dumps(service_fds, separators=(",", ":"))]:
        raise ValueError("family producer descriptor roster differs")
    child = subprocess.Popen(
        spec["command"], cwd=spec["cwd"], env=spec["environment"],
        stdin=subprocess.DEVNULL if family else service_fds[0],
        stdout=subprocess.DEVNULL if family else service_fds[0], stderr=subprocess.PIPE,
        pass_fds=tuple(service_fds) if family else (),
        close_fds=True, start_new_session=True, preexec_fn=_limits,
        bufsize=0,
    )
    reason = "producer_exit"
    stopping = None
    owner_gone = False
    forced = False
    channel_closed = False
    observed = retained = 0
    primary = None
    try:
        for fd in service_fds:
            os.close(fd)
        _emit({"schema": schema_prefix + "-start.v1", "pid": child.pid, **extra})
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
                        for channel in channels:
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
                        value = os.read(child.stderr.fileno(), log_bytes)
                        if not value:
                            selector.unregister(child.stderr)
                            continue
                        observed += len(value)
                        selected = value[:max(0, log_bytes - retained)]
                        log.write(selected)
                        retained += len(selected)
                        if observed > OUTPUT_BYTES and stopping is None:
                            reason = "output_limit"
                            stopping = time.monotonic()
            # Drain available diagnostics only. A descendant retaining stderr
            # cannot extend the session by withholding pipe EOF.
            while observed <= OUTPUT_BYTES:
                try:
                    value = os.read(child.stderr.fileno(), log_bytes)
                except BlockingIOError:
                    break
                if not value:
                    break
                observed += len(value)
                selected = value[:max(0, log_bytes - retained)]
                log.write(selected)
                retained += len(selected)
                if observed > OUTPUT_BYTES and stopping is None:
                    reason = "output_limit"
                    stopping = time.monotonic()
    except BaseException as error:
        primary = error
    finally:
        cleanup = []

        def attempt(operation):
            try:
                return operation()
            except BaseException as error:
                cleanup.append(error)
                return None

        for channel in channels:
            attempt(channel.close)
        if child.poll() is None:
            forced = True
            attempt(child.terminate)
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                attempt(child.kill)
                attempt(lambda: child.wait(timeout=2))
            except BaseException as error:
                cleanup.append(error)
                if child.poll() is None:
                    attempt(child.kill)
                    attempt(lambda: child.wait(timeout=2))
        attempt(child.stderr.close)
        row = {
            "schema": schema_prefix + "-exit.v1", "pid": child.pid,
            "returncode": child.returncode, "reason": reason, "forced": forced,
            "diagnostics_bytes": observed,
            "diagnostics_truncated": observed > log_bytes,
            "cleanup_confirmed": not forced and child.returncode == 0,
            **extra,
        }
        attempt(lambda: (path.parent / "exit.json").write_text(json.dumps(row) + "\n", encoding="utf-8"))
        attempt(lambda: _emit(row))
        if owner_gone and row["cleanup_confirmed"]:
            attempt(lambda: shutil.rmtree(path.parent))
        if primary is not None and cleanup:
            raise BaseExceptionGroup("guardian operation and cleanup failed", [primary, *cleanup])
        if cleanup:
            raise BaseExceptionGroup("guardian cleanup failed", cleanup)
    if primary is not None:
        raise primary
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
