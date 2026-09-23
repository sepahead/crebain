"""Installed optional live-family custody, without ordinary predictor capabilities."""

from contextlib import contextmanager
import json
import time

from . import codec as c, family_contract as fc
from ._process import _Process
from .family import FamilySession
from .runtime import InstalledFamilyRuntime


@contextmanager
def family_session(runtime, plan, *, exchanges=None):
    """Own all frozen endpoints and require actual shared-host exit after terminal ACKs.

    Installed byte verification precedes launch. One absolute family deadline covers
    preparation, caller work, every branch, and the canonical terminal exchange.
    The guardian's separate 205-second cleanup ceiling needs family qualification.
    """
    plan = fc.freeze_plan(plan)
    c.require(type(runtime) is InstalledFamilyRuntime)
    c.require(exchanges is None or (type(exchanges) in (tuple, list)
              and len(exchanges) == plan.limits.endpoint_count
              and all(exchange is None or callable(exchange) for exchange in exchanges)))
    checked = InstalledFamilyRuntime.open(runtime.prefix)
    c.require(checked == runtime, "binding")
    c.require(runtime.node is not None)
    deadline = time.monotonic() + plan.limits.total_wall_seconds
    command = [str(runtime.producer), "--bun", str(runtime.bun), "--node", str(runtime.node),
               "--bridge", str(runtime.bridge), "--source-identity", runtime.source_identity,
               "--family-plan-json", json.dumps(c.raw(plan), separators=(",", ":"), allow_nan=False)]
    process = _Process(command, runtime.environment, runtime.project, deadline=deadline,
                       _family_endpoints=plan.limits.endpoint_count)
    session = None
    errors = []
    try:
        session = FamilySession(plan, process.streams, deadline=deadline,
                                close_endpoint=process.close_endpoint,
                                source_identity=runtime.source_identity, exchanges=exchanges)
        session.prepare()
        yield session
        if time.monotonic() >= deadline:
            raise TimeoutError("live family exceeded its absolute deadline")
        session.finish()
        if time.monotonic() >= deadline:
            raise TimeoutError("live family exceeded its absolute deadline")
    except BaseException as error:
        errors.append(error)
    finally:
        if session is not None:
            try:
                session.close()
            except BaseException as error:
                errors.append(error)
        try:
            process.close(healthy=not errors)
        except BaseException as cleanup:
            errors.append(cleanup)
        finally:
            if session is not None:
                session.process_exit = process.exit
                session.diagnostics = process.diagnostics
                session.diagnostics_truncated = process.diagnostics_truncated
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise BaseExceptionGroup("live family and cleanup failed", errors)
