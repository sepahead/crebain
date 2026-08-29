#!/usr/bin/env python3
"""Run Engram's installed CREBAIN loop and capture its exact neural results."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import os
import re
import stat
import sys
import tempfile
from argparse import Namespace
from collections.abc import Mapping, Sequence
from decimal import ROUND_CEILING, Decimal
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from managed_simulation_authoring_files import (
    ManagedSimulationSubprocessError,
    run_bounded_process,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    TARGET,
    validate_build_receipt,
    validate_pack_receipt,
    validate_stage_receipt,
)


MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_SOURCE_FILES = 1_024
MAX_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024
MAX_RECEIPT_STORE_FILES = 128
MAX_RECEIPT_STORE_BYTES = 64 * 1024 * 1024
DEFAULT_RECEIPT_LOCK_TIMEOUT_MS = 30_000
MAX_RECEIPT_LOCK_TIMEOUT_MS = 300_000
RECEIPT_STORE_LOCK_PAYLOAD = b"engram-extension-closed-loop-receipt-store-lock-v1\n"
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
GIT_COMMIT_PATTERN = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")
REQUIRED_HOST_MODULES = frozenset(
    {
        "backend.core",
        "backend.core.errors",
        "backend.core.units",
        "backend.integrations",
        "backend.integrations.contained_exec_gate",
        "backend.integrations.extension_package_store",
        "backend.integrations.extension_package_v2_contract",
        "backend.integrations.managed_runtime_authoring",
        "backend.integrations.managed_runtime_contract",
        "backend.integrations.managed_runtime_json",
        "backend.integrations.managed_runtime_manager_contract",
        "backend.integrations.reviewed_native_development_session",
        "backend.integrations.reviewed_native_process_guardian",
        "backend.integrations.standard_closed_loop_simulator",
        "backend.neurocontrol",
        "backend.neurocontrol.backends",
        "backend.neurocontrol.bus",
        "backend.neurocontrol.codec",
        "backend.neurocontrol.loop",
        "backend.neurocontrol.profiles",
        "backend.neurocontrol.protocol",
        "backend.neurocontrol.service",
        "backend.neurocontrol.session",
        "backend.neurocontrol.transport",
        "backend.optimization",
        "backend.optimization.extension_closed_loop",
        "backend.optimization.extension_closed_loop_limits",
        "backend.optimization.extension_closed_loop_nest",
        "backend.optimization.extension_closed_loop_nest_evidence",
        "backend.optimization.extension_closed_loop_nest_process",
        "backend.optimization.extension_closed_loop_receipt_store",
        "backend.optimization.simulator_study_ledger",
        "backend.schemas",
        "backend.schemas.evidence",
        "backend.schemas.runtime",
        "backend.schemas.simulator_study",
        "scripts",
        "scripts.engram_extension",
    }
)
REQUIRED_WORKER_MODULES = frozenset(
    {
        "backend.core",
        "backend.core.errors",
        "backend.core.units",
        "backend.integrations",
        "backend.integrations.contained_exec_gate",
        "backend.integrations.managed_runtime_contract",
        "backend.integrations.managed_runtime_json",
        "backend.integrations.managed_runtime_manager_contract",
        "backend.neurocontrol",
        "backend.neurocontrol.backends",
        "backend.neurocontrol.bus",
        "backend.neurocontrol.codec",
        "backend.neurocontrol.loop",
        "backend.neurocontrol.profiles",
        "backend.neurocontrol.protocol",
        "backend.neurocontrol.service",
        "backend.neurocontrol.session",
        "backend.neurocontrol.transport",
        "backend.optimization",
        "backend.optimization.extension_closed_loop",
        "backend.optimization.extension_closed_loop_limits",
        "backend.optimization.extension_closed_loop_nest",
        "backend.optimization.extension_closed_loop_nest_process",
        "backend.optimization.simulator_study_ledger",
        "backend.schemas",
        "backend.schemas.evidence",
        "backend.schemas.runtime",
        "backend.schemas.simulator_study",
    }
)
EXERCISED_ENTRYPOINTS = (
    (
        "reviewed-runtime-guardian",
        "backend/integrations/reviewed_native_process_guardian.py",
    ),
    (
        "nest-worker",
        "backend/optimization/extension_closed_loop_nest_worker.py",
    ),
    (
        "nest-guardian",
        "backend/optimization/extension_closed_loop_nest_guardian.py",
    ),
)
SIMULATOR_ONLY_AUTHORITY = {
    "simulator_only": True,
    "ncp_qualified": False,
    "physical_actuation": False,
    "plant_control": False,
    "scientific_authority": False,
}
NON_AUTHORITY_FALSE_FIELDS = frozenset(
    {
        "agent_action_authority",
        "calibrated_posterior",
        "durable_process_launch_authority",
        "execution_authority",
        "is_paper_local_evidence",
        "music_transport_used",
        "ncp_authority",
        "ncp_control",
        "ncp_qualified",
        "ncp_transport",
        "ncp_transport_used",
        "physical_actuation",
        "physical_authority",
        "plant_control",
        "replayable_live_launch_authority",
        "scientific_authority",
    }
)
RECEIPT_STORE_SIDECAR_KEYS = {
    "schema_version",
    "store_metadata",
    "finalized_reservation",
    "observation",
    "publication_admission_anchor",
    "publication_authority",
    "closure_sha256",
}
SUMMARY_KEYS = {
    "authority",
    "calibrated_posterior",
    "channel_count",
    "completed_step_count",
    "evidence_bundle_sha256",
    "ncp_qualified",
    "physical_actuation",
    "planned_step_count",
    "receipt_sha256",
    "reservation_id",
    "run_status",
    "scientific_authority",
    "simulator_only",
    "status",
    "store_id",
    "study_run_id",
    "terminal_reason_code",
}
NEST_EVIDENCE_KEYS = {
    "schema_version",
    "digest_canonicalization",
    "profile",
    "run_receipt_sha256",
    "study_run_id",
    "neural_provider_identity_sha256",
    "neural_preparation_sha256",
    "runtime_launch_expectation",
    "worker_launch_attempt",
    "preparation_attempt",
    "child_capabilities",
    "worker_runtime_identity",
    "child_preparation_receipt",
    "provider_preparation_receipt",
    "worker_session_binding",
    "nest_session_readback",
    "step_execution_receipts",
    "step_attempt_receipts",
    "tail_disposition_receipt",
    "worker_termination_attempt_receipts",
    "worker_lifecycle_receipt",
    "worker_terminal_disposition",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
    "bundle_sha256",
}
TERMINAL_RECEIPT_KEYS = {
    "calibrated_posterior",
    "cleanup",
    "cleanup_complete",
    "closed_loop_definition_sha256",
    "digest_canonicalization",
    "initial_snapshot_sha256",
    "is_paper_local_evidence",
    "last_verified_simulation_time_tics",
    "ncp_qualified",
    "neural_deadline_enforcement",
    "neural_durable_evidence_profile",
    "neural_executions",
    "neural_preparation_sha256",
    "neural_provider_identity_sha256",
    "neural_session_receipt_sha256",
    "physical_actuation",
    "planned_step_count",
    "primary_reason_code",
    "receipt_sha256",
    "runtime_adapter_configuration_sha256",
    "runtime_binding_sha256",
    "runtime_deadline_enforcement",
    "runtime_finish_sha256",
    "runtime_lifecycle",
    "runtime_progress_disposition",
    "schema_version",
    "scientific_authority",
    "simulator_only",
    "status",
    "steps",
    "study_definition_sha256",
    "study_run_id",
    "terminal_reason_code",
    "timebase",
    "transcript_sha256",
}
REVIEWED_COMMAND_BINDING_KEYS = {
    "argument_shape",
    "exec_gate_command_sha256",
    "exec_gate_source_sha256",
    "python_executable_sha256",
    "schema_version",
    "target_command_sha256",
}
REVIEWED_HANDSHAKE_KEYS = {
    "automatic_restart",
    "child_ready_claim",
    "descendant_creation_denied",
    "durable_process_launch_authority",
    "exec_gate_command_sha256",
    "exec_gate_source_sha256",
    "executable_sha256",
    "explicit_absolute_path_spawn",
    "extension_id",
    "extension_version",
    "external_dependency_closure_attested",
    "filesystem_isolation_enforced",
    "generation_directory_identity_sha256",
    "generation_id",
    "generation_ordinal",
    "guardian_command_sha256",
    "guardian_generation_lease_retained",
    "guardian_group_member",
    "guardian_owner_loss_seal",
    "guardian_pid",
    "guardian_ready_frame_sha256",
    "guardian_source_sha256",
    "guardian_uncertainty_record_prepared",
    "handshake_transcript_accepted",
    "host_handshake_frame_sha256",
    "host_local_admission",
    "installation_id",
    "launch_source",
    "ncp_authority",
    "network_isolation_enforced",
    "os_sandbox_enforced",
    "package_generation_id",
    "package_generation_lease_retained",
    "package_path_reopened_for_spawn",
    "path_lookup_at_spawn",
    "physical_authority",
    "process_group_containment",
    "process_group_id",
    "process_launch_performed",
    "process_pid",
    "profile",
    "publisher_authenticated",
    "receipt_sha256",
    "replayable_live_launch_authority",
    "runtime_handshake_frame_sha256",
    "runtime_process_group_leader",
    "sandbox_launcher_sha256",
    "sandbox_profile_sha256",
    "schema_version",
    "scientific_authority",
    "session_id",
    "staged_executable_owner_private",
    "staged_executable_user_immutable",
    "store_id",
    "target_id",
    "validator_set_sha256",
    "verified_executable_staged",
}
REVIEWED_TERMINATION_KEYS = {
    "child_reaped",
    "containment_empty",
    "containment_seal_signal",
    "containment_signal_scope",
    "diagnostic_stream_complete",
    "direct_child_signal_while_unreaped",
    "disposition",
    "durable_process_launch_authority",
    "exit_code",
    "generation_id",
    "group_signal_while_guardian_unreaped",
    "guardian_generation_lease_held_until_containment",
    "guardian_pid",
    "guardian_reaped",
    "handshake_receipt_sha256",
    "ncp_authority",
    "package_generation_lease_released",
    "physical_authority",
    "private_work_directory_removed",
    "process_group_id",
    "reason_code",
    "receipt_sha256",
    "schema_version",
    "scientific_authority",
    "stderr_retained_bytes",
    "stderr_sha256",
    "stderr_truncated",
    "termination_signal",
}
RUNTIME_LIFECYCLE_KEYS = {
    "binding_sha256",
    "child_reaped",
    "containment_empty",
    "diagnostic_stream_complete",
    "durable_process_launch_authority",
    "generation_directory_identity_sha256",
    "generation_id",
    "handshake_receipt_sha256",
    "launch_source",
    "ncp_authority",
    "package_generation_id",
    "package_generation_lease_released",
    "package_generation_lease_retained_at_launch",
    "physical_authority",
    "private_work_directory_removed",
    "profile",
    "publisher_authenticated",
    "schema_version",
    "scientific_authority",
    "store_id",
    "termination_disposition",
    "termination_receipt_sha256",
}
TIMEBASE_KEYS = {
    "action_application",
    "causality_policy",
    "clock_relation",
    "coupling",
    "dispatch_order",
    "neural_step_duration_tics",
    "observation_sample_phase",
    "runtime_step_duration_tics",
    "schema_version",
    "tic_unit",
}
TERMINAL_STEP_KEYS = {
    "admitted_action_sha256",
    "fault_codes",
    "input_snapshot_sha256",
    "neural_request_sha256",
    "neural_result_sha256",
    "output_snapshot_sha256",
    "provider_execution_scope",
    "provider_execution_sha256",
    "receipt_sha256",
    "runtime_request_sha256",
    "schema_version",
    "step_id",
    "step_index",
    "study_run_id",
}
NEURAL_EXECUTION_BINDING_KEYS = {
    "binding_sha256",
    "neural_request_sha256",
    "neural_result_sha256",
    "provider_execution_scope",
    "provider_execution_sha256",
    "schema_version",
    "step_id",
    "step_index",
}
NEURAL_STEP_KEYS = {"request", "result"}
NEURAL_STEP_REQUEST_KEYS = {
    "channels",
    "controller_end_time_tics",
    "controller_interval_tics",
    "controller_start_time_tics",
    "neural_preparation_sha256",
    "observation_runtime_time_tics",
    "request_sha256",
    "runtime_interval_end_time_tics",
    "runtime_interval_tics",
    "schema_version",
    "source_snapshot_sha256",
    "step_id",
    "step_index",
    "study_run_id",
}
NEURAL_INPUT_CHANNEL_KEYS = {
    "channel_id",
    "fault_code",
    "hold_required",
    "observation_values",
    "subject_id",
}
NEURAL_STEP_RESULT_KEYS = {
    "controller_end_time_tics",
    "controller_start_time_tics",
    "proposals",
    "provider_execution_scope",
    "provider_execution_sha256",
    "request_sha256",
    "result_sha256",
    "schema_version",
    "step_id",
    "step_index",
    "study_run_id",
}
NEURAL_ACTION_PROPOSAL_KEYS = {
    "channel_id",
    "source_populations",
    "values",
}
CLEANUP_RECEIPT_KEYS = {
    "attempted",
    "component",
    "confirmed",
    "containment_empty",
    "mode",
    "owner_identity_sha256",
    "provider_lifecycle_receipt_sha256",
    "provider_terminal_receipt_sha256",
    "reason_code",
    "receipt_sha256",
    "runtime_lifecycle",
    "schema_version",
}
NEST_WORK_ADMISSION_KEYS = {
    "action_dimension_count",
    "admitted",
    "byte_estimate_policy",
    "channel_count",
    "closed_loop_definition_sha256",
    "controller_configuration_sha256",
    "device_node_count",
    "estimated_evidence_bundle_bytes",
    "estimated_evidence_bundle_nodes",
    "estimated_step_response_bytes",
    "estimated_step_response_nodes",
    "expected_control_binding_sha256",
    "expected_population_roster_sha256",
    "input_event_work_units",
    "max_evidence_bundle_bytes",
    "max_evidence_bundle_nodes",
    "max_input_event_work_units",
    "max_neuron_tic_work_units",
    "max_step_response_bytes",
    "max_step_response_nodes",
    "max_total_connections",
    "max_total_nodes",
    "maximum_input_rate_hz",
    "neuron_tic_work_units",
    "node_estimate_policy",
    "planned_step_count",
    "population_neuron_count",
    "population_size",
    "receipt_sha256",
    "schema_version",
    "signed_population_count",
    "step_duration_tics",
    "total_connection_count",
    "total_node_count",
    "total_run_tics",
}
NEST_SESSION_KEYS = {
    "channel_recovery_policy",
    "connection_delay_api_argument_ms",
    "connection_readback_sha256",
    "connection_readbacks",
    "control_binding_sha256",
    "control_bindings",
    "control_neuron_model",
    "control_neuron_refractory_input",
    "control_neuron_refractory_period_tics",
    "effective_local_num_threads",
    "effective_model_roster",
    "effective_resolution_ms",
    "effective_resolution_tics",
    "effective_rng_seed",
    "effective_total_num_virtual_processes",
    "kernel_reset_at_admission",
    "loaded_bytes_attested",
    "model_readback_sha256",
    "ncp_transport",
    "observed_device_node_count",
    "observed_population_neuron_count",
    "observed_total_connection_count",
    "one_session",
    "population_roster",
    "population_roster_sha256",
    "receipt_sha256",
    "reported_version",
    "requested_connection_delay_tics",
    "requested_input_weight",
    "requested_local_num_threads",
    "requested_receptor",
    "requested_recorder_weight",
    "requested_resolution_ms",
    "requested_resolution_tics",
    "requested_rng_seed",
    "requested_step_duration_ms",
    "requested_step_duration_tics",
    "resolution_api_argument_ms",
    "run_api_argument_ms",
    "schema_version",
    "work_admission",
}
NEST_CONNECTION_KEYS = {
    "connection_count",
    "delay_api_argument_ms",
    "direction",
    "effective_delay_ms",
    "effective_delay_tics",
    "effective_receptor",
    "effective_weight",
    "population_name",
    "requested_delay_tics",
    "requested_receptor",
    "requested_weight",
    "synapse_model",
}
NEST_CONTROL_BINDING_KEYS = {
    "axis_binding_sha256s",
    "channel_id",
    "neural_codec_sha256",
}
NEURAL_POPULATION_BINDING_KEYS = {"channel_id", "population_names"}
NEST_POPULATION_TAIL_KEYS = {
    "pending_event_count",
    "pending_event_times_sha256",
    "population_name",
}
NEST_TERMINATION_ATTEMPT_KEYS = {
    "adapter_source_sha256",
    "anchored_group_kill_delivered",
    "attempt_index",
    "child_reaped",
    "containment_empty",
    "containment_seal_signal",
    "diagnostic_stream_complete",
    "disposition",
    "exit_code",
    "group_signal_attempted",
    "group_signal_basis",
    "group_signal_while_guardian_unreaped",
    "guardian_pid",
    "guardian_reaped",
    "guardian_source_sha256",
    "guardian_unexpected_exit_observed",
    "hard_deadline_enforcement",
    "ncp_transport",
    "physical_authority",
    "posix_process_group_portability_scope",
    "process_group_id",
    "reason_code",
    "receipt_sha256",
    "request_count",
    "response_count",
    "runtime_launch_expectation_sha256",
    "schema_version",
    "scientific_authority",
    "session_id",
    "stderr_retained_bytes",
    "stderr_sha256",
    "stderr_truncated",
    "termination_signal",
    "worker_command_sha256",
    "worker_launch_attempt_sha256",
    "worker_pid",
    "worker_source_sha256",
}
NEST_WORKER_LIFECYCLE_KEYS = {
    "adapter_source_sha256",
    "child_reaped",
    "containment_empty",
    "diagnostic_stream_complete",
    "disposition",
    "exit_code",
    "guardian_pid",
    "guardian_reaped",
    "guardian_source_sha256",
    "guardian_unexpected_exit_observed",
    "hard_deadline_enforcement",
    "ncp_transport",
    "physical_authority",
    "posix_process_group_portability_scope",
    "process_group_id",
    "reason_code",
    "receipt_sha256",
    "request_count",
    "resource_limit_receipt_sha256",
    "response_count",
    "runtime_identity_receipt_sha256",
    "runtime_launch_expectation_sha256",
    "schema_version",
    "scientific_authority",
    "session_binding_receipt_sha256",
    "session_id",
    "stderr_retained_bytes",
    "stderr_sha256",
    "stderr_truncated",
    "termination_attempt_roster_sha256",
    "termination_attempts",
    "termination_signal",
    "worker_command_sha256",
    "worker_launch_attempt_sha256",
    "worker_pid",
    "worker_source_sha256",
}
STORE_METADATA_KEYS = {
    "schema_version",
    "store_id",
    "policy",
    "digest_canonicalization",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
}
FINALIZED_RESERVATION_KEYS = {
    "schema_version",
    "store_id",
    "reservation",
    "pre_spawn_sha256",
    "extension_dispatch_sha256",
    "simulation_dispatch_sha256",
    "terminal_receipt_sha256",
    "evidence_bundle_sha256",
    "nest_work_admission_rejoined",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
    "finalization_sha256",
}
RESERVATION_KEYS = {
    "schema_version",
    "store_id",
    "reservation_id",
    "study_run_id",
    "closed_loop_definition_sha256",
    "receipt_profile",
    "evidence_profile",
    "nest_work_admission_sha256",
    "pre_spawn_sha256",
    "run_plan_sha256",
    "nest_configuration_sha256",
    "expected_runtime_binding_sha256",
    "reviewed_native_handshake_receipt_sha256",
    "reviewed_native_handshake",
    "package_generation_id",
    "runtime_generation_id",
    "reserved_record_count",
    "reserved_artifact_bytes",
    "reserved_evidence_bytes",
    "reserved_record_bytes",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
    "reservation_sha256",
}
OBSERVATION_KEYS = {
    "schema_version",
    "store_id",
    "artifact",
    "study_run_id",
    "run_status",
    "terminal_reason_code",
    "relative_artifact_path",
    "artifact_byte_length",
    "evidence_profile",
    "evidence_bundle_sha256",
    "relative_evidence_path",
    "evidence_byte_length",
    "admission_mode",
    "publication_authority_sha256",
    "reservation_id",
    "reservation_sha256",
    "reservation_finalization_sha256",
    "nest_work_admission_sha256",
    "nest_work_admission_rejoined",
    "digest_canonicalization",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
    "record_sha256",
}
PUBLICATION_ADMISSION_ANCHOR_KEYS = {
    "schema_version",
    "store_id",
    "study_run_key_sha256",
    "study_run_id",
    "terminal_receipt_sha256",
    "admission_mode",
    "publication_wal_sha256",
    "evidence_bundle_sha256",
    "reservation_id",
    "reservation_sha256",
    "pre_spawn_sha256",
    "extension_dispatch_sha256",
    "simulation_dispatch_sha256",
    "reservation_finalization_sha256",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
    "anchor_sha256",
}
PUBLICATION_AUTHORITY_KEYS = {
    "schema_version",
    "store_id",
    "terminal_receipt_sha256",
    "study_run_id",
    "admission_mode",
    "publication_admission_anchor_sha256",
    "publication_wal_sha256",
    "evidence_bundle_sha256",
    "reservation_id",
    "reservation_sha256",
    "reservation_finalization_sha256",
    "nest_work_admission_sha256",
    "execution_authority",
    "ncp_control",
    "physical_actuation",
    "scientific_authority",
    "is_paper_local_evidence",
    "calibrated_posterior",
    "authority_sha256",
}
INSTALLED_PROOF_KEYS = {
    "schema_version",
    "observed_build_receipt_exact_sha256",
    "observed_build_receipt_sha256",
    "observed_build_receipt",
    "package_stage_receipt_exact_sha256",
    "package_stage_receipt_sha256",
    "package_stage_receipt",
    "engram_pack_receipt_exact_sha256",
    "engram_pack_receipt_sha256",
    "engram_pack_receipt",
    "crebain_commit",
    "crebain_tree",
    "crebain_origin_main",
    "engram_commit",
    "engram_tree",
    "engram_origin_main",
    "engram_extension_tool_sha256",
    "engram_extension_tool_git_blob",
    "build_source_roster_sha256",
    "build_input_identity_sha256",
    "executable_format",
    "executable_architecture",
    "store_id",
    "package_generation_id",
    "installation_id",
    "generation_core_sha256",
    "bundle_receipt_exact_sha256",
    "seal_receipt_exact_sha256",
    "install_observation_exact_sha256",
    "manifest_exact_sha256",
    "package_lock_exact_sha256",
    "configuration_exact_sha256",
    "package_sha256",
    "executable_sha256",
    "configuration_canonical_sha256",
    "operation_roster_sha256",
    "operation_ids",
    "standard_schema_sha256",
    "drone_counts",
    "step_count",
    "fault_step",
    "fault",
    "host_policy",
    "recovery_controls_sha256",
    "baseline_three_controls_sha256",
    "replay_exact",
    "unaffected_lane_observations_exact",
    "negative_clock_gate",
    "signal_cancellation_gate",
    "installed_artifacts_reverified_after_execution",
    "generation_seal_package_bundle_store_lineage_verified",
    "build_stage_seal_install_lineage_verified",
    "build_stage_seal_pack_install_lineage_verified",
    "authority",
    "disclosure",
    "receipt_sha256",
}
STANDARD_V3_SCHEMA_HASHES = {
    "engram.closed-loop-simulator.finish-request.v3": "486d0b94e229000b03eec04b0c6e05e6b01c9be1df1090d1c58c27bf14b09880",
    "engram.closed-loop-simulator.finish-response.v3": "abf670d295150b6f20d088aa88365e98f73fa4d0042859f7aa5d7a2403a45d9e",
    "engram.closed-loop-simulator.prepare-request.v3": "a5376511d1ba2edeef1b144074423bafc9fd88562893e3f2a4bba9718fc67e34",
    "engram.closed-loop-simulator.prepare-response.v3": "06fd034822ae82e164d2c14be034e0286b4f02d1345be076affebdd84fa5348a",
    "engram.closed-loop-simulator.step-request.v3": "aafb7c6574e83ba386acb4c10b81e5f9f4c1669e6b79208d86701b06fa473bb2",
    "engram.closed-loop-simulator.step-response.v3": "bac8b67dcd19fbd7addbf825cb1f3b1bf796fe28f638a84380bf906b32fcdb39",
}


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def managed_runtime_float_text(value: float) -> str:
    """Return the pinned serde_json-compatible binary64 spelling."""

    if type(value) is not float:
        raise TypeError("managed-runtime float rendering requires a float")
    if (
        not math.isfinite(value)
        or abs(value) > 1.0e300
        or (value == 0.0 and math.copysign(1.0, value) < 0.0)
    ):
        fail("managed-runtime float exceeds the portable finite range")
    negative = value < 0.0
    source = repr(abs(value)).lower()
    if "e" in source:
        mantissa, exponent_text = source.split("e", 1)
        exponent = int(exponent_text)
        digits = mantissa.replace(".", "").lstrip("0").rstrip("0") or "0"
        decimal_point = exponent + 1
    else:
        integer, dot, fraction = source.partition(".")
        combined = integer + (fraction if dot else "")
        first = next(
            (index for index, character in enumerate(combined) if character != "0"),
            None,
        )
        if first is None:
            return "0.0"
        decimal_point = len(integer) - first
        digits = combined[first:].rstrip("0")
    trailing_zero_count = decimal_point - len(digits)
    if 0 <= trailing_zero_count and decimal_point <= 16:
        rendered = digits + ("0" * trailing_zero_count) + ".0"
    elif 0 < decimal_point <= 16:
        rendered = digits[:decimal_point] + "." + digits[decimal_point:]
    elif -5 < decimal_point <= 0:
        rendered = "0." + ("0" * (-decimal_point)) + digits
    else:
        exponent = decimal_point - 1
        exponent_text = f"+{exponent}" if exponent >= 0 else str(exponent)
        rendered = (
            f"{digits}e{exponent_text}"
            if len(digits) == 1
            else f"{digits[0]}.{digits[1:]}e{exponent_text}"
        )
    return f"-{rendered}" if negative else rendered


def managed_runtime_canonical(value: Any) -> bytes:
    """Encode bounded Host API 2 canonical JSON independently of Engram."""

    active: set[int] = set()
    nodes = 0

    def encode(current: Any, depth: int) -> bytes:
        nonlocal nodes
        nodes += 1
        if nodes > 1_000_000 or depth > 64:
            fail("managed-runtime JSON exceeds its structure bound")
        if current is None:
            return b"null"
        if current is True:
            return b"true"
        if current is False:
            return b"false"
        if type(current) is int:
            if abs(current) > 9_007_199_254_740_991:
                fail("managed-runtime JSON integer exceeds the exact range")
            return str(current).encode("ascii")
        if type(current) is float:
            return managed_runtime_float_text(current).encode("ascii")
        if type(current) is str:
            if any(
                0xD800 <= ord(character) <= 0xDFFF
                or ord(character) == 0xFFFD
                or 0xFDD0 <= ord(character) <= 0xFDEF
                or (ord(character) & 0xFFFF) in {0xFFFE, 0xFFFF}
                or (ord(character) < 0x20 and character not in {"\t", "\n", "\r"})
                or 0x7F <= ord(character) <= 0x9F
                for character in current
            ):
                fail("managed-runtime JSON contains nonportable Unicode")
            return json.dumps(
                current,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        is_mapping = isinstance(current, Mapping)
        is_sequence = isinstance(current, Sequence) and not isinstance(
            current, (str, bytes, bytearray)
        )
        if not is_mapping and not is_sequence:
            fail("managed-runtime JSON contains an unsupported value")
        identity = id(current)
        if identity in active:
            fail("managed-runtime JSON contains a cycle")
        active.add(identity)
        try:
            if is_mapping:
                if any(type(key) is not str for key in current):
                    fail("managed-runtime JSON object key is not a string")
                members = (
                    encode(key, depth + 1) + b":" + encode(current[key], depth + 1)
                    for key in sorted(current)
                )
                return b"{" + b",".join(members) + b"}"
            return (
                b"[" + b",".join(encode(child, depth + 1) for child in current) + b"]"
            )
        finally:
            active.remove(identity)

    return encode(value, 1)


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


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


def read_regular(path: Path, maximum: int, *, allow_empty: bool = False) -> bytes:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        fail(f"input cannot be opened without following links: {path}: {error}")
    try:
        observed = os.fstat(descriptor)
        if (
            not stat.S_ISREG(observed.st_mode)
            or observed.st_uid != os.geteuid()
            or observed.st_nlink != 1
            or (observed.st_size < 1 and not allow_empty)
            or observed.st_size > maximum
        ):
            fail(f"input is not one bounded owner-controlled file: {path}")
        chunks: list[bytes] = []
        remaining = observed.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"input changed while it was read: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail(f"input grew while it was read: {path}")
        after = os.fstat(descriptor)
        if not same_file_observation(observed, after):
            fail(f"input changed while it was read: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def decode_json_object(payload: bytes, label: str) -> dict[str, Any]:
    def closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"{label} contains a duplicate JSON member: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        fail(f"{label} contains a non-finite JSON number: {value}")

    try:
        document = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=closed_object,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    if not isinstance(document, dict):
        fail(f"{label} must contain one JSON object")
    return document


def absolute_without_resolving_leaf(path: Path) -> Path:
    return Path(os.path.abspath(path))


def fresh_receipt_store_path(path: Path) -> Path:
    candidate = absolute_without_resolving_leaf(path)
    if candidate.exists() or candidate.is_symlink():
        fail("receipt store path must not exist before Engram initializes it")
    try:
        parent = candidate.parent.resolve(strict=True)
        observed_parent = parent.lstat()
    except OSError as error:
        fail(f"receipt store parent cannot be inspected: {error}")
    if (
        parent != candidate.parent
        or not stat.S_ISDIR(observed_parent.st_mode)
        or observed_parent.st_uid != os.geteuid()
        or observed_parent.st_mode & 0o022
    ):
        fail("receipt store parent is not one owner-controlled canonical directory")
    return candidate


def canonical_reported_absolute_path(value: Any, *, label: str) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        fail(f"{label} is not one absolute POSIX path")
    reported = Path(value)
    canonical_path = absolute_without_resolving_leaf(reported)
    if not reported.is_absolute() or reported != canonical_path:
        fail(f"{label} is not one canonical absolute path")
    return reported


def model_document(value: Any) -> dict[str, Any]:
    document = value.model_dump(mode="json")
    if not isinstance(document, dict):
        fail("Engram model did not serialize to one JSON object")
    return document


def safe_source_relative(value: str) -> PurePosixPath:
    if (
        not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        fail("Engram source path is not one canonical POSIX path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        fail(f"Engram source path is unsafe: {value}")
    if relative.as_posix() != value or relative.suffix != ".py":
        fail(f"Engram source path is not canonical Python source: {value}")
    return relative


def module_source_relative(module_name: str, *, is_package: bool) -> PurePosixPath:
    parts = module_name.split(".")
    if not parts or any(not part.isidentifier() for part in parts):
        fail(f"Engram module name is not canonical: {module_name}")
    base = PurePosixPath(*parts)
    return base / "__init__.py" if is_package else base.with_suffix(".py")


def source_record(
    engram_root: Path,
    relative: PurePosixPath,
    *,
    role: str,
    module_name: str | None = None,
) -> dict[str, Any]:
    path = engram_root.joinpath(*relative.parts)
    if path.parent.resolve(strict=True) != path.parent:
        fail(f"Engram source parent resolves outside its canonical path: {relative}")
    payload = read_regular(path, MAX_SOURCE_BYTES, allow_empty=True)
    record: dict[str, Any] = {
        "role": role,
        "relative_path": relative.as_posix(),
        "size_bytes": len(payload),
        "sha256": sha256(payload),
    }
    if module_name is not None:
        record["module_name"] = module_name
    return record


def collect_loaded_engram_sources(
    engram_root: Path,
    modules: Mapping[str, Any],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    paths: dict[str, str] = {}
    for module_name, module in tuple(modules.items()):
        observed_file = getattr(module, "__file__", None)
        if not isinstance(module_name, str) or not isinstance(observed_file, str):
            continue
        observed = absolute_without_resolving_leaf(Path(observed_file))
        try:
            relative_path = observed.relative_to(engram_root)
        except ValueError:
            continue
        relative = safe_source_relative(relative_path.as_posix())
        expected = module_source_relative(
            module_name,
            is_package=hasattr(module, "__path__"),
        )
        if relative != expected:
            fail(
                "Engram module source alias differs from its canonical module path: "
                f"{module_name}"
            )
        prior = paths.setdefault(relative.as_posix(), module_name)
        if prior != module_name:
            fail(f"Engram source has more than one loaded module name: {relative}")
        records.append(
            source_record(
                engram_root,
                relative,
                role="host-loaded-module",
                module_name=module_name,
            )
        )
    loaded_names = {record["module_name"] for record in records}
    missing = sorted(REQUIRED_HOST_MODULES - loaded_names)
    unexpected = sorted(loaded_names - REQUIRED_HOST_MODULES)
    if missing or unexpected:
        fail(
            "Engram host source closure differs from its exact module roster: "
            f"missing={missing}, unexpected={unexpected}"
        )
    if len(records) > MAX_SOURCE_FILES:
        fail("Engram host source closure exceeds its file bound")
    return sorted(records, key=lambda record: record["module_name"])


def collect_entrypoint_sources(engram_root: Path) -> list[dict[str, Any]]:
    return [
        source_record(
            engram_root,
            safe_source_relative(relative),
            role=role,
        )
        for role, relative in EXERCISED_ENTRYPOINTS
    ]


def collect_worker_sources(
    engram_root: Path,
    evidence_document: Mapping[str, Any],
) -> list[dict[str, Any]]:
    identity = evidence_document.get("worker_runtime_identity")
    if not isinstance(identity, dict):
        fail("NEST evidence does not contain a worker runtime identity")
    if identity.get("project_source_closure_verified") is not True or not isinstance(
        identity.get("project_source_roster_sha256"), str
    ):
        fail("NEST worker project source closure is not verified")
    if not SHA256_PATTERN.fullmatch(identity["project_source_roster_sha256"]):
        fail("NEST worker project source roster digest is invalid")
    files = identity.get("files")
    if (
        not isinstance(files, (list, tuple))
        or not files
        or len(files) > MAX_SOURCE_FILES
    ):
        fail("NEST worker runtime file roster is invalid")
    if identity.get("file_roster_sha256") != sha256(canonical(files)):
        fail("NEST worker runtime file roster digest differs")
    project_file_rows = tuple(
        row
        for row in files
        if isinstance(row, dict)
        and isinstance(row.get("role"), str)
        and row["role"].startswith("project-module:")
    )
    if identity["project_source_roster_sha256"] != sha256(canonical(project_file_rows)):
        fail("NEST worker project source roster digest differs")

    worker_file = next(
        (
            row
            for row in files
            if isinstance(row, dict) and row.get("role") == "worker-source"
        ),
        None,
    )
    if worker_file is None:
        fail("NEST worker runtime identity lacks its worker source")
    worker_relative = safe_source_relative(
        "backend/optimization/extension_closed_loop_nest_worker.py"
    )
    reported_worker = canonical_reported_absolute_path(
        worker_file.get("absolute_path"),
        label="NEST worker source path",
    )
    worker_runtime_root = reported_worker
    for _part in worker_relative.parts:
        worker_runtime_root = worker_runtime_root.parent
    if worker_runtime_root.joinpath(*worker_relative.parts) != reported_worker:
        fail("NEST worker source path does not identify one runtime source root")

    records: list[dict[str, Any]] = []
    seen_roles: set[str] = set()
    worker_modules: set[str] = set()
    worker_source_seen = False
    for row in files:
        if not isinstance(row, dict):
            fail("NEST worker runtime file row is invalid")
        role = row.get("role")
        if not isinstance(role, str) or role in seen_roles:
            fail("NEST worker runtime file roles are not unique strings")
        seen_roles.add(role)
        module_name: str | None = None
        if role.startswith("project-module:"):
            module_name = role.removeprefix("project-module:")
            reported = canonical_reported_absolute_path(
                row.get("absolute_path"),
                label="NEST worker project source path",
            )
            is_package = reported.name == "__init__.py"
            relative = module_source_relative(module_name, is_package=is_package)
            worker_modules.add(module_name)
        elif role == "worker-source":
            relative = worker_relative
            reported = reported_worker
            worker_source_seen = True
        else:
            continue
        expected = worker_runtime_root.joinpath(*relative.parts)
        if reported != expected:
            fail(f"NEST worker source path escapes its runtime source root: {role}")
        observed = source_record(
            engram_root,
            relative,
            role="worker-loaded-module" if module_name else "nest-worker-entrypoint",
            module_name=module_name,
        )
        if (
            row.get("sha256") != observed["sha256"]
            or row.get("size_bytes") != observed["size_bytes"]
        ):
            fail(f"NEST worker source bytes differ from its runtime identity: {role}")
        records.append(observed)
    missing = sorted(REQUIRED_WORKER_MODULES - worker_modules)
    unexpected = sorted(worker_modules - REQUIRED_WORKER_MODULES)
    if missing or unexpected or not worker_source_seen:
        fail(
            "NEST worker source closure is incomplete: "
            f"missing_modules={missing}, unexpected_modules={unexpected}, "
            f"worker_source={worker_source_seen}"
        )

    expectation = evidence_document.get("runtime_launch_expectation")
    if not isinstance(expectation, dict):
        fail("NEST evidence lacks its runtime launch expectation")
    required_files = expectation.get("required_runtime_files")
    if not isinstance(required_files, (list, tuple)) or not required_files:
        fail("NEST runtime launch expectation lacks required files")
    identity_by_role = {
        row["role"]: row
        for row in files
        if isinstance(row, dict) and isinstance(row.get("role"), str)
    }
    required_by_role: dict[str, Mapping[str, Any]] = {}
    for row in required_files:
        if not isinstance(row, dict) or not isinstance(row.get("role"), str):
            fail("NEST required runtime file row is invalid")
        if row["role"] in required_by_role:
            fail("NEST required runtime file roles are not unique")
        required_by_role[row["role"]] = row
        if identity_by_role.get(row["role"]) != row:
            fail("NEST required runtime file differs from worker observation")
    if required_by_role.get("worker-source") != worker_file:
        fail("NEST launch expectation does not bind the worker source")

    guardian_relative = safe_source_relative(
        "backend/optimization/extension_closed_loop_nest_guardian.py"
    )
    guardian_file = expectation.get("guardian_source_file")
    if not isinstance(guardian_file, dict) or guardian_file.get("role") != (
        "guardian-source"
    ):
        fail("NEST launch expectation lacks its guardian source")
    reported_guardian = canonical_reported_absolute_path(
        guardian_file.get("absolute_path"),
        label="NEST guardian source path",
    )
    if reported_guardian != worker_runtime_root.joinpath(*guardian_relative.parts):
        fail("NEST guardian source escapes the worker runtime source root")
    guardian_record = source_record(
        engram_root,
        guardian_relative,
        role="nest-guardian-entrypoint",
    )
    if (
        guardian_file.get("sha256") != guardian_record["sha256"]
        or guardian_file.get("size_bytes") != guardian_record["size_bytes"]
        or expectation.get("guardian_source_sha256") != guardian_record["sha256"]
        or expectation.get("worker_source_sha256") != worker_file.get("sha256")
    ):
        fail("NEST worker or guardian source differs from its launch expectation")
    records.append(guardian_record)

    binding = evidence_document.get("worker_session_binding")
    if not isinstance(binding, dict):
        fail("NEST evidence lacks its worker session binding")
    adapter_role = (
        "project-module:backend.optimization.extension_closed_loop_nest_process"
    )
    adapter_file = identity_by_role.get(adapter_role)
    if not isinstance(adapter_file, dict) or (
        binding.get("worker_source_sha256") != worker_file.get("sha256")
        or binding.get("guardian_source_sha256") != guardian_record["sha256"]
        or binding.get("adapter_source_sha256") != adapter_file.get("sha256")
        or binding.get("worker_project_source_roster_sha256")
        != identity["project_source_roster_sha256"]
    ):
        fail("NEST worker session source lineage differs")
    return sorted(
        records,
        key=lambda record: (
            record.get("module_name", ""),
            record["relative_path"],
        ),
    )


def merge_source_inventory(
    *record_groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_path: dict[str, dict[str, Any]] = {}
    for record in (record for group in record_groups for record in group):
        relative = record["relative_path"]
        prior = by_path.get(relative)
        source = {
            "relative_path": relative,
            "size_bytes": record["size_bytes"],
            "sha256": record["sha256"],
        }
        if prior is not None and prior != source:
            fail(f"Engram source observations disagree: {relative}")
        by_path[relative] = source
    if not by_path or len(by_path) > MAX_SOURCE_FILES:
        fail("Engram source closure has an invalid file count")
    if (
        sum(record["size_bytes"] for record in by_path.values())
        > MAX_SOURCE_TOTAL_BYTES
    ):
        fail("Engram source closure exceeds its byte bound")
    return [by_path[path] for path in sorted(by_path)]


def verify_source_inventory(
    engram_root: Path,
    inventory: list[dict[str, Any]],
) -> None:
    for record in inventory:
        relative = safe_source_relative(record["relative_path"])
        payload = read_regular(
            engram_root.joinpath(*relative.parts),
            MAX_SOURCE_BYTES,
            allow_empty=True,
        )
        if len(payload) != record["size_bytes"] or sha256(payload) != record["sha256"]:
            fail(f"Engram source changed during capture: {relative}")


def git_output(engram_root: Path, *arguments: str) -> bytes:
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    environment.update(
        {
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    try:
        completed = run_bounded_process(
            [
                "git",
                "--no-replace-objects",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                *arguments,
            ],
            cwd=engram_root,
            env=environment,
            input_bytes=None,
            timeout_seconds=30,
            max_input_bytes=0,
            max_stdout_bytes=MAX_INPUT_BYTES,
            max_stderr_bytes=64 * 1024,
            label="Engram Git verification",
        )
    except ManagedSimulationSubprocessError as error:
        diagnostic = error.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"Engram Git verification failed: {error}: {diagnostic.strip()}")
    if completed.returncode != 0:
        diagnostic = completed.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"Engram Git verification failed: {diagnostic.strip()}")
    return completed.stdout


def verify_immutable_engram_checkout(
    engram_root: Path,
    expected_commit: str,
) -> dict[str, Any]:
    if not GIT_COMMIT_PATTERN.fullmatch(expected_commit):
        fail("expected Engram commit is not one lowercase Git object ID")
    engram_root = absolute_without_resolving_leaf(engram_root)
    if engram_root.resolve(strict=True) != engram_root:
        fail("Engram checkout root must be one canonical directory")
    top_level = git_output(engram_root, "rev-parse", "--show-toplevel").decode().strip()
    if (
        top_level != str(engram_root)
        or git_output(engram_root, "rev-parse", "--is-inside-work-tree") != b"true\n"
        or git_output(engram_root, "rev-parse", "--is-bare-repository") != b"false\n"
    ):
        fail("Engram Git worktree identity differs from the canonical checkout")
    index_rows = git_output(engram_root, "ls-files", "-v", "-z", "--")
    if (
        not index_rows
        or not index_rows.endswith(b"\0")
        or any(not row.startswith(b"H ") for row in index_rows[:-1].split(b"\0"))
    ):
        fail("Engram tracked index contains non-normal file flags")
    head = (
        git_output(engram_root, "rev-parse", "--verify", "HEAD^{commit}")
        .decode()
        .strip()
    )
    remote_main = (
        git_output(
            engram_root,
            "rev-parse",
            "--verify",
            "refs/remotes/origin/main^{commit}",
        )
        .decode()
        .strip()
    )
    if head != expected_commit or remote_main != expected_commit:
        fail("Engram HEAD and local origin/main do not equal the required commit")
    if git_output(engram_root, "cat-file", "-t", expected_commit) != b"commit\n":
        fail("required Engram object is not a commit")
    status = git_output(
        engram_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    )
    if status:
        fail("Engram checkout is not clean")
    tree = (
        git_output(
            engram_root,
            "rev-parse",
            "--verify",
            f"{expected_commit}^{{tree}}",
        )
        .decode()
        .strip()
    )
    object_format = (
        git_output(engram_root, "rev-parse", "--show-object-format").decode().strip()
    )
    repository = git_output(engram_root, "remote", "get-url", "origin").decode().strip()
    object_length = 40 if object_format == "sha1" else 64
    if (
        object_format not in {"sha1", "sha256"}
        or len(expected_commit) != object_length
        or len(tree) != object_length
        or not repository
        or "\n" in repository
    ):
        fail("Engram Git object format, object IDs, or origin URL is malformed")
    return {
        "repository": repository,
        "commit": expected_commit,
        "tree": tree,
        "origin_main": remote_main,
        "object_format": object_format,
        "clean": True,
    }


def bind_git_source_objects(
    engram_root: Path,
    expected_commit: str,
    inventory: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    paths = [record["relative_path"] for record in inventory]
    payload = git_output(
        engram_root,
        "ls-tree",
        "-z",
        "--full-tree",
        expected_commit,
        "--",
        *paths,
    )
    rows: dict[str, tuple[str, str]] = {}
    for entry in payload.split(b"\0"):
        if not entry:
            continue
        try:
            header, raw_path = entry.split(b"\t", 1)
            mode, kind, object_id = header.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as error:
            fail(f"Engram Git source catalog is malformed: {error}")
        if (
            kind != "blob"
            or mode not in {"100644", "100755"}
            or not GIT_COMMIT_PATTERN.fullmatch(object_id)
            or len(object_id) != len(expected_commit)
            or path in rows
        ):
            fail(f"Engram Git source catalog contains an invalid row: {path}")
        rows[path] = (mode, object_id)
    if set(rows) != set(paths):
        fail("Engram source closure contains untracked or missing Git paths")
    for path, (_mode, object_id) in rows.items():
        observed_id = (
            git_output(
                engram_root,
                "hash-object",
                "--no-filters",
                "--",
                path,
            )
            .decode()
            .strip()
        )
        if observed_id != object_id:
            fail(f"Engram source bytes differ from their committed Git blob: {path}")
    return [
        {
            **record,
            "git_mode": rows[record["relative_path"]][0],
            "git_blob": rows[record["relative_path"]][1],
        }
        for record in inventory
    ]


def verify_pack_source_lineage(
    installed_proof: Mapping[str, Any],
    engram_identity: Mapping[str, Any],
    source_inventory: list[dict[str, Any]] | None = None,
) -> None:
    pack = installed_proof.get("engram_pack_receipt")
    if not isinstance(pack, dict):
        fail("installed proof lacks its Engram pack receipt")
    repository = pack.get("engram_repository")
    tool = pack.get("engram_tool")
    expected_repository = {
        "origin": engram_identity.get("repository"),
        "commit": engram_identity.get("commit"),
        "tree": engram_identity.get("tree"),
        "origin_main": engram_identity.get("origin_main"),
        "object_format": engram_identity.get("object_format"),
        "clean": engram_identity.get("clean"),
    }
    if (
        repository != expected_repository
        or installed_proof.get("engram_commit") != engram_identity.get("commit")
        or installed_proof.get("engram_tree") != engram_identity.get("tree")
        or installed_proof.get("engram_origin_main")
        != engram_identity.get("origin_main")
        or not isinstance(tool, dict)
        or installed_proof.get("engram_extension_tool_sha256") != tool.get("sha256")
        or installed_proof.get("engram_extension_tool_git_blob") != tool.get("git_blob")
    ):
        fail("Engram pack source lineage differs from the immutable checkout")
    if source_inventory is None:
        return
    matching = [
        row
        for row in source_inventory
        if row.get("relative_path") == "scripts/engram_extension.py"
    ]
    if len(matching) != 1 or matching[0] != tool:
        fail("Engram pack tool differs from the loaded committed source closure")


def validate_receipt_lock_timeout(value: int) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= MAX_RECEIPT_LOCK_TIMEOUT_MS
    ):
        fail("receipt lock timeout must be between 1 and 300000 ms")
    return value


def assert_canonical_digest(
    document: Mapping[str, Any],
    *,
    field: str,
    label: str,
) -> str:
    reported = document.get(field)
    if not isinstance(reported, str) or not SHA256_PATTERN.fullmatch(reported):
        fail(f"{label} lacks its canonical digest")
    material = {key: value for key, value in document.items() if key != field}
    if sha256(canonical(material)) != reported:
        fail(f"{label} canonical digest differs")
    return reported


def assert_managed_runtime_digest(
    document: Mapping[str, Any],
    *,
    field: str,
    label: str,
) -> str:
    reported = document.get(field)
    if not isinstance(reported, str) or not SHA256_PATTERN.fullmatch(reported):
        fail(f"{label} lacks its managed-runtime digest")
    material = {key: value for key, value in document.items() if key != field}
    if sha256(managed_runtime_canonical(material)) != reported:
        fail(f"{label} managed-runtime digest differs")
    return reported


def assert_no_authority_escalation(value: Any, label: str) -> None:
    """Reject an authority-bearing boolean anywhere in a retained document."""

    pending: list[Any] = [value]
    observed_nodes = 0
    while pending:
        current = pending.pop()
        observed_nodes += 1
        if observed_nodes > 1_000_000:
            fail(f"{label} exceeds the authority-audit node bound")
        if isinstance(current, Mapping):
            for key, child in current.items():
                if key in NON_AUTHORITY_FALSE_FIELDS and child is not False:
                    fail(f"{label} grants or implies non-simulator authority")
                if key == "simulator_only" and child is not True:
                    fail(f"{label} contradicts simulator-only scope")
                if (
                    key == "authority"
                    and isinstance(child, bool)
                    and child is not False
                ):
                    fail(f"{label} grants generic execution authority")
                pending.append(child)
        elif isinstance(current, (list, tuple)):
            pending.extend(current)


def load_installed_proof(path: Path) -> tuple[dict[str, Any], bytes]:
    payload = read_regular(path, MAX_INPUT_BYTES)
    document = decode_json_object(payload, "installed managed-simulation proof")
    if payload != canonical(document) + b"\n":
        fail("installed managed-simulation proof is not exact canonical JSON")
    if set(document) != INSTALLED_PROOF_KEYS or document.get("schema_version") != (
        "crebain.standard-v3-installed-binary-proof.v3"
    ):
        fail("installed managed-simulation proof schema differs")
    assert_canonical_digest(
        document,
        field="receipt_sha256",
        label="installed managed-simulation proof",
    )
    authority = document.get("authority")
    observed_build = document.get("observed_build_receipt")
    package_stage = document.get("package_stage_receipt")
    engram_pack = document.get("engram_pack_receipt")
    if (
        not isinstance(observed_build, dict)
        or not isinstance(package_stage, dict)
        or not isinstance(engram_pack, dict)
    ):
        fail("installed managed-simulation proof lacks build, stage, or pack receipts")
    validate_build_receipt(observed_build)
    observed_build_bytes = canonical(observed_build) + b"\n"
    validate_stage_receipt(
        package_stage,
        build_receipt=observed_build,
        build_receipt_bytes=observed_build_bytes,
    )
    package_stage_bytes = canonical(package_stage) + b"\n"
    validate_pack_receipt(engram_pack)
    engram_pack_bytes = canonical(engram_pack) + b"\n"
    pack_repository = engram_pack["engram_repository"]
    pack_tool = engram_pack["engram_tool"]
    if (
        authority != SIMULATOR_ONLY_AUTHORITY
        or document.get("drone_counts") != [1, 2, 3]
        or document.get("replay_exact") is not True
        or document.get("unaffected_lane_observations_exact") is not True
        or document.get("installed_artifacts_reverified_after_execution") is not True
        or document.get("generation_seal_package_bundle_store_lineage_verified")
        is not True
        or document.get("build_stage_seal_install_lineage_verified") is not True
        or document.get("build_stage_seal_pack_install_lineage_verified") is not True
        or document.get("observed_build_receipt_exact_sha256")
        != sha256(observed_build_bytes)
        or document.get("observed_build_receipt_sha256")
        != observed_build.get("receipt_sha256")
        or document.get("package_stage_receipt_exact_sha256")
        != sha256(package_stage_bytes)
        or document.get("package_stage_receipt_sha256")
        != package_stage.get("receipt_sha256")
        or document.get("engram_pack_receipt_exact_sha256") != sha256(engram_pack_bytes)
        or document.get("engram_pack_receipt_sha256")
        != engram_pack.get("receipt_sha256")
        or document.get("crebain_commit")
        != observed_build.get("repository", {}).get("commit")
        or document.get("crebain_tree")
        != observed_build.get("repository", {}).get("tree")
        or document.get("crebain_origin_main") != document.get("crebain_commit")
        or package_stage.get("crebain_commit") != document.get("crebain_commit")
        or document.get("engram_commit") != pack_repository.get("commit")
        or document.get("engram_tree") != pack_repository.get("tree")
        or document.get("engram_origin_main") != document.get("engram_commit")
        or document.get("engram_origin_main") != pack_repository.get("origin_main")
        or document.get("engram_extension_tool_sha256") != pack_tool.get("sha256")
        or document.get("engram_extension_tool_git_blob") != pack_tool.get("git_blob")
        or engram_pack.get("observed_build_receipt_exact_sha256")
        != sha256(observed_build_bytes)
        or engram_pack.get("observed_build_receipt_sha256")
        != observed_build.get("receipt_sha256")
        or engram_pack.get("package_stage_receipt_exact_sha256")
        != sha256(package_stage_bytes)
        or engram_pack.get("package_stage_receipt_sha256")
        != package_stage.get("receipt_sha256")
        or engram_pack.get("seal_receipt_exact_sha256")
        != document.get("seal_receipt_exact_sha256")
        or engram_pack.get("bundle_receipt_exact_sha256")
        != document.get("bundle_receipt_exact_sha256")
        or engram_pack.get("package_generation_id")
        != document.get("package_generation_id")
        or document.get("build_source_roster_sha256")
        != observed_build.get("source", {}).get("roster_sha256")
        or document.get("build_input_identity_sha256")
        != observed_build.get("input_identity_sha256")
        or document.get("configuration_exact_sha256")
        != package_stage.get("configuration_exact_sha256")
        or document.get("executable_format") != "mach-o-64"
        or document.get("executable_architecture") != "arm64"
        or package_stage.get("target") != TARGET
        or not isinstance(document.get("disclosure"), str)
        or not document.get("disclosure")
    ):
        fail("installed managed-simulation proof is incomplete or grants authority")
    for field, prefix in (
        ("store_id", "extstore_"),
        ("package_generation_id", "pkggen_"),
        ("installation_id", "inst_"),
    ):
        value = document.get(field)
        if (
            not isinstance(value, str)
            or value[: len(prefix)] != prefix
            or not SHA256_PATTERN.fullmatch(value[len(prefix) :])
        ):
            fail(f"installed managed-simulation proof lacks {field}")
    for field in (
        "generation_core_sha256",
        "bundle_receipt_exact_sha256",
        "seal_receipt_exact_sha256",
        "install_observation_exact_sha256",
        "manifest_exact_sha256",
        "package_lock_exact_sha256",
        "configuration_exact_sha256",
        "package_sha256",
        "executable_sha256",
        "configuration_canonical_sha256",
        "operation_roster_sha256",
        "observed_build_receipt_exact_sha256",
        "observed_build_receipt_sha256",
        "package_stage_receipt_exact_sha256",
        "package_stage_receipt_sha256",
        "engram_pack_receipt_exact_sha256",
        "engram_pack_receipt_sha256",
        "build_source_roster_sha256",
        "build_input_identity_sha256",
        "engram_extension_tool_sha256",
    ):
        value = document.get(field)
        if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
            fail(f"installed managed-simulation proof lacks {field}")
    for field in (
        "engram_commit",
        "engram_tree",
        "engram_origin_main",
        "engram_extension_tool_git_blob",
    ):
        value = document.get(field)
        if not isinstance(value, str) or not GIT_COMMIT_PATTERN.fullmatch(value):
            fail(f"installed managed-simulation proof lacks {field}")
    if document.get("executable_sha256") != observed_build.get("output", {}).get(
        "sha256"
    ) or document.get("executable_sha256") != package_stage.get(
        "staged_executable", {}
    ).get("sha256"):
        fail("installed executable differs from its build and stage receipts")
    if document.get("signal_cancellation_gate") != (
        "active-SIGTERM-then-fresh-generation-prepared"
    ):
        fail("installed managed-simulation proof lacks its cancellation closure")
    if (
        document.get("operation_ids")
        != [
            "crebain.simulation.finish.v1",
            "crebain.simulation.finish.v3",
            "crebain.simulation.prepare.v1",
            "crebain.simulation.prepare.v3",
            "crebain.simulation.step.v1",
            "crebain.simulation.step.v3",
        ]
        or document.get("step_count") != 6
        or document.get("fault_step") != 3
        or document.get("fault") != "sensor-unavailable"
        or document.get("host_policy")
        != [
            "fault-observed",
            "safe-hold",
            "bounded-zero-washout",
            "bounded-nonzero-resume",
        ]
        or document.get("negative_clock_gate") != "standard.clock-mismatch"
    ):
        fail("installed managed-simulation proof contract roster differs")
    recovery_controls = document.get("recovery_controls_sha256")
    standard_schemas = document.get("standard_schema_sha256")
    if (
        not isinstance(recovery_controls, dict)
        or set(recovery_controls) != {"1", "2", "3"}
        or any(
            not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value)
            for value in recovery_controls.values()
        )
        or standard_schemas != STANDARD_V3_SCHEMA_HASHES
        or not SHA256_PATTERN.fullmatch(
            document.get("baseline_three_controls_sha256", "")
        )
    ):
        fail("installed managed-simulation proof digest roster differs")
    return document, payload


def expected_population_topology(
    plan_document: Mapping[str, Any],
) -> tuple[list[str], list[str], list[tuple[str, int]]]:
    channels = plan_document.get("channels")
    if not isinstance(channels, list) or not 1 <= len(channels) <= 3:
        fail("run plan requires one through three drone channels")
    channel_ids: list[str] = []
    population_names: list[str] = []
    axis_roster: list[tuple[str, int]] = []
    prefixes: set[str] = set()
    for channel in channels:
        if not isinstance(channel, dict):
            fail("run plan channel is not an object")
        channel_id = channel.get("channel_id")
        prefix = channel.get("neural_population_prefix")
        axes = channel.get("neural_control_axes")
        if (
            not isinstance(channel_id, str)
            or channel_id in channel_ids
            or not isinstance(prefix, str)
            or prefix in prefixes
            or channel.get("subject_kind") != "simulated.drone"
            or channel.get("action_width") != 3
            or not isinstance(axes, list)
            or [axis.get("action_index") for axis in axes if isinstance(axis, dict)]
            != [0, 1, 2]
        ):
            fail("run plan channel or three-axis neural topology differs")
        channel_ids.append(channel_id)
        prefixes.add(prefix)
        for action_index in range(3):
            axis_roster.append((channel_id, action_index))
            population_names.extend(
                (
                    f"{prefix}.d{action_index:02}.negative",
                    f"{prefix}.d{action_index:02}.positive",
                )
            )
    return channel_ids, sorted(population_names), axis_roster


def expected_population_bindings(
    plan_document: Mapping[str, Any],
) -> dict[str, list[str]]:
    bindings: dict[str, list[str]] = {}
    for channel in plan_document["channels"]:
        channel_id = channel["channel_id"]
        prefix = channel["neural_population_prefix"]
        bindings[channel_id] = sorted(
            f"{prefix}.d{action_index:02}.{sign}"
            for action_index in range(3)
            for sign in ("negative", "positive")
        )
    return bindings


def exact_named_rows(
    rows: Any,
    *,
    key: str,
    expected: list[str],
    label: str,
) -> list[Mapping[str, Any]]:
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        fail(f"{label} is not one object roster")
    if [row.get(key) for row in rows] != expected:
        fail(f"{label} differs from the exact population topology")
    return rows


def assert_neural_steps_closure(
    plan_document: Mapping[str, Any],
    terminal_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
    neural_steps: Any,
    *,
    expected_step_count: int,
) -> None:
    """Close the captured Host neural request and result transcript."""

    plan_channels = plan_document.get("channels")
    terminal_steps = terminal_document.get("steps")
    neural_executions = terminal_document.get("neural_executions")
    nest_executions = evidence_document.get("step_execution_receipts")
    timebase = terminal_document.get("timebase")
    if (
        not isinstance(plan_channels, list)
        or not 1 <= len(plan_channels) <= 3
        or not isinstance(neural_steps, list)
        or len(neural_steps) != expected_step_count
        or not isinstance(terminal_steps, list)
        or len(terminal_steps) != expected_step_count
        or not isinstance(neural_executions, list)
        or len(neural_executions) != expected_step_count
        or not isinstance(nest_executions, list)
        or len(nest_executions) != expected_step_count
        or not isinstance(timebase, dict)
    ):
        fail("captured neural step transcript roster differs")
    interval_tics = timebase.get("runtime_step_duration_tics")
    if (
        not isinstance(interval_tics, int)
        or isinstance(interval_tics, bool)
        or interval_tics < 1
        or timebase.get("neural_step_duration_tics") != interval_tics
    ):
        fail("captured neural step transcript timebase differs")
    if any(not isinstance(row, dict) for row in plan_channels):
        fail("captured neural step plan channel contract differs")
    channel_ids = [row.get("channel_id") for row in plan_channels]
    subject_ids = [row.get("subject_id") for row in plan_channels]
    observation_widths = [row.get("observation_width") for row in plan_channels]
    action_widths = [row.get("action_width") for row in plan_channels]
    if (
        any(not isinstance(value, str) or not value for value in channel_ids)
        or len(set(channel_ids)) != len(channel_ids)
        or any(not isinstance(value, str) or not value for value in subject_ids)
        or any(
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 1 <= value <= 16
            for value in (*observation_widths, *action_widths)
        )
    ):
        fail("captured neural step plan channel contract differs")

    study_run_id = terminal_document.get("study_run_id")
    preparation_sha256 = terminal_document.get("neural_preparation_sha256")

    def exact_float_vector(value: Any, width: int, label: str) -> None:
        if not isinstance(value, list) or len(value) != width:
            fail(f"{label} width differs")
        for item in value:
            if type(item) is not float:
                fail(f"{label} contains a non-float JSON value")
            managed_runtime_float_text(item)

    for index, step_value in enumerate(neural_steps, start=1):
        step = _exact_object(
            step_value,
            NEURAL_STEP_KEYS,
            f"captured neural step {index}",
        )
        request = _exact_object(
            step.get("request"),
            NEURAL_STEP_REQUEST_KEYS,
            f"captured neural step {index} request",
        )
        result = _exact_object(
            step.get("result"),
            NEURAL_STEP_RESULT_KEYS,
            f"captured neural step {index} result",
        )
        request_digest = assert_managed_runtime_digest(
            request,
            field="request_sha256",
            label=f"captured neural step {index} request",
        )
        result_digest = assert_managed_runtime_digest(
            result,
            field="result_sha256",
            label=f"captured neural step {index} result",
        )
        terminal_step = terminal_steps[index - 1]
        execution_binding = neural_executions[index - 1]
        nest_execution = nest_executions[index - 1]
        step_id = _closed_loop_step_id(study_run_id, index)
        start_tics = (index - 1) * interval_tics
        end_tics = index * interval_tics
        if (
            not isinstance(terminal_step, dict)
            or not isinstance(execution_binding, dict)
            or not isinstance(nest_execution, dict)
            or request.get("schema_version")
            != "engram.closed-loop-neural-step-request.v1"
            or result.get("schema_version")
            != "engram.closed-loop-neural-step-result.v1"
            or request.get("study_run_id") != study_run_id
            or result.get("study_run_id") != study_run_id
            or request.get("step_index") != index
            or result.get("step_index") != index
            or request.get("step_id") != step_id
            or result.get("step_id") != step_id
            or request.get("neural_preparation_sha256") != preparation_sha256
            or request.get("source_snapshot_sha256")
            != terminal_step.get("input_snapshot_sha256")
            or request.get("observation_runtime_time_tics") != start_tics
            or request.get("runtime_interval_end_time_tics") != end_tics
            or request.get("runtime_interval_tics") != interval_tics
            or request.get("controller_start_time_tics") != start_tics
            or request.get("controller_end_time_tics") != end_tics
            or request.get("controller_interval_tics") != interval_tics
            or result.get("controller_start_time_tics") != start_tics
            or result.get("controller_end_time_tics") != end_tics
            or result.get("request_sha256") != request_digest
            or result.get("provider_execution_scope") != "nest-exact-step-readback"
            or result.get("provider_execution_sha256")
            != nest_execution.get("receipt_sha256")
            or terminal_step.get("neural_request_sha256") != request_digest
            or terminal_step.get("neural_result_sha256") != result_digest
            or terminal_step.get("provider_execution_scope")
            != result.get("provider_execution_scope")
            or terminal_step.get("provider_execution_sha256")
            != result.get("provider_execution_sha256")
            or execution_binding.get("neural_request_sha256") != request_digest
            or execution_binding.get("neural_result_sha256") != result_digest
            or execution_binding.get("provider_execution_sha256")
            != result.get("provider_execution_sha256")
        ):
            fail(f"captured neural step {index} lineage differs")

        channels = request.get("channels")
        if not isinstance(channels, list) or len(channels) != len(plan_channels):
            fail(f"captured neural step {index} request channel roster differs")
        for channel_index, channel_value in enumerate(channels):
            channel = _exact_object(
                channel_value,
                NEURAL_INPUT_CHANNEL_KEYS,
                f"captured neural step {index} input channel {channel_index + 1}",
            )
            fault_code = channel.get("fault_code")
            if (
                channel.get("channel_id") != channel_ids[channel_index]
                or channel.get("subject_id") != subject_ids[channel_index]
                or type(channel.get("hold_required")) is not bool
                or not isinstance(fault_code, str)
                or not fault_code
                or fault_code != fault_code.strip()
                or len(fault_code.encode("utf-8")) > 256
                or any(
                    ord(character) < 33 or ord(character) == 127
                    for character in fault_code
                )
            ):
                fail(f"captured neural step {index} input channel differs")
            exact_float_vector(
                channel.get("observation_values"),
                observation_widths[channel_index],
                f"captured neural step {index} observation",
            )

        proposals = result.get("proposals")
        if not isinstance(proposals, list) or len(proposals) != len(plan_channels):
            fail(f"captured neural step {index} proposal roster differs")
        for channel_index, proposal_value in enumerate(proposals):
            proposal = _exact_object(
                proposal_value,
                NEURAL_ACTION_PROPOSAL_KEYS,
                f"captured neural step {index} proposal {channel_index + 1}",
            )
            sources = proposal.get("source_populations")
            if (
                proposal.get("channel_id") != channel_ids[channel_index]
                or not isinstance(sources, list)
                or not 1 <= len(sources) <= 64
                or sources != sorted(sources)
                or len(sources) != len(set(sources))
                or any(not isinstance(source, str) or not source for source in sources)
            ):
                fail(f"captured neural step {index} proposal differs")
            exact_float_vector(
                proposal.get("values"),
                action_widths[channel_index],
                f"captured neural step {index} proposal",
            )


def assert_population_topology(
    plan_document: Mapping[str, Any],
    config_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
    neural_steps: list[dict[str, Any]],
) -> dict[str, Any]:
    channel_ids, population_names, axis_roster = expected_population_topology(
        plan_document
    )
    population_size = config_document.get("population_size")
    if (
        not isinstance(population_size, int)
        or isinstance(population_size, bool)
        or population_size < 1
    ):
        fail("NEST configuration population size is not an integer")
    session = evidence_document.get("nest_session_readback")
    if not isinstance(session, dict) or session.get("one_session") is not True:
        fail("NEST evidence does not prove exactly one session")
    expected_population_count = 6 * len(channel_ids)
    if len(population_names) != expected_population_count:
        fail("expected signed population topology is not exactly 6N")
    expected_connections = [
        (population_name, direction)
        for population_name in population_names
        for direction in ("input", "recorder")
    ]
    connection_rows = session.get("connection_readbacks")
    if not isinstance(connection_rows, list) or any(
        not isinstance(row, dict) for row in connection_rows
    ):
        fail("NEST connection readbacks are absent")
    if [
        (row.get("population_name"), row.get("direction")) for row in connection_rows
    ] != expected_connections:
        fail("NEST connection topology differs from the exact 6N roster")
    if any(row.get("connection_count") != population_size for row in connection_rows):
        fail("NEST connection count differs from the population size")
    if session.get("connection_readback_sha256") != sha256(canonical(connection_rows)):
        fail("NEST connection readback digest differs")
    if (
        session.get("observed_population_neuron_count")
        != expected_population_count * population_size
        or session.get("observed_device_node_count") != expected_population_count * 2
        or session.get("observed_total_connection_count")
        != expected_population_count * population_size * 2
    ):
        fail("NEST node or connection totals differ from the exact 6N topology")
    population_bindings = expected_population_bindings(plan_document)
    reported_roster = session.get("population_roster")
    expected_roster = [
        {
            "channel_id": channel_id,
            "population_names": population_bindings[channel_id],
        }
        for channel_id in channel_ids
    ]
    if reported_roster != expected_roster:
        fail("NEST population roster differs from the exact 6N topology")
    if session.get("population_roster_sha256") != sha256(canonical(reported_roster)):
        fail("NEST population roster digest differs")

    executions = evidence_document.get("step_execution_receipts")
    if (
        not isinstance(executions, list)
        or len(executions) != 6
        or len(neural_steps) != 6
    ):
        fail("NEST topology proof requires six exact steps")
    expected_axes = [list(row) for row in axis_roster]
    for step_index, (execution, neural_step) in enumerate(
        zip(executions, neural_steps, strict=True), start=1
    ):
        if not isinstance(execution, dict):
            fail("NEST execution receipt is not an object")
        for key, label in (
            ("generator_schedule_readbacks", "generator schedule roster"),
            ("input_weight_readbacks", "input weight roster"),
            ("completed_window_readbacks", "completed window roster"),
            ("population_event_deltas", "population event roster"),
        ):
            exact_named_rows(
                execution.get(key),
                key="population_name",
                expected=population_names,
                label=f"step {step_index} {label}",
            )
        safety = exact_named_rows(
            execution.get("channel_safety_readbacks"),
            key="channel_id",
            expected=channel_ids,
            label=f"step {step_index} channel safety roster",
        )
        if len(safety) != len(channel_ids):
            fail("NEST channel safety roster cardinality differs")
        encoded = execution.get("encoded_control_inputs")
        if (
            not isinstance(encoded, list)
            or any(not isinstance(row, dict) for row in encoded)
            or [[row.get("channel_id"), row.get("action_index")] for row in encoded]
            != expected_axes
        ):
            fail(f"step {step_index} encoded control axis roster differs")
        result = neural_step.get("result")
        request = neural_step.get("request")
        if not isinstance(result, dict) or not isinstance(request, dict):
            fail("captured neural step lacks request or result")
        if [
            row.get("channel_id") for row in request.get("channels", [])
        ] != channel_ids:
            fail(f"step {step_index} neural request channel roster differs")
        proposals = result.get("proposals")
        if (
            not isinstance(proposals, list)
            or [row.get("channel_id") for row in proposals if isinstance(row, dict)]
            != channel_ids
        ):
            fail(f"step {step_index} neural proposal channel roster differs")
        for proposal in proposals:
            expected_sources = population_bindings[proposal["channel_id"]]
            if proposal.get("source_populations") != expected_sources:
                fail(f"step {step_index} neural proposal population roster differs")
    return {
        "session_count": 1,
        "drone_count": len(channel_ids),
        "action_axis_count": len(axis_roster),
        "population_count": expected_population_count,
        "population_neuron_count": expected_population_count * population_size,
        "device_node_count": expected_population_count * 2,
        "connection_count": expected_population_count * population_size * 2,
        "population_names": population_names,
        "derived_population_roster_sha256": sha256(canonical(population_names)),
    }


def assert_worker_guardian_closure(
    evidence_document: Mapping[str, Any],
) -> dict[str, Any]:
    binding = evidence_document.get("worker_session_binding")
    lifecycle_value = evidence_document.get("worker_lifecycle_receipt")
    attempts = evidence_document.get("worker_termination_attempt_receipts")
    identity = evidence_document.get("worker_runtime_identity")
    session = evidence_document.get("nest_session_readback")
    if (
        evidence_document.get("worker_terminal_disposition") != "confirmed-lifecycle"
        or not isinstance(binding, dict)
        or not isinstance(lifecycle_value, dict)
        or not isinstance(attempts, list)
        or not attempts
        or not isinstance(identity, dict)
        or not isinstance(session, dict)
        or lifecycle_value.get("termination_attempts") != attempts
    ):
        fail("NEST worker guardian lifecycle is incomplete")
    lifecycle = _exact_object(
        lifecycle_value,
        NEST_WORKER_LIFECYCLE_KEYS,
        "NEST worker lifecycle receipt",
    )
    binding_digest = assert_canonical_digest(
        binding,
        field="receipt_sha256",
        label="NEST worker session binding",
    )
    lifecycle_digest = assert_canonical_digest(
        lifecycle,
        field="receipt_sha256",
        label="NEST worker lifecycle receipt",
    )
    identity_digest = assert_canonical_digest(
        identity,
        field="receipt_sha256",
        label="NEST worker runtime identity",
    )
    if (
        lifecycle.get("session_binding_receipt_sha256") != binding_digest
        or lifecycle.get("runtime_identity_receipt_sha256") != identity_digest
        or binding.get("worker_runtime_identity_sha256") != identity_digest
        or binding.get("child_session_receipt_sha256") != session.get("receipt_sha256")
        or binding.get("child_lineage_verified") is not True
        or binding.get("loaded_bytes_attested") is not False
        or binding.get("response_bound_loaded_bytes") is not False
        or binding.get("ncp_transport") is not False
        or binding.get("scientific_authority") is not False
        or lifecycle.get("termination_attempt_roster_sha256")
        != sha256(canonical(attempts))
        or lifecycle.get("child_reaped") is not True
        or lifecycle.get("containment_empty") is not True
        or lifecycle.get("diagnostic_stream_complete") is not True
        or lifecycle.get("hard_deadline_enforcement") is not True
        or lifecycle.get("ncp_transport") is not False
        or lifecycle.get("physical_authority") is not False
        or lifecycle.get("scientific_authority") is not False
    ):
        fail("NEST worker guardian terminal closure differs")
    checked_attempts: list[dict[str, Any]] = []
    for expected_index, attempt_value in enumerate(attempts, start=1):
        attempt = _exact_object(
            attempt_value,
            NEST_TERMINATION_ATTEMPT_KEYS,
            "NEST worker termination attempt",
        )
        assert_canonical_digest(
            attempt,
            field="receipt_sha256",
            label="NEST worker termination attempt",
        )
        if (
            attempt.get("attempt_index") != expected_index
            or attempt.get("schema_version")
            != "engram.nest-worker-termination-attempt.v1"
            or attempt.get("worker_pid") != lifecycle.get("worker_pid")
            or attempt.get("worker_source_sha256")
            != lifecycle.get("worker_source_sha256")
            or attempt.get("worker_command_sha256")
            != lifecycle.get("worker_command_sha256")
            or attempt.get("adapter_source_sha256")
            != lifecycle.get("adapter_source_sha256")
            or attempt.get("child_reaped") is not True
            or attempt.get("containment_empty") is not True
            or attempt.get("diagnostic_stream_complete") is not True
            or attempt.get("hard_deadline_enforcement") is not True
            or attempt.get("ncp_transport") is not False
            or attempt.get("physical_authority") is not False
            or attempt.get("scientific_authority") is not False
            or not isinstance(attempt.get("request_count"), int)
            or isinstance(attempt.get("request_count"), bool)
            or not 0 <= attempt.get("request_count") <= 4096
            or not isinstance(attempt.get("response_count"), int)
            or isinstance(attempt.get("response_count"), bool)
            or not 0 <= attempt.get("response_count") <= attempt.get("request_count")
            or attempt.get("process_group_id") != attempt.get("worker_pid")
            or attempt.get("guardian_pid") == attempt.get("process_group_id")
            or attempt.get("group_signal_while_guardian_unreaped")
            != (attempt.get("group_signal_basis") == "guardian-group-anchor-unreaped")
            or attempt.get("group_signal_attempted")
            != (
                attempt.get("group_signal_basis") != "none"
                and attempt.get("containment_seal_signal") == 9
            )
            or (
                attempt.get("containment_empty") is True
                and attempt.get("anchored_group_kill_delivered") is not True
            )
            or (
                attempt.get("group_signal_basis") == "guardian-group-anchor-unreaped"
                and attempt.get("guardian_unexpected_exit_observed") is not False
            )
            or (
                attempt.get("group_signal_basis") == "worker-group-leader-unreaped"
                and attempt.get("guardian_unexpected_exit_observed") is not True
            )
        ):
            fail("NEST worker termination attempt lineage differs")
        checked_attempts.append(attempt)
    final_attempt = checked_attempts[-1]
    if (
        lifecycle.get("schema_version") != "engram.nest-worker-lifecycle-receipt.v2"
        or not isinstance(lifecycle.get("request_count"), int)
        or isinstance(lifecycle.get("request_count"), bool)
        or not 0 <= lifecycle.get("request_count") <= 4096
        or not isinstance(lifecycle.get("response_count"), int)
        or isinstance(lifecycle.get("response_count"), bool)
        or not 0 <= lifecycle.get("response_count") <= lifecycle.get("request_count")
        or lifecycle.get("process_group_id") != lifecycle.get("worker_pid")
        or lifecycle.get("guardian_pid") == lifecycle.get("process_group_id")
        or not any(
            row.get("anchored_group_kill_delivered") is True for row in checked_attempts
        )
        or (
            lifecycle.get("runtime_identity_receipt_sha256") is None
            or lifecycle.get("resource_limit_receipt_sha256") is None
        )
        or any(
            final_attempt.get(field) != lifecycle.get(field)
            for field in (
                "disposition",
                "reason_code",
                "exit_code",
                "termination_signal",
                "guardian_unexpected_exit_observed",
                "stderr_sha256",
                "stderr_retained_bytes",
                "stderr_truncated",
                "request_count",
                "response_count",
            )
        )
        or any(
            final_attempt.get(field) is not True
            for field in (
                "child_reaped",
                "guardian_reaped",
                "containment_empty",
                "diagnostic_stream_complete",
            )
        )
    ):
        fail("NEST worker lifecycle differs from its terminal attempt")
    return {
        "worker_session_binding_receipt_sha256": binding_digest,
        "worker_runtime_identity_receipt_sha256": identity_digest,
        "worker_lifecycle_receipt_sha256": lifecycle_digest,
        "termination_attempt_count": len(attempts),
        "termination_attempt_roster_sha256": sha256(canonical(attempts)),
        "worker_pid": lifecycle.get("worker_pid"),
        "worker_source_sha256": lifecycle.get("worker_source_sha256"),
        "worker_command_sha256": lifecycle.get("worker_command_sha256"),
        "child_reaped": True,
        "containment_empty": True,
        "diagnostic_stream_complete": True,
    }


def receipt_store_identity(store: Any) -> str:
    value = getattr(store, "store_id", None)
    if callable(value):
        value = value()
    if not isinstance(value, str) or not value.startswith("clrs_"):
        fail("closed-loop receipt store does not expose its exact store identity")
    return value


def _exact_object(
    value: Any,
    keys: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} field roster differs")
    return value


def _require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        fail(f"{label} is not one SHA-256 identity")
    return value


def _closed_loop_step_id(study_run_id: str, step_index: int) -> str:
    digest = sha256(
        managed_runtime_canonical(
            {
                "domain": "engram-extension-closed-loop-step-v2",
                "run_id": study_run_id,
                "step_index": step_index,
            }
        )
    )
    return f"step_{digest[:32]}"


def assert_terminal_receipt_closure(
    terminal: Mapping[str, Any],
    *,
    expected_step_count: int,
) -> dict[str, str]:
    """Replay the successful ClosedLoopRunReceiptV2 validator contract."""

    terminal = _exact_object(
        terminal,
        TERMINAL_RECEIPT_KEYS,
        "terminal closed-loop receipt",
    )
    timebase = _exact_object(
        terminal.get("timebase"),
        TIMEBASE_KEYS,
        "terminal closed-loop timebase",
    )
    steps = terminal.get("steps")
    executions = terminal.get("neural_executions")
    cleanup = terminal.get("cleanup")
    lifecycle = _exact_object(
        terminal.get("runtime_lifecycle"),
        RUNTIME_LIFECYCLE_KEYS,
        "terminal runtime lifecycle",
    )
    if (
        terminal.get("schema_version") != "engram.extension-closed-loop-run-receipt.v2"
        or terminal.get("digest_canonicalization") != "engram.managed-runtime-json.v1"
        or not isinstance(steps, list)
        or not isinstance(executions, list)
        or not isinstance(cleanup, list)
        or len(steps) != expected_step_count
        or len(executions) != expected_step_count
        or len(cleanup) != 2
        or terminal.get("planned_step_count") != expected_step_count
    ):
        fail("terminal closed-loop root roster or cardinality differs")
    study_run_id = terminal.get("study_run_id")
    duration = timebase.get("runtime_step_duration_tics")
    if (
        not isinstance(study_run_id, str)
        or not study_run_id
        or not isinstance(duration, int)
        or isinstance(duration, bool)
        or duration < 1
        or timebase
        != {
            "schema_version": "engram.extension-closed-loop-timebase.v1",
            "tic_unit": "microsecond",
            "coupling": "one-controller-epoch-per-runtime-interval",
            "clock_relation": "independent-controller-and-runtime-logical-clocks",
            "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
            "dispatch_order": "observe-controller-action-runtime",
            "observation_sample_phase": "runtime-interval-start",
            "action_application": (
                "after-controller-completion-zoh-over-runtime-interval"
            ),
            "runtime_step_duration_tics": duration,
            "neural_step_duration_tics": duration,
        }
    ):
        fail("terminal closed-loop timebase differs")

    previous_snapshot = terminal.get("initial_snapshot_sha256")
    _require_sha256(previous_snapshot, "terminal initial snapshot")
    step_digests: list[str] = []
    execution_digests: list[str] = []
    for index, (step_value, execution_value) in enumerate(
        zip(steps, executions, strict=True),
        start=1,
    ):
        step = _exact_object(
            step_value,
            TERMINAL_STEP_KEYS,
            f"terminal step {index}",
        )
        execution = _exact_object(
            execution_value,
            NEURAL_EXECUTION_BINDING_KEYS,
            f"terminal neural execution {index}",
        )
        step_digest = assert_managed_runtime_digest(
            step,
            field="receipt_sha256",
            label=f"terminal step {index}",
        )
        execution_digest = assert_managed_runtime_digest(
            execution,
            field="binding_sha256",
            label=f"terminal neural execution {index}",
        )
        step_id = _closed_loop_step_id(study_run_id, index)
        if (
            step.get("schema_version") != "engram.extension-closed-loop-step-receipt.v2"
            or step.get("study_run_id") != study_run_id
            or step.get("step_index") != index
            or step.get("step_id") != step_id
            or step.get("input_snapshot_sha256") != previous_snapshot
            or step.get("provider_execution_scope") != "nest-exact-step-readback"
            or not isinstance(step.get("fault_codes"), list)
            or not step["fault_codes"]
            or any(
                not isinstance(code, str) or not code or len(code.encode("utf-8")) > 256
                for code in step["fault_codes"]
            )
            or execution.get("schema_version")
            != "engram.closed-loop-neural-execution-binding.v1"
            or execution.get("step_index") != index
            or execution.get("step_id") != step_id
            or execution.get("provider_execution_scope") != "nest-exact-step-readback"
            or any(
                execution.get(field) != step.get(field)
                for field in (
                    "neural_request_sha256",
                    "neural_result_sha256",
                    "provider_execution_scope",
                    "provider_execution_sha256",
                )
            )
        ):
            fail(f"terminal step {index} lineage differs")
        for field in (
            "input_snapshot_sha256",
            "neural_request_sha256",
            "neural_result_sha256",
            "provider_execution_sha256",
            "admitted_action_sha256",
            "runtime_request_sha256",
            "output_snapshot_sha256",
        ):
            _require_sha256(step.get(field), f"terminal step {index} {field}")
        previous_snapshot = step["output_snapshot_sha256"]
        step_digests.append(step_digest)
        execution_digests.append(execution_digest)

    runtime_cleanup = _exact_object(
        cleanup[0],
        CLEANUP_RECEIPT_KEYS,
        "terminal runtime cleanup",
    )
    neural_cleanup = _exact_object(
        cleanup[1],
        CLEANUP_RECEIPT_KEYS,
        "terminal neural cleanup",
    )
    cleanup_digests = [
        assert_managed_runtime_digest(
            row,
            field="receipt_sha256",
            label=f"terminal {row.get('component')} cleanup",
        )
        for row in (runtime_cleanup, neural_cleanup)
    ]
    lifecycle_digest = assert_managed_runtime_digest(
        lifecycle,
        field="binding_sha256",
        label="terminal runtime lifecycle",
    )
    if (
        runtime_cleanup.get("schema_version") != "engram.closed-loop-cleanup.v2"
        or neural_cleanup.get("schema_version") != "engram.closed-loop-cleanup.v2"
        or runtime_cleanup.get("component") != "runtime"
        or runtime_cleanup.get("owner_identity_sha256")
        != terminal.get("runtime_binding_sha256")
        or runtime_cleanup.get("mode") != "finish"
        or runtime_cleanup.get("runtime_lifecycle") != lifecycle
        or runtime_cleanup.get("provider_terminal_receipt_sha256") is not None
        or runtime_cleanup.get("provider_lifecycle_receipt_sha256") is not None
        or neural_cleanup.get("component") != "neural"
        or neural_cleanup.get("owner_identity_sha256")
        != terminal.get("neural_provider_identity_sha256")
        or neural_cleanup.get("mode") != "close"
        or neural_cleanup.get("runtime_lifecycle") is not None
        or any(
            row.get("attempted") is not True
            or row.get("confirmed") is not True
            or row.get("containment_empty") is not True
            or row.get("reason_code") != "loop.completed"
            for row in (runtime_cleanup, neural_cleanup)
        )
        or lifecycle.get("termination_disposition") != "clean-exit"
        or lifecycle.get("child_reaped") is not True
        or lifecycle.get("containment_empty") is not True
        or lifecycle.get("diagnostic_stream_complete") is not True
        or lifecycle.get("private_work_directory_removed") is not True
    ):
        fail("terminal cleanup or runtime lifecycle differs")

    for field in (
        "study_definition_sha256",
        "closed_loop_definition_sha256",
        "runtime_binding_sha256",
        "runtime_adapter_configuration_sha256",
        "neural_provider_identity_sha256",
        "neural_preparation_sha256",
        "neural_session_receipt_sha256",
        "runtime_finish_sha256",
        "transcript_sha256",
    ):
        _require_sha256(terminal.get(field), f"terminal {field}")
    if (
        terminal.get("neural_durable_evidence_profile")
        != "engram.nest-closed-loop-evidence-bundle.v2"
        or terminal.get("last_verified_simulation_time_tics")
        != expected_step_count * duration
        or terminal.get("runtime_progress_disposition") != "finished-and-host-verified"
        or terminal.get("status") != "completed"
        or terminal.get("primary_reason_code") != "loop.completed"
        or terminal.get("terminal_reason_code") != "loop.completed"
        or terminal.get("cleanup_complete") is not True
        or terminal.get("simulator_only") is not True
        or terminal.get("physical_actuation") is not False
        or terminal.get("ncp_qualified") is not False
        or terminal.get("scientific_authority") is not False
        or terminal.get("is_paper_local_evidence") is not False
        or terminal.get("calibrated_posterior") is not False
    ):
        fail("terminal completion or authority state differs")
    expected_transcript = sha256(
        managed_runtime_canonical(
            {
                "domain": "engram-extension-closed-loop-transcript-v5",
                "digest_canonicalization": terminal["digest_canonicalization"],
                "planned_step_count": terminal["planned_step_count"],
                "timebase": timebase,
                "neural_preparation_sha256": terminal["neural_preparation_sha256"],
                "neural_session_receipt_sha256": terminal[
                    "neural_session_receipt_sha256"
                ],
                "neural_durable_evidence_profile": terminal[
                    "neural_durable_evidence_profile"
                ],
                "initial_snapshot_sha256": terminal["initial_snapshot_sha256"],
                "last_verified_simulation_time_tics": terminal[
                    "last_verified_simulation_time_tics"
                ],
                "runtime_progress_disposition": terminal[
                    "runtime_progress_disposition"
                ],
                "step_receipts": step_digests,
                "neural_execution_bindings": execution_digests,
                "runtime_finish_sha256": terminal["runtime_finish_sha256"],
                "runtime_lifecycle_binding_sha256": lifecycle_digest,
                "cleanup_receipts": cleanup_digests,
                "status": terminal["status"],
                "primary_reason_code": terminal["primary_reason_code"],
                "terminal_reason_code": terminal["terminal_reason_code"],
            }
        )
    )
    if terminal.get("transcript_sha256") != expected_transcript:
        fail("terminal closed-loop transcript digest differs")
    receipt_digest = assert_managed_runtime_digest(
        terminal,
        field="receipt_sha256",
        label="terminal closed-loop receipt",
    )
    assert_no_authority_escalation(terminal, "terminal closed-loop receipt")
    return {
        "receipt_sha256": receipt_digest,
        "runtime_lifecycle_sha256": lifecycle_digest,
    }


def assert_nest_work_admission(
    work_admission: Any,
    *,
    terminal: Mapping[str, Any],
    expectation: Mapping[str, Any],
    session: Mapping[str, Any],
    expected_step_count: int,
) -> str:
    """Replay deterministic NEST construction, byte, node, and work budgets."""

    work = _exact_object(
        work_admission,
        NEST_WORK_ADMISSION_KEYS,
        "NEST work admission",
    )
    digest = assert_canonical_digest(
        work,
        field="receipt_sha256",
        label="NEST work admission",
    )
    controls = session.get("control_bindings")
    populations = session.get("population_roster")
    controller_configuration = expectation.get("controller_configuration")
    if (
        not isinstance(controls, list)
        or not controls
        or not isinstance(populations, list)
        or not populations
        or not isinstance(controller_configuration, dict)
    ):
        fail("NEST work admission lacks definition-bound rosters")
    channel_count = len(controls)
    action_dimensions = sum(
        len(row.get("axis_binding_sha256s", []))
        for row in controls
        if isinstance(row, dict)
    )
    population_size = work.get("population_size")
    step_duration = work.get("step_duration_tics")
    maximum_input_rate = work.get("maximum_input_rate_hz")
    if (
        any(not isinstance(row, dict) for row in [*controls, *populations])
        or not isinstance(population_size, int)
        or isinstance(population_size, bool)
        or not 2 <= population_size <= 512
        or not isinstance(step_duration, int)
        or isinstance(step_duration, bool)
        or step_duration < 1
        or not isinstance(maximum_input_rate, (int, float))
        or isinstance(maximum_input_rate, bool)
        or not 0 <= maximum_input_rate <= 200_000
    ):
        fail("NEST work admission scalar domain differs")
    signed_populations = action_dimensions * 2
    population_neurons = signed_populations * population_size
    device_nodes = signed_populations * 2
    total_nodes = population_neurons + device_nodes
    total_connections = population_neurons * 2
    total_run_tics = step_duration * expected_step_count
    neuron_tic_work = population_neurons * total_run_tics
    input_event_work = int(
        (
            Decimal(str(maximum_input_rate))
            * Decimal(total_run_tics)
            * Decimal(population_neurons)
            / Decimal(1_000_000)
        ).to_integral_value(rounding=ROUND_CEILING)
    )
    estimated_step_bytes = (
        32 * 1024 + channel_count * 4 * 1024 + (action_dimensions * 8 * 1024)
    )
    estimated_bundle_bytes = (
        16 * 1024 * 1024
        + channel_count * 4 * 1024
        + action_dimensions * 8 * 1024
        + estimated_step_bytes * expected_step_count
    )
    estimated_step_nodes = 128 + channel_count * 42 + action_dimensions * 160
    estimated_bundle_nodes = (
        32_768
        + channel_count * 64
        + action_dimensions * 192
        + expected_step_count * (128 + channel_count * 40 + action_dimensions * 160)
    )
    expected = {
        "schema_version": "engram.nest-work-admission.v1",
        "channel_count": channel_count,
        "planned_step_count": expected_step_count,
        "action_dimension_count": action_dimensions,
        "closed_loop_definition_sha256": terminal.get("closed_loop_definition_sha256"),
        "controller_configuration_sha256": sha256(canonical(controller_configuration)),
        "expected_control_binding_sha256": session.get("control_binding_sha256"),
        "expected_population_roster_sha256": session.get("population_roster_sha256"),
        "population_size": population_size,
        "step_duration_tics": step_duration,
        "maximum_input_rate_hz": maximum_input_rate,
        "signed_population_count": signed_populations,
        "population_neuron_count": population_neurons,
        "device_node_count": device_nodes,
        "total_node_count": total_nodes,
        "total_connection_count": total_connections,
        "total_run_tics": total_run_tics,
        "neuron_tic_work_units": neuron_tic_work,
        "input_event_work_units": input_event_work,
        "byte_estimate_policy": "closed-json-upper-bound-v1",
        "estimated_step_response_bytes": estimated_step_bytes,
        "estimated_evidence_bundle_bytes": estimated_bundle_bytes,
        "node_estimate_policy": "canonical-json-node-upper-bound-v1",
        "estimated_step_response_nodes": estimated_step_nodes,
        "estimated_evidence_bundle_nodes": estimated_bundle_nodes,
        "max_total_nodes": 65_536,
        "max_total_connections": 100_000,
        "max_neuron_tic_work_units": 10_000_000_000,
        "max_input_event_work_units": 100_000_000,
        "max_step_response_bytes": 3_145_728,
        "max_evidence_bundle_bytes": 251_658_240,
        "max_step_response_nodes": 32_768,
        "max_evidence_bundle_nodes": 131_072,
        "admitted": True,
        "receipt_sha256": digest,
    }
    if work != expected:
        fail("NEST work admission arithmetic or immutable caps differ")
    if (
        total_nodes > 65_536
        or total_connections > 100_000
        or neuron_tic_work > 10_000_000_000
        or input_event_work > 100_000_000
        or estimated_step_bytes > 3_145_728
        or estimated_bundle_bytes > 251_658_240
        or estimated_step_nodes > 32_768
        or estimated_bundle_nodes > 131_072
    ):
        fail("NEST work admission exceeds its immutable budget")
    return digest


def _millisecond_tics(value: Any, label: str) -> int:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        fail(f"{label} is not one finite millisecond value")
    scaled = Decimal(str(value)) * Decimal(1_000)
    if scaled != scaled.to_integral_value():
        fail(f"{label} is not aligned to the 0.001 ms grid")
    return int(scaled)


def _effective_millisecond_tics(value: Any, label: str) -> int:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or float(value) < 0.0
    ):
        fail(f"{label} is not one finite NEST readback")
    candidate = round(float(value) / 0.001)
    if float(value) != candidate * 0.001:
        fail(f"{label} is not one canonical NEST tic readback")
    return candidate


def assert_nest_session_readback(
    session: Any,
    *,
    terminal: Mapping[str, Any],
    expectation: Mapping[str, Any],
    expected_step_count: int,
) -> dict[str, str]:
    """Replay the NEST session and its definition-bound roster digests."""

    session = _exact_object(session, NEST_SESSION_KEYS, "NEST session readback")
    digest = assert_canonical_digest(
        session,
        field="receipt_sha256",
        label="NEST session readback",
    )
    controls = session.get("control_bindings")
    populations = session.get("population_roster")
    connections = session.get("connection_readbacks")
    if (
        not isinstance(controls, list)
        or not controls
        or not isinstance(populations, list)
        or not populations
        or not isinstance(connections, list)
        or not connections
    ):
        fail("NEST session roster is absent")
    controls = [
        _exact_object(row, NEST_CONTROL_BINDING_KEYS, "NEST control binding")
        for row in controls
    ]
    populations = [
        _exact_object(
            row,
            NEURAL_POPULATION_BINDING_KEYS,
            "NEST population binding",
        )
        for row in populations
    ]
    connections = [
        _exact_object(row, NEST_CONNECTION_KEYS, "NEST connection readback")
        for row in connections
    ]
    work_digest = assert_nest_work_admission(
        session.get("work_admission"),
        terminal=terminal,
        expectation=expectation,
        session=session,
        expected_step_count=expected_step_count,
    )
    control_ids = [row.get("channel_id") for row in controls]
    population_ids = [row.get("channel_id") for row in populations]
    if (
        control_ids != sorted(control_ids)
        or len(control_ids) != len(set(control_ids))
        or population_ids != control_ids
        or any(
            not isinstance(row.get("axis_binding_sha256s"), list)
            or not row["axis_binding_sha256s"]
            or any(
                _require_sha256(value, "NEST axis binding") != value
                for value in row["axis_binding_sha256s"]
            )
            or _require_sha256(row.get("neural_codec_sha256"), "NEST neural codec")
            != row.get("neural_codec_sha256")
            for row in controls
        )
        or any(
            not isinstance(row.get("population_names"), list)
            or not row["population_names"]
            or row["population_names"] != sorted(row["population_names"])
            or len(row["population_names"]) != len(set(row["population_names"]))
            for row in populations
        )
        or any(
            len(population["population_names"])
            != 2 * len(control["axis_binding_sha256s"])
            for control, population in zip(controls, populations, strict=True)
        )
    ):
        fail("NEST session control or population roster differs")
    population_names = [name for row in populations for name in row["population_names"]]
    connection_keys = [
        (row.get("population_name"), row.get("direction")) for row in connections
    ]
    work = session["work_admission"]
    requested_delay = session.get("requested_connection_delay_tics")
    requested_receptor = session.get("requested_receptor")
    requested_input_weight = session.get("requested_input_weight")
    requested_recorder_weight = session.get("requested_recorder_weight")
    if (
        connection_keys != sorted(connection_keys)
        or len(connection_keys) != len(set(connection_keys))
        or set(row.get("population_name") for row in connections)
        != set(population_names)
        or any(
            {
                row.get("direction")
                for row in connections
                if row.get("population_name") == name
            }
            != {"input", "recorder"}
            for name in population_names
        )
        or any(
            row.get("synapse_model") != "static_synapse"
            or row.get("requested_weight")
            != (
                requested_input_weight
                if row.get("direction") == "input"
                else requested_recorder_weight
            )
            or row.get("effective_weight") != row.get("requested_weight")
            or row.get("requested_delay_tics") != requested_delay
            or _millisecond_tics(
                row.get("delay_api_argument_ms"),
                "NEST connection delay API argument",
            )
            != requested_delay
            or _effective_millisecond_tics(
                row.get("effective_delay_ms"),
                "NEST effective connection delay",
            )
            != row.get("effective_delay_tics")
            or row.get("effective_delay_tics") != requested_delay
            or row.get("requested_receptor") != requested_receptor
            or row.get("effective_receptor") != requested_receptor
            or row.get("connection_count") != work.get("population_size")
            for row in connections
        )
    ):
        fail("NEST session connection readback differs")
    model_digest = sha256(
        canonical(
            {
                "effective_model_roster": session.get("effective_model_roster"),
                "population_neuron_count": session.get(
                    "observed_population_neuron_count"
                ),
                "device_node_count": session.get("observed_device_node_count"),
            }
        )
    )
    if (
        session.get("schema_version") != "engram.nest-session-readback.v2"
        or session.get("reported_version") != "3.9.0"
        or _millisecond_tics(
            session.get("requested_resolution_ms"), "NEST requested resolution"
        )
        != session.get("requested_resolution_tics")
        or _millisecond_tics(
            session.get("resolution_api_argument_ms"), "NEST resolution API argument"
        )
        != session.get("requested_resolution_tics")
        or _effective_millisecond_tics(
            session.get("effective_resolution_ms"), "NEST effective resolution"
        )
        != session.get("effective_resolution_tics")
        or session.get("effective_resolution_tics")
        != session.get("requested_resolution_tics")
        or _millisecond_tics(
            session.get("requested_step_duration_ms"),
            "NEST requested step duration",
        )
        != session.get("requested_step_duration_tics")
        or _millisecond_tics(
            session.get("run_api_argument_ms"), "NEST run API duration"
        )
        != session.get("requested_step_duration_tics")
        or session.get("requested_rng_seed") != session.get("effective_rng_seed")
        or session.get("requested_local_num_threads") != 1
        or session.get("effective_local_num_threads") != 1
        or session.get("effective_total_num_virtual_processes") != 1
        or session.get("effective_model_roster")
        != [
            "iaf_psc_delta",
            "inhomogeneous_poisson_generator",
            "spike_recorder",
        ]
        or session.get("control_neuron_model") != "iaf_psc_delta"
        or session.get("control_neuron_refractory_period_tics") != 2_000
        or session.get("control_neuron_refractory_input") is not False
        or session.get("channel_recovery_policy")
        != "delta-current-zero-input-washout-dual-reset-v1"
        or session.get("requested_recorder_weight") != 1.0
        or session.get("requested_receptor") != 0
        or session.get("requested_connection_delay_tics")
        != session.get("requested_resolution_tics")
        or _millisecond_tics(
            session.get("connection_delay_api_argument_ms"),
            "NEST connection delay API argument",
        )
        != session.get("requested_connection_delay_tics")
        or session.get("observed_population_neuron_count")
        != work.get("population_neuron_count")
        or session.get("observed_device_node_count") != work.get("device_node_count")
        or session.get("observed_total_connection_count")
        != work.get("total_connection_count")
        or session.get("model_readback_sha256") != model_digest
        or session.get("connection_readback_sha256") != sha256(canonical(connections))
        or session.get("control_binding_sha256") != sha256(canonical(controls))
        or session.get("population_roster_sha256") != sha256(canonical(populations))
        or session.get("kernel_reset_at_admission") is not True
        or session.get("one_session") is not True
        or session.get("ncp_transport") is not False
        or session.get("loaded_bytes_attested") is not False
    ):
        fail("NEST session model, time, RNG, or roster readback differs")
    return {"receipt_sha256": digest, "work_admission_sha256": work_digest}


def _expected_module_path(module_name: str, relative_path: str) -> bool:
    if not isinstance(module_name, str) or not isinstance(relative_path, str):
        return False
    if relative_path.endswith("/__init__.py"):
        expected = relative_path[: -len("/__init__.py")].replace("/", ".")
    elif relative_path.endswith(".py"):
        expected = relative_path[:-3].replace("/", ".")
    else:
        return False
    return module_name == expected


def assert_nest_evidence_closure(
    terminal: Any,
    evidence: Any,
    *,
    expected_step_count: int,
) -> dict[str, Any]:
    """Replay one successful NEST V2 bundle and its terminal receipt."""

    terminal = _exact_object(
        terminal,
        TERMINAL_RECEIPT_KEYS,
        "terminal closed-loop receipt",
    )
    terminal_closure = assert_terminal_receipt_closure(
        terminal,
        expected_step_count=expected_step_count,
    )
    evidence = _exact_object(
        evidence,
        NEST_EVIDENCE_KEYS,
        "NEST closed-loop evidence bundle",
    )

    def required_mapping(value: Any, label: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            fail(f"{label} is not one object")
        return value

    expectation = required_mapping(
        evidence.get("runtime_launch_expectation"),
        "NEST worker launch expectation",
    )
    launch = required_mapping(
        evidence.get("worker_launch_attempt"),
        "NEST worker launch attempt",
    )
    preparation = required_mapping(
        evidence.get("preparation_attempt"),
        "NEST worker preparation attempt",
    )
    capabilities = required_mapping(
        evidence.get("child_capabilities"),
        "NEST child capabilities",
    )
    identity = required_mapping(
        evidence.get("worker_runtime_identity"),
        "NEST worker runtime identity",
    )
    child_prepared = required_mapping(
        evidence.get("child_preparation_receipt"),
        "NEST child preparation receipt",
    )
    provider_prepared = required_mapping(
        evidence.get("provider_preparation_receipt"),
        "NEST provider preparation receipt",
    )
    binding = required_mapping(
        evidence.get("worker_session_binding"),
        "NEST worker session binding",
    )
    session = required_mapping(
        evidence.get("nest_session_readback"),
        "NEST session readback",
    )
    tail = required_mapping(
        evidence.get("tail_disposition_receipt"),
        "NEST tail disposition",
    )
    lifecycle = required_mapping(
        evidence.get("worker_lifecycle_receipt"),
        "NEST worker lifecycle receipt",
    )
    executions = evidence.get("step_execution_receipts")
    attempts = evidence.get("step_attempt_receipts")
    termination_attempts = evidence.get("worker_termination_attempt_receipts")
    terminal_executions = terminal.get("neural_executions")
    cleanup = terminal.get("cleanup")
    if (
        not isinstance(executions, list)
        or not isinstance(attempts, list)
        or not isinstance(termination_attempts, list)
        or not isinstance(terminal_executions, list)
        or not isinstance(cleanup, list)
        or len(cleanup) < 2
        or len(executions) != expected_step_count
        or len(attempts) != expected_step_count
        or len(terminal_executions) != expected_step_count
    ):
        fail("NEST successful evidence receipt rosters differ")

    receipt_digest = terminal_closure["receipt_sha256"]
    bundle_digest = assert_managed_runtime_digest(
        evidence,
        field="bundle_sha256",
        label="NEST evidence bundle",
    )
    expectation_digest = assert_canonical_digest(
        expectation,
        field="receipt_sha256",
        label="NEST worker launch expectation",
    )
    launch_digest = assert_canonical_digest(
        launch,
        field="receipt_sha256",
        label="NEST worker launch attempt",
    )
    preparation_digest = assert_canonical_digest(
        preparation,
        field="receipt_sha256",
        label="NEST worker preparation attempt",
    )
    identity_digest = assert_canonical_digest(
        identity,
        field="receipt_sha256",
        label="NEST worker runtime identity",
    )
    child_prepared_digest = assert_managed_runtime_digest(
        child_prepared,
        field="receipt_sha256",
        label="NEST child preparation receipt",
    )
    provider_prepared_digest = assert_managed_runtime_digest(
        provider_prepared,
        field="receipt_sha256",
        label="NEST provider preparation receipt",
    )
    binding_digest = assert_canonical_digest(
        binding,
        field="receipt_sha256",
        label="NEST worker session binding",
    )
    session_digest = assert_canonical_digest(
        session,
        field="receipt_sha256",
        label="NEST session readback",
    )
    tail_digest = assert_canonical_digest(
        tail,
        field="receipt_sha256",
        label="NEST tail disposition",
    )
    lifecycle_digest = assert_canonical_digest(
        lifecycle,
        field="receipt_sha256",
        label="NEST worker lifecycle receipt",
    )
    session_closure = assert_nest_session_readback(
        session,
        terminal=terminal,
        expectation=expectation,
        expected_step_count=expected_step_count,
    )
    if session_closure["receipt_sha256"] != session_digest:
        fail("NEST session closure digest differs")
    if (
        evidence.get("schema_version") != "engram.nest-closed-loop-evidence-bundle.v2"
        or evidence.get("digest_canonicalization") != "engram.managed-runtime-json.v1"
        or evidence.get("profile") != "killable-nest-population-controller-v2"
        or evidence.get("worker_terminal_disposition") != "confirmed-lifecycle"
        or evidence.get("run_receipt_sha256") != receipt_digest
        or evidence.get("study_run_id") != terminal.get("study_run_id")
        or evidence.get("neural_provider_identity_sha256")
        != terminal.get("neural_provider_identity_sha256")
        or evidence.get("neural_preparation_sha256")
        != terminal.get("neural_preparation_sha256")
        or terminal.get("neural_durable_evidence_profile")
        != "engram.nest-closed-loop-evidence-bundle.v2"
        or terminal.get("status") != "completed"
        or terminal.get("cleanup_complete") is not True
    ):
        fail("NEST evidence terminal identity or completion state differs")

    runtime_files = identity.get("files")
    required_files = expectation.get("required_runtime_files")
    project_roles = [
        f"project-module:{module_name}"
        for module_name in sorted(REQUIRED_WORKER_MODULES)
    ]
    identity_roles = project_roles + [
        "nest-package-init",
        "nest-pynestkernel-native",
        "pydantic-core-native",
        "pydantic-package-init",
        "python-executable",
        "worker-source",
    ]
    required_roles = project_roles + [
        "pydantic-core-native",
        "pydantic-package-init",
        "python-executable",
        "worker-source",
    ]
    if (
        not isinstance(runtime_files, list)
        or not isinstance(required_files, list)
        or [row.get("role") for row in runtime_files if isinstance(row, dict)]
        != identity_roles
        or [row.get("role") for row in required_files if isinstance(row, dict)]
        != required_roles
        or any(not isinstance(row, dict) for row in [*runtime_files, *required_files])
        or identity.get("file_roster_sha256") != sha256(canonical(runtime_files))
        or identity.get("project_source_roster_sha256")
        != sha256(canonical(runtime_files[: len(project_roles)]))
        or expectation.get("required_runtime_file_roster_sha256")
        != sha256(canonical(required_files))
        or expectation.get("required_project_source_roster_sha256")
        != sha256(canonical(required_files[: len(project_roles)]))
        or identity.get("project_source_closure_verified") is not True
        or identity.get("external_dependency_closure_attested") is not False
        or identity.get("response_bound_loaded_bytes") is not False
        or identity.get("loaded_bytes_attested") is not False
    ):
        fail("NEST worker runtime file closure differs")
    identity_by_role = {row["role"]: row for row in runtime_files}
    if any(identity_by_role.get(row["role"]) != row for row in required_files):
        fail("NEST required runtime files differ from worker observation")
    worker_source = identity_by_role["worker-source"]
    python_executable = identity_by_role["python-executable"]
    adapter_role = (
        "project-module:backend.optimization.extension_closed_loop_nest_process"
    )
    adapter_source = identity_by_role[adapter_role]
    expected_adapter = next(
        (row for row in required_files if row.get("role") == adapter_role),
        None,
    )
    guardian_source = expectation.get("guardian_source_file")
    exec_gate_source = expectation.get("exec_gate_source_file")
    resource_limits = required_mapping(
        identity.get("resource_limits"),
        "NEST worker resource-limit receipt",
    )
    resource_limit_digest = assert_canonical_digest(
        resource_limits,
        field="receipt_sha256",
        label="NEST worker resource limits",
    )
    if (
        not isinstance(expected_adapter, dict)
        or not isinstance(guardian_source, dict)
        or not isinstance(exec_gate_source, dict)
        or expectation.get("worker_source_sha256") != worker_source.get("sha256")
        or expectation.get("python_executable_sha256")
        != python_executable.get("sha256")
        or expectation.get("adapter_source_sha256") != adapter_source.get("sha256")
        or expected_adapter != adapter_source
        or expectation.get("guardian_source_sha256") != guardian_source.get("sha256")
        or expectation.get("exec_gate_source_sha256") != exec_gate_source.get("sha256")
        or identity.get("sys_path") != expectation.get("sys_path")
        or identity.get("environment") != expectation.get("environment")
        or resource_limits.get("profile") != expectation.get("resource_limit_profile")
        or resource_limits.get("platform") != expectation.get("platform")
        or resource_limits.get("address_space_bytes")
        != expectation.get("address_space_bytes")
        or resource_limits.get("address_space_limit_enforced")
        != expectation.get("address_space_limit_enforced")
        or resource_limits.get("cpu_time_seconds")
        != expectation.get("cpu_time_seconds")
        or resource_limits.get("file_size_bytes") != expectation.get("file_size_bytes")
        or resource_limits.get("open_file_count") != expectation.get("open_file_count")
        or resource_limits.get("core_file_bytes") != expectation.get("core_file_bytes")
    ):
        fail("NEST worker runtime launch identity differs")

    if (
        preparation.get("study_run_id") != evidence.get("study_run_id")
        or preparation.get("definition_sha256")
        != terminal.get("closed_loop_definition_sha256")
        or preparation.get("outcome") != "succeeded"
        or preparation.get("phase") != "provider-prepare"
        or preparation.get("reason_code") != "neural.prepare-succeeded"
        or preparation.get("worker_request_dispatched") is not True
        or preparation.get("worker_response_observed") is not True
        or preparation.get("runtime_launch_expectation_sha256") != expectation_digest
        or preparation.get("worker_launch_attempt_sha256") != launch_digest
        or preparation.get("runtime_identity_receipt_sha256") != identity_digest
        or preparation.get("provider_preparation_receipt_sha256")
        != provider_prepared_digest
        or preparation.get("session_binding_receipt_sha256") != binding_digest
        or launch.get("launch_expectation_sha256") != expectation_digest
        or launch.get("outcome") != "succeeded"
        or launch.get("phase") != "worker-ready"
        or launch.get("reason_code") != "neural.nest-worker-launch-succeeded"
        or launch.get("guardian_started") is not True
        or launch.get("guardian_ready_observed") is not True
        or launch.get("worker_started") is not True
        or launch.get("stderr_drain_started") is not True
        or launch.get("process_group_id") != launch.get("worker_pid")
        or launch.get("guardian_pid") == launch.get("process_group_id")
        or launch.get("production_isolation") is not False
        or launch.get("scientific_authority") is not False
        or capabilities.get("schema_version")
        != "engram.closed-loop-neural-capabilities.v1"
        or capabilities.get("provider") != "engram.nest-population-controller"
        or capabilities.get("provider_identity_sha256")
        != expectation.get("expected_child_provider_identity_sha256")
        or capabilities.get("deadline_enforcement") != "cooperative-observed"
        or capabilities.get("session_model") != "one-session-named-populations"
        or capabilities.get("max_channels") != 64
        or capabilities.get("automatic_restart") is not False
        or capabilities.get("physical_actuation") is not False
        or capabilities.get("ncp_transport") is not False
        or capabilities.get("loaded_bytes_attested") is not False
        or capabilities.get("durable_evidence_profile") != "none"
    ):
        fail("NEST launch or preparation lineage differs")

    if (
        provider_prepared.get("study_run_id") != evidence.get("study_run_id")
        or provider_prepared.get("definition_sha256")
        != preparation.get("definition_sha256")
        or provider_prepared.get("provider_identity_sha256")
        != evidence.get("neural_provider_identity_sha256")
        or provider_prepared.get("provider_session_receipt_sha256") != binding_digest
        or provider_prepared_digest != evidence.get("neural_preparation_sha256")
        or child_prepared.get("study_run_id") != evidence.get("study_run_id")
        or child_prepared.get("definition_sha256")
        != preparation.get("definition_sha256")
        or child_prepared.get("provider_identity_sha256")
        != capabilities.get("provider_identity_sha256")
        or child_prepared.get("provider_session_receipt_sha256") != session_digest
        or child_prepared.get("populations") != session.get("population_roster")
        or child_prepared.get("step_duration_tics")
        != session.get("requested_step_duration_tics")
        or provider_prepared.get("step_duration_tics")
        != child_prepared.get("step_duration_tics")
        or provider_prepared.get("populations") != child_prepared.get("populations")
        or capabilities.get("declared_step_duration_tics")
        != session.get("requested_step_duration_tics")
        or binding.get("study_run_id") != evidence.get("study_run_id")
        or binding.get("parent_provider_identity_sha256")
        != evidence.get("neural_provider_identity_sha256")
        or binding.get("runtime_launch_expectation_sha256") != expectation_digest
        or binding.get("worker_launch_attempt_sha256") != launch_digest
        or binding.get("worker_source_sha256")
        != expectation.get("worker_source_sha256")
        or binding.get("guardian_source_sha256")
        != expectation.get("guardian_source_sha256")
        or binding.get("adapter_source_sha256")
        != expectation.get("adapter_source_sha256")
        or binding.get("worker_command_sha256")
        != expectation.get("worker_command_sha256")
        or binding.get("worker_runtime_identity_sha256") != identity_digest
        or binding.get("worker_project_source_roster_sha256")
        != identity.get("project_source_roster_sha256")
        or binding.get("child_provider_identity_sha256")
        != capabilities.get("provider_identity_sha256")
        or binding.get("child_capabilities_sha256") != sha256(canonical(capabilities))
        or binding.get("child_prepared_receipt_sha256") != child_prepared_digest
        or binding.get("child_session_receipt_sha256") != session_digest
        or terminal.get("neural_session_receipt_sha256") != binding_digest
        or terminal.get("timebase", {}).get("neural_step_duration_tics")
        != session.get("requested_step_duration_tics")
    ):
        fail("NEST prepared-session lineage differs")

    duration = session.get("requested_step_duration_tics")
    control_bindings = session.get("control_bindings")
    population_roster = session.get("population_roster")
    if (
        not isinstance(duration, int)
        or isinstance(duration, bool)
        or duration < 1
        or not isinstance(control_bindings, list)
        or not isinstance(population_roster, list)
    ):
        fail("NEST session timebase or identity roster differs")
    expected_inputs = [
        (
            control["channel_id"],
            action_index,
            axis_sha256,
            control["neural_codec_sha256"],
        )
        for control in control_bindings
        for action_index, axis_sha256 in enumerate(control["axis_binding_sha256s"])
    ]
    expected_channel_ids = [control["channel_id"] for control in control_bindings]
    expected_population_names = sorted(
        name
        for population in population_roster
        for name in population["population_names"]
    )
    for index, (execution, attempt, terminal_execution) in enumerate(
        zip(executions, attempts, terminal_executions, strict=True),
        start=1,
    ):
        execution = required_mapping(execution, f"NEST step {index} execution")
        attempt = required_mapping(attempt, f"NEST step {index} attempt")
        terminal_execution = required_mapping(
            terminal_execution,
            f"terminal NEST step {index} binding",
        )
        execution_digest = assert_canonical_digest(
            execution,
            field="receipt_sha256",
            label=f"NEST step {index} execution",
        )
        assert_canonical_digest(
            attempt,
            field="receipt_sha256",
            label=f"NEST step {index} attempt",
        )
        observed_inputs = [
            (
                row.get("channel_id"),
                row.get("action_index"),
                row.get("axis_binding_sha256"),
                row.get("neural_codec_sha256"),
            )
            for row in execution.get("encoded_control_inputs", [])
            if isinstance(row, dict)
        ]
        encoded_inputs = execution.get("encoded_control_inputs")
        safety_readbacks = execution.get("channel_safety_readbacks")
        event_deltas = execution.get("population_event_deltas")
        completed_windows = execution.get("completed_window_readbacks")
        schedules = execution.get("generator_schedule_readbacks")
        weights = execution.get("input_weight_readbacks")
        observed_channel_ids = [
            row.get("channel_id")
            for row in execution.get("channel_safety_readbacks", [])
            if isinstance(row, dict)
        ]
        observed_population_names = [
            row.get("population_name")
            for row in execution.get("population_event_deltas", [])
            if isinstance(row, dict)
        ]
        if any(
            not isinstance(roster, list) or not roster
            for roster in (
                encoded_inputs,
                safety_readbacks,
                event_deltas,
                completed_windows,
                schedules,
                weights,
            )
        ) or any(
            not isinstance(row, dict)
            for roster in (
                encoded_inputs,
                safety_readbacks,
                event_deltas,
                completed_windows,
                schedules,
                weights,
            )
            for row in roster
        ):
            fail(f"NEST step {index} readback roster differs")
        expected_watermark = max(
            0,
            index * duration - session.get("requested_connection_delay_tics", 0),
        )
        if (
            execution.get("schema_version") != "engram.nest-step-execution-readback.v3"
            or _millisecond_tics(
                execution.get("run_api_argument_ms"),
                f"NEST step {index} run API duration",
            )
            != duration
            or execution.get("control_encoding_sha256")
            != sha256(canonical(encoded_inputs))
            or execution.get("channel_safety_readback_sha256")
            != sha256(canonical(safety_readbacks))
            or execution.get("completed_window_readback_sha256")
            != sha256(canonical(completed_windows))
            or execution.get("generator_schedule_readback_sha256")
            != sha256(canonical(schedules))
            or execution.get("input_weight_readback_sha256")
            != sha256(canonical(weights))
            or execution.get("input_encoding_policy")
            != "constant-rate-variable-weight-v1"
            or execution.get("decoded_proposal_only") is not True
        ):
            fail(f"NEST step {index} roster digest or execution policy differs")
        for encoded in encoded_inputs:
            raw = encoded.get("raw_affine_sum")
            normalized = encoded.get("normalized_input")
            if (
                not isinstance(raw, (int, float))
                or isinstance(raw, bool)
                or not math.isfinite(float(raw))
                or normalized != max(-1.0, min(1.0, raw))
                or encoded.get("clamped") != (raw < -1.0 or raw > 1.0)
                or (
                    encoded.get("input_disposition") != "encoded-observation"
                    and (
                        raw != 0.0
                        or normalized != 0.0
                        or encoded.get("clamped") is not False
                    )
                )
            ):
                fail(f"NEST step {index} control encoding differs")
        for delta in event_deltas:
            prior = delta.get("prior_event_count")
            current = delta.get("current_event_count")
            observed_delta = delta.get("event_count_delta")
            if (
                not isinstance(prior, int)
                or isinstance(prior, bool)
                or not isinstance(current, int)
                or isinstance(current, bool)
                or not isinstance(observed_delta, int)
                or isinstance(observed_delta, bool)
                or min(prior, current, observed_delta) < 0
                or current - prior != observed_delta
            ):
                fail(f"NEST step {index} event counter differs")
        for window in completed_windows:
            if (
                window.get("current_completed_watermark_tics") != expected_watermark
                or window.get("current_completed_watermark_tics")
                - window.get("decode_window_start_tics")
                != window.get("completed_window_tics")
                or not window.get("previous_completed_watermark_tics")
                <= window.get("decode_window_start_tics")
                < window.get("current_completed_watermark_tics")
            ):
                fail(f"NEST step {index} completed-window accounting differs")
        for schedule, weight in zip(schedules, weights, strict=True):
            requested_rate = schedule.get("requested_rate_hz")
            effective_rate = schedule.get("effective_rate_hz")
            carrier_rate = weight.get("constant_generator_rate_hz")
            desired_rate = weight.get("desired_equivalent_rate_hz")
            full_weight = weight.get("configured_full_scale_weight_mv")
            requested_weight = weight.get("requested_weight_mv")
            if (
                schedule.get("generator_model") != "inhomogeneous_poisson_generator"
                or _millisecond_tics(
                    schedule.get("schedule_api_argument_ms"),
                    f"NEST step {index} generator schedule",
                )
                != schedule.get("requested_schedule_time_tics")
                or _effective_millisecond_tics(
                    schedule.get("effective_schedule_time_ms"),
                    f"NEST step {index} effective generator schedule",
                )
                != schedule.get("effective_schedule_time_tics")
                or schedule.get("effective_schedule_time_tics")
                != schedule.get("requested_schedule_time_tics")
                or effective_rate != requested_rate
                or carrier_rate != requested_rate
                or not isinstance(carrier_rate, (int, float))
                or not isinstance(desired_rate, (int, float))
                or not isinstance(full_weight, (int, float))
                or carrier_rate <= 0
                or desired_rate > carrier_rate
                or requested_weight != full_weight * desired_rate / carrier_rate
                or weight.get("effective_weight_mv") != requested_weight
                or (
                    weight.get("input_disposition") != "encoded-observation"
                    and (desired_rate != 0.0 or requested_weight != 0.0)
                )
            ):
                fail(f"NEST step {index} schedule or input weight differs")
        for safety in safety_readbacks:
            reset_required = safety.get("hold_required") is True or (
                safety.get("recovery_from_hold") is True
            )
            expected_disposition = (
                "held-neutralized"
                if safety.get("hold_required") is True
                else "recovery-washout"
                if safety.get("recovery_from_hold") is True
                else "encoded-observation"
            )
            if (
                safety.get("input_disposition") != expected_disposition
                or safety.get("population_state_reset_performed") != reset_required
                or safety.get("population_state_reset_verified") != reset_required
                or safety.get("safety_washout_performed") != reset_required
                or (
                    reset_required
                    and (
                        safety.get("post_delivery_quiescence_tics")
                        < safety.get("minimum_refractory_flush_tics")
                        or safety.get("post_delivery_quiescence_tics")
                        != safety.get("safety_interval_tics")
                        - 2 * safety.get("resolution_tics")
                        or safety.get("recorder_delivery_flush_slack_tics")
                        != safety.get("safety_interval_tics")
                        - 3 * safety.get("resolution_tics")
                    )
                )
                or (
                    not reset_required
                    and (
                        safety.get("safety_interval_tics") != 0
                        or safety.get("post_delivery_quiescence_tics") != 0
                        or safety.get("recorder_delivery_flush_slack_tics") != 0
                        or safety.get("discarded_pending_event_count") != 0
                    )
                )
            ):
                fail(f"NEST step {index} safety reset closure differs")
        expected_partial_readback = sha256(
            canonical(
                {
                    "before_biological_time_tics": attempt.get(
                        "before_biological_time_tics"
                    ),
                    "observed_after_biological_time_tics": attempt.get(
                        "observed_after_biological_time_tics"
                    ),
                    "simulation_dispatched": attempt.get("simulation_dispatched"),
                    "simulation_returned": attempt.get("simulation_returned"),
                }
            )
        )
        if (
            execution.get("step_index") != index
            or execution.get("before_biological_time_tics") != (index - 1) * duration
            or execution.get("after_biological_time_tics") != index * duration
            or execution.get("requested_run_tics") != duration
            or observed_inputs != expected_inputs
            or observed_channel_ids != expected_channel_ids
            or observed_population_names != expected_population_names
            or execution.get("scientific_authority") is not False
            or attempt.get("attempt_index") != index
            or attempt.get("step_index") != index
            or attempt.get("before_biological_time_tics") != (index - 1) * duration
            or attempt.get("observed_after_biological_time_tics") != index * duration
            or attempt.get("requested_run_tics") != duration
            or attempt.get("outcome") != "succeeded"
            or attempt.get("observation_scope") != "child-reported"
            or attempt.get("reason_code") != "neural.step-succeeded"
            or attempt.get("simulation_dispatched") is not True
            or attempt.get("simulation_returned") is not True
            or attempt.get("decoded_proposal_produced") is not True
            or attempt.get("execution_receipt_sha256") != execution_digest
            or attempt.get("partial_readback_sha256") != expected_partial_readback
            or attempt.get("scientific_authority") is not False
            or terminal_execution.get("provider_execution_scope")
            != "nest-exact-step-readback"
            or terminal_execution.get("step_index") != index
            or terminal_execution.get("provider_execution_sha256") != execution_digest
            or terminal_execution.get("neural_request_sha256")
            != attempt.get("request_sha256")
        ):
            fail(f"NEST step {index} attempt, execution, or terminal join differs")

    guardian = assert_worker_guardian_closure(evidence)
    generation_identity = (
        expectation_digest,
        launch_digest,
        expectation.get("worker_source_sha256"),
        expectation.get("guardian_source_sha256"),
        expectation.get("adapter_source_sha256"),
        expectation.get("worker_command_sha256"),
        launch.get("worker_pid"),
        launch.get("guardian_pid"),
        launch.get("process_group_id"),
        launch.get("session_id"),
    )
    lifecycle_identity = (
        lifecycle.get("runtime_launch_expectation_sha256"),
        lifecycle.get("worker_launch_attempt_sha256"),
        lifecycle.get("worker_source_sha256"),
        lifecycle.get("guardian_source_sha256"),
        lifecycle.get("adapter_source_sha256"),
        lifecycle.get("worker_command_sha256"),
        lifecycle.get("worker_pid"),
        lifecycle.get("guardian_pid"),
        lifecycle.get("process_group_id"),
        lifecycle.get("session_id"),
    )
    if (
        lifecycle_identity != generation_identity
        or lifecycle.get("runtime_identity_receipt_sha256") != identity_digest
        or lifecycle.get("resource_limit_receipt_sha256") != resource_limit_digest
        or lifecycle.get("session_binding_receipt_sha256") != binding_digest
        or lifecycle.get("termination_attempts") != termination_attempts
        or any(
            (
                row.get("runtime_launch_expectation_sha256"),
                row.get("worker_launch_attempt_sha256"),
                row.get("worker_source_sha256"),
                row.get("guardian_source_sha256"),
                row.get("adapter_source_sha256"),
                row.get("worker_command_sha256"),
                row.get("worker_pid"),
                row.get("guardian_pid"),
                row.get("process_group_id"),
                row.get("session_id"),
            )
            != generation_identity
            for row in termination_attempts
            if isinstance(row, dict)
        )
    ):
        fail("NEST worker lifecycle generation identity differs")

    neural_cleanup = required_mapping(cleanup[1], "terminal neural cleanup")
    population_tails = tail.get("population_tails")
    if isinstance(population_tails, list):
        population_tails = [
            _exact_object(
                row,
                NEST_POPULATION_TAIL_KEYS,
                "NEST population tail",
            )
            for row in population_tails
        ]
    if (
        not isinstance(population_tails, list)
        or tail.get("study_run_id") != evidence.get("study_run_id")
        or tail.get("final_biological_time_tics") != expected_step_count * duration
        or tail.get("recorder_delivery_delay_tics")
        != session.get("requested_connection_delay_tics")
        or tail.get("final_completed_watermark_tics")
        != max(
            0,
            tail.get("final_biological_time_tics", 0)
            - tail.get("recorder_delivery_delay_tics", 0),
        )
        or [
            row.get("population_name")
            for row in population_tails
            if isinstance(row, dict)
        ]
        != expected_population_names
        or any(
            not isinstance(row.get("pending_event_count"), int)
            or isinstance(row.get("pending_event_count"), bool)
            or row["pending_event_count"] < 0
            or _require_sha256(
                row.get("pending_event_times_sha256"),
                "NEST pending event-time roster",
            )
            != row.get("pending_event_times_sha256")
            for row in population_tails
        )
        or tail.get("total_pending_event_count")
        != sum(row["pending_event_count"] for row in population_tails)
        or tail.get("population_tail_roster_sha256")
        != sha256(canonical(population_tails))
        or tail.get("accounting_disposition")
        != "discarded-incomplete-recorder-delivery-tail"
        or tail.get("decoded_proposal_only") is not True
        or tail.get("proposals_used_completed_windows_only") is not True
        or tail.get("scientific_authority") is not False
        or neural_cleanup.get("component") != "neural"
        or neural_cleanup.get("confirmed") is not True
        or neural_cleanup.get("containment_empty") is not True
        or neural_cleanup.get("provider_lifecycle_receipt_sha256") != lifecycle_digest
        or neural_cleanup.get("provider_terminal_receipt_sha256") != tail_digest
        or lifecycle.get("disposition") != "clean-exit"
    ):
        fail("NEST tail or terminal cleanup lineage differs")
    assert_no_authority_escalation(evidence, "NEST closed-loop evidence bundle")
    return {
        "receipt_sha256": receipt_digest,
        "bundle_sha256": bundle_digest,
        "runtime_launch_expectation_sha256": expectation_digest,
        "worker_launch_attempt_sha256": launch_digest,
        "preparation_attempt_sha256": preparation_digest,
        "worker_runtime_identity_sha256": identity_digest,
        "worker_session_binding_sha256": binding_digest,
        "nest_session_readback_sha256": session_digest,
        "tail_disposition_sha256": tail_digest,
        "worker_lifecycle_sha256": lifecycle_digest,
        "worker_guardian_closure": guardian,
    }


def assert_receipt_store_sidecars(
    sidecars: Any,
    *,
    store_id: str,
    receipt_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
    run_plan_document: Mapping[str, Any] | None = None,
    nest_config_document: Mapping[str, Any] | None = None,
    package_generation_id: str | None = None,
    reviewed_handshake: Mapping[str, Any] | None = None,
) -> dict[str, bytes]:
    sidecars = _exact_object(
        sidecars,
        RECEIPT_STORE_SIDECAR_KEYS,
        "closed-loop receipt-store sidecars",
    )
    if sidecars.get("schema_version") != (
        "crebain.closed-loop-receipt-store-sidecars.v1"
    ):
        fail("closed-loop receipt-store sidecar schema differs")
    assert_canonical_digest(
        sidecars,
        field="closure_sha256",
        label="closed-loop receipt-store sidecars",
    )
    metadata = _exact_object(
        sidecars.get("store_metadata"),
        STORE_METADATA_KEYS,
        "closed-loop receipt-store metadata",
    )
    finalization = _exact_object(
        sidecars.get("finalized_reservation"),
        FINALIZED_RESERVATION_KEYS,
        "closed-loop finalized reservation",
    )
    reservation = _exact_object(
        finalization.get("reservation"),
        RESERVATION_KEYS,
        "closed-loop receipt reservation",
    )
    observation = _exact_object(
        sidecars.get("observation"),
        OBSERVATION_KEYS,
        "closed-loop receipt observation",
    )
    anchor = _exact_object(
        sidecars.get("publication_admission_anchor"),
        PUBLICATION_ADMISSION_ANCHOR_KEYS,
        "closed-loop publication admission anchor",
    )
    authority = _exact_object(
        sidecars.get("publication_authority"),
        PUBLICATION_AUTHORITY_KEYS,
        "closed-loop publication authority",
    )
    assert_no_authority_escalation(sidecars, "closed-loop receipt-store sidecars")
    for document, field, label in (
        (reservation, "reservation_sha256", "closed-loop receipt reservation"),
        (finalization, "finalization_sha256", "closed-loop finalized reservation"),
        (observation, "record_sha256", "closed-loop receipt observation"),
        (anchor, "anchor_sha256", "closed-loop publication admission anchor"),
        (authority, "authority_sha256", "closed-loop publication authority"),
    ):
        assert_managed_runtime_digest(document, field=field, label=label)

    receipt_artifact = dict(receipt_document)
    evidence_artifact = dict(evidence_document)
    receipt_digest = receipt_artifact.pop("receipt_sha256", None)
    evidence_digest = evidence_artifact.pop("bundle_sha256", None)
    if (
        not isinstance(receipt_digest, str)
        or not SHA256_PATTERN.fullmatch(receipt_digest)
        or sha256(managed_runtime_canonical(receipt_artifact)) != receipt_digest
        or not isinstance(evidence_digest, str)
        or not SHA256_PATTERN.fullmatch(evidence_digest)
        or sha256(managed_runtime_canonical(evidence_artifact)) != evidence_digest
    ):
        fail("receipt-store artifact digests differ from canonical material")
    study_run_id = receipt_document.get("study_run_id")
    reservation_id = reservation.get("reservation_id")
    if (
        not isinstance(study_run_id, str)
        or not isinstance(reservation_id, str)
        or re.fullmatch(r"clrr_[a-f0-9]{64}", reservation_id) is None
    ):
        fail("closed-loop receipt-store run or reservation identity differs")
    work_admission = evidence_document.get("nest_session_readback")
    work_admission = (
        work_admission.get("work_admission")
        if isinstance(work_admission, Mapping)
        else None
    )
    if not isinstance(work_admission, dict):
        fail("closed-loop receipt-store evidence lacks NEST work admission")
    runtime_lifecycle = receipt_document.get("runtime_lifecycle")
    if not isinstance(runtime_lifecycle, Mapping):
        fail("closed-loop terminal receipt lacks its runtime lifecycle")
    work_admission_sha256 = assert_canonical_digest(
        work_admission,
        field="receipt_sha256",
        label="NEST work admission",
    )
    handshake = reservation.get("reviewed_native_handshake")
    if not isinstance(handshake, dict):
        fail("closed-loop receipt reservation lacks its reviewed handshake")
    handshake_sha256 = assert_canonical_digest(
        handshake,
        field="receipt_sha256",
        label="reserved reviewed-native handshake",
    )
    if reviewed_handshake is not None and dict(reviewed_handshake) != handshake:
        fail("closed-loop receipt reservation handshake differs from capture")
    estimated_evidence_bytes = work_admission.get("estimated_evidence_bundle_bytes")
    if (
        not isinstance(estimated_evidence_bytes, int)
        or isinstance(estimated_evidence_bytes, bool)
        or estimated_evidence_bytes < 1
    ):
        fail("NEST work admission evidence capacity differs")

    simulation_dispatch_sha256 = sha256(
        managed_runtime_canonical(
            {
                "schema_version": "engram.extension-closed-loop-dispatch-intent.v1",
                "store_id": store_id,
                "reservation_id": reservation_id,
                "reservation_sha256": reservation["reservation_sha256"],
            }
        )
    )
    extension_dispatch_sha256 = sha256(
        managed_runtime_canonical(
            {
                "schema_version": (
                    "engram.extension-closed-loop-extension-dispatch-intent.v1"
                ),
                "store_id": store_id,
                "reservation_id": reservation_id,
                "pre_spawn_sha256": reservation["pre_spawn_sha256"],
            }
        )
    )
    publication_wal_sha256 = sha256(
        managed_runtime_canonical(
            {
                "domain": (
                    "engram-extension-closed-loop-reserved-publication-wal-closure-v1"
                ),
                "store_id": store_id,
                "reservation_id": reservation_id,
                "pre_spawn_sha256": reservation["pre_spawn_sha256"],
                "extension_dispatch_sha256": extension_dispatch_sha256,
                "reservation_sha256": reservation["reservation_sha256"],
                "simulation_dispatch_sha256": simulation_dispatch_sha256,
                "terminal_receipt_sha256": receipt_digest,
            }
        )
    )
    study_run_key_sha256 = sha256(
        managed_runtime_canonical(
            {
                "domain": ("engram-extension-closed-loop-publication-study-run-key-v1"),
                "store_id": store_id,
                "study_run_id": study_run_id,
            }
        )
    )
    artifact = observation.get("artifact")
    expected_receipt_path = f"receipts/{receipt_digest[:2]}/{receipt_digest}.json"
    expected_evidence_path = f"evidence/{evidence_digest[:2]}/{evidence_digest}.json"
    expected_finalization_path = (
        f"finalized-reservations/{reservation_id[5:7]}/{reservation_id}.json"
    )
    expected_observation_path = (
        f"observations/{receipt_digest[:2]}/{receipt_digest}.json"
    )
    expected_anchor_path = f"publication-admission-anchors/{study_run_key_sha256}.json"
    expected_authority_path = (
        f"publication-authorities/{receipt_digest[:2]}/{receipt_digest}.json"
    )
    if (
        metadata.get("schema_version")
        != "engram.extension-closed-loop-receipt-store.v5"
        or metadata.get("store_id") != store_id
        or metadata.get("policy")
        != "engram.extension-closed-loop-receipt-store-policy.v5"
        or metadata.get("digest_canonicalization") != "engram.managed-runtime-json.v1"
        or reservation.get("schema_version")
        != "engram.extension-closed-loop-receipt-reservation.v1"
        or reservation.get("store_id") != store_id
        or reservation.get("study_run_id") != study_run_id
        or reservation.get("closed_loop_definition_sha256")
        != receipt_document.get("closed_loop_definition_sha256")
        or work_admission.get("closed_loop_definition_sha256")
        != receipt_document.get("closed_loop_definition_sha256")
        or work_admission.get("planned_step_count")
        != receipt_document.get("planned_step_count")
        or evidence_document.get("study_run_id") != study_run_id
        or evidence_document.get("run_receipt_sha256") != receipt_digest
        or reservation.get("receipt_profile")
        != "engram.extension-closed-loop-run-receipt.v2"
        or reservation.get("evidence_profile")
        not in {
            "engram.nest-closed-loop-evidence-bundle.v2",
            "optional-engram.nest-closed-loop-evidence-bundle.v2",
        }
        or reservation.get("nest_work_admission_sha256") != work_admission_sha256
        or reservation.get("nest_configuration_sha256")
        != work_admission.get("controller_configuration_sha256")
        or reservation.get("expected_runtime_binding_sha256")
        != receipt_document.get("runtime_binding_sha256")
        or reservation.get("reviewed_native_handshake_receipt_sha256")
        != handshake_sha256
        or reservation.get("runtime_generation_id")
        != runtime_lifecycle.get("generation_id")
        or not isinstance(reservation.get("reserved_record_count"), int)
        or isinstance(reservation.get("reserved_record_count"), bool)
        or reservation.get("reserved_record_count") != 1
        or reservation.get("reserved_record_bytes") != 4096
        or reservation.get("reserved_artifact_bytes") != 16 * 1024 * 1024
        or not isinstance(reservation.get("reserved_evidence_bytes"), int)
        or isinstance(reservation.get("reserved_evidence_bytes"), bool)
        or reservation.get("reserved_evidence_bytes") != estimated_evidence_bytes
        or not isinstance(reservation.get("pre_spawn_sha256"), str)
        or not SHA256_PATTERN.fullmatch(reservation.get("pre_spawn_sha256", ""))
        or (
            package_generation_id is not None
            and reservation.get("package_generation_id") != package_generation_id
        )
        or (
            run_plan_document is not None
            and reservation.get("run_plan_sha256")
            != sha256(managed_runtime_canonical(run_plan_document))
        )
        or (
            nest_config_document is not None
            and reservation.get("nest_configuration_sha256")
            != sha256(canonical(nest_config_document))
        )
        or finalization.get("schema_version")
        != "engram.extension-closed-loop-finalized-reservation.v1"
        or finalization.get("store_id") != store_id
        or finalization.get("pre_spawn_sha256") != reservation.get("pre_spawn_sha256")
        or finalization.get("extension_dispatch_sha256") != extension_dispatch_sha256
        or finalization.get("simulation_dispatch_sha256") != simulation_dispatch_sha256
        or finalization.get("terminal_receipt_sha256") != receipt_digest
        or finalization.get("evidence_bundle_sha256") != evidence_digest
        or finalization.get("nest_work_admission_rejoined") is not True
    ):
        fail("closed-loop receipt-store reservation lineage differs")
    if (
        not isinstance(artifact, dict)
        or set(artifact) != {"artifact_id", "kind", "sha256"}
        or artifact
        != {
            "artifact_id": f"art_{receipt_digest[:32]}",
            "kind": "closed_loop_receipt",
            "sha256": receipt_digest,
        }
        or observation.get("schema_version")
        != "engram.extension-closed-loop-stored-receipt.v5"
        or observation.get("store_id") != store_id
        or observation.get("study_run_id") != study_run_id
        or observation.get("run_status") != receipt_document.get("status")
        or observation.get("terminal_reason_code")
        != receipt_document.get("terminal_reason_code")
        or observation.get("relative_artifact_path") != expected_receipt_path
        or observation.get("artifact_byte_length")
        != len(managed_runtime_canonical(receipt_artifact))
        or observation.get("evidence_profile")
        != "killable-nest-population-controller-v2"
        or observation.get("evidence_bundle_sha256") != evidence_digest
        or observation.get("relative_evidence_path") != expected_evidence_path
        or observation.get("evidence_byte_length")
        != len(managed_runtime_canonical(evidence_artifact))
        or observation.get("admission_mode") != "reserved"
        or observation.get("reservation_id") != reservation_id
        or observation.get("reservation_sha256")
        != reservation.get("reservation_sha256")
        or observation.get("reservation_finalization_sha256")
        != finalization.get("finalization_sha256")
        or observation.get("nest_work_admission_sha256") != work_admission_sha256
        or observation.get("nest_work_admission_rejoined") is not True
        or observation.get("digest_canonicalization")
        != "engram.managed-runtime-json.v1"
    ):
        fail("closed-loop receipt-store observation lineage differs")
    if (
        anchor.get("schema_version")
        != "engram.extension-closed-loop-publication-admission-anchor.v1"
        or anchor.get("store_id") != store_id
        or anchor.get("study_run_key_sha256") != study_run_key_sha256
        or anchor.get("study_run_id") != study_run_id
        or anchor.get("terminal_receipt_sha256") != receipt_digest
        or anchor.get("admission_mode") != "reserved"
        or anchor.get("publication_wal_sha256") != publication_wal_sha256
        or anchor.get("evidence_bundle_sha256") != evidence_digest
        or anchor.get("reservation_id") != reservation_id
        or anchor.get("reservation_sha256") != reservation.get("reservation_sha256")
        or anchor.get("pre_spawn_sha256") != reservation.get("pre_spawn_sha256")
        or anchor.get("extension_dispatch_sha256") != extension_dispatch_sha256
        or anchor.get("simulation_dispatch_sha256") != simulation_dispatch_sha256
        or anchor.get("reservation_finalization_sha256")
        != finalization.get("finalization_sha256")
        or authority.get("schema_version")
        != "engram.extension-closed-loop-publication-authority.v1"
        or authority.get("store_id") != store_id
        or authority.get("terminal_receipt_sha256") != receipt_digest
        or authority.get("study_run_id") != study_run_id
        or authority.get("admission_mode") != "reserved"
        or authority.get("publication_admission_anchor_sha256")
        != anchor.get("anchor_sha256")
        or authority.get("publication_wal_sha256") != publication_wal_sha256
        or authority.get("evidence_bundle_sha256") != evidence_digest
        or authority.get("reservation_id") != reservation_id
        or authority.get("reservation_sha256") != reservation.get("reservation_sha256")
        or authority.get("reservation_finalization_sha256")
        != finalization.get("finalization_sha256")
        or authority.get("nest_work_admission_sha256") != work_admission_sha256
        or observation.get("publication_authority_sha256")
        != authority.get("authority_sha256")
    ):
        fail("closed-loop receipt-store publication authority lineage differs")
    return {
        "store.json": managed_runtime_canonical(metadata),
        "writer.lock": RECEIPT_STORE_LOCK_PAYLOAD,
        expected_receipt_path: managed_runtime_canonical(receipt_artifact),
        expected_evidence_path: managed_runtime_canonical(evidence_artifact),
        expected_finalization_path: managed_runtime_canonical(finalization),
        expected_observation_path: managed_runtime_canonical(observation),
        expected_anchor_path: managed_runtime_canonical(anchor),
        expected_authority_path: managed_runtime_canonical(authority),
    }


def assert_run_summary(
    summary: Any,
    *,
    channel_count: int,
    store_id: str,
    reservation_id: str,
    receipt_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
) -> None:
    summary = _exact_object(summary, SUMMARY_KEYS, "closed-loop run summary")
    assert_no_authority_escalation(summary, "closed-loop run summary")
    steps = receipt_document.get("steps")
    if (
        summary.get("authority") is not False
        or summary.get("calibrated_posterior") is not False
        or not isinstance(summary.get("channel_count"), int)
        or isinstance(summary.get("channel_count"), bool)
        or summary.get("channel_count") != channel_count
        or not isinstance(summary.get("completed_step_count"), int)
        or isinstance(summary.get("completed_step_count"), bool)
        or summary.get("completed_step_count")
        != (len(steps) if isinstance(steps, list) else -1)
        or summary.get("evidence_bundle_sha256")
        != evidence_document.get("bundle_sha256")
        or summary.get("ncp_qualified") is not False
        or summary.get("physical_actuation") is not False
        or not isinstance(summary.get("planned_step_count"), int)
        or isinstance(summary.get("planned_step_count"), bool)
        or summary.get("planned_step_count")
        != receipt_document.get("planned_step_count")
        or summary.get("receipt_sha256") != receipt_document.get("receipt_sha256")
        or summary.get("reservation_id") != reservation_id
        or summary.get("run_status") != "completed"
        or summary.get("scientific_authority") is not False
        or summary.get("simulator_only") is not True
        or summary.get("status") != "recorded"
        or summary.get("store_id") != store_id
        or summary.get("study_run_id") != receipt_document.get("study_run_id")
        or summary.get("terminal_reason_code")
        != receipt_document.get("terminal_reason_code")
    ):
        fail("closed-loop run summary lineage or authority differs")


def collect_receipt_store_material(
    root: Path,
    *,
    store_id: str,
    receipt_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    receipt_artifact = dict(receipt_document)
    evidence_artifact = dict(evidence_document)
    receipt_digest = receipt_artifact.pop("receipt_sha256", None)
    evidence_digest = evidence_artifact.pop("bundle_sha256", None)
    if (
        not isinstance(receipt_digest, str)
        or not SHA256_PATTERN.fullmatch(receipt_digest)
        or sha256(managed_runtime_canonical(receipt_artifact)) != receipt_digest
        or not isinstance(evidence_digest, str)
        or not SHA256_PATTERN.fullmatch(evidence_digest)
        or sha256(managed_runtime_canonical(evidence_artifact)) != evidence_digest
    ):
        fail("receipt store artifact digests differ from their canonical material")
    observed_root = root.lstat()
    if (
        not stat.S_ISDIR(observed_root.st_mode)
        or observed_root.st_uid != os.geteuid()
        or observed_root.st_mode & 0o022
        or root.resolve(strict=True) != root
    ):
        fail("receipt store root is not one owner-controlled private directory")
    pending = [root]
    rows: list[dict[str, Any]] = []
    receipt_paths: list[str] = []
    evidence_paths: list[str] = []
    documents_by_schema: dict[str, dict[str, Any]] = {}
    total_bytes = 0
    while pending:
        directory = pending.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as error:
            fail(f"receipt store directory cannot be enumerated: {error}")
        for entry in entries:
            path = Path(entry.path)
            observed = entry.stat(follow_symlinks=False)
            if observed.st_uid != os.geteuid():
                fail("receipt store entry is not owner-controlled")
            if stat.S_ISDIR(observed.st_mode):
                if observed.st_mode & 0o022:
                    fail("receipt store directory is not private")
                pending.append(path)
                continue
            if (
                not stat.S_ISREG(observed.st_mode)
                or observed.st_nlink != 1
                or observed.st_size > MAX_INPUT_BYTES
            ):
                fail("receipt store contains a link or unbounded non-regular entry")
            relative = path.relative_to(root).as_posix()
            if any(
                ord(character) < 0x20 or ord(character) == 0x7F
                for character in relative
            ) or any(part in {"", ".", ".."} for part in PurePosixPath(relative).parts):
                fail("receipt store contains an unsafe relative path")
            payload = read_regular(path, MAX_INPUT_BYTES, allow_empty=True)
            total_bytes += len(payload)
            rows.append(
                {
                    "relative_path": relative,
                    "size_bytes": len(payload),
                    "sha256": sha256(payload),
                }
            )
            if path.suffix == ".json":
                document = decode_json_object(payload, f"receipt store {relative}")
                if payload != managed_runtime_canonical(document):
                    fail("receipt store JSON artifact is not canonical")
                if document == receipt_artifact:
                    receipt_paths.append(relative)
                if document == evidence_artifact:
                    evidence_paths.append(relative)
                schema_version = document.get("schema_version")
                if isinstance(schema_version, str) and schema_version in {
                    "engram.extension-closed-loop-receipt-store.v5",
                    "engram.extension-closed-loop-finalized-reservation.v1",
                    "engram.extension-closed-loop-stored-receipt.v5",
                    "engram.extension-closed-loop-publication-admission-anchor.v1",
                    "engram.extension-closed-loop-publication-authority.v1",
                }:
                    if schema_version in documents_by_schema:
                        fail("receipt store repeats a retained sidecar schema")
                    documents_by_schema[schema_version] = document
            if (
                len(rows) > MAX_RECEIPT_STORE_FILES
                or total_bytes > MAX_RECEIPT_STORE_BYTES
            ):
                fail("receipt store closure exceeds its file or byte bound")
    rows.sort(key=lambda row: row["relative_path"])
    expected_receipt_path = f"receipts/{receipt_digest[:2]}/{receipt_digest}.json"
    expected_evidence_path = f"evidence/{evidence_digest[:2]}/{evidence_digest}.json"
    by_path = {row["relative_path"]: row for row in rows}
    if (
        len(rows) != 8
        or receipt_paths != [expected_receipt_path]
        or evidence_paths != [expected_evidence_path]
        or by_path.get(expected_receipt_path, {}).get("sha256") != receipt_digest
        or by_path.get(expected_evidence_path, {}).get("sha256") != evidence_digest
        or set(documents_by_schema)
        != {
            "engram.extension-closed-loop-receipt-store.v5",
            "engram.extension-closed-loop-finalized-reservation.v1",
            "engram.extension-closed-loop-stored-receipt.v5",
            "engram.extension-closed-loop-publication-admission-anchor.v1",
            "engram.extension-closed-loop-publication-authority.v1",
        }
    ):
        fail("receipt store does not contain its exact eight-file terminal closure")
    sidecars: dict[str, Any] = {
        "schema_version": "crebain.closed-loop-receipt-store-sidecars.v1",
        "store_metadata": documents_by_schema[
            "engram.extension-closed-loop-receipt-store.v5"
        ],
        "finalized_reservation": documents_by_schema[
            "engram.extension-closed-loop-finalized-reservation.v1"
        ],
        "observation": documents_by_schema[
            "engram.extension-closed-loop-stored-receipt.v5"
        ],
        "publication_admission_anchor": documents_by_schema[
            "engram.extension-closed-loop-publication-admission-anchor.v1"
        ],
        "publication_authority": documents_by_schema[
            "engram.extension-closed-loop-publication-authority.v1"
        ],
    }
    sidecars["closure_sha256"] = sha256(canonical(sidecars))
    expected_material = assert_receipt_store_sidecars(
        sidecars,
        store_id=store_id,
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    )
    expected_rows = [
        {
            "relative_path": relative_path,
            "size_bytes": len(payload),
            "sha256": sha256(payload),
        }
        for relative_path, payload in sorted(expected_material.items())
    ]
    if rows != expected_rows:
        fail("receipt store file identities differ from retained canonical bodies")
    closure: dict[str, Any] = {
        "schema_version": "crebain.closed-loop-receipt-store-closure.v1",
        "store_id": store_id,
        "receipt_sha256": receipt_digest,
        "receipt_artifact_path": expected_receipt_path,
        "evidence_bundle_sha256": evidence_digest,
        "evidence_artifact_path": expected_evidence_path,
        "file_count": len(rows),
        "total_bytes": total_bytes,
        "files": rows,
    }
    closure["closure_sha256"] = sha256(canonical(closure))
    return closure, sidecars


def collect_receipt_store_closure(
    root: Path,
    *,
    store_id: str,
    receipt_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
) -> dict[str, Any]:
    closure, _sidecars = collect_receipt_store_material(
        root,
        store_id=store_id,
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    )
    return closure


def assert_receipt_store_reopen(
    store: Any,
    *,
    store_id: str,
    receipt_sha256: str,
    receipt_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
) -> None:
    reopened_receipt = store.open(receipt_sha256)
    reopened_evidence = store.open_evidence(receipt_sha256)
    if (
        receipt_store_identity(store) != store_id
        or reopened_evidence is None
        or model_document(reopened_receipt) != receipt_document
        or model_document(reopened_evidence) != evidence_document
    ):
        fail("receipt store semantic reopen differs before capture publication")


def build_closed_loop_namespace(
    arguments: argparse.Namespace,
    *,
    plan_path: Path,
    config_path: Path,
    store_path: Path,
    receipt_store_path: Path,
) -> Namespace:
    return Namespace(
        plan=plan_path,
        nest_config=config_path,
        store=store_path,
        receipt_store=receipt_store_path,
        receipt_lock_timeout_ms=validate_receipt_lock_timeout(
            arguments.receipt_lock_timeout_ms
        ),
        identifier=arguments.identifier,
        generation_ordinal=arguments.generation_ordinal,
        startup_timeout_ms=arguments.startup_timeout_ms,
        termination_grace_ms=arguments.termination_grace_ms,
        progress=False,
    )


def assert_reviewed_runtime_closure(
    command_binding: Mapping[str, Any],
    handshake: Mapping[str, Any],
    termination: Mapping[str, Any],
    lifecycle: Mapping[str, Any],
    reviewed_guardian_source_sha256: str,
    reviewed_exec_gate_source_sha256: str,
    worker_python_executable_sha256: str,
    installed_proof: Mapping[str, Any],
) -> dict[str, Any]:
    command_binding = _exact_object(
        command_binding,
        REVIEWED_COMMAND_BINDING_KEYS,
        "reviewed runtime contained-command binding",
    )
    handshake = _exact_object(
        handshake,
        REVIEWED_HANDSHAKE_KEYS,
        "reviewed runtime handshake receipt",
    )
    termination = _exact_object(
        termination,
        REVIEWED_TERMINATION_KEYS,
        "reviewed runtime termination receipt",
    )
    lifecycle = _exact_object(
        lifecycle,
        RUNTIME_LIFECYCLE_KEYS,
        "reviewed runtime lifecycle binding",
    )
    for document, fields, label in (
        (
            command_binding,
            (
                "python_executable_sha256",
                "exec_gate_source_sha256",
                "target_command_sha256",
                "exec_gate_command_sha256",
            ),
            "reviewed runtime contained-command binding",
        ),
        (
            handshake,
            (
                "executable_sha256",
                "validator_set_sha256",
                "host_handshake_frame_sha256",
                "runtime_handshake_frame_sha256",
                "exec_gate_source_sha256",
                "exec_gate_command_sha256",
                "guardian_source_sha256",
                "guardian_command_sha256",
                "guardian_ready_frame_sha256",
                "sandbox_profile_sha256",
                "sandbox_launcher_sha256",
                "receipt_sha256",
            ),
            "reviewed runtime handshake",
        ),
        (
            termination,
            (
                "handshake_receipt_sha256",
                "stderr_sha256",
                "receipt_sha256",
            ),
            "reviewed runtime termination",
        ),
        (
            lifecycle,
            (
                "handshake_receipt_sha256",
                "termination_receipt_sha256",
                "binding_sha256",
            ),
            "reviewed runtime lifecycle",
        ),
    ):
        for field in fields:
            _require_sha256(document.get(field), f"{label} {field}")
    for value, prefix, label in (
        (handshake.get("installation_id"), "inst_", "handshake installation"),
        (handshake.get("generation_id"), "gen_", "handshake generation"),
        (
            handshake.get("package_generation_id"),
            "pkggen_",
            "handshake package generation",
        ),
        (handshake.get("store_id"), "extstore_", "handshake store"),
        (termination.get("generation_id"), "gen_", "termination generation"),
        (lifecycle.get("generation_id"), "gen_", "lifecycle generation"),
        (
            lifecycle.get("package_generation_id"),
            "pkggen_",
            "lifecycle package generation",
        ),
        (lifecycle.get("store_id"), "extstore_", "lifecycle store"),
    ):
        if (
            not isinstance(value, str)
            or not value.startswith(prefix)
            or SHA256_PATTERN.fullmatch(value[len(prefix) :]) is None
        ):
            fail(f"reviewed runtime {label} identity differs")
    for value, minimum, maximum, label in (
        (
            handshake.get("generation_ordinal"),
            1,
            9_007_199_254_740_991,
            "generation ordinal",
        ),
        (handshake.get("process_pid"), 2, 2**63 - 1, "process PID"),
        (handshake.get("guardian_pid"), 1, 2**63 - 1, "guardian PID"),
        (handshake.get("process_group_id"), 1, 2**63 - 1, "process group"),
        (handshake.get("session_id"), 2, 2**63 - 1, "session ID"),
        (termination.get("guardian_pid"), 1, 2**63 - 1, "guardian PID"),
        (termination.get("process_group_id"), 1, 2**63 - 1, "process group"),
        (termination.get("stderr_retained_bytes"), 0, 1_048_576, "stderr bytes"),
    ):
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not minimum <= value <= maximum
        ):
            fail(f"reviewed runtime {label} differs")
    for nullable_digest, label in (
        (
            handshake.get("generation_directory_identity_sha256"),
            "handshake generation directory",
        ),
        (
            lifecycle.get("generation_directory_identity_sha256"),
            "lifecycle generation directory",
        ),
    ):
        _require_sha256(nullable_digest, f"reviewed runtime {label}")
    handshake_digest = assert_canonical_digest(
        handshake,
        field="receipt_sha256",
        label="reviewed runtime handshake receipt",
    )
    termination_digest = assert_canonical_digest(
        termination,
        field="receipt_sha256",
        label="reviewed runtime termination receipt",
    )
    lifecycle_digest = assert_managed_runtime_digest(
        lifecycle,
        field="binding_sha256",
        label="reviewed runtime lifecycle binding",
    )
    command_digest = assert_canonical_digest(
        command_binding,
        field="exec_gate_command_sha256",
        label="reviewed runtime contained-command binding",
    )
    expected_argument_shape = [
        "python",
        "-I",
        "-S",
        "-c",
        "frozen-exec-gate-source",
        "--gate-fd",
        "descriptor",
        "--ready-fd",
        "descriptor",
        "--expected-session-id",
        "supervisor-session-id",
        "target-command",
    ]
    observed_target = (
        installed_proof.get("observed_build_receipt", {})
        .get("cargo", {})
        .get("target", {})
    )
    if (
        command_binding.get("schema_version") != "engram.contained-exec-command.v1"
        or command_binding.get("argument_shape") != expected_argument_shape
        or command_binding.get("python_executable_sha256")
        != worker_python_executable_sha256
        or command_binding.get("exec_gate_source_sha256")
        != reviewed_exec_gate_source_sha256
        or handshake.get("exec_gate_source_sha256")
        != command_binding.get("exec_gate_source_sha256")
        or handshake.get("exec_gate_command_sha256") != command_digest
        or handshake.get("guardian_source_sha256") != reviewed_guardian_source_sha256
        or handshake.get("schema_version")
        != "engram.reviewed-native-development-handshake.v1"
        or handshake.get("profile") != "engram.reviewed-native-development.v1"
        or handshake.get("extension_id") != "sepahead.crebain.simulation"
        or handshake.get("extension_version") != "0.1.0"
        or handshake.get("target_id") != "macos-aarch64-darwin"
        or handshake.get("target_id") != observed_target.get("target_id")
        or handshake.get("installation_id") != installed_proof.get("installation_id")
        or handshake.get("executable_sha256")
        != installed_proof.get("executable_sha256")
        or handshake.get("process_pid") != handshake.get("process_group_id")
        or handshake.get("guardian_pid") == handshake.get("process_group_id")
        or handshake.get("handshake_transcript_accepted") is not True
        or handshake.get("child_ready_claim") is not False
        or handshake.get("host_local_admission") is not True
        or handshake.get("process_launch_performed") is not True
        or handshake.get("explicit_absolute_path_spawn") is not True
        or handshake.get("path_lookup_at_spawn") is not True
        or handshake.get("package_path_reopened_for_spawn") is not False
        or handshake.get("verified_executable_staged") is not True
        or handshake.get("staged_executable_owner_private") is not True
        or handshake.get("staged_executable_user_immutable") is not True
        or handshake.get("process_group_containment") is not True
        or handshake.get("runtime_process_group_leader") is not True
        or handshake.get("guardian_group_member") is not True
        or handshake.get("guardian_owner_loss_seal") is not True
        or handshake.get("guardian_generation_lease_retained") is not True
        or handshake.get("guardian_uncertainty_record_prepared") is not True
        or handshake.get("descendant_creation_denied") is not True
        or handshake.get("os_sandbox_enforced") is not True
        or handshake.get("network_isolation_enforced") is not True
        or handshake.get("filesystem_isolation_enforced") is not False
        or handshake.get("external_dependency_closure_attested") is not False
        or handshake.get("automatic_restart") is not False
        or handshake.get("publisher_authenticated") is not False
        or handshake.get("durable_process_launch_authority") is not False
        or handshake.get("replayable_live_launch_authority") is not False
        or handshake.get("ncp_authority") is not False
        or handshake.get("physical_authority") is not False
        or handshake.get("scientific_authority") is not False
        or termination.get("handshake_receipt_sha256") != handshake_digest
        or termination.get("schema_version")
        != "engram.reviewed-native-development-termination.v1"
        or termination.get("generation_id") != handshake.get("generation_id")
        or termination.get("guardian_pid") != handshake.get("guardian_pid")
        or termination.get("process_group_id") != handshake.get("process_group_id")
        or termination.get("disposition") != "clean-exit"
        or termination.get("reason_code") != "runtime.clean-exit"
        or termination.get("exit_code") != 0
        or termination.get("termination_signal") is not None
        or termination.get("guardian_reaped") is not True
        or termination.get("group_signal_while_guardian_unreaped") is not True
        or termination.get("direct_child_signal_while_unreaped") is not False
        or termination.get("containment_signal_scope") != "process-group"
        or termination.get("containment_seal_signal") != 9
        or termination.get("guardian_generation_lease_held_until_containment")
        is not True
        or not isinstance(termination.get("stderr_truncated"), bool)
        or termination.get("durable_process_launch_authority") is not False
        or termination.get("ncp_authority") is not False
        or termination.get("physical_authority") is not False
        or termination.get("scientific_authority") is not False
        or lifecycle.get("handshake_receipt_sha256") != handshake_digest
        or lifecycle.get("termination_receipt_sha256") != termination_digest
        or lifecycle.get("schema_version")
        != "engram.closed-loop-runtime-lifecycle-binding.v1"
        or lifecycle.get("profile") != handshake.get("profile")
        or lifecycle.get("generation_id") != handshake.get("generation_id")
        or lifecycle.get("generation_directory_identity_sha256")
        != handshake.get("generation_directory_identity_sha256")
        or lifecycle.get("launch_source") != handshake.get("launch_source")
        or lifecycle.get("store_id") != handshake.get("store_id")
        or lifecycle.get("package_generation_id")
        != handshake.get("package_generation_id")
        or lifecycle.get("package_generation_lease_retained_at_launch")
        != handshake.get("package_generation_lease_retained")
        or lifecycle.get("package_generation_lease_released")
        != termination.get("package_generation_lease_released")
        or lifecycle.get("termination_disposition") != termination.get("disposition")
        or lifecycle.get("child_reaped") != termination.get("child_reaped")
        or lifecycle.get("containment_empty") != termination.get("containment_empty")
        or lifecycle.get("diagnostic_stream_complete")
        != termination.get("diagnostic_stream_complete")
        or lifecycle.get("private_work_directory_removed")
        != termination.get("private_work_directory_removed")
        or handshake.get("launch_source") != "package-store-lease"
        or lifecycle.get("launch_source") != "package-store-lease"
        or handshake.get("store_id") != installed_proof.get("store_id")
        or lifecycle.get("store_id") != installed_proof.get("store_id")
        or handshake.get("package_generation_id")
        != installed_proof.get("package_generation_id")
        or handshake.get("package_generation_lease_retained") is not True
        or handshake.get("generation_directory_identity_sha256") is None
        or lifecycle.get("package_generation_id")
        != installed_proof.get("package_generation_id")
        or lifecycle.get("package_generation_lease_retained_at_launch") is not True
        or lifecycle.get("package_generation_lease_released") is not True
        or lifecycle.get("child_reaped") is not True
        or lifecycle.get("containment_empty") is not True
        or lifecycle.get("diagnostic_stream_complete") is not True
        or lifecycle.get("private_work_directory_removed") is not True
        or lifecycle.get("termination_disposition") != "clean-exit"
        or lifecycle.get("publisher_authenticated") is not False
        or lifecycle.get("durable_process_launch_authority") is not False
        or lifecycle.get("ncp_authority") is not False
        or lifecycle.get("physical_authority") is not False
        or lifecycle.get("scientific_authority") is not False
        or termination.get("child_reaped") is not True
        or termination.get("containment_empty") is not True
        or termination.get("diagnostic_stream_complete") is not True
        or termination.get("private_work_directory_removed") is not True
        or termination.get("package_generation_lease_released") is not True
    ):
        fail("reviewed runtime guardian or lifecycle source lineage differs")
    assert_no_authority_escalation(
        {
            "command_binding": command_binding,
            "handshake": handshake,
            "termination": termination,
            "lifecycle": lifecycle,
        },
        "reviewed runtime closure",
    )
    return {
        "exec_gate_command_binding": command_binding,
        "handshake_receipt": handshake,
        "termination_receipt": termination,
        "lifecycle_binding_sha256": lifecycle_digest,
        "guardian_closure_verified": True,
        "package_store_lineage_verified": True,
    }


def reviewed_runtime_lineage(
    session: Any,
    terminal_receipt: Mapping[str, Any],
    reviewed_guardian_source: Mapping[str, Any],
    reviewed_exec_gate_source: Mapping[str, Any],
    worker_python_executable_sha256: str,
    installed_proof: Mapping[str, Any],
) -> dict[str, Any]:
    handshake = model_document(session.handshake_receipt)
    command_binding_model = getattr(session, "exec_gate_command_binding", None)
    if command_binding_model is None:
        fail("reviewed runtime session lacks its contained-command binding")
    command_binding = model_document(command_binding_model)
    termination_model = session.termination_receipt
    if termination_model is None:
        fail("reviewed runtime session lacks its termination receipt")
    termination = model_document(termination_model)
    lifecycle = terminal_receipt.get("runtime_lifecycle")
    if not isinstance(lifecycle, dict):
        fail("terminal receipt lacks reviewed runtime lifecycle evidence")
    return assert_reviewed_runtime_closure(
        command_binding,
        handshake,
        termination,
        lifecycle,
        reviewed_guardian_source["sha256"],
        reviewed_exec_gate_source["sha256"],
        worker_python_executable_sha256,
        installed_proof,
    )


def assert_recovery(captured: list[tuple[Any, Any]], evidence: Any) -> None:
    if len(captured) != 6 or len(evidence.step_execution_receipts) != 6:
        fail("proof requires exactly six controller steps")
    for expected_step, (request, result) in enumerate(captured, start=1):
        if request.step_index != expected_step or result.step_index != expected_step:
            fail("captured controller step order drifted")
        if result.request_sha256 != request.request_sha256:
            fail("captured neural request/result lineage drifted")
        if result.provider_execution_scope != "nest-exact-step-readback":
            fail("captured neural result is not real-NEST evidence")
        execution = evidence.step_execution_receipts[expected_step - 1]
        if result.provider_execution_sha256 != execution.receipt_sha256:
            fail("captured neural result does not bind its NEST execution receipt")

    channel_ids = tuple(item.channel_id for item in captured[0][0].channels)
    if not 1 <= len(channel_ids) <= 3:
        fail("captured controller channel count is outside one through three")
    faulted_channel = channel_ids[0]
    held = captured[3][0]
    recovery = captured[4][0]
    resumed = captured[5][1]
    held_by_id = {item.channel_id: item for item in held.channels}
    recovery_by_id = {item.channel_id: item for item in recovery.channels}
    proposal_by_id = {item.channel_id: item for item in resumed.proposals}
    if not held_by_id[faulted_channel].hold_required:
        fail("scheduled fault did not cause the next host safe hold")
    if recovery_by_id[faulted_channel].hold_required:
        fail("recovery step unexpectedly retained the host hold")
    if not any(value != 0.0 for value in proposal_by_id[faulted_channel].values):
        fail("faulted channel did not resume a nonzero NEST proposal")
    for channel_id in channel_ids[1:]:
        if held_by_id[channel_id].hold_required:
            fail("scheduled fault contaminated another channel's safety input")

    held_readback = next(
        item
        for item in evidence.step_execution_receipts[3].channel_safety_readbacks
        if item.channel_id == faulted_channel
    )
    recovery_readback = next(
        item
        for item in evidence.step_execution_receipts[4].channel_safety_readbacks
        if item.channel_id == faulted_channel
    )
    if not (
        held_readback.hold_required
        and held_readback.safety_washout_performed
        and held_readback.population_state_reset_verified
    ):
        fail("NEST hold washout/reset evidence is incomplete")
    if not (
        recovery_readback.recovery_from_hold
        and recovery_readback.safety_washout_performed
        and recovery_readback.population_state_reset_verified
    ):
        fail("NEST recovery washout/reset evidence is incomplete")
    for execution in evidence.step_execution_receipts:
        for item in execution.channel_safety_readbacks[1:]:
            if item.hold_required or item.recovery_from_hold:
                fail("scheduled fault contaminated another NEST safety lane")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engram-root", type=Path, required=True)
    parser.add_argument("--engram-commit", required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--receipt-store", type=Path, required=True)
    parser.add_argument(
        "--receipt-lock-timeout-ms",
        type=int,
        default=DEFAULT_RECEIPT_LOCK_TIMEOUT_MS,
    )
    parser.add_argument("--identifier", required=True)
    parser.add_argument("--installed-proof", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--nest-config", type=Path, required=True)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--generation-ordinal", type=int, default=1)
    parser.add_argument("--startup-timeout-ms", type=int, default=30_000)
    parser.add_argument("--termination-grace-ms", type=int, default=1_000)
    return parser


def main() -> None:
    arguments = build_parser().parse_args()

    engram_root = arguments.engram_root.resolve(strict=True)
    if not engram_root.is_dir():
        fail("Engram root is not a directory")
    plan_path = absolute_without_resolving_leaf(arguments.plan)
    config_path = absolute_without_resolving_leaf(arguments.nest_config)
    store_path = arguments.store.resolve(strict=True)
    receipt_store_path = fresh_receipt_store_path(arguments.receipt_store)
    capture_path = absolute_without_resolving_leaf(arguments.capture)
    installed_proof_path = absolute_without_resolving_leaf(arguments.installed_proof)
    if capture_path.exists() or capture_path.is_symlink():
        fail("capture output already exists")
    capture_parent = capture_path.parent.resolve(strict=True)
    if capture_parent != capture_path.parent:
        fail("capture output parent must not use a symlink")
    observed_capture_parent = capture_parent.lstat()
    if (
        not stat.S_ISDIR(observed_capture_parent.st_mode)
        or observed_capture_parent.st_uid != os.geteuid()
        or observed_capture_parent.st_mode & 0o022
    ):
        fail("capture output parent is not one owner-controlled directory")

    git_before = verify_immutable_engram_checkout(
        engram_root,
        arguments.engram_commit,
    )
    plan_bytes = read_regular(plan_path, MAX_INPUT_BYTES)
    config_bytes = read_regular(config_path, MAX_INPUT_BYTES)
    plan_document = decode_json_object(plan_bytes, "run plan")
    config_document = decode_json_object(config_bytes, "NEST configuration")
    installed_proof, installed_proof_bytes = load_installed_proof(installed_proof_path)
    if installed_proof.get("package_generation_id") != arguments.identifier:
        fail("installed proof package generation differs from the requested identifier")
    verify_pack_source_lineage(installed_proof, git_before)
    validate_receipt_lock_timeout(arguments.receipt_lock_timeout_ms)

    sys.path.insert(0, str(engram_root))
    cli = importlib.import_module("scripts.engram_extension")
    host_sources_before = collect_loaded_engram_sources(engram_root, sys.modules)
    entrypoint_sources_before = collect_entrypoint_sources(engram_root)
    captured: list[tuple[Any, Any]] = []
    captured_sessions: list[Any] = []
    captured_controllers: list[Any] = []
    base_controller = cli.KillableNestPopulationController
    base_reviewed_session = cli.ReviewedNativeDevelopmentSession

    class CapturingController(base_controller):  # type: ignore[valid-type,misc]
        def __init__(self, *positional: Any, **keywords: Any) -> None:
            super().__init__(*positional, **keywords)
            captured_controllers.append(self)

        def step(self, request: Any, *, deadline_ns: int) -> Any:
            result = super().step(request, deadline_ns=deadline_ns)
            captured.append((request, result))
            return result

    class CapturingReviewedSession:
        @classmethod
        def launch_closed_loop_from_store(
            cls, *positional: Any, **keywords: Any
        ) -> Any:
            session = base_reviewed_session.launch_closed_loop_from_store(
                *positional,
                **keywords,
            )
            captured_sessions.append(session)
            return session

    with tempfile.TemporaryDirectory(prefix="crebain-real-nest-inputs-") as raw:
        private_root = Path(raw)
        os.chmod(private_root, 0o700)
        private_plan = private_root / "run-plan.json"
        private_config = private_root / "nest-config.json"
        write_new_regular(
            private_plan,
            plan_bytes,
            label="private run plan",
            fail=fail,
        )
        write_new_regular(
            private_config,
            config_bytes,
            label="private NEST configuration",
            fail=fail,
        )
        run_arguments = build_closed_loop_namespace(
            arguments,
            plan_path=private_plan,
            config_path=private_config,
            store_path=store_path,
            receipt_store_path=receipt_store_path,
        )
        setattr(cli, "KillableNestPopulationController", CapturingController)
        setattr(cli, "ReviewedNativeDevelopmentSession", CapturingReviewedSession)
        try:
            summary, return_code = cli._run_closed_loop(run_arguments)
        finally:
            setattr(cli, "KillableNestPopulationController", base_controller)
            setattr(cli, "ReviewedNativeDevelopmentSession", base_reviewed_session)
        if (
            read_regular(private_plan, MAX_INPUT_BYTES) != plan_bytes
            or read_regular(private_config, MAX_INPUT_BYTES) != config_bytes
        ):
            fail("private run inputs changed during Engram execution")

    if return_code != 0 or summary.get("run_status") != "completed":
        fail("Engram closed-loop command did not complete")
    if len(captured_sessions) != 1:
        fail("proof requires exactly one reviewed runtime session")
    if len(captured_controllers) != 1:
        fail("proof requires exactly one NEST controller session")
    receipt_store = cli.ClosedLoopReceiptStore(
        receipt_store_path,
        lock_timeout_ms=arguments.receipt_lock_timeout_ms,
    )
    receipt = receipt_store.open(summary["receipt_sha256"])
    evidence = receipt_store.open_evidence(summary["receipt_sha256"])
    if evidence is None:
        fail("real-NEST run did not persist an evidence bundle")
    if evidence.run_receipt_sha256 != receipt.receipt_sha256:
        fail("NEST evidence does not bind the terminal receipt")
    expected_results = [item.neural_result_sha256 for item in receipt.neural_executions]
    actual_results = [result.result_sha256 for _, result in captured]
    if actual_results != expected_results:
        fail("captured neural result roster differs from the terminal receipt")
    assert_recovery(captured, evidence)

    receipt_document = model_document(receipt)
    evidence_document = model_document(evidence)
    neural_step_documents = [
        {
            "request": model_document(request),
            "result": model_document(result),
        }
        for request, result in captured
    ]
    nest_evidence_closure = assert_nest_evidence_closure(
        receipt_document,
        evidence_document,
        expected_step_count=6,
    )
    assert_neural_steps_closure(
        plan_document,
        receipt_document,
        evidence_document,
        neural_step_documents,
        expected_step_count=6,
    )
    topology = assert_population_topology(
        plan_document,
        config_document,
        evidence_document,
        neural_step_documents,
    )
    worker_guardian_closure = nest_evidence_closure["worker_guardian_closure"]
    store_id = receipt_store_identity(receipt_store)
    receipt_store_closure, receipt_store_sidecars = collect_receipt_store_material(
        receipt_store_path,
        store_id=store_id,
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    )
    reviewed_guardian_source = next(
        record
        for record in entrypoint_sources_before
        if record["role"] == "reviewed-runtime-guardian"
    )
    reviewed_exec_gate_source = next(
        record
        for record in host_sources_before
        if record.get("module_name") == "backend.integrations.contained_exec_gate"
    )
    worker_python_executable = next(
        row
        for row in evidence_document["worker_runtime_identity"]["files"]
        if row.get("role") == "python-executable"
    )
    reviewed_lineage = reviewed_runtime_lineage(
        captured_sessions[0],
        receipt_document,
        reviewed_guardian_source,
        reviewed_exec_gate_source,
        worker_python_executable["sha256"],
        installed_proof,
    )
    assert_receipt_store_sidecars(
        receipt_store_sidecars,
        store_id=store_id,
        receipt_document=receipt_document,
        evidence_document=evidence_document,
        run_plan_document=plan_document,
        nest_config_document=config_document,
        package_generation_id=installed_proof["package_generation_id"],
        reviewed_handshake=reviewed_lineage["handshake_receipt"],
    )
    assert_run_summary(
        summary,
        channel_count=len(captured[0][0].channels),
        store_id=store_id,
        reservation_id=receipt_store_sidecars["finalized_reservation"]["reservation"][
            "reservation_id"
        ],
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    )
    host_sources_after = collect_loaded_engram_sources(engram_root, sys.modules)
    entrypoint_sources_after = collect_entrypoint_sources(engram_root)
    worker_sources = collect_worker_sources(engram_root, evidence_document)
    before_inventory = merge_source_inventory(
        host_sources_before,
        entrypoint_sources_before,
    )
    after_inventory = merge_source_inventory(
        host_sources_after,
        entrypoint_sources_after,
        worker_sources,
    )
    after_by_path = {record["relative_path"]: record for record in after_inventory}
    if any(
        after_by_path.get(record["relative_path"]) != record
        for record in before_inventory
    ):
        fail("Engram source closure changed after its initial import")
    verify_source_inventory(engram_root, after_inventory)
    if (
        read_regular(plan_path, MAX_INPUT_BYTES) != plan_bytes
        or read_regular(config_path, MAX_INPUT_BYTES) != config_bytes
        or read_regular(installed_proof_path, MAX_INPUT_BYTES) != installed_proof_bytes
    ):
        fail("external run inputs or installed proof changed during capture")

    git_after = verify_immutable_engram_checkout(
        engram_root,
        arguments.engram_commit,
    )
    if git_after != git_before:
        fail("Engram Git identity changed during capture")
    git_sources = bind_git_source_objects(
        engram_root,
        arguments.engram_commit,
        after_inventory,
    )
    verify_pack_source_lineage(installed_proof, git_after, git_sources)
    host_module_roster = [
        {
            "module_name": record["module_name"],
            "relative_path": record["relative_path"],
        }
        for record in host_sources_after
    ]
    worker_module_roster = [
        {
            "module_name": record["module_name"],
            "relative_path": record["relative_path"],
        }
        for record in worker_sources
        if "module_name" in record
    ]
    source_closure: dict[str, Any] = {
        "schema_version": "crebain.engram-python-source-closure.v1",
        "discovery_policy": (
            "loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1"
        ),
        "git": git_after,
        "host_modules": host_module_roster,
        "worker_project_modules": worker_module_roster,
        "worker_project_source_roster_sha256": evidence_document[
            "worker_runtime_identity"
        ]["project_source_roster_sha256"],
        "reviewed_runtime_handshake_receipt_sha256": reviewed_lineage[
            "handshake_receipt"
        ]["receipt_sha256"],
        "reviewed_runtime_guardian_source_sha256": reviewed_guardian_source["sha256"],
        "reviewed_runtime_exec_gate_source_sha256": reviewed_exec_gate_source["sha256"],
        "reviewed_runtime_exec_gate_command_sha256": reviewed_lineage[
            "exec_gate_command_binding"
        ]["exec_gate_command_sha256"],
        "exercised_entrypoints": sorted(
            (
                {"role": role, "relative_path": relative}
                for role, relative in EXERCISED_ENTRYPOINTS
            ),
            key=lambda row: (row["role"], row["relative_path"]),
        ),
        "sources": git_sources,
        "source_roster_sha256": sha256(
            b"crebain.engram-source-roster.v1\0" + canonical(git_sources)
        ),
    }
    source_closure["closure_sha256"] = sha256(canonical(source_closure))
    source_sha256 = {
        record["relative_path"]: record["sha256"] for record in git_sources
    }

    verify_source_inventory(engram_root, after_inventory)
    reopened_store = cli.ClosedLoopReceiptStore(
        receipt_store_path,
        lock_timeout_ms=arguments.receipt_lock_timeout_ms,
    )
    assert_receipt_store_reopen(
        reopened_store,
        store_id=store_id,
        receipt_sha256=receipt_document["receipt_sha256"],
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    )
    if collect_receipt_store_material(
        receipt_store_path,
        store_id=store_id,
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    ) != (receipt_store_closure, receipt_store_sidecars):
        fail("receipt store closure changed before capture publication")
    if read_regular(installed_proof_path, MAX_INPUT_BYTES) != installed_proof_bytes:
        fail("installed proof changed before capture publication")
    if (
        verify_immutable_engram_checkout(engram_root, arguments.engram_commit)
        != git_before
    ):
        fail("Engram checkout changed before capture publication")

    payload = {
        "schema_version": "crebain.real-nest-closed-loop-capture.v2",
        "engram_source_sha256": source_sha256,
        "engram_source_closure": source_closure,
        "package_generation_id": arguments.identifier,
        "installed_package_proof_exact_sha256": sha256(installed_proof_bytes),
        "installed_package_proof": installed_proof,
        "plan_exact_sha256": sha256(plan_bytes),
        "nest_config_exact_sha256": sha256(config_bytes),
        "receipt_lock_timeout_ms": arguments.receipt_lock_timeout_ms,
        "run_plan": plan_document,
        "nest_config": config_document,
        "summary": summary,
        "terminal_receipt": receipt_document,
        "reviewed_native_runtime": reviewed_lineage,
        "nest_worker_guardian_closure": worker_guardian_closure,
        "receipt_store_closure": receipt_store_closure,
        "receipt_store_sidecars": receipt_store_sidecars,
        "population_topology": topology,
        "nest_evidence_bundle": evidence_document,
        "neural_steps": neural_step_documents,
        "assertions": {
            "fault_then_next_step_hold": True,
            "nest_hold_washout_and_reset_verified": True,
            "nest_recovery_washout_and_reset_verified": True,
            "resumed_nest_proposal_nonzero": True,
            "other_channels_never_entered_safety_mode": True,
            "terminal_receipt_and_neural_result_lineage_verified": True,
            "engram_host_and_worker_source_closure_verified": True,
            "reviewed_runtime_guardian_lineage_verified": True,
            "engram_commit_equals_local_origin_main": True,
            "private_frozen_run_inputs_used": True,
            "one_nest_session_exact_6n_population_topology_verified": True,
            "nest_worker_guardian_terminal_closure_verified": True,
            "receipt_store_artifact_closure_verified": True,
            "installed_generation_seal_package_bundle_store_lineage_verified": True,
        },
        "authority": SIMULATOR_ONLY_AUTHORITY,
        "disclosure": (
            "This local capture binds installed simulator and real NEST results. "
            "It is not a signature, physical authority, or scientific validation."
        ),
    }
    assert_no_authority_escalation(payload, "real-NEST capture")
    output = managed_runtime_canonical(payload) + b"\n"
    write_new_regular(
        capture_path,
        output,
        label="real-NEST capture",
        fail=fail,
    )
    print(
        canonical(
            {
                "status": "verified",
                "capture": str(capture_path),
                "capture_sha256": sha256(output),
                "receipt_sha256": receipt.receipt_sha256,
                "evidence_bundle_sha256": summary["evidence_bundle_sha256"],
                "engram_commit": arguments.engram_commit,
                "engram_source_closure_sha256": source_closure["closure_sha256"],
                "channel_count": len(captured[0][0].channels),
            }
        ).decode("utf-8")
    )


if __name__ == "__main__":
    main()
