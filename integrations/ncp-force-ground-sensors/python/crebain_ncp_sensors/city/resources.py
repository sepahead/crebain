"""Trusted composition admission for named logical extents, not process memory."""

from dataclasses import dataclass, fields
import hashlib

from ncp_local import modular_owner as owner, modular_wire as w
from ncp_local.modular_buffer import CHUNK_BYTES, MAX_ID
from ncp_local.modular_client import Client

from . import codec as c, types as t
from .contract import CityContract

# UTF-8 admission extents owned by src/environment/CitySourceContract.ts.
NATIVE_PLAN_BYTES = 512 * 1024
GRAPHICS_INPUT_BYTES = 128 * 1024


@dataclass(frozen=True, slots=True)
class ResourceBudget:
    """Caller-selected byte limits; these numbers allocate no physical resources."""

    logical_bytes: int
    graphics_color_bytes: int
    storage_bytes: int

    def validate(self):
        for field in fields(self):
            c.require(w.integer(getattr(self, field.name), 0, MAX_ID), "capacity")


@dataclass(frozen=True, slots=True)
class CompositionResources:
    """Independently derived, conservative byte allowances for one finite run.

    Metadata fields price encoded representations, not Python object overhead.
    Opaque runtime, driver, allocator and arbitrary caller copies are excluded.
    """

    source_bytes: int
    application_bytes: int
    public_buffer_bytes: int
    core_owner_bytes: int
    graphics_host_bytes: int
    graphics_color_bytes: int
    canonical_encoding_bytes: int
    host_original_bytes: int
    host_metadata_bytes: int
    host_transfer_bytes: int
    capture_logical_bytes: int
    capture_storage_bytes: int
    normal_exchanges: int
    maximum_exchanges: int
    payload_count: int
    chunk_count: int
    maximum_source_bytes: int
    maximum_batch_bytes: int
    canonical_experiment_storage_bytes: int = 0
    opaque_runtime_memory_bound: bool = False
    physical_reservation: bool = False

    @property
    def logical_bytes(self):
        return sum(
            (
                self.source_bytes,
                self.application_bytes,
                self.public_buffer_bytes,
                self.core_owner_bytes,
                self.graphics_host_bytes,
                self.graphics_color_bytes,
                self.canonical_encoding_bytes,
                self.host_original_bytes,
                self.host_metadata_bytes,
                self.host_transfer_bytes,
                self.capture_logical_bytes,
            )
        )

    @property
    def storage_bytes(self):
        return self.capture_storage_bytes + self.canonical_experiment_storage_bytes


@dataclass(frozen=True, slots=True)
class ResourceAdmission:
    """Recheckable local calculation; copied values are not capacity authority."""

    budget: ResourceBudget
    resources: CompositionResources
    binding: t.BufferBinding
    prepare_digest: str
    capture: bool


def composition_resources(
    prepare, binding, *, capture=False, canonical_experiment=False
):
    """Validate the complete plan and public frame before any selected effect."""
    c.require(type(capture) is bool and type(canonical_experiment) is bool)
    c.require(not canonical_experiment, "unsupported_canonical_experiment")
    CityContract.check_input(w.Prepare(prepare))
    c.require(type(binding) is t.BufferBinding)
    # Use the real request codec, including its envelope; counts alone do not
    # admit a complete Prepare frame. This client never dispatches the request.
    Client(binding, CityContract).begin(w.Prepare(prepare))
    base = c.resources(prepare)
    public, overhead = owner.composition_budget(
        (base["maximum_public_live_payload_bytes"],)
    )
    payload_bytes = payloads = chunks = largest = largest_batch = 0
    operations = 2  # Prepare and Finish; every operation also has an ACK.
    for tick in range(1, prepare.world.horizon_ticks + 1):
        operations += 2  # Advance and ReleaseBatch, including zero-source ticks.
        batch_bytes = 0
        for source in prepare.sources:
            if tick % source.publication_period_ticks:
                continue
            length = (
                (tick * 16000 // 120 - (tick - 1) * 16000 // 120) * 8
                if type(source) is t.PressureRequest
                else 4 * source.width * source.height
            )
            count = (length + CHUNK_BYTES - 1) // CHUNK_BYTES
            batch_bytes += length
            payload_bytes += length
            payloads += 1
            chunks += count
            largest = max(largest, length)
            operations += 2 + count  # ExportSource, reads, and BufferRelease.
        largest_batch = max(largest_batch, batch_bytes)
    normal = 2 * operations
    maximum = normal + 2  # One Abort and its ACK after a known source failure.
    capture_storage = 0
    if capture:
        # This owner supplies the file format, overhead and exact peer header.
        # Importing a city-only composition does not require Prisoma.
        from prisoma_ncp_transcript import Peer, capacity_bytes

        capture_storage = capacity_bytes(
            (Peer(binding, CityContract),), max_exchanges=maximum
        )
    cameras = any(type(s) is not t.PressureRequest for s in prepare.sources)
    return CompositionResources(
        source_bytes=base["native_original_bytes"]
        + base["native_receipt_bytes"]
        + 2 * base["native_control_bytes"]
        + base["acoustic_history_bytes"]
        + base["acoustic_block_bytes"],
        application_bytes=base["application_original_bytes"]
        + base["application_result_bytes"],
        public_buffer_bytes=public,
        core_owner_bytes=overhead,
        graphics_host_bytes=base["rgb_readback_bytes"]
        + base["thermal_readback_bytes"]
        + base["source_graphics_retention_bytes"],
        graphics_color_bytes=base["render_target_color_bytes"],
        # The NCP owner overhead already prices its canonical staging. Add the
        # independent host client, native plan, native receipt/control encoding,
        # and the selected graphics input. These are UTF-8 logical extents.
        canonical_encoding_bytes=w.PROJECTION_BYTES
        + NATIVE_PLAN_BYTES
        + base["native_receipt_bytes"]
        + base["native_control_bytes"]
        + (GRAPHICS_INPUT_BYTES if cameras else 0),
        host_original_bytes=payload_bytes,
        # Each exposed batch retains its request and response. Each Reading
        # retains two manifests contained together in one admitted export frame.
        host_metadata_bytes=(prepare.world.horizon_ticks + 2) * 2 * w.FRAME_BYTES
        + payloads * w.FRAME_BYTES,
        host_transfer_bytes=largest + 2 * CHUNK_BYTES + 2 * w.FRAME_BYTES,
        # Price independent capture request/response and record staging plus
        # its replay client's canonical projection. This excludes object heaps.
        capture_logical_bytes=(4 * w.FRAME_BYTES + w.PROJECTION_BYTES)
        if capture
        else 0,
        capture_storage_bytes=capture_storage,
        normal_exchanges=normal,
        maximum_exchanges=maximum,
        payload_count=payloads,
        chunk_count=chunks,
        maximum_source_bytes=largest,
        maximum_batch_bytes=largest_batch,
    )


def admit_composition(
    prepare, binding, budget, *, capture=False, canonical_experiment=False
):
    """Reject each insufficient trusted limit before recorder or process creation."""
    c.require(type(budget) is ResourceBudget, "capacity")
    budget.validate()
    required = composition_resources(
        prepare,
        binding,
        capture=capture,
        canonical_experiment=canonical_experiment,
    )
    c.require(
        required.logical_bytes <= budget.logical_bytes
        and required.graphics_color_bytes <= budget.graphics_color_bytes
        and required.storage_bytes <= budget.storage_bytes,
        "capacity",
    )
    return ResourceAdmission(
        budget,
        required,
        binding,
        hashlib.sha256(
            Client(binding, CityContract).begin(w.Prepare(prepare))
        ).hexdigest(),
        capture,
    )


def recheck_admission(prepare, binding, admission):
    """Recompute every quantity; a caller-replaced digest or total cannot authorize."""
    c.require(type(admission) is ResourceAdmission, "binding")
    c.require(type(admission.resources) is CompositionResources, "binding")
    for field in fields(admission.resources):
        value = getattr(admission.resources, field.name)
        if field.name in ("opaque_runtime_memory_bound", "physical_reservation"):
            c.require(value is False, "binding")
        else:
            c.require(w.integer(value, 0, MAX_ID), "binding")
    c.require(type(admission.binding) is t.BufferBinding, "binding")
    admission.binding.validate()
    c.require(w.digest_valid(admission.prepare_digest), "binding")
    expected = admit_composition(
        prepare, binding, admission.budget, capture=admission.capture
    )
    c.require(admission == expected, "binding")
