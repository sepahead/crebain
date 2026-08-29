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
const FIXTURE_FLOAT_MEMBERS = Symbol('fixture-float-members')
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

export function compareText(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0))
  const rightPoints = [...right].map((character) => character.codePointAt(0))
  const commonLength = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < commonLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}
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
const PACKAGE_MODULES = new Set([
  'backend.core',
  'backend.integrations',
  'backend.neurocontrol',
  'backend.optimization',
  'backend.schemas',
  'scripts',
])

function modulePath(moduleName) {
  const stem = moduleName.replaceAll('.', '/')
  return PACKAGE_MODULES.has(moduleName) ? `${stem}/__init__.py` : `${stem}.py`
}

function schemaValue(schema, root = schema) {
  if (schema.$ref !== undefined) {
    if (!schema.$ref.startsWith('#/$defs/')) {
      throw new Error(`synthetic fixture cannot resolve external schema ${schema.$ref}`)
    }
    return schemaValue(root.$defs[schema.$ref.slice('#/$defs/'.length)], root)
  }
  if (Object.hasOwn(schema, 'const')) return structuredClone(schema.const)
  if (Object.hasOwn(schema, 'default')) return structuredClone(schema.default)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0])
  if (Array.isArray(schema.anyOf)) {
    const nullable = schema.anyOf.find((candidate) => candidate.type === 'null')
    return schemaValue(nullable ?? schema.anyOf[0], root)
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    const value = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, child]) => [key, schemaValue(child, root)])
    )
    annotateNumberLexemes(value, schema, root)
    return value
  }
  if (schema.type === 'array') {
    if (Array.isArray(schema.prefixItems)) {
      const value = schema.prefixItems.map((child) => schemaValue(child, root))
      annotateNumberLexemes(value, schema, root)
      return value
    }
    const value = Array.from({ length: schema.minItems ?? 0 }, () =>
      schemaValue(schema.items, root)
    )
    annotateNumberLexemes(value, schema, root)
    return value
  }
  if (schema.type === 'boolean') return false
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 0
  if (schema.type === 'null') return null
  if (schema.type === 'string') {
    if (schema.pattern?.includes('pkggen_')) return `pkggen_${'0'.repeat(64)}`
    if (schema.pattern?.includes('extstore_')) return `extstore_${'0'.repeat(64)}`
    if (schema.pattern?.includes('inst_')) return `inst_${'0'.repeat(64)}`
    if (schema.pattern?.includes('gen_')) return `gen_${'0'.repeat(64)}`
    if (schema.pattern?.includes('[0-9a-f]{64}')) return '0'.repeat(64)
    if (schema.pattern?.includes('[0-9a-f]{32}')) return '0'.repeat(32)
    return 'x'.repeat(Math.max(1, schema.minLength ?? 1))
  }
  throw new Error(`synthetic fixture lacks a value for schema node ${JSON.stringify(schema)}`)
}

function schemaNodes(schema, root) {
  if (schema.$ref !== undefined) {
    if (!schema.$ref.startsWith('#/$defs/')) {
      throw new Error(`synthetic fixture cannot resolve external schema ${schema.$ref}`)
    }
    return schemaNodes(root.$defs[schema.$ref.slice('#/$defs/'.length)], root)
  }
  const compositions = [schema.anyOf, schema.oneOf, schema.allOf].filter(Array.isArray)
  if (compositions.length === 0) return [schema]
  return compositions.flatMap((members) => members.flatMap((member) => schemaNodes(member, root)))
}

function addFloatMembers(value, members) {
  if (members.length === 0) return value
  const current = value[FIXTURE_FLOAT_MEMBERS]
  if (current !== undefined) {
    for (const member of members) current.add(`${member}`)
    return value
  }
  Object.defineProperty(value, FIXTURE_FLOAT_MEMBERS, {
    value: new Set(members.map((member) => `${member}`)),
    enumerable: true,
  })
  return value
}

function annotateNumberLexemes(value, schema, root = schema) {
  if (value === null || typeof value !== 'object') return value
  const nodes = schemaNodes(schema, root)
  if (Array.isArray(value)) {
    const numericIndexes = []
    value.forEach((child, index) => {
      const childSchemas = nodes.flatMap((node) => {
        if (Array.isArray(node.prefixItems) && node.prefixItems[index] !== undefined) {
          return [node.prefixItems[index]]
        }
        return node.items === undefined || node.items === false ? [] : [node.items]
      })
      if (
        childSchemas.some((childSchema) =>
          schemaNodes(childSchema, root).some((row) => row.type === 'number')
        )
      ) {
        numericIndexes.push(index)
      }
      for (const childSchema of childSchemas) annotateNumberLexemes(child, childSchema, root)
    })
    return addFloatMembers(value, numericIndexes)
  }
  const numericMembers = []
  for (const [member, child] of Object.entries(value)) {
    const childSchemas = nodes.flatMap((node) =>
      node.properties?.[member] === undefined ? [] : [node.properties[member]]
    )
    if (
      childSchemas.some((childSchema) =>
        schemaNodes(childSchema, root).some((row) => row.type === 'number')
      )
    ) {
      numericMembers.push(member)
    }
    for (const childSchema of childSchemas) annotateNumberLexemes(child, childSchema, root)
  }
  return addFloatMembers(value, numericMembers)
}

function exactSchemaFixture(schema, definitionName = undefined) {
  const target = definitionName === undefined ? schema : schema.$defs[definitionName]
  const value = schemaValue(target, schema)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('synthetic receipt schema root is not an object')
  }
  return annotateNumberLexemes(value, target, schema)
}

function floatVector(values) {
  return addFloatMembers(
    values,
    values.map((_, index) => index)
  )
}

function annotateRunPlanNumbers(plan) {
  for (const channel of plan.channels) {
    for (const key of ['action_min', 'action_max', 'safe_action']) {
      floatVector(channel[key])
    }
    for (const axis of channel.neural_control_axes) {
      addFloatMembers(axis, ['decoded_action_gain'])
      for (const term of axis.terms) {
        addFloatMembers(term, ['reference_value', 'gain_per_observation_unit'])
      }
    }
  }
  return plan
}

export function canonical(value, parent = undefined, key = undefined) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && parent?.[FIXTURE_FLOAT_MEMBERS]?.has(`${key}`)) {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new Error('synthetic managed-runtime float is outside the fixture domain')
      }
      const rendered = JSON.stringify(value)
      return /[.eE]/u.test(rendered) ? rendered : `${rendered}.0`
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((child, index) => canonical(child, value, index)).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort(compareText)
    .map((member) => `${JSON.stringify(member)}:${canonical(value[member], value, member)}`)
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
  const floatMembers = document[FIXTURE_FLOAT_MEMBERS]
  if (floatMembers !== undefined) {
    addFloatMembers(
      material,
      [...floatMembers].filter((member) => member !== field)
    )
  }
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
    compareText(left.relative_path, right.relative_path)
  )
  const generatorRows = GENERATOR_PATHS.map(sourceRow).sort((left, right) =>
    compareText(left.relative_path, right.relative_path)
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

function sourceClosure(engram, handshake, execGateCommandBinding, guardianSourceSha256) {
  const hostModules = REQUIRED_HOST_MODULES.map((moduleName) => ({
    module_name: moduleName,
    relative_path: modulePath(moduleName),
  }))
  const workerProjectModules = REQUIRED_WORKER_MODULES.map((moduleName) => ({
    module_name: moduleName,
    relative_path: modulePath(moduleName),
  }))
  const entrypointPaths = [
    'backend/optimization/extension_closed_loop_nest_guardian.py',
    'backend/optimization/extension_closed_loop_nest_worker.py',
    'backend/integrations/reviewed_native_process_guardian.py',
  ]
  const sourcePaths = new Set([
    ...hostModules.map((row) => row.relative_path),
    ...workerProjectModules.map((row) => row.relative_path),
    ...entrypointPaths,
  ])
  const sources = [...sourcePaths]
    .map(sourceRow)
    .map((row) =>
      row.relative_path === 'backend/integrations/reviewed_native_process_guardian.py'
        ? { ...row, sha256: guardianSourceSha256 }
        : row
    )
    .sort((left, right) => compareText(left.relative_path, right.relative_path))
  const closure = {
    schema_version: 'crebain.engram-python-source-closure.v1',
    discovery_policy: 'loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1',
    git: engram,
    source_roster_sha256: sha256(
      Buffer.concat([
        Buffer.from('crebain.engram-source-roster.v1\0'),
        Buffer.from(canonical(sources)),
      ])
    ),
    host_modules: hostModules,
    worker_project_modules: workerProjectModules,
    worker_project_source_roster_sha256: digest('unsealed worker source roster'),
    reviewed_runtime_handshake_receipt_sha256: handshake.receipt_sha256,
    reviewed_runtime_guardian_source_sha256: guardianSourceSha256,
    reviewed_runtime_exec_gate_source_sha256: execGateCommandBinding.exec_gate_source_sha256,
    reviewed_runtime_exec_gate_command_sha256: execGateCommandBinding.exec_gate_command_sha256,
    exercised_entrypoints: [
      {
        relative_path: 'backend/optimization/extension_closed_loop_nest_guardian.py',
        role: 'nest-guardian',
      },
      {
        relative_path: 'backend/optimization/extension_closed_loop_nest_worker.py',
        role: 'nest-worker',
      },
      {
        relative_path: 'backend/integrations/reviewed_native_process_guardian.py',
        role: 'reviewed-runtime-guardian',
      },
    ],
    sources,
  }
  const sourceByPath = new Map(sources.map((row) => [row.relative_path, row]))
  const workerRows = workerProjectModules.map((row) => {
    const source = sourceByPath.get(row.relative_path)
    return {
      absolute_path: `/synthetic/engram/${row.relative_path}`,
      role: `project-module:${row.module_name}`,
      sha256: source.sha256,
      size_bytes: source.size_bytes,
    }
  })
  closure.worker_project_source_roster_sha256 = sha256(Buffer.from(canonical(workerRows)))
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
  populationNames.sort(compareText)
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

function exactRuntimeCaptureFixture(
  count,
  planBytes,
  configBytes,
  proof,
  source,
  handshake,
  execGateCommandBinding,
  schemas
) {
  const plan = annotateRunPlanNumbers(JSON.parse(planBytes))
  const config = JSON.parse(configBytes)
  const evidenceSchema = schemas.evidence
  const terminalSchema = schemas.terminal
  annotateNumberLexemes(
    config,
    evidenceSchema.$defs.NestPopulationControllerConfigV2,
    evidenceSchema
  )
  const studyRunId = `crebain-standard-v3-real-nest-${count}`
  const definitionSha256 = digest(`${count}-drone closed-loop definition`)
  const runtimeBindingSha256 = digest(`${count}-drone runtime binding`)
  const runtimeGenerationId = handshake.generation_id
  const topologySummary = topology(plan, config)
  const channelIds = plan.channels.map((channel) => channel.channel_id)
  const populationBindings = new Map(
    plan.channels.map((channel) => [
      channel.channel_id,
      [0, 1, 2]
        .flatMap((axis) => [
          `${channel.neural_population_prefix}.d${String(axis).padStart(2, '0')}.negative`,
          `${channel.neural_population_prefix}.d${String(axis).padStart(2, '0')}.positive`,
        ])
        .sort(compareText),
    ])
  )
  const populationCoordinates = new Map(
    plan.channels.flatMap((channel) =>
      channel.neural_control_axes.flatMap((axis) =>
        ['negative', 'positive'].map((sign) => [
          `${channel.neural_population_prefix}.d${String(axis.action_index).padStart(2, '0')}.${sign}`,
          { channel, axis, sign },
        ])
      )
    )
  )
  const populationRoster = channelIds.map((channelId) => ({
    channel_id: channelId,
    population_names: populationBindings.get(channelId),
  }))
  const sourceByPath = new Map(source.sources.map((row) => [row.relative_path, row]))
  const runtimeFileForModule = (moduleName) => {
    const relativePath = modulePath(moduleName)
    const row = sourceByPath.get(relativePath)
    return {
      absolute_path: `/synthetic/engram/${relativePath}`,
      role: `project-module:${moduleName}`,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
    }
  }
  const projectRuntimeFiles = REQUIRED_WORKER_MODULES.map(runtimeFileForModule)
  const externalRuntimeFile = (role, path) => {
    const payload = Buffer.from(`synthetic runtime fixture: ${role}\n`)
    return {
      absolute_path: path,
      role,
      sha256: sha256(payload),
      size_bytes: payload.length,
    }
  }
  const nestPackageFile = externalRuntimeFile(
    'nest-package-init',
    '/synthetic/runtime/site-packages/nest/__init__.py'
  )
  const nestNativeFile = externalRuntimeFile(
    'nest-pynestkernel-native',
    '/synthetic/runtime/site-packages/nest/pynestkernel.so'
  )
  const pydanticCoreFile = externalRuntimeFile(
    'pydantic-core-native',
    '/synthetic/runtime/site-packages/pydantic_core/_pydantic_core.so'
  )
  const pydanticPackageFile = externalRuntimeFile(
    'pydantic-package-init',
    '/synthetic/runtime/site-packages/pydantic/__init__.py'
  )
  const pythonFile = {
    ...externalRuntimeFile('python-executable', '/synthetic/runtime/python'),
    sha256: execGateCommandBinding.python_executable_sha256,
  }
  const workerSourceRow = sourceByPath.get(
    'backend/optimization/extension_closed_loop_nest_worker.py'
  )
  const workerSourceFile = {
    absolute_path: '/synthetic/engram/backend/optimization/extension_closed_loop_nest_worker.py',
    role: 'worker-source',
    sha256: workerSourceRow.sha256,
    size_bytes: workerSourceRow.size_bytes,
  }
  const guardianSourcePath = 'backend/optimization/extension_closed_loop_nest_guardian.py'
  const guardianSourceRow = sourceByPath.get(guardianSourcePath)
  const guardianSourceText = `synthetic committed fixture: ${guardianSourcePath}\n`
  const guardianSourceFile = {
    absolute_path: `/synthetic/engram/${guardianSourcePath}`,
    role: 'guardian-source',
    sha256: guardianSourceRow.sha256,
    size_bytes: guardianSourceRow.size_bytes,
  }
  const execGateSourcePath = 'backend/integrations/contained_exec_gate.py'
  const execGateSourceRow = sourceByPath.get(execGateSourcePath)
  const execGateSourceFile = {
    absolute_path: `/synthetic/engram/${execGateSourcePath}`,
    role: 'exec-gate-source',
    sha256: execGateSourceRow.sha256,
    size_bytes: execGateSourceRow.size_bytes,
  }
  const adapterSourceFile = projectRuntimeFiles.find(
    (row) => row.role === 'project-module:backend.optimization.extension_closed_loop_nest_process'
  )
  const controllerSourceFile = projectRuntimeFiles.find(
    (row) => row.role === 'project-module:backend.optimization.extension_closed_loop_nest'
  )
  const identityFiles = [
    ...projectRuntimeFiles,
    nestPackageFile,
    nestNativeFile,
    pydanticCoreFile,
    pydanticPackageFile,
    pythonFile,
    workerSourceFile,
  ]
  const requiredRuntimeFiles = [
    ...projectRuntimeFiles,
    pydanticCoreFile,
    pydanticPackageFile,
    pythonFile,
    workerSourceFile,
  ]
  const environment = [
    ['LANG', 'C'],
    ['LC_ALL', 'C'],
    ['PATH', '/usr/bin:/bin'],
    ['TZ', 'UTC'],
  ]
  const sysPath = [
    '/synthetic/engram',
    '/synthetic/runtime/stdlib',
    '/synthetic/runtime/lib-dynload',
    '/synthetic/runtime/site-packages',
  ]
  const workerCommand = [
    pythonFile.absolute_path,
    '-I',
    '-S',
    '-B',
    workerSourceFile.absolute_path,
    '--resource-limit-profile',
    'portable-posix-rlimit-v1',
    '--address-space-bytes',
    '1073741824',
    '--cpu-time-seconds',
    '300',
    '--file-size-bytes',
    '67108864',
    '--open-file-count',
    '256',
  ]
  const guardianCommand = [pythonFile.absolute_path, '-I', '-S', '-B', '-c', guardianSourceText]
  const workerDispatchCommand = [...workerCommand]
  const workerCommandSha256 = sha256(
    Buffer.from(
      canonical({
        guardian_command: guardianCommand,
        worker_command: workerCommand,
        worker_dispatch_command: workerDispatchCommand,
        exec_gate_source_sha256: execGateSourceFile.sha256,
        session_escape_prevention_profile: 'linux-trusted-worker-source-v1',
        darwin_sandbox_profile_sha256: null,
        darwin_sandbox_launcher_sha256: null,
      })
    )
  )
  const providerIdentitySha256 = digest(`${count}-drone parent NEST provider`)
  const childProviderIdentitySha256 = sha256(
    Buffer.from(
      canonical({
        schema_version: 'engram.nest-population-controller-identity.v1',
        provider: 'NEST',
        semantic_policy: 'engram.nest-population-controller-policy.v4',
        test_failure_phase: 'none',
        controller_source_sha256: controllerSourceFile.sha256,
        reported_version: '3.9.0',
        config,
        nest_tic_ms: '0.001',
        local_num_threads: 1,
        model_roster: ['iaf_psc_delta', 'inhomogeneous_poisson_generator', 'spike_recorder'],
        resource_limits: {
          max_total_nodes: 65536,
          max_total_connections: 100000,
          max_neuron_tic_work_units: 10000000000,
          max_input_event_work_units: 100000000,
        },
        loaded_bytes_attested: false,
        ncp_transport: false,
      })
    )
  )
  const expectation = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerLaunchExpectationV4'),
    guardian_command: guardianCommand,
    worker_command: workerCommand,
    worker_dispatch_command: workerDispatchCommand,
    worker_command_sha256: workerCommandSha256,
    environment,
    sys_path: sysPath,
    python_executable_sha256: pythonFile.sha256,
    worker_source_sha256: workerSourceFile.sha256,
    exec_gate_source_file: execGateSourceFile,
    exec_gate_source_sha256: execGateSourceFile.sha256,
    guardian_source_file: guardianSourceFile,
    guardian_source_sha256: guardianSourceFile.sha256,
    adapter_source_sha256: adapterSourceFile.sha256,
    controller_configuration: config,
    child_provider_test_failure_phase: 'none',
    expected_child_provider_identity_sha256: childProviderIdentitySha256,
    required_runtime_files: requiredRuntimeFiles,
    required_runtime_file_roster_sha256: sha256(Buffer.from(canonical(requiredRuntimeFiles))),
    required_project_source_roster_sha256: sha256(Buffer.from(canonical(projectRuntimeFiles))),
    platform: 'linux',
    session_escape_prevention_profile: 'linux-trusted-worker-source-v1',
    descendant_creation_denied: false,
    runtime_process_group_leader: true,
    guardian_group_member: true,
    darwin_sandbox_profile_sha256: null,
    darwin_sandbox_launcher_sha256: null,
    address_space_bytes: 1073741824,
    address_space_limit_enforced: true,
    cpu_time_seconds: 300,
    file_size_bytes: 67108864,
    open_file_count: 256,
    core_file_bytes: 0,
    network_namespace_isolation: false,
    syscall_filter: false,
    production_isolation: false,
    external_dependency_closure_attested: false,
    loaded_bytes_attested: false,
  })
  const workerPid = 4100 + count * 10
  const guardianPid = workerPid + 1
  const workerSessionId = 5100 + count
  const launch = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerLaunchAttemptReceiptV1'),
    launch_expectation_sha256: expectation.receipt_sha256,
    phase: 'worker-ready',
    outcome: 'succeeded',
    reason_code: 'neural.nest-worker-launch-succeeded',
    guardian_started: true,
    guardian_ready_observed: true,
    worker_started: true,
    stderr_drain_started: true,
    guardian_pid: guardianPid,
    worker_pid: workerPid,
    process_group_id: workerPid,
    session_id: workerSessionId,
    group_signal_attempted: false,
    anchored_group_kill_delivered: false,
    group_signal_basis: 'none',
    containment_seal_signal: null,
    guardian_reaped: false,
    worker_reaped: false,
    containment_empty: false,
    bounded_cleanup_observation_complete: false,
    production_isolation: false,
    scientific_authority: false,
  })
  const resourceLimits = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerResourceLimitReceiptV1'),
    platform: 'linux',
    address_space_bytes: 1073741824,
    address_space_limit_enforced: true,
    cpu_time_seconds: 300,
    file_size_bytes: 67108864,
    open_file_count: 256,
    core_file_bytes: 0,
    applied_before_nest_import: true,
    network_namespace_isolation: false,
    syscall_filter: false,
    production_isolation: false,
  })
  const identity = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerRuntimeIdentityReceiptV2'),
    python_version: '3.11.15 synthetic fixture',
    sys_path: sysPath,
    environment,
    reported_nest_version: '3.9.0',
    reported_pydantic_version: '2.13.4',
    files: identityFiles,
    file_roster_sha256: sha256(Buffer.from(canonical(identityFiles))),
    project_source_roster_sha256: sha256(Buffer.from(canonical(projectRuntimeFiles))),
    project_source_closure_verified: true,
    external_dependency_closure_attested: false,
    resource_limits: resourceLimits,
    response_bound_loaded_bytes: false,
    loaded_bytes_attested: false,
  })
  const capabilities = {
    ...exactSchemaFixture(evidenceSchema, 'NeuralAdapterCapabilitiesV1'),
    provider: 'engram.nest-population-controller',
    provider_identity_sha256: childProviderIdentitySha256,
    deadline_enforcement: 'cooperative-observed',
    session_model: 'one-session-named-populations',
    max_channels: 64,
    declared_step_duration_tics: Math.round(config.step_duration_ms * 1000),
    automatic_restart: false,
    physical_actuation: false,
    ncp_transport: false,
    loaded_bytes_attested: false,
    durable_evidence_profile: 'none',
  }
  const stepDurationTics = Math.round(config.step_duration_ms * 1000)
  const resolutionTics = Math.round(config.resolution_ms * 1000)
  const connectionDelayTics = resolutionTics
  const controlBindings = plan.channels.map((channel) => ({
    ...exactSchemaFixture(evidenceSchema, 'NestControlBindingV1'),
    channel_id: channel.channel_id,
    neural_codec_sha256: sha256(
      Buffer.from(
        canonical({
          domain: 'engram-neural-control-codec-v1',
          observation_space_id: channel.observation_space_id,
          action_space_id: channel.action_space_id,
          observation_components: channel.observation_components,
          action_components: channel.action_components,
          axes: channel.neural_control_axes,
        })
      )
    ),
    axis_binding_sha256s: channel.neural_control_axes.map((axis) =>
      sha256(Buffer.from(canonical(axis)))
    ),
  }))
  const actionDimensionCount = count * 3
  const populationNeuronCount = actionDimensionCount * 2 * config.population_size
  const deviceNodeCount = actionDimensionCount * 4
  const totalNodeCount = populationNeuronCount + deviceNodeCount
  const totalConnectionCount = populationNeuronCount * 2
  const totalRunTics = stepDurationTics * 6
  const maximumInputRateHz = config.baseline_rate_hz + config.input_span_hz
  const neuronTicWorkUnits = populationNeuronCount * totalRunTics
  const inputEventWorkUnits = Math.ceil(
    (maximumInputRateHz * totalRunTics * populationNeuronCount) / 1000000
  )
  const estimatedStepResponseBytes = 32768 + count * 4096 + actionDimensionCount * 8192
  const estimatedEvidenceBundleBytes =
    16777216 + count * 4096 + actionDimensionCount * 8192 + estimatedStepResponseBytes * 6
  const estimatedStepResponseNodes = 128 + count * 42 + actionDimensionCount * 160
  const estimatedEvidenceBundleNodes =
    32768 +
    count * 64 +
    actionDimensionCount * 192 +
    6 * (128 + count * 40 + actionDimensionCount * 160)
  const workAdmission = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkAdmissionV1'),
    channel_count: count,
    planned_step_count: 6,
    action_dimension_count: actionDimensionCount,
    closed_loop_definition_sha256: definitionSha256,
    controller_configuration_sha256: sha256(Buffer.from(canonical(config))),
    expected_control_binding_sha256: sha256(Buffer.from(canonical(controlBindings))),
    expected_population_roster_sha256: sha256(Buffer.from(canonical(populationRoster))),
    population_size: config.population_size,
    step_duration_tics: stepDurationTics,
    maximum_input_rate_hz: maximumInputRateHz,
    signed_population_count: actionDimensionCount * 2,
    population_neuron_count: populationNeuronCount,
    device_node_count: deviceNodeCount,
    total_node_count: totalNodeCount,
    total_connection_count: totalConnectionCount,
    total_run_tics: totalRunTics,
    neuron_tic_work_units: neuronTicWorkUnits,
    input_event_work_units: inputEventWorkUnits,
    estimated_step_response_bytes: estimatedStepResponseBytes,
    estimated_evidence_bundle_bytes: estimatedEvidenceBundleBytes,
    estimated_step_response_nodes: estimatedStepResponseNodes,
    estimated_evidence_bundle_nodes: estimatedEvidenceBundleNodes,
    admitted: true,
  })
  const connectionRows = topologySummary.population_names.flatMap((populationName) =>
    ['input', 'recorder'].map((direction) => ({
      ...exactSchemaFixture(evidenceSchema, 'NestConnectionGroupReadbackV1'),
      population_name: populationName,
      direction,
      requested_weight: direction === 'input' ? config.input_weight_mv : 1,
      effective_weight: direction === 'input' ? config.input_weight_mv : 1,
      requested_delay_tics: connectionDelayTics,
      delay_api_argument_ms: config.resolution_ms,
      effective_delay_ms: config.resolution_ms,
      effective_delay_tics: connectionDelayTics,
      requested_receptor: 0,
      effective_receptor: 0,
      synapse_model: 'static_synapse',
      connection_count: config.population_size,
    }))
  )
  const modelReadback = {
    effective_model_roster: ['iaf_psc_delta', 'inhomogeneous_poisson_generator', 'spike_recorder'],
    population_neuron_count: topologySummary.population_neuron_count,
    device_node_count: topologySummary.device_node_count,
  }
  const session = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestSessionReadbackV2'),
    reported_version: '3.9.0',
    one_session: true,
    kernel_reset_at_admission: true,
    requested_resolution_ms: config.resolution_ms,
    requested_resolution_tics: resolutionTics,
    resolution_api_argument_ms: config.resolution_ms,
    effective_resolution_ms: config.resolution_ms,
    effective_resolution_tics: resolutionTics,
    requested_step_duration_ms: config.step_duration_ms,
    requested_step_duration_tics: stepDurationTics,
    run_api_argument_ms: config.step_duration_ms,
    requested_connection_delay_tics: connectionDelayTics,
    connection_delay_api_argument_ms: config.resolution_ms,
    requested_rng_seed: config.rng_seed,
    effective_rng_seed: config.rng_seed,
    requested_local_num_threads: 1,
    effective_local_num_threads: 1,
    effective_total_num_virtual_processes: 1,
    requested_input_weight: config.input_weight_mv,
    requested_recorder_weight: 1,
    requested_receptor: 0,
    effective_model_roster: ['iaf_psc_delta', 'inhomogeneous_poisson_generator', 'spike_recorder'],
    control_neuron_model: 'iaf_psc_delta',
    control_neuron_refractory_period_tics: 2000,
    control_neuron_refractory_input: false,
    model_readback_sha256: sha256(Buffer.from(canonical(modelReadback))),
    control_bindings: controlBindings,
    control_binding_sha256: sha256(Buffer.from(canonical(controlBindings))),
    connection_readbacks: connectionRows,
    connection_readback_sha256: sha256(Buffer.from(canonical(connectionRows))),
    observed_population_neuron_count: topologySummary.population_neuron_count,
    observed_device_node_count: topologySummary.device_node_count,
    observed_total_connection_count: topologySummary.connection_count,
    population_roster: populationRoster,
    population_roster_sha256: sha256(Buffer.from(canonical(populationRoster))),
    work_admission: workAdmission,
    loaded_bytes_attested: false,
    ncp_transport: false,
  })
  const childPrepared = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NeuralPreparedV1'),
    study_run_id: studyRunId,
    definition_sha256: definitionSha256,
    provider_identity_sha256: childProviderIdentitySha256,
    provider_session_receipt_sha256: session.receipt_sha256,
    single_session: true,
    populations: populationRoster,
    step_duration_tics: stepDurationTics,
  })
  const binding = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerSessionBindingReceiptV1'),
    study_run_id: studyRunId,
    parent_provider_identity_sha256: providerIdentitySha256,
    runtime_launch_expectation_sha256: expectation.receipt_sha256,
    worker_launch_attempt_sha256: launch.receipt_sha256,
    worker_source_sha256: workerSourceFile.sha256,
    guardian_source_sha256: guardianSourceFile.sha256,
    adapter_source_sha256: adapterSourceFile.sha256,
    worker_command_sha256: workerCommandSha256,
    worker_runtime_identity_sha256: identity.receipt_sha256,
    worker_project_source_roster_sha256: identity.project_source_roster_sha256,
    child_provider_identity_sha256: childProviderIdentitySha256,
    child_capabilities_sha256: sha256(Buffer.from(canonical(capabilities))),
    child_prepared_receipt_sha256: childPrepared.receipt_sha256,
    child_session_receipt_sha256: session.receipt_sha256,
    child_lineage_verified: true,
    response_bound_loaded_bytes: false,
    loaded_bytes_attested: false,
    ncp_transport: false,
    scientific_authority: false,
  })
  const providerPrepared = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NeuralPreparedV1'),
    study_run_id: studyRunId,
    definition_sha256: definitionSha256,
    provider_identity_sha256: providerIdentitySha256,
    provider_session_receipt_sha256: binding.receipt_sha256,
    single_session: true,
    populations: populationRoster,
    step_duration_tics: stepDurationTics,
  })
  const preparation = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerPreparationAttemptReceiptV1'),
    study_run_id: studyRunId,
    definition_sha256: definitionSha256,
    runtime_launch_expectation_sha256: expectation.receipt_sha256,
    worker_launch_attempt_sha256: launch.receipt_sha256,
    phase: 'provider-prepare',
    worker_request_dispatched: true,
    worker_response_observed: true,
    outcome: 'succeeded',
    reason_code: 'neural.prepare-succeeded',
    runtime_identity_receipt_sha256: identity.receipt_sha256,
    provider_preparation_receipt_sha256: providerPrepared.receipt_sha256,
    session_binding_receipt_sha256: binding.receipt_sha256,
    scientific_authority: false,
  })
  const normalFaults = Array.from({ length: count }, () => 'none')
  const scheduledFaults = [...normalFaults]
  scheduledFaults[0] = 'sensor-unavailable'
  const initialSnapshotSha256 = digest(`${count}-drone initial snapshot`)
  const outputSnapshotSha256s = Array.from({ length: 6 }, (_, index) =>
    digest(`${count}-drone output snapshot ${index + 1}`)
  )
  const neuralSteps = Array.from({ length: 6 }, (_, index) => {
    const stepId = `step_${sha256(
      Buffer.from(
        canonical({
          domain: 'engram-extension-closed-loop-step-v2',
          run_id: studyRunId,
          step_index: index + 1,
        })
      )
    ).slice(0, 32)}`
    const controllerStartTics = index * stepDurationTics
    const controllerEndTics = (index + 1) * stepDurationTics
    const request = reseal(
      {
        schema_version: 'engram.closed-loop-neural-step-request.v1',
        study_run_id: studyRunId,
        step_index: index + 1,
        step_id: stepId,
        neural_preparation_sha256: providerPrepared.receipt_sha256,
        source_snapshot_sha256:
          index === 0 ? initialSnapshotSha256 : outputSnapshotSha256s[index - 1],
        observation_runtime_time_tics: controllerStartTics,
        runtime_interval_end_time_tics: controllerEndTics,
        runtime_interval_tics: stepDurationTics,
        controller_start_time_tics: controllerStartTics,
        controller_end_time_tics: controllerEndTics,
        controller_interval_tics: stepDurationTics,
        channels: plan.channels.map((channel, channelIndex) => ({
          channel_id: channel.channel_id,
          subject_id: channel.subject_id,
          observation_values: floatVector(
            index === 3 && channelIndex === 0
              ? Array.from({ length: channel.observation_width }, () => 0)
              : Array.from(
                  { length: channel.observation_width },
                  (_, valueIndex) => 0.25 + valueIndex / 100
                )
          ),
          hold_required: index === 3 && channelIndex === 0,
          fault_code: index === 3 && channelIndex === 0 ? 'sensor-unavailable' : 'none',
        })),
      },
      'request_sha256'
    )
    return {
      request,
      result: {
        schema_version: 'engram.closed-loop-neural-step-result.v1',
        study_run_id: studyRunId,
        step_index: index + 1,
        step_id: stepId,
        request_sha256: request.request_sha256,
        provider_execution_scope: 'nest-exact-step-readback',
        provider_execution_sha256: '0'.repeat(64),
        controller_start_time_tics: controllerStartTics,
        controller_end_time_tics: controllerEndTics,
        proposals: plan.channels.map((channel, channelIndex) => ({
          channel_id: channel.channel_id,
          source_populations: populationBindings.get(channel.channel_id),
          values: floatVector(
            channelIndex === 0 && (index === 3 || index === 4) ? [0, 0, 0] : [0.25, 0.5, 0.75]
          ),
        })),
        result_sha256: '0'.repeat(64),
      },
    }
  })
  const stepExecutions = neuralSteps.map((neuralStep, index) => {
    const before = index * stepDurationTics
    const after = (index + 1) * stepDurationTics
    const previousCompletedWatermark = Math.max(0, before - connectionDelayTics)
    const currentCompletedWatermark = Math.max(0, after - connectionDelayTics)
    const priorRequest = index === 0 ? undefined : neuralSteps[index - 1].request
    const channelStates = new Map(
      plan.channels.map((channel, channelIndex) => {
        const requestChannel = neuralStep.request.channels[channelIndex]
        const priorHold = priorRequest?.channels[channelIndex].hold_required ?? false
        const recoveryFromHold = priorHold && !requestChannel.hold_required
        const safetyState = requestChannel.hold_required || recoveryFromHold
        const disposition = requestChannel.hold_required
          ? 'held-neutralized'
          : recoveryFromHold
            ? 'recovery-washout'
            : 'encoded-observation'
        const axes = channel.neural_control_axes.map((axis) => {
          const rawAffineSum = safetyState
            ? 0
            : axis.terms.reduce(
                (sum, term) =>
                  sum +
                  (requestChannel.observation_values[term.observation_index] -
                    term.reference_value) *
                    term.gain_per_observation_unit,
                0
              )
          return {
            axis,
            rawAffineSum,
            normalizedInput: Math.max(-1, Math.min(1, rawAffineSum)),
          }
        })
        return [
          channel.channel_id,
          {
            channel,
            requestChannel,
            recoveryFromHold,
            safetyState,
            disposition,
            axes,
          },
        ]
      })
    )
    const generatorRows = topologySummary.population_names.map((populationName) => ({
      ...exactSchemaFixture(evidenceSchema, 'NestGeneratorScheduleReadbackV1'),
      population_name: populationName,
      generator_model: 'inhomogeneous_poisson_generator',
      requested_schedule_time_tics: before + resolutionTics,
      schedule_api_argument_ms: (before + resolutionTics) / 1000,
      effective_schedule_time_ms: (before + resolutionTics) * 0.001,
      effective_schedule_time_tics: before + resolutionTics,
      requested_rate_hz: maximumInputRateHz,
      effective_rate_hz: maximumInputRateHz,
    }))
    const populationEventCounts = new Map(
      topologySummary.population_names.map((populationName) => {
        const coordinate = populationCoordinates.get(populationName)
        const state = channelStates.get(coordinate.channel.channel_id)
        const normalized = state.axes[coordinate.axis.action_index].normalizedInput
        const activeSign = normalized < 0 ? 'negative' : 'positive'
        return [populationName, state.safetyState || coordinate.sign !== activeSign ? 0 : 1]
      })
    )
    const inputRows = topologySummary.population_names.map((populationName) => {
      const coordinate = populationCoordinates.get(populationName)
      const state = channelStates.get(coordinate.channel.channel_id)
      const normalized = state.axes[coordinate.axis.action_index].normalizedInput
      const signedValue =
        coordinate.sign === 'negative' ? Math.max(-normalized, 0) : Math.max(normalized, 0)
      const desiredEquivalentRateHz = state.safetyState
        ? 0
        : config.baseline_rate_hz + config.input_span_hz * signedValue
      const requestedWeightMv =
        (config.input_weight_mv * desiredEquivalentRateHz) / maximumInputRateHz
      return {
        ...exactSchemaFixture(evidenceSchema, 'NestInputWeightReadbackV1'),
        population_name: populationName,
        input_disposition: state.disposition,
        desired_equivalent_rate_hz: desiredEquivalentRateHz,
        configured_full_scale_weight_mv: config.input_weight_mv,
        requested_weight_mv: requestedWeightMv,
        effective_weight_mv: requestedWeightMv,
        constant_generator_rate_hz: maximumInputRateHz,
        connection_count: config.population_size,
      }
    })
    const completedRows = topologySummary.population_names.map((populationName) => {
      const coordinate = populationCoordinates.get(populationName)
      const state = channelStates.get(coordinate.channel.channel_id)
      const decodeWindowStart = state.safetyState ? before : previousCompletedWatermark
      const eventCount = populationEventCounts.get(populationName)
      const eventTics = eventCount === 0 ? [] : [decodeWindowStart + 1]
      return {
        ...exactSchemaFixture(evidenceSchema, 'NestPopulationCompletedWindowV1'),
        population_name: populationName,
        previous_completed_watermark_tics: previousCompletedWatermark,
        decode_window_start_tics: decodeWindowStart,
        current_completed_watermark_tics: currentCompletedWatermark,
        completed_window_tics: currentCompletedWatermark - decodeWindowStart,
        recorder_delivery_delay_tics: connectionDelayTics,
        newly_delivered_event_count: eventCount,
        completed_event_count: eventCount,
        pending_event_count: 0,
        quarantined_event_count: 0,
        completed_event_times_sha256: sha256(Buffer.from(canonical(eventTics))),
        pending_event_times_sha256: sha256(Buffer.from(canonical([]))),
        quarantined_event_times_sha256: sha256(Buffer.from(canonical([]))),
      }
    })
    const eventRows = topologySummary.population_names.map((populationName) => ({
      ...exactSchemaFixture(evidenceSchema, 'NestPopulationEventDeltaV1'),
      population_name: populationName,
      prior_event_count: 0,
      current_event_count: populationEventCounts.get(populationName),
      event_count_delta: populationEventCounts.get(populationName),
    }))
    const safetyRows = channelIds.map((channelId) => {
      const state = channelStates.get(channelId)
      const emptyDigest = sha256(Buffer.from(canonical([])))
      const preReset = state.safetyState ? digest(`${channelId} pre-reset ${index}`) : emptyDigest
      const postReset = state.safetyState ? digest(`${channelId} post-reset ${index}`) : emptyDigest
      const preQuarantine = state.safetyState
        ? digest(`${channelId} pre-quarantine ${index}`)
        : emptyDigest
      const postQuarantine = state.safetyState
        ? digest(`${channelId} post-quarantine ${index}`)
        : emptyDigest
      return {
        ...exactSchemaFixture(evidenceSchema, 'NestChannelSafetyReadbackV2'),
        channel_id: channelId,
        input_disposition: state.disposition,
        hold_required: state.requestChannel.hold_required,
        recovery_from_hold: state.recoveryFromHold,
        population_state_reset_performed: state.safetyState,
        population_state_reset_verified: state.safetyState,
        safety_washout_performed: state.safetyState,
        safety_interval_tics: state.safetyState ? stepDurationTics : 0,
        resolution_tics: resolutionTics,
        post_delivery_quiescence_tics: state.safetyState
          ? stepDurationTics - 2 * resolutionTics
          : 0,
        recorder_delivery_flush_slack_tics: state.safetyState
          ? stepDurationTics - 3 * resolutionTics
          : 0,
        minimum_refractory_flush_tics: 2000,
        discarded_pending_event_count: 0,
        pre_interval_reset_readback_sha256: preReset,
        post_interval_reset_readback_sha256: postReset,
        reset_readback_sha256: sha256(
          Buffer.from(canonical({ before: preReset, after: postReset }))
        ),
        recorder_quarantine_sha256: sha256(
          Buffer.from(canonical({ before: preQuarantine, after: postQuarantine }))
        ),
      }
    })
    const encodedRows = plan.channels.flatMap((channel, channelIndex) =>
      channel.neural_control_axes.map((axis) => {
        const state = channelStates.get(channel.channel_id)
        const encoded = state.axes[axis.action_index]
        return {
          ...exactSchemaFixture(evidenceSchema, 'NestEncodedControlInputV1'),
          channel_id: channel.channel_id,
          action_index: axis.action_index,
          raw_affine_sum: encoded.rawAffineSum,
          normalized_input: encoded.normalizedInput,
          clamped: encoded.rawAffineSum < -1 || encoded.rawAffineSum > 1,
          input_disposition: state.disposition,
          axis_binding_sha256:
            controlBindings[channelIndex].axis_binding_sha256s[axis.action_index],
          neural_codec_sha256: controlBindings[channelIndex].neural_codec_sha256,
        }
      })
    )
    const completedByName = new Map(completedRows.map((row) => [row.population_name, row]))
    for (const [channelIndex, proposal] of neuralStep.result.proposals.entries()) {
      const state = channelStates.get(proposal.channel_id)
      proposal.values = floatVector(
        state.channel.neural_control_axes.map((axis) => {
          if (state.safetyState) return 0
          const prefix = `${state.channel.neural_population_prefix}.d${String(axis.action_index).padStart(2, '0')}`
          const negative = completedByName.get(`${prefix}.negative`)
          const positive = completedByName.get(`${prefix}.positive`)
          const negativeRate =
            negative.completed_event_count /
            (config.population_size * (negative.completed_window_tics / 1000000))
          const positiveRate =
            positive.completed_event_count /
            (config.population_size * (positive.completed_window_tics / 1000000))
          const normalizedOutput = Math.tanh(
            (positiveRate - negativeRate) / config.output_rate_scale_hz
          )
          const limit =
            normalizedOutput >= 0
              ? state.channel.action_max[axis.action_index]
              : Math.abs(state.channel.action_min[axis.action_index])
          return normalizedOutput * limit * axis.decoded_action_gain
        })
      )
    }
    const execution = reseal({
      ...exactSchemaFixture(evidenceSchema, 'NestStepExecutionReceiptV3'),
      step_index: index + 1,
      before_biological_time_tics: before,
      requested_run_tics: stepDurationTics,
      run_api_argument_ms: config.step_duration_ms,
      after_biological_time_tics: after,
      generator_schedule_readbacks: generatorRows,
      generator_schedule_readback_sha256: sha256(Buffer.from(canonical(generatorRows))),
      input_weight_readbacks: inputRows,
      input_weight_readback_sha256: sha256(Buffer.from(canonical(inputRows))),
      completed_window_readbacks: completedRows,
      completed_window_readback_sha256: sha256(Buffer.from(canonical(completedRows))),
      population_event_deltas: eventRows,
      channel_safety_readbacks: safetyRows,
      channel_safety_readback_sha256: sha256(Buffer.from(canonical(safetyRows))),
      encoded_control_inputs: encodedRows,
      control_encoding_sha256: sha256(Buffer.from(canonical(encodedRows))),
      decoded_proposal_only: true,
      scientific_authority: false,
    })
    neuralStep.result.provider_execution_sha256 = execution.receipt_sha256
    reseal(neuralStep.result, 'result_sha256')
    return execution
  })
  const stepAttempts = stepExecutions.map((execution, index) =>
    reseal({
      ...exactSchemaFixture(evidenceSchema, 'NestStepAttemptReceiptV1'),
      attempt_index: index + 1,
      step_index: index + 1,
      request_sha256: neuralSteps[index].request.request_sha256,
      before_biological_time_tics: index * stepDurationTics,
      requested_run_tics: stepDurationTics,
      simulation_dispatched: true,
      simulation_returned: true,
      observed_after_biological_time_tics: (index + 1) * stepDurationTics,
      decoded_proposal_produced: true,
      execution_receipt_sha256: execution.receipt_sha256,
      outcome: 'succeeded',
      reason_code: 'neural.step-succeeded',
      partial_readback_sha256: sha256(
        Buffer.from(
          canonical({
            before_biological_time_tics: index * stepDurationTics,
            observed_after_biological_time_tics: (index + 1) * stepDurationTics,
            simulation_dispatched: true,
            simulation_returned: true,
          })
        )
      ),
      observation_scope: 'child-reported',
      scientific_authority: false,
    })
  )
  const populationTails = topologySummary.population_names.map((populationName) => ({
    ...exactSchemaFixture(evidenceSchema, 'NestPopulationTailV1'),
    population_name: populationName,
    pending_event_count: 0,
    pending_event_times_sha256: sha256(Buffer.from(canonical([]))),
  }))
  const tail = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestTailDispositionReceiptV1'),
    study_run_id: studyRunId,
    final_biological_time_tics: totalRunTics,
    final_completed_watermark_tics: totalRunTics - connectionDelayTics,
    recorder_delivery_delay_tics: connectionDelayTics,
    accounting_disposition: 'discarded-incomplete-recorder-delivery-tail',
    population_tails: populationTails,
    total_pending_event_count: 0,
    population_tail_roster_sha256: sha256(Buffer.from(canonical(populationTails))),
    proposals_used_completed_windows_only: true,
    decoded_proposal_only: true,
    scientific_authority: false,
  })
  const terminationAttempt = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerTerminationAttemptReceiptV1'),
    attempt_index: 1,
    runtime_launch_expectation_sha256: expectation.receipt_sha256,
    worker_launch_attempt_sha256: launch.receipt_sha256,
    worker_source_sha256: workerSourceFile.sha256,
    guardian_source_sha256: guardianSourceFile.sha256,
    adapter_source_sha256: adapterSourceFile.sha256,
    worker_command_sha256: workerCommandSha256,
    worker_pid: workerPid,
    guardian_pid: guardianPid,
    process_group_id: workerPid,
    session_id: workerSessionId,
    disposition: 'clean-exit',
    reason_code: 'neural.nest-worker-clean-exit',
    exit_code: 0,
    termination_signal: null,
    group_signal_attempted: true,
    anchored_group_kill_delivered: true,
    group_signal_while_guardian_unreaped: true,
    group_signal_basis: 'guardian-group-anchor-unreaped',
    guardian_unexpected_exit_observed: false,
    containment_seal_signal: 9,
    child_reaped: true,
    guardian_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    stderr_sha256: sha256(Buffer.alloc(0)),
    stderr_retained_bytes: 0,
    stderr_truncated: false,
    request_count: 9,
    response_count: 9,
    hard_deadline_enforcement: true,
    ncp_transport: false,
    physical_authority: false,
    scientific_authority: false,
  })
  const terminationAttempts = [terminationAttempt]
  const workerLifecycle = reseal({
    ...exactSchemaFixture(evidenceSchema, 'NestWorkerLifecycleReceiptV2'),
    runtime_launch_expectation_sha256: expectation.receipt_sha256,
    worker_launch_attempt_sha256: launch.receipt_sha256,
    worker_source_sha256: workerSourceFile.sha256,
    guardian_source_sha256: guardianSourceFile.sha256,
    adapter_source_sha256: adapterSourceFile.sha256,
    worker_command_sha256: workerCommandSha256,
    worker_pid: workerPid,
    guardian_pid: guardianPid,
    process_group_id: workerPid,
    session_id: workerSessionId,
    disposition: 'clean-exit',
    reason_code: 'neural.nest-worker-clean-exit',
    exit_code: 0,
    termination_signal: null,
    guardian_unexpected_exit_observed: false,
    child_reaped: true,
    guardian_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    stderr_sha256: sha256(Buffer.alloc(0)),
    stderr_retained_bytes: 0,
    stderr_truncated: false,
    request_count: 9,
    response_count: 9,
    termination_attempts: terminationAttempts,
    termination_attempt_roster_sha256: sha256(Buffer.from(canonical(terminationAttempts))),
    runtime_identity_receipt_sha256: identity.receipt_sha256,
    resource_limit_receipt_sha256: resourceLimits.receipt_sha256,
    session_binding_receipt_sha256: binding.receipt_sha256,
    hard_deadline_enforcement: true,
    ncp_transport: false,
    physical_authority: false,
    scientific_authority: false,
  })
  const reviewedTermination = reseal({
    ...exactSchemaFixture(schemas.termination),
    handshake_receipt_sha256: handshake.receipt_sha256,
    generation_id: runtimeGenerationId,
    guardian_pid: handshake.guardian_pid,
    process_group_id: handshake.process_group_id,
    disposition: 'clean-exit',
    reason_code: 'runtime.clean-exit',
    exit_code: 0,
    termination_signal: null,
    containment_signal_scope: 'process-group',
    containment_seal_signal: 9,
    group_signal_while_guardian_unreaped: true,
    direct_child_signal_while_unreaped: false,
    guardian_reaped: true,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
    stderr_sha256: sha256(Buffer.alloc(0)),
    stderr_retained_bytes: 0,
    stderr_truncated: false,
    guardian_generation_lease_held_until_containment: true,
    package_generation_lease_released: true,
    private_work_directory_removed: true,
    durable_process_launch_authority: false,
    ncp_authority: false,
    physical_authority: false,
    scientific_authority: false,
  })
  const runtimeLifecycle = reseal(
    {
      ...exactSchemaFixture(schemas.lifecycle),
      profile: 'engram.reviewed-native-development.v1',
      handshake_receipt_sha256: handshake.receipt_sha256,
      termination_receipt_sha256: reviewedTermination.receipt_sha256,
      launch_source: 'package-store-lease',
      store_id: proof.store_id,
      package_generation_id: proof.package_generation_id,
      generation_id: runtimeGenerationId,
      generation_directory_identity_sha256: handshake.generation_directory_identity_sha256,
      package_generation_lease_retained_at_launch: true,
      package_generation_lease_released: true,
      child_reaped: true,
      containment_empty: true,
      diagnostic_stream_complete: true,
      private_work_directory_removed: true,
      termination_disposition: 'clean-exit',
      publisher_authenticated: false,
      durable_process_launch_authority: false,
      ncp_authority: false,
      physical_authority: false,
      scientific_authority: false,
    },
    'binding_sha256'
  )
  const runtimeCleanup = reseal({
    ...exactSchemaFixture(terminalSchema, 'ComponentCleanupReceiptV2'),
    component: 'runtime',
    mode: 'finish',
    attempted: true,
    confirmed: true,
    containment_empty: true,
    reason_code: 'loop.completed',
    owner_identity_sha256: runtimeBindingSha256,
    provider_lifecycle_receipt_sha256: null,
    provider_terminal_receipt_sha256: null,
    runtime_lifecycle: runtimeLifecycle,
  })
  const neuralCleanup = reseal({
    ...exactSchemaFixture(terminalSchema, 'ComponentCleanupReceiptV2'),
    component: 'neural',
    mode: 'close',
    attempted: true,
    confirmed: true,
    containment_empty: true,
    reason_code: 'loop.completed',
    owner_identity_sha256: providerIdentitySha256,
    provider_lifecycle_receipt_sha256: workerLifecycle.receipt_sha256,
    provider_terminal_receipt_sha256: tail.receipt_sha256,
    runtime_lifecycle: null,
  })
  const terminalSteps = neuralSteps.map((neuralStep, index) => {
    const outputSnapshotSha256 = outputSnapshotSha256s[index]
    const step = reseal({
      ...exactSchemaFixture(terminalSchema, 'ClosedLoopStepReceiptV2'),
      study_run_id: studyRunId,
      step_id: `step_${sha256(
        Buffer.from(
          canonical({
            domain: 'engram-extension-closed-loop-step-v2',
            run_id: studyRunId,
            step_index: index + 1,
          })
        )
      ).slice(0, 32)}`,
      step_index: index + 1,
      input_snapshot_sha256: index === 0 ? initialSnapshotSha256 : outputSnapshotSha256s[index - 1],
      runtime_request_sha256: digest(`${count}-drone runtime request ${index + 1}`),
      neural_request_sha256: neuralStep.request.request_sha256,
      neural_result_sha256: neuralStep.result.result_sha256,
      provider_execution_scope: 'nest-exact-step-readback',
      provider_execution_sha256: stepExecutions[index].receipt_sha256,
      admitted_action_sha256: digest(`${count}-drone admitted action ${index + 1}`),
      output_snapshot_sha256: outputSnapshotSha256,
      fault_codes: index === 2 ? scheduledFaults : normalFaults,
    })
    return step
  })
  const neuralExecutions = neuralSteps.map((neuralStep, index) =>
    reseal(
      {
        ...exactSchemaFixture(terminalSchema, 'NeuralExecutionReceiptBindingV1'),
        step_id: terminalSteps[index].step_id,
        step_index: index + 1,
        neural_request_sha256: neuralStep.request.request_sha256,
        neural_result_sha256: neuralStep.result.result_sha256,
        provider_execution_scope: 'nest-exact-step-readback',
        provider_execution_sha256: stepExecutions[index].receipt_sha256,
      },
      'binding_sha256'
    )
  )
  const timebase = {
    ...exactSchemaFixture(terminalSchema, 'ClosedLoopTimebaseV1'),
    runtime_step_duration_tics: stepDurationTics,
    neural_step_duration_tics: stepDurationTics,
  }
  const terminal = {
    ...exactSchemaFixture(terminalSchema),
    study_run_id: studyRunId,
    study_definition_sha256: plan.study_definition_sha256,
    closed_loop_definition_sha256: definitionSha256,
    runtime_adapter_configuration_sha256: digest(`${count}-drone runtime adapter config`),
    runtime_binding_sha256: runtimeBindingSha256,
    neural_provider_identity_sha256: providerIdentitySha256,
    neural_preparation_sha256: providerPrepared.receipt_sha256,
    neural_session_receipt_sha256: binding.receipt_sha256,
    initial_snapshot_sha256: initialSnapshotSha256,
    transcript_sha256: '0'.repeat(64),
    planned_step_count: 6,
    timebase,
    steps: terminalSteps,
    neural_executions: neuralExecutions,
    last_verified_simulation_time_tics: totalRunTics,
    runtime_finish_sha256: digest(`${count}-drone runtime finish`),
    cleanup: [runtimeCleanup, neuralCleanup],
    cleanup_complete: true,
    status: 'completed',
    primary_reason_code: 'loop.completed',
    terminal_reason_code: 'loop.completed',
    runtime_progress_disposition: 'finished-and-host-verified',
    runtime_deadline_enforcement: 'host-generation-kill',
    neural_deadline_enforcement: 'host-generation-kill',
    neural_durable_evidence_profile: 'engram.nest-closed-loop-evidence-bundle.v2',
    runtime_lifecycle: runtimeLifecycle,
    simulator_only: true,
    ncp_qualified: false,
    physical_actuation: false,
    scientific_authority: false,
    is_paper_local_evidence: false,
    calibrated_posterior: false,
  }
  terminal.transcript_sha256 = sha256(
    Buffer.from(
      canonical({
        domain: 'engram-extension-closed-loop-transcript-v5',
        digest_canonicalization: terminal.digest_canonicalization,
        planned_step_count: terminal.planned_step_count,
        timebase: terminal.timebase,
        neural_preparation_sha256: terminal.neural_preparation_sha256,
        neural_session_receipt_sha256: terminal.neural_session_receipt_sha256,
        neural_durable_evidence_profile: terminal.neural_durable_evidence_profile,
        initial_snapshot_sha256: terminal.initial_snapshot_sha256,
        last_verified_simulation_time_tics: terminal.last_verified_simulation_time_tics,
        runtime_progress_disposition: terminal.runtime_progress_disposition,
        step_receipts: terminal.steps.map((row) => row.receipt_sha256),
        neural_execution_bindings: terminal.neural_executions.map((row) => row.binding_sha256),
        runtime_finish_sha256: terminal.runtime_finish_sha256,
        runtime_lifecycle_binding_sha256: terminal.runtime_lifecycle.binding_sha256,
        cleanup_receipts: terminal.cleanup.map((row) => row.receipt_sha256),
        status: terminal.status,
        primary_reason_code: terminal.primary_reason_code,
        terminal_reason_code: terminal.terminal_reason_code,
      })
    )
  )
  reseal(terminal)
  const evidence = reseal(
    {
      ...exactSchemaFixture(evidenceSchema),
      profile: 'killable-nest-population-controller-v2',
      run_receipt_sha256: terminal.receipt_sha256,
      study_run_id: studyRunId,
      neural_provider_identity_sha256: providerIdentitySha256,
      neural_preparation_sha256: providerPrepared.receipt_sha256,
      runtime_launch_expectation: expectation,
      worker_launch_attempt: launch,
      preparation_attempt: preparation,
      child_capabilities: capabilities,
      worker_runtime_identity: identity,
      child_preparation_receipt: childPrepared,
      provider_preparation_receipt: providerPrepared,
      worker_session_binding: binding,
      nest_session_readback: session,
      step_execution_receipts: stepExecutions,
      step_attempt_receipts: stepAttempts,
      tail_disposition_receipt: tail,
      worker_termination_attempt_receipts: terminationAttempts,
      worker_lifecycle_receipt: workerLifecycle,
      worker_terminal_disposition: 'confirmed-lifecycle',
      execution_authority: false,
      ncp_control: false,
      physical_actuation: false,
      scientific_authority: false,
      is_paper_local_evidence: false,
      calibrated_posterior: false,
    },
    'bundle_sha256'
  )
  const workerGuardian = {
    worker_session_binding_receipt_sha256: binding.receipt_sha256,
    worker_runtime_identity_receipt_sha256: identity.receipt_sha256,
    worker_lifecycle_receipt_sha256: workerLifecycle.receipt_sha256,
    termination_attempt_count: terminationAttempts.length,
    termination_attempt_roster_sha256: sha256(Buffer.from(canonical(terminationAttempts))),
    worker_pid: workerPid,
    worker_source_sha256: workerSourceFile.sha256,
    worker_command_sha256: workerCommandSha256,
    child_reaped: true,
    containment_empty: true,
    diagnostic_stream_complete: true,
  }
  const storedTerminal = Object.fromEntries(
    Object.entries(terminal).filter(([key]) => key !== 'receipt_sha256')
  )
  const storedEvidence = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'bundle_sha256')
  )
  const receiptPath = `receipts/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const evidencePath = `evidence/${evidence.bundle_sha256.slice(0, 2)}/${evidence.bundle_sha256}.json`
  const storeId = `clrs_${digest(`${count}-drone receipt store`)}`
  const reservationId = `clrr_${digest(`${count}-drone receipt reservation`)}`
  const preSpawnSha256 = digest(`${count}-drone pre-spawn`)
  const reservation = reseal(
    {
      schema_version: 'engram.extension-closed-loop-receipt-reservation.v1',
      store_id: storeId,
      reservation_id: reservationId,
      study_run_id: studyRunId,
      closed_loop_definition_sha256: definitionSha256,
      receipt_profile: 'engram.extension-closed-loop-run-receipt.v2',
      evidence_profile: 'optional-engram.nest-closed-loop-evidence-bundle.v2',
      nest_work_admission_sha256: workAdmission.receipt_sha256,
      pre_spawn_sha256: preSpawnSha256,
      run_plan_sha256: sha256(Buffer.from(canonical(plan))),
      nest_configuration_sha256: sha256(Buffer.from(canonical(config))),
      expected_runtime_binding_sha256: runtimeBindingSha256,
      reviewed_native_handshake_receipt_sha256: handshake.receipt_sha256,
      reviewed_native_handshake: handshake,
      package_generation_id: proof.package_generation_id,
      runtime_generation_id: runtimeGenerationId,
      reserved_record_count: 1,
      reserved_artifact_bytes: 16777216,
      reserved_evidence_bytes: estimatedEvidenceBundleBytes,
      reserved_record_bytes: 4096,
      execution_authority: false,
      ncp_control: false,
      physical_actuation: false,
      scientific_authority: false,
      is_paper_local_evidence: false,
      calibrated_posterior: false,
    },
    'reservation_sha256'
  )
  const simulationDispatchSha256 = sha256(
    Buffer.from(
      canonical({
        schema_version: 'engram.extension-closed-loop-dispatch-intent.v1',
        store_id: storeId,
        reservation_id: reservationId,
        reservation_sha256: reservation.reservation_sha256,
      })
    )
  )
  const extensionDispatchSha256 = sha256(
    Buffer.from(
      canonical({
        schema_version: 'engram.extension-closed-loop-extension-dispatch-intent.v1',
        store_id: storeId,
        reservation_id: reservationId,
        pre_spawn_sha256: preSpawnSha256,
      })
    )
  )
  const finalization = reseal(
    {
      schema_version: 'engram.extension-closed-loop-finalized-reservation.v1',
      store_id: storeId,
      reservation,
      pre_spawn_sha256: preSpawnSha256,
      extension_dispatch_sha256: extensionDispatchSha256,
      simulation_dispatch_sha256: simulationDispatchSha256,
      terminal_receipt_sha256: terminal.receipt_sha256,
      evidence_bundle_sha256: evidence.bundle_sha256,
      nest_work_admission_rejoined: true,
      execution_authority: false,
      ncp_control: false,
      physical_actuation: false,
      scientific_authority: false,
      is_paper_local_evidence: false,
      calibrated_posterior: false,
    },
    'finalization_sha256'
  )
  const publicationWalSha256 = sha256(
    Buffer.from(
      canonical({
        domain: 'engram-extension-closed-loop-reserved-publication-wal-closure-v1',
        store_id: storeId,
        reservation_id: reservationId,
        pre_spawn_sha256: preSpawnSha256,
        extension_dispatch_sha256: extensionDispatchSha256,
        reservation_sha256: reservation.reservation_sha256,
        simulation_dispatch_sha256: simulationDispatchSha256,
        terminal_receipt_sha256: terminal.receipt_sha256,
      })
    )
  )
  const studyRunKeySha256 = sha256(
    Buffer.from(
      canonical({
        domain: 'engram-extension-closed-loop-publication-study-run-key-v1',
        store_id: storeId,
        study_run_id: studyRunId,
      })
    )
  )
  const publicationAnchor = reseal(
    {
      schema_version: 'engram.extension-closed-loop-publication-admission-anchor.v1',
      store_id: storeId,
      study_run_key_sha256: studyRunKeySha256,
      study_run_id: studyRunId,
      terminal_receipt_sha256: terminal.receipt_sha256,
      admission_mode: 'reserved',
      publication_wal_sha256: publicationWalSha256,
      evidence_bundle_sha256: evidence.bundle_sha256,
      reservation_id: reservationId,
      reservation_sha256: reservation.reservation_sha256,
      pre_spawn_sha256: preSpawnSha256,
      extension_dispatch_sha256: extensionDispatchSha256,
      simulation_dispatch_sha256: simulationDispatchSha256,
      reservation_finalization_sha256: finalization.finalization_sha256,
      execution_authority: false,
      ncp_control: false,
      physical_actuation: false,
      scientific_authority: false,
      is_paper_local_evidence: false,
      calibrated_posterior: false,
    },
    'anchor_sha256'
  )
  const publicationAuthority = reseal(
    {
      schema_version: 'engram.extension-closed-loop-publication-authority.v1',
      store_id: storeId,
      terminal_receipt_sha256: terminal.receipt_sha256,
      study_run_id: studyRunId,
      admission_mode: 'reserved',
      publication_admission_anchor_sha256: publicationAnchor.anchor_sha256,
      publication_wal_sha256: publicationWalSha256,
      evidence_bundle_sha256: evidence.bundle_sha256,
      reservation_id: reservationId,
      reservation_sha256: reservation.reservation_sha256,
      reservation_finalization_sha256: finalization.finalization_sha256,
      nest_work_admission_sha256: workAdmission.receipt_sha256,
      execution_authority: false,
      ncp_control: false,
      physical_actuation: false,
      scientific_authority: false,
      is_paper_local_evidence: false,
      calibrated_posterior: false,
    },
    'authority_sha256'
  )
  const observation = reseal(
    {
      schema_version: 'engram.extension-closed-loop-stored-receipt.v5',
      store_id: storeId,
      artifact: {
        artifact_id: `art_${terminal.receipt_sha256.slice(0, 32)}`,
        kind: 'closed_loop_receipt',
        sha256: terminal.receipt_sha256,
      },
      study_run_id: studyRunId,
      run_status: 'completed',
      terminal_reason_code: 'loop.completed',
      relative_artifact_path: receiptPath,
      artifact_byte_length: Buffer.byteLength(canonical(storedTerminal)),
      evidence_profile: 'killable-nest-population-controller-v2',
      evidence_bundle_sha256: evidence.bundle_sha256,
      relative_evidence_path: evidencePath,
      evidence_byte_length: Buffer.byteLength(canonical(storedEvidence)),
      admission_mode: 'reserved',
      publication_authority_sha256: publicationAuthority.authority_sha256,
      reservation_id: reservationId,
      reservation_sha256: reservation.reservation_sha256,
      reservation_finalization_sha256: finalization.finalization_sha256,
      nest_work_admission_sha256: workAdmission.receipt_sha256,
      nest_work_admission_rejoined: true,
      digest_canonicalization: 'engram.managed-runtime-json.v1',
      execution_authority: false,
      ncp_control: false,
      physical_actuation: false,
      scientific_authority: false,
      is_paper_local_evidence: false,
      calibrated_posterior: false,
    },
    'record_sha256'
  )
  const storeMetadata = {
    schema_version: 'engram.extension-closed-loop-receipt-store.v5',
    store_id: storeId,
    policy: 'engram.extension-closed-loop-receipt-store-policy.v5',
    digest_canonicalization: 'engram.managed-runtime-json.v1',
    execution_authority: false,
    ncp_control: false,
    physical_actuation: false,
    scientific_authority: false,
    is_paper_local_evidence: false,
    calibrated_posterior: false,
  }
  const receiptStoreSidecars = reseal(
    {
      schema_version: 'crebain.closed-loop-receipt-store-sidecars.v1',
      store_metadata: storeMetadata,
      finalized_reservation: finalization,
      observation,
      publication_admission_anchor: publicationAnchor,
      publication_authority: publicationAuthority,
    },
    'closure_sha256'
  )
  const finalizationPath = `finalized-reservations/${reservationId.slice(5, 7)}/${reservationId}.json`
  const observationPath = `observations/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const anchorPath = `publication-admission-anchors/${studyRunKeySha256}.json`
  const authorityPath = `publication-authorities/${terminal.receipt_sha256.slice(0, 2)}/${terminal.receipt_sha256}.json`
  const storeMaterial = new Map([
    ['store.json', Buffer.from(canonical(storeMetadata))],
    ['writer.lock', Buffer.from('engram-extension-closed-loop-receipt-store-lock-v1\n')],
    [receiptPath, Buffer.from(canonical(storedTerminal))],
    [evidencePath, Buffer.from(canonical(storedEvidence))],
    [finalizationPath, Buffer.from(canonical(finalization))],
    [observationPath, Buffer.from(canonical(observation))],
    [anchorPath, Buffer.from(canonical(publicationAnchor))],
    [authorityPath, Buffer.from(canonical(publicationAuthority))],
  ])
  const files = [...storeMaterial.entries()]
    .map(([relative_path, payload]) => ({
      relative_path,
      size_bytes: payload.length,
      sha256: sha256(payload),
    }))
    .sort((left, right) => compareText(left.relative_path, right.relative_path))
  const store = reseal(
    {
      schema_version: 'crebain.closed-loop-receipt-store-closure.v1',
      store_id: storeId,
      receipt_sha256: terminal.receipt_sha256,
      receipt_artifact_path: receiptPath,
      evidence_bundle_sha256: evidence.bundle_sha256,
      evidence_artifact_path: evidencePath,
      file_count: files.length,
      total_bytes: files.reduce((sum, row) => sum + row.size_bytes, 0),
      files,
    },
    'closure_sha256'
  )
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
      authority: false,
      calibrated_posterior: false,
      run_status: 'completed',
      status: 'recorded',
      channel_count: count,
      completed_step_count: 6,
      planned_step_count: 6,
      receipt_sha256: terminal.receipt_sha256,
      evidence_bundle_sha256: evidence.bundle_sha256,
      store_id: storeId,
      reservation_id: reservationId,
      study_run_id: studyRunId,
      terminal_reason_code: 'loop.completed',
      simulator_only: true,
      ncp_qualified: false,
      physical_actuation: false,
      scientific_authority: false,
    },
    terminal_receipt: terminal,
    reviewed_native_runtime: {
      handshake_receipt: handshake,
      termination_receipt: reviewedTermination,
      exec_gate_command_binding: execGateCommandBinding,
      lifecycle_binding_sha256: runtimeLifecycle.binding_sha256,
      guardian_closure_verified: true,
      package_store_lineage_verified: true,
    },
    nest_worker_guardian_closure: workerGuardian,
    receipt_store_closure: store,
    receipt_store_sidecars: receiptStoreSidecars,
    population_topology: topologySummary,
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

export function makeV2EvidenceFixture(root, { independentPopulationPrefixOrder = false } = {}) {
  const inputRoot = resolve(
    root,
    'integrations/engram/managed-simulation/operational-inputs/real-nest-3.9-v1'
  )
  let suiteBytes = readFileSync(resolve(inputRoot, 'SUITE.json'))
  const suite = JSON.parse(suiteBytes)
  const configBytes = readFileSync(resolve(inputRoot, suite.nest_config.path))
  const plans = new Map(
    suite.runs.map((row) => {
      const bytes = readFileSync(resolve(inputRoot, row.plan_path))
      return [row.drone_count, { row, path: row.plan_path, bytes }]
    })
  )
  if (independentPopulationPrefixOrder) {
    const plan = plans.get(3)
    const document = annotateRunPlanNumbers(JSON.parse(plan.bytes))
    for (const [channel, prefix] of document.channels.map((channel, index) => [
      channel,
      ['zeta', 'alpha', 'mu'][index],
    ])) {
      channel.neural_population_prefix = prefix
    }
    plan.bytes = exactBytes(document)
    suite.runs.find((row) => row.drone_count === 3).plan_exact_sha256 = sha256(plan.bytes)
    const suiteDefinition = Object.fromEntries(
      Object.entries(suite).filter(([key]) => key !== 'suite_definition_sha256')
    )
    suite.suite_definition_sha256 = sha256(Buffer.from(canonical(suiteDefinition)))
    suiteBytes = exactBytes(suite)
  }
  const context = {
    suite,
    suiteBytes,
    configBytes,
    toolSourceBytes: new Map(
      [...TOOL_SOURCE_ROLES].map(([path]) => [path, readFileSync(resolve(root, path))])
    ),
    plans,
  }
  const evidenceSchemaRoot = resolve(
    root,
    'integrations/engram/managed-simulation/evidence-schemas'
  )
  const schemas = Object.fromEntries(
    [
      ['contained', 'engram.contained-exec-command.v1.schema.json'],
      ['handshake', 'engram.reviewed-native-development-handshake.v1.schema.json'],
      ['termination', 'engram.reviewed-native-development-termination.v1.schema.json'],
      ['lifecycle', 'engram.closed-loop-runtime-lifecycle-binding.v1.schema.json'],
      ['terminal', 'engram.extension-closed-loop-run-receipt.v2.schema.json'],
      ['evidence', 'engram.nest-closed-loop-evidence-bundle.v2.schema.json'],
    ].map(([role, name]) => [role, JSON.parse(readFileSync(resolve(evidenceSchemaRoot, name)))])
  )
  const engram = {
    repository: 'https://github.com/sepahead/engram.git',
    commit: 'c'.repeat(40),
    tree: 'd'.repeat(40),
    origin_main: 'c'.repeat(40),
    object_format: 'sha1',
    clean: true,
  }
  const proof = installedProof(engram)
  const buildRepository = proof.observed_build_receipt.repository
  const crebainSourceRepository = {
    repository: buildRepository.origin,
    commit: buildRepository.commit,
    tree: buildRepository.tree,
    origin_main_at_capture: buildRepository.origin_main,
    object_format: buildRepository.object_format,
    clean_at_capture: buildRepository.clean,
  }
  context.crebainSourceRepository = crebainSourceRepository
  const captures = new Map()
  const rows = []
  for (const count of [1, 2, 3]) {
    const guardianSourceSha256 = digest('reviewed runtime guardian source')
    const execGateSourceSha256 = sourceRow('backend/integrations/contained_exec_gate.py').sha256
    const execGateCommandBinding = reseal(
      {
        ...exactSchemaFixture(schemas.contained),
        python_executable_sha256: digest('reviewed runtime Python executable'),
        exec_gate_source_sha256: execGateSourceSha256,
        target_command_sha256: digest(`${count}-drone reviewed runtime target command`),
      },
      'exec_gate_command_sha256'
    )
    const processPid = 3100 + count * 10
    const handshake = reseal({
      ...exactSchemaFixture(schemas.handshake),
      installation_id: proof.installation_id,
      generation_id: `gen_${digest(`${count}-drone runtime generation`)}`,
      generation_ordinal: count,
      extension_id: 'sepahead.crebain.simulation',
      extension_version: '0.1.0',
      target_id: TARGET.target_id,
      executable_sha256: proof.executable_sha256,
      validator_set_sha256: digest('reviewed runtime validator set'),
      launch_source: 'package-store-lease',
      store_id: proof.store_id,
      generation_directory_identity_sha256: digest(`${count}-drone generation directory`),
      package_generation_id: proof.package_generation_id,
      package_generation_lease_retained: true,
      host_handshake_frame_sha256: digest(`${count}-drone host handshake frame`),
      runtime_handshake_frame_sha256: digest(`${count}-drone runtime handshake frame`),
      package_path_reopened_for_spawn: false,
      verified_executable_staged: true,
      staged_executable_owner_private: true,
      staged_executable_user_immutable: true,
      exec_gate_source_sha256: execGateSourceSha256,
      exec_gate_command_sha256: execGateCommandBinding.exec_gate_command_sha256,
      process_pid: processPid,
      guardian_source_sha256: guardianSourceSha256,
      guardian_command_sha256: digest(`${count}-drone reviewed runtime guardian command`),
      guardian_pid: processPid + 1,
      process_group_id: processPid,
      session_id: 2100 + count,
      guardian_ready_frame_sha256: digest(`${count}-drone guardian ready frame`),
      guardian_generation_lease_retained: true,
      guardian_uncertainty_record_prepared: true,
      sandbox_profile_sha256: digest('reviewed runtime sandbox profile'),
      sandbox_launcher_sha256: digest('reviewed runtime sandbox launcher'),
      child_ready_claim: false,
      automatic_restart: false,
      host_local_admission: true,
      process_launch_performed: true,
      handshake_transcript_accepted: true,
      explicit_absolute_path_spawn: true,
      path_lookup_at_spawn: true,
      process_group_containment: true,
      runtime_process_group_leader: true,
      guardian_group_member: true,
      guardian_owner_loss_seal: true,
      network_isolation_enforced: true,
      os_sandbox_enforced: true,
      descendant_creation_denied: true,
      filesystem_isolation_enforced: false,
      external_dependency_closure_attested: false,
      publisher_authenticated: false,
      replayable_live_launch_authority: false,
      durable_process_launch_authority: false,
      ncp_authority: false,
      physical_authority: false,
      scientific_authority: false,
    })
    const source = sourceClosure(engram, handshake, execGateCommandBinding, guardianSourceSha256)
    const plan = plans.get(count)
    const capture = exactRuntimeCaptureFixture(
      count,
      plan.bytes,
      configBytes,
      proof,
      source,
      handshake,
      execGateCommandBinding,
      schemas
    )
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
      engram_source_roster_sha256: source.source_roster_sha256,
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
    crebain_source_repository: crebainSourceRepository,
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
      common_clean_engram_source_roster: true,
      distinct_engram_runtime_source_closures: true,
      crebain_source_lineage_common: true,
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
