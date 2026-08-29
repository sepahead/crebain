#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CRATE = resolve(ROOT, 'src-tauri/crates/managed-simulation')
const INTEGRATION = resolve(ROOT, 'integrations/engram/managed-simulation')
const CONTRACTS = resolve(INTEGRATION, 'contracts')
const EVIDENCE_SCHEMAS = resolve(INTEGRATION, 'evidence-schemas')
const OPERATIONAL_EVIDENCE_RELATIVE =
  'integrations/engram/managed-simulation/operational-evidence/real-nest-3.9-v2'
const OPERATIONAL_EVIDENCE = resolve(ROOT, OPERATIONAL_EVIDENCE_RELATIVE)
const OPERATIONAL_INPUTS = resolve(INTEGRATION, 'operational-inputs/real-nest-3.9-v1')
const OPERATIONAL_PUBLICATION_NAMES = [
  'INDEX.json',
  'capture-1-drone.json',
  'capture-2-drones.json',
  'capture-3-drones.json',
]
const OPERATIONAL_PUBLICATION_PATHS = OPERATIONAL_PUBLICATION_NAMES.map(
  (name) => `${OPERATIONAL_EVIDENCE_RELATIVE}/${name}`
)
const MAX_OPERATIONAL_EVIDENCE_BYTES = 16 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const EXPECTED_CONTRACT_GATE = [
  'cargo build --locked --release --manifest-path src-tauri/Cargo.toml -p crebain-managed-simulation',
  'python3 scripts/generate-managed-simulation-transcript.py --binary src-tauri/target/release/crebain-managed-simulation --verify integrations/engram/managed-simulation/sample-transcript.json',
  'python3 scripts/test-check-installed-managed-simulation-v3.py',
  'python3 scripts/test-run-managed-simulation-real-nest-proof.py',
].join(' && ')
const BUILD_RECEIPT_KEYS = new Set([
  'schema_version',
  'repository',
  'source',
  'generator',
  'cargo',
  'output',
  'input_identity_sha256',
  'claims',
  'authority',
  'disclosure',
  'receipt_sha256',
])
const STAGE_RECEIPT_KEYS = new Set([
  'schema_version',
  'observed_build_receipt_exact_sha256',
  'observed_build_receipt_sha256',
  'crebain_commit',
  'crebain_tree',
  'origin_main',
  'target',
  'recipe_exact_sha256',
  'configuration_exact_sha256',
  'source_executable',
  'staged_executable',
  'package_inventory',
  'package_inventory_sha256',
  'authority',
  'disclosure',
  'receipt_sha256',
])
const PACK_RECEIPT_KEYS = new Set([
  'schema_version',
  'engram_repository',
  'engram_tool',
  'verification_policy',
  'operations',
  'observed_build_receipt_exact_sha256',
  'observed_build_receipt_sha256',
  'package_stage_receipt_exact_sha256',
  'package_stage_receipt_sha256',
  'seal_receipt_exact_sha256',
  'bundle_receipt_exact_sha256',
  'package_generation_id',
  'claims',
  'authority',
  'disclosure',
  'receipt_sha256',
])
const CAPTURE_V2_KEYS = new Set([
  'schema_version',
  'engram_source_sha256',
  'engram_source_closure',
  'package_generation_id',
  'installed_package_proof_exact_sha256',
  'installed_package_proof',
  'plan_exact_sha256',
  'nest_config_exact_sha256',
  'receipt_lock_timeout_ms',
  'run_plan',
  'nest_config',
  'summary',
  'terminal_receipt',
  'reviewed_native_runtime',
  'nest_worker_guardian_closure',
  'receipt_store_closure',
  'receipt_store_sidecars',
  'population_topology',
  'nest_evidence_bundle',
  'neural_steps',
  'assertions',
  'authority',
  'disclosure',
])
const SUMMARY_KEYS = new Set([
  'authority',
  'calibrated_posterior',
  'channel_count',
  'completed_step_count',
  'evidence_bundle_sha256',
  'ncp_qualified',
  'physical_actuation',
  'planned_step_count',
  'receipt_sha256',
  'reservation_id',
  'run_status',
  'scientific_authority',
  'simulator_only',
  'status',
  'store_id',
  'study_run_id',
  'terminal_reason_code',
])
const NON_AUTHORITY_FALSE_FIELDS = new Set([
  'agent_action_authority',
  'calibrated_posterior',
  'durable_process_launch_authority',
  'execution_authority',
  'is_paper_local_evidence',
  'music_transport_used',
  'ncp_authority',
  'ncp_control',
  'ncp_qualified',
  'ncp_transport',
  'ncp_transport_used',
  'physical_actuation',
  'physical_authority',
  'plant_control',
  'replayable_live_launch_authority',
  'scientific_authority',
])
const RECEIPT_STORE_LOCK_PAYLOAD = Buffer.from(
  'engram-extension-closed-loop-receipt-store-lock-v1\n'
)
const REQUIRED_HOST_MODULES = [
  'backend.core',
  'backend.core.errors',
  'backend.core.units',
  'backend.integrations',
  'backend.integrations.contained_exec_gate',
  'backend.integrations.extension_package_store',
  'backend.integrations.extension_package_v2_contract',
  'backend.integrations.managed_runtime_authoring',
  'backend.integrations.managed_runtime_contract',
  'backend.integrations.managed_runtime_json',
  'backend.integrations.managed_runtime_manager_contract',
  'backend.integrations.reviewed_native_development_session',
  'backend.integrations.reviewed_native_process_guardian',
  'backend.integrations.standard_closed_loop_simulator',
  'backend.neurocontrol',
  'backend.neurocontrol.backends',
  'backend.neurocontrol.bus',
  'backend.neurocontrol.codec',
  'backend.neurocontrol.loop',
  'backend.neurocontrol.profiles',
  'backend.neurocontrol.protocol',
  'backend.neurocontrol.service',
  'backend.neurocontrol.session',
  'backend.neurocontrol.transport',
  'backend.optimization',
  'backend.optimization.extension_closed_loop',
  'backend.optimization.extension_closed_loop_limits',
  'backend.optimization.extension_closed_loop_nest',
  'backend.optimization.extension_closed_loop_nest_evidence',
  'backend.optimization.extension_closed_loop_nest_process',
  'backend.optimization.extension_closed_loop_receipt_store',
  'backend.optimization.simulator_study_ledger',
  'backend.schemas',
  'backend.schemas.evidence',
  'backend.schemas.runtime',
  'backend.schemas.simulator_study',
  'scripts',
  'scripts.engram_extension',
]
const REQUIRED_WORKER_MODULES = [
  'backend.core',
  'backend.core.errors',
  'backend.core.units',
  'backend.integrations',
  'backend.integrations.contained_exec_gate',
  'backend.integrations.managed_runtime_contract',
  'backend.integrations.managed_runtime_json',
  'backend.integrations.managed_runtime_manager_contract',
  'backend.neurocontrol',
  'backend.neurocontrol.backends',
  'backend.neurocontrol.bus',
  'backend.neurocontrol.codec',
  'backend.neurocontrol.loop',
  'backend.neurocontrol.profiles',
  'backend.neurocontrol.protocol',
  'backend.neurocontrol.service',
  'backend.neurocontrol.session',
  'backend.neurocontrol.transport',
  'backend.optimization',
  'backend.optimization.extension_closed_loop',
  'backend.optimization.extension_closed_loop_limits',
  'backend.optimization.extension_closed_loop_nest',
  'backend.optimization.extension_closed_loop_nest_process',
  'backend.optimization.simulator_study_ledger',
  'backend.schemas',
  'backend.schemas.evidence',
  'backend.schemas.runtime',
  'backend.schemas.simulator_study',
]
const NEST_TIC_MS = 0.001
const NEST_REFRACTORY_TICS = 2000
const NEST_MAX_RECORDER_EVENTS = 65536
const NEST_MODEL_ROSTER = ['iaf_psc_delta', 'inhomogeneous_poisson_generator', 'spike_recorder']
const NEST_WORK_LIMITS = {
  max_total_nodes: 65536,
  max_total_connections: 100000,
  max_neuron_tic_work_units: 10000000000,
  max_input_event_work_units: 100000000,
  max_step_response_bytes: 3145728,
  max_evidence_bundle_bytes: 251658240,
  max_step_response_nodes: 32768,
  max_evidence_bundle_nodes: 131072,
}
const NEST_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec'
const NEST_DARWIN_SANDBOX_PROFILE =
  '(version 1)(allow default)(deny process-fork)(deny signal)' +
  '(deny process-info-pidinfo (target others))' +
  '(deny process-info-dirtycontrol (target others))'
const NEST_EVIDENCE_KEYS = new Set([
  'schema_version',
  'digest_canonicalization',
  'profile',
  'run_receipt_sha256',
  'study_run_id',
  'neural_provider_identity_sha256',
  'neural_preparation_sha256',
  'runtime_launch_expectation',
  'worker_launch_attempt',
  'preparation_attempt',
  'child_capabilities',
  'worker_runtime_identity',
  'child_preparation_receipt',
  'provider_preparation_receipt',
  'worker_session_binding',
  'nest_session_readback',
  'step_execution_receipts',
  'step_attempt_receipts',
  'tail_disposition_receipt',
  'worker_termination_attempt_receipts',
  'worker_lifecycle_receipt',
  'worker_terminal_disposition',
  'execution_authority',
  'ncp_control',
  'physical_actuation',
  'scientific_authority',
  'is_paper_local_evidence',
  'calibrated_posterior',
  'bundle_sha256',
])
const TERMINAL_RECEIPT_KEYS = new Set([
  'calibrated_posterior',
  'cleanup',
  'cleanup_complete',
  'closed_loop_definition_sha256',
  'digest_canonicalization',
  'initial_snapshot_sha256',
  'is_paper_local_evidence',
  'last_verified_simulation_time_tics',
  'ncp_qualified',
  'neural_deadline_enforcement',
  'neural_durable_evidence_profile',
  'neural_executions',
  'neural_preparation_sha256',
  'neural_provider_identity_sha256',
  'neural_session_receipt_sha256',
  'physical_actuation',
  'planned_step_count',
  'primary_reason_code',
  'receipt_sha256',
  'runtime_adapter_configuration_sha256',
  'runtime_binding_sha256',
  'runtime_deadline_enforcement',
  'runtime_finish_sha256',
  'runtime_lifecycle',
  'runtime_progress_disposition',
  'schema_version',
  'scientific_authority',
  'simulator_only',
  'status',
  'steps',
  'study_definition_sha256',
  'study_run_id',
  'terminal_reason_code',
  'timebase',
  'transcript_sha256',
])
const NEURAL_STEP_KEYS = new Set(['request', 'result'])
const NEURAL_STEP_REQUEST_KEYS = new Set([
  'channels',
  'controller_end_time_tics',
  'controller_interval_tics',
  'controller_start_time_tics',
  'neural_preparation_sha256',
  'observation_runtime_time_tics',
  'request_sha256',
  'runtime_interval_end_time_tics',
  'runtime_interval_tics',
  'schema_version',
  'source_snapshot_sha256',
  'step_id',
  'step_index',
  'study_run_id',
])
const NEURAL_INPUT_CHANNEL_KEYS = new Set([
  'channel_id',
  'fault_code',
  'hold_required',
  'observation_values',
  'subject_id',
])
const NEURAL_STEP_RESULT_KEYS = new Set([
  'controller_end_time_tics',
  'controller_start_time_tics',
  'proposals',
  'provider_execution_scope',
  'provider_execution_sha256',
  'request_sha256',
  'result_sha256',
  'schema_version',
  'step_id',
  'step_index',
  'study_run_id',
])
const NEURAL_ACTION_PROPOSAL_KEYS = new Set(['channel_id', 'source_populations', 'values'])
const REVIEWED_COMMAND_BINDING_KEYS = new Set([
  'argument_shape',
  'exec_gate_command_sha256',
  'exec_gate_source_sha256',
  'python_executable_sha256',
  'schema_version',
  'target_command_sha256',
])
const REVIEWED_HANDSHAKE_KEYS = new Set([
  'automatic_restart',
  'child_ready_claim',
  'descendant_creation_denied',
  'durable_process_launch_authority',
  'exec_gate_command_sha256',
  'exec_gate_source_sha256',
  'executable_sha256',
  'explicit_absolute_path_spawn',
  'extension_id',
  'extension_version',
  'external_dependency_closure_attested',
  'filesystem_isolation_enforced',
  'generation_directory_identity_sha256',
  'generation_id',
  'generation_ordinal',
  'guardian_command_sha256',
  'guardian_generation_lease_retained',
  'guardian_group_member',
  'guardian_owner_loss_seal',
  'guardian_pid',
  'guardian_ready_frame_sha256',
  'guardian_source_sha256',
  'guardian_uncertainty_record_prepared',
  'handshake_transcript_accepted',
  'host_handshake_frame_sha256',
  'host_local_admission',
  'installation_id',
  'launch_source',
  'ncp_authority',
  'network_isolation_enforced',
  'os_sandbox_enforced',
  'package_generation_id',
  'package_generation_lease_retained',
  'package_path_reopened_for_spawn',
  'path_lookup_at_spawn',
  'physical_authority',
  'process_group_containment',
  'process_group_id',
  'process_launch_performed',
  'process_pid',
  'profile',
  'publisher_authenticated',
  'receipt_sha256',
  'replayable_live_launch_authority',
  'runtime_handshake_frame_sha256',
  'runtime_process_group_leader',
  'sandbox_launcher_sha256',
  'sandbox_profile_sha256',
  'schema_version',
  'scientific_authority',
  'session_id',
  'staged_executable_owner_private',
  'staged_executable_user_immutable',
  'store_id',
  'target_id',
  'validator_set_sha256',
  'verified_executable_staged',
])
const REVIEWED_TERMINATION_KEYS = new Set([
  'child_reaped',
  'containment_empty',
  'containment_seal_signal',
  'containment_signal_scope',
  'diagnostic_stream_complete',
  'direct_child_signal_while_unreaped',
  'disposition',
  'durable_process_launch_authority',
  'exit_code',
  'generation_id',
  'group_signal_while_guardian_unreaped',
  'guardian_generation_lease_held_until_containment',
  'guardian_pid',
  'guardian_reaped',
  'handshake_receipt_sha256',
  'ncp_authority',
  'package_generation_lease_released',
  'physical_authority',
  'private_work_directory_removed',
  'process_group_id',
  'reason_code',
  'receipt_sha256',
  'schema_version',
  'scientific_authority',
  'stderr_retained_bytes',
  'stderr_sha256',
  'stderr_truncated',
  'termination_signal',
])
const RUNTIME_LIFECYCLE_KEYS = new Set([
  'binding_sha256',
  'child_reaped',
  'containment_empty',
  'diagnostic_stream_complete',
  'durable_process_launch_authority',
  'generation_directory_identity_sha256',
  'generation_id',
  'handshake_receipt_sha256',
  'launch_source',
  'ncp_authority',
  'package_generation_id',
  'package_generation_lease_released',
  'package_generation_lease_retained_at_launch',
  'physical_authority',
  'private_work_directory_removed',
  'profile',
  'publisher_authenticated',
  'schema_version',
  'scientific_authority',
  'store_id',
  'termination_disposition',
  'termination_receipt_sha256',
])
const EXERCISED_ENTRYPOINTS = [
  {
    role: 'nest-guardian',
    relative_path: 'backend/optimization/extension_closed_loop_nest_guardian.py',
  },
  {
    role: 'nest-worker',
    relative_path: 'backend/optimization/extension_closed_loop_nest_worker.py',
  },
  {
    role: 'reviewed-runtime-guardian',
    relative_path: 'backend/integrations/reviewed_native_process_guardian.py',
  },
]
const CAPTURE_ROW_V2_KEYS = new Set([
  'drone_count',
  'path',
  'capture_sha256',
  'plan_exact_sha256',
  'receipt_sha256',
  'evidence_bundle_sha256',
  'receipt_store_id',
  'receipt_store_closure_sha256',
  'engram_source_closure_sha256',
  'engram_source_roster_sha256',
  'observed_build_receipt_exact_sha256',
  'population_count',
  'population_neuron_count',
  'device_node_count',
  'connection_count',
  'session_count',
])
const INSTALLED_PROOF_V3_KEYS = new Set([
  'schema_version',
  'observed_build_receipt_exact_sha256',
  'observed_build_receipt_sha256',
  'observed_build_receipt',
  'package_stage_receipt_exact_sha256',
  'package_stage_receipt_sha256',
  'package_stage_receipt',
  'engram_pack_receipt_exact_sha256',
  'engram_pack_receipt_sha256',
  'engram_pack_receipt',
  'crebain_commit',
  'crebain_tree',
  'crebain_origin_main',
  'engram_commit',
  'engram_tree',
  'engram_origin_main',
  'engram_extension_tool_sha256',
  'engram_extension_tool_git_blob',
  'build_source_roster_sha256',
  'build_input_identity_sha256',
  'executable_format',
  'executable_architecture',
  'store_id',
  'package_generation_id',
  'installation_id',
  'generation_core_sha256',
  'bundle_receipt_exact_sha256',
  'seal_receipt_exact_sha256',
  'install_observation_exact_sha256',
  'manifest_exact_sha256',
  'package_lock_exact_sha256',
  'configuration_exact_sha256',
  'package_sha256',
  'executable_sha256',
  'configuration_canonical_sha256',
  'operation_roster_sha256',
  'operation_ids',
  'standard_schema_sha256',
  'drone_counts',
  'step_count',
  'fault_step',
  'fault',
  'host_policy',
  'recovery_controls_sha256',
  'baseline_three_controls_sha256',
  'replay_exact',
  'unaffected_lane_observations_exact',
  'negative_clock_gate',
  'signal_cancellation_gate',
  'installed_artifacts_reverified_after_execution',
  'generation_seal_package_bundle_store_lineage_verified',
  'build_stage_seal_install_lineage_verified',
  'build_stage_seal_pack_install_lineage_verified',
  'authority',
  'disclosure',
  'receipt_sha256',
])
const SIMULATOR_ONLY_AUTHORITY = {
  simulator_only: true,
  ncp_qualified: false,
  physical_actuation: false,
  plant_control: false,
  scientific_authority: false,
}
const BUILD_NO_AUTHORITY = {
  execution: false,
  installation: false,
  ncp: false,
  physical: false,
  plant: false,
  scientific: false,
}
const BUILD_TARGET = {
  target_id: 'macos-aarch64-darwin',
  operating_system: 'macos',
  architecture: 'aarch64',
  abi: 'darwin',
  rust_target_triple: 'aarch64-apple-darwin',
}
const EXACT_BUILD_ARGV = [
  'rustup',
  'run',
  '1.91.1',
  'cargo',
  'build',
  '--locked',
  '--release',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '-p',
  'crebain-managed-simulation',
  '--target',
  'aarch64-apple-darwin',
  '--target-dir',
  'src-tauri/target/managed-simulation-bootstrap/observed-build-target',
]
const BUILD_CONTRACT_PATHS = [
  'integrations/engram/managed-simulation/contracts/configuration.schema.json',
  'integrations/engram/managed-simulation/contracts/finish-request.schema.json',
  'integrations/engram/managed-simulation/contracts/finish-response.schema.json',
  'integrations/engram/managed-simulation/contracts/managed-runtime-ipc.schema.json',
  'integrations/engram/managed-simulation/contracts/prepare-request.schema.json',
  'integrations/engram/managed-simulation/contracts/prepare-response.schema.json',
  'integrations/engram/managed-simulation/contracts/standard-v3-finish-request.schema.json',
  'integrations/engram/managed-simulation/contracts/standard-v3-finish-response.schema.json',
  'integrations/engram/managed-simulation/contracts/standard-v3-prepare-request.schema.json',
  'integrations/engram/managed-simulation/contracts/standard-v3-prepare-response.schema.json',
  'integrations/engram/managed-simulation/contracts/standard-v3-step-request.schema.json',
  'integrations/engram/managed-simulation/contracts/standard-v3-step-response.schema.json',
  'integrations/engram/managed-simulation/contracts/step-request.schema.json',
  'integrations/engram/managed-simulation/contracts/step-response.schema.json',
]
const TOOL_SOURCE_ROLES = new Map([
  ['scripts/managed_simulation_authoring_files.py', 'atomic-authoring-io'],
  ['scripts/managed_simulation_build_provenance.py', 'receipt-validator'],
  ['scripts/run-managed-simulation-real-nest-proof.py', 'capture-runner'],
  ['scripts/run-managed-simulation-real-nest-suite.py', 'suite-runner'],
])
const EXPECTED_DEPENDENCIES = new Set([
  'log',
  'nalgebra',
  'rand',
  'rand_distr',
  'serde',
  'serde_json',
  'sha2',
  'thiserror',
])
const EXPECTED_SOURCE_INCLUDES = new Set([
  '../../../src/pid_observation.rs',
  '../../../src/sensor_fusion.rs',
])
const EXPECTED_MANIFEST_AUTHORITY = {
  physical_actuation: false,
  plant_control: false,
  agent_direct_execution: false,
  scientific_authority: false,
  is_paper_local_evidence: false,
  calibrated_posterior: false,
}
const EXPECTED_RUNTIME_CONFIGURATION = {
  catalog_id: 'sepahead.crebain.simulation.configuration.v1',
  schema: {
    schema_id: 'crebain.simulation.configuration.v1',
    schema_sha256: '425195af335d2131744f65d14b4713b1b2fcc6e55ea44f885e720172acdb7551',
  },
  max_bytes: 4096,
}
const EXPECTED_RUNTIME_TRANSPORT = {
  kind: 'inherited-private-pipes',
  framing: 'uint32-be-length-prefixed-json',
  contract: {
    schema_id: 'engram.managed-runtime-ipc.v1',
    schema_sha256: 'e6950a2b3d1913ebacb82823afe648538ec789fe845ed3894b2122dd9864cfc1',
  },
  host_to_runtime: 'inherited-read-pipe',
  runtime_to_host: 'inherited-write-pipe',
  diagnostics: 'bounded-inherited-write-pipe',
  descriptor_inheritance: 'explicit-private-only',
}
const EXPECTED_RUNTIME_LIFECYCLE = {
  control_plane: 'host-manager-only',
  readiness_authority: 'host-manager-only',
  ipc_lifecycle_messages_enabled: false,
  startup_timeout_ms: 10000,
  handshake_timeout_ms: 5000,
  shutdown_timeout_ms: 3000,
  kill_timeout_ms: 1000,
  max_generation_lifetime_ms: 7200000,
}
const EXPECTED_RESTART_POLICY = {
  mode: 'bounded',
  max_restarts: 0,
  window_ms: 60000,
  backoff_ms: 1000,
  healthy_reset_ms: 120000,
  on_exhaustion: 'stop',
}
const EXPECTED_RUNTIME_RESOURCES = {
  max_frame_bytes: 65536,
  max_inflight_operations: 1,
  max_operations_per_generation: 1026,
  max_operation_timeout_ms: 5000,
  max_memory_bytes: 268435456,
  max_cpu_time_ms: 600000,
  max_diagnostic_bytes: 1048576,
  max_artifact_bytes: 0,
  max_processes: 1,
}
const EXPECTED_REVIEWED_PACKAGE_TEMPLATE = {
  lock_schema: 'engram.extension-package-lock.v1',
  target_id: 'macos-aarch64-darwin',
  lock_sha256: '0'.repeat(64),
  package_sha256: '0'.repeat(64),
  executable_catalog_id: 'sepahead.crebain.simulation.runtime.v1',
}
const FORBIDDEN_CODE = [
  /\bCommand\b/u,
  /\bOpenOptions\b/u,
  /\bTcpListener\b/u,
  /\bTcpStream\b/u,
  /\bUdpSocket\b/u,
  /\bUnixDatagram\b/u,
  /\bUnixListener\b/u,
  /\bUnixStream\b/u,
  /\bstd\s*::\s*fs\b/u,
  /\bstd\s*::\s*net\b/u,
  /\bstd\s*::\s*os\b/u,
  /\buse\s+(?:::)?std\s+as\b/u,
  /\bstd\s*::\s*\{[^}]*\b(?:fs|net|os)\b/u,
  /\btauri\b/u,
  /\btokio\b/u,
  /\bunsafe\b/u,
  /\bzenoh\b/u,
]
const EXPECTED_SCHEMA_HASHES = {
  'configuration.schema.json': '425195af335d2131744f65d14b4713b1b2fcc6e55ea44f885e720172acdb7551',
  'finish-request.schema.json': 'f3f75a568edb56fdc1407ad7054307e86e6db6cac2e1de21b3a688a20c70779e',
  'finish-response.schema.json': 'b2974cbbcff36925d809633ecaaaff458de93604e23c121d55c8e79df075a0eb',
  'managed-runtime-ipc.schema.json':
    'e6950a2b3d1913ebacb82823afe648538ec789fe845ed3894b2122dd9864cfc1',
  'prepare-request.schema.json': '75c90fa40cf5e3b82d6b95485df5a6fb8acd5ba7bca5a7d4ddb71c164d79fea8',
  'prepare-response.schema.json':
    '0fe1cdf62b6dcd0179c54d386b904458c7dce49629d5a60605a7a1e4052ae136',
  'audit-standard-v1-finish-request.schema.json':
    'a011368a61d81337be087e1d84550662a6ee0154873740797fe7ffe079eac275',
  'audit-standard-v1-finish-response.schema.json':
    'ce76959e62d7f36fc7e4a9e412190b7f7b68d135d1180656f4035ced77a52a08',
  'audit-standard-v1-prepare-request.schema.json':
    '9dd97ed67aa19b250a87f0b55c217f7049df14509e60c8eb7119e3363ef69805',
  'audit-standard-v1-prepare-response.schema.json':
    '536a8471c353f3e2b00147ffddc3b3ba179f1b9b4d70fe96c1718e13bb800024',
  'audit-standard-v1-step-request.schema.json':
    '9e23d6d8176d4f01bc0a18de04fdcc23a05828111212752bf47fa72f21308d08',
  'audit-standard-v1-step-response.schema.json':
    '56a3aa3f652096bd8fb4386815d98f8b521a68efa96ea230ee59a2d9e68e29bd',
  'audit-standard-v2-finish-request.schema.json':
    '580e6dc92a71ab13f0757c524d537cf55598ec1b9d39eef0038d258f4d54f070',
  'audit-standard-v2-finish-response.schema.json':
    '30e0297c95ef6aa0de3be99464336f34f2386023b660e4c9aa65ce33e5c280ee',
  'audit-standard-v2-prepare-request.schema.json':
    'c667636779dc157d636569cff364da379a923e4286fc6d54b57552f25c5b76b8',
  'audit-standard-v2-prepare-response.schema.json':
    '8e540cceb669fac3657a9cf0227693a0258e59eb785a6d1a06321caf14cc18f2',
  'audit-standard-v2-step-request.schema.json':
    'a435cb8f079343ad53f0271315b84a7e2651b8ab9c89e7301a90608912a67b50',
  'audit-standard-v2-step-response.schema.json':
    '64827ec1243d5d122870ece8930e9593d4933f104630fc95d4ca26d35c6e4112',
  'standard-v3-finish-request.schema.json':
    '486d0b94e229000b03eec04b0c6e05e6b01c9be1df1090d1c58c27bf14b09880',
  'standard-v3-finish-response.schema.json':
    'abf670d295150b6f20d088aa88365e98f73fa4d0042859f7aa5d7a2403a45d9e',
  'standard-v3-prepare-request.schema.json':
    'a5376511d1ba2edeef1b144074423bafc9fd88562893e3f2a4bba9718fc67e34',
  'standard-v3-prepare-response.schema.json':
    '06fd034822ae82e164d2c14be034e0286b4f02d1345be076affebdd84fa5348a',
  'standard-v3-step-request.schema.json':
    'aafb7c6574e83ba386acb4c10b81e5f9f4c1669e6b79208d86701b06fa473bb2',
  'standard-v3-step-response.schema.json':
    'bac8b67dcd19fbd7addbf825cb1f3b1bf796fe28f638a84380bf906b32fcdb39',
  'step-request.schema.json': 'f676c372f36e850c4d2315434740f10356d17c02aba690ef83665d96f5aa5120',
  'step-response.schema.json': 'dc086ee3a1406abf5396112ac7880bdc8c64a63163f630a25f22239f9af8a5da',
}
const ENGRAM_CONTRACT_SCHEMA_IDS = new Map([
  ['managed-runtime-ipc.schema.json', 'engram.managed-runtime-ipc.v1'],
  ...[1, 2, 3].flatMap((version) =>
    ['finish', 'prepare', 'step'].flatMap((operation) =>
      ['request', 'response'].map((direction) => [
        `${version < 3 ? 'audit-standard' : 'standard'}-v${version}-${operation}-${direction}.schema.json`,
        `engram.closed-loop-simulator.${operation}-${direction}.v${version}`,
      ])
    )
  ),
])
const EXPECTED_ROSTER_HASH = '8e883db32c7cc01ab0913aa95d9f1730aa02c28b46709f130d1eb86a81c0503d'
const EXPECTED_DIFFERENTIAL_HASHES = {
  'engram.managed-runtime-finite-float.v1.json':
    '245274905d9ac3cf8567bfdde5e2e8e3bd59be474c228b0cd7146d17feaa8a9b',
  'finite-float-differential.provenance.json':
    '02b75cc275ac2b8dd9eb53667d6c6f3826f30591627cffb484601ec7d4db9b29',
}
const EXPECTED_SAFE_PATH_PATTERN = String.raw`^(?!/)(?!.*(?:^|/)\.\.?(?:/|$))(?!.*//)(?!.*\\)[^\u0000-\u001f\u007f]+$`
const ENGRAM_CONTRACT_SOURCE = Object.freeze({
  repository: 'https://github.com/sepahead/Paper2Brain.git',
  commit: 'b6dcbd1ae853e23ce99309198050b8bd06e40829',
  tree: 'aa848d795bea9145983ea8320a10d5e3d8f621e5',
  origin_main: 'b6dcbd1ae853e23ce99309198050b8bd06e40829',
  object_format: 'sha1',
  clean: true,
})
const EXPECTED_CONTRACT_PROVENANCE_SHA256 =
  '7d1781de1351d68ecd37b1aa57bfcd86c6cd8d95cd0656327c769ceed8f36d33'
const ENGRAM_RUNTIME_RECEIPT_SCHEMAS = new Map([
  [
    'engram.closed-loop-runtime-lifecycle-binding.v1.schema.json',
    {
      sha256: 'ae3efa655bde0852cf388e9a029cfa63c2013c6ea75e0285952c95f8ac5b74f5',
      gitBlob: 'd393ac9bcb6d21147edf59d6848914a2dd179bb5',
      sizeBytes: 4399,
    },
  ],
  [
    'engram.contained-exec-command.v1.schema.json',
    {
      sha256: 'e47a78f158166b2a36517195049bc2563da9211740e4e97308178df43c09edd0',
      gitBlob: '0d26ec153e83f470ec39e5bdc543e2298310cd69',
      sizeBytes: 2465,
    },
  ],
  [
    'engram.extension-closed-loop-run-receipt.v2.schema.json',
    {
      sha256: '5bc14fd70ad6daac3479bcd65354812ddca35b172de1147ad56521dbe1d63341',
      gitBlob: 'bf8de46b865a49eec674290b12713fe9f44e546f',
      sizeBytes: 22943,
    },
  ],
  [
    'engram.nest-closed-loop-evidence-bundle.v2.schema.json',
    {
      sha256: '2da4580e21fcc7ed1cabe740435b70ad594aa16c063fccc215bc4890072d1b34',
      gitBlob: '76a4d89ea787e8f1a0dcd6a9dc3ff086f8554e3a',
      sizeBytes: 106590,
    },
  ],
  [
    'engram.reviewed-native-development-handshake.v1.schema.json',
    {
      sha256: '1625cc287f5cf676e653f3c3641dee1a19372619c737255442cb142c1f251bd0',
      gitBlob: 'a17dd33456ee4db09ecb256d8fc2d517d9ac87f2',
      sizeBytes: 10512,
    },
  ],
  [
    'engram.reviewed-native-development-termination.v1.schema.json',
    {
      sha256: '442198a83546fe163f3098b9a9cf017bdcf4e5e8f2223f64ffaa3335e3164783',
      gitBlob: 'c45b32bbf4cfcc38404174f630b6244747b77916',
      sizeBytes: 5097,
    },
  ],
])
const EXPECTED_RUNTIME_RECEIPT_PROVENANCE_SHA256 =
  '45c4bd2f1d64aa8552403056fbf5933c58ae764dada91e7da11f6f21c1bca5b1'
const EXPECTED_EVIDENCE_SCHEMA_HASHES = {
  ...Object.fromEntries(
    [...ENGRAM_RUNTIME_RECEIPT_SCHEMAS].map(([name, identity]) => [name, identity.sha256])
  ),
  'engram-pack-receipt.v1.schema.json':
    '6a2f7a72ae29033ca53d45f6345913bb7294ea89be2d9668882c60d65ee49500',
  'installed-binary-proof.v3.schema.json':
    'c04b958cf4af85bed91c225767b27484c8791378efb60eec27a10111c298a0c4',
  'observed-build-receipt.v1.schema.json':
    '6f0f40444b3bbfbce642cb1766f05d0d55a741df6dbd9e7fe199784488ac06e0',
  'package-stage-receipt.v1.schema.json':
    'c0c6d3d9615d87b320da4220c3e0da5d3a355889d1aacd8e1751dc75a596cfed',
  'real-nest-capture.v2.schema.json':
    'ab93d8e2355a75fe5f77a72d0d431c8555831359195ab890f76567af59280675',
  'real-nest-evidence-index.v2.schema.json':
    '6bb49f74559dbacc6b41a30541e470bd320adf6da455186569275a17e829f478',
}
function fail(message) {
  throw new Error(`Managed simulation boundary check failed: ${message}`)
}

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

const MANAGED_RUNTIME_NUMBER_LEXEMES = Symbol('managed-runtime-number-lexemes')

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  fail('fixture contains a non-JSON value')
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0))
  const rightPoints = [...right].map((character) => character.codePointAt(0))
  const commonLength = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < commonLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}

export function managedRuntimeFloatText(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1e300 ||
    Object.is(value, -0)
  ) {
    fail('managed-runtime float exceeds the portable finite range')
  }
  const negative = value < 0
  const source = Math.abs(value).toString().toLowerCase()
  let digits
  let decimalPoint
  if (source.includes('e')) {
    const [mantissa, exponentText] = source.split('e')
    const exponent = Number.parseInt(exponentText, 10)
    digits = mantissa.replace('.', '').replace(/^0+/u, '').replace(/0+$/u, '') || '0'
    decimalPoint = exponent + 1
  } else {
    const [integer, fraction = ''] = source.split('.')
    const combined = `${integer}${fraction}`
    const first = [...combined].findIndex((character) => character !== '0')
    if (first === -1) return '0.0'
    decimalPoint = integer.length - first
    digits = combined.slice(first).replace(/0+$/u, '')
  }
  const trailingZeroCount = decimalPoint - digits.length
  let rendered
  if (trailingZeroCount >= 0 && decimalPoint <= 16) {
    rendered = `${digits}${'0'.repeat(trailingZeroCount)}.0`
  } else if (decimalPoint > 0 && decimalPoint <= 16) {
    rendered = `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`
  } else if (decimalPoint > -5 && decimalPoint <= 0) {
    rendered = `0.${'0'.repeat(-decimalPoint)}${digits}`
  } else {
    const exponent = decimalPoint - 1
    const exponentText = exponent >= 0 ? `+${exponent}` : `${exponent}`
    rendered =
      digits.length === 1
        ? `${digits}e${exponentText}`
        : `${digits[0]}.${digits.slice(1)}e${exponentText}`
  }
  return negative ? `-${rendered}` : rendered
}

export function assertManagedRuntimeUnicode(value) {
  if (typeof value !== 'string') fail('managed-runtime JSON text is not a string')
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffd ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff ||
      (codePoint < 0x20 && character !== '\t' && character !== '\n' && character !== '\r') ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      fail('managed-runtime JSON contains nonportable Unicode')
    }
  }
  return value
}

function managedRuntimeNumberText(value, sourceLexeme) {
  if (typeof sourceLexeme !== 'string') return JSON.stringify(value)
  if (!Number.isFinite(value)) fail('managed-runtime JSON contains a non-finite number')
  if (!/[.eE]/u.test(sourceLexeme)) {
    if (!Number.isSafeInteger(value)) {
      fail('managed-runtime JSON integer exceeds the exact range')
    }
    return `${value}`
  }
  return managedRuntimeFloatText(value)
}

export function ledgerFloatText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('ledger float is not finite')
  }
  if (Object.is(value, -0)) return '-0.0'
  const negative = value < 0
  const source = Math.abs(value).toString().toLowerCase()
  let digits
  let decimalPoint
  if (source.includes('e')) {
    const [mantissa, exponentText] = source.split('e')
    const exponent = Number.parseInt(exponentText, 10)
    digits = mantissa.replace('.', '').replace(/^0+/u, '').replace(/0+$/u, '') || '0'
    decimalPoint = exponent + 1
  } else {
    const [integer, fraction = ''] = source.split('.')
    const combined = `${integer}${fraction}`
    const first = [...combined].findIndex((character) => character !== '0')
    if (first === -1) return '0.0'
    decimalPoint = integer.length - first
    digits = combined.slice(first).replace(/0+$/u, '')
  }
  const trailingZeroCount = decimalPoint - digits.length
  let rendered
  if (trailingZeroCount >= 0 && decimalPoint <= 16) {
    rendered = `${digits}${'0'.repeat(trailingZeroCount)}.0`
  } else if (decimalPoint > 0 && decimalPoint <= 16) {
    rendered = `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`
  } else if (decimalPoint > -4 && decimalPoint <= 0) {
    rendered = `0.${'0'.repeat(-decimalPoint)}${digits}`
  } else {
    const exponent = decimalPoint - 1
    const exponentDigits = `${Math.abs(exponent)}`.padStart(2, '0')
    const exponentText = `${exponent >= 0 ? '+' : '-'}${exponentDigits}`
    rendered =
      digits.length === 1
        ? `${digits}e${exponentText}`
        : `${digits[0]}.${digits.slice(1)}e${exponentText}`
  }
  return negative ? `-${rendered}` : rendered
}

function ledgerNumberText(value, sourceLexeme) {
  if (!Number.isFinite(value)) fail('ledger JSON contains a non-finite number')
  if (typeof sourceLexeme === 'string' && !/[.eE]/u.test(sourceLexeme)) {
    if (!Number.isSafeInteger(value)) fail('ledger JSON integer exceeds the exact range')
    return `${value}`
  }
  return ledgerFloatText(value)
}

export function ledgerCanonical(value, parent = undefined, key = undefined, omit = undefined) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    return ledgerNumberText(value, parent?.[MANAGED_RUNTIME_NUMBER_LEXEMES]?.get(`${key}`))
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value
      .map((child, index) => ledgerCanonical(child, value, index, undefined))
      .join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((member) => member !== omit)
      .sort(compareUnicodeCodePoints)
      .map(
        (member) =>
          `${JSON.stringify(member)}:${ledgerCanonical(value[member], value, member, undefined)}`
      )
      .join(',')}}`
  }
  fail('ledger document contains a non-JSON value')
}

export function managedRuntimeCanonical(
  value,
  parent = undefined,
  key = undefined,
  omit = undefined
) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    return managedRuntimeNumberText(value, parent?.[MANAGED_RUNTIME_NUMBER_LEXEMES]?.get(`${key}`))
  }
  if (typeof value === 'string') return JSON.stringify(assertManagedRuntimeUnicode(value))
  if (Array.isArray(value)) {
    return `[${value
      .map((child, index) => managedRuntimeCanonical(child, value, index, undefined))
      .join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((member) => member !== omit)
      .sort(compareUnicodeCodePoints)
      .map(
        (member) =>
          `${JSON.stringify(assertManagedRuntimeUnicode(member))}:${managedRuntimeCanonical(value[member], value, member, undefined)}`
      )
      .join(',')}}`
  }
  fail('managed-runtime document contains a non-JSON value')
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function gitOutput(repositoryRoot, arguments_, maxBytes = MAX_GIT_OUTPUT_BYTES) {
  const environment = {
    ...process.env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  }
  delete environment.GIT_DIR
  delete environment.GIT_WORK_TREE
  delete environment.GIT_INDEX_FILE
  const result = spawnSync(
    'git',
    [
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      ...arguments_,
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: null,
      maxBuffer: maxBytes,
      timeout: 30_000,
      windowsHide: true,
    }
  )
  if (result.error !== undefined) {
    fail(`Git ${arguments_[0]} failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const diagnostic = Buffer.from(result.stderr ?? Buffer.alloc(0))
      .subarray(0, 4096)
      .toString('utf8')
      .trim()
    fail(`Git ${arguments_[0]} failed: ${diagnostic}`)
  }
  return Buffer.from(result.stdout ?? Buffer.alloc(0))
}

function oneGitLine(repositoryRoot, arguments_, label) {
  const output = gitOutput(repositoryRoot, arguments_, 64 * 1024)
  if (!output.toString('utf8').endsWith('\n')) fail(`${label} lacks one terminal newline`)
  const value = output.toString('utf8').slice(0, -1)
  if (value.length === 0 || value.includes('\n') || value.includes('\r')) {
    fail(`${label} is not one line`)
  }
  return value
}

function nulFields(payload, label) {
  if (payload.length === 0 || payload[payload.length - 1] !== 0) {
    fail(`${label} is not NUL terminated`)
  }
  return payload
    .subarray(0, payload.length - 1)
    .toString('utf8')
    .split('\0')
}

function parseRawDiff(payload, objectLength) {
  const fields = nulFields(payload, 'publication diff')
  if (fields.length % 2 !== 0) fail('publication diff field count differs')
  const objectPattern = `[a-f0-9]{${objectLength}}`
  const headerPattern = new RegExp(
    `^:([0-7]{6}) ([0-7]{6}) (${objectPattern}) (${objectPattern}) ([A-Z])$`,
    'u'
  )
  const rows = []
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index].match(headerPattern)
    if (match === null) fail('publication diff row is malformed')
    rows.push({
      old_mode: match[1],
      new_mode: match[2],
      old_oid: match[3],
      new_oid: match[4],
      status: match[5],
      path: fields[index + 1],
    })
  }
  return rows
}

function parseTree(payload, objectLength) {
  const fields = nulFields(payload, 'publication tree')
  const objectPattern = `[a-f0-9]{${objectLength}}`
  const rowPattern = new RegExp(`^([0-7]{6}) ([a-z]+) (${objectPattern})\t(.+)$`, 'u')
  return fields.map((field) => {
    const match = field.match(rowPattern)
    if (match === null) fail('publication tree row is malformed')
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] }
  })
}

function parseCommitParents(payload, objectLength) {
  const headerEnd = payload.indexOf(Buffer.from('\n\n'))
  if (headerEnd < 1 || headerEnd > 64 * 1024 || payload.length > 1024 * 1024) {
    fail('publication commit lacks one bounded complete header')
  }
  const header = payload.subarray(0, headerEnd).toString('utf8')
  if (header.includes('\r') || header.includes('\0')) fail('publication commit header is malformed')
  const objectPattern = new RegExp(`^[a-f0-9]{${objectLength}}$`, 'u')
  const lines = header.split('\n')
  const treeMatch = lines[0]?.match(/^tree ([a-f0-9]+)$/u)
  if (treeMatch === null || !objectPattern.test(treeMatch[1])) {
    fail('publication commit tree header is malformed')
  }
  const parents = []
  let parentHeadersEnded = false
  for (const line of lines.slice(1)) {
    if (line.startsWith(' ')) continue
    if (/^parent(?: |$)/u.test(line)) {
      const parent = line.slice('parent '.length)
      if (parentHeadersEnded || !objectPattern.test(parent)) {
        fail('publication commit parent is malformed')
      }
      parents.push(parent)
      continue
    }
    if (line.startsWith('tree ') || !/^[A-Za-z][A-Za-z0-9-]* .+$/u.test(line)) {
      fail('publication commit header is malformed')
    }
    parentHeadersEnded = true
  }
  return { tree: treeMatch[1], parents }
}

function normalIndexDigest(payload) {
  const rows = nulFields(payload, 'tracked Git index')
  if (rows.length === 0 || rows.some((row) => !row.startsWith('H '))) {
    fail('CREBAIN tracked index contains non-normal file flags')
  }
  return sha256(payload)
}

function readRegularNoFollow(path, maxBytes) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) {
    fail('this platform lacks no-follow file admission')
  }
  const before = lstatSync(path, { bigint: true })
  const expectedUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : before.uid
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== expectedUid ||
    before.nlink !== 1n ||
    (before.mode & 0o111n) !== 0n ||
    before.size < 1n ||
    before.size > BigInt(maxBytes)
  ) {
    fail(`operational evidence is not one bounded no-follow regular file: ${path}`)
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.nlink !== before.nlink
    ) {
      fail(`operational evidence identity changed during open: ${path}`)
    }
    const payload = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < payload.length) {
      const count = readSync(descriptor, payload, offset, payload.length - offset, offset)
      if (count <= 0) fail(`operational evidence read stopped early: ${path}`)
      offset += count
    }
    const after = lstatSync(path, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mode !== opened.mode ||
      after.uid !== opened.uid ||
      after.nlink !== opened.nlink ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      fail(`operational evidence identity changed during read: ${path}`)
    }
    return payload
  } finally {
    closeSync(descriptor)
  }
}

export function assertOperationalPublicationState(
  state,
  expectedSourceRevision,
  expectedPublicationRevision
) {
  const objectLength = state.object_format === 'sha1' ? 40 : 64
  const objectPattern = new RegExp(`^[a-f0-9]{${objectLength}}$`, 'u')
  if (
    !['sha1', 'sha256'].includes(state.object_format) ||
    !objectPattern.test(expectedSourceRevision) ||
    !objectPattern.test(expectedPublicationRevision) ||
    expectedSourceRevision === expectedPublicationRevision ||
    state.head !== expectedPublicationRevision ||
    state.origin_main !== expectedPublicationRevision ||
    state.status_hex !== '' ||
    state.worktree_root !== state.repository_root ||
    state.is_bare_repository !== 'false' ||
    state.is_inside_work_tree !== 'true' ||
    state.grafts_absent !== true ||
    !isSha256(state.index_flags_sha256) ||
    state.source_type !== 'commit' ||
    state.publication_type !== 'commit' ||
    !objectPattern.test(state.source_tree) ||
    !objectPattern.test(state.publication_tree) ||
    canonical(state.parents) !== canonical([expectedSourceRevision]) ||
    typeof state.repository !== 'string' ||
    state.repository.length === 0 ||
    state.repository.includes('\n')
  ) {
    fail('operational publication repository identity or direct-parent lineage differs')
  }
  const diffRows = [...state.diff_rows].sort((left, right) =>
    compareCodePoint(left.path, right.path)
  )
  const treeRows = [...state.tree_rows].sort((left, right) =>
    compareCodePoint(left.path, right.path)
  )
  if (
    canonical(diffRows.map((row) => row.path)) !== canonical(OPERATIONAL_PUBLICATION_PATHS) ||
    canonical(treeRows.map((row) => row.path)) !== canonical(OPERATIONAL_PUBLICATION_PATHS) ||
    canonical(state.directory_names) !== canonical(OPERATIONAL_PUBLICATION_NAMES) ||
    diffRows.some(
      (row) =>
        row.old_mode !== '000000' ||
        row.new_mode !== '100644' ||
        row.old_oid !== '0'.repeat(objectLength) ||
        row.status !== 'A' ||
        !objectPattern.test(row.new_oid)
    ) ||
    treeRows.some(
      (row) => row.mode !== '100644' || row.type !== 'blob' || !objectPattern.test(row.oid)
    ) ||
    diffRows.some((row, index) => row.new_oid !== treeRows[index].oid) ||
    canonical(state.worktree_rows.map((row) => row.path)) !==
      canonical(OPERATIONAL_PUBLICATION_PATHS) ||
    state.worktree_rows.some(
      (row, index) =>
        row.sha256 !== row.blob_sha256 ||
        row.oid !== treeRows[index].oid ||
        !Number.isInteger(row.size_bytes) ||
        row.size_bytes < 1 ||
        row.size_bytes > MAX_OPERATIONAL_EVIDENCE_BYTES
    )
  ) {
    fail('operational publication is not exactly four added 100644 Git blobs')
  }
  return {
    repository: state.repository,
    commit: expectedSourceRevision,
    tree: state.source_tree,
    origin_main_at_capture: expectedSourceRevision,
    object_format: state.object_format,
    clean_at_capture: true,
  }
}

export function verifyOperationalPublicationRepository(
  repositoryRoot,
  expectedSourceRevision,
  expectedPublicationRevision
) {
  const root = resolve(repositoryRoot)
  const expectedUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : undefined
  const rootStatus = lstatSync(root, { bigint: true })
  if (
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink() ||
    (expectedUid !== undefined && rootStatus.uid !== expectedUid) ||
    (rootStatus.mode & 0o022n) !== 0n ||
    realpathSync(root) !== root
  ) {
    fail('CREBAIN publication root must be one canonical directory')
  }
  const evidenceRoot = resolve(root, OPERATIONAL_EVIDENCE_RELATIVE)
  const relativeEvidence = relative(root, evidenceRoot)
  if (
    relativeEvidence === '' ||
    relativeEvidence === '..' ||
    relativeEvidence.startsWith(`..${sep}`)
  ) {
    fail('operational evidence directory escapes CREBAIN')
  }
  let directory = root
  for (const part of OPERATIONAL_EVIDENCE_RELATIVE.split('/')) {
    directory = resolve(directory, part)
    const status = lstatSync(directory, { bigint: true })
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      (expectedUid !== undefined && status.uid !== expectedUid) ||
      (status.mode & 0o022n) !== 0n ||
      realpathSync(directory) !== directory
    ) {
      fail('operational evidence directory is not one owner-controlled canonical directory')
    }
  }
  const directoryEntries = readdirSync(evidenceRoot, { withFileTypes: true }).sort((left, right) =>
    compareCodePoint(left.name, right.name)
  )
  if (directoryEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail('operational evidence directory contains a non-regular entry')
  }
  const objectFormat = oneGitLine(root, ['rev-parse', '--show-object-format'], 'Git object format')
  if (!['sha1', 'sha256'].includes(objectFormat)) fail('Git object format differs')
  const objectLength = objectFormat === 'sha1' ? 40 : 64
  const objectPattern = new RegExp(`^[a-f0-9]{${objectLength}}$`, 'u')
  if (
    !objectPattern.test(expectedSourceRevision) ||
    !objectPattern.test(expectedPublicationRevision) ||
    expectedSourceRevision === expectedPublicationRevision
  ) {
    fail('expected CREBAIN source or publication revision is invalid')
  }
  const worktreeRoot = oneGitLine(root, ['rev-parse', '--show-toplevel'], 'Git worktree root')
  const isBareRepository = oneGitLine(
    root,
    ['rev-parse', '--is-bare-repository'],
    'Git bare-repository state'
  )
  const isInsideWorkTree = oneGitLine(
    root,
    ['rev-parse', '--is-inside-work-tree'],
    'Git worktree state'
  )
  if (
    resolve(worktreeRoot) !== root ||
    realpathSync(worktreeRoot) !== root ||
    isBareRepository !== 'false' ||
    isInsideWorkTree !== 'true'
  ) {
    fail('CREBAIN Git worktree root or repository mode differs')
  }
  const indexFlagsSha256 = normalIndexDigest(gitOutput(root, ['ls-files', '-v', '-z', '--']))
  const graftPath = oneGitLine(root, ['rev-parse', '--git-path', 'info/grafts'], 'Git graft path')
  if (existsSync(resolve(root, graftPath))) fail('CREBAIN Git graft override is present')
  const head = oneGitLine(root, ['rev-parse', '--verify', 'HEAD^{commit}'], 'CREBAIN HEAD')
  const originMain = oneGitLine(
    root,
    ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    'CREBAIN origin/main'
  )
  const sourceType = oneGitLine(
    root,
    ['cat-file', '-t', expectedSourceRevision],
    'CREBAIN source object type'
  )
  const publicationType = oneGitLine(
    root,
    ['cat-file', '-t', expectedPublicationRevision],
    'CREBAIN publication object type'
  )
  const sourceTree = oneGitLine(
    root,
    ['rev-parse', '--verify', `${expectedSourceRevision}^{tree}`],
    'CREBAIN source tree'
  )
  const publicationCommit = parseCommitParents(
    gitOutput(root, ['cat-file', 'commit', expectedPublicationRevision], 1024 * 1024),
    objectLength
  )
  const diffRows = parseRawDiff(
    gitOutput(root, [
      'diff-tree',
      '--raw',
      '-r',
      '-z',
      '--no-renames',
      '--no-commit-id',
      '--no-abbrev',
      expectedSourceRevision,
      expectedPublicationRevision,
      '--',
    ]),
    objectLength
  )
  const treeRows = parseTree(
    gitOutput(root, [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      expectedPublicationRevision,
      '--',
      OPERATIONAL_EVIDENCE_RELATIVE,
    ]),
    objectLength
  ).sort((left, right) => compareCodePoint(left.path, right.path))
  const payloads = new Map()
  const worktreeRows = []
  for (const row of treeRows) {
    const localName = row.path.slice(`${OPERATIONAL_EVIDENCE_RELATIVE}/`.length)
    const payload = readRegularNoFollow(
      resolve(evidenceRoot, localName),
      MAX_OPERATIONAL_EVIDENCE_BYTES
    )
    const blob = gitOutput(root, ['cat-file', 'blob', row.oid], MAX_OPERATIONAL_EVIDENCE_BYTES + 1)
    payloads.set(localName, payload)
    worktreeRows.push({
      path: row.path,
      oid: row.oid,
      size_bytes: payload.length,
      sha256: sha256(payload),
      blob_sha256: sha256(blob),
    })
    if (!payload.equals(blob)) fail(`operational evidence differs from its Git blob: ${row.path}`)
  }
  const state = {
    object_format: objectFormat,
    repository: oneGitLine(root, ['remote', 'get-url', 'origin'], 'CREBAIN origin'),
    repository_root: root,
    worktree_root: worktreeRoot,
    is_bare_repository: isBareRepository,
    is_inside_work_tree: isInsideWorkTree,
    grafts_absent: true,
    index_flags_sha256: indexFlagsSha256,
    head,
    origin_main: originMain,
    status_hex: gitOutput(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]).toString('hex'),
    source_type: sourceType,
    publication_type: publicationType,
    source_tree: sourceTree,
    publication_tree: publicationCommit.tree,
    parents: publicationCommit.parents,
    diff_rows: diffRows,
    tree_rows: treeRows,
    directory_names: directoryEntries.map((entry) => entry.name),
    worktree_rows: worktreeRows,
  }
  const sourceRepository = assertOperationalPublicationState(
    state,
    expectedSourceRevision,
    expectedPublicationRevision
  )
  return {
    state,
    state_sha256: sha256(Buffer.from(canonical(state))),
    sourceRepository,
    indexPayload: payloads.get('INDEX.json'),
    capturePayloads: new Map(
      OPERATIONAL_PUBLICATION_NAMES.filter((name) => name !== 'INDEX.json').map((name) => [
        name,
        payloads.get(name),
      ])
    ),
  }
}

function strictJsonObject(payload, label) {
  if (
    !(payload instanceof Uint8Array) ||
    payload.byteLength < 2 ||
    payload.byteLength > 64 * 1024 * 1024
  ) {
    fail(`${label} is not one bounded JSON document`)
  }
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    fail(`${label} is not UTF-8`)
  }
  let nodes = 0
  const whitespace = /\s/u
  const skipWhitespace = (start) => {
    let index = start
    while (index < source.length && whitespace.test(source[index])) index += 1
    return index
  }
  const scanString = (start) => {
    if (source[start] !== '"') fail(`${label} contains malformed JSON text`)
    let index = start + 1
    while (index < source.length) {
      const character = source[index]
      if (character === '"') return index + 1
      if (character === '\\') {
        index += 2
      } else {
        if (character.charCodeAt(0) < 0x20) fail(`${label} contains malformed JSON text`)
        index += 1
      }
    }
    fail(`${label} contains an unterminated JSON string`)
  }
  const scanValue = (start, depth) => {
    if (depth > 128 || ++nodes > 1_000_000) fail(`${label} exceeds its JSON structure bound`)
    let index = skipWhitespace(start)
    if (source[index] === '{') {
      const keys = new Set()
      index = skipWhitespace(index + 1)
      if (source[index] === '}') return index + 1
      while (index < source.length) {
        const end = scanString(index)
        let key
        try {
          key = JSON.parse(source.slice(index, end))
        } catch {
          fail(`${label} contains malformed JSON text`)
        }
        if (keys.has(key)) fail(`${label} contains a duplicate JSON member: ${key}`)
        keys.add(key)
        index = skipWhitespace(end)
        if (source[index] !== ':') fail(`${label} contains malformed JSON text`)
        index = skipWhitespace(scanValue(index + 1, depth + 1))
        if (source[index] === '}') return index + 1
        if (source[index] !== ',') fail(`${label} contains malformed JSON text`)
        index = skipWhitespace(index + 1)
      }
      fail(`${label} contains an unterminated JSON object`)
    }
    if (source[index] === '[') {
      index = skipWhitespace(index + 1)
      if (source[index] === ']') return index + 1
      while (index < source.length) {
        index = skipWhitespace(scanValue(index, depth + 1))
        if (source[index] === ']') return index + 1
        if (source[index] !== ',') fail(`${label} contains malformed JSON text`)
        index = skipWhitespace(index + 1)
      }
      fail(`${label} contains an unterminated JSON array`)
    }
    if (source[index] === '"') return scanString(index)
    const primitive = source
      .slice(index)
      .match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u)?.[0]
    if (primitive === undefined) fail(`${label} contains malformed JSON text`)
    return index + primitive.length
  }
  const end = skipWhitespace(scanValue(0, 0))
  if (end !== source.length) fail(`${label} contains trailing JSON text`)
  let document
  try {
    document = JSON.parse(source, function retainManagedRuntimeNumberLexeme(key, value, context) {
      if (typeof value === 'number') {
        if (typeof context?.source !== 'string') {
          throw new Error('JSON parser did not expose the number source')
        }
        if (!Object.hasOwn(this, MANAGED_RUNTIME_NUMBER_LEXEMES)) {
          Object.defineProperty(this, MANAGED_RUNTIME_NUMBER_LEXEMES, {
            configurable: false,
            enumerable: false,
            value: new Map(),
            writable: false,
          })
        }
        this[MANAGED_RUNTIME_NUMBER_LEXEMES].set(`${key}`, context.source)
      }
      return value
    })
  } catch {
    fail(`${label} contains malformed JSON text`)
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail(`${label} is not one JSON object`)
  }
  return document
}

const IMPORTED_RECEIPT_SCHEMA_FILES = new Map([
  ['lifecycle', 'engram.closed-loop-runtime-lifecycle-binding.v1.schema.json'],
  ['command', 'engram.contained-exec-command.v1.schema.json'],
  ['terminal', 'engram.extension-closed-loop-run-receipt.v2.schema.json'],
  ['nest', 'engram.nest-closed-loop-evidence-bundle.v2.schema.json'],
  ['handshake', 'engram.reviewed-native-development-handshake.v1.schema.json'],
  ['termination', 'engram.reviewed-native-development-termination.v1.schema.json'],
])
const importedReceiptSchemaCache = new Map()

// Engram b6 does not publish this model as a standalone schema file.
// This is the validation projection of ClosedLoopRunPlanV1.model_json_schema().
const CLOSED_LOOP_RUN_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    advisory_proposal_sha256: {
      anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }],
    },
    agent_action_authority: { type: 'boolean', const: false },
    calibrated_posterior: { type: 'boolean', const: false },
    channels: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action_components: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { $ref: '#/$defs/ControlVectorComponentV1' },
          },
          action_max: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { type: 'number' },
          },
          action_min: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { type: 'number' },
          },
          action_space_id: {
            type: 'string',
            pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)+$',
          },
          action_width: { type: 'integer', minimum: 1, maximum: 16 },
          channel_id: {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          },
          neural_control_axes: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { $ref: '#/$defs/NeuralControlAxisV1' },
          },
          neural_population_prefix: {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          },
          observation_components: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { $ref: '#/$defs/ControlVectorComponentV1' },
          },
          observation_space_id: {
            type: 'string',
            pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)+$',
          },
          observation_width: { type: 'integer', minimum: 1, maximum: 16 },
          safe_action: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { type: 'number' },
          },
          subject_id: {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          },
          subject_kind: {
            type: 'string',
            pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)+$',
          },
        },
        required: [
          'channel_id',
          'subject_kind',
          'subject_id',
          'observation_space_id',
          'action_space_id',
          'observation_width',
          'action_width',
          'observation_components',
          'action_components',
          'action_min',
          'action_max',
          'safe_action',
          'neural_control_axes',
          'neural_population_prefix',
        ],
      },
    },
    cleanup_timeout_ms: { type: 'integer', minimum: 1, maximum: 600000 },
    is_paper_local_evidence: { type: 'boolean', const: false },
    max_transcript_bytes: { type: 'integer', minimum: 1024, maximum: 268435456 },
    music_transport_used: { type: 'boolean', const: false },
    ncp_transport_used: { type: 'boolean', const: false },
    neural_step_timeout_ms: { type: 'integer', minimum: 1, maximum: 600000 },
    physical_actuation: { type: 'boolean', const: false },
    schema_version: {
      type: 'string',
      const: 'engram.extension-closed-loop-run-plan.v1',
    },
    scientific_authority: { type: 'boolean', const: false },
    simulator_only: { type: 'boolean', const: true },
    step_count: { type: 'integer', minimum: 1, maximum: 1024 },
    study_definition_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    study_run_id: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
    },
    timebase: { $ref: '#/$defs/ClosedLoopTimebaseV1' },
    total_deadline_ms: { type: 'integer', minimum: 1, maximum: 86400000 },
  },
  required: [
    'study_run_id',
    'study_definition_sha256',
    'timebase',
    'channels',
    'step_count',
    'neural_step_timeout_ms',
    'cleanup_timeout_ms',
    'total_deadline_ms',
    'max_transcript_bytes',
  ],
  $defs: {
    ClosedLoopTimebaseV1: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action_application: {
          type: 'string',
          const: 'after-controller-completion-zoh-over-runtime-interval',
        },
        causality_policy: {
          type: 'string',
          const: 'sample-runtime-run-controller-apply-zoh-v1',
        },
        clock_relation: {
          type: 'string',
          const: 'independent-controller-and-runtime-logical-clocks',
        },
        coupling: {
          type: 'string',
          const: 'one-controller-epoch-per-runtime-interval',
        },
        dispatch_order: {
          type: 'string',
          const: 'observe-controller-action-runtime',
        },
        neural_step_duration_tics: {
          type: 'integer',
          minimum: 1,
          maximum: 10000000,
        },
        observation_sample_phase: { type: 'string', const: 'runtime-interval-start' },
        runtime_step_duration_tics: {
          type: 'integer',
          minimum: 1,
          maximum: 10000000,
        },
        schema_version: {
          type: 'string',
          const: 'engram.extension-closed-loop-timebase.v1',
        },
        tic_unit: { type: 'string', const: 'microsecond' },
      },
      required: ['runtime_step_duration_tics', 'neural_step_duration_tics'],
    },
    ControlVectorComponentV1: {
      type: 'object',
      additionalProperties: false,
      properties: {
        component_id: {
          type: 'string',
          pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)+$',
        },
        unit_id: {
          type: 'string',
          pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)+$',
        },
      },
      required: ['component_id', 'unit_id'],
    },
    NeuralControlAxisV1: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action_index: { type: 'integer', minimum: 0, exclusiveMaximum: 16 },
        decoded_action_gain: { type: 'number', exclusiveMinimum: 0.0, maximum: 1.0 },
        encoder: { type: 'string', const: 'affine-sum-clamped-v1' },
        terms: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { $ref: '#/$defs/NeuralControlTermV1' },
        },
      },
      required: ['action_index', 'terms', 'decoded_action_gain'],
    },
    NeuralControlTermV1: {
      type: 'object',
      additionalProperties: false,
      properties: {
        gain_per_observation_unit: { type: 'number' },
        observation_index: { type: 'integer', minimum: 0, exclusiveMaximum: 16 },
        reference_value: { type: 'number' },
      },
      required: ['observation_index', 'reference_value', 'gain_per_observation_unit'],
    },
  },
}

function importedReceiptSchema(name) {
  const filename = IMPORTED_RECEIPT_SCHEMA_FILES.get(name)
  if (filename === undefined) fail(`unknown imported receipt schema: ${name}`)
  if (!importedReceiptSchemaCache.has(name)) {
    importedReceiptSchemaCache.set(
      name,
      JSON.parse(readFileSync(resolve(EVIDENCE_SCHEMAS, filename), 'utf8'))
    )
  }
  return importedReceiptSchemaCache.get(name)
}

function schemaReference(root, reference, label) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    fail(`${label} contains a nonlocal schema reference`)
  }
  let current = root
  for (const token of reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    current = current?.[token]
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    fail(`${label} contains an unresolved schema reference`)
  }
  return current
}

function schemaTypeMatches(value, schema, root, label) {
  if (schema === true) return true
  if (schema === false) return false
  if (schema?.$ref !== undefined) {
    return schemaTypeMatches(value, schemaReference(root, schema.$ref, label), root, label)
  }
  if (Array.isArray(schema?.anyOf)) {
    return schema.anyOf.some((candidate) => schemaTypeMatches(value, candidate, root, label))
  }
  if (schema?.type === 'null') return value === null
  if (schema?.type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (schema?.type === 'array') return Array.isArray(value)
  if (schema?.type === 'number' || schema?.type === 'integer') return typeof value === 'number'
  if (schema?.type === 'string') return typeof value === 'string'
  if (schema?.type === 'boolean') return typeof value === 'boolean'
  return true
}

function assertClosedSchemaValue(value, schema, root, label, parent = undefined, key = undefined) {
  if (schema === true) return
  if (schema === false) fail(`${label} is forbidden by its schema`)
  if (schema?.$ref !== undefined) {
    assertClosedSchemaValue(
      value,
      schemaReference(root, schema.$ref, label),
      root,
      label,
      parent,
      key
    )
    return
  }
  if (Array.isArray(schema?.anyOf)) {
    const candidates = schema.anyOf.filter((candidate) =>
      schemaTypeMatches(value, candidate, root, label)
    )
    if (candidates.length !== 1) fail(`${label} has no unambiguous schema branch`)
    assertClosedSchemaValue(value, candidates[0], root, label, parent, key)
    return
  }

  if (!schemaTypeMatches(value, schema, root, label)) {
    fail(`${label} does not match schema type ${schema?.type ?? 'unknown'}`)
  }
  if (Object.hasOwn(schema, 'const') && canonical(value) !== canonical(schema.const)) {
    fail(`${label} differs from its schema constant`)
  }
  if (
    Array.isArray(schema?.enum) &&
    !schema.enum.some((candidate) => canonical(value) === canonical(candidate))
  ) {
    fail(`${label} is outside its schema enumeration`)
  }

  if (schema?.type === 'number' || schema?.type === 'integer') {
    const lexeme = parent?.[MANAGED_RUNTIME_NUMBER_LEXEMES]?.get(`${key}`)
    const isFloat = typeof lexeme === 'string' && /[.eE]/u.test(lexeme)
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      typeof lexeme !== 'string' ||
      (schema.type === 'number' ? !isFloat : isFloat || !Number.isSafeInteger(value))
    ) {
      fail(`${label} numeric kind differs at ${key}`)
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      fail(`${label} is below its schema minimum`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      fail(`${label} is above its schema maximum`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      fail(`${label} is not above its exclusive schema minimum`)
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      fail(`${label} is not below its exclusive schema maximum`)
    }
    return
  }

  if (schema?.type === 'string') {
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      fail(`${label} is shorter than its schema minimum`)
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      fail(`${label} is longer than its schema maximum`)
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      fail(`${label} does not match its schema pattern`)
    }
    return
  }

  if (schema?.type === 'array') {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      fail(`${label} has fewer items than its schema minimum`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      fail(`${label} has more items than its schema maximum`)
    }
    for (const [index, child] of value.entries()) {
      const childSchema = Array.isArray(schema.prefixItems)
        ? (schema.prefixItems[index] ?? schema.items)
        : schema.items
      if (childSchema === false) fail(`${label} has an unexpected item at index ${index}`)
      if (childSchema !== undefined) {
        assertClosedSchemaValue(child, childSchema, root, `${label}[${index}]`, value, index)
      }
    }
    return
  }

  if (schema?.type === 'object') {
    const members = Object.keys(value)
    if (typeof schema.minProperties === 'number' && members.length < schema.minProperties) {
      fail(`${label} has fewer members than its schema minimum`)
    }
    if (typeof schema.maxProperties === 'number' && members.length > schema.maxProperties) {
      fail(`${label} has more members than its schema maximum`)
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        fail(`${label} schema member roster lacks required member: ${required}`)
      }
    }
    for (const [member, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[member]
      if (childSchema !== undefined) {
        assertClosedSchemaValue(child, childSchema, root, `${label}.${member}`, value, member)
      } else if (schema.additionalProperties === false) {
        fail(`${label} schema member roster has an unexpected member: ${member}`)
      } else if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties === 'object'
      ) {
        assertClosedSchemaValue(
          child,
          schema.additionalProperties,
          root,
          `${label}.${member}`,
          value,
          member
        )
      }
    }
  }
}

export function assertImportedReceiptSchema(value, name, label) {
  const schema = importedReceiptSchema(name)
  assertClosedSchemaValue(value, schema, schema, label)
}

export function assertManagedRuntimeCanonicalObject(payload, label) {
  const document = strictJsonObject(payload, label)
  if (!Buffer.from(`${managedRuntimeCanonical(document)}\n`).equals(payload)) {
    fail(`${label} is not exact canonical JSON bytes under the managed-runtime profile`)
  }
  return document
}

function compareSets(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort()
  const extra = [...actual].filter((value) => !expected.has(value)).sort()
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${label} drift (missing ${missing.join(',') || 'none'}; extra ${extra.join(',') || 'none'})`
    )
  }
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is not an object`)
  }
  compareSets(new Set(Object.keys(value)), expected, `${label} member roster`)
  return value
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isGitObject(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
}

function safeRelative(value, label, suffix = undefined) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    (suffix !== undefined && !value.endsWith(suffix))
  ) {
    fail(`${label} is not one canonical safe POSIX path`)
  }
  return value
}

function ledgerDigest(document, field, label) {
  const reported = document?.[field]
  if (!isSha256(reported)) fail(`${label} lacks ${field}`)
  if (sha256(ledgerCanonical(document, undefined, undefined, field)) !== reported) {
    fail(`${label} ledger digest differs`)
  }
  return reported
}

function managedRuntimeDigest(document, field, label) {
  const reported = document?.[field]
  if (!isSha256(reported)) fail(`${label} lacks ${field}`)
  if (sha256(managedRuntimeCanonical(document, undefined, undefined, field)) !== reported) {
    fail(`${label} managed-runtime digest differs`)
  }
  return reported
}

function sortedUnique(values, label) {
  if (
    values.join('\0') !== [...values].sort().join('\0') ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} is not sorted and unique`)
  }
}

function assertSourceRows(
  rows,
  label,
  requireBuildInputs = false,
  minimumSize = 1,
  maximumCount = 128
) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > maximumCount) {
    fail(`${label} has an invalid file count`)
  }
  const paths = []
  let totalBytes = 0
  for (const row of rows) {
    exactKeys(
      row,
      new Set(['relative_path', 'size_bytes', 'sha256', 'git_mode', 'git_blob']),
      `${label} row`
    )
    const path = safeRelative(row.relative_path, `${label} path`)
    if (
      !Number.isInteger(row.size_bytes) ||
      row.size_bytes < minimumSize ||
      row.size_bytes > 16 * 1024 * 1024 ||
      !isSha256(row.sha256) ||
      !['100644', '100755'].includes(row.git_mode) ||
      !isGitObject(row.git_blob)
    ) {
      fail(`${label} row value differs`)
    }
    paths.push(path)
    totalBytes += row.size_bytes
  }
  sortedUnique(paths, `${label} paths`)
  if (totalBytes > 128 * 1024 * 1024) fail(`${label} exceeds its byte bound`)
  if (requireBuildInputs) {
    const required = [
      ...BUILD_CONTRACT_PATHS,
      'rust-toolchain.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/Cargo.toml',
      'src-tauri/crates/managed-simulation/Cargo.toml',
      'src-tauri/crates/managed-simulation/src/lib.rs',
      'src-tauri/crates/managed-simulation/src/main.rs',
      'src-tauri/src/pid_observation.rs',
      'src-tauri/src/sensor_fusion.rs',
    ]
    if (required.some((path) => !paths.includes(path))) fail(`${label} lacks required build inputs`)
    if (
      paths.some(
        (path) =>
          !required.includes(path) &&
          !(path.startsWith('src-tauri/crates/managed-simulation/src/') && path.endsWith('.rs'))
      )
    ) {
      fail(`${label} escapes the managed-simulation build closure`)
    }
  }
  return rows
}

function assertModuleRows(rows, label) {
  if (!Array.isArray(rows) || rows.length > 1024) fail(`${label} is not bounded`)
  const moduleNames = []
  const paths = []
  const identities = rows.map((row) => {
    exactKeys(row, new Set(['module_name', 'relative_path']), `${label} row`)
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(row.module_name)) {
      fail(`${label} module name is not canonical`)
    }
    safeRelative(row.relative_path, `${label} path`, '.py')
    moduleNames.push(row.module_name)
    paths.push(row.relative_path)
    return `${row.module_name}\0${row.relative_path}`
  })
  sortedUnique(identities, label)
  if (new Set(moduleNames).size !== moduleNames.length || new Set(paths).size !== paths.length) {
    fail(`${label} module names or paths are not unique`)
  }
  return rows
}

function assertPathRows(
  rows,
  expectedKeys,
  label,
  orderFields = ['relative_path'],
  pathField = 'relative_path'
) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1024) {
    fail(`${label} is not one bounded nonempty roster`)
  }
  const paths = []
  const identities = rows.map((row) => {
    exactKeys(row, expectedKeys, `${label} row`)
    safeRelative(row[pathField], `${label} path`)
    paths.push(row[pathField])
    return orderFields
      .map((field) => {
        if (typeof row[field] !== 'string') fail(`${label} ${field} is not a string`)
        return row[field]
      })
      .join('\0')
  })
  sortedUnique(identities, label)
  if (new Set(paths).size !== paths.length) fail(`${label} paths are not unique`)
  return rows
}

function assertClosedAuthority(authority, label) {
  if (canonical(authority) !== canonical(SIMULATOR_ONLY_AUTHORITY)) {
    fail(`${label} grants or implies non-simulator authority`)
  }
}

function assertNoAuthorityEscalation(value, label) {
  const pending = [value]
  let observedNodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    observedNodes += 1
    if (observedNodes > 1_000_000) fail(`${label} exceeds the authority-audit node bound`)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (current === null || typeof current !== 'object') continue
    for (const [key, child] of Object.entries(current)) {
      if (NON_AUTHORITY_FALSE_FIELDS.has(key) && child !== false) {
        fail(`${label} grants or implies non-simulator authority`)
      }
      if (key === 'simulator_only' && child !== true) {
        fail(`${label} contradicts simulator-only scope`)
      }
      if (key === 'authority' && typeof child === 'boolean' && child !== false) {
        fail(`${label} grants generic execution authority`)
      }
      pending.push(child)
    }
  }
}

function expectedModulePath(moduleName, relativePath) {
  let expected
  if (relativePath.endsWith('/__init__.py')) {
    expected = relativePath.slice(0, -'/__init__.py'.length).replaceAll('/', '.')
  } else if (relativePath.endsWith('.py')) {
    expected = relativePath.slice(0, -'.py'.length).replaceAll('/', '.')
  } else {
    return false
  }
  return moduleName === expected
}

function dependencyKeys(manifest) {
  const result = new Set()
  let section = ''
  for (const line of manifest.split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)
    if (header !== null) {
      section = header[1]
      continue
    }
    if (section !== 'dependencies') continue
    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u)?.[1]
    if (key !== undefined) result.add(key)
  }
  return result
}

function maskedRust(source) {
  const characters = source.split('')
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== '\n') characters[index] = ' '
    }
  }
  let index = 0
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      blank(index, end === -1 ? source.length : end)
      index = end === -1 ? source.length : end
      continue
    }
    if (source.startsWith('/*', index)) {
      let depth = 1
      let end = index + 2
      while (end < source.length && depth > 0) {
        if (source.startsWith('/*', end)) {
          depth += 1
          end += 2
        } else if (source.startsWith('*/', end)) {
          depth -= 1
          end += 2
        } else {
          end += 1
        }
      }
      if (depth !== 0) fail('Rust source has an unterminated block comment')
      blank(index, end)
      index = end
      continue
    }
    const raw = source.slice(index).match(/^(?:br|r)(#{0,255})"/u)
    if (raw !== null) {
      const closing = `"${raw[1]}`
      const closingIndex = source.indexOf(closing, index + raw[0].length)
      if (closingIndex === -1) fail('Rust source has an unterminated raw string')
      const end = closingIndex + closing.length
      blank(index, end)
      index = end
      continue
    }
    if (source[index] === '"') {
      let end = index + 1
      while (end < source.length) {
        if (source[end] === '\\') {
          end += 2
        } else if (source[end] === '"') {
          end += 1
          break
        } else {
          end += 1
        }
      }
      if (end > source.length || source[end - 1] !== '"') {
        fail('Rust source has an unterminated string')
      }
      blank(index, end)
      index = end
      continue
    }
    if (source[index] === "'") {
      const character = source.slice(index).match(/^'(?:\\(?:.|u\{[a-fA-F0-9_]+\})|[^'\\\n])'/u)
      if (character !== null) {
        blank(index, index + character[0].length)
        index += character[0].length
        continue
      }
    }
    index += 1
  }
  return characters.join('')
}

function stripRust(source) {
  const stripped = maskedRust(source)
  const characters = stripped.split('')
  const testAttribute = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/gu
  for (const match of stripped.matchAll(testAttribute)) {
    const start = match.index
    const opening = stripped.indexOf('{', start + match[0].length)
    const semicolon = stripped.indexOf(';', start + match[0].length)
    let end
    if (semicolon !== -1 && (opening === -1 || semicolon < opening)) {
      end = semicolon + 1
    } else if (opening !== -1) {
      let depth = 0
      for (let index = opening; index < stripped.length; index += 1) {
        if (stripped[index] === '{') depth += 1
        if (stripped[index] === '}') depth -= 1
        if (depth === 0) {
          end = index + 1
          break
        }
      }
    }
    if (end === undefined) fail('source has an unterminated cfg(test) item')
    characters.fill(' ', start, end)
  }
  return characters.join('')
}

function sourceIncludes(library) {
  return new Set(
    [...library.matchAll(/#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]/gu)].map((match) => match[1])
  )
}

export function assertCrateBoundary(manifest, sources, fileNames) {
  compareSets(dependencyKeys(manifest), EXPECTED_DEPENDENCIES, 'runtime dependencies')
  if (!/^unsafe_code\s*=\s*"forbid"$/mu.test(manifest)) fail('unsafe code is not forbidden')
  if (fileNames.includes('build.rs')) fail('implicit build.rs is forbidden')
  const library = sources.get('lib.rs') ?? ''
  const includes = sourceIncludes(library)
  compareSets(includes, EXPECTED_SOURCE_INCLUDES, 'source-included Rust roster')
  for (const include of includes) {
    if (!sources.has(include)) {
      fail(`source-included Rust file was not scanned: ${include}`)
    }
  }
  for (const [path, source] of sources) {
    const code = stripRust(source)
    for (const forbidden of FORBIDDEN_CODE) {
      if (forbidden.test(code)) fail(`${path} contains forbidden capability ${forbidden}`)
    }
  }
}

export function assertContractGateBoundary(packageDocument) {
  if (packageDocument?.scripts?.['check:managed-simulation-contract'] !== EXPECTED_CONTRACT_GATE) {
    fail('managed simulation contract gate must build and replay the exact release binary')
  }
}

export function assertManifestBoundary(manifest) {
  const runtime = manifest.runtime
  if (
    manifest.schema_version !== '2.0' ||
    manifest.id !== 'sepahead.crebain.simulation' ||
    manifest.version !== '0.1.0' ||
    canonical(manifest.host_api) !== canonical({ minimum: '2.0', maximum: '2.0' }) ||
    canonical(manifest.presentation) !== canonical({ mode: 'none' }) ||
    canonical(manifest.capabilities) !==
      canonical(['compute.one-shot', 'operations.simulation', 'runtime.managed-headless']) ||
    runtime?.mode !== 'managed-headless' ||
    runtime?.profile !== 'engram.reviewed-native-development.v1' ||
    canonical(runtime.reviewed_package) !== canonical(EXPECTED_REVIEWED_PACKAGE_TEMPLATE) ||
    canonical(runtime.configuration) !== canonical(EXPECTED_RUNTIME_CONFIGURATION) ||
    canonical(runtime.transport) !== canonical(EXPECTED_RUNTIME_TRANSPORT) ||
    canonical(runtime.lifecycle) !== canonical(EXPECTED_RUNTIME_LIFECYCLE)
  ) {
    fail('manifest identity or development profile drifted')
  }
  if (
    canonical(manifest.ncp) !==
    canonical({ mode: 'none', activation_enabled: false, host_compatible: false })
  ) {
    fail('manifest grants or implies NCP authority')
  }
  if (
    manifest.authority === undefined ||
    canonical(manifest.authority) !== canonical(EXPECTED_MANIFEST_AUTHORITY)
  ) {
    fail('manifest authority roster differs')
  }
  if (
    canonical(runtime.resources) !== canonical(EXPECTED_RUNTIME_RESOURCES) ||
    canonical(runtime.restart_policy) !== canonical(EXPECTED_RESTART_POLICY)
  ) {
    fail('resource envelope drifted')
  }
  const operations = runtime.operations
  const ids = operations.map((row) => row.operation_id)
  if (ids.join(',') !== [...ids].sort().join(',')) fail('operation roster is not sorted')
  for (const row of operations) {
    if (
      row.class !== 'simulation' ||
      row.effect !== 'none' ||
      row.compute_grant !== 'host-one-shot' ||
      row.artifact_access?.read !== 'none' ||
      row.artifact_access?.write !== 'none'
    ) {
      fail(`operation ${row.operation_id} crosses the simulator-only boundary`)
    }
  }
  const rosterHash = sha256(`engram-managed-operation-roster-v1\0${canonical(operations)}`)
  if (rosterHash !== EXPECTED_ROSTER_HASH) fail('operation roster digest drifted')
}

export function assertTranscriptBoundary(transcript) {
  if (
    transcript.schema_version !== 'crebain.simulation.sample-transcript.v2' ||
    transcript.fixture_only !== true ||
    transcript.operation_roster_sha256 !== EXPECTED_ROSTER_HASH ||
    transcript.scenario?.authority !== 'simulator-only' ||
    transcript.scenario?.ncp_mode !== 'none' ||
    transcript.scenario?.surface !== 'standard-v3' ||
    transcript.frames?.length !== 8
  ) {
    fail('sample transcript header drifted')
  }
  for (const frame of transcript.frames) {
    if (
      !Number.isInteger(frame.payload_length) ||
      frame.payload_length < 1 ||
      frame.payload_length > 65536 ||
      frame.prefix_hex !== frame.payload_length.toString(16).padStart(8, '0') ||
      !/^[a-f0-9]{64}$/u.test(frame.payload_sha256)
    ) {
      fail('sample transcript framing receipt drifted')
    }
  }
  const requests = transcript.frames
    .filter((frame) => frame.direction === 'host-to-runtime')
    .map((frame) => frame.envelope)
  const responses = transcript.frames
    .filter((frame) => frame.direction === 'runtime-to-host')
    .map((frame) => frame.envelope)
  if (requests.map((frame) => frame.sequence).join(',') !== '0,1,2,3') {
    fail('host sequence is not exact')
  }
  if (responses.map((frame) => frame.sequence).join(',') !== '0,1,2,3') {
    fail('runtime sequence is not exact')
  }
  const controls = responses.slice(1).map((frame) => frame.body.control)
  if (
    controls.some((control) => control.study_run_id !== 'study-run-standard-wire-01') ||
    controls[0].schema_version !== 'engram.closed-loop-simulator.prepare-response.v3' ||
    controls[1].schema_version !== 'engram.closed-loop-simulator.step-response.v3' ||
    controls[2].schema_version !== 'engram.closed-loop-simulator.finish-response.v3' ||
    controls[0].step_index !== 0 ||
    controls[0].simulation_time_tics !== 0 ||
    controls[1].step_index !== 1 ||
    controls[1].simulation_time_tics !== 20000 ||
    controls[2].final_step_index !== 1 ||
    controls[2].final_simulation_time_tics !== 20000 ||
    controls
      .slice(0, 2)
      .some((control) => control.channel_ids.join(',') !== 'channel-01,channel-02,channel-03') ||
    controls.slice(0, 2).some((control) => control.observation_widths.join(',') !== '6,6,6') ||
    controls.slice(0, 2).some((control) => control.observation_present.some((value) => !value)) ||
    controls.slice(0, 2).some((control) => control.fault_codes.join(',') !== 'none,none,none') ||
    controls[2].run_state_cleared !== true
  ) {
    fail('standard run, clock, roster, fault, or cleanup join drifted')
  }
  for (const control of controls.slice(0, 2)) {
    if (
      !Array.isArray(control.observation_values) ||
      control.observation_values.length !== 18 ||
      control.observation_values.some((number) => !Number.isFinite(number))
    ) {
      fail('observation_values contains a non-finite or wrong-width wire value')
    }
  }
}

export function assertSchemaDigests(payloads) {
  for (const [name, expected] of Object.entries(EXPECTED_SCHEMA_HASHES)) {
    if (sha256(payloads.get(name) ?? Buffer.alloc(0)) !== expected) {
      fail(`${name} digest drifted`)
    }
  }
}

export function assertContractProvenance(provenance, payloads) {
  const source = provenance?.source
  const copies = provenance?.copies
  const objectLength = source?.object_format === 'sha1' ? 40 : 64
  if (
    provenance?.schema_version !== 'crebain.contract-provenance.v2' ||
    provenance?.authority !== 'compatibility-copy-only' ||
    canonical(source) !== canonical(ENGRAM_CONTRACT_SOURCE) ||
    source?.clean !== true ||
    typeof source.repository !== 'string' ||
    source.repository.length === 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.commit ?? '') ||
    source.origin_main !== source.commit ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.tree ?? '') ||
    !['sha1', 'sha256'].includes(source.object_format) ||
    source.commit.length !== objectLength ||
    source.tree.length !== objectLength ||
    !Array.isArray(copies) ||
    provenance?.generation?.policy !== 'clean-head-equals-local-origin-main-git-blob-copy.v1' ||
    provenance?.generation?.copy_count !== ENGRAM_CONTRACT_SCHEMA_IDS.size ||
    copies.length !== ENGRAM_CONTRACT_SCHEMA_IDS.size
  ) {
    fail('Engram contract provenance identity or clean-origin binding differs')
  }
  const observedNames = new Set()
  const observedSchemaIds = new Set()
  for (const row of copies) {
    const destinationPrefix = 'integrations/engram/managed-simulation/contracts/'
    const destination = row?.destination_path
    const name =
      typeof destination === 'string' && destination.startsWith(destinationPrefix)
        ? destination.slice(destinationPrefix.length)
        : ''
    const expectedSchemaId = ENGRAM_CONTRACT_SCHEMA_IDS.get(name)
    if (
      expectedSchemaId === undefined ||
      name.includes('/') ||
      row.schema_id !== expectedSchemaId ||
      row.source_path !== `integrations/contracts/${expectedSchemaId}.schema.json` ||
      row.sha256 !== sha256(payloads.get(name) ?? Buffer.alloc(0)) ||
      !['100644', '100755'].includes(row.git_mode) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(row.git_blob ?? '') ||
      row.git_blob.length !== objectLength ||
      row.runtime_role !== (name.startsWith('audit-standard-') ? 'audit-only' : 'runnable') ||
      observedNames.has(name) ||
      observedSchemaIds.has(row.schema_id)
    ) {
      fail(`Engram contract copy provenance differs: ${name || 'invalid destination'}`)
    }
    observedNames.add(name)
    observedSchemaIds.add(row.schema_id)
  }
  compareSets(observedNames, new Set(ENGRAM_CONTRACT_SCHEMA_IDS.keys()), 'Engram contract copies')
}

export function assertContractProvenanceBytes(payload, contractPayloads) {
  if (sha256(payload) !== EXPECTED_CONTRACT_PROVENANCE_SHA256) {
    fail('Engram wire-contract provenance digest drifted')
  }
  let provenance
  try {
    provenance = JSON.parse(payload)
  } catch {
    fail('Engram wire-contract provenance is not strict JSON')
  }
  assertContractProvenance(provenance, contractPayloads)
  return provenance
}

export function assertStandardFaultCodeSchemaBoundary(payloads) {
  for (const name of [
    'standard-v3-prepare-response.schema.json',
    'standard-v3-step-response.schema.json',
  ]) {
    let schema
    try {
      schema = JSON.parse(payloads.get(name) ?? Buffer.alloc(0))
    } catch {
      fail(`${name} is not strict JSON`)
    }
    const faultCode = schema?.properties?.fault_codes?.items
    if (
      faultCode?.type !== 'string' ||
      faultCode?.minLength !== 1 ||
      faultCode?.maxLength !== 128
    ) {
      fail(`${name} fault-code length bound drifted`)
    }
  }
}

export function assertDifferentialArtifacts(payloads) {
  compareSets(
    new Set(payloads.keys()),
    new Set(Object.keys(EXPECTED_DIFFERENTIAL_HASHES)),
    'finite-float differential artifact roster'
  )
  for (const [name, expected] of Object.entries(EXPECTED_DIFFERENTIAL_HASHES)) {
    if (sha256(payloads.get(name)) !== expected) {
      fail(`${name} digest drifted`)
    }
  }
}

export function assertRuntimeReceiptProvenance(provenance, payloads) {
  exactKeys(
    provenance,
    new Set(['schema_version', 'source', 'copies', 'generation', 'authority']),
    'Engram runtime-receipt provenance'
  )
  const source = exactKeys(
    provenance.source,
    new Set(['repository', 'commit', 'tree', 'origin_main', 'object_format', 'clean']),
    'Engram runtime-receipt provenance source'
  )
  const generation = exactKeys(
    provenance.generation,
    new Set(['policy', 'copy_count']),
    'Engram runtime-receipt provenance generation'
  )
  if (
    provenance.schema_version !== 'crebain.contract-provenance.v2' ||
    provenance.authority !== 'compatibility-copy-only' ||
    canonical(source) !== canonical(ENGRAM_CONTRACT_SOURCE) ||
    generation.policy !== 'clean-head-equals-local-origin-main-git-blob-copy.v1' ||
    generation.copy_count !== ENGRAM_RUNTIME_RECEIPT_SCHEMAS.size ||
    !Array.isArray(provenance.copies) ||
    provenance.copies.length !== ENGRAM_RUNTIME_RECEIPT_SCHEMAS.size
  ) {
    fail('Engram runtime-receipt provenance identity or immutable source differs')
  }
  compareSets(
    new Set(payloads.keys()),
    new Set(ENGRAM_RUNTIME_RECEIPT_SCHEMAS.keys()),
    'Engram runtime-receipt payload roster'
  )
  const sourcePrefix = 'integrations/contracts/'
  const destinationPrefix = 'integrations/engram/managed-simulation/evidence-schemas/'
  const observedNames = new Set()
  for (const [index, [name, identity]] of [...ENGRAM_RUNTIME_RECEIPT_SCHEMAS].entries()) {
    const row = exactKeys(
      provenance.copies[index],
      new Set([
        'schema_id',
        'source_path',
        'destination_path',
        'sha256',
        'git_mode',
        'git_blob',
        'runtime_role',
        'size_bytes',
      ]),
      `Engram runtime-receipt provenance copy ${index + 1}`
    )
    const schemaId = name.slice(0, -'.schema.json'.length)
    const payload = payloads.get(name) ?? Buffer.alloc(0)
    if (
      row.schema_id !== schemaId ||
      row.source_path !== `${sourcePrefix}${name}` ||
      row.destination_path !== `${destinationPrefix}${name}` ||
      row.sha256 !== identity.sha256 ||
      row.sha256 !== sha256(payload) ||
      row.git_mode !== '100644' ||
      row.git_blob !== identity.gitBlob ||
      row.runtime_role !== 'evidence-validation' ||
      row.size_bytes !== identity.sizeBytes ||
      row.size_bytes !== payload.length ||
      observedNames.has(name)
    ) {
      fail(`Engram runtime-receipt provenance copy differs: ${name}`)
    }
    observedNames.add(name)
  }
  compareSets(
    observedNames,
    new Set(ENGRAM_RUNTIME_RECEIPT_SCHEMAS.keys()),
    'Engram runtime-receipt provenance copies'
  )
}

export function assertRuntimeReceiptProvenanceBytes(payload, schemaPayloads) {
  if (sha256(payload) !== EXPECTED_RUNTIME_RECEIPT_PROVENANCE_SHA256) {
    fail('Engram runtime-receipt provenance digest drifted')
  }
  let provenance
  try {
    provenance = JSON.parse(payload)
  } catch {
    fail('Engram runtime-receipt provenance is not strict JSON')
  }
  assertRuntimeReceiptProvenance(provenance, schemaPayloads)
  return provenance
}

export function assertCommonEngramContractSource(wireProvenance, runtimeProvenance) {
  const sourceMembers = new Set([
    'repository',
    'commit',
    'tree',
    'origin_main',
    'object_format',
    'clean',
  ])
  const wireSource = exactKeys(
    wireProvenance?.source,
    sourceMembers,
    'Engram wire-contract provenance source'
  )
  const runtimeSource = exactKeys(
    runtimeProvenance?.source,
    sourceMembers,
    'Engram runtime-receipt provenance source'
  )
  if (canonical(wireSource) !== canonical(runtimeSource)) {
    fail('Engram wire-contract and runtime-receipt provenance sources differ')
  }
}

export function assertEvidenceSchemas(payloads) {
  compareSets(
    new Set(payloads.keys()),
    new Set(Object.keys(EXPECTED_EVIDENCE_SCHEMA_HASHES)),
    'managed-simulation evidence schema roster'
  )
  const requiredByName = new Map([
    ['observed-build-receipt.v1.schema.json', BUILD_RECEIPT_KEYS],
    ['package-stage-receipt.v1.schema.json', STAGE_RECEIPT_KEYS],
    ['engram-pack-receipt.v1.schema.json', PACK_RECEIPT_KEYS],
    ['installed-binary-proof.v3.schema.json', INSTALLED_PROOF_V3_KEYS],
    ['real-nest-capture.v2.schema.json', CAPTURE_V2_KEYS],
    [
      'real-nest-evidence-index.v2.schema.json',
      new Set([
        'schema_version',
        'profile',
        'input_suite',
        'tool_source_closure',
        'crebain_source_repository',
        'engram',
        'package',
        'installed_package_proof_exact_sha256',
        'captures',
        'assertions',
        'authority',
        'disclosure',
      ]),
    ],
  ])
  for (const [name, expectedHash] of Object.entries(EXPECTED_EVIDENCE_SCHEMA_HASHES)) {
    const payload = payloads.get(name)
    if (sha256(payload) !== expectedHash) fail(`${name} digest drifted`)
    let schema
    try {
      schema = JSON.parse(payload)
    } catch {
      fail(`${name} is not strict JSON`)
    }
    const runtimeReceiptIdentity = ENGRAM_RUNTIME_RECEIPT_SCHEMAS.get(name)
    const required = requiredByName.get(name)
    const expectedSchemaId = runtimeReceiptIdentity
      ? `https://engram.local/schemas/${name}`
      : undefined
    if (
      schema?.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
      typeof schema?.$id !== 'string' ||
      (expectedSchemaId === undefined
        ? !schema.$id.startsWith('https://crebain.local/schemas/')
        : schema.$id !== expectedSchemaId) ||
      schema.type !== 'object' ||
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required) ||
      schema.properties === null ||
      typeof schema.properties !== 'object'
    ) {
      fail(`${name} root closure differs`)
    }
    if (runtimeReceiptIdentity === undefined) {
      compareSets(new Set(schema.required), required, `${name} required roster`)
      compareSets(new Set(Object.keys(schema.properties)), required, `${name} property roster`)
    } else {
      compareSets(
        new Set(schema.required),
        new Set(Object.keys(schema.properties)),
        `${name} exported root closure`
      )
    }
    if (
      runtimeReceiptIdentity === undefined &&
      name !== 'installed-binary-proof.v3.schema.json' &&
      (schema.$defs?.safePath?.type !== 'string' ||
        schema.$defs.safePath.pattern !== EXPECTED_SAFE_PATH_PATTERN)
    ) {
      fail(`${name} safe-path boundary differs`)
    }
    if (name === 'real-nest-evidence-index.v2.schema.json') {
      const row = schema.$defs?.captureRow
      if (
        row?.additionalProperties !== false ||
        !Array.isArray(row.required) ||
        row.properties === null ||
        typeof row.properties !== 'object'
      ) {
        fail('real-NEST v2 capture-row schema is not the exact 16-key closure')
      }
      compareSets(
        new Set(row.required),
        CAPTURE_ROW_V2_KEYS,
        'real-NEST v2 capture-row schema required roster'
      )
      compareSets(
        new Set(Object.keys(row.properties)),
        CAPTURE_ROW_V2_KEYS,
        'real-NEST v2 capture-row schema property roster'
      )
    }
  }
}

function assertBuildReceipt(receipt) {
  exactKeys(receipt, BUILD_RECEIPT_KEYS, 'observed-build receipt')
  if (receipt.schema_version !== 'crebain.managed-simulation-observed-build-receipt.v1') {
    fail('observed-build receipt schema differs')
  }
  const repository = exactKeys(
    receipt.repository,
    new Set(['origin', 'commit', 'tree', 'origin_main', 'object_format', 'clean']),
    'observed-build repository'
  )
  if (
    !isGitObject(repository.commit) ||
    !isGitObject(repository.tree) ||
    repository.origin_main !== repository.commit ||
    !['sha1', 'sha256'].includes(repository.object_format) ||
    repository.clean !== true ||
    typeof repository.origin !== 'string' ||
    repository.origin.length === 0 ||
    repository.origin.includes('\n')
  ) {
    fail('observed-build repository is not clean immutable origin/main')
  }
  const objectLength = repository.object_format === 'sha1' ? 40 : 64
  if (repository.commit.length !== objectLength || repository.tree.length !== objectLength) {
    fail('observed-build Git objects differ from the declared object format')
  }
  const source = exactKeys(
    receipt.source,
    new Set(['policy', 'files', 'roster_sha256']),
    'observed-build source closure'
  )
  if (source.policy !== 'clean-origin-main-git-blob-and-rustc-dep-info-build-inputs.v1') {
    fail('observed-build source policy differs')
  }
  assertSourceRows(source.files, 'observed-build source roster', true)
  if (source.files.some((row) => row.git_blob.length !== objectLength)) {
    fail('observed-build source blob differs from the Git object format')
  }
  if (source.roster_sha256 !== sha256(ledgerCanonical(source.files))) {
    fail('observed-build source roster digest differs')
  }
  const generator = exactKeys(
    receipt.generator,
    new Set(['files', 'roster_sha256']),
    'observed-build generator closure'
  )
  assertSourceRows(generator.files, 'observed-build generator roster')
  if (generator.files.some((row) => row.git_blob.length !== objectLength)) {
    fail('observed-build generator blob differs from the Git object format')
  }
  const expectedGenerator = [
    'scripts/build-managed-simulation-bootstrap.py',
    'scripts/managed_simulation_authoring_files.py',
    'scripts/managed_simulation_build_provenance.py',
  ]
  if (generator.files.map((row) => row.relative_path).join(',') !== expectedGenerator.join(',')) {
    fail('observed-build generator roster differs')
  }
  if (generator.roster_sha256 !== sha256(ledgerCanonical(generator.files))) {
    fail('observed-build generator roster digest differs')
  }
  const cargo = exactKeys(
    receipt.cargo,
    new Set([
      'workspace_manifest_path',
      'workspace_manifest_exact_sha256',
      'package_manifest_path',
      'package_manifest_exact_sha256',
      'lock_path',
      'lock_exact_sha256',
      'toolchain_path',
      'toolchain_exact_sha256',
      'rust_toolchain',
      'rustc_version',
      'cargo_version',
      'argv',
      'profile',
      'target',
      'target_directory_policy',
      'environment_policy',
    ]),
    'observed-build Cargo identity'
  )
  const paths = {
    workspace_manifest_path: 'src-tauri/Cargo.toml',
    package_manifest_path: 'src-tauri/crates/managed-simulation/Cargo.toml',
    lock_path: 'src-tauri/Cargo.lock',
    toolchain_path: 'rust-toolchain.toml',
  }
  for (const [field, expected] of Object.entries(paths)) {
    if (cargo[field] !== expected) fail(`observed-build ${field} differs`)
  }
  for (const field of [
    'workspace_manifest_exact_sha256',
    'package_manifest_exact_sha256',
    'lock_exact_sha256',
    'toolchain_exact_sha256',
  ]) {
    if (!isSha256(cargo[field])) fail(`observed-build ${field} is invalid`)
  }
  if (
    cargo.rust_toolchain !== '1.91.1' ||
    cargo.rustc_version !== 'rustc 1.91.1 (ed61e7d7e 2025-11-07)' ||
    cargo.cargo_version !== 'cargo 1.91.1 (ea2d97820 2025-10-10)' ||
    canonical(cargo.argv) !== canonical(EXACT_BUILD_ARGV) ||
    cargo.profile !== 'release' ||
    canonical(cargo.target) !== canonical(BUILD_TARGET) ||
    cargo.target_directory_policy !== 'fresh-fixed-owner-private-removed-after-copy.v1' ||
    cargo.environment_policy !== 'reject-build-override-environment-and-record-output-bytes.v1'
  ) {
    fail('observed-build toolchain, arguments, profile, target, or environment policy differs')
  }
  const byPath = new Map(source.files.map((row) => [row.relative_path, row]))
  const digestJoins = {
    workspace_manifest_exact_sha256: 'src-tauri/Cargo.toml',
    package_manifest_exact_sha256: 'src-tauri/crates/managed-simulation/Cargo.toml',
    lock_exact_sha256: 'src-tauri/Cargo.lock',
    toolchain_exact_sha256: 'rust-toolchain.toml',
  }
  for (const [field, path] of Object.entries(digestJoins)) {
    if (cargo[field] !== byPath.get(path)?.sha256) {
      fail('observed-build Cargo digest differs from its Git source row')
    }
  }
  const output = exactKeys(
    receipt.output,
    new Set([
      'file_name',
      'byte_length',
      'sha256',
      'source_mode',
      'format',
      'architecture',
      'file_type',
    ]),
    'observed-build output'
  )
  if (
    output.file_name !== 'crebain-managed-simulation' ||
    !Number.isInteger(output.byte_length) ||
    output.byte_length < 1 ||
    output.byte_length > 64 * 1024 * 1024 ||
    !isSha256(output.sha256) ||
    ![0o500, 0o555, 0o700, 0o755].includes(output.source_mode) ||
    output.format !== 'mach-o-64' ||
    output.architecture !== 'arm64' ||
    output.file_type !== 'executable'
  ) {
    fail('observed-build output identity differs')
  }
  const identity = {
    repository,
    source_roster_sha256: source.roster_sha256,
    generator_roster_sha256: generator.roster_sha256,
    cargo,
  }
  if (receipt.input_identity_sha256 !== sha256(ledgerCanonical(identity))) {
    fail('observed-build input identity differs')
  }
  if (
    canonical(receipt.claims) !==
      canonical({
        observed_local_build: true,
        reproducible_build: false,
        signature: false,
        external_dependency_bytes_attested: false,
        complete_environment_attested: false,
      }) ||
    canonical(receipt.authority) !== canonical(BUILD_NO_AUTHORITY) ||
    typeof receipt.disclosure !== 'string' ||
    receipt.disclosure.length === 0
  ) {
    fail('observed-build claim or authority boundary differs')
  }
  ledgerDigest(receipt, 'receipt_sha256', 'observed-build receipt')
  return receipt
}

function assertStageInventory(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 128) {
    fail('package-stage inventory has an invalid file count')
  }
  const paths = rows.map((row) => {
    exactKeys(
      row,
      new Set(['relative_path', 'byte_length', 'sha256', 'mode', 'role']),
      'package-stage inventory row'
    )
    const path = safeRelative(row.relative_path, 'package-stage inventory path')
    if (
      !Number.isInteger(row.byte_length) ||
      row.byte_length < 1 ||
      row.byte_length > 64 * 1024 * 1024 ||
      !isSha256(row.sha256) ||
      ![0o600, 0o700].includes(row.mode) ||
      !['contract', 'executable'].includes(row.role) ||
      (row.role === 'executable' &&
        (path !== 'bin/crebain-managed-simulation' || row.mode !== 0o700)) ||
      (row.role === 'contract' &&
        (!path.startsWith('contracts/') || !path.endsWith('.schema.json') || row.mode !== 0o600))
    ) {
      fail('package-stage inventory row differs')
    }
    return path
  })
  sortedUnique(paths, 'package-stage inventory paths')
  if (rows.filter((row) => row.role === 'executable').length !== 1) {
    fail('package-stage inventory lacks one exact executable')
  }
  return rows
}

function assertStageReceipt(receipt, buildReceipt) {
  exactKeys(receipt, STAGE_RECEIPT_KEYS, 'package-stage receipt')
  if (receipt.schema_version !== 'crebain.managed-simulation-package-stage-receipt.v1') {
    fail('package-stage receipt schema differs')
  }
  const buildBytes = Buffer.from(`${canonical(buildReceipt)}\n`)
  if (
    receipt.observed_build_receipt_exact_sha256 !== sha256(buildBytes) ||
    receipt.observed_build_receipt_sha256 !== buildReceipt.receipt_sha256 ||
    receipt.crebain_commit !== buildReceipt.repository.commit ||
    receipt.crebain_tree !== buildReceipt.repository.tree ||
    receipt.origin_main !== receipt.crebain_commit ||
    canonical(receipt.target) !== canonical(BUILD_TARGET) ||
    !isSha256(receipt.recipe_exact_sha256) ||
    !isSha256(receipt.configuration_exact_sha256)
  ) {
    fail('package-stage build, Git, target, recipe, or configuration lineage differs')
  }
  const executableKeys = new Set([
    'byte_length',
    'sha256',
    'mode',
    'format',
    'architecture',
    'file_type',
  ])
  const source = exactKeys(receipt.source_executable, executableKeys, 'stage source executable')
  const staged = exactKeys(receipt.staged_executable, executableKeys, 'staged executable')
  const output = buildReceipt.output
  if (
    canonical(source) !==
      canonical({
        byte_length: output.byte_length,
        sha256: output.sha256,
        mode: output.source_mode,
        format: output.format,
        architecture: output.architecture,
        file_type: output.file_type,
      }) ||
    canonical(staged) !== canonical({ ...source, mode: 0o700 })
  ) {
    fail('package-stage executable differs from the observed build')
  }
  const inventory = assertStageInventory(receipt.package_inventory)
  const executable = inventory.find((row) => row.role === 'executable')
  if (
    canonical(executable) !==
    canonical({
      relative_path: 'bin/crebain-managed-simulation',
      byte_length: staged.byte_length,
      sha256: staged.sha256,
      mode: staged.mode,
      role: 'executable',
    })
  ) {
    fail('package-stage executable inventory differs')
  }
  if (
    receipt.package_inventory_sha256 !== sha256(ledgerCanonical(inventory)) ||
    canonical(receipt.authority) !== canonical(BUILD_NO_AUTHORITY) ||
    typeof receipt.disclosure !== 'string' ||
    receipt.disclosure.length === 0
  ) {
    fail('package-stage inventory digest or authority differs')
  }
  ledgerDigest(receipt, 'receipt_sha256', 'package-stage receipt')
  return receipt
}

function assertPackReceipt(receipt, build, stage) {
  exactKeys(receipt, PACK_RECEIPT_KEYS, 'Engram pack receipt')
  if (receipt.schema_version !== 'crebain.managed-simulation-engram-pack-receipt.v1') {
    fail('Engram pack receipt schema differs')
  }
  const repository = exactKeys(
    receipt.engram_repository,
    new Set(['origin', 'commit', 'tree', 'origin_main', 'object_format', 'clean']),
    'Engram pack repository'
  )
  const objectLength = repository.object_format === 'sha1' ? 40 : 64
  const tool = exactKeys(
    receipt.engram_tool,
    new Set(['relative_path', 'size_bytes', 'sha256', 'git_mode', 'git_blob']),
    'Engram pack tool'
  )
  const expectedOperations = [
    { operation: 'pack', exit_code: 0, source_reverified: true },
    { operation: 'check', exit_code: 0, source_reverified: true },
  ]
  const expectedClaims = {
    local_pack_observed: true,
    local_check_observed: true,
    publisher_authenticated: false,
    signature: false,
    reproducible: false,
    executed_tool_loaded_bytes_attested: false,
    complete_python_environment_attested: false,
  }
  const buildBytes = Buffer.from(`${canonical(build)}\n`)
  const stageBytes = Buffer.from(`${canonical(stage)}\n`)
  if (
    typeof repository.origin !== 'string' ||
    repository.origin.length === 0 ||
    repository.origin.includes('\n') ||
    !['sha1', 'sha256'].includes(repository.object_format) ||
    !isGitObject(repository.commit) ||
    !isGitObject(repository.tree) ||
    repository.commit.length !== objectLength ||
    repository.tree.length !== objectLength ||
    repository.origin_main !== repository.commit ||
    repository.clean !== true ||
    tool.relative_path !== 'scripts/engram_extension.py' ||
    !Number.isInteger(tool.size_bytes) ||
    tool.size_bytes < 1 ||
    tool.size_bytes > 1048576 ||
    !isSha256(tool.sha256) ||
    !['100644', '100755'].includes(tool.git_mode) ||
    !isGitObject(tool.git_blob) ||
    tool.git_blob.length !== objectLength ||
    receipt.verification_policy !==
      'clean-head-origin-main-committed-tool-before-and-after-each-operation.v1' ||
    canonical(receipt.operations) !== canonical(expectedOperations) ||
    receipt.observed_build_receipt_exact_sha256 !== sha256(buildBytes) ||
    receipt.observed_build_receipt_sha256 !== build.receipt_sha256 ||
    receipt.package_stage_receipt_exact_sha256 !== sha256(stageBytes) ||
    receipt.package_stage_receipt_sha256 !== stage.receipt_sha256 ||
    !isSha256(receipt.seal_receipt_exact_sha256) ||
    !isSha256(receipt.bundle_receipt_exact_sha256) ||
    !/^pkggen_[a-f0-9]{64}$/u.test(receipt.package_generation_id) ||
    canonical(receipt.claims) !== canonical(expectedClaims) ||
    canonical(receipt.authority) !== canonical(BUILD_NO_AUTHORITY) ||
    typeof receipt.disclosure !== 'string' ||
    receipt.disclosure.length === 0
  ) {
    fail('Engram pack source, operation, lineage, claim, or authority differs')
  }
  ledgerDigest(receipt, 'receipt_sha256', 'Engram pack receipt')
  return receipt
}

function assertInstalledProofV3(proof) {
  exactKeys(proof, INSTALLED_PROOF_V3_KEYS, 'installed-binary proof v3')
  if (proof.schema_version !== 'crebain.standard-v3-installed-binary-proof.v3') {
    fail('installed-binary proof schema differs')
  }
  const build = assertBuildReceipt(proof.observed_build_receipt)
  const stage = assertStageReceipt(proof.package_stage_receipt, build)
  const pack = assertPackReceipt(proof.engram_pack_receipt, build, stage)
  const buildBytes = Buffer.from(`${canonical(build)}\n`)
  const stageBytes = Buffer.from(`${canonical(stage)}\n`)
  const packBytes = Buffer.from(`${canonical(pack)}\n`)
  const digestFields = [
    'generation_core_sha256',
    'bundle_receipt_exact_sha256',
    'seal_receipt_exact_sha256',
    'install_observation_exact_sha256',
    'manifest_exact_sha256',
    'package_lock_exact_sha256',
    'configuration_exact_sha256',
    'package_sha256',
    'executable_sha256',
    'configuration_canonical_sha256',
    'operation_roster_sha256',
    'observed_build_receipt_exact_sha256',
    'observed_build_receipt_sha256',
    'package_stage_receipt_exact_sha256',
    'package_stage_receipt_sha256',
    'engram_pack_receipt_exact_sha256',
    'engram_pack_receipt_sha256',
    'engram_extension_tool_sha256',
    'build_source_roster_sha256',
    'build_input_identity_sha256',
    'baseline_three_controls_sha256',
  ]
  if (digestFields.some((field) => !isSha256(proof[field]))) {
    fail('installed-binary proof digest roster differs')
  }
  if (
    !/^extstore_[a-f0-9]{64}$/u.test(proof.store_id) ||
    !/^pkggen_[a-f0-9]{64}$/u.test(proof.package_generation_id) ||
    !/^inst_[a-f0-9]{64}$/u.test(proof.installation_id) ||
    proof.observed_build_receipt_exact_sha256 !== sha256(buildBytes) ||
    proof.observed_build_receipt_sha256 !== build.receipt_sha256 ||
    proof.package_stage_receipt_exact_sha256 !== sha256(stageBytes) ||
    proof.package_stage_receipt_sha256 !== stage.receipt_sha256 ||
    proof.engram_pack_receipt_exact_sha256 !== sha256(packBytes) ||
    proof.engram_pack_receipt_sha256 !== pack.receipt_sha256 ||
    proof.crebain_commit !== build.repository.commit ||
    proof.crebain_tree !== build.repository.tree ||
    proof.crebain_origin_main !== proof.crebain_commit ||
    stage.crebain_commit !== proof.crebain_commit ||
    proof.engram_commit !== pack.engram_repository.commit ||
    proof.engram_tree !== pack.engram_repository.tree ||
    proof.engram_origin_main !== proof.engram_commit ||
    proof.engram_origin_main !== pack.engram_repository.origin_main ||
    proof.engram_extension_tool_sha256 !== pack.engram_tool.sha256 ||
    proof.engram_extension_tool_git_blob !== pack.engram_tool.git_blob ||
    proof.engram_extension_tool_git_blob.length !==
      (pack.engram_repository.object_format === 'sha1' ? 40 : 64) ||
    pack.seal_receipt_exact_sha256 !== proof.seal_receipt_exact_sha256 ||
    pack.bundle_receipt_exact_sha256 !== proof.bundle_receipt_exact_sha256 ||
    pack.package_generation_id !== proof.package_generation_id ||
    proof.build_source_roster_sha256 !== build.source.roster_sha256 ||
    proof.build_input_identity_sha256 !== build.input_identity_sha256 ||
    proof.configuration_exact_sha256 !== stage.configuration_exact_sha256 ||
    proof.executable_sha256 !== build.output.sha256 ||
    proof.executable_sha256 !== stage.staged_executable.sha256 ||
    proof.executable_format !== 'mach-o-64' ||
    proof.executable_architecture !== 'arm64'
  ) {
    fail('installed-binary proof build, stage, Git, or executable lineage differs')
  }
  const expectedOperationIds = [
    'crebain.simulation.finish.v1',
    'crebain.simulation.finish.v3',
    'crebain.simulation.prepare.v1',
    'crebain.simulation.prepare.v3',
    'crebain.simulation.step.v1',
    'crebain.simulation.step.v3',
  ]
  const schemaById = {
    'engram.closed-loop-simulator.finish-request.v3':
      EXPECTED_SCHEMA_HASHES['standard-v3-finish-request.schema.json'],
    'engram.closed-loop-simulator.finish-response.v3':
      EXPECTED_SCHEMA_HASHES['standard-v3-finish-response.schema.json'],
    'engram.closed-loop-simulator.prepare-request.v3':
      EXPECTED_SCHEMA_HASHES['standard-v3-prepare-request.schema.json'],
    'engram.closed-loop-simulator.prepare-response.v3':
      EXPECTED_SCHEMA_HASHES['standard-v3-prepare-response.schema.json'],
    'engram.closed-loop-simulator.step-request.v3':
      EXPECTED_SCHEMA_HASHES['standard-v3-step-request.schema.json'],
    'engram.closed-loop-simulator.step-response.v3':
      EXPECTED_SCHEMA_HASHES['standard-v3-step-response.schema.json'],
  }
  if (
    canonical(proof.operation_ids) !== canonical(expectedOperationIds) ||
    canonical(proof.standard_schema_sha256) !== canonical(schemaById) ||
    canonical(proof.drone_counts) !== canonical([1, 2, 3]) ||
    proof.step_count !== 6 ||
    proof.fault_step !== 3 ||
    proof.fault !== 'sensor-unavailable' ||
    canonical(proof.host_policy) !==
      canonical([
        'fault-observed',
        'safe-hold',
        'bounded-zero-washout',
        'bounded-nonzero-resume',
      ]) ||
    !proof.replay_exact ||
    !proof.unaffected_lane_observations_exact ||
    proof.negative_clock_gate !== 'standard.clock-mismatch' ||
    proof.signal_cancellation_gate !== 'active-SIGTERM-then-fresh-generation-prepared' ||
    !proof.installed_artifacts_reverified_after_execution ||
    !proof.generation_seal_package_bundle_store_lineage_verified ||
    !proof.build_stage_seal_install_lineage_verified ||
    !proof.build_stage_seal_pack_install_lineage_verified ||
    canonical(proof.authority) !== canonical(SIMULATOR_ONLY_AUTHORITY) ||
    typeof proof.disclosure !== 'string' ||
    proof.disclosure.length === 0
  ) {
    fail('installed-binary proof behavior, lifecycle, or authority contract differs')
  }
  const recovery = proof.recovery_controls_sha256
  if (
    recovery === null ||
    typeof recovery !== 'object' ||
    Array.isArray(recovery) ||
    canonical([...Object.keys(recovery)].sort()) !== canonical(['1', '2', '3']) ||
    Object.values(recovery).some((value) => !isSha256(value))
  ) {
    fail('installed-binary proof recovery digest roster differs')
  }
  ledgerDigest(proof, 'receipt_sha256', 'installed-binary proof v3')
  return proof
}

function operationalInputContext(crebainSourceRepository) {
  const suiteBytes = readFileSync(resolve(OPERATIONAL_INPUTS, 'SUITE.json'))
  const suite = JSON.parse(suiteBytes)
  const configRow = suite.nest_config
  const configPath = safeRelative(configRow?.path, 'tracked NEST configuration path')
  const configBytes = readFileSync(resolve(OPERATIONAL_INPUTS, configPath))
  const plans = new Map()
  for (const row of suite.runs ?? []) {
    const path = safeRelative(row.plan_path, 'tracked run-plan path')
    plans.set(row.drone_count, {
      row,
      path,
      bytes: readFileSync(resolve(OPERATIONAL_INPUTS, path)),
    })
  }
  return {
    suite,
    suiteBytes,
    configBytes,
    toolSourceBytes: new Map(
      [...TOOL_SOURCE_ROLES].map(([path]) => [path, readFileSync(resolve(ROOT, path))])
    ),
    plans,
    crebainSourceRepository,
  }
}

function assertNestedSourceClosure(capture, index, proof) {
  const source = exactKeys(
    capture.engram_source_closure,
    new Set([
      'schema_version',
      'discovery_policy',
      'git',
      'source_roster_sha256',
      'host_modules',
      'worker_project_modules',
      'worker_project_source_roster_sha256',
      'reviewed_runtime_handshake_receipt_sha256',
      'reviewed_runtime_guardian_source_sha256',
      'reviewed_runtime_exec_gate_source_sha256',
      'reviewed_runtime_exec_gate_command_sha256',
      'exercised_entrypoints',
      'sources',
      'closure_sha256',
    ]),
    'Engram source closure'
  )
  const git = exactKeys(
    source.git,
    new Set(['repository', 'commit', 'tree', 'origin_main', 'object_format', 'clean']),
    'Engram source Git identity'
  )
  const objectLength = git.object_format === 'sha1' ? 40 : 64
  const pack = proof.engram_pack_receipt
  const packRepository = pack.engram_repository
  const packTool = pack.engram_tool
  if (
    source.schema_version !== 'crebain.engram-python-source-closure.v1' ||
    source.discovery_policy !==
      'loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1' ||
    typeof git.repository !== 'string' ||
    git.repository.length === 0 ||
    git.repository.includes('\n') ||
    git.repository !== index.engram.repository ||
    git.repository !== packRepository.origin ||
    git.commit !== index.engram.commit ||
    git.commit !== packRepository.commit ||
    git.tree !== index.engram.tree ||
    git.tree !== packRepository.tree ||
    git.origin_main !== git.commit ||
    git.object_format !== index.engram.object_format ||
    !['sha1', 'sha256'].includes(git.object_format) ||
    git.commit.length !== objectLength ||
    git.tree.length !== objectLength ||
    git.clean !== true ||
    !isSha256(source.source_roster_sha256) ||
    !isSha256(source.worker_project_source_roster_sha256) ||
    !isSha256(source.reviewed_runtime_handshake_receipt_sha256) ||
    !isSha256(source.reviewed_runtime_guardian_source_sha256) ||
    !isSha256(source.reviewed_runtime_exec_gate_source_sha256) ||
    !isSha256(source.reviewed_runtime_exec_gate_command_sha256)
  ) {
    fail('Engram source closure identity differs')
  }
  assertSourceRows(source.sources, 'Engram source closure roster', false, 0, 1024)
  const stableRosterSha256 = sha256(
    Buffer.concat([
      Buffer.from('crebain.engram-source-roster.v1\0'),
      Buffer.from(ledgerCanonical(source.sources)),
    ])
  )
  if (source.source_roster_sha256 !== stableRosterSha256) {
    fail('Engram source roster digest differs')
  }
  if (source.sources.some((row) => row.git_blob.length !== objectLength)) {
    fail('Engram source closure Git object format differs')
  }
  assertModuleRows(source.host_modules, 'Engram host module roster')
  assertModuleRows(source.worker_project_modules, 'Engram worker module roster')
  assertPathRows(
    source.exercised_entrypoints,
    new Set(['role', 'relative_path']),
    'Engram exercised entrypoint roster',
    ['role', 'relative_path']
  )
  const paths = new Set(source.sources.map((row) => row.relative_path))
  const nestedRows = [
    ...source.host_modules,
    ...source.worker_project_modules,
    ...source.exercised_entrypoints,
  ]
  const nestedPaths = new Set(nestedRows.map((row) => row.relative_path))
  if (
    canonical([...paths].sort()) !== canonical([...nestedPaths].sort()) ||
    canonical(source.host_modules.map((row) => row.module_name).sort()) !==
      canonical(REQUIRED_HOST_MODULES) ||
    canonical(source.worker_project_modules.map((row) => row.module_name).sort()) !==
      canonical(REQUIRED_WORKER_MODULES) ||
    [...source.host_modules, ...source.worker_project_modules].some(
      (row) => !expectedModulePath(row.module_name, row.relative_path)
    ) ||
    canonical(source.exercised_entrypoints) !== canonical(EXERCISED_ENTRYPOINTS)
  ) {
    fail('nested Engram source closure differs')
  }
  const packRows = source.sources.filter(
    (row) => row.relative_path === 'scripts/engram_extension.py'
  )
  const reviewedGuardianRows = source.sources.filter(
    (row) => row.relative_path === 'backend/integrations/reviewed_native_process_guardian.py'
  )
  const reviewedExecGateRows = source.sources.filter(
    (row) => row.relative_path === 'backend/integrations/contained_exec_gate.py'
  )
  const packModules = source.host_modules.filter(
    (row) =>
      row.module_name === 'scripts.engram_extension' &&
      row.relative_path === 'scripts/engram_extension.py'
  )
  if (
    packRows.length !== 1 ||
    canonical(packRows[0]) !== canonical(packTool) ||
    packModules.length !== 1 ||
    reviewedGuardianRows.length !== 1 ||
    reviewedGuardianRows[0].sha256 !== source.reviewed_runtime_guardian_source_sha256 ||
    reviewedExecGateRows.length !== 1 ||
    reviewedExecGateRows[0].sha256 !== source.reviewed_runtime_exec_gate_source_sha256
  ) {
    fail('Engram pack tool differs from the loaded committed source closure')
  }
  const sourceDigestMap = Object.fromEntries(
    source.sources.map((row) => [row.relative_path, row.sha256])
  )
  if (canonical(capture.engram_source_sha256) !== canonical(sourceDigestMap)) {
    fail('capture Engram source digest map differs')
  }
  ledgerDigest(source, 'closure_sha256', 'Engram source closure')
  return source
}

function assertReceiptStoreSidecars(sidecars, storeId, terminal, evidence, capture) {
  exactKeys(
    sidecars,
    new Set([
      'schema_version',
      'store_metadata',
      'finalized_reservation',
      'observation',
      'publication_admission_anchor',
      'publication_authority',
      'closure_sha256',
    ]),
    'closed-loop receipt-store sidecars'
  )
  if (sidecars.schema_version !== 'crebain.closed-loop-receipt-store-sidecars.v1') {
    fail('closed-loop receipt-store sidecar schema differs')
  }
  ledgerDigest(sidecars, 'closure_sha256', 'closed-loop receipt-store sidecars')
  const metadata = exactKeys(
    sidecars.store_metadata,
    new Set([
      'schema_version',
      'store_id',
      'policy',
      'digest_canonicalization',
      'execution_authority',
      'ncp_control',
      'physical_actuation',
      'scientific_authority',
      'is_paper_local_evidence',
      'calibrated_posterior',
    ]),
    'closed-loop receipt-store metadata'
  )
  const finalization = exactKeys(
    sidecars.finalized_reservation,
    new Set([
      'schema_version',
      'store_id',
      'reservation',
      'pre_spawn_sha256',
      'extension_dispatch_sha256',
      'simulation_dispatch_sha256',
      'terminal_receipt_sha256',
      'evidence_bundle_sha256',
      'nest_work_admission_rejoined',
      'execution_authority',
      'ncp_control',
      'physical_actuation',
      'scientific_authority',
      'is_paper_local_evidence',
      'calibrated_posterior',
      'finalization_sha256',
    ]),
    'closed-loop finalized reservation'
  )
  const reservation = exactKeys(
    finalization.reservation,
    new Set([
      'schema_version',
      'store_id',
      'reservation_id',
      'study_run_id',
      'closed_loop_definition_sha256',
      'receipt_profile',
      'evidence_profile',
      'nest_work_admission_sha256',
      'pre_spawn_sha256',
      'run_plan_sha256',
      'nest_configuration_sha256',
      'expected_runtime_binding_sha256',
      'reviewed_native_handshake_receipt_sha256',
      'reviewed_native_handshake',
      'package_generation_id',
      'runtime_generation_id',
      'reserved_record_count',
      'reserved_artifact_bytes',
      'reserved_evidence_bytes',
      'reserved_record_bytes',
      'execution_authority',
      'ncp_control',
      'physical_actuation',
      'scientific_authority',
      'is_paper_local_evidence',
      'calibrated_posterior',
      'reservation_sha256',
    ]),
    'closed-loop receipt reservation'
  )
  const observation = exactKeys(
    sidecars.observation,
    new Set([
      'schema_version',
      'store_id',
      'artifact',
      'study_run_id',
      'run_status',
      'terminal_reason_code',
      'relative_artifact_path',
      'artifact_byte_length',
      'evidence_profile',
      'evidence_bundle_sha256',
      'relative_evidence_path',
      'evidence_byte_length',
      'admission_mode',
      'publication_authority_sha256',
      'reservation_id',
      'reservation_sha256',
      'reservation_finalization_sha256',
      'nest_work_admission_sha256',
      'nest_work_admission_rejoined',
      'digest_canonicalization',
      'execution_authority',
      'ncp_control',
      'physical_actuation',
      'scientific_authority',
      'is_paper_local_evidence',
      'calibrated_posterior',
      'record_sha256',
    ]),
    'closed-loop receipt observation'
  )
  const anchor = exactKeys(
    sidecars.publication_admission_anchor,
    new Set([
      'schema_version',
      'store_id',
      'study_run_key_sha256',
      'study_run_id',
      'terminal_receipt_sha256',
      'admission_mode',
      'publication_wal_sha256',
      'evidence_bundle_sha256',
      'reservation_id',
      'reservation_sha256',
      'pre_spawn_sha256',
      'extension_dispatch_sha256',
      'simulation_dispatch_sha256',
      'reservation_finalization_sha256',
      'execution_authority',
      'ncp_control',
      'physical_actuation',
      'scientific_authority',
      'is_paper_local_evidence',
      'calibrated_posterior',
      'anchor_sha256',
    ]),
    'closed-loop publication admission anchor'
  )
  const authority = exactKeys(
    sidecars.publication_authority,
    new Set([
      'schema_version',
      'store_id',
      'terminal_receipt_sha256',
      'study_run_id',
      'admission_mode',
      'publication_admission_anchor_sha256',
      'publication_wal_sha256',
      'evidence_bundle_sha256',
      'reservation_id',
      'reservation_sha256',
      'reservation_finalization_sha256',
      'nest_work_admission_sha256',
      'execution_authority',
      'ncp_control',
      'physical_actuation',
      'scientific_authority',
      'is_paper_local_evidence',
      'calibrated_posterior',
      'authority_sha256',
    ]),
    'closed-loop publication authority'
  )
  assertNoAuthorityEscalation(sidecars, 'closed-loop receipt-store sidecars')
  for (const [document, field, label] of [
    [reservation, 'reservation_sha256', 'closed-loop receipt reservation'],
    [finalization, 'finalization_sha256', 'closed-loop finalized reservation'],
    [observation, 'record_sha256', 'closed-loop receipt observation'],
    [anchor, 'anchor_sha256', 'closed-loop publication admission anchor'],
    [authority, 'authority_sha256', 'closed-loop publication authority'],
  ]) {
    managedRuntimeDigest(document, field, label)
  }
  const receiptBody = Buffer.from(
    managedRuntimeCanonical(terminal, undefined, undefined, 'receipt_sha256')
  )
  const evidenceBody = Buffer.from(
    managedRuntimeCanonical(evidence, undefined, undefined, 'bundle_sha256')
  )
  if (
    sha256(receiptBody) !== terminal.receipt_sha256 ||
    sha256(evidenceBody) !== evidence.bundle_sha256
  ) {
    fail('receipt-store artifact digests differ from canonical material')
  }
  const reservationId = reservation.reservation_id
  const studyRunId = terminal.study_run_id
  if (!/^clrr_[a-f0-9]{64}$/u.test(reservationId) || typeof studyRunId !== 'string') {
    fail('closed-loop receipt-store run or reservation identity differs')
  }
  const workAdmission = evidence.nest_session_readback?.work_admission
  if (workAdmission === null || typeof workAdmission !== 'object' || Array.isArray(workAdmission)) {
    fail('closed-loop receipt-store evidence lacks NEST work admission')
  }
  const workAdmissionSha256 = ledgerDigest(workAdmission, 'receipt_sha256', 'NEST work admission')
  const handshake = reservation.reviewed_native_handshake
  exactKeys(handshake, REVIEWED_HANDSHAKE_KEYS, 'reserved reviewed-native handshake')
  const handshakeSha256 = ledgerDigest(
    handshake,
    'receipt_sha256',
    'reserved reviewed-native handshake'
  )
  const simulationDispatchSha256 = sha256(
    Buffer.from(
      managedRuntimeCanonical({
        schema_version: 'engram.extension-closed-loop-dispatch-intent.v1',
        store_id: storeId,
        reservation_id: reservationId,
        reservation_sha256: reservation.reservation_sha256,
      })
    )
  )
  const extensionDispatchSha256 = sha256(
    Buffer.from(
      managedRuntimeCanonical({
        schema_version: 'engram.extension-closed-loop-extension-dispatch-intent.v1',
        store_id: storeId,
        reservation_id: reservationId,
        pre_spawn_sha256: reservation.pre_spawn_sha256,
      })
    )
  )
  const publicationWalSha256 = sha256(
    Buffer.from(
      managedRuntimeCanonical({
        domain: 'engram-extension-closed-loop-reserved-publication-wal-closure-v1',
        store_id: storeId,
        reservation_id: reservationId,
        pre_spawn_sha256: reservation.pre_spawn_sha256,
        extension_dispatch_sha256: extensionDispatchSha256,
        reservation_sha256: reservation.reservation_sha256,
        simulation_dispatch_sha256: simulationDispatchSha256,
        terminal_receipt_sha256: terminal.receipt_sha256,
      })
    )
  )
  const studyRunKeySha256 = sha256(
    Buffer.from(
      managedRuntimeCanonical({
        domain: 'engram-extension-closed-loop-publication-study-run-key-v1',
        store_id: storeId,
        study_run_id: studyRunId,
      })
    )
  )
  const receiptPath = `receipts/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const evidencePath = `evidence/${evidence.bundle_sha256.slice(0, 2)}/${evidence.bundle_sha256}.json`
  const finalizationPath = `finalized-reservations/${reservationId.slice(5, 7)}/${reservationId}.json`
  const observationPath = `observations/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const anchorPath = `publication-admission-anchors/${studyRunKeySha256}.json`
  const authorityPath = `publication-authorities/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const expectedArtifact = {
    artifact_id: `art_${terminal.receipt_sha256.slice(0, 32)}`,
    kind: 'closed_loop_receipt',
    sha256: terminal.receipt_sha256,
  }
  if (
    metadata.schema_version !== 'engram.extension-closed-loop-receipt-store.v5' ||
    metadata.store_id !== storeId ||
    metadata.policy !== 'engram.extension-closed-loop-receipt-store-policy.v5' ||
    metadata.digest_canonicalization !== 'engram.managed-runtime-json.v1' ||
    reservation.schema_version !== 'engram.extension-closed-loop-receipt-reservation.v1' ||
    reservation.store_id !== storeId ||
    reservation.study_run_id !== studyRunId ||
    reservation.closed_loop_definition_sha256 !== terminal.closed_loop_definition_sha256 ||
    workAdmission.closed_loop_definition_sha256 !== terminal.closed_loop_definition_sha256 ||
    workAdmission.planned_step_count !== terminal.planned_step_count ||
    evidence.study_run_id !== studyRunId ||
    evidence.run_receipt_sha256 !== terminal.receipt_sha256 ||
    reservation.receipt_profile !== 'engram.extension-closed-loop-run-receipt.v2' ||
    ![
      'engram.nest-closed-loop-evidence-bundle.v2',
      'optional-engram.nest-closed-loop-evidence-bundle.v2',
    ].includes(reservation.evidence_profile) ||
    reservation.nest_work_admission_sha256 !== workAdmissionSha256 ||
    reservation.nest_configuration_sha256 !== workAdmission.controller_configuration_sha256 ||
    reservation.expected_runtime_binding_sha256 !== terminal.runtime_binding_sha256 ||
    reservation.reviewed_native_handshake_receipt_sha256 !== handshakeSha256 ||
    canonical(handshake) !== canonical(capture.reviewed_native_runtime?.handshake_receipt) ||
    reservation.package_generation_id !== capture.package_generation_id ||
    reservation.runtime_generation_id !== terminal.runtime_lifecycle?.generation_id ||
    reservation.run_plan_sha256 !==
      sha256(Buffer.from(managedRuntimeCanonical(capture.run_plan))) ||
    reservation.nest_configuration_sha256 !==
      sha256(Buffer.from(ledgerCanonical(capture.nest_config))) ||
    !Number.isSafeInteger(reservation.reserved_record_count) ||
    reservation.reserved_record_count !== 1 ||
    reservation.reserved_record_bytes !== 4096 ||
    reservation.reserved_artifact_bytes !== 16 * 1024 * 1024 ||
    !Number.isSafeInteger(workAdmission.estimated_evidence_bundle_bytes) ||
    workAdmission.estimated_evidence_bundle_bytes < 1 ||
    !Number.isSafeInteger(reservation.reserved_evidence_bytes) ||
    reservation.reserved_evidence_bytes !== workAdmission.estimated_evidence_bundle_bytes ||
    !isSha256(reservation.pre_spawn_sha256) ||
    finalization.schema_version !== 'engram.extension-closed-loop-finalized-reservation.v1' ||
    finalization.store_id !== storeId ||
    finalization.pre_spawn_sha256 !== reservation.pre_spawn_sha256 ||
    finalization.extension_dispatch_sha256 !== extensionDispatchSha256 ||
    finalization.simulation_dispatch_sha256 !== simulationDispatchSha256 ||
    finalization.terminal_receipt_sha256 !== terminal.receipt_sha256 ||
    finalization.evidence_bundle_sha256 !== evidence.bundle_sha256 ||
    finalization.nest_work_admission_rejoined !== true
  ) {
    fail('closed-loop receipt-store reservation lineage differs')
  }
  exactKeys(observation.artifact, new Set(['artifact_id', 'kind', 'sha256']), 'stored artifact')
  if (
    canonical(observation.artifact) !== canonical(expectedArtifact) ||
    observation.schema_version !== 'engram.extension-closed-loop-stored-receipt.v5' ||
    observation.store_id !== storeId ||
    observation.study_run_id !== studyRunId ||
    observation.run_status !== terminal.status ||
    observation.terminal_reason_code !== terminal.terminal_reason_code ||
    observation.relative_artifact_path !== receiptPath ||
    observation.artifact_byte_length !== receiptBody.length ||
    observation.evidence_profile !== 'killable-nest-population-controller-v2' ||
    observation.evidence_bundle_sha256 !== evidence.bundle_sha256 ||
    observation.relative_evidence_path !== evidencePath ||
    observation.evidence_byte_length !== evidenceBody.length ||
    observation.admission_mode !== 'reserved' ||
    observation.reservation_id !== reservationId ||
    observation.reservation_sha256 !== reservation.reservation_sha256 ||
    observation.reservation_finalization_sha256 !== finalization.finalization_sha256 ||
    observation.nest_work_admission_sha256 !== workAdmissionSha256 ||
    observation.nest_work_admission_rejoined !== true ||
    observation.digest_canonicalization !== 'engram.managed-runtime-json.v1'
  ) {
    fail('closed-loop receipt-store observation lineage differs')
  }
  if (
    anchor.schema_version !== 'engram.extension-closed-loop-publication-admission-anchor.v1' ||
    anchor.store_id !== storeId ||
    anchor.study_run_key_sha256 !== studyRunKeySha256 ||
    anchor.study_run_id !== studyRunId ||
    anchor.terminal_receipt_sha256 !== terminal.receipt_sha256 ||
    anchor.admission_mode !== 'reserved' ||
    anchor.publication_wal_sha256 !== publicationWalSha256 ||
    anchor.evidence_bundle_sha256 !== evidence.bundle_sha256 ||
    anchor.reservation_id !== reservationId ||
    anchor.reservation_sha256 !== reservation.reservation_sha256 ||
    anchor.pre_spawn_sha256 !== reservation.pre_spawn_sha256 ||
    anchor.extension_dispatch_sha256 !== extensionDispatchSha256 ||
    anchor.simulation_dispatch_sha256 !== simulationDispatchSha256 ||
    anchor.reservation_finalization_sha256 !== finalization.finalization_sha256 ||
    authority.schema_version !== 'engram.extension-closed-loop-publication-authority.v1' ||
    authority.store_id !== storeId ||
    authority.terminal_receipt_sha256 !== terminal.receipt_sha256 ||
    authority.study_run_id !== studyRunId ||
    authority.admission_mode !== 'reserved' ||
    authority.publication_admission_anchor_sha256 !== anchor.anchor_sha256 ||
    authority.publication_wal_sha256 !== publicationWalSha256 ||
    authority.evidence_bundle_sha256 !== evidence.bundle_sha256 ||
    authority.reservation_id !== reservationId ||
    authority.reservation_sha256 !== reservation.reservation_sha256 ||
    authority.reservation_finalization_sha256 !== finalization.finalization_sha256 ||
    authority.nest_work_admission_sha256 !== workAdmissionSha256 ||
    observation.publication_authority_sha256 !== authority.authority_sha256
  ) {
    fail('closed-loop receipt-store publication authority lineage differs')
  }
  return {
    reservation,
    material: new Map([
      ['store.json', Buffer.from(managedRuntimeCanonical(metadata))],
      ['writer.lock', RECEIPT_STORE_LOCK_PAYLOAD],
      [receiptPath, receiptBody],
      [evidencePath, evidenceBody],
      [finalizationPath, Buffer.from(managedRuntimeCanonical(finalization))],
      [observationPath, Buffer.from(managedRuntimeCanonical(observation))],
      [anchorPath, Buffer.from(managedRuntimeCanonical(anchor))],
      [authorityPath, Buffer.from(managedRuntimeCanonical(authority))],
    ]),
  }
}

function assertReceiptStoreClosure(store, sidecars, terminal, evidence, capture) {
  exactKeys(
    store,
    new Set([
      'schema_version',
      'store_id',
      'receipt_sha256',
      'receipt_artifact_path',
      'evidence_bundle_sha256',
      'evidence_artifact_path',
      'file_count',
      'total_bytes',
      'files',
      'closure_sha256',
    ]),
    'closed-loop receipt-store closure'
  )
  if (store.schema_version !== 'crebain.closed-loop-receipt-store-closure.v1') {
    fail('closed-loop receipt-store closure schema differs')
  }
  assertPathRows(
    store.files,
    new Set(['relative_path', 'size_bytes', 'sha256']),
    'closed-loop receipt-store file roster'
  )
  const receiptPath = `receipts/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const evidencePath = `evidence/${evidence.bundle_sha256.slice(0, 2)}/${evidence.bundle_sha256}.json`
  const { material, reservation } = assertReceiptStoreSidecars(
    sidecars,
    store.store_id,
    terminal,
    evidence,
    capture
  )
  const expectedFiles = [...material.entries()]
    .map(([relative_path, payload]) => ({
      relative_path,
      size_bytes: payload.length,
      sha256: sha256(payload),
    }))
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  if (
    !/^clrs_[a-f0-9]{64}$/u.test(store.store_id) ||
    store.files.length !== 8 ||
    store.files.some(
      (row) =>
        !Number.isInteger(row.size_bytes) ||
        row.size_bytes < 0 ||
        row.size_bytes > 16 * 1024 * 1024 ||
        !isSha256(row.sha256)
    ) ||
    store.file_count !== store.files.length ||
    store.total_bytes !== store.files.reduce((sum, row) => sum + row.size_bytes, 0) ||
    store.receipt_artifact_path !== receiptPath ||
    store.evidence_artifact_path !== evidencePath ||
    canonical(store.files) !== canonical(expectedFiles) ||
    store.receipt_sha256 !== terminal.receipt_sha256 ||
    store.evidence_bundle_sha256 !== evidence.bundle_sha256
  ) {
    fail('closed-loop receipt-store closure identity differs')
  }
  ledgerDigest(store, 'closure_sha256', 'closed-loop receipt-store closure')
  return { store, reservation }
}

export function assertWorkerGuardianClosure(guardian, evidence, source) {
  exactKeys(
    guardian,
    new Set([
      'worker_session_binding_receipt_sha256',
      'worker_runtime_identity_receipt_sha256',
      'worker_lifecycle_receipt_sha256',
      'termination_attempt_count',
      'termination_attempt_roster_sha256',
      'worker_pid',
      'worker_source_sha256',
      'worker_command_sha256',
      'child_reaped',
      'containment_empty',
      'diagnostic_stream_complete',
    ]),
    'NEST worker guardian closure'
  )
  const binding = evidence.worker_session_binding
  const lifecycle = evidence.worker_lifecycle_receipt
  const identity = evidence.worker_runtime_identity
  const attempts = evidence.worker_termination_attempt_receipts
  const session = evidence.nest_session_readback
  if (
    evidence.worker_terminal_disposition !== 'confirmed-lifecycle' ||
    binding === null ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    lifecycle === null ||
    typeof lifecycle !== 'object' ||
    Array.isArray(lifecycle) ||
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    session === null ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    !Array.isArray(attempts) ||
    attempts.length < 1 ||
    attempts.length > 16
  ) {
    fail('NEST worker guardian lifecycle is incomplete')
  }
  const bindingDigest = ledgerDigest(binding, 'receipt_sha256', 'NEST worker session binding')
  const lifecycleDigest = ledgerDigest(lifecycle, 'receipt_sha256', 'NEST worker lifecycle receipt')
  const identityDigest = ledgerDigest(identity, 'receipt_sha256', 'NEST worker runtime identity')
  const sessionDigest = ledgerDigest(session, 'receipt_sha256', 'NEST session readback')
  const attemptsDigest = sha256(ledgerCanonical(attempts))
  const runtimeFiles = identity.files
  const requiredFiles = evidence.runtime_launch_expectation?.required_runtime_files
  const projectRoles = REQUIRED_WORKER_MODULES.map((moduleName) => `project-module:${moduleName}`)
  const identityExternalRoles = [
    'nest-package-init',
    'nest-pynestkernel-native',
    'pydantic-core-native',
    'pydantic-package-init',
    'python-executable',
    'worker-source',
  ]
  const expectationExternalRoles = [
    'pydantic-core-native',
    'pydantic-package-init',
    'python-executable',
    'worker-source',
  ]
  if (
    !Array.isArray(runtimeFiles) ||
    !Array.isArray(requiredFiles) ||
    canonical(runtimeFiles.map((row) => row?.role)) !==
      canonical([...projectRoles, ...identityExternalRoles]) ||
    canonical(requiredFiles.map((row) => row?.role)) !==
      canonical([...projectRoles, ...expectationExternalRoles]) ||
    runtimeFiles.some(
      (row) =>
        row === null ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        canonical(Object.keys(row).sort()) !==
          canonical(['absolute_path', 'role', 'sha256', 'size_bytes']) ||
        typeof row.absolute_path !== 'string' ||
        !row.absolute_path.startsWith('/') ||
        !Number.isSafeInteger(row.size_bytes) ||
        row.size_bytes < 0 ||
        row.size_bytes > 67108864 ||
        !isSha256(row.sha256)
    ) ||
    identity.file_roster_sha256 !== sha256(ledgerCanonical(runtimeFiles)) ||
    identity.project_source_roster_sha256 !==
      sha256(ledgerCanonical(runtimeFiles.slice(0, projectRoles.length))) ||
    identity.project_source_closure_verified !== true ||
    identity.external_dependency_closure_attested !== false ||
    identity.response_bound_loaded_bytes !== false ||
    identity.loaded_bytes_attested !== false ||
    evidence.runtime_launch_expectation.required_runtime_file_roster_sha256 !==
      sha256(ledgerCanonical(requiredFiles)) ||
    evidence.runtime_launch_expectation.required_project_source_roster_sha256 !==
      sha256(ledgerCanonical(requiredFiles.slice(0, projectRoles.length)))
  ) {
    fail('NEST worker runtime file closure differs')
  }
  const identityByRole = new Map(runtimeFiles.map((row) => [row.role, row]))
  if (requiredFiles.some((row) => canonical(identityByRole.get(row.role)) !== canonical(row))) {
    fail('NEST launch required files differ from the worker observation')
  }
  const expectation = evidence.runtime_launch_expectation
  const launch = evidence.worker_launch_attempt
  const resourceLimits = identity.resource_limits
  if (
    resourceLimits === null ||
    typeof resourceLimits !== 'object' ||
    Array.isArray(resourceLimits)
  ) {
    fail('NEST worker resource-limit receipt is absent')
  }
  const resourceLimitDigest = ledgerDigest(
    resourceLimits,
    'receipt_sha256',
    'NEST worker resource limits'
  )
  if (
    canonical(identity.sys_path) !== canonical(expectation.sys_path) ||
    canonical(identity.environment) !== canonical(expectation.environment) ||
    resourceLimits.profile !== expectation.resource_limit_profile ||
    resourceLimits.platform !== expectation.platform ||
    resourceLimits.address_space_bytes !== expectation.address_space_bytes ||
    resourceLimits.address_space_limit_enforced !== expectation.address_space_limit_enforced ||
    resourceLimits.cpu_time_seconds !== expectation.cpu_time_seconds ||
    resourceLimits.file_size_bytes !== expectation.file_size_bytes ||
    resourceLimits.open_file_count !== expectation.open_file_count ||
    resourceLimits.core_file_bytes !== expectation.core_file_bytes ||
    lifecycle.resource_limit_receipt_sha256 !== resourceLimitDigest
  ) {
    fail('NEST worker launch environment or resource-limit lineage differs')
  }
  const sourceByPath = new Map(source.sources.map((row) => [row.relative_path, row]))
  for (const moduleName of REQUIRED_WORKER_MODULES) {
    const moduleRow = source.worker_project_modules.find((row) => row.module_name === moduleName)
    const runtimeRow = identityByRole.get(`project-module:${moduleName}`)
    const sourceRow =
      moduleRow === undefined ? undefined : sourceByPath.get(moduleRow.relative_path)
    if (
      moduleRow === undefined ||
      runtimeRow === undefined ||
      sourceRow === undefined ||
      runtimeRow.sha256 !== sourceRow.sha256 ||
      runtimeRow.size_bytes !== sourceRow.size_bytes
    ) {
      fail('NEST worker runtime project source differs from the committed source closure')
    }
  }
  const workerSource = identityByRole.get('worker-source')
  const workerSourceRow = sourceByPath.get(
    'backend/optimization/extension_closed_loop_nest_worker.py'
  )
  const guardianSource = evidence.runtime_launch_expectation?.guardian_source_file
  const guardianSourceRow = sourceByPath.get(
    'backend/optimization/extension_closed_loop_nest_guardian.py'
  )
  const execGateSource = evidence.runtime_launch_expectation?.exec_gate_source_file
  const execGateSourceRow = sourceByPath.get('backend/integrations/contained_exec_gate.py')
  const adapterSource = identityByRole.get(
    'project-module:backend.optimization.extension_closed_loop_nest_process'
  )
  if (
    workerSource === undefined ||
    workerSourceRow === undefined ||
    workerSource.sha256 !== workerSourceRow.sha256 ||
    workerSource.size_bytes !== workerSourceRow.size_bytes ||
    guardianSource?.role !== 'guardian-source' ||
    guardianSourceRow === undefined ||
    guardianSource.sha256 !== guardianSourceRow.sha256 ||
    guardianSource.size_bytes !== guardianSourceRow.size_bytes ||
    execGateSource?.role !== 'exec-gate-source' ||
    execGateSourceRow === undefined ||
    execGateSource.sha256 !== execGateSourceRow.sha256 ||
    execGateSource.size_bytes !== execGateSourceRow.size_bytes ||
    adapterSource === undefined ||
    expectation.adapter_source_sha256 !== adapterSource.sha256 ||
    evidence.runtime_launch_expectation.worker_source_sha256 !== workerSource.sha256 ||
    evidence.runtime_launch_expectation.guardian_source_sha256 !== guardianSource.sha256 ||
    evidence.runtime_launch_expectation.exec_gate_source_sha256 !== execGateSource.sha256 ||
    binding.worker_source_sha256 !== workerSource.sha256 ||
    binding.guardian_source_sha256 !== guardianSource.sha256 ||
    binding.adapter_source_sha256 !== adapterSource.sha256
  ) {
    fail('NEST worker entrypoint or containment source closure differs')
  }
  const generationIdentity = [
    expectation.receipt_sha256,
    launch.receipt_sha256,
    expectation.worker_source_sha256,
    expectation.guardian_source_sha256,
    expectation.adapter_source_sha256,
    expectation.worker_command_sha256,
    launch.worker_pid,
    launch.guardian_pid,
    launch.process_group_id,
    launch.session_id,
  ]
  if (
    canonical([
      lifecycle.runtime_launch_expectation_sha256,
      lifecycle.worker_launch_attempt_sha256,
      lifecycle.worker_source_sha256,
      lifecycle.guardian_source_sha256,
      lifecycle.adapter_source_sha256,
      lifecycle.worker_command_sha256,
      lifecycle.worker_pid,
      lifecycle.guardian_pid,
      lifecycle.process_group_id,
      lifecycle.session_id,
    ]) !== canonical(generationIdentity)
  ) {
    fail('NEST worker lifecycle generation identity differs')
  }
  if (
    canonical(lifecycle.termination_attempts) !== canonical(attempts) ||
    lifecycle.session_binding_receipt_sha256 !== bindingDigest ||
    lifecycle.runtime_identity_receipt_sha256 !== identityDigest ||
    binding.worker_runtime_identity_sha256 !== identityDigest ||
    binding.child_session_receipt_sha256 !== sessionDigest ||
    binding.child_lineage_verified !== true ||
    binding.loaded_bytes_attested !== false ||
    binding.response_bound_loaded_bytes !== false ||
    binding.ncp_transport !== false ||
    binding.scientific_authority !== false ||
    identity.project_source_roster_sha256 !== source.worker_project_source_roster_sha256 ||
    lifecycle.termination_attempt_roster_sha256 !== attemptsDigest ||
    lifecycle.child_reaped !== true ||
    lifecycle.containment_empty !== true ||
    lifecycle.diagnostic_stream_complete !== true ||
    lifecycle.hard_deadline_enforcement !== true ||
    lifecycle.ncp_transport !== false ||
    lifecycle.physical_authority !== false ||
    lifecycle.scientific_authority !== false
  ) {
    fail('NEST worker guardian terminal closure differs')
  }
  const checkedAttempts = []
  for (const [index, attempt] of attempts.entries()) {
    if (attempt === null || typeof attempt !== 'object' || Array.isArray(attempt)) {
      fail('NEST worker termination attempt is not an object')
    }
    ledgerDigest(attempt, 'receipt_sha256', 'NEST worker termination attempt')
    if (
      attempt.attempt_index !== index + 1 ||
      attempt.schema_version !== 'engram.nest-worker-termination-attempt.v1' ||
      canonical([
        attempt.runtime_launch_expectation_sha256,
        attempt.worker_launch_attempt_sha256,
        attempt.worker_source_sha256,
        attempt.guardian_source_sha256,
        attempt.adapter_source_sha256,
        attempt.worker_command_sha256,
        attempt.worker_pid,
        attempt.guardian_pid,
        attempt.process_group_id,
        attempt.session_id,
      ]) !== canonical(generationIdentity) ||
      !Number.isInteger(attempt.request_count) ||
      attempt.request_count < 0 ||
      attempt.request_count > 4096 ||
      !Number.isInteger(attempt.response_count) ||
      attempt.response_count < 0 ||
      attempt.response_count > attempt.request_count ||
      attempt.process_group_id !== attempt.worker_pid ||
      attempt.guardian_pid === attempt.process_group_id ||
      attempt.group_signal_while_guardian_unreaped !==
        (attempt.group_signal_basis === 'guardian-group-anchor-unreaped') ||
      attempt.group_signal_attempted !==
        (attempt.group_signal_basis !== 'none' && attempt.containment_seal_signal === 9) ||
      (attempt.containment_empty === true && attempt.anchored_group_kill_delivered !== true) ||
      (attempt.group_signal_basis === 'guardian-group-anchor-unreaped' &&
        attempt.guardian_unexpected_exit_observed !== false) ||
      (attempt.group_signal_basis === 'worker-group-leader-unreaped' &&
        attempt.guardian_unexpected_exit_observed !== true) ||
      attempt.child_reaped !== true ||
      attempt.containment_empty !== true ||
      attempt.diagnostic_stream_complete !== true ||
      attempt.hard_deadline_enforcement !== true ||
      attempt.ncp_transport !== false ||
      attempt.physical_authority !== false ||
      attempt.scientific_authority !== false
    ) {
      fail('NEST worker termination attempt lineage differs')
    }
    checkedAttempts.push(attempt)
  }
  const finalAttempt = checkedAttempts.at(-1)
  const finalProjectionFields = [
    'disposition',
    'reason_code',
    'exit_code',
    'termination_signal',
    'guardian_unexpected_exit_observed',
    'stderr_sha256',
    'stderr_retained_bytes',
    'stderr_truncated',
    'request_count',
    'response_count',
  ]
  if (
    lifecycle.schema_version !== 'engram.nest-worker-lifecycle-receipt.v2' ||
    !Number.isInteger(lifecycle.request_count) ||
    lifecycle.request_count < 0 ||
    lifecycle.request_count > 4096 ||
    !Number.isInteger(lifecycle.response_count) ||
    lifecycle.response_count < 0 ||
    lifecycle.response_count > lifecycle.request_count ||
    lifecycle.process_group_id !== lifecycle.worker_pid ||
    lifecycle.guardian_pid === lifecycle.process_group_id ||
    !checkedAttempts.some((attempt) => attempt.anchored_group_kill_delivered === true) ||
    lifecycle.runtime_identity_receipt_sha256 == null ||
    lifecycle.resource_limit_receipt_sha256 == null ||
    finalProjectionFields.some((field) => finalAttempt[field] !== lifecycle[field]) ||
    ['child_reaped', 'guardian_reaped', 'containment_empty', 'diagnostic_stream_complete'].some(
      (field) => finalAttempt[field] !== true
    )
  ) {
    fail('NEST worker lifecycle differs from its terminal attempt')
  }
  const expected = {
    worker_session_binding_receipt_sha256: bindingDigest,
    worker_runtime_identity_receipt_sha256: identityDigest,
    worker_lifecycle_receipt_sha256: lifecycleDigest,
    termination_attempt_count: attempts.length,
    termination_attempt_roster_sha256: attemptsDigest,
    worker_pid: lifecycle.worker_pid,
    worker_source_sha256: lifecycle.worker_source_sha256,
    worker_command_sha256: lifecycle.worker_command_sha256,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
  }
  if (canonical(guardian) !== canonical(expected)) {
    fail('NEST worker guardian closure summary differs')
  }
  return guardian
}

function expectedPopulationTopology(capture) {
  const channels = capture.run_plan?.channels
  const populationSize = capture.nest_config?.population_size
  if (
    !Array.isArray(channels) ||
    channels.length < 1 ||
    channels.length > 3 ||
    !Number.isInteger(populationSize) ||
    populationSize < 1
  ) {
    fail('capture run plan or NEST population size differs')
  }
  const channelIds = []
  const populationNames = []
  const populationBindings = new Map()
  const axisRoster = []
  const prefixes = new Set()
  for (const channel of channels) {
    if (
      channel === null ||
      typeof channel !== 'object' ||
      typeof channel.channel_id !== 'string' ||
      channelIds.includes(channel.channel_id) ||
      typeof channel.neural_population_prefix !== 'string' ||
      prefixes.has(channel.neural_population_prefix) ||
      channel.subject_kind !== 'simulated.drone' ||
      channel.action_width !== 3 ||
      !Array.isArray(channel.neural_control_axes) ||
      channel.neural_control_axes.length !== 3 ||
      channel.neural_control_axes.some(
        (axis, index) =>
          axis === null ||
          typeof axis !== 'object' ||
          Array.isArray(axis) ||
          axis.action_index !== index
      )
    ) {
      fail('capture channel or neural population topology differs')
    }
    channelIds.push(channel.channel_id)
    prefixes.add(channel.neural_population_prefix)
    const channelPopulations = []
    for (let axis = 0; axis < 3; axis += 1) {
      axisRoster.push([channel.channel_id, axis])
      channelPopulations.push(
        `${channel.neural_population_prefix}.d${axis.toString().padStart(2, '0')}.negative`,
        `${channel.neural_population_prefix}.d${axis.toString().padStart(2, '0')}.positive`
      )
    }
    channelPopulations.sort(compareCodePoint)
    populationBindings.set(channel.channel_id, channelPopulations)
    populationNames.push(...channelPopulations)
  }
  populationNames.sort(compareCodePoint)
  const populationRoster = channelIds.map((channelId) => ({
    channel_id: channelId,
    population_names: populationBindings.get(channelId),
  }))
  return {
    topology: {
      session_count: 1,
      drone_count: channelIds.length,
      action_axis_count: channelIds.length * 3,
      population_count: channelIds.length * 6,
      population_neuron_count: channelIds.length * 6 * populationSize,
      device_node_count: channelIds.length * 12,
      connection_count: channelIds.length * 12 * populationSize,
      population_names: populationNames,
      derived_population_roster_sha256: sha256(canonical(populationNames)),
    },
    channelIds,
    populationBindings,
    populationRoster,
    axisRoster,
  }
}

function exactManagedFloatVector(values, width, label) {
  if (!Array.isArray(values) || values.length !== width) {
    fail(`${label} width differs`)
  }
  for (const [index, value] of values.entries()) {
    const sourceLexeme = values[MANAGED_RUNTIME_NUMBER_LEXEMES]?.get(`${index}`)
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      typeof sourceLexeme !== 'string' ||
      !/[.eE]/u.test(sourceLexeme)
    ) {
      fail(`${label} contains a non-float JSON value`)
    }
    managedRuntimeFloatText(value)
  }
}

export function assertNeuralStepsClosure(capture, terminal, evidence, count) {
  const planChannels = capture.run_plan?.channels
  const neuralSteps = capture.neural_steps
  const terminalSteps = terminal.steps
  const neuralExecutions = terminal.neural_executions
  const nestExecutions = evidence.step_execution_receipts
  const intervalTics = terminal.timebase?.runtime_step_duration_tics
  if (
    !Array.isArray(planChannels) ||
    planChannels.length !== count ||
    !Array.isArray(neuralSteps) ||
    neuralSteps.length !== 6 ||
    !Array.isArray(terminalSteps) ||
    terminalSteps.length !== 6 ||
    !Array.isArray(neuralExecutions) ||
    neuralExecutions.length !== 6 ||
    !Array.isArray(nestExecutions) ||
    nestExecutions.length !== 6 ||
    !Number.isSafeInteger(intervalTics) ||
    intervalTics < 1 ||
    terminal.timebase?.neural_step_duration_tics !== intervalTics ||
    planChannels.some(
      (row) =>
        row === null ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        typeof row.channel_id !== 'string' ||
        typeof row.subject_id !== 'string' ||
        !Number.isSafeInteger(row.observation_width) ||
        row.observation_width < 1 ||
        row.observation_width > 16 ||
        !Number.isSafeInteger(row.action_width) ||
        row.action_width < 1 ||
        row.action_width > 16
    ) ||
    new Set(planChannels.map((row) => row.channel_id)).size !== planChannels.length
  ) {
    fail(`${count}-drone captured neural step transcript roster differs`)
  }

  for (const [offset, step] of neuralSteps.entries()) {
    const index = offset + 1
    exactKeys(step, NEURAL_STEP_KEYS, `captured neural step ${index}`)
    const request = exactKeys(
      step.request,
      NEURAL_STEP_REQUEST_KEYS,
      `captured neural step ${index} request`
    )
    const result = exactKeys(
      step.result,
      NEURAL_STEP_RESULT_KEYS,
      `captured neural step ${index} result`
    )
    const requestDigest = managedRuntimeDigest(
      request,
      'request_sha256',
      `captured neural step ${index} request`
    )
    const resultDigest = managedRuntimeDigest(
      result,
      'result_sha256',
      `captured neural step ${index} result`
    )
    const terminalStep = terminalSteps[offset]
    const executionBinding = neuralExecutions[offset]
    const nestExecution = nestExecutions[offset]
    const stepId = closedLoopStepId(terminal.study_run_id, index)
    const startTics = offset * intervalTics
    const endTics = index * intervalTics
    if (
      request.schema_version !== 'engram.closed-loop-neural-step-request.v1' ||
      result.schema_version !== 'engram.closed-loop-neural-step-result.v1' ||
      request.study_run_id !== terminal.study_run_id ||
      result.study_run_id !== terminal.study_run_id ||
      request.step_index !== index ||
      result.step_index !== index ||
      request.step_id !== stepId ||
      result.step_id !== stepId ||
      request.neural_preparation_sha256 !== terminal.neural_preparation_sha256 ||
      request.source_snapshot_sha256 !== terminalStep.input_snapshot_sha256 ||
      request.observation_runtime_time_tics !== startTics ||
      request.runtime_interval_end_time_tics !== endTics ||
      request.runtime_interval_tics !== intervalTics ||
      request.controller_start_time_tics !== startTics ||
      request.controller_end_time_tics !== endTics ||
      request.controller_interval_tics !== intervalTics ||
      result.controller_start_time_tics !== startTics ||
      result.controller_end_time_tics !== endTics ||
      result.request_sha256 !== requestDigest ||
      result.provider_execution_scope !== 'nest-exact-step-readback' ||
      result.provider_execution_sha256 !== nestExecution.receipt_sha256 ||
      terminalStep.neural_request_sha256 !== requestDigest ||
      terminalStep.neural_result_sha256 !== resultDigest ||
      terminalStep.provider_execution_scope !== result.provider_execution_scope ||
      terminalStep.provider_execution_sha256 !== result.provider_execution_sha256 ||
      executionBinding.neural_request_sha256 !== requestDigest ||
      executionBinding.neural_result_sha256 !== resultDigest ||
      executionBinding.provider_execution_sha256 !== result.provider_execution_sha256
    ) {
      fail(`${count}-drone captured neural step ${index} lineage differs`)
    }

    if (!Array.isArray(request.channels) || request.channels.length !== planChannels.length) {
      fail(`${count}-drone captured neural step ${index} request channel roster differs`)
    }
    for (const [channelIndex, channel] of request.channels.entries()) {
      exactKeys(
        channel,
        NEURAL_INPUT_CHANNEL_KEYS,
        `captured neural step ${index} input channel ${channelIndex + 1}`
      )
      const planChannel = planChannels[channelIndex]
      if (
        channel.channel_id !== planChannel.channel_id ||
        channel.subject_id !== planChannel.subject_id ||
        typeof channel.hold_required !== 'boolean' ||
        typeof channel.fault_code !== 'string' ||
        channel.fault_code.length === 0 ||
        channel.fault_code !== channel.fault_code.trim() ||
        Buffer.byteLength(channel.fault_code, 'utf8') > 256 ||
        [...channel.fault_code].some((character) => {
          const codePoint = character.codePointAt(0)
          return codePoint < 33 || codePoint === 127
        })
      ) {
        fail(`${count}-drone captured neural step ${index} input channel differs`)
      }
      exactManagedFloatVector(
        channel.observation_values,
        planChannel.observation_width,
        `${count}-drone captured neural step ${index} observation`
      )
    }

    if (!Array.isArray(result.proposals) || result.proposals.length !== planChannels.length) {
      fail(`${count}-drone captured neural step ${index} proposal roster differs`)
    }
    for (const [channelIndex, proposal] of result.proposals.entries()) {
      exactKeys(
        proposal,
        NEURAL_ACTION_PROPOSAL_KEYS,
        `captured neural step ${index} proposal ${channelIndex + 1}`
      )
      const sources = proposal.source_populations
      if (
        proposal.channel_id !== planChannels[channelIndex].channel_id ||
        !Array.isArray(sources) ||
        sources.length < 1 ||
        sources.length > 64 ||
        canonical(sources) !== canonical([...sources].sort(compareUnicodeCodePoints)) ||
        new Set(sources).size !== sources.length ||
        sources.some((source) => typeof source !== 'string' || source.length === 0)
      ) {
        fail(`${count}-drone captured neural step ${index} proposal differs`)
      }
      exactManagedFloatVector(
        proposal.values,
        planChannels[channelIndex].action_width,
        `${count}-drone captured neural step ${index} proposal`
      )
    }
  }
}

function exactLedgerFloat(parent, key, label) {
  const value = parent?.[key]
  const sourceLexeme = parent?.[MANAGED_RUNTIME_NUMBER_LEXEMES]?.get(`${key}`)
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    typeof sourceLexeme !== 'string' ||
    !/[.eE]/u.test(sourceLexeme)
  ) {
    fail(`${label} is not a float-typed finite JSON value`)
  }
  ledgerFloatText(value)
  return { value, sourceLexeme }
}

function markLedgerIntegerMembers(value, members) {
  const lexemes = new Map()
  for (const member of members) {
    const number = value[member]
    if (!Number.isSafeInteger(number)) fail(`expected ledger integer differs: ${member}`)
    lexemes.set(`${member}`, `${number}`)
  }
  Object.defineProperty(value, MANAGED_RUNTIME_NUMBER_LEXEMES, {
    configurable: false,
    enumerable: false,
    value: lexemes,
    writable: false,
  })
  return value
}

function decimalTics(sourceLexeme, label) {
  const match = sourceLexeme.match(/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u)
  if (match === null || match[1] === '-') fail(`${label} is not a nonnegative decimal time`)
  const fraction = match[3] ?? ''
  const exponent = Number.parseInt(match[4] ?? '0', 10)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    fail(`${label} exceeds the exact NEST tic range`)
  }
  const digits = BigInt(`${match[2]}${fraction}`)
  const shift = exponent - fraction.length + 3
  let tics
  if (shift >= 0) {
    tics = digits * 10n ** BigInt(shift)
  } else {
    const divisor = 10n ** BigInt(-shift)
    if (digits % divisor !== 0n) fail(`${label} is not on the exact 0.001-ms NEST grid`)
    tics = digits / divisor
  }
  if (tics > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} exceeds the exact NEST tic range`)
  return Number(tics)
}

function decimalFraction(sourceLexeme, label) {
  const match = sourceLexeme.match(/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u)
  if (match === null) fail(`${label} is not an exact decimal value`)
  const fraction = match[3] ?? ''
  const exponent = Number.parseInt(match[4] ?? '0', 10)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    fail(`${label} exceeds the exact decimal range`)
  }
  let numerator = BigInt(`${match[2]}${fraction}`)
  if (match[1] === '-') numerator = -numerator
  const shift = exponent - fraction.length
  if (shift >= 0) {
    return { numerator: numerator * 10n ** BigInt(shift), denominator: 1n }
  }
  return { numerator, denominator: 10n ** BigInt(-shift) }
}

function decimalProductCeiling(value, integerFactors, divisor, label) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !integerFactors.every((factor) => Number.isSafeInteger(factor) && factor >= 0) ||
    !Number.isSafeInteger(divisor) ||
    divisor < 1
  ) {
    fail(`${label} exceeds the exact arithmetic domain`)
  }
  const decimal = decimalFraction(ledgerFloatText(value), label)
  if (decimal.numerator < 0n) fail(`${label} is negative`)
  const numerator = integerFactors.reduce(
    (product, factor) => product * BigInt(factor),
    decimal.numerator
  )
  const denominator = decimal.denominator * BigInt(divisor)
  const result = (numerator + denominator - 1n) / denominator
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} exceeds the exact integer range`)
  return Number(result)
}

function decimalFloatSum(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${label} has no decimal terms`)
  }
  const fractions = values.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${label} contains a non-finite term`)
    }
    return decimalFraction(ledgerFloatText(value), label)
  })
  const denominator = fractions.reduce(
    (largest, row) => (row.denominator > largest ? row.denominator : largest),
    1n
  )
  const numerator = fractions.reduce((sum, row) => {
    if (denominator % row.denominator !== 0n) {
      fail(`${label} has an incompatible decimal denominator`)
    }
    return sum + row.numerator * (denominator / row.denominator)
  }, 0n)
  const denominatorText = denominator.toString()
  if (!/^10*$/u.test(denominatorText)) {
    fail(`${label} has a non-decimal denominator`)
  }
  const scale = denominatorText.length - 1
  const negative = numerator < 0n
  const digits = (negative ? -numerator : numerator).toString().padStart(scale + 1, '0')
  const decimalText =
    scale === 0
      ? digits
      : `${digits.slice(0, -scale)}.${digits.slice(-scale).replace(/0+$/u, '') || '0'}`
  const result = Number(`${negative ? '-' : ''}${decimalText}`)
  if (!Number.isFinite(result)) fail(`${label} exceeds the binary64 range`)
  return result
}

function requestedNestTics(parent, key, label, allowZero = false) {
  const { value, sourceLexeme } = exactLedgerFloat(parent, key, label)
  const tics = decimalTics(sourceLexeme, label)
  if ((!allowZero && tics < 1) || value < 0) fail(`${label} is not a positive NEST time`)
  return tics
}

function effectiveNestTics(parent, key, label, allowZero = false) {
  const { value } = exactLedgerFloat(parent, key, label)
  if (value < 0 || (!allowZero && value === 0)) fail(`${label} is not a valid NEST readback`)
  const scaled = value / NEST_TIC_MS
  const candidate = Math.round(scaled)
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 0 ||
    (!allowZero && candidate === 0) ||
    !Object.is(value, candidate * NEST_TIC_MS)
  ) {
    fail(`${label} is not an exact canonical NEST tic readback`)
  }
  return candidate
}

function assertNestControllerConfigSemantics(config) {
  if (config?.schema_version !== 'engram.nest-population-controller-config.v2') {
    fail('NEST controller configuration identity differs')
  }
  const resolutionTics = requestedNestTics(config, 'resolution_ms', 'NEST resolution')
  const durationTics = requestedNestTics(config, 'step_duration_ms', 'NEST step duration')
  const bounds = [
    ['resolution_ms', 0.001, 10],
    ['step_duration_ms', 1, 10000],
    ['baseline_rate_hz', 0, 100000],
    ['input_span_hz', Number.MIN_VALUE, 100000],
    ['input_weight_mv', Number.MIN_VALUE, 1000],
    ['output_rate_scale_hz', Number.MIN_VALUE, 1000000000],
  ]
  for (const [key, minimum, maximum] of bounds) {
    const { value } = exactLedgerFloat(config, key, `NEST controller ${key}`)
    if (value < minimum || value > maximum || (minimum === Number.MIN_VALUE && value <= 0)) {
      fail(`NEST controller ${key} exceeds its bound`)
    }
  }
  if (
    !Number.isSafeInteger(config.population_size) ||
    config.population_size < 2 ||
    config.population_size > 512 ||
    !Number.isSafeInteger(config.rng_seed) ||
    config.rng_seed < 1 ||
    config.rng_seed > 2147483647 ||
    durationTics % resolutionTics !== 0 ||
    durationTics <= resolutionTics ||
    durationTics < Math.max(NEST_REFRACTORY_TICS + 2 * resolutionTics, 3 * resolutionTics)
  ) {
    fail('NEST controller timing or integer configuration differs')
  }
  return { resolutionTics, durationTics }
}

function assertNestLaunchExpectationSemantics(expectation) {
  const { resolutionTics, durationTics } = assertNestControllerConfigSemantics(
    expectation.controller_configuration
  )
  const files = expectation.required_runtime_files
  const byRole = new Map(files.map((row) => [row.role, row]))
  const python = byRole.get('python-executable')
  const worker = byRole.get('worker-source')
  const controller = byRole.get('project-module:backend.optimization.extension_closed_loop_nest')
  if (python === undefined || worker === undefined || controller === undefined) {
    fail('NEST launch lacks its required executable or controller source')
  }
  const expectedWorkerCommand = [
    python.absolute_path,
    '-I',
    '-S',
    '-B',
    worker.absolute_path,
    '--resource-limit-profile',
    'portable-posix-rlimit-v1',
    '--address-space-bytes',
    `${expectation.address_space_bytes ?? 0}`,
    '--cpu-time-seconds',
    `${expectation.cpu_time_seconds}`,
    '--file-size-bytes',
    `${expectation.file_size_bytes}`,
    '--open-file-count',
    `${expectation.open_file_count}`,
  ]
  const guardianSource = expectation.guardian_command?.[5]
  const expectedGuardianCommand = [python.absolute_path, '-I', '-S', '-B', '-c', guardianSource]
  const expectedDispatch =
    expectation.session_escape_prevention_profile === 'darwin-gated-group-leader-deny-fork-v1'
      ? [NEST_SANDBOX_EXECUTABLE, '-p', NEST_DARWIN_SANDBOX_PROFILE, ...expectedWorkerCommand]
      : expectedWorkerCommand
  const expectedEnvironment = [
    ['LANG', 'C'],
    ['LC_ALL', 'C'],
    ['PATH', '/usr/bin:/bin'],
    ['TZ', 'UTC'],
  ]
  const roles = files.map((row) => row.role)
  const projectFiles = files.filter((row) => row.role.startsWith('project-module:'))
  const nonprojectRoles = roles.filter((role) => !role.startsWith('project-module:'))
  const expectedNonprojectRoles = [
    'pydantic-core-native',
    'pydantic-package-init',
    'python-executable',
    'worker-source',
  ]
  const childResourceLimits = markLedgerIntegerMembers(
    {
      max_total_nodes: NEST_WORK_LIMITS.max_total_nodes,
      max_total_connections: NEST_WORK_LIMITS.max_total_connections,
      max_neuron_tic_work_units: NEST_WORK_LIMITS.max_neuron_tic_work_units,
      max_input_event_work_units: NEST_WORK_LIMITS.max_input_event_work_units,
    },
    [
      'max_total_nodes',
      'max_total_connections',
      'max_neuron_tic_work_units',
      'max_input_event_work_units',
    ]
  )
  const childIdentity = markLedgerIntegerMembers(
    {
      schema_version: 'engram.nest-population-controller-identity.v1',
      provider: 'NEST',
      semantic_policy: 'engram.nest-population-controller-policy.v4',
      test_failure_phase: expectation.child_provider_test_failure_phase,
      controller_source_sha256: controller.sha256,
      reported_version: '3.9.0',
      config: expectation.controller_configuration,
      nest_tic_ms: '0.001',
      local_num_threads: 1,
      model_roster: NEST_MODEL_ROSTER,
      resource_limits: childResourceLimits,
      loaded_bytes_attested: false,
      ncp_transport: false,
    },
    ['local_num_threads']
  )
  const expectedChildIdentity = sha256(Buffer.from(ledgerCanonical(childIdentity)))
  const expectedCommandDigest = sha256(
    Buffer.from(
      ledgerCanonical({
        guardian_command: expectation.guardian_command,
        worker_command: expectation.worker_command,
        worker_dispatch_command: expectation.worker_dispatch_command,
        exec_gate_source_sha256: expectation.exec_gate_source_sha256,
        session_escape_prevention_profile: expectation.session_escape_prevention_profile,
        darwin_sandbox_profile_sha256: expectation.darwin_sandbox_profile_sha256,
        darwin_sandbox_launcher_sha256: expectation.darwin_sandbox_launcher_sha256,
      })
    )
  )
  const darwin = expectation.platform === 'darwin'
  if (
    expectation.schema_version !== 'engram.nest-worker-launch-expectation.v4' ||
    !Array.isArray(files) ||
    files.length < REQUIRED_WORKER_MODULES.length + expectedNonprojectRoles.length ||
    files.length > 68 ||
    new Set(roles).size !== roles.length ||
    canonical(projectFiles.map((row) => row.role)) !==
      canonical([...projectFiles.map((row) => row.role)].sort(compareUnicodeCodePoints)) ||
    REQUIRED_WORKER_MODULES.some((moduleName) => !roles.includes(`project-module:${moduleName}`)) ||
    canonical(nonprojectRoles) !== canonical(expectedNonprojectRoles) ||
    files.some(
      (row) =>
        row === null ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        typeof row.absolute_path !== 'string' ||
        !row.absolute_path.startsWith('/') ||
        !Number.isSafeInteger(row.size_bytes) ||
        row.size_bytes < 0 ||
        row.size_bytes > 67108864 ||
        !isSha256(row.sha256)
    ) ||
    expectation.required_runtime_file_roster_sha256 !==
      sha256(Buffer.from(ledgerCanonical(files))) ||
    expectation.required_project_source_roster_sha256 !==
      sha256(Buffer.from(ledgerCanonical(projectFiles))) ||
    canonical(expectation.worker_command) !== canonical(expectedWorkerCommand) ||
    canonical(expectation.guardian_command) !== canonical(expectedGuardianCommand) ||
    canonical(expectation.worker_dispatch_command) !== canonical(expectedDispatch) ||
    canonical(expectation.environment) !== canonical(expectedEnvironment) ||
    !Array.isArray(expectation.sys_path) ||
    expectation.sys_path.length < 4 ||
    expectation.sys_path.length > 8 ||
    new Set(expectation.sys_path).size !== expectation.sys_path.length ||
    expectation.sys_path.some((path) => typeof path !== 'string' || !path.startsWith('/')) ||
    typeof guardianSource !== 'string' ||
    Buffer.byteLength(guardianSource) !== expectation.guardian_source_file?.size_bytes ||
    sha256(Buffer.from(guardianSource)) !== expectation.guardian_source_sha256 ||
    expectation.guardian_source_sha256 !== expectation.guardian_source_file?.sha256 ||
    expectation.exec_gate_source_sha256 !== expectation.exec_gate_source_file?.sha256 ||
    !expectation.guardian_source_file?.absolute_path?.startsWith('/') ||
    !expectation.exec_gate_source_file?.absolute_path?.startsWith('/') ||
    expectation.python_executable_sha256 !== python.sha256 ||
    expectation.worker_source_sha256 !== worker.sha256 ||
    expectation.expected_child_provider_identity_sha256 !== expectedChildIdentity ||
    expectation.worker_command_sha256 !== expectedCommandDigest ||
    expectation.project_source_discovery_policy !== 'minimum-direct-worker-import-roster-v1' ||
    expectation.resource_limit_profile !== 'portable-posix-rlimit-v1' ||
    expectation.child_provider_test_failure_phase !== 'none' ||
    expectation.address_space_limit_enforced !== (expectation.address_space_bytes !== null) ||
    (expectation.platform === 'linux') !== expectation.address_space_limit_enforced ||
    (expectation.platform === 'linux' && expectation.address_space_bytes !== 1073741824) ||
    (expectation.platform === 'darwin' && expectation.address_space_bytes !== null) ||
    expectation.cpu_time_seconds !== 300 ||
    expectation.file_size_bytes !== 67108864 ||
    expectation.open_file_count !== 256 ||
    expectation.core_file_bytes !== 0 ||
    expectation.network_namespace_isolation !== false ||
    expectation.syscall_filter !== false ||
    expectation.runtime_process_group_leader !== true ||
    expectation.guardian_group_member !== true ||
    expectation.production_isolation !== false ||
    expectation.external_dependency_closure_attested !== false ||
    expectation.loaded_bytes_attested !== false ||
    (darwin &&
      (expectation.session_escape_prevention_profile !== 'darwin-gated-group-leader-deny-fork-v1' ||
        expectation.descendant_creation_denied !== true ||
        expectation.darwin_sandbox_profile_sha256 !==
          sha256(Buffer.from(NEST_DARWIN_SANDBOX_PROFILE)) ||
        !isSha256(expectation.darwin_sandbox_launcher_sha256))) ||
    (!darwin &&
      (expectation.platform !== 'linux' ||
        expectation.session_escape_prevention_profile !== 'linux-trusted-worker-source-v1' ||
        expectation.descendant_creation_denied !== false ||
        expectation.darwin_sandbox_profile_sha256 !== null ||
        expectation.darwin_sandbox_launcher_sha256 !== null))
  ) {
    fail('NEST launch command, containment, or provider-identity semantics differ')
  }
  return { config: expectation.controller_configuration, resolutionTics, durationTics }
}

function assertNestWorkAdmissionSemantics(work, terminal, config, controlBindings, populations) {
  const maximumInputRate = exactLedgerFloat(
    work,
    'maximum_input_rate_hz',
    'NEST work maximum input rate'
  ).value
  const expectedSignedPopulations = work.action_dimension_count * 2
  const expectedPopulationNeurons = expectedSignedPopulations * work.population_size
  const expectedDevices = expectedSignedPopulations * 2
  const expectedConnections = expectedPopulationNeurons * 2
  const expectedRunTics = work.step_duration_tics * work.planned_step_count
  const expectedNeuronWork = expectedPopulationNeurons * expectedRunTics
  const expectedInputWork = decimalProductCeiling(
    maximumInputRate,
    [expectedRunTics, expectedPopulationNeurons],
    1000000,
    'NEST work maximum input rate'
  )
  const expectedStepBytes = 32768 + work.channel_count * 4096 + work.action_dimension_count * 8192
  const expectedBundleBytes =
    16777216 +
    work.channel_count * 4096 +
    work.action_dimension_count * 8192 +
    expectedStepBytes * work.planned_step_count
  const expectedStepNodes = 128 + work.channel_count * 42 + work.action_dimension_count * 160
  const expectedBundleNodes =
    32768 +
    work.channel_count * 64 +
    work.action_dimension_count * 192 +
    work.planned_step_count * (128 + work.channel_count * 40 + work.action_dimension_count * 160)
  if (
    work.schema_version !== 'engram.nest-work-admission.v1' ||
    work.channel_count !== controlBindings.length ||
    work.channel_count !== populations.length ||
    work.action_dimension_count < work.channel_count ||
    work.planned_step_count !== terminal.planned_step_count ||
    work.closed_loop_definition_sha256 !== terminal.closed_loop_definition_sha256 ||
    work.controller_configuration_sha256 !== sha256(Buffer.from(ledgerCanonical(config))) ||
    work.expected_control_binding_sha256 !==
      sha256(Buffer.from(ledgerCanonical(controlBindings))) ||
    work.expected_population_roster_sha256 !== sha256(Buffer.from(ledgerCanonical(populations))) ||
    work.population_size !== config.population_size ||
    maximumInputRate !==
      decimalFloatSum(
        [config.baseline_rate_hz, config.input_span_hz],
        'NEST work maximum input rate'
      ) ||
    work.signed_population_count !== expectedSignedPopulations ||
    work.population_neuron_count !== expectedPopulationNeurons ||
    work.device_node_count !== expectedDevices ||
    work.total_node_count !== expectedPopulationNeurons + expectedDevices ||
    work.total_connection_count !== expectedConnections ||
    work.total_run_tics !== expectedRunTics ||
    work.neuron_tic_work_units !== expectedNeuronWork ||
    work.input_event_work_units !== expectedInputWork ||
    work.estimated_step_response_bytes !== expectedStepBytes ||
    work.estimated_evidence_bundle_bytes !== expectedBundleBytes ||
    work.estimated_step_response_nodes !== expectedStepNodes ||
    work.estimated_evidence_bundle_nodes !== expectedBundleNodes ||
    work.byte_estimate_policy !== 'closed-json-upper-bound-v1' ||
    work.node_estimate_policy !== 'canonical-json-node-upper-bound-v1' ||
    Object.entries(NEST_WORK_LIMITS).some(([key, value]) => work[key] !== value) ||
    work.total_node_count > work.max_total_nodes ||
    work.total_connection_count > work.max_total_connections ||
    work.neuron_tic_work_units > work.max_neuron_tic_work_units ||
    work.input_event_work_units > work.max_input_event_work_units ||
    work.estimated_step_response_bytes > work.max_step_response_bytes ||
    work.estimated_evidence_bundle_bytes > work.max_evidence_bundle_bytes ||
    work.estimated_step_response_nodes > work.max_step_response_nodes ||
    work.estimated_evidence_bundle_nodes > work.max_evidence_bundle_nodes ||
    work.admitted !== true
  ) {
    fail('NEST work-admission arithmetic, budget, or lineage differs')
  }
  ledgerDigest(work, 'receipt_sha256', 'NEST work admission')
}

function assertNestSessionSemantics(session, terminal, config, timing) {
  const work = session.work_admission
  const requestedResolution = requestedNestTics(
    session,
    'requested_resolution_ms',
    'NEST requested resolution'
  )
  const resolutionArgument = requestedNestTics(
    session,
    'resolution_api_argument_ms',
    'NEST resolution API argument'
  )
  const effectiveResolution = effectiveNestTics(
    session,
    'effective_resolution_ms',
    'NEST effective resolution'
  )
  const requestedDuration = requestedNestTics(
    session,
    'requested_step_duration_ms',
    'NEST requested step duration'
  )
  const runArgument = requestedNestTics(session, 'run_api_argument_ms', 'NEST run API argument')
  const delayArgument = requestedNestTics(
    session,
    'connection_delay_api_argument_ms',
    'NEST connection delay API argument'
  )
  const requestedInputWeight = exactLedgerFloat(
    session,
    'requested_input_weight',
    'NEST requested input weight'
  ).value
  const requestedRecorderWeight = exactLedgerFloat(
    session,
    'requested_recorder_weight',
    'NEST requested recorder weight'
  ).value
  const connections = session.connection_readbacks
  const controlBindings = session.control_bindings
  const populations = session.population_roster
  assertNestWorkAdmissionSemantics(work, terminal, config, controlBindings, populations)
  const connectionKeys = connections.map((row) => [row.population_name, row.direction])
  const sortedConnectionKeys = [...connectionKeys].sort(
    (left, right) =>
      compareUnicodeCodePoints(left[0], right[0]) || compareUnicodeCodePoints(left[1], right[1])
  )
  const grouped = new Map()
  let connectionCount = 0
  for (const row of connections) {
    const requestedWeight = exactLedgerFloat(
      row,
      'requested_weight',
      `NEST ${row.population_name} ${row.direction} requested weight`
    ).value
    const effectiveWeight = exactLedgerFloat(
      row,
      'effective_weight',
      `NEST ${row.population_name} ${row.direction} effective weight`
    ).value
    const delayTics = requestedNestTics(
      row,
      'delay_api_argument_ms',
      `NEST ${row.population_name} ${row.direction} delay API argument`
    )
    const effectiveDelay = effectiveNestTics(
      row,
      'effective_delay_ms',
      `NEST ${row.population_name} ${row.direction} effective delay`
    )
    const expectedWeight =
      row.direction === 'input' ? requestedInputWeight : requestedRecorderWeight
    if (
      !['input', 'recorder'].includes(row.direction) ||
      row.synapse_model !== 'static_synapse' ||
      requestedWeight !== expectedWeight ||
      effectiveWeight !== requestedWeight ||
      row.requested_delay_tics !== session.requested_connection_delay_tics ||
      delayTics !== row.requested_delay_tics ||
      row.effective_delay_tics !== row.requested_delay_tics ||
      effectiveDelay !== row.effective_delay_tics ||
      row.requested_receptor !== session.requested_receptor ||
      row.effective_receptor !== row.requested_receptor ||
      row.connection_count !== work.population_size
    ) {
      fail('NEST connection readback parameters differ from the session')
    }
    if (!grouped.has(row.population_name)) grouped.set(row.population_name, new Set())
    grouped.get(row.population_name).add(row.direction)
    connectionCount += row.connection_count
  }
  const controlIds = controlBindings.map((row) => row.channel_id)
  const populationIds = populations.map((row) => row.channel_id)
  const populationNames = populations.flatMap((row) => row.population_names)
  const expectedModelReadback = markLedgerIntegerMembers(
    {
      effective_model_roster: session.effective_model_roster,
      population_neuron_count: session.observed_population_neuron_count,
      device_node_count: session.observed_device_node_count,
    },
    ['population_neuron_count', 'device_node_count']
  )
  if (
    session.schema_version !== 'engram.nest-session-readback.v2' ||
    session.reported_version !== '3.9.0' ||
    requestedResolution !== timing.resolutionTics ||
    resolutionArgument !== timing.resolutionTics ||
    effectiveResolution !== timing.resolutionTics ||
    session.requested_resolution_tics !== timing.resolutionTics ||
    session.effective_resolution_tics !== timing.resolutionTics ||
    requestedDuration !== timing.durationTics ||
    runArgument !== timing.durationTics ||
    session.requested_step_duration_tics !== timing.durationTics ||
    session.requested_connection_delay_tics !== timing.resolutionTics ||
    delayArgument !== timing.resolutionTics ||
    session.requested_rng_seed !== config.rng_seed ||
    session.effective_rng_seed !== config.rng_seed ||
    session.requested_local_num_threads !== 1 ||
    session.effective_local_num_threads !== 1 ||
    session.effective_total_num_virtual_processes !== 1 ||
    canonical(session.effective_model_roster) !== canonical(NEST_MODEL_ROSTER) ||
    session.control_neuron_model !== 'iaf_psc_delta' ||
    session.control_neuron_refractory_period_tics !== NEST_REFRACTORY_TICS ||
    session.control_neuron_refractory_input !== false ||
    session.channel_recovery_policy !== 'delta-current-zero-input-washout-dual-reset-v1' ||
    requestedInputWeight !== config.input_weight_mv ||
    requestedRecorderWeight !== 1 ||
    session.requested_receptor !== 0 ||
    session.observed_population_neuron_count !== work.population_neuron_count ||
    session.observed_device_node_count !== work.device_node_count ||
    session.observed_total_connection_count !== work.total_connection_count ||
    work.step_duration_tics !== timing.durationTics ||
    canonical(connectionKeys) !== canonical(sortedConnectionKeys) ||
    new Set(connectionKeys.map((row) => `${row[0]}\0${row[1]}`)).size !== connectionKeys.length ||
    grouped.size !== work.signed_population_count ||
    [...grouped.values()].some(
      (directions) =>
        directions.size !== 2 || !directions.has('input') || !directions.has('recorder')
    ) ||
    connectionCount !== session.observed_total_connection_count ||
    session.model_readback_sha256 !== sha256(Buffer.from(ledgerCanonical(expectedModelReadback))) ||
    session.connection_readback_sha256 !== sha256(Buffer.from(ledgerCanonical(connections))) ||
    canonical(controlIds) !== canonical([...controlIds].sort(compareUnicodeCodePoints)) ||
    new Set(controlIds).size !== controlIds.length ||
    canonical(populationIds) !== canonical(controlIds) ||
    controlIds.length !== work.channel_count ||
    controlBindings.reduce((sum, row) => sum + row.axis_binding_sha256s.length, 0) !==
      work.action_dimension_count ||
    populations.some(
      (row, index) =>
        row.population_names.length !== 2 * controlBindings[index].axis_binding_sha256s.length
    ) ||
    populationNames.length !== work.signed_population_count ||
    new Set(populationNames).size !== populationNames.length ||
    populationNames.some((name) => !grouped.has(name)) ||
    session.control_binding_sha256 !== sha256(Buffer.from(ledgerCanonical(controlBindings))) ||
    session.population_roster_sha256 !== sha256(Buffer.from(ledgerCanonical(populations))) ||
    session.control_binding_sha256 !== work.expected_control_binding_sha256 ||
    session.population_roster_sha256 !== work.expected_population_roster_sha256 ||
    session.kernel_reset_at_admission !== true ||
    session.one_session !== true ||
    session.ncp_transport !== false ||
    session.loaded_bytes_attested !== false
  ) {
    fail('NEST session timing, construction, model, or roster semantics differ')
  }
  ledgerDigest(session, 'receipt_sha256', 'NEST session readback')
  return work
}

function assertNestStepExecutionSemantics(execution, session, priorState) {
  const runTics = requestedNestTics(
    execution,
    'run_api_argument_ms',
    `NEST step ${execution.step_index} run API argument`
  )
  if (
    execution.after_biological_time_tics - execution.before_biological_time_tics !==
      execution.requested_run_tics ||
    runTics !== execution.requested_run_tics
  ) {
    fail(`NEST step ${execution.step_index} biological-time semantics differ`)
  }
  const eventRows = execution.population_event_deltas
  const windows = execution.completed_window_readbacks
  const schedules = execution.generator_schedule_readbacks
  const weights = execution.input_weight_readbacks
  const encodings = execution.encoded_control_inputs
  const safetyRows = execution.channel_safety_readbacks
  if (
    execution.schema_version !== 'engram.nest-step-execution-readback.v3' ||
    !Number.isSafeInteger(execution.step_index) ||
    execution.step_index < 1 ||
    !Number.isSafeInteger(execution.before_biological_time_tics) ||
    !Number.isSafeInteger(execution.after_biological_time_tics) ||
    !Number.isSafeInteger(execution.requested_run_tics) ||
    !Array.isArray(eventRows) ||
    !Array.isArray(windows) ||
    !Array.isArray(schedules) ||
    !Array.isArray(weights) ||
    !Array.isArray(encodings) ||
    !Array.isArray(safetyRows) ||
    windows.length === 0
  ) {
    fail(`NEST step ${execution.step_index} shape or identity differs`)
  }
  const names = eventRows.map((row) => row.population_name)
  if (
    canonical(names) !== canonical([...names].sort(compareUnicodeCodePoints)) ||
    new Set(names).size !== names.length ||
    canonical(windows.map((row) => row.population_name)) !== canonical(names) ||
    canonical(schedules.map((row) => row.population_name)) !== canonical(names) ||
    canonical(weights.map((row) => row.population_name)) !== canonical(names)
  ) {
    fail(`NEST step ${execution.step_index} population roster semantics differ`)
  }
  for (const row of eventRows) {
    const prior = priorState.get(row.population_name)
    if (
      prior === undefined ||
      !Number.isSafeInteger(row.prior_event_count) ||
      !Number.isSafeInteger(row.current_event_count) ||
      !Number.isSafeInteger(row.event_count_delta) ||
      row.prior_event_count < 0 ||
      row.current_event_count < 0 ||
      row.event_count_delta < 0 ||
      row.current_event_count > NEST_MAX_RECORDER_EVENTS ||
      row.event_count_delta > NEST_MAX_RECORDER_EVENTS ||
      (row.prior_event_count !== 0 &&
        (!prior.counterMayPersist || row.prior_event_count !== prior.lastEventCount)) ||
      row.current_event_count - row.prior_event_count !== row.event_count_delta
    ) {
      fail(`NEST step ${execution.step_index} event-counter semantics differ`)
    }
  }
  const expectedWatermark = Math.max(
    0,
    execution.after_biological_time_tics - windows[0].recorder_delivery_delay_tics
  )
  const eventByName = new Map(eventRows.map((row) => [row.population_name, row]))
  const safetyByChannel = new Map(safetyRows.map((row) => [row.channel_id, row]))
  const populationChannel = new Map(
    session.population_roster.flatMap((row) =>
      row.population_names.map((populationName) => [populationName, row.channel_id])
    )
  )
  const emptyRosterDigest = sha256(Buffer.from(ledgerCanonical([])))
  const safetyPriorPending = new Map()
  for (const row of windows) {
    const prior = priorState.get(row.population_name)
    const event = eventByName.get(row.population_name)
    const channelId = populationChannel.get(row.population_name)
    const safety = safetyByChannel.get(channelId)
    if (prior === undefined || event === undefined || safety === undefined) {
      fail(`NEST step ${execution.step_index} completed-window lineage is partial`)
    }
    const safetyRequired = safety.hold_required || safety.recovery_from_hold
    const expectedWindowStart = safetyRequired
      ? execution.before_biological_time_tics
      : prior.watermark
    const counts = [
      row.newly_delivered_event_count,
      row.completed_event_count,
      row.pending_event_count,
      row.quarantined_event_count,
    ]
    const countDigests = [
      [row.completed_event_count, row.completed_event_times_sha256],
      [row.pending_event_count, row.pending_event_times_sha256],
      [row.quarantined_event_count, row.quarantined_event_times_sha256],
    ]
    if (
      counts.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > NEST_MAX_RECORDER_EVENTS
      ) ||
      row.completed_event_count + row.pending_event_count + row.quarantined_event_count >
        NEST_MAX_RECORDER_EVENTS ||
      countDigests.some(
        ([count, digest]) =>
          !isSha256(digest) ||
          (count === 0 && digest !== emptyRosterDigest) ||
          (count > 0 && digest === emptyRosterDigest)
      ) ||
      row.recorder_delivery_delay_tics !== session.requested_connection_delay_tics ||
      row.previous_completed_watermark_tics !== prior.watermark ||
      row.current_completed_watermark_tics !== expectedWatermark ||
      row.decode_window_start_tics !== expectedWindowStart ||
      row.current_completed_watermark_tics - row.decode_window_start_tics !==
        row.completed_window_tics ||
      row.newly_delivered_event_count !== event.event_count_delta ||
      (!safetyRequired &&
        (row.quarantined_event_count !== 0 ||
          row.completed_event_count + row.pending_event_count !==
            prior.pendingCount + row.newly_delivered_event_count)) ||
      (safetyRequired &&
        (event.event_count_delta !== 0 ||
          row.newly_delivered_event_count !== 0 ||
          row.completed_event_count !== 0 ||
          row.pending_event_count !== 0 ||
          row.quarantined_event_count !== 0)) ||
      !(
        row.previous_completed_watermark_tics <= row.decode_window_start_tics &&
        row.decode_window_start_tics < row.current_completed_watermark_tics
      )
    ) {
      fail(`NEST step ${execution.step_index} completed-window semantics differ`)
    }
    if (safetyRequired) {
      safetyPriorPending.set(
        channelId,
        (safetyPriorPending.get(channelId) ?? 0) + prior.pendingCount
      )
    }
    priorState.set(row.population_name, {
      watermark: row.current_completed_watermark_tics,
      pendingCount: row.pending_event_count,
      pendingDigest: row.pending_event_times_sha256,
      lastEventCount: event.current_event_count,
      counterMayPersist: !safetyRequired,
    })
  }
  for (const [index, row] of schedules.entries()) {
    const requested = requestedNestTics(
      row,
      'schedule_api_argument_ms',
      `NEST step ${execution.step_index} generator schedule`
    )
    const effective = effectiveNestTics(
      row,
      'effective_schedule_time_ms',
      `NEST step ${execution.step_index} generator effective schedule`
    )
    const requestedRate = exactLedgerFloat(
      row,
      'requested_rate_hz',
      `NEST step ${execution.step_index} generator requested rate`
    ).value
    const effectiveRate = exactLedgerFloat(
      row,
      'effective_rate_hz',
      `NEST step ${execution.step_index} generator effective rate`
    ).value
    const weight = weights[index]
    const carrier = exactLedgerFloat(
      weight,
      'constant_generator_rate_hz',
      `NEST step ${execution.step_index} carrier rate`
    ).value
    const desired = exactLedgerFloat(
      weight,
      'desired_equivalent_rate_hz',
      `NEST step ${execution.step_index} desired rate`
    ).value
    const fullScale = exactLedgerFloat(
      weight,
      'configured_full_scale_weight_mv',
      `NEST step ${execution.step_index} full-scale weight`
    ).value
    const requestedWeight = exactLedgerFloat(
      weight,
      'requested_weight_mv',
      `NEST step ${execution.step_index} requested carrier weight`
    ).value
    const effectiveWeight = exactLedgerFloat(
      weight,
      'effective_weight_mv',
      `NEST step ${execution.step_index} effective carrier weight`
    ).value
    if (
      row.generator_model !== 'inhomogeneous_poisson_generator' ||
      row.requested_schedule_time_tics !==
        execution.before_biological_time_tics + session.requested_resolution_tics ||
      requested !== row.requested_schedule_time_tics ||
      effective !== row.effective_schedule_time_tics ||
      row.effective_schedule_time_tics !== row.requested_schedule_time_tics ||
      requestedRate !== effectiveRate ||
      requestedRate !== carrier ||
      desired > carrier ||
      requestedWeight !== (fullScale * desired) / carrier ||
      effectiveWeight !== requestedWeight ||
      weight.connection_count !== session.work_admission.population_size ||
      (weight.input_disposition !== 'encoded-observation' &&
        (desired !== 0 || requestedWeight !== 0))
    ) {
      fail(`NEST step ${execution.step_index} generator or carrier-weight semantics differ`)
    }
  }
  const encodingKeys = encodings.map((row) => [row.channel_id, row.action_index])
  const sortedEncodingKeys = [...encodingKeys].sort(
    (left, right) => compareUnicodeCodePoints(left[0], right[0]) || left[1] - right[1]
  )
  for (const row of encodings) {
    const raw = exactLedgerFloat(
      row,
      'raw_affine_sum',
      `NEST step ${execution.step_index} raw encoded input`
    ).value
    const normalized = exactLedgerFloat(
      row,
      'normalized_input',
      `NEST step ${execution.step_index} normalized input`
    ).value
    const expected = Math.max(-1, Math.min(1, raw))
    if (
      normalized !== expected ||
      row.clamped !== (raw < -1 || raw > 1) ||
      (row.input_disposition !== 'encoded-observation' &&
        (raw !== 0 || normalized !== 0 || row.clamped))
    ) {
      fail(`NEST step ${execution.step_index} control-encoding semantics differ`)
    }
  }
  for (const row of safetyRows) {
    const expectedDisposition = row.hold_required
      ? 'held-neutralized'
      : row.recovery_from_hold
        ? 'recovery-washout'
        : 'encoded-observation'
    const reset = row.hold_required || row.recovery_from_hold
    const expectedResetDigest = sha256(
      Buffer.from(
        ledgerCanonical({
          before: row.pre_interval_reset_readback_sha256,
          after: row.post_interval_reset_readback_sha256,
        })
      )
    )
    const channelPopulationCount = session.population_roster.find(
      (population) => population.channel_id === row.channel_id
    )?.population_names.length
    const priorPendingCount = safetyPriorPending.get(row.channel_id) ?? 0
    const maximumDiscardedCount =
      channelPopulationCount === undefined
        ? -1
        : priorPendingCount + 2 * NEST_MAX_RECORDER_EVENTS * channelPopulationCount
    if (
      row.input_disposition !== expectedDisposition ||
      row.population_state_reset_performed !== reset ||
      row.population_state_reset_verified !== reset ||
      row.safety_washout_performed !== reset ||
      row.resolution_tics !== session.requested_resolution_tics ||
      row.minimum_refractory_flush_tics !== NEST_REFRACTORY_TICS ||
      row.reset_readback_sha256 !== expectedResetDigest ||
      !isSha256(row.recorder_quarantine_sha256) ||
      !Number.isSafeInteger(row.discarded_pending_event_count) ||
      row.discarded_pending_event_count < 0 ||
      (reset && row.discarded_pending_event_count < priorPendingCount) ||
      (reset && row.discarded_pending_event_count > maximumDiscardedCount) ||
      (reset &&
        (row.pre_interval_reset_readback_sha256 === emptyRosterDigest ||
          row.post_interval_reset_readback_sha256 === emptyRosterDigest ||
          row.recorder_quarantine_sha256 === expectedResetDigest ||
          row.safety_interval_tics !== session.requested_step_duration_tics ||
          row.post_delivery_quiescence_tics < row.minimum_refractory_flush_tics ||
          row.post_delivery_quiescence_tics !==
            row.safety_interval_tics - 2 * row.resolution_tics ||
          row.recorder_delivery_flush_slack_tics !==
            row.safety_interval_tics - 3 * row.resolution_tics)) ||
      (!reset &&
        (row.safety_interval_tics !== 0 ||
          row.post_delivery_quiescence_tics !== 0 ||
          row.recorder_delivery_flush_slack_tics !== 0 ||
          row.discarded_pending_event_count !== 0 ||
          row.pre_interval_reset_readback_sha256 !== emptyRosterDigest ||
          row.post_interval_reset_readback_sha256 !== emptyRosterDigest ||
          row.recorder_quarantine_sha256 !== expectedResetDigest))
    ) {
      fail(`NEST step ${execution.step_index} channel-safety semantics differ`)
    }
  }
  const safetyIds = safetyRows.map((row) => row.channel_id)
  const encodingIds = [...new Set(encodings.map((row) => row.channel_id))].sort(
    compareUnicodeCodePoints
  )
  if (
    canonical(encodingKeys) !== canonical(sortedEncodingKeys) ||
    new Set(encodingKeys.map((row) => `${row[0]}\0${row[1]}`)).size !== encodingKeys.length ||
    eventRows.length !== 2 * encodings.length ||
    canonical(safetyIds) !== canonical(encodingIds) ||
    execution.completed_window_readback_sha256 !== sha256(Buffer.from(ledgerCanonical(windows))) ||
    execution.generator_schedule_readback_sha256 !==
      sha256(Buffer.from(ledgerCanonical(schedules))) ||
    execution.input_weight_readback_sha256 !== sha256(Buffer.from(ledgerCanonical(weights))) ||
    execution.control_encoding_sha256 !== sha256(Buffer.from(ledgerCanonical(encodings))) ||
    execution.channel_safety_readback_sha256 !== sha256(Buffer.from(ledgerCanonical(safetyRows))) ||
    execution.input_encoding_policy !== 'constant-rate-variable-weight-v1' ||
    execution.decoded_proposal_only !== true ||
    execution.scientific_authority !== false
  ) {
    fail(`NEST step ${execution.step_index} roster or digest semantics differ`)
  }
  return ledgerDigest(execution, 'receipt_sha256', `NEST step ${execution.step_index} execution`)
}

function assertNestStepAttemptSemantics(attempt) {
  const partial = markLedgerIntegerMembers(
    {
      before_biological_time_tics: attempt.before_biological_time_tics,
      observed_after_biological_time_tics: attempt.observed_after_biological_time_tics,
      simulation_dispatched: attempt.simulation_dispatched,
      simulation_returned: attempt.simulation_returned,
    },
    [
      'before_biological_time_tics',
      ...(attempt.observed_after_biological_time_tics === null
        ? []
        : ['observed_after_biological_time_tics']),
    ]
  )
  const parentOnly = attempt.observation_scope === 'parent-dispatch-only'
  if (
    attempt.schema_version !== 'engram.nest-step-attempt.v1' ||
    !['child-reported', 'parent-dispatch-only'].includes(attempt.observation_scope) ||
    !Number.isSafeInteger(attempt.attempt_index) ||
    attempt.attempt_index < 1 ||
    !Number.isSafeInteger(attempt.step_index) ||
    attempt.step_index < 1 ||
    !Number.isSafeInteger(attempt.before_biological_time_tics) ||
    attempt.before_biological_time_tics < 0 ||
    (attempt.observed_after_biological_time_tics !== null &&
      (!Number.isSafeInteger(attempt.observed_after_biological_time_tics) ||
        attempt.observed_after_biological_time_tics < attempt.before_biological_time_tics)) ||
    !Number.isSafeInteger(attempt.requested_run_tics) ||
    attempt.requested_run_tics < 1 ||
    typeof attempt.simulation_dispatched !== 'boolean' ||
    typeof attempt.simulation_returned !== 'boolean' ||
    (attempt.simulation_returned && !attempt.simulation_dispatched) ||
    !['succeeded', 'failed', 'unknown-after-worker-dispatch'].includes(attempt.outcome) ||
    typeof attempt.reason_code !== 'string' ||
    attempt.reason_code.length < 1 ||
    Buffer.byteLength(attempt.reason_code, 'utf8') > 256 ||
    attempt.partial_readback_sha256 !== sha256(Buffer.from(ledgerCanonical(partial))) ||
    (parentOnly &&
      (attempt.outcome !== 'unknown-after-worker-dispatch' ||
        attempt.simulation_dispatched ||
        attempt.simulation_returned ||
        attempt.observed_after_biological_time_tics !== null ||
        attempt.execution_receipt_sha256 !== null ||
        attempt.decoded_proposal_produced)) ||
    (!parentOnly && attempt.outcome === 'unknown-after-worker-dispatch') ||
    (attempt.outcome === 'succeeded' &&
      (!attempt.simulation_returned ||
        !isSha256(attempt.execution_receipt_sha256) ||
        attempt.decoded_proposal_produced !== true ||
        attempt.reason_code !== 'neural.step-succeeded' ||
        attempt.observed_after_biological_time_tics !==
          attempt.before_biological_time_tics + attempt.requested_run_tics)) ||
    (attempt.outcome !== 'succeeded' &&
      (attempt.execution_receipt_sha256 !== null || attempt.decoded_proposal_produced)) ||
    attempt.scientific_authority !== false
  ) {
    fail(`NEST step ${attempt.step_index} attempt semantics differ`)
  }
  return ledgerDigest(attempt, 'receipt_sha256', `NEST step ${attempt.step_index} attempt`)
}

function assertNestTailSemantics(tail, session, finalState) {
  const names = tail.population_tails.map((row) => row.population_name)
  const expectedNames = session.population_roster
    .flatMap((row) => row.population_names)
    .sort(compareUnicodeCodePoints)
  const emptyRosterDigest = sha256(Buffer.from(ledgerCanonical([])))
  if (
    tail.schema_version !== 'engram.nest-tail-disposition-receipt.v1' ||
    canonical(names) !== canonical([...names].sort(compareUnicodeCodePoints)) ||
    new Set(names).size !== names.length ||
    canonical(names) !== canonical(expectedNames) ||
    tail.population_tails.some((row) => {
      const final = finalState.get(row.population_name)
      return (
        final === undefined ||
        !Number.isSafeInteger(row.pending_event_count) ||
        row.pending_event_count < 0 ||
        row.pending_event_count > NEST_MAX_RECORDER_EVENTS ||
        !isSha256(row.pending_event_times_sha256) ||
        (row.pending_event_count === 0 && row.pending_event_times_sha256 !== emptyRosterDigest) ||
        (row.pending_event_count > 0 && row.pending_event_times_sha256 === emptyRosterDigest) ||
        row.pending_event_count !== final.pendingCount ||
        row.pending_event_times_sha256 !== final.pendingDigest
      )
    }) ||
    tail.total_pending_event_count !==
      tail.population_tails.reduce((sum, row) => sum + row.pending_event_count, 0) ||
    tail.total_pending_event_count > NEST_MAX_RECORDER_EVENTS * tail.population_tails.length ||
    tail.population_tail_roster_sha256 !==
      sha256(Buffer.from(ledgerCanonical(tail.population_tails))) ||
    tail.final_completed_watermark_tics !==
      Math.max(0, tail.final_biological_time_tics - tail.recorder_delivery_delay_tics) ||
    tail.recorder_delivery_delay_tics !== session.requested_connection_delay_tics ||
    !['discarded-incomplete-recorder-delivery-tail', 'unresolved-after-controller-fault'].includes(
      tail.accounting_disposition
    ) ||
    tail.proposals_used_completed_windows_only !== true ||
    tail.decoded_proposal_only !== true ||
    tail.scientific_authority !== false
  ) {
    fail('NEST tail disposition semantics differ')
  }
  return ledgerDigest(tail, 'receipt_sha256', 'NEST tail disposition')
}

function jsonNodeCount(value) {
  if (Array.isArray(value)) {
    return 1 + value.reduce((sum, child) => sum + jsonNodeCount(child), 0)
  }
  if (value !== null && typeof value === 'object') {
    return 1 + Object.values(value).reduce((sum, child) => sum + 1 + jsonNodeCount(child), 0)
  }
  return 1
}

export function assertNestEvidenceBudget(evidence, work) {
  const observedNodes = jsonNodeCount(evidence)
  const observedBytes = Buffer.byteLength(managedRuntimeCanonical(evidence), 'utf8')
  if (
    observedNodes > NEST_WORK_LIMITS.max_evidence_bundle_nodes ||
    observedBytes > NEST_WORK_LIMITS.max_evidence_bundle_bytes ||
    observedNodes > work.estimated_evidence_bundle_nodes ||
    observedBytes > work.estimated_evidence_bundle_bytes
  ) {
    fail('NEST evidence exceeds its admitted byte or node budget')
  }
  return { observedBytes, observedNodes }
}

export function assertNestReceiptSemantics(terminal, evidence) {
  assertImportedReceiptSchema(evidence, 'nest', 'NEST evidence bundle')
  const expectation = evidence.runtime_launch_expectation
  const session = evidence.nest_session_readback
  const identity = evidence.worker_runtime_identity
  const tail = evidence.tail_disposition_receipt
  const timing = assertNestLaunchExpectationSemantics(expectation)
  ledgerDigest(expectation, 'receipt_sha256', 'NEST worker launch expectation')
  if (
    session === null ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    tail === null ||
    typeof tail !== 'object' ||
    Array.isArray(tail)
  ) {
    fail('successful NEST receipt semantics are incomplete')
  }
  const resourceLimits = identity.resource_limits
  if (
    identity.schema_version !== 'engram.nest-worker-runtime-identity.v2' ||
    identity.isolated_flag !== 1 ||
    identity.no_site_flag !== 1 ||
    identity.ignore_environment_flag !== 1 ||
    identity.no_user_site_flag !== 1 ||
    identity.reported_nest_version !== '3.9.0' ||
    identity.project_source_closure_verified !== true ||
    identity.external_dependency_closure_attested !== false ||
    identity.response_bound_loaded_bytes !== false ||
    identity.loaded_bytes_attested !== false ||
    resourceLimits?.schema_version !== 'engram.nest-worker-resource-limits.v1' ||
    resourceLimits.profile !== 'portable-posix-rlimit-v1' ||
    resourceLimits.platform !== expectation.platform ||
    resourceLimits.address_space_bytes !== expectation.address_space_bytes ||
    resourceLimits.address_space_limit_enforced !== expectation.address_space_limit_enforced ||
    resourceLimits.address_space_limit_enforced !== (resourceLimits.address_space_bytes !== null) ||
    (resourceLimits.platform === 'linux') !== resourceLimits.address_space_limit_enforced ||
    resourceLimits.cpu_time_seconds !== 300 ||
    resourceLimits.file_size_bytes !== 67108864 ||
    resourceLimits.open_file_count !== 256 ||
    resourceLimits.core_file_bytes !== 0 ||
    resourceLimits.applied_before_nest_import !== true ||
    resourceLimits.network_namespace_isolation !== false ||
    resourceLimits.syscall_filter !== false ||
    resourceLimits.production_isolation !== false
  ) {
    fail('NEST runtime identity or resource-limit semantics differ')
  }
  ledgerDigest(resourceLimits, 'receipt_sha256', 'NEST worker resource limits')
  ledgerDigest(identity, 'receipt_sha256', 'NEST worker runtime identity')
  const work = assertNestSessionSemantics(session, terminal, timing.config, timing)
  const priorState = new Map(
    session.population_roster.flatMap((row) =>
      row.population_names.map((populationName) => [
        populationName,
        {
          watermark: 0,
          pendingCount: 0,
          pendingDigest: sha256(Buffer.from(ledgerCanonical([]))),
          lastEventCount: 0,
          counterMayPersist: false,
        },
      ])
    )
  )
  const executions = evidence.step_execution_receipts
  const attempts = evidence.step_attempt_receipts
  if (!Array.isArray(executions) || !Array.isArray(attempts)) {
    fail('NEST receipt step rosters are absent')
  }
  for (const [index, execution] of executions.entries()) {
    const digest = assertNestStepExecutionSemantics(execution, session, priorState)
    if (
      execution.step_index !== index + 1 ||
      execution.before_biological_time_tics !== index * timing.durationTics ||
      execution.after_biological_time_tics !== (index + 1) * timing.durationTics ||
      execution.requested_run_tics !== timing.durationTics ||
      attempts[index]?.execution_receipt_sha256 !== digest
    ) {
      fail(`NEST step ${index + 1} execution sequence differs`)
    }
  }
  for (const [index, attempt] of attempts.entries()) {
    assertNestStepAttemptSemantics(attempt)
    if (
      attempt.attempt_index !== index + 1 ||
      attempt.step_index !== index + 1 ||
      attempt.before_biological_time_tics !== index * timing.durationTics
    ) {
      fail(`NEST step ${index + 1} attempt sequence differs`)
    }
  }
  const successful = attempts.filter((row) => row.outcome === 'succeeded')
  const unsuccessful = attempts.filter((row) => row.outcome !== 'succeeded')
  if (
    unsuccessful.length > 1 ||
    (unsuccessful.length === 1 && attempts.at(-1) !== unsuccessful[0]) ||
    canonical(successful.map((row) => row.execution_receipt_sha256)) !==
      canonical(executions.map((row) => row.receipt_sha256))
  ) {
    fail('NEST attempt and execution rosters differ')
  }
  assertNestTailSemantics(tail, session, priorState)
  assertNestEvidenceBudget(evidence, work)
  return { session, work, finalState: priorState }
}

const MAX_CROSS_RUNTIME_TANH_ULPS = 2n

function orderedFloatBits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('cross-runtime float comparison received a non-finite value')
  }
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value, false)
  const bits = view.getBigUint64(0, false)
  return (bits & 0x8000000000000000n) !== 0n
    ? ~bits & 0xffffffffffffffffn
    : bits | 0x8000000000000000n
}

function withinFloatUlps(observed, expected, maximumUlps = MAX_CROSS_RUNTIME_TANH_ULPS) {
  if (Object.is(observed, expected)) return true
  const left = orderedFloatBits(observed)
  const right = orderedFloatBits(expected)
  const distance = left >= right ? left - right : right - left
  return distance <= maximumUlps
}

function assertPlanNeuralControlSemantics(plan, session, count) {
  assertClosedSchemaValue(
    plan,
    CLOSED_LOOP_RUN_PLAN_SCHEMA,
    CLOSED_LOOP_RUN_PLAN_SCHEMA,
    'run plan'
  )
  const channels = plan?.channels
  if (
    plan?.schema_version !== 'engram.extension-closed-loop-run-plan.v1' ||
    !Array.isArray(channels) ||
    channels.length !== count ||
    canonical(channels.map((row) => row.channel_id)) !==
      canonical([...channels.map((row) => row.channel_id)].sort(compareUnicodeCodePoints)) ||
    new Set(channels.map((row) => row.channel_id)).size !== channels.length ||
    session.control_bindings.length !== channels.length
  ) {
    fail(`${count}-drone run-plan neural control roster differs`)
  }
  for (const [channelIndex, channel] of channels.entries()) {
    const binding = session.control_bindings[channelIndex]
    exactManagedFloatVector(channel.action_min, channel.action_width, 'run-plan action minimum')
    exactManagedFloatVector(channel.action_max, channel.action_width, 'run-plan action maximum')
    exactManagedFloatVector(channel.safe_action, channel.action_width, 'run-plan safe action')
    if (
      !Number.isSafeInteger(channel.observation_width) ||
      channel.observation_width < 1 ||
      channel.observation_width > 16 ||
      !Number.isSafeInteger(channel.action_width) ||
      channel.action_width < 1 ||
      channel.action_width > 16 ||
      channel.observation_components?.length !== channel.observation_width ||
      channel.action_components?.length !== channel.action_width ||
      channel.neural_control_axes?.length !== channel.action_width ||
      binding.channel_id !== channel.channel_id ||
      binding.axis_binding_sha256s.length !== channel.action_width
    ) {
      fail(`${count}-drone run-plan channel dimensions differ`)
    }
    const codecMaterial = {
      domain: 'engram-neural-control-codec-v1',
      observation_space_id: channel.observation_space_id,
      action_space_id: channel.action_space_id,
      observation_components: channel.observation_components,
      action_components: channel.action_components,
      axes: channel.neural_control_axes,
    }
    if (
      binding.neural_codec_sha256 !== sha256(Buffer.from(managedRuntimeCanonical(codecMaterial)))
    ) {
      fail(`${count}-drone run-plan neural codec digest differs`)
    }
    const consumed = new Set()
    for (const [axisIndex, axis] of channel.neural_control_axes.entries()) {
      const gain = exactLedgerFloat(
        axis,
        'decoded_action_gain',
        `${count}-drone run-plan decoded action gain`
      ).value
      const indices = axis.terms?.map((term) => term.observation_index)
      if (
        axis.action_index !== axisIndex ||
        axis.encoder !== 'affine-sum-clamped-v1' ||
        !Array.isArray(indices) ||
        indices.length < 1 ||
        canonical(indices) !== canonical([...indices].sort((left, right) => left - right)) ||
        new Set(indices).size !== indices.length ||
        gain <= 0 ||
        gain > 1 ||
        binding.axis_binding_sha256s[axisIndex] !== sha256(Buffer.from(ledgerCanonical(axis)))
      ) {
        fail(`${count}-drone run-plan neural axis differs`)
      }
      for (const term of axis.terms) {
        const reference = exactLedgerFloat(
          term,
          'reference_value',
          `${count}-drone run-plan control reference`
        ).value
        const termGain = exactLedgerFloat(
          term,
          'gain_per_observation_unit',
          `${count}-drone run-plan control gain`
        ).value
        if (
          !Number.isSafeInteger(term.observation_index) ||
          term.observation_index < 0 ||
          term.observation_index >= channel.observation_width ||
          !Number.isFinite(reference) ||
          termGain === 0
        ) {
          fail(`${count}-drone run-plan control term differs`)
        }
        consumed.add(term.observation_index)
      }
      const minimum = channel.action_min[axisIndex]
      const maximum = channel.action_max[axisIndex]
      const safe = channel.safe_action[axisIndex]
      if (!(minimum < maximum && minimum <= safe && safe <= maximum)) {
        fail(`${count}-drone run-plan action bounds differ`)
      }
    }
    if (
      consumed.size !== channel.observation_width ||
      [...consumed].some((index) => index < 0 || index >= channel.observation_width)
    ) {
      fail(`${count}-drone run-plan neural codec does not consume every observation`)
    }
  }
  return channels
}

export function assertNestControllerChain(capture, evidence, count) {
  const session = evidence.nest_session_readback
  const config = capture.nest_config
  const channels = assertPlanNeuralControlSemantics(capture.run_plan, session, count)
  const bindingByChannel = new Map(
    session.control_bindings.map((binding) => [binding.channel_id, binding])
  )
  const previousHold = new Map(channels.map((channel) => [channel.channel_id, false]))
  const baseline = exactLedgerFloat(config, 'baseline_rate_hz', 'NEST baseline rate').value
  const span = exactLedgerFloat(config, 'input_span_hz', 'NEST input span').value
  const fullScaleWeight = exactLedgerFloat(
    config,
    'input_weight_mv',
    'NEST full-scale input weight'
  ).value
  const outputScale = exactLedgerFloat(
    config,
    'output_rate_scale_hz',
    'NEST output rate scale'
  ).value
  const carrier = baseline + span
  if (
    !/^3\.11\.[0-9]+(?:\s|$)/u.test(evidence.worker_runtime_identity?.python_version ?? '') ||
    ledgerCanonical(config) !==
      ledgerCanonical(evidence.runtime_launch_expectation.controller_configuration)
  ) {
    fail(`${count}-drone NEST configuration chain differs`)
  }
  for (const [stepOffset, neuralStep] of capture.neural_steps.entries()) {
    const execution = evidence.step_execution_receipts[stepOffset]
    const sourceFaultCodes =
      stepOffset === 0
        ? Array.from({ length: channels.length }, () => 'none')
        : capture.terminal_receipt?.steps?.[stepOffset - 1]?.fault_codes
    if (!Array.isArray(sourceFaultCodes) || sourceFaultCodes.length !== channels.length) {
      fail(`${count}-drone step ${stepOffset + 1} source fault roster differs`)
    }
    const requestByChannel = new Map(
      neuralStep.request.channels.map((row) => [row.channel_id, row])
    )
    const proposalByChannel = new Map(
      neuralStep.result.proposals.map((row) => [row.channel_id, row])
    )
    const encodingByKey = new Map(
      execution.encoded_control_inputs.map((row) => [`${row.channel_id}\0${row.action_index}`, row])
    )
    const safetyByChannel = new Map(
      execution.channel_safety_readbacks.map((row) => [row.channel_id, row])
    )
    const weightByPopulation = new Map(
      execution.input_weight_readbacks.map((row) => [row.population_name, row])
    )
    const scheduleByPopulation = new Map(
      execution.generator_schedule_readbacks.map((row) => [row.population_name, row])
    )
    const windowByPopulation = new Map(
      execution.completed_window_readbacks.map((row) => [row.population_name, row])
    )
    for (const [channelIndex, channel] of channels.entries()) {
      const request = requestByChannel.get(channel.channel_id)
      const proposal = proposalByChannel.get(channel.channel_id)
      const safety = safetyByChannel.get(channel.channel_id)
      const binding = bindingByChannel.get(channel.channel_id)
      const sourceFaultCode = sourceFaultCodes[channelIndex]
      const sourceRequiresHold = sourceFaultCode === 'sensor-unavailable'
      const recovery = previousHold.get(channel.channel_id) && !request?.hold_required
      const safetyRequired = request?.hold_required === true || recovery
      const disposition = request?.hold_required
        ? 'held-neutralized'
        : recovery
          ? 'recovery-washout'
          : 'encoded-observation'
      if (
        request === undefined ||
        proposal === undefined ||
        safety === undefined ||
        binding === undefined ||
        request.subject_id !== channel.subject_id ||
        request.observation_values.length !== channel.observation_width ||
        request.fault_code !== sourceFaultCode ||
        request.hold_required !== sourceRequiresHold ||
        (sourceRequiresHold && request.observation_values.some((value) => !Object.is(value, 0))) ||
        safety.hold_required !== request.hold_required ||
        safety.recovery_from_hold !== recovery ||
        safety.input_disposition !== disposition ||
        proposal.values.length !== channel.action_width
      ) {
        fail(`${count}-drone step ${stepOffset + 1} controller safety chain differs`)
      }
      for (const axis of channel.neural_control_axes) {
        const encoding = encodingByKey.get(`${channel.channel_id}\0${axis.action_index}`)
        let raw = 0
        if (!safetyRequired) {
          for (const term of axis.terms) {
            raw +=
              (request.observation_values[term.observation_index] - term.reference_value) *
              term.gain_per_observation_unit
          }
        }
        const normalized = Math.max(-1, Math.min(1, raw))
        const negativeName = `${channel.neural_population_prefix}.d${axis.action_index
          .toString()
          .padStart(2, '0')}.negative`
        const positiveName = `${channel.neural_population_prefix}.d${axis.action_index
          .toString()
          .padStart(2, '0')}.positive`
        if (
          encoding === undefined ||
          encoding.axis_binding_sha256 !== binding.axis_binding_sha256s[axis.action_index] ||
          encoding.neural_codec_sha256 !== binding.neural_codec_sha256 ||
          !Object.is(encoding.raw_affine_sum, raw) ||
          !Object.is(encoding.normalized_input, normalized) ||
          encoding.clamped !== (raw < -1 || raw > 1) ||
          encoding.input_disposition !== disposition
        ) {
          fail(`${count}-drone step ${stepOffset + 1} affine controller encoding differs`)
        }
        for (const [sign, populationName, signedValue] of [
          ['negative', negativeName, Math.max(-normalized, 0)],
          ['positive', positiveName, Math.max(normalized, 0)],
        ]) {
          const weight = weightByPopulation.get(populationName)
          const schedule = scheduleByPopulation.get(populationName)
          const desired = safetyRequired ? 0 : baseline + span * signedValue
          const requestedWeight = (fullScaleWeight * desired) / carrier
          if (
            weight === undefined ||
            schedule === undefined ||
            weight.input_disposition !== disposition ||
            !Object.is(weight.constant_generator_rate_hz, carrier) ||
            !Object.is(weight.desired_equivalent_rate_hz, desired) ||
            !Object.is(weight.configured_full_scale_weight_mv, fullScaleWeight) ||
            !Object.is(weight.requested_weight_mv, requestedWeight) ||
            !Object.is(weight.effective_weight_mv, requestedWeight) ||
            !Object.is(schedule.requested_rate_hz, carrier) ||
            !Object.is(schedule.effective_rate_hz, carrier) ||
            (safetyRequired && (desired !== 0 || requestedWeight !== 0)) ||
            !['negative', 'positive'].includes(sign)
          ) {
            fail(`${count}-drone step ${stepOffset + 1} signed carrier encoding differs`)
          }
        }
        const negativeWindow = windowByPopulation.get(negativeName)
        const positiveWindow = windowByPopulation.get(positiveName)
        if (
          negativeWindow === undefined ||
          positiveWindow === undefined ||
          negativeWindow.completed_window_tics !== positiveWindow.completed_window_tics
        ) {
          fail(`${count}-drone step ${stepOffset + 1} decoded population window differs`)
        }
        const windowTics = positiveWindow.completed_window_tics
        const denominator = config.population_size * (windowTics / 1000000)
        const negativeRate = negativeWindow.completed_event_count / denominator
        const positiveRate = positiveWindow.completed_event_count / denominator
        const normalizedOutput = Math.tanh((positiveRate - negativeRate) / outputScale)
        const limit =
          normalizedOutput >= 0
            ? channel.action_max[axis.action_index]
            : Math.abs(channel.action_min[axis.action_index])
        const proposalScale = limit * axis.decoded_action_gain
        const expectedProposal = safetyRequired ? 0 : normalizedOutput * proposalScale
        const observedProposal = proposal.values[axis.action_index]
        if (
          (safetyRequired && !Object.is(observedProposal, 0)) ||
          (!safetyRequired && !withinFloatUlps(observedProposal, expectedProposal))
        ) {
          fail(`${count}-drone step ${stepOffset + 1} decoded proposal differs from spike counts`)
        }
      }
      previousHold.set(channel.channel_id, request.hold_required)
    }
  }
}

function assertPopulationTopology(capture, evidence, neuralSteps, count) {
  const expected = expectedPopulationTopology(capture)
  const topology = expected.topology
  if (canonical(capture.population_topology) !== canonical(topology)) {
    fail(`${count}-drone v2 capture exact 6N topology summary differs`)
  }
  const session = evidence.nest_session_readback
  const connectionRows = session.connection_readbacks
  const expectedConnections = topology.population_names.flatMap((populationName) =>
    ['input', 'recorder'].map((direction) => [populationName, direction])
  )
  if (
    !Array.isArray(connectionRows) ||
    connectionRows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row)) ||
    canonical(connectionRows.map((row) => [row.population_name, row.direction])) !==
      canonical(expectedConnections) ||
    connectionRows.some((row) => row.connection_count !== capture.nest_config.population_size) ||
    session.connection_readback_sha256 !== sha256(ledgerCanonical(connectionRows)) ||
    session.observed_population_neuron_count !== topology.population_neuron_count ||
    session.observed_device_node_count !== topology.device_node_count ||
    session.observed_total_connection_count !== topology.connection_count ||
    canonical(session.population_roster) !== canonical(expected.populationRoster) ||
    session.population_roster_sha256 !== sha256(ledgerCanonical(session.population_roster))
  ) {
    fail(`${count}-drone v2 capture NEST topology readback differs`)
  }
  for (const [stepIndex, [execution, neuralStep]] of evidence.step_execution_receipts
    .map((execution, index) => [execution, neuralSteps[index]])
    .entries()) {
    for (const key of [
      'generator_schedule_readbacks',
      'input_weight_readbacks',
      'completed_window_readbacks',
      'population_event_deltas',
    ]) {
      if (
        !Array.isArray(execution[key]) ||
        canonical(execution[key].map((row) => row?.population_name)) !==
          canonical(topology.population_names)
      ) {
        fail(`${count}-drone v2 capture step ${stepIndex + 1} population readback differs`)
      }
    }
    if (
      canonical(execution.channel_safety_readbacks?.map((row) => row?.channel_id)) !==
        canonical(expected.channelIds) ||
      canonical(
        execution.encoded_control_inputs?.map((row) => [row?.channel_id, row?.action_index])
      ) !== canonical(expected.axisRoster) ||
      canonical(neuralStep.request?.channels?.map((row) => row?.channel_id)) !==
        canonical(expected.channelIds) ||
      canonical(neuralStep.result?.proposals?.map((row) => row?.channel_id)) !==
        canonical(expected.channelIds)
    ) {
      fail(`${count}-drone v2 capture step ${stepIndex + 1} channel topology differs`)
    }
    for (const proposal of neuralStep.result.proposals) {
      if (
        canonical(proposal.source_populations) !==
        canonical(expected.populationBindings.get(proposal.channel_id))
      ) {
        fail(`${count}-drone v2 capture step ${stepIndex + 1} proposal population binding differs`)
      }
    }
  }
  return topology
}

function assertNestEvidenceClosure(terminal, evidence, count) {
  exactKeys(evidence, NEST_EVIDENCE_KEYS, 'NEST closed-loop evidence bundle')
  if (
    evidence.schema_version !== 'engram.nest-closed-loop-evidence-bundle.v2' ||
    evidence.digest_canonicalization !== 'engram.managed-runtime-json.v1' ||
    evidence.profile !== 'killable-nest-population-controller-v2' ||
    evidence.worker_terminal_disposition !== 'confirmed-lifecycle' ||
    evidence.execution_authority !== false ||
    evidence.ncp_control !== false ||
    evidence.physical_actuation !== false ||
    evidence.scientific_authority !== false ||
    evidence.is_paper_local_evidence !== false ||
    evidence.calibrated_posterior !== false
  ) {
    fail(`${count}-drone NEST evidence identity or authority differs`)
  }
  const expectation = evidence.runtime_launch_expectation
  const launch = evidence.worker_launch_attempt
  const preparation = evidence.preparation_attempt
  const capabilities = evidence.child_capabilities
  const identity = evidence.worker_runtime_identity
  const childPrepared = evidence.child_preparation_receipt
  const providerPrepared = evidence.provider_preparation_receipt
  const binding = evidence.worker_session_binding
  const session = evidence.nest_session_readback
  const tail = evidence.tail_disposition_receipt
  const lifecycle = evidence.worker_lifecycle_receipt
  if (
    [
      expectation,
      launch,
      preparation,
      capabilities,
      identity,
      childPrepared,
      providerPrepared,
      binding,
      session,
      tail,
      lifecycle,
    ].some((value) => value === null || typeof value !== 'object' || Array.isArray(value)) ||
    !Array.isArray(evidence.step_execution_receipts) ||
    !Array.isArray(evidence.step_attempt_receipts) ||
    !Array.isArray(evidence.worker_termination_attempt_receipts)
  ) {
    fail(`${count}-drone successful NEST evidence lacks a closed receipt roster`)
  }
  assertNestReceiptSemantics(terminal, evidence)
  const expectationDigest = ledgerDigest(
    expectation,
    'receipt_sha256',
    'NEST worker launch expectation'
  )
  const launchDigest = ledgerDigest(launch, 'receipt_sha256', 'NEST worker launch attempt')
  const preparationDigest = ledgerDigest(
    preparation,
    'receipt_sha256',
    'NEST worker preparation attempt'
  )
  const identityDigest = ledgerDigest(identity, 'receipt_sha256', 'NEST worker runtime identity')
  const childPreparedDigest = managedRuntimeDigest(
    childPrepared,
    'receipt_sha256',
    'NEST child preparation receipt'
  )
  const providerPreparedDigest = managedRuntimeDigest(
    providerPrepared,
    'receipt_sha256',
    'NEST provider preparation receipt'
  )
  const bindingDigest = ledgerDigest(binding, 'receipt_sha256', 'NEST worker session binding')
  const sessionDigest = ledgerDigest(session, 'receipt_sha256', 'NEST session readback')
  const tailDigest = ledgerDigest(tail, 'receipt_sha256', 'NEST tail disposition')
  const lifecycleDigest = ledgerDigest(lifecycle, 'receipt_sha256', 'NEST worker lifecycle receipt')
  if (
    evidence.run_receipt_sha256 !== terminal.receipt_sha256 ||
    evidence.study_run_id !== terminal.study_run_id ||
    evidence.neural_provider_identity_sha256 !== terminal.neural_provider_identity_sha256 ||
    evidence.neural_preparation_sha256 !== terminal.neural_preparation_sha256 ||
    terminal.neural_durable_evidence_profile !== 'engram.nest-closed-loop-evidence-bundle.v2' ||
    preparation.study_run_id !== evidence.study_run_id ||
    preparation.definition_sha256 !== terminal.closed_loop_definition_sha256 ||
    preparation.outcome !== 'succeeded' ||
    preparation.phase !== 'provider-prepare' ||
    preparation.reason_code !== 'neural.prepare-succeeded' ||
    preparation.worker_request_dispatched !== true ||
    preparation.worker_response_observed !== true ||
    preparation.runtime_launch_expectation_sha256 !== expectationDigest ||
    preparation.worker_launch_attempt_sha256 !== launchDigest ||
    preparation.runtime_identity_receipt_sha256 !== identityDigest ||
    preparation.provider_preparation_receipt_sha256 !== providerPreparedDigest ||
    preparation.session_binding_receipt_sha256 !== bindingDigest ||
    launch.launch_expectation_sha256 !== expectationDigest ||
    launch.outcome !== 'succeeded' ||
    launch.phase !== 'worker-ready' ||
    launch.reason_code !== 'neural.nest-worker-launch-succeeded' ||
    launch.guardian_started !== true ||
    launch.guardian_ready_observed !== true ||
    launch.worker_started !== true ||
    launch.stderr_drain_started !== true ||
    launch.process_group_id !== launch.worker_pid ||
    launch.guardian_pid === launch.process_group_id ||
    launch.production_isolation !== false ||
    launch.scientific_authority !== false ||
    capabilities.schema_version !== 'engram.closed-loop-neural-capabilities.v1' ||
    capabilities.provider !== 'engram.nest-population-controller' ||
    capabilities.provider_identity_sha256 !== expectation.expected_child_provider_identity_sha256 ||
    capabilities.deadline_enforcement !== 'cooperative-observed' ||
    capabilities.session_model !== 'one-session-named-populations' ||
    capabilities.max_channels !== 64 ||
    capabilities.automatic_restart !== false ||
    capabilities.physical_actuation !== false ||
    capabilities.ncp_transport !== false ||
    capabilities.loaded_bytes_attested !== false ||
    capabilities.durable_evidence_profile !== 'none'
  ) {
    fail(`${count}-drone NEST launch or preparation lineage differs`)
  }
  if (
    providerPrepared.study_run_id !== evidence.study_run_id ||
    providerPrepared.definition_sha256 !== preparation.definition_sha256 ||
    providerPrepared.provider_identity_sha256 !== evidence.neural_provider_identity_sha256 ||
    providerPrepared.provider_session_receipt_sha256 !== bindingDigest ||
    providerPrepared.receipt_sha256 !== evidence.neural_preparation_sha256 ||
    childPrepared.study_run_id !== evidence.study_run_id ||
    childPrepared.definition_sha256 !== preparation.definition_sha256 ||
    childPrepared.provider_identity_sha256 !== capabilities.provider_identity_sha256 ||
    childPrepared.provider_session_receipt_sha256 !== sessionDigest ||
    canonical(childPrepared.populations) !== canonical(session.population_roster) ||
    childPrepared.step_duration_tics !== session.requested_step_duration_tics ||
    providerPrepared.step_duration_tics !== childPrepared.step_duration_tics ||
    canonical(providerPrepared.populations) !== canonical(childPrepared.populations) ||
    capabilities.declared_step_duration_tics !== session.requested_step_duration_tics ||
    binding.study_run_id !== evidence.study_run_id ||
    binding.parent_provider_identity_sha256 !== evidence.neural_provider_identity_sha256 ||
    binding.runtime_launch_expectation_sha256 !== expectationDigest ||
    binding.worker_launch_attempt_sha256 !== launchDigest ||
    binding.worker_source_sha256 !== expectation.worker_source_sha256 ||
    binding.guardian_source_sha256 !== expectation.guardian_source_sha256 ||
    binding.adapter_source_sha256 !== expectation.adapter_source_sha256 ||
    binding.worker_command_sha256 !== expectation.worker_command_sha256 ||
    binding.worker_runtime_identity_sha256 !== identityDigest ||
    binding.worker_project_source_roster_sha256 !== identity.project_source_roster_sha256 ||
    binding.child_provider_identity_sha256 !== capabilities.provider_identity_sha256 ||
    binding.child_capabilities_sha256 !== sha256(ledgerCanonical(capabilities)) ||
    binding.child_prepared_receipt_sha256 !== childPreparedDigest ||
    binding.child_session_receipt_sha256 !== sessionDigest ||
    terminal.neural_session_receipt_sha256 !== bindingDigest ||
    terminal.timebase?.neural_step_duration_tics !== session.requested_step_duration_tics
  ) {
    fail(`${count}-drone NEST prepared session lineage differs`)
  }
  const duration = session.requested_step_duration_tics
  const executions = evidence.step_execution_receipts
  const attempts = evidence.step_attempt_receipts
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    executions.length !== 6 ||
    attempts.length !== executions.length ||
    terminal.neural_executions?.length !== executions.length
  ) {
    fail(`${count}-drone NEST step evidence cardinality differs`)
  }
  for (let index = 0; index < executions.length; index += 1) {
    const execution = executions[index]
    const attempt = attempts[index]
    const terminalExecution = terminal.neural_executions[index]
    const executionDigest = ledgerDigest(
      execution,
      'receipt_sha256',
      `NEST step ${index + 1} execution`
    )
    ledgerDigest(attempt, 'receipt_sha256', `NEST step ${index + 1} attempt`)
    if (
      execution.step_index !== index + 1 ||
      execution.before_biological_time_tics !== index * duration ||
      execution.after_biological_time_tics !== (index + 1) * duration ||
      execution.requested_run_tics !== duration ||
      execution.scientific_authority !== false ||
      attempt.attempt_index !== index + 1 ||
      attempt.step_index !== index + 1 ||
      attempt.before_biological_time_tics !== index * duration ||
      attempt.observed_after_biological_time_tics !== (index + 1) * duration ||
      attempt.requested_run_tics !== duration ||
      attempt.outcome !== 'succeeded' ||
      attempt.reason_code !== 'neural.step-succeeded' ||
      attempt.simulation_dispatched !== true ||
      attempt.simulation_returned !== true ||
      attempt.decoded_proposal_produced !== true ||
      attempt.execution_receipt_sha256 !== executionDigest ||
      attempt.scientific_authority !== false ||
      terminalExecution?.provider_execution_scope !== 'nest-exact-step-readback' ||
      terminalExecution?.step_index !== index + 1 ||
      terminalExecution?.provider_execution_sha256 !== executionDigest ||
      terminalExecution?.neural_request_sha256 !== attempt.request_sha256
    ) {
      fail(`${count}-drone NEST step attempt, execution, or terminal join differs`)
    }
  }
  const expectedTailNames = session.population_roster
    .flatMap((row) => row.population_names)
    .sort(compareCodePoint)
  const neuralCleanup = terminal.cleanup?.[1]
  if (
    tail.study_run_id !== evidence.study_run_id ||
    tail.final_biological_time_tics !== executions.length * duration ||
    tail.recorder_delivery_delay_tics !== session.requested_connection_delay_tics ||
    canonical(tail.population_tails?.map((row) => row.population_name)) !==
      canonical(expectedTailNames) ||
    tail.accounting_disposition !== 'discarded-incomplete-recorder-delivery-tail' ||
    tail.decoded_proposal_only !== true ||
    tail.proposals_used_completed_windows_only !== true ||
    tail.scientific_authority !== false ||
    neuralCleanup?.component !== 'neural' ||
    neuralCleanup?.confirmed !== true ||
    neuralCleanup?.containment_empty !== true ||
    neuralCleanup?.provider_lifecycle_receipt_sha256 !== lifecycleDigest ||
    neuralCleanup?.provider_terminal_receipt_sha256 !== tailDigest ||
    lifecycle.disposition !== 'clean-exit'
  ) {
    fail(`${count}-drone NEST tail or cleanup lineage differs`)
  }
  assertNoAuthorityEscalation(evidence, 'NEST closed-loop evidence bundle')
  return {
    expectationDigest,
    launchDigest,
    preparationDigest,
    identityDigest,
    bindingDigest,
    sessionDigest,
    tailDigest,
    lifecycleDigest,
  }
}

function closedLoopStepId(studyRunId, stepIndex) {
  const digest = sha256(
    managedRuntimeCanonical({
      domain: 'engram-extension-closed-loop-step-v2',
      run_id: studyRunId,
      step_index: stepIndex,
    })
  )
  return `step_${digest.slice(0, 32)}`
}

function assertTerminalReceiptClosure(terminal, expectedStepCount) {
  assertImportedReceiptSchema(terminal, 'terminal', 'terminal closed-loop receipt')
  exactKeys(terminal, TERMINAL_RECEIPT_KEYS, 'terminal closed-loop receipt')
  const timebase = terminal.timebase
  const steps = terminal.steps
  const executions = terminal.neural_executions
  const cleanup = terminal.cleanup
  const lifecycle = terminal.runtime_lifecycle
  exactKeys(lifecycle, RUNTIME_LIFECYCLE_KEYS, 'terminal runtime lifecycle')
  if (
    terminal.schema_version !== 'engram.extension-closed-loop-run-receipt.v2' ||
    terminal.digest_canonicalization !== 'engram.managed-runtime-json.v1' ||
    !Array.isArray(steps) ||
    !Array.isArray(executions) ||
    !Array.isArray(cleanup) ||
    steps.length !== expectedStepCount ||
    executions.length !== expectedStepCount ||
    cleanup.length !== 2 ||
    terminal.planned_step_count !== expectedStepCount ||
    timebase?.schema_version !== 'engram.extension-closed-loop-timebase.v1' ||
    timebase?.tic_unit !== 'microsecond' ||
    timebase?.coupling !== 'one-controller-epoch-per-runtime-interval' ||
    timebase?.clock_relation !== 'independent-controller-and-runtime-logical-clocks' ||
    timebase?.causality_policy !== 'sample-runtime-run-controller-apply-zoh-v1' ||
    timebase?.dispatch_order !== 'observe-controller-action-runtime' ||
    timebase?.observation_sample_phase !== 'runtime-interval-start' ||
    timebase?.action_application !== 'after-controller-completion-zoh-over-runtime-interval' ||
    !Number.isSafeInteger(timebase?.runtime_step_duration_tics) ||
    timebase.runtime_step_duration_tics < 1 ||
    timebase.neural_step_duration_tics !== timebase.runtime_step_duration_tics
  ) {
    fail('terminal closed-loop root or timebase differs')
  }
  let previousSnapshot = terminal.initial_snapshot_sha256
  if (!isSha256(previousSnapshot)) fail('terminal initial snapshot identity differs')
  const stepDigests = []
  const executionDigests = []
  for (let offset = 0; offset < expectedStepCount; offset += 1) {
    const index = offset + 1
    const step = steps[offset]
    const execution = executions[offset]
    const stepDigest = managedRuntimeDigest(step, 'receipt_sha256', `terminal step ${index}`)
    const executionDigest = managedRuntimeDigest(
      execution,
      'binding_sha256',
      `terminal neural execution ${index}`
    )
    const stepId = closedLoopStepId(terminal.study_run_id, index)
    if (
      step.schema_version !== 'engram.extension-closed-loop-step-receipt.v2' ||
      step.study_run_id !== terminal.study_run_id ||
      step.step_index !== index ||
      step.step_id !== stepId ||
      step.input_snapshot_sha256 !== previousSnapshot ||
      step.provider_execution_scope !== 'nest-exact-step-readback' ||
      execution.schema_version !== 'engram.closed-loop-neural-execution-binding.v1' ||
      execution.step_index !== index ||
      execution.step_id !== stepId ||
      execution.provider_execution_scope !== 'nest-exact-step-readback' ||
      ['neural_request_sha256', 'neural_result_sha256', 'provider_execution_sha256'].some(
        (field) => execution[field] !== step[field]
      ) ||
      [
        'input_snapshot_sha256',
        'neural_request_sha256',
        'neural_result_sha256',
        'provider_execution_sha256',
        'admitted_action_sha256',
        'runtime_request_sha256',
        'output_snapshot_sha256',
      ].some((field) => !isSha256(step[field]))
    ) {
      fail(`terminal step ${index} lineage differs`)
    }
    previousSnapshot = step.output_snapshot_sha256
    stepDigests.push(stepDigest)
    executionDigests.push(executionDigest)
  }
  const runtimeCleanup = cleanup[0]
  const neuralCleanup = cleanup[1]
  const cleanupDigests = [runtimeCleanup, neuralCleanup].map((row) =>
    managedRuntimeDigest(row, 'receipt_sha256', `terminal ${row.component} cleanup`)
  )
  const lifecycleDigest = managedRuntimeDigest(
    lifecycle,
    'binding_sha256',
    'terminal runtime lifecycle'
  )
  if (
    runtimeCleanup.schema_version !== 'engram.closed-loop-cleanup.v2' ||
    neuralCleanup.schema_version !== 'engram.closed-loop-cleanup.v2' ||
    runtimeCleanup.component !== 'runtime' ||
    runtimeCleanup.owner_identity_sha256 !== terminal.runtime_binding_sha256 ||
    runtimeCleanup.mode !== 'finish' ||
    canonical(runtimeCleanup.runtime_lifecycle) !== canonical(lifecycle) ||
    runtimeCleanup.provider_terminal_receipt_sha256 !== null ||
    runtimeCleanup.provider_lifecycle_receipt_sha256 !== null ||
    neuralCleanup.component !== 'neural' ||
    neuralCleanup.owner_identity_sha256 !== terminal.neural_provider_identity_sha256 ||
    neuralCleanup.mode !== 'close' ||
    neuralCleanup.runtime_lifecycle !== null ||
    [runtimeCleanup, neuralCleanup].some(
      (row) =>
        row.attempted !== true ||
        row.confirmed !== true ||
        row.containment_empty !== true ||
        row.reason_code !== 'loop.completed'
    ) ||
    terminal.neural_durable_evidence_profile !== 'engram.nest-closed-loop-evidence-bundle.v2' ||
    terminal.last_verified_simulation_time_tics !==
      expectedStepCount * timebase.runtime_step_duration_tics ||
    terminal.runtime_progress_disposition !== 'finished-and-host-verified' ||
    terminal.status !== 'completed' ||
    terminal.primary_reason_code !== 'loop.completed' ||
    terminal.terminal_reason_code !== 'loop.completed' ||
    terminal.cleanup_complete !== true ||
    terminal.simulator_only !== true ||
    terminal.physical_actuation !== false ||
    terminal.ncp_qualified !== false ||
    terminal.scientific_authority !== false ||
    terminal.is_paper_local_evidence !== false ||
    terminal.calibrated_posterior !== false
  ) {
    fail('terminal completion, cleanup, or authority closure differs')
  }
  const transcript = sha256(
    managedRuntimeCanonical({
      domain: 'engram-extension-closed-loop-transcript-v5',
      digest_canonicalization: terminal.digest_canonicalization,
      planned_step_count: terminal.planned_step_count,
      timebase,
      neural_preparation_sha256: terminal.neural_preparation_sha256,
      neural_session_receipt_sha256: terminal.neural_session_receipt_sha256,
      neural_durable_evidence_profile: terminal.neural_durable_evidence_profile,
      initial_snapshot_sha256: terminal.initial_snapshot_sha256,
      last_verified_simulation_time_tics: terminal.last_verified_simulation_time_tics,
      runtime_progress_disposition: terminal.runtime_progress_disposition,
      step_receipts: stepDigests,
      neural_execution_bindings: executionDigests,
      runtime_finish_sha256: terminal.runtime_finish_sha256,
      runtime_lifecycle_binding_sha256: lifecycleDigest,
      cleanup_receipts: cleanupDigests,
      status: terminal.status,
      primary_reason_code: terminal.primary_reason_code,
      terminal_reason_code: terminal.terminal_reason_code,
    })
  )
  if (terminal.transcript_sha256 !== transcript) {
    fail('terminal closed-loop transcript digest differs')
  }
  managedRuntimeDigest(terminal, 'receipt_sha256', 'terminal closed-loop receipt')
}

function assertCaptureBehaviorV2(capture, count) {
  const terminal = capture.terminal_receipt
  const evidence = capture.nest_evidence_bundle
  const neuralSteps = capture.neural_steps
  if (
    terminal === null ||
    typeof terminal !== 'object' ||
    evidence === null ||
    typeof evidence !== 'object' ||
    !Array.isArray(neuralSteps) ||
    neuralSteps.length !== 6 ||
    terminal.status !== 'completed' ||
    terminal.cleanup_complete !== true ||
    terminal.simulator_only !== true ||
    terminal.ncp_qualified !== false ||
    terminal.physical_actuation !== false ||
    terminal.scientific_authority !== false ||
    evidence.execution_authority !== false ||
    evidence.ncp_control !== false ||
    evidence.physical_actuation !== false ||
    evidence.scientific_authority !== false ||
    evidence.nest_session_readback?.reported_version !== '3.9.0' ||
    evidence.nest_session_readback?.one_session !== true ||
    !Array.isArray(evidence.step_execution_receipts) ||
    evidence.step_execution_receipts.length !== 6
  ) {
    fail(`${count}-drone v2 capture terminal or NEST evidence differs`)
  }
  exactKeys(terminal, TERMINAL_RECEIPT_KEYS, 'terminal closed-loop receipt')
  exactKeys(evidence, NEST_EVIDENCE_KEYS, 'NEST closed-loop evidence bundle')
  assertTerminalReceiptClosure(terminal, 6)
  managedRuntimeDigest(terminal, 'receipt_sha256', 'terminal closed-loop receipt')
  managedRuntimeDigest(evidence, 'bundle_sha256', 'NEST evidence bundle')
  if (evidence.run_receipt_sha256 !== terminal.receipt_sha256) {
    fail(`${count}-drone v2 capture receipt and evidence differ`)
  }
  assertNestEvidenceClosure(terminal, evidence, count)
  const expectedFaults = Array.from({ length: count }, () => 'none')
  const faulted = [...expectedFaults]
  faulted[0] = 'sensor-unavailable'
  if (
    !Array.isArray(terminal.steps) ||
    terminal.steps.length !== 6 ||
    terminal.steps.some(
      (step, index) =>
        canonical(step.fault_codes) !== canonical(index === 2 ? faulted : expectedFaults)
    )
  ) {
    fail(`${count}-drone v2 capture fault sequence differs`)
  }
  assertNeuralStepsClosure(capture, terminal, evidence, count)
  assertNestControllerChain(capture, evidence, count)
  for (const [index, neuralStep] of neuralSteps.entries()) {
    const execution = evidence.step_execution_receipts[index]
    if (
      neuralStep.request?.request_sha256 !== neuralStep.result?.request_sha256 ||
      neuralStep.result?.provider_execution_scope !== 'nest-exact-step-readback' ||
      neuralStep.result?.provider_execution_sha256 !== execution?.receipt_sha256 ||
      terminal.neural_executions?.[index]?.neural_result_sha256 !== neuralStep.result?.result_sha256
    ) {
      fail(`${count}-drone v2 capture provider lineage differs at step ${index + 1}`)
    }
  }
  const holdRequest = neuralSteps[3].request.channels
  const holdProposals = neuralSteps[3].result.proposals
  const washoutProposals = neuralSteps[4].result.proposals
  const resumedProposals = neuralSteps[5].result.proposals
  if (
    !Array.isArray(holdRequest) ||
    !Array.isArray(holdProposals) ||
    !Array.isArray(washoutProposals) ||
    !Array.isArray(resumedProposals) ||
    holdRequest.length !== count ||
    holdProposals.length !== count ||
    washoutProposals.length !== count ||
    resumedProposals.length !== count ||
    [...holdProposals, ...washoutProposals, ...resumedProposals].some(
      (row) => row === null || typeof row !== 'object' || !Array.isArray(row.values)
    ) ||
    holdRequest?.[0]?.hold_required !== true ||
    holdRequest?.slice(1).some((row) => row.hold_required) ||
    holdProposals[0].values.some((value) => value !== 0) ||
    washoutProposals[0].values.some((value) => value !== 0) ||
    !resumedProposals[0].values.some((value) => value !== 0) ||
    holdProposals.slice(1).some((row) => row.values.every((value) => value === 0)) ||
    washoutProposals.slice(1).some((row) => row.values.every((value) => value === 0))
  ) {
    fail(`${count}-drone v2 capture hold, washout, resume, or isolation differs`)
  }
  return { terminal, evidence, neuralSteps }
}

function assertCaptureV2(capturePayload, row, index, context) {
  if (sha256(capturePayload) !== row.capture_sha256) {
    fail(`v2 capture digest differs: ${row.path}`)
  }
  const capture = assertManagedRuntimeCanonicalObject(
    capturePayload,
    `${row.drone_count}-drone v2 capture`
  )
  exactKeys(capture, CAPTURE_V2_KEYS, `${row.drone_count}-drone v2 capture`)
  const earlyReviewed = exactKeys(
    capture.reviewed_native_runtime,
    new Set([
      'exec_gate_command_binding',
      'handshake_receipt',
      'termination_receipt',
      'lifecycle_binding_sha256',
      'guardian_closure_verified',
      'package_store_lineage_verified',
    ]),
    'reviewed native runtime closure'
  )
  assertImportedReceiptSchema(
    earlyReviewed.exec_gate_command_binding,
    'command',
    'reviewed runtime contained-command binding'
  )
  assertImportedReceiptSchema(
    earlyReviewed.handshake_receipt,
    'handshake',
    'reviewed runtime handshake receipt'
  )
  assertImportedReceiptSchema(
    earlyReviewed.termination_receipt,
    'termination',
    'reviewed runtime termination receipt'
  )
  assertImportedReceiptSchema(
    capture.terminal_receipt?.runtime_lifecycle,
    'lifecycle',
    'reviewed runtime lifecycle binding'
  )
  exactKeys(
    earlyReviewed.exec_gate_command_binding,
    REVIEWED_COMMAND_BINDING_KEYS,
    'reviewed runtime contained-command binding'
  )
  exactKeys(
    earlyReviewed.handshake_receipt,
    REVIEWED_HANDSHAKE_KEYS,
    'reviewed runtime handshake receipt'
  )
  exactKeys(
    earlyReviewed.termination_receipt,
    REVIEWED_TERMINATION_KEYS,
    'reviewed runtime termination receipt'
  )
  exactKeys(capture.terminal_receipt, TERMINAL_RECEIPT_KEYS, 'terminal closed-loop receipt')
  exactKeys(
    capture.terminal_receipt?.runtime_lifecycle,
    RUNTIME_LIFECYCLE_KEYS,
    'reviewed runtime lifecycle binding'
  )
  exactKeys(capture.nest_evidence_bundle, NEST_EVIDENCE_KEYS, 'NEST closed-loop evidence bundle')
  const count = row.drone_count
  const plan = context.plans.get(count)
  if (plan === undefined) fail(`${count}-drone v2 capture lacks its tracked run plan`)
  const trackedPlan = strictJsonObject(plan.bytes, `${count}-drone tracked run plan`)
  const trackedConfig = strictJsonObject(context.configBytes, 'tracked NEST configuration')
  if (
    capture.schema_version !== 'crebain.real-nest-closed-loop-capture.v2' ||
    capture.plan_exact_sha256 !== sha256(plan.bytes) ||
    capture.plan_exact_sha256 !== row.plan_exact_sha256 ||
    managedRuntimeCanonical(capture.run_plan) !== managedRuntimeCanonical(trackedPlan) ||
    capture.nest_config_exact_sha256 !== sha256(context.configBytes) ||
    ledgerCanonical(capture.nest_config) !== ledgerCanonical(trackedConfig) ||
    !Number.isInteger(capture.receipt_lock_timeout_ms) ||
    capture.receipt_lock_timeout_ms < 1 ||
    capture.receipt_lock_timeout_ms > 300000
  ) {
    fail(`${count}-drone v2 capture tracked input lineage differs`)
  }
  const proof = assertInstalledProofV3(capture.installed_package_proof)
  const proofBytes = Buffer.from(`${ledgerCanonical(proof)}\n`)
  const expectedPackage = Object.fromEntries(
    [
      'store_id',
      'package_generation_id',
      'installation_id',
      'generation_core_sha256',
      'bundle_receipt_exact_sha256',
      'seal_receipt_exact_sha256',
      'install_observation_exact_sha256',
      'package_sha256',
      'executable_sha256',
      'configuration_canonical_sha256',
      'operation_roster_sha256',
      'receipt_sha256',
      'observed_build_receipt_exact_sha256',
      'observed_build_receipt_sha256',
      'package_stage_receipt_exact_sha256',
      'package_stage_receipt_sha256',
      'engram_pack_receipt_exact_sha256',
      'engram_pack_receipt_sha256',
      'crebain_commit',
      'crebain_tree',
      'crebain_origin_main',
      'engram_commit',
      'engram_tree',
      'engram_origin_main',
      'engram_extension_tool_sha256',
      'engram_extension_tool_git_blob',
      'build_stage_seal_pack_install_lineage_verified',
      'build_source_roster_sha256',
      'build_input_identity_sha256',
      'executable_format',
      'executable_architecture',
    ].map((key) => [key, proof[key]])
  )
  if (
    capture.installed_package_proof_exact_sha256 !== sha256(proofBytes) ||
    capture.package_generation_id !== proof.package_generation_id ||
    proof.package_generation_id !== index.package.package_generation_id ||
    proof.receipt_sha256 !== index.package.receipt_sha256 ||
    proof.observed_build_receipt_exact_sha256 !==
      index.package.observed_build_receipt_exact_sha256 ||
    canonical(index.package) !== canonical(expectedPackage)
  ) {
    fail(`${count}-drone v2 capture installed-package proof lineage differs`)
  }
  const source = assertNestedSourceClosure(capture, index, proof)
  const { terminal, evidence } = assertCaptureBehaviorV2(capture, count)
  const expectedTopology = assertPopulationTopology(capture, evidence, capture.neural_steps, count)
  assertWorkerGuardianClosure(capture.nest_worker_guardian_closure, evidence, source)
  const { store, reservation } = assertReceiptStoreClosure(
    capture.receipt_store_closure,
    capture.receipt_store_sidecars,
    terminal,
    evidence,
    capture
  )
  const summary = exactKeys(capture.summary, SUMMARY_KEYS, 'closed-loop run summary')
  assertNoAuthorityEscalation(summary, 'closed-loop run summary')
  if (
    summary.authority !== false ||
    summary.calibrated_posterior !== false ||
    summary.run_status !== 'completed' ||
    summary.status !== 'recorded' ||
    !Number.isSafeInteger(summary.channel_count) ||
    summary.channel_count !== count ||
    !Number.isSafeInteger(summary.completed_step_count) ||
    summary.completed_step_count !== terminal.steps.length ||
    !Number.isSafeInteger(summary.planned_step_count) ||
    summary.planned_step_count !== terminal.planned_step_count ||
    summary.receipt_sha256 !== terminal.receipt_sha256 ||
    summary.evidence_bundle_sha256 !== evidence.bundle_sha256 ||
    summary.store_id !== store.store_id ||
    summary.reservation_id !== reservation.reservation_id ||
    summary.study_run_id !== terminal.study_run_id ||
    summary.terminal_reason_code !== terminal.terminal_reason_code ||
    summary.simulator_only !== true ||
    summary.ncp_qualified !== false ||
    summary.physical_actuation !== false ||
    summary.scientific_authority !== false
  ) {
    fail(`${count}-drone v2 capture summary differs`)
  }
  const reviewed = capture.reviewed_native_runtime
  const lifecycle = terminal.runtime_lifecycle
  exactKeys(
    reviewed,
    new Set([
      'exec_gate_command_binding',
      'handshake_receipt',
      'termination_receipt',
      'lifecycle_binding_sha256',
      'guardian_closure_verified',
      'package_store_lineage_verified',
    ]),
    'reviewed native runtime closure'
  )
  const commandBinding = reviewed.exec_gate_command_binding
  const handshake = reviewed.handshake_receipt
  const termination = reviewed.termination_receipt
  if (
    commandBinding === null ||
    typeof commandBinding !== 'object' ||
    Array.isArray(commandBinding) ||
    handshake === null ||
    typeof handshake !== 'object' ||
    Array.isArray(handshake) ||
    termination === null ||
    typeof termination !== 'object' ||
    Array.isArray(termination) ||
    lifecycle === null ||
    typeof lifecycle !== 'object' ||
    Array.isArray(lifecycle)
  ) {
    fail(`${count}-drone v2 capture reviewed-runtime receipt shape differs`)
  }
  exactKeys(
    commandBinding,
    REVIEWED_COMMAND_BINDING_KEYS,
    'reviewed runtime contained-command binding'
  )
  exactKeys(handshake, REVIEWED_HANDSHAKE_KEYS, 'reviewed runtime handshake receipt')
  exactKeys(termination, REVIEWED_TERMINATION_KEYS, 'reviewed runtime termination receipt')
  exactKeys(lifecycle, RUNTIME_LIFECYCLE_KEYS, 'reviewed runtime lifecycle binding')
  const commandDigest = ledgerDigest(
    commandBinding,
    'exec_gate_command_sha256',
    'reviewed runtime contained-command binding'
  )
  const handshakeDigest = ledgerDigest(
    handshake,
    'receipt_sha256',
    'reviewed runtime handshake receipt'
  )
  const terminationDigest = ledgerDigest(
    termination,
    'receipt_sha256',
    'reviewed runtime termination receipt'
  )
  const lifecycleDigest = managedRuntimeDigest(
    lifecycle,
    'binding_sha256',
    'reviewed runtime lifecycle binding'
  )
  const expectedArgumentShape = [
    'python',
    '-I',
    '-S',
    '-c',
    'frozen-exec-gate-source',
    '--gate-fd',
    'descriptor',
    '--ready-fd',
    'descriptor',
    '--expected-session-id',
    'supervisor-session-id',
    'target-command',
  ]
  const workerPythonExecutable = evidence.worker_runtime_identity.files.find(
    (row) => row.role === 'python-executable'
  )
  if (
    reviewed.guardian_closure_verified !== true ||
    reviewed.package_store_lineage_verified !== true ||
    reviewed.lifecycle_binding_sha256 !== lifecycleDigest ||
    commandBinding.schema_version !== 'engram.contained-exec-command.v1' ||
    canonical(commandBinding.argument_shape) !== canonical(expectedArgumentShape) ||
    !isSha256(commandBinding.target_command_sha256) ||
    commandBinding.python_executable_sha256 !== workerPythonExecutable?.sha256 ||
    commandBinding.exec_gate_source_sha256 !== source.reviewed_runtime_exec_gate_source_sha256 ||
    commandDigest !== source.reviewed_runtime_exec_gate_command_sha256 ||
    handshake.exec_gate_source_sha256 !== commandBinding.exec_gate_source_sha256 ||
    handshake.exec_gate_command_sha256 !== commandDigest ||
    source.reviewed_runtime_handshake_receipt_sha256 !== handshakeDigest ||
    source.reviewed_runtime_guardian_source_sha256 !== handshake.guardian_source_sha256 ||
    handshake.schema_version !== 'engram.reviewed-native-development-handshake.v1' ||
    handshake.profile !== 'engram.reviewed-native-development.v1' ||
    handshake.extension_id !== 'sepahead.crebain.simulation' ||
    handshake.extension_version !== '0.1.0' ||
    handshake.target_id !== 'macos-aarch64-darwin' ||
    handshake.target_id !== proof.observed_build_receipt?.cargo?.target?.target_id ||
    handshake.installation_id !== proof.installation_id ||
    handshake.executable_sha256 !== proof.executable_sha256 ||
    handshake.process_pid !== handshake.process_group_id ||
    handshake.guardian_pid === handshake.process_group_id ||
    handshake.handshake_transcript_accepted !== true ||
    handshake.child_ready_claim !== false ||
    handshake.host_local_admission !== true ||
    handshake.process_launch_performed !== true ||
    handshake.explicit_absolute_path_spawn !== true ||
    handshake.path_lookup_at_spawn !== true ||
    handshake.package_path_reopened_for_spawn !== false ||
    handshake.verified_executable_staged !== true ||
    handshake.staged_executable_owner_private !== true ||
    handshake.staged_executable_user_immutable !== true ||
    handshake.process_group_containment !== true ||
    handshake.runtime_process_group_leader !== true ||
    handshake.guardian_group_member !== true ||
    handshake.guardian_owner_loss_seal !== true ||
    handshake.guardian_generation_lease_retained !== true ||
    handshake.guardian_uncertainty_record_prepared !== true ||
    handshake.descendant_creation_denied !== true ||
    handshake.os_sandbox_enforced !== true ||
    handshake.network_isolation_enforced !== true ||
    handshake.filesystem_isolation_enforced !== false ||
    handshake.external_dependency_closure_attested !== false ||
    handshake.automatic_restart !== false ||
    handshake.publisher_authenticated !== false ||
    handshake.durable_process_launch_authority !== false ||
    handshake.replayable_live_launch_authority !== false ||
    handshake.ncp_authority !== false ||
    handshake.physical_authority !== false ||
    handshake.scientific_authority !== false ||
    termination.handshake_receipt_sha256 !== handshakeDigest ||
    termination.schema_version !== 'engram.reviewed-native-development-termination.v1' ||
    termination.generation_id !== handshake.generation_id ||
    termination.guardian_pid !== handshake.guardian_pid ||
    termination.process_group_id !== handshake.process_group_id ||
    termination.disposition !== 'clean-exit' ||
    termination.reason_code !== 'runtime.clean-exit' ||
    termination.exit_code !== 0 ||
    termination.termination_signal !== null ||
    termination.guardian_reaped !== true ||
    termination.group_signal_while_guardian_unreaped !== true ||
    termination.direct_child_signal_while_unreaped !== false ||
    termination.containment_signal_scope !== 'process-group' ||
    termination.containment_seal_signal !== 9 ||
    termination.guardian_generation_lease_held_until_containment !== true ||
    termination.durable_process_launch_authority !== false ||
    termination.ncp_authority !== false ||
    termination.physical_authority !== false ||
    termination.scientific_authority !== false ||
    lifecycle.handshake_receipt_sha256 !== handshakeDigest ||
    lifecycle.termination_receipt_sha256 !== terminationDigest ||
    lifecycle.schema_version !== 'engram.closed-loop-runtime-lifecycle-binding.v1' ||
    lifecycle.profile !== handshake.profile ||
    lifecycle.generation_id !== handshake.generation_id ||
    lifecycle.generation_directory_identity_sha256 !==
      handshake.generation_directory_identity_sha256 ||
    lifecycle.launch_source !== handshake.launch_source ||
    lifecycle.store_id !== handshake.store_id ||
    lifecycle.package_generation_id !== handshake.package_generation_id ||
    lifecycle.package_generation_lease_retained_at_launch !==
      handshake.package_generation_lease_retained ||
    lifecycle.package_generation_lease_released !== termination.package_generation_lease_released ||
    lifecycle.termination_disposition !== termination.disposition ||
    lifecycle.child_reaped !== termination.child_reaped ||
    lifecycle.containment_empty !== termination.containment_empty ||
    lifecycle.diagnostic_stream_complete !== termination.diagnostic_stream_complete ||
    lifecycle.private_work_directory_removed !== termination.private_work_directory_removed ||
    handshake.launch_source !== 'package-store-lease' ||
    handshake.package_generation_lease_retained !== true ||
    handshake.generation_directory_identity_sha256 === null ||
    lifecycle.launch_source !== 'package-store-lease' ||
    handshake.store_id !== proof.store_id ||
    handshake.package_generation_id !== proof.package_generation_id ||
    lifecycle?.store_id !== proof.store_id ||
    lifecycle?.package_generation_id !== proof.package_generation_id ||
    lifecycle?.child_reaped !== true ||
    lifecycle?.containment_empty !== true ||
    lifecycle?.private_work_directory_removed !== true ||
    lifecycle?.package_generation_lease_retained_at_launch !== true ||
    lifecycle?.package_generation_lease_released !== true ||
    lifecycle?.diagnostic_stream_complete !== true ||
    lifecycle?.termination_disposition !== 'clean-exit' ||
    lifecycle?.publisher_authenticated !== false ||
    lifecycle?.durable_process_launch_authority !== false ||
    lifecycle?.ncp_authority !== false ||
    lifecycle?.physical_authority !== false ||
    lifecycle?.scientific_authority !== false ||
    termination.child_reaped !== true ||
    termination.containment_empty !== true ||
    termination.diagnostic_stream_complete !== true ||
    termination.private_work_directory_removed !== true ||
    termination.package_generation_lease_released !== true
  ) {
    fail(`${count}-drone v2 capture reviewed-runtime lifecycle differs`)
  }
  assertNoAuthorityEscalation(reviewed, 'reviewed native runtime closure')
  const expectedAssertions = new Set([
    'fault_then_next_step_hold',
    'nest_hold_washout_and_reset_verified',
    'nest_recovery_washout_and_reset_verified',
    'resumed_nest_proposal_nonzero',
    'other_channels_never_entered_safety_mode',
    'terminal_receipt_and_neural_result_lineage_verified',
    'engram_host_and_worker_source_closure_verified',
    'reviewed_runtime_guardian_lineage_verified',
    'engram_commit_equals_local_origin_main',
    'private_frozen_run_inputs_used',
    'one_nest_session_exact_6n_population_topology_verified',
    'nest_worker_guardian_terminal_closure_verified',
    'receipt_store_artifact_closure_verified',
    'installed_generation_seal_package_bundle_store_lineage_verified',
  ])
  exactKeys(capture.assertions, expectedAssertions, 'v2 capture assertion roster')
  if (Object.values(capture.assertions).some((value) => value !== true)) {
    fail(`${count}-drone v2 capture assertion is not verified`)
  }
  assertClosedAuthority(capture.authority, `${count}-drone v2 capture`)
  assertNoAuthorityEscalation(capture, `${count}-drone v2 capture`)
  if (typeof capture.disclosure !== 'string' || capture.disclosure.length === 0) {
    fail(`${count}-drone v2 capture lacks its disclosure`)
  }
  const expectedRow = {
    drone_count: count,
    path: row.path,
    capture_sha256: sha256(capturePayload),
    plan_exact_sha256: sha256(plan.bytes),
    receipt_sha256: terminal.receipt_sha256,
    evidence_bundle_sha256: evidence.bundle_sha256,
    receipt_store_id: store.store_id,
    receipt_store_closure_sha256: store.closure_sha256,
    engram_source_closure_sha256: source.closure_sha256,
    engram_source_roster_sha256: source.source_roster_sha256,
    observed_build_receipt_exact_sha256: proof.observed_build_receipt_exact_sha256,
    population_count: expectedTopology.population_count,
    population_neuron_count: expectedTopology.population_neuron_count,
    device_node_count: expectedTopology.device_node_count,
    connection_count: expectedTopology.connection_count,
    session_count: expectedTopology.session_count,
  }
  if (canonical(row) !== canonical(expectedRow)) {
    fail(`${count}-drone v2 capture row differs from its exact 16-key closure`)
  }
  return { capture, proof, source, store }
}

function assertOperationalEvidenceV2(indexPayload, capturePayloads, context) {
  const index = assertManagedRuntimeCanonicalObject(indexPayload, 'real-NEST v2 evidence index')
  exactKeys(
    index,
    new Set([
      'schema_version',
      'profile',
      'input_suite',
      'tool_source_closure',
      'crebain_source_repository',
      'engram',
      'package',
      'installed_package_proof_exact_sha256',
      'captures',
      'assertions',
      'authority',
      'disclosure',
    ]),
    'real-NEST v2 evidence index'
  )
  if (
    index.schema_version !== 'crebain.real-nest-closed-loop-evidence-index.v2' ||
    index.profile !== 'installed-crebain-standard-v3-real-nest-3.9'
  ) {
    fail('real-NEST v2 evidence index identity differs')
  }
  exactKeys(
    index.input_suite,
    new Set([
      'schema_version',
      'exact_sha256',
      'suite_definition_sha256',
      'nest_config_exact_sha256',
    ]),
    'real-NEST v2 input suite binding'
  )
  const suiteDefinition = Object.fromEntries(
    Object.entries(context.suite).filter(([key]) => key !== 'suite_definition_sha256')
  )
  if (
    index.input_suite.schema_version !== context.suite.schema_version ||
    index.input_suite.exact_sha256 !== sha256(context.suiteBytes) ||
    index.input_suite.suite_definition_sha256 !== sha256(canonical(suiteDefinition)) ||
    index.input_suite.suite_definition_sha256 !== context.suite.suite_definition_sha256 ||
    index.input_suite.nest_config_exact_sha256 !== sha256(context.configBytes)
  ) {
    fail('real-NEST v2 tracked input suite binding differs')
  }
  const toolClosure = exactKeys(
    index.tool_source_closure,
    new Set(['schema_version', 'files', 'roster_sha256']),
    'real-NEST v2 tool source closure'
  )
  const toolRows = assertPathRows(
    toolClosure.files,
    new Set(['role', 'path', 'exact_sha256']),
    'real-NEST v2 tool source roster',
    ['path'],
    'path'
  )
  if (
    toolClosure.schema_version !== 'crebain.real-nest-tool-source-closure.v1' ||
    toolClosure.roster_sha256 !== sha256(canonical(toolRows)) ||
    canonical(toolRows.map(({ path, role }) => ({ path, role }))) !==
      canonical([...TOOL_SOURCE_ROLES].map(([path, role]) => ({ path, role }))) ||
    toolRows.some(
      (row) =>
        !isSha256(row.exact_sha256) ||
        row.exact_sha256 !== sha256(context.toolSourceBytes.get(row.path))
    )
  ) {
    fail('real-NEST v2 tool source binding differs')
  }
  const crebainSource = exactKeys(
    index.crebain_source_repository,
    new Set([
      'repository',
      'commit',
      'tree',
      'origin_main_at_capture',
      'object_format',
      'clean_at_capture',
    ]),
    'real-NEST v2 CREBAIN source repository'
  )
  const crebainObjectLength = crebainSource.object_format === 'sha1' ? 40 : 64
  if (
    canonical(crebainSource) !== canonical(context.crebainSourceRepository) ||
    typeof crebainSource.repository !== 'string' ||
    crebainSource.repository.length === 0 ||
    crebainSource.repository.includes('\n') ||
    !isGitObject(crebainSource.commit) ||
    !isGitObject(crebainSource.tree) ||
    crebainSource.origin_main_at_capture !== crebainSource.commit ||
    !['sha1', 'sha256'].includes(crebainSource.object_format) ||
    crebainSource.commit.length !== crebainObjectLength ||
    crebainSource.tree.length !== crebainObjectLength ||
    crebainSource.clean_at_capture !== true
  ) {
    fail('real-NEST v2 CREBAIN source repository identity differs')
  }
  exactKeys(
    index.engram,
    new Set(['repository', 'commit', 'tree', 'origin_main', 'object_format', 'clean']),
    'real-NEST v2 Engram identity'
  )
  const engramObjectLength = index.engram.object_format === 'sha1' ? 40 : 64
  if (
    typeof index.engram.repository !== 'string' ||
    index.engram.repository.length === 0 ||
    index.engram.repository.includes('\n') ||
    !isGitObject(index.engram.commit) ||
    !isGitObject(index.engram.tree) ||
    index.engram.origin_main !== index.engram.commit ||
    !['sha1', 'sha256'].includes(index.engram.object_format) ||
    index.engram.commit.length !== engramObjectLength ||
    index.engram.tree.length !== engramObjectLength ||
    index.engram.clean !== true
  ) {
    fail('real-NEST v2 Engram immutable identity differs')
  }
  const packageKeys = new Set([
    'store_id',
    'package_generation_id',
    'installation_id',
    'generation_core_sha256',
    'bundle_receipt_exact_sha256',
    'seal_receipt_exact_sha256',
    'install_observation_exact_sha256',
    'package_sha256',
    'executable_sha256',
    'configuration_canonical_sha256',
    'operation_roster_sha256',
    'receipt_sha256',
    'observed_build_receipt_exact_sha256',
    'observed_build_receipt_sha256',
    'package_stage_receipt_exact_sha256',
    'package_stage_receipt_sha256',
    'engram_pack_receipt_exact_sha256',
    'engram_pack_receipt_sha256',
    'crebain_commit',
    'crebain_tree',
    'crebain_origin_main',
    'engram_commit',
    'engram_tree',
    'engram_origin_main',
    'engram_extension_tool_sha256',
    'engram_extension_tool_git_blob',
    'build_stage_seal_pack_install_lineage_verified',
    'build_source_roster_sha256',
    'build_input_identity_sha256',
    'executable_format',
    'executable_architecture',
  ])
  exactKeys(index.package, packageKeys, 'real-NEST v2 installed package binding')
  if (
    !/^extstore_[a-f0-9]{64}$/u.test(index.package.store_id) ||
    !/^pkggen_[a-f0-9]{64}$/u.test(index.package.package_generation_id) ||
    !/^inst_[a-f0-9]{64}$/u.test(index.package.installation_id) ||
    index.package.crebain_origin_main !== index.package.crebain_commit ||
    index.package.crebain_commit !== crebainSource.commit ||
    index.package.crebain_tree !== crebainSource.tree ||
    index.package.crebain_origin_main !== crebainSource.origin_main_at_capture ||
    index.package.engram_commit !== index.engram.commit ||
    index.package.engram_tree !== index.engram.tree ||
    index.package.engram_origin_main !== index.engram.origin_main ||
    !isGitObject(index.package.engram_extension_tool_git_blob) ||
    index.package.engram_extension_tool_git_blob.length !== engramObjectLength ||
    index.package.build_stage_seal_pack_install_lineage_verified !== true ||
    index.package.executable_format !== 'mach-o-64' ||
    index.package.executable_architecture !== 'arm64' ||
    Object.entries(index.package).some(
      ([key, value]) =>
        ![
          'store_id',
          'package_generation_id',
          'installation_id',
          'crebain_commit',
          'crebain_tree',
          'crebain_origin_main',
          'engram_commit',
          'engram_tree',
          'engram_origin_main',
          'engram_extension_tool_git_blob',
          'build_stage_seal_pack_install_lineage_verified',
          'executable_format',
          'executable_architecture',
        ].includes(key) && !isSha256(value)
    ) ||
    !isSha256(index.installed_package_proof_exact_sha256)
  ) {
    fail('real-NEST v2 installed package identity differs')
  }
  if (
    !Array.isArray(index.captures) ||
    index.captures.length !== 3 ||
    index.captures.map((row) => row.drone_count).join(',') !== '1,2,3' ||
    index.captures.map((row) => row.path).join(',') !==
      'capture-1-drone.json,capture-2-drones.json,capture-3-drones.json'
  ) {
    fail('real-NEST v2 capture roster differs')
  }
  const observed = []
  for (const row of index.captures) {
    exactKeys(row, CAPTURE_ROW_V2_KEYS, 'real-NEST v2 capture row')
    safeRelative(row.path, 'real-NEST v2 capture path', '.json')
    const payload = capturePayloads.get(row.path)
    if (payload === undefined) fail(`real-NEST v2 capture is absent: ${row.path}`)
    observed.push(assertCaptureV2(payload, row, index, context))
  }
  compareSets(
    new Set(capturePayloads.keys()),
    new Set(index.captures.map((row) => row.path)),
    'real-NEST v2 capture file roster'
  )
  const proofs = observed.map((row) => row.proof)
  const buildSourceRepositories = proofs.map((proof) => {
    const repository = proof.observed_build_receipt.repository
    return {
      repository: repository.origin,
      commit: repository.commit,
      tree: repository.tree,
      origin_main_at_capture: repository.origin_main,
      object_format: repository.object_format,
      clean_at_capture: repository.clean,
    }
  })
  if (
    new Set(index.captures.map((row) => row.receipt_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.capture_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.evidence_bundle_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.receipt_store_id)).size !== 3 ||
    new Set(index.captures.map((row) => row.engram_source_closure_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.engram_source_roster_sha256)).size !== 1 ||
    new Set(index.captures.map((row) => row.observed_build_receipt_exact_sha256)).size !== 1 ||
    new Set(proofs.map((proof) => ledgerCanonical(proof))).size !== 1 ||
    buildSourceRepositories.some(
      (repository) => canonical(repository) !== canonical(crebainSource)
    ) ||
    index.installed_package_proof_exact_sha256 !==
      sha256(Buffer.from(`${ledgerCanonical(proofs[0])}\n`))
  ) {
    fail('real-NEST v2 captures reuse run identities or differ in common lineage')
  }
  const expectedAssertions = new Set([
    'tracked_inputs_exact',
    'one_session_per_run',
    'exact_6n_population_topology',
    'one_two_three_drone_roster',
    'distinct_receipt_and_evidence_identities',
    'distinct_closed_receipt_stores',
    'common_clean_engram_source_roster',
    'distinct_engram_runtime_source_closures',
    'crebain_source_lineage_common',
    'installed_package_lineage_common',
    'engram_pack_source_lineage_common',
    'observed_build_stage_seal_install_lineage_common',
    'observed_build_stage_seal_pack_install_lineage_common',
  ])
  exactKeys(index.assertions, expectedAssertions, 'real-NEST v2 index assertion roster')
  if (Object.values(index.assertions).some((value) => value !== true)) {
    fail('real-NEST v2 index assertion is not verified')
  }
  assertClosedAuthority(index.authority, 'real-NEST v2 evidence index')
  if (typeof index.disclosure !== 'string' || index.disclosure.length === 0) {
    fail('real-NEST v2 evidence index lacks its disclosure')
  }
}

export function assertOperationalEvidence(indexPayload, capturePayloads, context = undefined) {
  const index = strictJsonObject(indexPayload, 'real-NEST evidence index')
  if (index.schema_version !== 'crebain.real-nest-closed-loop-evidence-index.v2') {
    fail('real-NEST release verifier requires evidence index v2; v1 is historical audit-only')
  }
  if (context === undefined) {
    fail('real-NEST v2 release verification requires explicit operational input context')
  }
  assertOperationalEvidenceV2(indexPayload, capturePayloads, context)
}

function assertTrackedOperationalEvidenceV2(publication) {
  const evidenceIndex = publication.indexPayload
  const evidenceIndexDocument = strictJsonObject(evidenceIndex, 'tracked real-NEST evidence index')
  if (evidenceIndexDocument.schema_version !== 'crebain.real-nest-closed-loop-evidence-index.v2') {
    fail('operational-v2 mode requires tracked real-NEST INDEX v2')
  }
  if (!Array.isArray(evidenceIndexDocument.captures)) {
    fail('operational-v2 mode requires the tracked capture-v2 roster')
  }
  for (const row of evidenceIndexDocument.captures) {
    safeRelative(row?.path, 'tracked real-NEST capture path', '.json')
  }
  assertOperationalEvidence(
    evidenceIndex,
    publication.capturePayloads,
    operationalInputContext(publication.sourceRepository)
  )
}

function parseArguments(argv) {
  if (argv.length === 0) return undefined
  if (
    argv.length !== 5 ||
    argv[0] !== '--operational-v2' ||
    argv[1] !== '--expected-crebain-source-revision' ||
    argv[3] !== '--expected-crebain-publication-revision'
  ) {
    fail(
      'usage: check-managed-simulation-boundary.mjs [--operational-v2 --expected-crebain-source-revision C0 --expected-crebain-publication-revision C1]'
    )
  }
  return { expectedSourceRevision: argv[2], expectedPublicationRevision: argv[4] }
}

function main(argv = process.argv.slice(2)) {
  const operational = parseArguments(argv)
  const initialPublication =
    operational === undefined
      ? undefined
      : verifyOperationalPublicationRepository(
          ROOT,
          operational.expectedSourceRevision,
          operational.expectedPublicationRevision
        )
  const manifestSource = readFileSync(resolve(CRATE, 'Cargo.toml'), 'utf8')
  const sourceRoot = resolve(CRATE, 'src')
  const sourceNames = readdirSync(sourceRoot)
    .filter((name) => name.endsWith('.rs'))
    .sort()
  const sources = new Map(
    sourceNames.map((name) => [name, readFileSync(resolve(sourceRoot, name), 'utf8')])
  )
  for (const relative of EXPECTED_SOURCE_INCLUDES) {
    sources.set(relative, readFileSync(resolve(sourceRoot, relative), 'utf8'))
  }
  const payloads = new Map(
    Object.keys(EXPECTED_SCHEMA_HASHES).map((name) => [
      name,
      readFileSync(resolve(CONTRACTS, name)),
    ])
  )
  const differentialPayloads = new Map(
    Object.keys(EXPECTED_DIFFERENTIAL_HASHES).map((name) => [
      name,
      readFileSync(resolve(CONTRACTS, name)),
    ])
  )
  const evidenceSchemaPayloads = new Map(
    Object.keys(EXPECTED_EVIDENCE_SCHEMA_HASHES).map((name) => [
      name,
      readRegularNoFollow(resolve(EVIDENCE_SCHEMAS, name), MAX_OPERATIONAL_EVIDENCE_BYTES),
    ])
  )
  const runtimeReceiptSchemaPayloads = new Map(
    [...ENGRAM_RUNTIME_RECEIPT_SCHEMAS.keys()].map((name) => [
      name,
      evidenceSchemaPayloads.get(name),
    ])
  )
  assertCrateBoundary(manifestSource, sources, readdirSync(CRATE))
  assertContractGateBoundary(JSON.parse(readFileSync(resolve(ROOT, 'package.json'))))
  assertSchemaDigests(payloads)
  const wireProvenance = assertContractProvenanceBytes(
    readRegularNoFollow(resolve(CONTRACTS, 'PROVENANCE.json'), MAX_OPERATIONAL_EVIDENCE_BYTES),
    payloads
  )
  assertStandardFaultCodeSchemaBoundary(payloads)
  assertDifferentialArtifacts(differentialPayloads)
  assertEvidenceSchemas(evidenceSchemaPayloads)
  const runtimeReceiptProvenance = assertRuntimeReceiptProvenanceBytes(
    readRegularNoFollow(
      resolve(EVIDENCE_SCHEMAS, 'ENGRAM_RUNTIME_RECEIPT_PROVENANCE.json'),
      MAX_OPERATIONAL_EVIDENCE_BYTES
    ),
    runtimeReceiptSchemaPayloads
  )
  assertCommonEngramContractSource(wireProvenance, runtimeReceiptProvenance)
  assertManifestBoundary(JSON.parse(readFileSync(resolve(INTEGRATION, 'manifest.template.json'))))
  assertTranscriptBoundary(JSON.parse(readFileSync(resolve(INTEGRATION, 'sample-transcript.json'))))
  if (operational !== undefined) {
    assertTrackedOperationalEvidenceV2(initialPublication)
    const finalPublication = verifyOperationalPublicationRepository(
      ROOT,
      operational.expectedSourceRevision,
      operational.expectedPublicationRevision
    )
    if (finalPublication.state_sha256 !== initialPublication.state_sha256) {
      fail('operational publication repository changed during verification')
    }
    console.log(
      'OK: managed simulation bootstrap boundary and two-revision real-NEST v2 publication are exact'
    )
    return
  }
  console.log('OK: provider-free managed simulation bootstrap boundary is exact')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
