#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertContractGateBoundary,
  assertCrateBoundary,
  assertContractProvenance,
  assertDifferentialArtifacts,
  assertEvidenceSchemas,
  assertManifestBoundary,
  assertOperationalEvidence,
  assertStandardFaultCodeSchemaBoundary,
  assertTranscriptBoundary,
} from './check-managed-simulation-boundary.mjs'
import {
  canonical,
  exactBytes,
  makeV2EvidenceFixture,
  reseal,
  sha256,
} from './managed-simulation-v2-test-fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, 'package.json')))
const CRATE = resolve(ROOT, 'src-tauri/crates/managed-simulation')
const INTEGRATION = resolve(ROOT, 'integrations/engram/managed-simulation')
const MANIFEST_SOURCE = readFileSync(resolve(CRATE, 'Cargo.toml'), 'utf8')
const sourceRoot = resolve(CRATE, 'src')
const SOURCES = new Map(
  readdirSync(sourceRoot)
    .filter((name) => name.endsWith('.rs'))
    .map((name) => [name, readFileSync(resolve(sourceRoot, name), 'utf8')])
)
for (const relative of ['../../../src/pid_observation.rs', '../../../src/sensor_fusion.rs']) {
  SOURCES.set(relative, readFileSync(resolve(sourceRoot, relative), 'utf8'))
}
const MANIFEST = JSON.parse(readFileSync(resolve(INTEGRATION, 'manifest.template.json')))
const TRANSCRIPT = JSON.parse(readFileSync(resolve(INTEGRATION, 'sample-transcript.json')))
const DIFFERENTIAL_ARTIFACTS = new Map(
  ['engram.managed-runtime-finite-float.v1.json', 'finite-float-differential.provenance.json'].map(
    (name) => [name, readFileSync(resolve(INTEGRATION, 'contracts', name))]
  )
)
const EVIDENCE_SCHEMAS = new Map(
  [
    'engram-pack-receipt.v1.schema.json',
    'installed-binary-proof.v3.schema.json',
    'observed-build-receipt.v1.schema.json',
    'package-stage-receipt.v1.schema.json',
    'real-nest-capture.v2.schema.json',
    'real-nest-evidence-index.v2.schema.json',
  ].map((name) => [name, readFileSync(resolve(INTEGRATION, 'evidence-schemas', name))])
)
const STANDARD_RESPONSE_SCHEMAS = new Map(
  ['standard-v3-prepare-response.schema.json', 'standard-v3-step-response.schema.json'].map(
    (name) => [name, readFileSync(resolve(INTEGRATION, 'contracts', name))]
  )
)
const CONTRACT_PAYLOADS = new Map(
  [
    'managed-runtime-ipc.schema.json',
    ...[1, 2, 3].flatMap((version) =>
      ['finish', 'prepare', 'step'].flatMap((operation) =>
        ['request', 'response'].map(
          (direction) =>
            `${version < 3 ? 'audit-standard' : 'standard'}-v${version}-${operation}-${direction}.schema.json`
        )
      )
    ),
  ].map((name) => [name, readFileSync(resolve(INTEGRATION, 'contracts', name))])
)
const PROVENANCE_PREFIX = 'integrations/engram/managed-simulation/contracts/'
const HISTORICAL_V1_INDEX = Buffer.from(
  '{"schema_version":"crebain.real-nest-closed-loop-evidence-index.v1"}\n'
)

function contractProvenance() {
  const copies = [...CONTRACT_PAYLOADS].map(([name, payload]) => {
    const match = name.match(
      /^(?:audit-)?standard-v([123])-(finish|prepare|step)-(request|response)\.schema\.json$/u
    )
    const schemaId =
      name === 'managed-runtime-ipc.schema.json'
        ? 'engram.managed-runtime-ipc.v1'
        : `engram.closed-loop-simulator.${match[2]}-${match[3]}.v${match[1]}`
    return {
      schema_id: schemaId,
      source_path: `integrations/contracts/${schemaId}.schema.json`,
      destination_path: `${PROVENANCE_PREFIX}${name}`,
      sha256: createHash('sha256').update(payload).digest('hex'),
      git_mode: '100644',
      git_blob: '1'.repeat(40),
      runtime_role: name.startsWith('audit-standard-') ? 'audit-only' : 'runnable',
    }
  })
  return {
    schema_version: 'crebain.contract-provenance.v2',
    source: {
      repository: 'git@example.invalid:engram.git',
      commit: '2'.repeat(40),
      tree: '3'.repeat(40),
      origin_main: '2'.repeat(40),
      object_format: 'sha1',
      clean: true,
    },
    copies,
    generation: {
      policy: 'clean-head-equals-local-origin-main-git-blob-copy.v1',
      copy_count: copies.length,
    },
    authority: 'compatibility-copy-only',
  }
}
function changed(value) {
  return structuredClone(value)
}

function expectFailure(name, action, expected) {
  let message = ''
  try {
    action()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (!message.includes(expected)) throw new Error(`${name}: expected ${expected}; got ${message}`)
}

assertContractGateBoundary(PACKAGE)
const debugBinaryGate = changed(PACKAGE)
debugBinaryGate.scripts['check:managed-simulation-contract'] = debugBinaryGate.scripts[
  'check:managed-simulation-contract'
].replace('target/release/crebain-managed-simulation', 'target/debug/crebain-managed-simulation')
expectFailure(
  'contract-gate-debug-binary',
  () => assertContractGateBoundary(debugBinaryGate),
  'exact release binary'
)

function mutateV2Capture(count, mutate) {
  const fixture = makeV2EvidenceFixture(ROOT)
  const row = fixture.index.captures.find((candidate) => candidate.drone_count === count)
  const capture = JSON.parse(fixture.captures.get(row.path))
  mutate(capture, fixture.index)
  const payload = exactBytes(capture)
  fixture.captures.set(row.path, payload)
  row.capture_sha256 = sha256(payload)
  fixture.indexBytes = exactBytes(fixture.index)
  return fixture
}

function assertV2Fixture(fixture) {
  assertOperationalEvidence(fixture.indexBytes, fixture.captures, fixture.context)
}

expectFailure(
  'network-dependency',
  () =>
    assertCrateBoundary(
      MANIFEST_SOURCE.replace('[dependencies]', '[dependencies]\nreqwest = "0.12"'),
      SOURCES,
      readdirSync(CRATE)
    ),
  'runtime dependencies'
)
const unsafeSources = new Map(SOURCES)
unsafeSources.set('protocol.rs', `${unsafeSources.get('protocol.rs')}\nunsafe { abort() }`)
expectFailure(
  'unsafe-source',
  () => assertCrateBoundary(MANIFEST_SOURCE, unsafeSources, readdirSync(CRATE)),
  'forbidden capability'
)
const includedNetworkSources = new Map(SOURCES)
includedNetworkSources.set(
  '../../../src/sensor_fusion.rs',
  `${includedNetworkSources.get('../../../src/sensor_fusion.rs')}\nstd::net::TcpStream::connect("localhost");`
)
expectFailure(
  'source-included-network',
  () => assertCrateBoundary(MANIFEST_SOURCE, includedNetworkSources, readdirSync(CRATE)),
  'forbidden capability'
)
const groupedFileSources = new Map(SOURCES)
groupedFileSources.set(
  '../../../src/pid_observation.rs',
  `${groupedFileSources.get('../../../src/pid_observation.rs')}\nuse std::{fs};\nfs::read("hostile");`
)
expectFailure(
  'source-included-grouped-file-import',
  () => assertCrateBoundary(MANIFEST_SOURCE, groupedFileSources, readdirSync(CRATE)),
  'forbidden capability'
)
const missingIncludedSource = new Map(SOURCES)
missingIncludedSource.delete('../../../src/pid_observation.rs')
expectFailure(
  'source-include-not-scanned',
  () => assertCrateBoundary(MANIFEST_SOURCE, missingIncludedSource, readdirSync(CRATE)),
  'was not scanned'
)
const nullBlobProvenance = contractProvenance()
nullBlobProvenance.copies[0].git_blob = null
expectFailure(
  'contract-provenance-null-blob',
  () => assertContractProvenance(nullBlobProvenance, CONTRACT_PAYLOADS),
  'copy provenance differs'
)
const originDriftProvenance = contractProvenance()
originDriftProvenance.source.origin_main = '4'.repeat(40)
expectFailure(
  'contract-provenance-origin-drift',
  () => assertContractProvenance(originDriftProvenance, CONTRACT_PAYLOADS),
  'clean-origin binding differs'
)
const objectFormatDriftProvenance = contractProvenance()
objectFormatDriftProvenance.source.object_format = 'sha256'
expectFailure(
  'contract-provenance-object-format-drift',
  () => assertContractProvenance(objectFormatDriftProvenance, CONTRACT_PAYLOADS),
  'clean-origin binding differs'
)
const ncpManifest = changed(MANIFEST)
ncpManifest.ncp.activation_enabled = true
expectFailure('ncp-authority', () => assertManifestBoundary(ncpManifest), 'NCP authority')
const restartManifest = changed(MANIFEST)
restartManifest.runtime.restart_policy.max_restarts = 1
expectFailure('runtime-restart', () => assertManifestBoundary(restartManifest), 'resource envelope')
const actuationManifest = changed(MANIFEST)
actuationManifest.authority.physical_actuation = true
expectFailure('physical-authority', () => assertManifestBoundary(actuationManifest), 'authority')
const missingAuthorityManifest = changed(MANIFEST)
delete missingAuthorityManifest.authority
expectFailure(
  'missing-authority-roster',
  () => assertManifestBoundary(missingAuthorityManifest),
  'authority roster'
)
const changedTranscript = changed(TRANSCRIPT)
changedTranscript.frames[3].envelope.body.control.channel_ids[0] = 'wrong-channel'
expectFailure(
  'roster-drift',
  () => assertTranscriptBoundary(changedTranscript),
  'run, clock, roster'
)
const nonfiniteTranscript = changed(TRANSCRIPT)
nonfiniteTranscript.frames[3].envelope.body.control.observation_values[0] = null
expectFailure(
  'nonfinite-state',
  () => assertTranscriptBoundary(nonfiniteTranscript),
  'non-finite or wrong-width wire value'
)
const standardSchemaDrift = changed(MANIFEST)
standardSchemaDrift.runtime.operations.find(
  (row) => row.operation_id === 'crebain.simulation.prepare.v3'
).request_schema.schema_sha256 = '0'.repeat(64)
expectFailure(
  'standard-schema-drift',
  () => assertManifestBoundary(standardSchemaDrift),
  'operation roster digest'
)
const relaxedFaultCodeSchemas = new Map(STANDARD_RESPONSE_SCHEMAS)
const relaxedFaultCodeSchemaName = 'standard-v3-step-response.schema.json'
const relaxedFaultCodeSchema = JSON.parse(relaxedFaultCodeSchemas.get(relaxedFaultCodeSchemaName))
relaxedFaultCodeSchema.properties.fault_codes.items.maxLength = 129
relaxedFaultCodeSchemas.set(
  relaxedFaultCodeSchemaName,
  Buffer.from(JSON.stringify(relaxedFaultCodeSchema))
)
expectFailure(
  'standard-fault-code-bound',
  () => assertStandardFaultCodeSchemaBoundary(relaxedFaultCodeSchemas),
  'fault-code length bound'
)
expectFailure(
  'exact-historical-v1-index',
  () => assertOperationalEvidence(HISTORICAL_V1_INDEX, new Map()),
  'release verifier requires evidence index v2; v1 is historical audit-only'
)

{
  const fixture = makeV2EvidenceFixture(ROOT)
  expectFailure(
    'v2-explicit-input-context-required',
    () => assertOperationalEvidence(fixture.indexBytes, fixture.captures),
    'requires explicit operational input context'
  )
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  fixture.index.profile = 'drifted'
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure('v2-index-drift', () => assertV2Fixture(fixture), 'index identity differs')
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  const changedCapture = Buffer.from(fixture.captures.get('capture-3-drones.json'))
  changedCapture[changedCapture.length - 2] ^= 1
  fixture.captures.set('capture-3-drones.json', changedCapture)
  expectFailure('v2-capture-drift', () => assertV2Fixture(fixture), 'v2 capture digest differs')
}

const changedDifferential = new Map(DIFFERENTIAL_ARTIFACTS)
const changedCorpus = Buffer.from(
  changedDifferential.get('engram.managed-runtime-finite-float.v1.json')
)
changedCorpus[changedCorpus.length - 2] ^= 1
changedDifferential.set('engram.managed-runtime-finite-float.v1.json', changedCorpus)
expectFailure(
  'finite-float-corpus-drift',
  () => assertDifferentialArtifacts(changedDifferential),
  'finite-float.v1.json digest drifted'
)

const changedEvidenceSchemas = new Map(EVIDENCE_SCHEMAS)
const changedEvidenceSchemaName = 'real-nest-evidence-index.v2.schema.json'
const changedEvidenceSchema = Buffer.from(changedEvidenceSchemas.get(changedEvidenceSchemaName))
changedEvidenceSchema[changedEvidenceSchema.length - 2] ^= 1
changedEvidenceSchemas.set(changedEvidenceSchemaName, changedEvidenceSchema)
expectFailure(
  'evidence-schema-drift',
  () => assertEvidenceSchemas(changedEvidenceSchemas),
  'real-nest-evidence-index.v2.schema.json digest drifted'
)

assertV2Fixture(makeV2EvidenceFixture(ROOT))

for (const [name, mutate, expected] of [
  [
    'v2-pack-authority-promotion',
    (pack) => {
      pack.authority.execution = true
    },
    'Engram pack source, operation, lineage, claim, or authority differs',
  ],
  [
    'v2-pack-operation-order',
    (pack) => {
      pack.operations.reverse()
    },
    'Engram pack source, operation, lineage, claim, or authority differs',
  ],
  [
    'v2-pack-tool-forgery',
    (pack) => {
      pack.engram_tool.sha256 = 'e'.repeat(64)
    },
    'Engram pack receipt canonical digest differs',
  ],
]) {
  const fixture = mutateV2Capture(1, (capture) =>
    mutate(capture.installed_package_proof.engram_pack_receipt)
  )
  expectFailure(name, () => assertV2Fixture(fixture), expected)
}

{
  const fixture = mutateV2Capture(1, (capture) => {
    const source = capture.engram_source_closure
    const row = source.sources.find(
      (candidate) => candidate.relative_path === 'scripts/engram_extension.py'
    )
    row.sha256 = 'e'.repeat(64)
    capture.engram_source_sha256['scripts/engram_extension.py'] = row.sha256
    reseal(source, 'closure_sha256')
  })
  expectFailure(
    'v2-pack-loaded-source-drift',
    () => assertV2Fixture(fixture),
    'Engram pack tool differs from the loaded committed source closure'
  )
}

for (const [name, mutate, expected] of [
  [
    'v2-index-pack-digest-drift',
    (index) => {
      index.package.engram_pack_receipt_exact_sha256 = 'e'.repeat(64)
    },
    'installed-package proof lineage differs',
  ],
  [
    'v2-index-pack-lineage-false',
    (index) => {
      index.package.build_stage_seal_pack_install_lineage_verified = false
    },
    'installed package identity differs',
  ],
]) {
  const fixture = makeV2EvidenceFixture(ROOT)
  mutate(fixture.index)
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure(name, () => assertV2Fixture(fixture), expected)
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  fixture.indexBytes = Buffer.concat([Buffer.from(' '), fixture.indexBytes])
  expectFailure(
    'v2-index-noncanonical-bytes',
    () => assertV2Fixture(fixture),
    'exact canonical JSON bytes'
  )
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  fixture.indexBytes = Buffer.from(
    fixture.indexBytes
      .toString('utf8')
      .replace('{', '{"schema_version":"crebain.real-nest-closed-loop-evidence-index.v2",')
  )
  expectFailure(
    'v2-index-duplicate-member',
    () => assertV2Fixture(fixture),
    'duplicate JSON member: schema_version'
  )
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  const row = fixture.index.captures[0]
  const duplicate = Buffer.from(
    fixture.captures
      .get(row.path)
      .toString('utf8')
      .replace('{', '{"schema_version":"crebain.real-nest-closed-loop-capture.v2",')
  )
  fixture.captures.set(row.path, duplicate)
  row.capture_sha256 = sha256(duplicate)
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure(
    'v2-capture-duplicate-member',
    () => assertV2Fixture(fixture),
    'duplicate JSON member: schema_version'
  )
}

for (const [name, mutate, expected] of [
  [
    'v2-stale-capture-schema',
    (capture) => {
      capture.schema_version = 'crebain.real-nest-closed-loop-capture.v1'
    },
    'tracked input lineage',
  ],
  [
    'v2-source-path-spoof',
    (capture) => {
      capture.engram_source_closure.sources[0].relative_path = '../backend/example.py'
    },
    'canonical safe POSIX path',
  ],
  [
    'v2-source-control-path-spoof',
    (capture) => {
      capture.engram_source_closure.sources[0].relative_path = 'backend/example.py\nspoof'
    },
    'canonical safe POSIX path',
  ],
  [
    'v2-source-object-format-drift',
    (capture) => {
      capture.engram_source_closure.git.object_format = 'sha256'
    },
    'source closure identity differs',
  ],
  [
    'v2-source-roster-order',
    (capture) => {
      capture.engram_source_closure.sources.reverse()
    },
    'sorted and unique',
  ],
  [
    'v2-source-roster-duplicate',
    (capture) => {
      capture.engram_source_closure.sources[1].relative_path =
        capture.engram_source_closure.sources[0].relative_path
    },
    'sorted and unique',
  ],
  [
    'v2-nested-module-escape',
    (capture) => {
      capture.engram_source_closure.host_modules[0].relative_path = 'backend/absent.py'
    },
    'nested Engram source roster escapes',
  ],
  [
    'v2-nested-module-path-alias',
    (capture) => {
      capture.engram_source_closure.host_modules.push({
        module_name: 'backend.other',
        relative_path: 'backend/example.py',
      })
      capture.engram_source_closure.host_modules.sort((left, right) =>
        `${left.module_name}\0${left.relative_path}`.localeCompare(
          `${right.module_name}\0${right.relative_path}`
        )
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'module names or paths are not unique',
  ],
  [
    'v2-nested-entrypoint-order',
    (capture) => {
      capture.engram_source_closure.exercised_entrypoints.push({
        role: 'aaa-first',
        relative_path: 'backend/example.py',
      })
    },
    'sorted and unique',
  ],
  [
    'v2-nested-entrypoint-path-alias',
    (capture) => {
      capture.engram_source_closure.exercised_entrypoints.push({
        role: 'zzz-secondary',
        relative_path: 'scripts/engram_extension.py',
      })
      capture.engram_source_closure.exercised_entrypoints.sort((left, right) =>
        `${left.role}\0${left.relative_path}`.localeCompare(`${right.role}\0${right.relative_path}`)
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'paths are not unique',
  ],
  [
    'v2-receipt-store-path-spoof',
    (capture) => {
      capture.receipt_store_closure.files[0].relative_path = '../evidence.json'
    },
    'canonical safe POSIX path',
  ],
  [
    'v2-receipt-store-order',
    (capture) => {
      capture.receipt_store_closure.files.reverse()
    },
    'sorted and unique',
  ],
  [
    'v2-worker-guardian-swap',
    (capture) => {
      capture.nest_worker_guardian_closure.worker_pid += 1
    },
    'guardian closure summary',
  ],
  [
    'v2-reviewed-termination-receipt-swap',
    (capture) => {
      capture.reviewed_native_runtime.termination_receipt.child_reaped = false
    },
    'termination receipt canonical digest',
  ],
  [
    'v2-build-source-path-spoof',
    (capture) => {
      capture.installed_package_proof.observed_build_receipt.source.files[0].relative_path =
        '../rust-toolchain.toml'
    },
    'canonical safe POSIX path',
  ],
  [
    'v2-build-source-drift',
    (capture) => {
      capture.installed_package_proof.observed_build_receipt.source.files.find((row) =>
        row.relative_path.endsWith('/lib.rs')
      ).sha256 = 'f'.repeat(64)
    },
    'source roster digest',
  ],
  [
    'v2-embedded-contract-source-omitted',
    (capture) => {
      capture.installed_package_proof.observed_build_receipt.source.files =
        capture.installed_package_proof.observed_build_receipt.source.files.filter(
          (row) => !row.relative_path.endsWith('/configuration.schema.json')
        )
    },
    'lacks required build inputs',
  ],
  [
    'v2-unclassified-build-source',
    (capture) => {
      const files = capture.installed_package_proof.observed_build_receipt.source.files
      files.push({
        ...structuredClone(files.at(-1)),
        relative_path: 'src-tauri/crates/managed-simulation/README.md',
      })
      files.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
    },
    'escapes the managed-simulation build closure',
  ],
  [
    'v2-toolchain-drift',
    (capture) => {
      capture.installed_package_proof.observed_build_receipt.cargo.rust_toolchain = 'stable'
    },
    'toolchain, arguments, profile, target, or environment policy',
  ],
  [
    'v2-wrong-executable-format',
    (capture) => {
      capture.installed_package_proof.observed_build_receipt.output.format = 'elf-64'
    },
    'output identity',
  ],
  [
    'v2-wrong-executable-architecture',
    (capture) => {
      capture.installed_package_proof.observed_build_receipt.output.architecture = 'x86_64'
    },
    'output identity',
  ],
  [
    'v2-stale-installed-proof',
    (capture) => {
      capture.installed_package_proof.schema_version =
        'crebain.standard-v3-installed-binary-proof.v2'
    },
    'installed-binary proof schema',
  ],
  [
    'v2-observed-build-receipt-swap',
    (capture) => {
      const replacement = structuredClone(capture.installed_package_proof.observed_build_receipt)
      replacement.disclosure = 'Different valid observed-build receipt.'
      reseal(replacement)
      capture.installed_package_proof.observed_build_receipt = replacement
    },
    'package-stage build',
  ],
  [
    'v2-package-stage-receipt-swap',
    (capture) => {
      const replacement = structuredClone(capture.installed_package_proof.package_stage_receipt)
      replacement.disclosure = 'Different valid package-stage receipt.'
      reseal(replacement)
      capture.installed_package_proof.package_stage_receipt = replacement
    },
    'Engram pack source, operation, lineage, claim, or authority',
  ],
]) {
  const fixture = mutateV2Capture(2, mutate)
  expectFailure(name, () => assertV2Fixture(fixture), expected)
}

for (const [name, mutate] of [
  [
    'v2-capture-row-missing-key',
    (index) => {
      delete index.captures[0].session_count
    },
  ],
  [
    'v2-capture-row-extra-key',
    (index) => {
      index.captures[0].unexpected = true
    },
  ],
]) {
  const fixture = makeV2EvidenceFixture(ROOT)
  mutate(fixture.index)
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure(name, () => assertV2Fixture(fixture), 'capture row member roster')
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  fixture.index.tool_source_closure.files.find(
    (row) => row.role === 'receipt-validator'
  ).exact_sha256 = 'f'.repeat(64)
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure('v2-tool-source-drift', () => assertV2Fixture(fixture), 'tool source binding')
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  fixture.index.tool_source_closure.files.shift()
  fixture.index.tool_source_closure.roster_sha256 = sha256(
    Buffer.from(canonical(fixture.index.tool_source_closure.files))
  )
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure(
    'v2-tool-source-closure-omission',
    () => assertV2Fixture(fixture),
    'tool source binding'
  )
}

{
  const fixture = makeV2EvidenceFixture(ROOT)
  fixture.index.package.executable_sha256 = 'f'.repeat(64)
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure(
    'v2-index-package-receipt-swap',
    () => assertV2Fixture(fixture),
    'installed-package proof lineage'
  )
}

assertCrateBoundary(MANIFEST_SOURCE, SOURCES, readdirSync(CRATE))
assertContractProvenance(contractProvenance(), CONTRACT_PAYLOADS)
assertDifferentialArtifacts(DIFFERENTIAL_ARTIFACTS)
assertEvidenceSchemas(EVIDENCE_SCHEMAS)
assertManifestBoundary(MANIFEST)
assertStandardFaultCodeSchemaBoundary(STANDARD_RESPONSE_SCHEMAS)
assertTranscriptBoundary(TRANSCRIPT)
assertV2Fixture(makeV2EvidenceFixture(ROOT))
console.log('OK: provider-free managed simulation boundary self-test passed')
