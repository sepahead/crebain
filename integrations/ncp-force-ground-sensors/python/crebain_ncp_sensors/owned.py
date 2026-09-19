"""Ordinary sensor use with an explicitly installed, locally owned runtime."""

from contextlib import contextmanager
from dataclasses import asdict
import json
import time
import uuid

from ncp_local import modular_owner as o, modular_wire as w
from ncp_local.modular_client import Client

from . import codec as c, types as t
from ._process import _Process
from .client import SensorSession
from .contract import SensorContract
from .runtime import InstalledRuntime


class BodySession(SensorSession):
    """SensorSession with process-exit evidence populated after context exit."""

    process_exit: dict | None = None
    diagnostics: bytes = b""
    diagnostics_truncated: bool = False


def new_binding(*, run_id=None) -> t.BufferBinding:
    """Create fresh host-owned endpoint and generation identities."""
    binding = t.BufferBinding(
        o.profile_digest(), c.APPLICATION_DIGEST,
        str(uuid.uuid4()) if run_id is None else run_id,
        str(uuid.uuid4()), str(uuid.uuid4()),
    )
    binding.validate()
    return binding


@contextmanager
def body_session(runtime, prepare, *, timeout_s=180, binding=None, exchange=None):
    """Prepare, use, finish, and retire one installed CREBAIN sensor producer.

    Prelaunch byte verification precedes the timeout. Its single absolute budget
    covers preparation, every exchange, and caller work. Cleanup has a separate
    205-second maximum grace for the existing process chain. Trusted callbacks
    must return; the guardian can retire the producer but cannot interrupt Python.
    """
    SensorContract.check_input(w.Prepare(prepare))
    c.require(type(timeout_s) is int and 1 <= timeout_s <= 600)
    c.require(exchange is None or callable(exchange))
    binding = new_binding() if binding is None else binding
    c.require(type(binding) is t.BufferBinding)
    Client(binding, SensorContract)  # Pure binding/descriptor admission, before spawn.
    c.require(type(runtime) is InstalledRuntime)
    checked = InstalledRuntime.open(runtime.prefix)
    c.require(checked == runtime, "binding")
    cameras = prepare.specification.scene.rgbCameras or prepare.specification.scene.thermalCameras
    c.require(not cameras or runtime.node is not None)
    deadline = time.monotonic() + timeout_s
    command = [str(runtime.producer), "--bun", str(runtime.bun)]
    if cameras:
        command.extend(("--node", str(runtime.node)))
    command.extend(("--bridge", str(runtime.bridge), "--source-identity", runtime.source_identity,
                    "--binding-json", json.dumps(asdict(binding), separators=(",", ":"))))
    process = _Process(command, runtime.environment, runtime.project, deadline=deadline)
    session = None
    primary = None
    try:
        session = BodySession(process.reader, process.writer, binding, prepare,
                              deadline=deadline, exchange=exchange)
        session.prepare()
        c.require(session.prepare_response.body.data.source_identity == runtime.source_identity, "binding")
        yield session
        if time.monotonic() >= deadline:
            raise TimeoutError("sensor session exceeded its absolute deadline")
        session.finish()  # Idempotent if the caller already finished explicitly.
        if time.monotonic() >= deadline:
            raise TimeoutError("sensor session exceeded its absolute deadline")
    except BaseException as error:
        primary = error
    finally:
        if session is not None:
            session.close()
        try:
            process.close(healthy=primary is None)
        except BaseException as cleanup:
            if primary is not None:
                raise BaseExceptionGroup("sensor session and cleanup failed", [primary, cleanup])
            raise
        finally:
            if session is not None:
                session.process_exit = process.exit
                session.diagnostics = process.diagnostics
                session.diagnostics_truncated = process.diagnostics_truncated
    if primary is not None:
        if process.diagnostics:
            primary.add_note("Producer diagnostics (bounded):\n" + process.diagnostics[-2048:].decode("utf-8", errors="replace"))
        raise primary
