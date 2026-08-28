#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
  assertOperationalPublicationState,
  assertStandardFaultCodeSchemaBoundary,
  assertTranscriptBoundary,
  verifyOperationalPublicationRepository,
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
const OPERATIONAL_PUBLICATION_NAMES = [
  'INDEX.json',
  'capture-1-drone.json',
  'capture-2-drones.json',
  'capture-3-drones.json',
]
const OPERATIONAL_EVIDENCE_RELATIVE =
  'integrations/engram/managed-simulation/operational-evidence/real-nest-3.9-v2'
const OPERATIONAL_PUBLICATION_PATHS = OPERATIONAL_PUBLICATION_NAMES.map(
  (name) => `${OPERATIONAL_EVIDENCE_RELATIVE}/${name}`
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

function publicationState() {
  const source = 'a'.repeat(40)
  const publication = 'b'.repeat(40)
  const treeRows = OPERATIONAL_PUBLICATION_PATHS.map((path, index) => ({
    mode: '100644',
    type: 'blob',
    oid: String(index + 1).repeat(40),
    path,
  }))
  return {
    source,
    publication,
    state: {
      object_format: 'sha1',
      repository: 'https://example.invalid/crebain.git',
      repository_root: '/canonical/crebain',
      worktree_root: '/canonical/crebain',
      is_bare_repository: 'false',
      is_inside_work_tree: 'true',
      grafts_absent: true,
      index_flags_sha256: 'd'.repeat(64),
      head: publication,
      origin_main: publication,
      status_hex: '',
      source_type: 'commit',
      publication_type: 'commit',
      source_tree: 'c'.repeat(40),
      publication_tree: 'e'.repeat(40),
      parents: [source],
      diff_rows: treeRows.map((row) => ({
        old_mode: '000000',
        new_mode: '100644',
        old_oid: '0'.repeat(40),
        new_oid: row.oid,
        status: 'A',
        path: row.path,
      })),
      tree_rows: treeRows,
      directory_names: OPERATIONAL_PUBLICATION_NAMES,
      worktree_rows: treeRows.map((row, index) => ({
        path: row.path,
        oid: row.oid,
        size_bytes: index + 1,
        sha256: String(index + 5).repeat(64),
        blob_sha256: String(index + 5).repeat(64),
      })),
    },
  }
}

{
  const fixture = publicationState()
  const sourceRepository = assertOperationalPublicationState(
    fixture.state,
    fixture.source,
    fixture.publication
  )
  if (
    sourceRepository.commit !== fixture.source ||
    sourceRepository.origin_main_at_capture !== fixture.source ||
    sourceRepository.clean_at_capture !== true
  ) {
    throw new Error('two-revision-publication-positive: source projection differs')
  }
}

for (const [name, mutate] of [
  [
    'two-revision-wrong-parent',
    (state) => {
      state.parents = ['d'.repeat(40)]
    },
  ],
  [
    'two-revision-dirty-publication',
    (state) => {
      state.status_hex = '3f3f20'
    },
  ],
  [
    'two-revision-executable-evidence',
    (state) => {
      state.diff_rows[0].new_mode = '100755'
    },
  ],
  [
    'two-revision-extra-diff-row',
    (state) => {
      state.diff_rows.push({
        ...state.diff_rows[0],
        new_oid: '9'.repeat(40),
        path: 'unexpected.txt',
      })
    },
  ],
  [
    'two-revision-worktree-blob-drift',
    (state) => {
      state.worktree_rows[0].blob_sha256 = 'f'.repeat(64)
    },
  ],
]) {
  const fixture = publicationState()
  mutate(fixture.state)
  expectFailure(
    name,
    () => assertOperationalPublicationState(fixture.state, fixture.source, fixture.publication),
    name === 'two-revision-wrong-parent' || name === 'two-revision-dirty-publication'
      ? 'repository identity or direct-parent lineage differs'
      : 'exactly four added 100644 Git blobs'
  )
}

{
  const repository = realpathSync(mkdtempSync(resolve(tmpdir(), 'crebain-publication-git-')))
  const git = (...arguments_) =>
    execFileSync('git', arguments_, { cwd: repository, encoding: 'utf8' }).trim()
  try {
    git('init', '--quiet')
    git('config', 'user.name', 'CREBAIN publication test')
    git('config', 'user.email', 'crebain-publication@example.invalid')
    writeFileSync(resolve(repository, 'source.txt'), 'source\n')
    git('add', '--', 'source.txt')
    git('commit', '--quiet', '-m', 'source C0')
    const source = git('rev-parse', 'HEAD^{commit}')
    const evidenceRoot = resolve(repository, OPERATIONAL_EVIDENCE_RELATIVE)
    mkdirSync(evidenceRoot, { recursive: true })
    for (const name of OPERATIONAL_PUBLICATION_NAMES) {
      writeFileSync(resolve(evidenceRoot, name), `{"fixture":"${name}"}\n`)
    }
    git('add', '--', OPERATIONAL_EVIDENCE_RELATIVE)
    git('commit', '--quiet', '-m', 'evidence C1')
    const publication = git('rev-parse', 'HEAD^{commit}')
    git('remote', 'add', 'origin', 'https://example.invalid/crebain.git')
    git('update-ref', 'refs/remotes/origin/main', publication)

    const verified = verifyOperationalPublicationRepository(repository, source, publication)
    if (verified.sourceRepository.commit !== source) {
      throw new Error('two-revision-git-positive: source commit differs')
    }

    chmodSync(evidenceRoot, 0o777)
    expectFailure(
      'two-revision-git-writable-directory',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'owner-controlled canonical directory'
    )
    chmodSync(evidenceRoot, 0o755)

    const capturePath = resolve(evidenceRoot, 'capture-1-drone.json')
    const captureBytes = readFileSync(capturePath)
    writeFileSync(capturePath, '{"dirty":true}\n')
    expectFailure(
      'two-revision-git-dirty-worktree',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'differs from its Git blob'
    )
    writeFileSync(capturePath, captureBytes)

    unlinkSync(capturePath)
    linkSync(resolve(evidenceRoot, 'INDEX.json'), capturePath)
    expectFailure(
      'two-revision-git-hard-link',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'bounded no-follow regular file'
    )
    unlinkSync(capturePath)
    writeFileSync(capturePath, captureBytes)

    const graftPath = resolve(repository, '.git/info/grafts')
    writeFileSync(graftPath, `${publication} ${'f'.repeat(40)}\n`)
    expectFailure(
      'two-revision-git-graft-override',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'graft override is present'
    )
    unlinkSync(graftPath)

    git('update-index', '--assume-unchanged', '--', 'source.txt')
    expectFailure(
      'two-revision-git-assume-unchanged',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'non-normal file flags'
    )
    git('update-index', '--no-assume-unchanged', '--', 'source.txt')

    git('update-index', '--skip-worktree', '--', 'source.txt')
    expectFailure(
      'two-revision-git-skip-worktree',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'non-normal file flags'
    )
    git('update-index', '--no-skip-worktree', '--', 'source.txt')

    const redirected = realpathSync(mkdtempSync(resolve(tmpdir(), 'crebain-redirected-git-')))
    try {
      git('config', 'core.worktree', redirected)
      expectFailure(
        'two-revision-git-redirected-worktree',
        () => verifyOperationalPublicationRepository(repository, source, publication),
        'worktree root or repository mode differs'
      )
      git('--git-dir', resolve(repository, '.git'), 'config', '--unset', 'core.worktree')
    } finally {
      rmSync(redirected, { recursive: true, force: true })
    }

    unlinkSync(capturePath)
    symlinkSync('INDEX.json', capturePath)
    expectFailure(
      'two-revision-git-symlink',
      () => verifyOperationalPublicationRepository(repository, source, publication),
      'non-regular entry'
    )
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
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
  fixture.index.crebain_source_repository.commit = 'e'.repeat(40)
  fixture.indexBytes = exactBytes(fixture.index)
  expectFailure(
    'v2-crebain-source-revision-drift',
    () => assertV2Fixture(fixture),
    'CREBAIN source repository identity differs'
  )
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
assertV2Fixture(makeV2EvidenceFixture(ROOT, { independentPopulationPrefixOrder: true }))

{
  const fixture = mutateV2Capture(2, (capture) => {
    capture.neural_steps[0].result.proposals[0].channel_id =
      capture.neural_steps[0].result.proposals[1].channel_id
  })
  expectFailure(
    'v2-proposal-wrong-channel-binding',
    () => assertV2Fixture(fixture),
    'step 1 channel topology differs'
  )
}

{
  const fixture = mutateV2Capture(2, (capture) => {
    capture.nest_evidence_bundle.nest_session_readback.population_roster_sha256 = 'e'.repeat(64)
    reseal(capture.nest_evidence_bundle, 'bundle_sha256')
  })
  expectFailure(
    'v2-population-roster-digest-drift',
    () => assertV2Fixture(fixture),
    'NEST topology readback differs'
  )
}

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
    source.source_roster_sha256 = sha256(
      Buffer.concat([
        Buffer.from('crebain.engram-source-roster.v1\0'),
        Buffer.from(canonical(source.sources)),
      ])
    )
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
    'v2-source-roster-digest-drift',
    (capture) => {
      capture.engram_source_closure.source_roster_sha256 = 'e'.repeat(64)
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'Engram source roster digest differs',
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
    'v2-receipt-store-content-address-path-drift',
    (capture) => {
      capture.receipt_store_closure.receipt_artifact_path = `receipts/00/${capture.terminal_receipt.receipt_sha256}.json`
      reseal(capture.receipt_store_closure, 'closure_sha256')
    },
    'receipt-store closure identity differs',
  ],
  [
    'v2-receipt-store-receipt-row-digest-drift',
    (capture) => {
      const store = capture.receipt_store_closure
      store.files.find((row) => row.relative_path === store.receipt_artifact_path).sha256 =
        'e'.repeat(64)
      reseal(store, 'closure_sha256')
    },
    'receipt-store closure identity differs',
  ],
  [
    'v2-receipt-store-writer-lock-omitted',
    (capture) => {
      const store = capture.receipt_store_closure
      store.files = store.files.filter((row) => row.relative_path !== 'writer.lock')
      store.file_count = store.files.length
      store.total_bytes = store.files.reduce((sum, row) => sum + row.size_bytes, 0)
      reseal(store, 'closure_sha256')
    },
    'receipt-store closure identity differs',
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
