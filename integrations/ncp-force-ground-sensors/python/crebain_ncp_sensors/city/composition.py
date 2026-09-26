"""Budgeted installed city launch, with the existing optional transcript owner."""

from contextlib import contextmanager
from dataclasses import asdict
import os
from pathlib import Path

from . import codec as c
from .contract import CityContract
from .owned import _launch_preflight, city_session, failure_retirement, new_binding
from .resources import admit_composition


def _storage_preflight(path, required):
    selected = Path(path)
    c.require(selected.is_absolute(), "capture_path")
    # This is an observed available-byte precondition. Another actor, filesystem
    # overhead, or later I/O failure can invalidate it; no disk blocks are owned.
    space = os.statvfs(selected.parent)
    c.require(space.f_bavail * space.f_frsize >= required, "storage_capacity")
    return selected


@contextmanager
def budgeted_city_session(
    runtime,
    prepare,
    *,
    budget,
    capture_path=None,
    binding=None,
    timeout_s=600,
    canonical_experiment=False,
):
    """Admit the complete selected sum before recorder and producer construction.

    This entrypoint supports body-only or body plus the existing Prisoma Journal.
    It supplies no callback, arbitrary caller-memory or physical-reservation bound.
    A failed composition closes its journal without inventing a terminal record.
    """
    binding = new_binding() if binding is None else binding
    admission = admit_composition(
        prepare,
        binding,
        budget,
        capture=capture_path is not None,
        canonical_experiment=canonical_experiment,
    )
    _launch_preflight(runtime, prepare, timeout_s=timeout_s, binding=binding)
    if capture_path is not None:
        capture_path = _storage_preflight(
            capture_path, admission.resources.capture_storage_bytes
        )
    journal = session = None
    failures = []
    receipt = None
    try:
        exchange = None
        if capture_path is not None:
            from prisoma_ncp_transcript import Journal, Peer

            journal = Journal(
                capture_path,
                (Peer(binding, CityContract),),
                max_exchanges=admission.resources.maximum_exchanges,
                quota_bytes=admission.resources.capture_storage_bytes,
            )

            def exchange(request, reader, writer, *, deadline):
                return journal.exchange(
                    binding.endpoint_id, request, reader, writer, deadline=deadline
                )

        with city_session(
            runtime,
            prepare,
            timeout_s=timeout_s,
            binding=binding,
            exchange=exchange,
            _resource_admission=admission,
        ) as session:
            yield session
        if journal is not None:
            session.capture_terminal = asdict(journal.finish())
    except BaseException as primary:
        failures.append(primary)
        receipt = failure_retirement(primary)
    finally:
        if journal is not None:
            try:
                journal.close()
            except BaseException as error:
                failures.append(error)
        if receipt is None and session is not None:
            receipt = session.retirement
    if failures:
        outgoing = (
            failures[0]
            if len(failures) == 1
            else BaseExceptionGroup(
                "city composition and capture cleanup failed", failures
            )
        )
        if receipt is not None:
            try:
                BaseException.__setattr__(outgoing, "city_retirement", receipt)
            except BaseException:
                pass
        raise outgoing
