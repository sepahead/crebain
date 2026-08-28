#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CRATE = resolve(ROOT, 'src-tauri/crates/managed-simulation')
const INTEGRATION = resolve(ROOT, 'integrations/engram/managed-simulation')
const CONTRACTS = resolve(INTEGRATION, 'contracts')
const EVIDENCE_SCHEMAS = resolve(INTEGRATION, 'evidence-schemas')
const OPERATIONAL_EVIDENCE = resolve(INTEGRATION, 'operational-evidence/real-nest-3.9-v2')
const OPERATIONAL_INPUTS = resolve(INTEGRATION, 'operational-inputs/real-nest-3.9-v1')
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
  'population_topology',
  'nest_evidence_bundle',
  'neural_steps',
  'assertions',
  'authority',
  'disclosure',
])
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
const EXPECTED_EVIDENCE_SCHEMA_HASHES = {
  'engram-pack-receipt.v1.schema.json':
    '6a2f7a72ae29033ca53d45f6345913bb7294ea89be2d9668882c60d65ee49500',
  'installed-binary-proof.v3.schema.json':
    'c04b958cf4af85bed91c225767b27484c8791378efb60eec27a10111c298a0c4',
  'observed-build-receipt.v1.schema.json':
    '6f0f40444b3bbfbce642cb1766f05d0d55a741df6dbd9e7fe199784488ac06e0',
  'package-stage-receipt.v1.schema.json':
    'c0c6d3d9615d87b320da4220c3e0da5d3a355889d1aacd8e1751dc75a596cfed',
  'real-nest-capture.v2.schema.json':
    'a57a029a14db0dee40dc5d9b3a0394ec53bb569cedf9ae67ca477ade73b2b4b8',
  'real-nest-evidence-index.v2.schema.json':
    '0bac92adbc5fa0e53852b5aca8219ecb28ca44e1bde25e3a5bdeded138d43234',
}
function fail(message) {
  throw new Error(`Managed simulation boundary check failed: ${message}`)
}

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

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
    document = JSON.parse(source)
  } catch {
    fail(`${label} contains malformed JSON text`)
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail(`${label} is not one JSON object`)
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

function canonicalDigest(document, field, label) {
  const reported = document?.[field]
  if (!isSha256(reported)) fail(`${label} lacks ${field}`)
  const material = Object.fromEntries(Object.entries(document).filter(([key]) => key !== field))
  if (sha256(canonical(material)) !== reported) fail(`${label} canonical digest differs`)
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
    const required = requiredByName.get(name)
    if (
      schema?.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
      typeof schema?.$id !== 'string' ||
      !schema.$id.startsWith('https://crebain.local/schemas/') ||
      schema.type !== 'object' ||
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required) ||
      schema.properties === null ||
      typeof schema.properties !== 'object'
    ) {
      fail(`${name} root closure differs`)
    }
    compareSets(new Set(schema.required), required, `${name} required roster`)
    compareSets(new Set(Object.keys(schema.properties)), required, `${name} property roster`)
    if (
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
        fail('real-NEST v2 capture-row schema is not the exact 15-key closure')
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
  if (source.roster_sha256 !== sha256(canonical(source.files))) {
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
  if (generator.roster_sha256 !== sha256(canonical(generator.files))) {
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
  if (receipt.input_identity_sha256 !== sha256(canonical(identity))) {
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
  canonicalDigest(receipt, 'receipt_sha256', 'observed-build receipt')
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
    receipt.package_inventory_sha256 !== sha256(canonical(inventory)) ||
    canonical(receipt.authority) !== canonical(BUILD_NO_AUTHORITY) ||
    typeof receipt.disclosure !== 'string' ||
    receipt.disclosure.length === 0
  ) {
    fail('package-stage inventory digest or authority differs')
  }
  canonicalDigest(receipt, 'receipt_sha256', 'package-stage receipt')
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
  canonicalDigest(receipt, 'receipt_sha256', 'Engram pack receipt')
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
  canonicalDigest(proof, 'receipt_sha256', 'installed-binary proof v3')
  return proof
}

function operationalInputContext() {
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
  }
}

function assertNestedSourceClosure(capture, index, proof) {
  const source = exactKeys(
    capture.engram_source_closure,
    new Set([
      'schema_version',
      'discovery_policy',
      'git',
      'host_modules',
      'worker_project_modules',
      'worker_project_source_roster_sha256',
      'reviewed_runtime_handshake_receipt_sha256',
      'reviewed_runtime_guardian_source_sha256',
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
    !isSha256(source.worker_project_source_roster_sha256) ||
    !isSha256(source.reviewed_runtime_handshake_receipt_sha256) ||
    !isSha256(source.reviewed_runtime_guardian_source_sha256)
  ) {
    fail('Engram source closure identity differs')
  }
  assertSourceRows(source.sources, 'Engram source closure roster', false, 0, 1024)
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
  for (const row of [
    ...source.host_modules,
    ...source.worker_project_modules,
    ...source.exercised_entrypoints,
  ]) {
    if (!paths.has(row.relative_path)) fail('nested Engram source roster escapes its closure')
  }
  const packRows = source.sources.filter(
    (row) => row.relative_path === 'scripts/engram_extension.py'
  )
  const packModules = source.host_modules.filter(
    (row) =>
      row.module_name === 'scripts.engram_extension' &&
      row.relative_path === 'scripts/engram_extension.py'
  )
  if (
    packRows.length !== 1 ||
    canonical(packRows[0]) !== canonical(packTool) ||
    packModules.length !== 1
  ) {
    fail('Engram pack tool differs from the loaded committed source closure')
  }
  const sourceDigestMap = Object.fromEntries(
    source.sources.map((row) => [row.relative_path, row.sha256])
  )
  if (canonical(capture.engram_source_sha256) !== canonical(sourceDigestMap)) {
    fail('capture Engram source digest map differs')
  }
  canonicalDigest(source, 'closure_sha256', 'Engram source closure')
  return source
}

function assertReceiptStoreClosure(store, terminal, evidence) {
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
  if (
    !/^clrs_[a-f0-9]{64}$/u.test(store.store_id) ||
    store.files.some(
      (row) =>
        !Number.isInteger(row.size_bytes) ||
        row.size_bytes < 0 ||
        row.size_bytes > 16 * 1024 * 1024 ||
        !isSha256(row.sha256)
    ) ||
    store.file_count !== store.files.length ||
    store.total_bytes !== store.files.reduce((sum, row) => sum + row.size_bytes, 0) ||
    !store.files.some((row) => row.relative_path === store.receipt_artifact_path) ||
    !store.files.some((row) => row.relative_path === store.evidence_artifact_path) ||
    store.receipt_sha256 !== terminal.receipt_sha256 ||
    store.evidence_bundle_sha256 !== evidence.bundle_sha256
  ) {
    fail('closed-loop receipt-store closure identity differs')
  }
  canonicalDigest(store, 'closure_sha256', 'closed-loop receipt-store closure')
  return store
}

function assertWorkerGuardianClosure(guardian, evidence, source) {
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
  const bindingDigest = canonicalDigest(binding, 'receipt_sha256', 'NEST worker session binding')
  const lifecycleDigest = canonicalDigest(
    lifecycle,
    'receipt_sha256',
    'NEST worker lifecycle receipt'
  )
  const identityDigest = canonicalDigest(identity, 'receipt_sha256', 'NEST worker runtime identity')
  const sessionDigest = canonicalDigest(session, 'receipt_sha256', 'NEST session readback')
  const attemptsDigest = sha256(canonical(attempts))
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
  for (const [index, attempt] of attempts.entries()) {
    if (attempt === null || typeof attempt !== 'object' || Array.isArray(attempt)) {
      fail('NEST worker termination attempt is not an object')
    }
    canonicalDigest(attempt, 'receipt_sha256', 'NEST worker termination attempt')
    if (
      attempt.attempt_index !== index + 1 ||
      attempt.worker_pid !== lifecycle.worker_pid ||
      attempt.worker_source_sha256 !== lifecycle.worker_source_sha256 ||
      attempt.worker_command_sha256 !== lifecycle.worker_command_sha256 ||
      attempt.adapter_source_sha256 !== lifecycle.adapter_source_sha256 ||
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
    for (let axis = 0; axis < 3; axis += 1) {
      populationNames.push(
        `${channel.neural_population_prefix}.d${axis.toString().padStart(2, '0')}.negative`,
        `${channel.neural_population_prefix}.d${axis.toString().padStart(2, '0')}.positive`
      )
    }
  }
  return {
    session_count: 1,
    drone_count: channelIds.length,
    action_axis_count: channelIds.length * 3,
    population_count: channelIds.length * 6,
    population_neuron_count: channelIds.length * 6 * populationSize,
    device_node_count: channelIds.length * 12,
    connection_count: channelIds.length * 12 * populationSize,
    population_names: populationNames,
    derived_population_roster_sha256: sha256(canonical(populationNames)),
  }
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
  canonicalDigest(terminal, 'receipt_sha256', 'terminal closed-loop receipt')
  canonicalDigest(evidence, 'bundle_sha256', 'NEST evidence bundle')
  if (evidence.run_receipt_sha256 !== terminal.receipt_sha256) {
    fail(`${count}-drone v2 capture receipt and evidence differ`)
  }
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
  const capture = strictJsonObject(capturePayload, `${row.drone_count}-drone v2 capture`)
  if (!Buffer.from(`${canonical(capture)}\n`).equals(capturePayload)) {
    fail(`${row.drone_count}-drone v2 capture is not exact canonical JSON bytes`)
  }
  exactKeys(capture, CAPTURE_V2_KEYS, `${row.drone_count}-drone v2 capture`)
  const count = row.drone_count
  const plan = context.plans.get(count)
  if (
    capture.schema_version !== 'crebain.real-nest-closed-loop-capture.v2' ||
    plan === undefined ||
    capture.plan_exact_sha256 !== sha256(plan.bytes) ||
    capture.plan_exact_sha256 !== row.plan_exact_sha256 ||
    canonical(capture.run_plan) !== canonical(JSON.parse(plan.bytes)) ||
    capture.nest_config_exact_sha256 !== sha256(context.configBytes) ||
    canonical(capture.nest_config) !== canonical(JSON.parse(context.configBytes)) ||
    !Number.isInteger(capture.receipt_lock_timeout_ms) ||
    capture.receipt_lock_timeout_ms < 1 ||
    capture.receipt_lock_timeout_ms > 300000
  ) {
    fail(`${count}-drone v2 capture tracked input lineage differs`)
  }
  const proof = assertInstalledProofV3(capture.installed_package_proof)
  const proofBytes = Buffer.from(`${canonical(proof)}\n`)
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
  assertWorkerGuardianClosure(capture.nest_worker_guardian_closure, evidence, source)
  const store = assertReceiptStoreClosure(capture.receipt_store_closure, terminal, evidence)
  const expectedTopology = expectedPopulationTopology(capture)
  if (canonical(capture.population_topology) !== canonical(expectedTopology)) {
    fail(`${count}-drone v2 capture exact 6N topology summary differs`)
  }
  const session = evidence.nest_session_readback
  if (
    session.observed_population_neuron_count !== expectedTopology.population_neuron_count ||
    session.observed_device_node_count !== expectedTopology.device_node_count ||
    session.observed_total_connection_count !== expectedTopology.connection_count
  ) {
    fail(`${count}-drone v2 capture NEST topology readback differs`)
  }
  const summary = capture.summary
  if (
    summary?.run_status !== 'completed' ||
    summary?.channel_count !== count ||
    summary?.receipt_sha256 !== terminal.receipt_sha256 ||
    summary?.evidence_bundle_sha256 !== evidence.bundle_sha256 ||
    summary?.store_id !== store.store_id
  ) {
    fail(`${count}-drone v2 capture summary differs`)
  }
  const reviewed = capture.reviewed_native_runtime
  const lifecycle = terminal.runtime_lifecycle
  exactKeys(
    reviewed,
    new Set([
      'handshake_receipt',
      'termination_receipt',
      'lifecycle_binding_sha256',
      'guardian_closure_verified',
      'package_store_lineage_verified',
    ]),
    'reviewed native runtime closure'
  )
  const handshake = reviewed.handshake_receipt
  const termination = reviewed.termination_receipt
  if (
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
  const handshakeDigest = canonicalDigest(
    handshake,
    'receipt_sha256',
    'reviewed runtime handshake receipt'
  )
  const terminationDigest = canonicalDigest(
    termination,
    'receipt_sha256',
    'reviewed runtime termination receipt'
  )
  const lifecycleDigest = canonicalDigest(
    lifecycle,
    'binding_sha256',
    'reviewed runtime lifecycle binding'
  )
  if (
    reviewed.guardian_closure_verified !== true ||
    reviewed.package_store_lineage_verified !== true ||
    reviewed.lifecycle_binding_sha256 !== lifecycleDigest ||
    source.reviewed_runtime_handshake_receipt_sha256 !== handshakeDigest ||
    source.reviewed_runtime_guardian_source_sha256 !== handshake.guardian_source_sha256 ||
    termination.handshake_receipt_sha256 !== handshakeDigest ||
    lifecycle.handshake_receipt_sha256 !== handshakeDigest ||
    lifecycle.termination_receipt_sha256 !== terminationDigest ||
    handshake.launch_source !== 'package-store-lease' ||
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
    observed_build_receipt_exact_sha256: proof.observed_build_receipt_exact_sha256,
    population_count: expectedTopology.population_count,
    population_neuron_count: expectedTopology.population_neuron_count,
    device_node_count: expectedTopology.device_node_count,
    connection_count: expectedTopology.connection_count,
    session_count: expectedTopology.session_count,
  }
  if (canonical(row) !== canonical(expectedRow)) {
    fail(`${count}-drone v2 capture row differs from its exact 15-key closure`)
  }
  return { capture, proof, source, store }
}

function assertOperationalEvidenceV2(indexPayload, capturePayloads, context) {
  const index = strictJsonObject(indexPayload, 'real-NEST v2 evidence index')
  if (!Buffer.from(`${canonical(index)}\n`).equals(indexPayload)) {
    fail('real-NEST v2 evidence index is not exact canonical JSON bytes')
  }
  exactKeys(
    index,
    new Set([
      'schema_version',
      'profile',
      'input_suite',
      'tool_source_closure',
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
  if (
    new Set(index.captures.map((row) => row.receipt_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.capture_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.evidence_bundle_sha256)).size !== 3 ||
    new Set(index.captures.map((row) => row.receipt_store_id)).size !== 3 ||
    new Set(index.captures.map((row) => row.engram_source_closure_sha256)).size !== 1 ||
    new Set(index.captures.map((row) => row.observed_build_receipt_exact_sha256)).size !== 1 ||
    new Set(proofs.map((proof) => canonical(proof))).size !== 1 ||
    index.installed_package_proof_exact_sha256 !== sha256(Buffer.from(`${canonical(proofs[0])}\n`))
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
    'common_clean_engram_source_closure',
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

function assertTrackedOperationalEvidenceV2() {
  const evidenceIndex = readFileSync(resolve(OPERATIONAL_EVIDENCE, 'INDEX.json'))
  const evidenceIndexDocument = strictJsonObject(evidenceIndex, 'tracked real-NEST evidence index')
  if (evidenceIndexDocument.schema_version !== 'crebain.real-nest-closed-loop-evidence-index.v2') {
    fail('operational-v2 mode requires tracked real-NEST INDEX v2')
  }
  if (!Array.isArray(evidenceIndexDocument.captures)) {
    fail('operational-v2 mode requires the tracked capture-v2 roster')
  }
  const captures = new Map(
    evidenceIndexDocument.captures.map((row) => {
      const path = safeRelative(row?.path, 'tracked real-NEST capture path', '.json')
      return [path, readFileSync(resolve(OPERATIONAL_EVIDENCE, path))]
    })
  )
  assertOperationalEvidence(evidenceIndex, captures, operationalInputContext())
}

function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--operational-v2')) {
    fail('usage: check-managed-simulation-boundary.mjs [--operational-v2]')
  }
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
      readFileSync(resolve(EVIDENCE_SCHEMAS, name)),
    ])
  )
  assertCrateBoundary(manifestSource, sources, readdirSync(CRATE))
  assertContractGateBoundary(JSON.parse(readFileSync(resolve(ROOT, 'package.json'))))
  assertSchemaDigests(payloads)
  assertContractProvenance(
    JSON.parse(readFileSync(resolve(CONTRACTS, 'PROVENANCE.json'))),
    payloads
  )
  assertStandardFaultCodeSchemaBoundary(payloads)
  assertDifferentialArtifacts(differentialPayloads)
  assertEvidenceSchemas(evidenceSchemaPayloads)
  assertManifestBoundary(JSON.parse(readFileSync(resolve(INTEGRATION, 'manifest.template.json'))))
  assertTranscriptBoundary(JSON.parse(readFileSync(resolve(INTEGRATION, 'sample-transcript.json'))))
  if (argv[0] === '--operational-v2') {
    assertTrackedOperationalEvidenceV2()
    console.log(
      'OK: managed simulation bootstrap boundary and tracked real-NEST v2 evidence are exact'
    )
    return
  }
  console.log('OK: provider-free managed simulation bootstrap boundary is exact')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
