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
  assertCommonEngramContractSource,
  assertContractProvenance,
  assertContractProvenanceBytes,
  assertDifferentialArtifacts,
  assertEvidenceSchemas,
  assertImportedReceiptSchema,
  assertManagedRuntimeCanonicalObject,
  assertManifestBoundary,
  assertManagedRuntimeUnicode,
  assertNestControllerChain,
  assertNestEvidenceBudget,
  assertNestReceiptSemantics,
  managedRuntimeFloatText,
  managedRuntimeCanonical,
  assertNeuralStepsClosure,
  assertOperationalEvidence,
  assertOperationalPublicationState,
  assertRuntimeReceiptProvenance,
  assertRuntimeReceiptProvenanceBytes,
  assertStandardFaultCodeSchemaBoundary,
  assertTranscriptBoundary,
  assertWorkerGuardianClosure,
  ledgerCanonical,
  ledgerFloatText,
  verifyOperationalPublicationRepository,
} from './check-managed-simulation-boundary.mjs'
import {
  canonical,
  compareText,
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
    'engram.closed-loop-runtime-lifecycle-binding.v1.schema.json',
    'engram.contained-exec-command.v1.schema.json',
    'engram.extension-closed-loop-run-receipt.v2.schema.json',
    'engram.nest-closed-loop-evidence-bundle.v2.schema.json',
    'engram.reviewed-native-development-handshake.v1.schema.json',
    'engram.reviewed-native-development-termination.v1.schema.json',
    'engram-pack-receipt.v1.schema.json',
    'installed-binary-proof.v3.schema.json',
    'observed-build-receipt.v1.schema.json',
    'package-stage-receipt.v1.schema.json',
    'real-nest-capture.v2.schema.json',
    'real-nest-evidence-index.v2.schema.json',
  ].map((name) => [name, readFileSync(resolve(INTEGRATION, 'evidence-schemas', name))])
)
const RUNTIME_RECEIPT_SCHEMA_NAMES = [
  'engram.closed-loop-runtime-lifecycle-binding.v1.schema.json',
  'engram.contained-exec-command.v1.schema.json',
  'engram.extension-closed-loop-run-receipt.v2.schema.json',
  'engram.nest-closed-loop-evidence-bundle.v2.schema.json',
  'engram.reviewed-native-development-handshake.v1.schema.json',
  'engram.reviewed-native-development-termination.v1.schema.json',
]
const RUNTIME_RECEIPT_SCHEMAS = new Map(
  RUNTIME_RECEIPT_SCHEMA_NAMES.map((name) => [name, EVIDENCE_SCHEMAS.get(name)])
)
const RUNTIME_RECEIPT_PROVENANCE_BYTES = readFileSync(
  resolve(INTEGRATION, 'evidence-schemas', 'ENGRAM_RUNTIME_RECEIPT_PROVENANCE.json')
)
const RUNTIME_RECEIPT_PROVENANCE = JSON.parse(RUNTIME_RECEIPT_PROVENANCE_BYTES)
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
const WIRE_PROVENANCE_BYTES = readFileSync(resolve(INTEGRATION, 'contracts', 'PROVENANCE.json'))
const WIRE_PROVENANCE = JSON.parse(WIRE_PROVENANCE_BYTES)
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
    source: structuredClone(WIRE_PROVENANCE.source),
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

if (compareText('\ue000', '\u{1f600}') >= 0 || compareText('\u{1f600}', '\ue000') <= 0) {
  throw new Error('fixture code-point ordering differs across the UTF-16 surrogate boundary')
}
const unicodeCanonical = canonical({ '\u{1f600}': 1, '\ue000': 2 })
if (
  unicodeCanonical.indexOf(JSON.stringify('\ue000')) >
  unicodeCanonical.indexOf(JSON.stringify('\u{1f600}'))
) {
  throw new Error('fixture canonical JSON key order differs across the UTF-16 surrogate boundary')
}

{
  const corpus = JSON.parse(
    DIFFERENTIAL_ARTIFACTS.get('engram.managed-runtime-finite-float.v1.json')
  )
  for (const row of corpus.cases) {
    const value = Buffer.from(row.binary64_be_hex, 'hex').readDoubleBE(0)
    if (row.portable) {
      if (managedRuntimeFloatText(value) !== row.canonical_json) {
        throw new Error(`managed-runtime-float-${row.id}: canonical spelling drifted`)
      }
    } else {
      expectFailure(
        `managed-runtime-float-${row.id}`,
        () => managedRuntimeFloatText(value),
        'portable finite range'
      )
    }
  }
  const randomized = corpus.randomized
  const mask = (1n << 64n) - 1n
  let state = BigInt(`0x${randomized.seed_hex}`)
  let accepted = 0
  const transcript = createHash('sha256')
  for (let index = 0; index < randomized.sample_count; index += 1) {
    state = (state + 0x9e3779b97f4a7c15n) & mask
    let bits = state
    bits = ((bits ^ (bits >> 30n)) * 0xbf58476d1ce4e5b9n) & mask
    bits = ((bits ^ (bits >> 27n)) * 0x94d049bb133111ebn) & mask
    bits = (bits ^ (bits >> 31n)) & mask
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(bits)
    let rendered = 'rejected'
    try {
      rendered = managedRuntimeFloatText(bytes.readDoubleBE(0))
      accepted += 1
    } catch {
      // The frozen transcript records every value outside the portable domain.
    }
    transcript.update(`${bits.toString(16).padStart(16, '0')}:${rendered}\n`)
  }
  if (
    accepted !== randomized.accepted_count ||
    transcript.digest('hex') !== randomized.transcript_sha256
  ) {
    throw new Error('managed-runtime randomized finite-float transcript drifted')
  }
}

{
  const positive = Buffer.from('{"float":100.0,"integer":100,"small":1e-6}\n')
  const document = assertManagedRuntimeCanonicalObject(
    positive,
    'managed-runtime numeric positive control'
  )
  if (document.float !== 100 || document.integer !== 100 || document.small !== 1e-6) {
    throw new Error('managed-runtime numeric positive control changed semantic values')
  }
  expectFailure(
    'managed-runtime-noncanonical-float',
    () =>
      assertManagedRuntimeCanonicalObject(
        Buffer.from('{"float":100.00,"integer":100,"small":1e-6}\n'),
        'managed-runtime numeric negative control'
      ),
    'exact canonical JSON bytes'
  )
}

{
  const allowedControls = Buffer.from('{"text":"tab\\tline\\nreturn\\r"}\n')
  assertManagedRuntimeCanonicalObject(allowedControls, 'managed-runtime Unicode positive control')
  for (const [name, payload] of [
    ['replacement-character', Buffer.from('{"value":"\ufffd"}\n')],
    ['lone-surrogate', Buffer.from('{"value":"\\ud800"}\n')],
    ['bmp-noncharacter', Buffer.from('{"value":"\ufdd0"}\n')],
    ['plane-noncharacter', Buffer.from('{"value":"\u{1fffe}"}\n')],
    ['c1-control', Buffer.from('{"value":"\u0085"}\n')],
    ['disallowed-c0-control', Buffer.from('{"value":"\\u0001"}\n')],
    ['object-key', Buffer.from('{"\\udfff":"value"}\n')],
  ]) {
    expectFailure(
      `managed-runtime-unicode-${name}`,
      () => assertManagedRuntimeCanonicalObject(payload, `managed-runtime Unicode ${name}`),
      'nonportable Unicode'
    )
  }

  let rejected = 0
  const transcript = createHash('sha256')
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    try {
      assertManagedRuntimeUnicode(String.fromCodePoint(codePoint))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('nonportable Unicode')) throw error
      rejected += 1
      transcript.update(`${codePoint.toString(16).padStart(6, '0')}\n`)
    }
  }
  if (
    rejected !== 2177 ||
    transcript.digest('hex') !== '44b006abd64c5264ff2b6a863f4689fb6451cdf819e84eb5f0886cb70399a540'
  ) {
    throw new Error('managed-runtime Unicode domain differs from the frozen Engram b6 roster')
  }
}

{
  const boundaryBits = [
    '0000000000000000',
    '8000000000000000',
    '3eb0c6f7a0b5ed8d',
    '3ee4f8b588e368f1',
    '3f1a36e2eb1c432d',
    '430c6bf526340000',
    '4341c37937e08000',
    '7e37e43c8800759c',
    'fe37e43c8800759c',
  ]
  const randomizedBits = []
  const mask = (1n << 64n) - 1n
  let state = 0xd1ff3e12a9735c47n
  while (randomizedBits.length < 8192) {
    state = (state + 0x9e3779b97f4a7c15n) & mask
    let bits = state
    bits = ((bits ^ (bits >> 30n)) * 0xbf58476d1ce4e5b9n) & mask
    bits = ((bits ^ (bits >> 27n)) * 0x94d049bb133111ebn) & mask
    bits = (bits ^ (bits >> 31n)) & mask
    if (((bits >> 52n) & 0x7ffn) !== 0x7ffn) {
      randomizedBits.push(bits.toString(16).padStart(16, '0'))
    }
  }
  const bitsRoster = [...boundaryBits, ...randomizedBits]
  const pythonProgram = [
    'import json, struct, sys',
    'rows = json.load(sys.stdin)',
    'values = [struct.unpack(">d", bytes.fromhex(row))[0] for row in rows]',
    'json.dump([json.dumps(value, allow_nan=False) for value in values], sys.stdout)',
  ].join('\n')
  const pythonSpellings = JSON.parse(
    execFileSync('python3', ['-c', pythonProgram], {
      input: JSON.stringify(bitsRoster),
      maxBuffer: 2 * 1024 * 1024,
    })
  )
  for (const [index, bits] of bitsRoster.entries()) {
    const bytes = Buffer.from(bits, 'hex')
    const observed = ledgerFloatText(bytes.readDoubleBE(0))
    if (observed !== pythonSpellings[index]) {
      throw new Error(
        `ledger-float-${bits}: Python emitted ${pythonSpellings[index]}; JavaScript emitted ${observed}`
      )
    }
  }
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
  const capture = assertManagedRuntimeCanonicalObject(
    fixture.captures.get(row.path),
    `${count}-drone mutation fixture`
  )
  mutate(capture, fixture.index)
  const payload = Buffer.from(`${managedRuntimeCanonical(capture)}\n`)
  fixture.captures.set(row.path, payload)
  row.capture_sha256 = sha256(payload)
  fixture.indexBytes = exactBytes(fixture.index)
  return fixture
}

function resealReceiptStoreSidecar(capture, key, digestField = undefined) {
  const sidecars = capture.receipt_store_sidecars
  const document = sidecars[key]
  if (digestField !== undefined) reseal(document, digestField)
  reseal(sidecars, 'closure_sha256')
  const pathPrefix = {
    store_metadata: 'store.json',
    finalized_reservation: 'finalized-reservations/',
    observation: 'observations/',
    publication_admission_anchor: 'publication-admission-anchors/',
    publication_authority: 'publication-authorities/',
  }[key]
  const row = capture.receipt_store_closure.files.find((candidate) =>
    pathPrefix.endsWith('/')
      ? candidate.relative_path.startsWith(pathPrefix)
      : candidate.relative_path === pathPrefix
  )
  if (row === undefined) throw new Error(`missing synthetic sidecar row: ${key}`)
  const payload = Buffer.from(canonical(document))
  row.size_bytes = payload.length
  row.sha256 = sha256(payload)
  capture.receipt_store_closure.total_bytes = capture.receipt_store_closure.files.reduce(
    (sum, candidate) => sum + candidate.size_bytes,
    0
  )
  reseal(capture.receipt_store_closure, 'closure_sha256')
}

function assertV2Fixture(fixture) {
  assertOperationalEvidence(fixture.indexBytes, fixture.captures, fixture.context)
}

function guardianFixture(count = 1) {
  const fixture = makeV2EvidenceFixture(ROOT)
  const row = fixture.index.captures.find((candidate) => candidate.drone_count === count)
  return assertManagedRuntimeCanonicalObject(
    fixture.captures.get(row.path),
    `${count}-drone guardian fixture`
  )
}

function resealLedger(document, field = 'receipt_sha256') {
  document[field] = sha256(Buffer.from(ledgerCanonical(document, undefined, undefined, field)))
}

function resealManagedRuntime(document, field) {
  document[field] = sha256(
    Buffer.from(managedRuntimeCanonical(document, undefined, undefined, field))
  )
}

function shiftFloatUlps(value, count) {
  if (!Number.isFinite(value) || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('invalid binary64 ULP shift')
  }
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value, false)
  let bits = view.getBigUint64(0, false)
  bits += value >= 0 ? BigInt(count) : -BigInt(count)
  view.setBigUint64(0, bits, false)
  return view.getFloat64(0, false)
}

function resealGuardianAttempt(capture, mutateAttempt, mutateLifecycle = undefined) {
  const evidence = capture.nest_evidence_bundle
  const attempt = evidence.worker_termination_attempt_receipts.at(-1)
  const lifecycleAttempt = evidence.worker_lifecycle_receipt.termination_attempts.at(-1)
  mutateAttempt(attempt)
  mutateAttempt(lifecycleAttempt)
  resealLedger(attempt)
  resealLedger(lifecycleAttempt)
  evidence.worker_lifecycle_receipt.termination_attempt_roster_sha256 = sha256(
    Buffer.from(ledgerCanonical(evidence.worker_lifecycle_receipt.termination_attempts))
  )
  mutateLifecycle?.(evidence.worker_lifecycle_receipt)
  resealLedger(evidence.worker_lifecycle_receipt)
  capture.nest_worker_guardian_closure.termination_attempt_roster_sha256 = sha256(
    Buffer.from(ledgerCanonical(evidence.worker_termination_attempt_receipts))
  )
  capture.nest_worker_guardian_closure.worker_lifecycle_receipt_sha256 =
    evidence.worker_lifecycle_receipt.receipt_sha256
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
const crossSurfaceDriftProvenance = changed(WIRE_PROVENANCE)
crossSurfaceDriftProvenance.source.commit = 'f'.repeat(40)
crossSurfaceDriftProvenance.source.origin_main = 'f'.repeat(40)
expectFailure(
  'contract-provenance-cross-surface-source-drift',
  () => assertCommonEngramContractSource(crossSurfaceDriftProvenance, RUNTIME_RECEIPT_PROVENANCE),
  'provenance sources differ'
)
const changedWireProvenanceBytes = Buffer.from(WIRE_PROVENANCE_BYTES)
changedWireProvenanceBytes[changedWireProvenanceBytes.length - 2] ^= 1
expectFailure(
  'contract-provenance-exact-byte-drift',
  () => assertContractProvenanceBytes(changedWireProvenanceBytes, CONTRACT_PAYLOADS),
  'provenance digest drifted'
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

{
  const changedProvenance = Buffer.from(RUNTIME_RECEIPT_PROVENANCE_BYTES)
  changedProvenance[changedProvenance.length - 2] ^= 1
  expectFailure(
    'runtime-receipt-provenance-byte-drift',
    () => assertRuntimeReceiptProvenanceBytes(changedProvenance, RUNTIME_RECEIPT_SCHEMAS),
    'runtime-receipt provenance digest drifted'
  )
}

for (const [name, mutate, expected] of [
  [
    'runtime-receipt-provenance-extra-member',
    (provenance) => {
      provenance.unreviewed = false
    },
    'runtime-receipt provenance member roster',
  ],
  [
    'runtime-receipt-provenance-source-member-omission',
    (provenance) => {
      delete provenance.source.tree
    },
    'runtime-receipt provenance source member roster',
  ],
  [
    'runtime-receipt-provenance-source-revision-drift',
    (provenance) => {
      provenance.source.commit = 'f'.repeat(40)
    },
    'immutable source differs',
  ],
  [
    'runtime-receipt-provenance-copy-extra-member',
    (provenance) => {
      provenance.copies[0].unreviewed = false
    },
    'provenance copy 1 member roster',
  ],
  [
    'runtime-receipt-provenance-source-path-drift',
    (provenance) => {
      provenance.copies[0].source_path = 'integrations/contracts/other.schema.json'
    },
    'provenance copy differs',
  ],
  [
    'runtime-receipt-provenance-blob-drift',
    (provenance) => {
      provenance.copies[0].git_blob = 'f'.repeat(40)
    },
    'provenance copy differs',
  ],
  [
    'runtime-receipt-provenance-schema-digest-drift',
    (provenance) => {
      provenance.copies[0].sha256 = 'f'.repeat(64)
    },
    'provenance copy differs',
  ],
  [
    'runtime-receipt-provenance-schema-size-drift',
    (provenance) => {
      provenance.copies[0].size_bytes += 1
    },
    'provenance copy differs',
  ],
  [
    'runtime-receipt-provenance-destination-order-drift',
    (provenance) => {
      const first = provenance.copies[0]
      provenance.copies[0] = provenance.copies[1]
      provenance.copies[1] = first
    },
    'provenance copy differs',
  ],
]) {
  const provenance = changed(RUNTIME_RECEIPT_PROVENANCE)
  mutate(provenance)
  expectFailure(
    name,
    () => assertRuntimeReceiptProvenance(provenance, RUNTIME_RECEIPT_SCHEMAS),
    expected
  )
}

{
  const missingSchema = new Map(RUNTIME_RECEIPT_SCHEMAS)
  missingSchema.delete(RUNTIME_RECEIPT_SCHEMA_NAMES[0])
  expectFailure(
    'runtime-receipt-provenance-schema-roster-omission',
    () => assertRuntimeReceiptProvenance(RUNTIME_RECEIPT_PROVENANCE, missingSchema),
    'runtime-receipt payload roster drift'
  )
}

assertV2Fixture(makeV2EvidenceFixture(ROOT))
assertV2Fixture(makeV2EvidenceFixture(ROOT, { independentPopulationPrefixOrder: true }))

{
  const capture = guardianFixture()
  const evidence = capture.nest_evidence_bundle
  evidence.unreviewed = false
  resealManagedRuntime(evidence, 'bundle_sha256')
  expectFailure(
    'v2-nest-imported-schema-extra-member-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, evidence),
    'unexpected member: unreviewed'
  )
}

{
  const capture = guardianFixture()
  const original = managedRuntimeCanonical(capture.reviewed_native_runtime.handshake_receipt)
  const changedHandshake = original.replace('"generation_ordinal":1', '"generation_ordinal":1.0')
  if (changedHandshake === original) {
    throw new Error('reviewed StrictInt negative control did not change its numeric lexeme')
  }
  const handshake = assertManagedRuntimeCanonicalObject(
    Buffer.from(`${changedHandshake}\n`),
    'reviewed StrictInt-as-float negative control'
  )
  resealLedger(handshake)
  expectFailure(
    'v2-reviewed-strict-int-as-float-resealed',
    () => assertImportedReceiptSchema(handshake, 'handshake', 'reviewed runtime handshake receipt'),
    'generation_ordinal numeric kind differs'
  )
}

{
  const capture = guardianFixture()
  const expectation = capture.nest_evidence_bundle.runtime_launch_expectation
  expectation.core_file_bytes = 1
  resealLedger(expectation)
  expectFailure(
    'v2-nest-launch-literal-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, capture.nest_evidence_bundle),
    'runtime_launch_expectation.core_file_bytes differs from its schema constant'
  )
}

{
  const capture = guardianFixture()
  const work = capture.nest_evidence_bundle.nest_session_readback.work_admission
  work.input_event_work_units += 1
  resealLedger(work)
  expectFailure(
    'v2-nest-work-arithmetic-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, capture.nest_evidence_bundle),
    'work-admission arithmetic, budget, or lineage differs'
  )
}

{
  const capture = guardianFixture()
  const session = capture.nest_evidence_bundle.nest_session_readback
  session.requested_rng_seed += 1
  session.effective_rng_seed += 1
  resealLedger(session)
  expectFailure(
    'v2-nest-session-config-rejoin-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, capture.nest_evidence_bundle),
    'session timing, construction, model, or roster semantics differ'
  )
}

{
  const capture = guardianFixture()
  const execution = capture.nest_evidence_bundle.step_execution_receipts[0]
  const schedule = execution.generator_schedule_readbacks[0]
  schedule.requested_schedule_time_tics += 1
  schedule.effective_schedule_time_tics += 1
  schedule.schedule_api_argument_ms = 0.101
  schedule.effective_schedule_time_ms = 0.101
  execution.generator_schedule_readback_sha256 = sha256(
    Buffer.from(ledgerCanonical(execution.generator_schedule_readbacks))
  )
  resealLedger(execution)
  expectFailure(
    'v2-nest-step-schedule-rejoin-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, capture.nest_evidence_bundle),
    'generator or carrier-weight semantics differ'
  )
}

{
  const capture = guardianFixture()
  const attempt = capture.nest_evidence_bundle.step_attempt_receipts[0]
  attempt.partial_readback_sha256 = 'e'.repeat(64)
  resealLedger(attempt)
  expectFailure(
    'v2-nest-attempt-partial-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, capture.nest_evidence_bundle),
    'attempt semantics differ'
  )
}

{
  const capture = guardianFixture()
  const tail = capture.nest_evidence_bundle.tail_disposition_receipt
  tail.population_tails[0].pending_event_count = 1
  tail.population_tails[0].pending_event_times_sha256 = 'e'.repeat(64)
  tail.total_pending_event_count = 1
  tail.population_tail_roster_sha256 = sha256(Buffer.from(ledgerCanonical(tail.population_tails)))
  resealLedger(tail)
  expectFailure(
    'v2-nest-tail-window-rejoin-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, capture.nest_evidence_bundle),
    'tail disposition semantics differ'
  )
}

{
  const capture = guardianFixture()
  const evidence = capture.nest_evidence_bundle
  const execution = evidence.step_execution_receipts[3]
  const safety = execution.channel_safety_readbacks[0]
  safety.discarded_pending_event_count = Number.MAX_SAFE_INTEGER
  execution.channel_safety_readback_sha256 = sha256(
    Buffer.from(ledgerCanonical(execution.channel_safety_readbacks))
  )
  resealLedger(execution)
  evidence.step_attempt_receipts[3].execution_receipt_sha256 = execution.receipt_sha256
  resealLedger(evidence.step_attempt_receipts[3])
  expectFailure(
    'v2-nest-discarded-recorder-budget-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, evidence),
    'channel-safety semantics differ'
  )
}

{
  const capture = guardianFixture()
  const evidence = capture.nest_evidence_bundle
  const execution = evidence.step_execution_receipts[1]
  const event = execution.population_event_deltas[0]
  event.prior_event_count = 65535
  event.current_event_count = 65535
  event.event_count_delta = 0
  resealLedger(execution)
  evidence.step_attempt_receipts[1].execution_receipt_sha256 = execution.receipt_sha256
  resealLedger(evidence.step_attempt_receipts[1])
  expectFailure(
    'v2-nest-recorder-counter-discontinuity-resealed',
    () => assertNestReceiptSemantics(capture.terminal_receipt, evidence),
    'event-counter semantics differ'
  )
}

expectFailure(
  'v2-nest-evidence-node-budget',
  () =>
    assertNestEvidenceBudget(
      { payload: Array.from({ length: 40000 }, () => null) },
      { estimated_evidence_bundle_bytes: 1000000, estimated_evidence_bundle_nodes: 1000 }
    ),
  'exceeds its admitted byte or node budget'
)

{
  const capture = guardianFixture()
  capture.run_plan.channels[0].action_max = assertManagedRuntimeCanonicalObject(
    Buffer.from('{"values":[10,10.0,10.0]}\n'),
    'run-plan integer-collapse negative control'
  ).values
  expectFailure(
    'v2-run-plan-float-kind-collapse',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'numeric kind differs'
  )
}

{
  const capture = guardianFixture()
  capture.nest_evidence_bundle.worker_runtime_identity.python_version = '3.12.0'
  expectFailure(
    'v2-nest-affine-python-profile-drift',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'configuration chain differs'
  )
}

{
  const capture = guardianFixture()
  const execution = capture.nest_evidence_bundle.step_execution_receipts[0]
  execution.encoded_control_inputs[0].raw_affine_sum = 0.2
  execution.encoded_control_inputs[0].normalized_input = 0.2
  execution.control_encoding_sha256 = sha256(
    Buffer.from(ledgerCanonical(execution.encoded_control_inputs))
  )
  resealLedger(execution)
  expectFailure(
    'v2-nest-affine-controller-rejoin-resealed',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'affine controller encoding differs'
  )
}

for (const [name, field] of [
  ['v2-nest-axis-binding-rejoin-resealed', 'axis_binding_sha256'],
  ['v2-nest-neural-codec-rejoin-resealed', 'neural_codec_sha256'],
]) {
  const capture = guardianFixture()
  const execution = capture.nest_evidence_bundle.step_execution_receipts[0]
  execution.encoded_control_inputs[0][field] = 'e'.repeat(64)
  execution.control_encoding_sha256 = sha256(
    Buffer.from(ledgerCanonical(execution.encoded_control_inputs))
  )
  resealLedger(execution)
  expectFailure(
    name,
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'affine controller encoding differs'
  )
}

{
  const capture = guardianFixture()
  const request = capture.neural_steps[0].request
  request.channels[0].fault_code = 'fabricated-fault'
  resealManagedRuntime(request, 'request_sha256')
  expectFailure(
    'v2-neural-source-fault-rejoin-resealed',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'controller safety chain differs'
  )
}

{
  const capture = guardianFixture()
  const request = capture.neural_steps[3].request
  request.channels[0].hold_required = false
  resealManagedRuntime(request, 'request_sha256')
  expectFailure(
    'v2-neural-source-hold-rejoin-resealed',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'controller safety chain differs'
  )
}

{
  const capture = guardianFixture()
  const request = capture.neural_steps[3].request
  request.channels[0].observation_values[0] = 0.25
  resealManagedRuntime(request, 'request_sha256')
  expectFailure(
    'v2-neural-unavailable-observation-rejoin-resealed',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'controller safety chain differs'
  )
}

{
  const capture = guardianFixture()
  const result = capture.neural_steps[0].result
  result.proposals[0].values[0] += 0.000001
  resealManagedRuntime(result, 'result_sha256')
  expectFailure(
    'v2-nest-proposal-count-rejoin-resealed',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'decoded proposal differs from spike counts'
  )
}

{
  const capture = guardianFixture()
  const result = capture.neural_steps[0].result
  result.proposals[0].values[0] = shiftFloatUlps(result.proposals[0].values[0], 3)
  resealManagedRuntime(result, 'result_sha256')
  expectFailure(
    'v2-nest-proposal-three-ulp-drift-resealed',
    () => assertNestControllerChain(capture, capture.nest_evidence_bundle, 1),
    'decoded proposal differs from spike counts'
  )
}

{
  const capture = guardianFixture()
  assertNeuralStepsClosure(capture, capture.terminal_receipt, capture.nest_evidence_bundle, 1)
}

{
  const capture = guardianFixture()
  const result = capture.neural_steps[0].result
  result.proposals[0].physical_command_authority = true
  resealManagedRuntime(result, 'result_sha256')
  capture.terminal_receipt.steps[0].neural_result_sha256 = result.result_sha256
  capture.terminal_receipt.neural_executions[0].neural_result_sha256 = result.result_sha256
  expectFailure(
    'v2-neural-proposal-authority-like-member',
    () =>
      assertNeuralStepsClosure(capture, capture.terminal_receipt, capture.nest_evidence_bundle, 1),
    'proposal 1 member roster'
  )
}

{
  const capture = guardianFixture()
  delete capture.neural_steps[0].request.source_snapshot_sha256
  expectFailure(
    'v2-neural-request-missing-member',
    () =>
      assertNeuralStepsClosure(capture, capture.terminal_receipt, capture.nest_evidence_bundle, 1),
    'request member roster'
  )
}

{
  const capture = guardianFixture()
  const result = capture.neural_steps[3].result
  result.proposals[0].values = assertManagedRuntimeCanonicalObject(
    Buffer.from('{"values":[0,0,0]}\n'),
    'integer-zero neural vector negative control'
  ).values
  resealManagedRuntime(result, 'result_sha256')
  capture.terminal_receipt.steps[3].neural_result_sha256 = result.result_sha256
  capture.terminal_receipt.neural_executions[3].neural_result_sha256 = result.result_sha256
  expectFailure(
    'v2-neural-integer-zero-float-collapse',
    () =>
      assertNeuralStepsClosure(capture, capture.terminal_receipt, capture.nest_evidence_bundle, 1),
    'proposal contains a non-float JSON value'
  )
}

{
  const capture = guardianFixture()
  resealGuardianAttempt(capture, (attempt) => {
    attempt.anchored_group_kill_delivered = false
  })
  expectFailure(
    'v2-worker-unanchored-containment-claim',
    () =>
      assertWorkerGuardianClosure(
        capture.nest_worker_guardian_closure,
        capture.nest_evidence_bundle,
        capture.engram_source_closure
      ),
    'termination attempt lineage differs'
  )
}

{
  const capture = guardianFixture()
  resealGuardianAttempt(
    capture,
    () => {},
    (lifecycle) => {
      lifecycle.request_count -= 1
      lifecycle.response_count -= 1
    }
  )
  expectFailure(
    'v2-worker-terminal-attempt-projection-drift',
    () =>
      assertWorkerGuardianClosure(
        capture.nest_worker_guardian_closure,
        capture.nest_evidence_bundle,
        capture.engram_source_closure
      ),
    'lifecycle differs from its terminal attempt'
  )
}

{
  const fixture = mutateV2Capture(2, (capture) => {
    capture.neural_steps[0].result.proposals[0].channel_id =
      capture.neural_steps[0].result.proposals[1].channel_id
  })
  expectFailure(
    'v2-proposal-wrong-channel-binding',
    () => assertV2Fixture(fixture),
    'captured neural step 1 result managed-runtime digest differs'
  )
}

{
  const fixture = mutateV2Capture(2, (capture) => {
    capture.nest_evidence_bundle.nest_session_readback.population_roster_sha256 = 'e'.repeat(64)
    resealManagedRuntime(capture.nest_evidence_bundle, 'bundle_sha256')
  })
  expectFailure(
    'v2-population-roster-digest-drift',
    () => assertV2Fixture(fixture),
    'NEST session timing, construction, model, or roster semantics differ'
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
    'Engram pack receipt ledger digest differs',
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
    'nested Engram source closure differs',
  ],
  [
    'v2-nested-module-path-alias',
    (capture) => {
      capture.engram_source_closure.host_modules.push({
        module_name: 'backend.other',
        relative_path: 'backend/example.py',
      })
      capture.engram_source_closure.host_modules.sort((left, right) =>
        compareText(
          `${left.module_name}\0${left.relative_path}`,
          `${right.module_name}\0${right.relative_path}`
        )
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'nested Engram source closure differs',
  ],
  [
    'v2-nested-module-name-path-mismatch',
    (capture) => {
      capture.engram_source_closure.host_modules[0].module_name = 'backend.wrong_name'
      capture.engram_source_closure.host_modules.sort((left, right) =>
        compareText(
          `${left.module_name}\0${left.relative_path}`,
          `${right.module_name}\0${right.relative_path}`
        )
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'nested Engram source closure differs',
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
        compareText(`${left.role}\0${left.relative_path}`, `${right.role}\0${right.relative_path}`)
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'nested Engram source closure differs',
  ],
  [
    'v2-nested-entrypoint-role-substitution',
    (capture) => {
      capture.engram_source_closure.exercised_entrypoints[1].role = 'arbitrary-entrypoint'
      capture.engram_source_closure.exercised_entrypoints.sort((left, right) =>
        compareText(`${left.role}\0${left.relative_path}`, `${right.role}\0${right.relative_path}`)
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'nested Engram source closure differs',
  ],
  [
    'v2-source-roster-unclaimed-superset',
    (capture) => {
      const row = structuredClone(capture.engram_source_closure.sources.at(-1))
      row.relative_path = 'backend/unclaimed.py'
      row.sha256 = '1'.repeat(64)
      row.git_blob = '2'.repeat(row.git_blob.length)
      capture.engram_source_closure.sources.push(row)
      capture.engram_source_closure.sources.sort((left, right) =>
        compareText(left.relative_path, right.relative_path)
      )
      capture.engram_source_sha256 = Object.fromEntries(
        capture.engram_source_closure.sources.map((item) => [item.relative_path, item.sha256])
      )
      capture.engram_source_closure.source_roster_sha256 = sha256(
        Buffer.concat([
          Buffer.from('crebain.engram-source-roster.v1\0'),
          Buffer.from(canonical(capture.engram_source_closure.sources)),
        ])
      )
      reseal(capture.engram_source_closure, 'closure_sha256')
    },
    'nested Engram source closure differs',
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
    'v2-summary-authority-escalation',
    (capture) => {
      capture.summary.authority = true
    },
    'grants generic execution authority',
  ],
  [
    'v2-summary-simulator-scope-contradiction',
    (capture) => {
      capture.summary.simulator_only = false
    },
    'contradicts simulator-only scope',
  ],
  [
    'v2-summary-extra-field',
    (capture) => {
      capture.summary.unreviewed = false
    },
    'closed-loop run summary member roster',
  ],
  [
    'v2-sidecar-observation-authority-escalation',
    (capture) => {
      capture.receipt_store_sidecars.observation.execution_authority = true
      resealReceiptStoreSidecar(capture, 'observation', 'record_sha256')
    },
    'grants or implies non-simulator authority',
  ],
  [
    'v2-sidecar-observation-semantic-drift',
    (capture) => {
      capture.receipt_store_sidecars.observation.run_status = 'failed'
      resealReceiptStoreSidecar(capture, 'observation', 'record_sha256')
    },
    'receipt-store observation lineage differs',
  ],
  [
    'v2-sidecar-finalization-dispatch-drift',
    (capture) => {
      capture.receipt_store_sidecars.finalized_reservation.simulation_dispatch_sha256 = '3'.repeat(
        64
      )
      resealReceiptStoreSidecar(capture, 'finalized_reservation', 'finalization_sha256')
    },
    'receipt-store reservation lineage differs',
  ],
  [
    'v2-sidecar-admission-anchor-wal-drift',
    (capture) => {
      capture.receipt_store_sidecars.publication_admission_anchor.publication_wal_sha256 =
        '4'.repeat(64)
      resealReceiptStoreSidecar(capture, 'publication_admission_anchor', 'anchor_sha256')
    },
    'receipt-store publication authority lineage differs',
  ],
  [
    'v2-sidecar-publication-authority-work-admission-drift',
    (capture) => {
      capture.receipt_store_sidecars.publication_authority.nest_work_admission_sha256 = '5'.repeat(
        64
      )
      resealReceiptStoreSidecar(capture, 'publication_authority', 'authority_sha256')
    },
    'receipt-store publication authority lineage differs',
  ],
  [
    'v2-sidecar-store-metadata-id-drift',
    (capture) => {
      capture.receipt_store_sidecars.store_metadata.store_id = `clrs_${'6'.repeat(64)}`
      resealReceiptStoreSidecar(capture, 'store_metadata')
    },
    'receipt-store reservation lineage differs',
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
    'termination receipt ledger digest differs',
  ],
  [
    'v2-contained-command-missing-field',
    (capture) => {
      delete capture.reviewed_native_runtime.exec_gate_command_binding.argument_shape
    },
    'member roster',
  ],
  [
    'v2-contained-command-unknown-field',
    (capture) => {
      capture.reviewed_native_runtime.exec_gate_command_binding.unreviewed = false
    },
    'member roster',
  ],
  [
    'v2-handshake-missing-field',
    (capture) => {
      delete capture.reviewed_native_runtime.handshake_receipt.path_lookup_at_spawn
    },
    'member roster',
  ],
  [
    'v2-handshake-unknown-field',
    (capture) => {
      capture.reviewed_native_runtime.handshake_receipt.unreviewed = false
    },
    'member roster',
  ],
  [
    'v2-termination-missing-field',
    (capture) => {
      delete capture.reviewed_native_runtime.termination_receipt.containment_signal_scope
    },
    'member roster',
  ],
  [
    'v2-termination-unknown-field',
    (capture) => {
      capture.reviewed_native_runtime.termination_receipt.unreviewed = false
    },
    'member roster',
  ],
  [
    'v2-runtime-lifecycle-missing-field',
    (capture) => {
      delete capture.terminal_receipt.runtime_lifecycle.publisher_authenticated
    },
    'member roster',
  ],
  [
    'v2-runtime-lifecycle-unknown-field',
    (capture) => {
      capture.terminal_receipt.runtime_lifecycle.unreviewed = false
    },
    'member roster',
  ],
  [
    'v2-terminal-receipt-missing-field',
    (capture) => {
      delete capture.terminal_receipt.digest_canonicalization
    },
    'member roster',
  ],
  [
    'v2-terminal-receipt-unknown-field',
    (capture) => {
      capture.terminal_receipt.unreviewed = false
    },
    'member roster',
  ],
  [
    'v2-nest-evidence-missing-field',
    (capture) => {
      delete capture.nest_evidence_bundle.digest_canonicalization
    },
    'member roster',
  ],
  [
    'v2-nest-evidence-unknown-field',
    (capture) => {
      capture.nest_evidence_bundle.unreviewed = false
    },
    'member roster',
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
      files.sort((left, right) => compareText(left.relative_path, right.relative_path))
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

for (const [name, prefix] of [
  ['v2-finalized-reservation-row-forgery', 'finalized-reservations/'],
  ['v2-observation-row-forgery', 'observations/'],
  ['v2-publication-admission-anchor-row-forgery', 'publication-admission-anchors/'],
  ['v2-publication-authority-row-forgery', 'publication-authorities/'],
]) {
  const fixture = mutateV2Capture(2, (capture) => {
    const store = capture.receipt_store_closure
    const row = store.files.find((candidate) => candidate.relative_path.startsWith(prefix))
    row.size_bytes += 1
    row.sha256 = '7'.repeat(64)
    store.total_bytes = store.files.reduce((sum, candidate) => sum + candidate.size_bytes, 0)
    reseal(store, 'closure_sha256')
  })
  expectFailure(name, () => assertV2Fixture(fixture), 'receipt-store closure identity differs')
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
assertContractProvenanceBytes(WIRE_PROVENANCE_BYTES, CONTRACT_PAYLOADS)
assertDifferentialArtifacts(DIFFERENTIAL_ARTIFACTS)
assertEvidenceSchemas(EVIDENCE_SCHEMAS)
assertRuntimeReceiptProvenance(RUNTIME_RECEIPT_PROVENANCE, RUNTIME_RECEIPT_SCHEMAS)
assertRuntimeReceiptProvenanceBytes(RUNTIME_RECEIPT_PROVENANCE_BYTES, RUNTIME_RECEIPT_SCHEMAS)
assertCommonEngramContractSource(WIRE_PROVENANCE, RUNTIME_RECEIPT_PROVENANCE)
assertManifestBoundary(MANIFEST)
assertStandardFaultCodeSchemaBoundary(STANDARD_RESPONSE_SCHEMAS)
assertTranscriptBoundary(TRANSCRIPT)
assertV2Fixture(makeV2EvidenceFixture(ROOT))
console.log('OK: provider-free managed simulation boundary self-test passed')
