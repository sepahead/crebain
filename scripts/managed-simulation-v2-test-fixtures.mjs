import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const AUTHORITY = {
  simulator_only: true,
  ncp_qualified: false,
  physical_actuation: false,
  plant_control: false,
  scientific_authority: false,
}
const NO_AUTHORITY = {
  execution: false,
  installation: false,
  ncp: false,
  physical: false,
  plant: false,
  scientific: false,
}
const TARGET = {
  target_id: 'macos-aarch64-darwin',
  operating_system: 'macos',
  architecture: 'aarch64',
  abi: 'darwin',
  rust_target_triple: 'aarch64-apple-darwin',
}
const BUILD_ARGV = [
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
const SOURCE_PATHS = [
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
const GENERATOR_PATHS = [
  'scripts/build-managed-simulation-bootstrap.py',
  'scripts/managed_simulation_authoring_files.py',
  'scripts/managed_simulation_build_provenance.py',
]
const TOOL_SOURCE_ROLES = new Map([
  ['scripts/managed_simulation_authoring_files.py', 'atomic-authoring-io'],
  ['scripts/managed_simulation_build_provenance.py', 'receipt-validator'],
  ['scripts/run-managed-simulation-real-nest-proof.py', 'capture-runner'],
  ['scripts/run-managed-simulation-real-nest-suite.py', 'suite-runner'],
])
const STANDARD_SCHEMAS = {
  'engram.closed-loop-simulator.finish-request.v3':
    '486d0b94e229000b03eec04b0c6e05e6b01c9be1df1090d1c58c27bf14b09880',
  'engram.closed-loop-simulator.finish-response.v3':
    'abf670d295150b6f20d088aa88365e98f73fa4d0042859f7aa5d7a2403a45d9e',
  'engram.closed-loop-simulator.prepare-request.v3':
    'a5376511d1ba2edeef1b144074423bafc9fd88562893e3f2a4bba9718fc67e34',
  'engram.closed-loop-simulator.prepare-response.v3':
    '06fd034822ae82e164d2c14be034e0286b4f02d1345be076affebdd84fa5348a',
  'engram.closed-loop-simulator.step-request.v3':
    'aafb7c6574e83ba386acb4c10b81e5f9f4c1669e6b79208d86701b06fa473bb2',
  'engram.closed-loop-simulator.step-response.v3':
    'bac8b67dcd19fbd7addbf825cb1f3b1bf796fe28f638a84380bf906b32fcdb39',
}

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digest(label) {
  return sha256(Buffer.from(`synthetic managed-simulation fixture: ${label}`))
}

export function reseal(document, field = 'receipt_sha256') {
  const material = Object.fromEntries(Object.entries(document).filter(([key]) => key !== field))
  document[field] = sha256(Buffer.from(canonical(material)))
  return document
}

export function exactBytes(document) {
  return Buffer.from(`${canonical(document)}\n`)
}

function sourceRow(path) {
  const bytes = Buffer.from(`synthetic committed fixture: ${path}\n`)
  return {
    relative_path: path,
    size_bytes: bytes.length,
    sha256: sha256(bytes),
    git_mode: path.endsWith('.py') ? '100755' : '100644',
    git_blob: createHash('sha1').update(bytes).digest('hex'),
  }
}

function observedBuildReceipt() {
  const repository = {
    origin: 'https://github.com/sepahead/crebain.git',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    origin_main: 'a'.repeat(40),
    object_format: 'sha1',
    clean: true,
  }
  const sourceRows = SOURCE_PATHS.map(sourceRow).sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path)
  )
  const generatorRows = GENERATOR_PATHS.map(sourceRow).sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path)
  )
  const source = {
    policy: 'clean-origin-main-git-blob-and-rustc-dep-info-build-inputs.v1',
    files: sourceRows,
    roster_sha256: sha256(Buffer.from(canonical(sourceRows))),
  }
  const generator = {
    files: generatorRows,
    roster_sha256: sha256(Buffer.from(canonical(generatorRows))),
  }
  const byPath = new Map(sourceRows.map((row) => [row.relative_path, row]))
  const cargo = {
    workspace_manifest_path: 'src-tauri/Cargo.toml',
    workspace_manifest_exact_sha256: byPath.get('src-tauri/Cargo.toml').sha256,
    package_manifest_path: 'src-tauri/crates/managed-simulation/Cargo.toml',
    package_manifest_exact_sha256: byPath.get('src-tauri/crates/managed-simulation/Cargo.toml')
      .sha256,
    lock_path: 'src-tauri/Cargo.lock',
    lock_exact_sha256: byPath.get('src-tauri/Cargo.lock').sha256,
    toolchain_path: 'rust-toolchain.toml',
    toolchain_exact_sha256: byPath.get('rust-toolchain.toml').sha256,
    rust_toolchain: '1.91.1',
    rustc_version: 'rustc 1.91.1 (ed61e7d7e 2025-11-07)',
    cargo_version: 'cargo 1.91.1 (ea2d97820 2025-10-10)',
    argv: BUILD_ARGV,
    profile: 'release',
    target: TARGET,
    target_directory_policy: 'fresh-fixed-owner-private-removed-after-copy.v1',
    environment_policy: 'reject-build-override-environment-and-record-output-bytes.v1',
  }
  const inputIdentity = {
    repository,
    source_roster_sha256: source.roster_sha256,
    generator_roster_sha256: generator.roster_sha256,
    cargo,
  }
  return reseal({
    schema_version: 'crebain.managed-simulation-observed-build-receipt.v1',
    repository,
    source,
    generator,
    cargo,
    output: {
      file_name: 'crebain-managed-simulation',
      byte_length: 32,
      sha256: digest('Mach-O arm64 executable'),
      source_mode: 0o755,
      format: 'mach-o-64',
      architecture: 'arm64',
      file_type: 'executable',
    },
    input_identity_sha256: sha256(Buffer.from(canonical(inputIdentity))),
    claims: {
      observed_local_build: true,
      reproducible_build: false,
      signature: false,
      external_dependency_bytes_attested: false,
      complete_environment_attested: false,
    },
    authority: NO_AUTHORITY,
    disclosure: 'Synthetic observed build for provider-free boundary tests.',
  })
}

function packageStageReceipt(build) {
  const source = {
    byte_length: build.output.byte_length,
    sha256: build.output.sha256,
    mode: build.output.source_mode,
    format: build.output.format,
    architecture: build.output.architecture,
    file_type: build.output.file_type,
  }
  const inventory = [
    {
      relative_path: 'bin/crebain-managed-simulation',
      byte_length: build.output.byte_length,
      sha256: build.output.sha256,
      mode: 0o700,
      role: 'executable',
    },
    {
      relative_path: 'contracts/example.schema.json',
      byte_length: 3,
      sha256: sha256(Buffer.from('{}\n')),
      mode: 0o600,
      role: 'contract',
    },
  ]
  return reseal({
    schema_version: 'crebain.managed-simulation-package-stage-receipt.v1',
    observed_build_receipt_exact_sha256: sha256(exactBytes(build)),
    observed_build_receipt_sha256: build.receipt_sha256,
    crebain_commit: build.repository.commit,
    crebain_tree: build.repository.tree,
    origin_main: build.repository.origin_main,
    target: TARGET,
    recipe_exact_sha256: digest('authoring recipe'),
    configuration_exact_sha256: digest('installed configuration'),
    source_executable: source,
    staged_executable: { ...source, mode: 0o700 },
    package_inventory: inventory,
    package_inventory_sha256: sha256(Buffer.from(canonical(inventory))),
    authority: NO_AUTHORITY,
    disclosure: 'Synthetic package stage for provider-free boundary tests.',
  })
}

function engramPackReceipt(build, stage, engram) {
  return reseal({
    schema_version: 'crebain.managed-simulation-engram-pack-receipt.v1',
    engram_repository: {
      origin: engram.repository,
      commit: engram.commit,
      tree: engram.tree,
      origin_main: engram.origin_main,
      object_format: engram.object_format,
      clean: engram.clean,
    },
    engram_tool: sourceRow('scripts/engram_extension.py'),
    verification_policy: 'clean-head-origin-main-committed-tool-before-and-after-each-operation.v1',
    operations: [
      { operation: 'pack', exit_code: 0, source_reverified: true },
      { operation: 'check', exit_code: 0, source_reverified: true },
    ],
    observed_build_receipt_exact_sha256: sha256(exactBytes(build)),
    observed_build_receipt_sha256: build.receipt_sha256,
    package_stage_receipt_exact_sha256: sha256(exactBytes(stage)),
    package_stage_receipt_sha256: stage.receipt_sha256,
    seal_receipt_exact_sha256: digest('seal receipt'),
    bundle_receipt_exact_sha256: digest('bundle receipt'),
    package_generation_id: `pkggen_${digest('package generation')}`,
    claims: {
      local_pack_observed: true,
      local_check_observed: true,
      publisher_authenticated: false,
      signature: false,
      reproducible: false,
      executed_tool_loaded_bytes_attested: false,
      complete_python_environment_attested: false,
    },
    authority: NO_AUTHORITY,
    disclosure: 'Synthetic Engram pack receipt for provider-free boundary tests.',
  })
}

function installedProof(engram) {
  const build = observedBuildReceipt()
  const stage = packageStageReceipt(build)
  const pack = engramPackReceipt(build, stage, engram)
  return reseal({
    schema_version: 'crebain.standard-v3-installed-binary-proof.v3',
    observed_build_receipt_exact_sha256: sha256(exactBytes(build)),
    observed_build_receipt_sha256: build.receipt_sha256,
    observed_build_receipt: build,
    package_stage_receipt_exact_sha256: sha256(exactBytes(stage)),
    package_stage_receipt_sha256: stage.receipt_sha256,
    package_stage_receipt: stage,
    engram_pack_receipt_exact_sha256: sha256(exactBytes(pack)),
    engram_pack_receipt_sha256: pack.receipt_sha256,
    engram_pack_receipt: pack,
    crebain_commit: build.repository.commit,
    crebain_tree: build.repository.tree,
    crebain_origin_main: build.repository.origin_main,
    engram_commit: pack.engram_repository.commit,
    engram_tree: pack.engram_repository.tree,
    engram_origin_main: pack.engram_repository.origin_main,
    engram_extension_tool_sha256: pack.engram_tool.sha256,
    engram_extension_tool_git_blob: pack.engram_tool.git_blob,
    build_source_roster_sha256: build.source.roster_sha256,
    build_input_identity_sha256: build.input_identity_sha256,
    executable_format: 'mach-o-64',
    executable_architecture: 'arm64',
    store_id: `extstore_${digest('package store')}`,
    package_generation_id: `pkggen_${digest('package generation')}`,
    installation_id: `inst_${digest('installation')}`,
    generation_core_sha256: digest('generation core'),
    bundle_receipt_exact_sha256: digest('bundle receipt'),
    seal_receipt_exact_sha256: digest('seal receipt'),
    install_observation_exact_sha256: digest('install observation'),
    manifest_exact_sha256: digest('manifest'),
    package_lock_exact_sha256: digest('package lock'),
    configuration_exact_sha256: stage.configuration_exact_sha256,
    package_sha256: digest('package'),
    executable_sha256: build.output.sha256,
    configuration_canonical_sha256: digest('canonical configuration'),
    operation_roster_sha256: digest('operation roster'),
    operation_ids: [
      'crebain.simulation.finish.v1',
      'crebain.simulation.finish.v3',
      'crebain.simulation.prepare.v1',
      'crebain.simulation.prepare.v3',
      'crebain.simulation.step.v1',
      'crebain.simulation.step.v3',
    ],
    standard_schema_sha256: STANDARD_SCHEMAS,
    drone_counts: [1, 2, 3],
    step_count: 6,
    fault_step: 3,
    fault: 'sensor-unavailable',
    host_policy: ['fault-observed', 'safe-hold', 'bounded-zero-washout', 'bounded-nonzero-resume'],
    recovery_controls_sha256: {
      1: digest('one-drone recovery'),
      2: digest('two-drone recovery'),
      3: digest('three-drone recovery'),
    },
    baseline_three_controls_sha256: digest('three-drone baseline'),
    replay_exact: true,
    unaffected_lane_observations_exact: true,
    negative_clock_gate: 'standard.clock-mismatch',
    signal_cancellation_gate: 'active-SIGTERM-then-fresh-generation-prepared',
    installed_artifacts_reverified_after_execution: true,
    generation_seal_package_bundle_store_lineage_verified: true,
    build_stage_seal_install_lineage_verified: true,
    build_stage_seal_pack_install_lineage_verified: true,
    authority: AUTHORITY,
    disclosure: 'Synthetic installed proof for provider-free boundary tests.',
  })
}

function sourceClosure(engram, handshake, guardianSourceSha256) {
  const sources = ['backend/example.py', 'scripts/engram_extension.py'].map(sourceRow)
  const closure = {
    schema_version: 'crebain.engram-python-source-closure.v1',
    discovery_policy: 'loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1',
    git: engram,
    host_modules: [
      { module_name: 'backend.example', relative_path: 'backend/example.py' },
      {
        module_name: 'scripts.engram_extension',
        relative_path: 'scripts/engram_extension.py',
      },
    ],
    worker_project_modules: [],
    worker_project_source_roster_sha256: digest('worker source roster'),
    reviewed_runtime_handshake_receipt_sha256: handshake.receipt_sha256,
    reviewed_runtime_guardian_source_sha256: guardianSourceSha256,
    exercised_entrypoints: [{ role: 'runtime-cli', relative_path: 'scripts/engram_extension.py' }],
    sources,
  }
  closure.closure_sha256 = sha256(Buffer.from(canonical(closure)))
  return closure
}

function topology(plan, config) {
  const populationNames = plan.channels.flatMap((channel) =>
    [0, 1, 2].flatMap((axis) => [
      `${channel.neural_population_prefix}.d${String(axis).padStart(2, '0')}.negative`,
      `${channel.neural_population_prefix}.d${String(axis).padStart(2, '0')}.positive`,
    ])
  )
  const count = plan.channels.length
  return {
    session_count: 1,
    drone_count: count,
    action_axis_count: count * 3,
    population_count: count * 6,
    population_neuron_count: count * 6 * config.population_size,
    device_node_count: count * 12,
    connection_count: count * 12 * config.population_size,
    population_names: populationNames,
    derived_population_roster_sha256: sha256(Buffer.from(canonical(populationNames))),
  }
}

function captureFixture(count, planBytes, configBytes, proof, source, handshake) {
  const plan = JSON.parse(planBytes)
  const config = JSON.parse(configBytes)
  const expectedTopology = topology(plan, config)
  const normalFaults = Array.from({ length: count }, () => 'none')
  const scheduledFaults = [...normalFaults]
  scheduledFaults[0] = 'sensor-unavailable'
  const neuralSteps = Array.from({ length: 6 }, (_, index) => {
    const requestSha = digest(`${count}-drone request ${index + 1}`)
    const executionSha = digest(`${count}-drone execution ${index + 1}`)
    const proposals = Array.from({ length: count }, (_, channel) => ({
      values: channel === 0 && (index === 3 || index === 4) ? [0, 0, 0] : [0.25, 0.5, 0.75],
    }))
    return {
      request: {
        request_sha256: requestSha,
        channels: Array.from({ length: count }, (_, channel) => ({
          hold_required: index === 3 && channel === 0,
        })),
      },
      result: {
        request_sha256: requestSha,
        result_sha256: digest(`${count}-drone neural result ${index + 1}`),
        provider_execution_scope: 'nest-exact-step-readback',
        provider_execution_sha256: executionSha,
        proposals,
      },
    }
  })
  const termination = reseal({
    handshake_receipt_sha256: handshake.receipt_sha256,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    private_work_directory_removed: true,
    package_generation_lease_released: true,
  })
  const lifecycle = {
    handshake_receipt_sha256: handshake.receipt_sha256,
    termination_receipt_sha256: termination.receipt_sha256,
    launch_source: 'package-store-lease',
    store_id: proof.store_id,
    package_generation_id: proof.package_generation_id,
    package_generation_lease_retained_at_launch: true,
    package_generation_lease_released: true,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    private_work_directory_removed: true,
    termination_disposition: 'clean-exit',
    durable_process_launch_authority: false,
    ncp_authority: false,
    physical_authority: false,
    scientific_authority: false,
  }
  lifecycle.binding_sha256 = sha256(Buffer.from(canonical(lifecycle)))
  const terminal = reseal({
    status: 'completed',
    cleanup_complete: true,
    simulator_only: true,
    ncp_qualified: false,
    physical_actuation: false,
    scientific_authority: false,
    steps: Array.from({ length: 6 }, (_, index) => ({
      fault_codes: index === 2 ? scheduledFaults : normalFaults,
    })),
    neural_executions: neuralSteps.map((step) => ({
      neural_result_sha256: step.result.result_sha256,
    })),
    runtime_lifecycle: lifecycle,
  })
  const workerPid = 4100 + count
  const workerSourceSha256 = digest('NEST worker source')
  const workerCommandSha256 = digest(`${count}-drone NEST worker command`)
  const adapterSourceSha256 = digest('NEST adapter source')
  const nestSession = reseal({
    reported_version: '3.9.0',
    one_session: true,
    observed_population_neuron_count: expectedTopology.population_neuron_count,
    observed_device_node_count: expectedTopology.device_node_count,
    observed_total_connection_count: expectedTopology.connection_count,
  })
  const workerIdentity = reseal({
    project_source_roster_sha256: source.worker_project_source_roster_sha256,
  })
  const workerBinding = reseal({
    worker_runtime_identity_sha256: workerIdentity.receipt_sha256,
    child_session_receipt_sha256: nestSession.receipt_sha256,
    child_lineage_verified: true,
    loaded_bytes_attested: false,
    response_bound_loaded_bytes: false,
    ncp_transport: false,
    scientific_authority: false,
  })
  const attempt = reseal({
    attempt_index: 1,
    worker_pid: workerPid,
    worker_source_sha256: workerSourceSha256,
    worker_command_sha256: workerCommandSha256,
    adapter_source_sha256: adapterSourceSha256,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    hard_deadline_enforcement: true,
    ncp_transport: false,
    physical_authority: false,
    scientific_authority: false,
  })
  const workerAttempts = [attempt]
  const workerLifecycle = reseal({
    session_binding_receipt_sha256: workerBinding.receipt_sha256,
    runtime_identity_receipt_sha256: workerIdentity.receipt_sha256,
    termination_attempts: workerAttempts,
    termination_attempt_roster_sha256: sha256(Buffer.from(canonical(workerAttempts))),
    worker_pid: workerPid,
    worker_source_sha256: workerSourceSha256,
    worker_command_sha256: workerCommandSha256,
    adapter_source_sha256: adapterSourceSha256,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    hard_deadline_enforcement: true,
    ncp_transport: false,
    physical_authority: false,
    scientific_authority: false,
  })
  const workerGuardian = {
    worker_session_binding_receipt_sha256: workerBinding.receipt_sha256,
    worker_runtime_identity_receipt_sha256: workerIdentity.receipt_sha256,
    worker_lifecycle_receipt_sha256: workerLifecycle.receipt_sha256,
    termination_attempt_count: 1,
    termination_attempt_roster_sha256: workerLifecycle.termination_attempt_roster_sha256,
    worker_pid: workerPid,
    worker_source_sha256: workerSourceSha256,
    worker_command_sha256: workerCommandSha256,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
  }
  const evidence = {
    execution_authority: false,
    ncp_control: false,
    physical_actuation: false,
    scientific_authority: false,
    run_receipt_sha256: terminal.receipt_sha256,
    nest_session_readback: nestSession,
    step_execution_receipts: neuralSteps.map((step) => ({
      receipt_sha256: step.result.provider_execution_sha256,
    })),
    worker_terminal_disposition: 'confirmed-lifecycle',
    worker_session_binding: workerBinding,
    worker_lifecycle_receipt: workerLifecycle,
    worker_termination_attempt_receipts: workerAttempts,
    worker_runtime_identity: workerIdentity,
  }
  evidence.bundle_sha256 = sha256(Buffer.from(canonical(evidence)))
  const files = [
    { relative_path: 'evidence.json', size_bytes: 16, sha256: evidence.bundle_sha256 },
    { relative_path: 'receipt.json', size_bytes: 16, sha256: terminal.receipt_sha256 },
  ]
  const store = {
    schema_version: 'crebain.closed-loop-receipt-store-closure.v1',
    store_id: `clrs_${digest(`${count}-drone receipt store`)}`,
    receipt_sha256: terminal.receipt_sha256,
    receipt_artifact_path: 'receipt.json',
    evidence_bundle_sha256: evidence.bundle_sha256,
    evidence_artifact_path: 'evidence.json',
    file_count: files.length,
    total_bytes: files.reduce((sum, row) => sum + row.size_bytes, 0),
    files,
  }
  store.closure_sha256 = sha256(Buffer.from(canonical(store)))
  return {
    schema_version: 'crebain.real-nest-closed-loop-capture.v2',
    engram_source_sha256: Object.fromEntries(
      source.sources.map((row) => [row.relative_path, row.sha256])
    ),
    engram_source_closure: source,
    package_generation_id: proof.package_generation_id,
    installed_package_proof_exact_sha256: sha256(exactBytes(proof)),
    installed_package_proof: proof,
    plan_exact_sha256: sha256(planBytes),
    nest_config_exact_sha256: sha256(configBytes),
    receipt_lock_timeout_ms: 30000,
    run_plan: plan,
    nest_config: config,
    summary: {
      run_status: 'completed',
      channel_count: count,
      receipt_sha256: terminal.receipt_sha256,
      evidence_bundle_sha256: evidence.bundle_sha256,
      store_id: store.store_id,
    },
    terminal_receipt: terminal,
    reviewed_native_runtime: {
      handshake_receipt: handshake,
      termination_receipt: termination,
      lifecycle_binding_sha256: lifecycle.binding_sha256,
      guardian_closure_verified: true,
      package_store_lineage_verified: true,
    },
    nest_worker_guardian_closure: workerGuardian,
    receipt_store_closure: store,
    population_topology: expectedTopology,
    nest_evidence_bundle: evidence,
    neural_steps: neuralSteps,
    assertions: {
      fault_then_next_step_hold: true,
      nest_hold_washout_and_reset_verified: true,
      nest_recovery_washout_and_reset_verified: true,
      resumed_nest_proposal_nonzero: true,
      other_channels_never_entered_safety_mode: true,
      terminal_receipt_and_neural_result_lineage_verified: true,
      engram_host_and_worker_source_closure_verified: true,
      reviewed_runtime_guardian_lineage_verified: true,
      engram_commit_equals_local_origin_main: true,
      private_frozen_run_inputs_used: true,
      one_nest_session_exact_6n_population_topology_verified: true,
      nest_worker_guardian_terminal_closure_verified: true,
      receipt_store_artifact_closure_verified: true,
      installed_generation_seal_package_bundle_store_lineage_verified: true,
    },
    authority: AUTHORITY,
    disclosure: 'Synthetic capture for provider-free boundary tests.',
  }
}

export function makeV2EvidenceFixture(root) {
  const inputRoot = resolve(
    root,
    'integrations/engram/managed-simulation/operational-inputs/real-nest-3.9-v1'
  )
  const suiteBytes = readFileSync(resolve(inputRoot, 'SUITE.json'))
  const suite = JSON.parse(suiteBytes)
  const configBytes = readFileSync(resolve(inputRoot, suite.nest_config.path))
  const plans = new Map(
    suite.runs.map((row) => {
      const bytes = readFileSync(resolve(inputRoot, row.plan_path))
      return [row.drone_count, { row, path: row.plan_path, bytes }]
    })
  )
  const context = {
    suite,
    suiteBytes,
    configBytes,
    toolSourceBytes: new Map(
      [...TOOL_SOURCE_ROLES].map(([path]) => [path, readFileSync(resolve(root, path))])
    ),
    plans,
  }
  const engram = {
    repository: 'https://github.com/sepahead/engram.git',
    commit: 'c'.repeat(40),
    tree: 'd'.repeat(40),
    origin_main: 'c'.repeat(40),
    object_format: 'sha1',
    clean: true,
  }
  const proof = installedProof(engram)
  const guardianSourceSha256 = digest('reviewed runtime guardian source')
  const handshake = reseal({
    guardian_source_sha256: guardianSourceSha256,
    launch_source: 'package-store-lease',
    store_id: proof.store_id,
    package_generation_id: proof.package_generation_id,
  })
  const source = sourceClosure(engram, handshake, guardianSourceSha256)
  const captures = new Map()
  const rows = []
  for (const count of [1, 2, 3]) {
    const plan = plans.get(count)
    const capture = captureFixture(count, plan.bytes, configBytes, proof, source, handshake)
    const bytes = exactBytes(capture)
    const name = `capture-${count}-drone${count > 1 ? 's' : ''}.json`
    captures.set(name, bytes)
    rows.push({
      drone_count: count,
      path: name,
      capture_sha256: sha256(bytes),
      plan_exact_sha256: sha256(plan.bytes),
      receipt_sha256: capture.terminal_receipt.receipt_sha256,
      evidence_bundle_sha256: capture.nest_evidence_bundle.bundle_sha256,
      receipt_store_id: capture.receipt_store_closure.store_id,
      receipt_store_closure_sha256: capture.receipt_store_closure.closure_sha256,
      engram_source_closure_sha256: source.closure_sha256,
      observed_build_receipt_exact_sha256: proof.observed_build_receipt_exact_sha256,
      population_count: capture.population_topology.population_count,
      population_neuron_count: capture.population_topology.population_neuron_count,
      device_node_count: capture.population_topology.device_node_count,
      connection_count: capture.population_topology.connection_count,
      session_count: 1,
    })
  }
  const packageFields = [
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
  ]
  const suiteDefinition = Object.fromEntries(
    Object.entries(suite).filter(([key]) => key !== 'suite_definition_sha256')
  )
  const toolSourceRows = [...TOOL_SOURCE_ROLES].map(([path, role]) => ({
    role,
    path,
    exact_sha256: sha256(context.toolSourceBytes.get(path)),
  }))
  const index = {
    schema_version: 'crebain.real-nest-closed-loop-evidence-index.v2',
    profile: suite.profile,
    input_suite: {
      schema_version: suite.schema_version,
      exact_sha256: sha256(suiteBytes),
      suite_definition_sha256: sha256(Buffer.from(canonical(suiteDefinition))),
      nest_config_exact_sha256: sha256(configBytes),
    },
    tool_source_closure: {
      schema_version: 'crebain.real-nest-tool-source-closure.v1',
      files: toolSourceRows,
      roster_sha256: sha256(Buffer.from(canonical(toolSourceRows))),
    },
    engram,
    package: Object.fromEntries(packageFields.map((key) => [key, proof[key]])),
    installed_package_proof_exact_sha256: sha256(exactBytes(proof)),
    captures: rows,
    assertions: {
      tracked_inputs_exact: true,
      one_session_per_run: true,
      exact_6n_population_topology: true,
      one_two_three_drone_roster: true,
      distinct_receipt_and_evidence_identities: true,
      distinct_closed_receipt_stores: true,
      common_clean_engram_source_closure: true,
      installed_package_lineage_common: true,
      engram_pack_source_lineage_common: true,
      observed_build_stage_seal_install_lineage_common: true,
      observed_build_stage_seal_pack_install_lineage_common: true,
    },
    authority: AUTHORITY,
    disclosure: 'Synthetic INDEX v2 for provider-free boundary tests.',
  }
  return { index, indexBytes: exactBytes(index), captures, context }
}
