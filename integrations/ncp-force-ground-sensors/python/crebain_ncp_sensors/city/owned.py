"""Explicit installed city process custody, including pre-yield retirement observations."""

from contextlib import contextmanager
from dataclasses import dataclass
import json
import time
import uuid

from ncp_local import modular_owner as o, modular_wire as w
from ncp_local.modular_client import Client

from .._process import _Process
from . import codec as c, types as t
from .client import CitySession, CommittedObservation
from .contract import CityContract
from .runtime import InstalledCityRuntime
from .resources import ResourceAdmission, recheck_admission


@dataclass(frozen=True, slots=True)
class RetirementReceipt:
    """Local observed facts, independent of successful Finish or acknowledged progress."""

    schema: str
    yielded: bool
    process_exit: dict | None
    diagnostics: bytes
    diagnostics_truncated: bool
    last_committed: CommittedObservation | None
    observed_prepared: bool
    observed_completed_tick: int
    observed_terminal: t.Terminal | None
    observed_native_retirement: bool
    acknowledged_prepared: bool
    acknowledged_completed_tick: int
    acknowledged_terminal: bool
    acknowledged_result_digest: str | None


class OwnedCitySession(CitySession):
    retirement: RetirementReceipt | None = None
    resource_admission: ResourceAdmission | None = None
    capture_terminal: dict | None = None


def new_binding(*, run_id=None):
    binding = t.BufferBinding(
        o.profile_digest(),
        c.APPLICATION_DIGEST,
        str(uuid.uuid4()) if run_id is None else run_id,
        str(uuid.uuid4()),
        str(uuid.uuid4()),
    )
    binding.validate()
    return binding


def failure_retirement(error):
    """Read the receipt attached to the outgoing original or cleanup group."""
    try:
        value = BaseException.__getattribute__(error, "city_retirement")
    except BaseException:
        return None
    return value if type(value) is RetirementReceipt else None


def _launch_preflight(runtime, prepare, *, timeout_s, binding):
    """Reopen selected installation and validate launch inputs without construction."""
    CityContract.check_input(w.Prepare(prepare))
    c.require(type(timeout_s) is int and 1 <= timeout_s <= 600)
    c.require(type(binding) is t.BufferBinding)
    Client(binding, CityContract)
    c.require(type(runtime) is InstalledCityRuntime)
    c.require(InstalledCityRuntime.open(runtime.prefix) == runtime, "binding")
    cameras = any(type(s) in (t.RGBRequest, t.ThermalRequest) for s in prepare.sources)
    c.require(not cameras or runtime.node is not None)
    return cameras


@contextmanager
def city_session(
    runtime,
    prepare,
    *,
    timeout_s=600,
    binding=None,
    exchange=None,
    _resource_admission=None,
):
    """Verify installed bytes, use one absolute command deadline, then retire owned processes.

    The existing process guardian has a separate 205-second cleanup grace.
    A constructor failure without a returned process has unavailable exit evidence.
    """
    c.require(exchange is None or callable(exchange))
    binding = new_binding() if binding is None else binding
    cameras = _launch_preflight(runtime, prepare, timeout_s=timeout_s, binding=binding)
    deadline = time.monotonic() + timeout_s
    command = [str(runtime.producer), "--bun", str(runtime.bun)]
    if cameras:
        command.extend(("--node", str(runtime.node)))
    command.extend(
        (
            "--bridge",
            str(runtime.bridge),
            "--source-identity",
            runtime.source_identity,
            "--binding-json",
            json.dumps(c.raw(binding), separators=(",", ":")),
        )
    )
    process = session = None
    yielded = False
    failures = []
    try:
        if _resource_admission is not None:
            recheck_admission(prepare, binding, _resource_admission)
            c.require(_resource_admission.capture == (exchange is not None), "binding")
        process = _Process(
            command, runtime.environment, runtime.project, deadline=deadline
        )
        session = OwnedCitySession(
            process.reader,
            process.writer,
            binding,
            prepare,
            deadline=deadline,
            exchange=exchange,
            source_identity=runtime.source_identity,
        )
        session.prepare()
        session.resource_admission = _resource_admission
        yielded = True
        yield session
        if time.monotonic() >= deadline:
            raise TimeoutError("city session deadline")
        session.finish()
        if time.monotonic() >= deadline:
            raise TimeoutError("city session deadline")
    except BaseException as primary:
        failures.append(primary)
    finally:
        if session is not None:
            try:
                session.close()
            except BaseException as error:
                failures.append(error)
        if process is not None:
            try:
                process.close(healthy=not failures)
            except BaseException as error:
                failures.append(error)
        receipt = RetirementReceipt(
            "crebain.city-session-retirement.v1",
            yielded,
            None if process is None else process.exit,
            b"" if process is None else process.diagnostics,
            False if process is None else process.diagnostics_truncated,
            None if session is None else session.last_committed,
            False if session is None else session.observed_prepared,
            0 if session is None else session.observed_completed_tick,
            None if session is None else session.observed_terminal,
            False if session is None else session.observed_native_retirement,
            False if session is None else session.acknowledged_prepared,
            0 if session is None else session.acknowledged_completed_tick,
            False if session is None else session.acknowledged_terminal,
            None if session is None else session.acknowledged_result_digest,
        )
        if session is not None:
            session.retirement = receipt
    if failures:
        outgoing = (
            failures[0]
            if len(failures) == 1
            else BaseExceptionGroup("city operation and cleanup failed", failures)
        )
        try:
            BaseException.__setattr__(outgoing, "city_retirement", receipt)
        except BaseException:
            # Preserve hostile original exceptions; a diagnostic setter cannot mask them.
            pass
        raise outgoing
