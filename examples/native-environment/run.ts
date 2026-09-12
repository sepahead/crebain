import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvironmentOwner, observationEnvelopeBytes } from '../../src/environment/EnvironmentOwner'
import type { EnvironmentPlan } from '../../src/environment/EnvironmentState'
import type { ScheduledDynamicsAction } from '../../src/physics/DeterministicDroneWorld'
import { closedKeys } from '../../src/environment/SceneSpec'
import { exactJson } from '../../src/environment/ExactJson'
import type { OwnedGraphicsProcess } from '../../scripts/lib/owned-graphics-process.mjs'

// A bounded engineering export. This example does not implement Prisoma's commit contract.
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_EXPORT_BYTES = 128 * 1024 * 1024
const TERMINAL_BYTES = 16 * 1024
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [inputPath, outputPath, nodeExecutable] = process.argv.slice(2)
if (
  !inputPath ||
  !outputPath ||
  (process.argv.length !== 4 && process.argv.length !== 5) ||
  (nodeExecutable !== undefined && !isAbsolute(nodeExecutable))
)
  throw new Error(
    'Usage: bun examples/native-environment/run.ts PLAN_JSON NEW_OUTPUT_DIRECTORY [ABSOLUTE_NODE_EXECUTABLE]'
  )
const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
async function files(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) paths.push(...(await files(resolve(directory, item.name))))
    else if (item.isFile()) paths.push(resolve(directory, item.name))
  }
  return paths
}
const sourcePaths = [
  ...(await files(resolve(root, 'src'))),
  ...(await files(resolve(root, 'scripts/lib'))),
  resolve(root, 'examples/native-environment/run.ts'),
  resolve(root, 'package.json'),
  resolve(root, 'bun.lock'),
].sort()
const sourceRoster = []
for (const path of sourcePaths) {
  const bytes = await readFile(path)
  sourceRoster.push({ path: relative(root, path), bytes: bytes.length, sha256: sha256(bytes) })
}
const sourceIdentity = sha256(JSON.stringify(sourceRoster))
const inputFile = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
let inputText: string
let originalInputBytes: Buffer
try {
  const before = await inputFile.stat()
  assert(before.isFile() && before.size > 0 && before.size <= MAX_INPUT_BYTES)
  const bytes = Buffer.alloc(before.size + 1)
  let length = 0
  while (length < bytes.length) {
    const result = await inputFile.read(bytes, length, bytes.length - length)
    if (result.bytesRead === 0) break
    length += result.bytesRead
  }
  const after = await inputFile.stat()
  assert(length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs)
  inputText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  originalInputBytes = Buffer.from(bytes.subarray(0, length))
} finally {
  await inputFile.close()
}
const specification = JSON.parse(inputText) as {
  plan: EnvironmentPlan
  actions: ScheduledDynamicsAction[]
  steps: number
}
closedKeys(specification, ['plan', 'actions', 'steps'])
assert(
  Number.isSafeInteger(specification.steps) &&
    specification.steps >= 1 &&
    specification.steps <= 7200
)
assert(Array.isArray(specification.actions) && specification.actions.length <= 4096)
// The example computes its declared local source inventory. It does not attest loaded code.
specification.plan.sourceIdentity = sourceIdentity
const plan = specification.plan
const effectiveSpecificationJson = `{"plan":${exactJson(plan)},"actions":[${specification.actions.map((action) => exactJson(action)).join(',')}],"steps":${specification.steps}}`
const inputRecord = {
  scope: 'Bounded standalone engineering export; no Prisoma transaction or scientific attestation',
  originalInput: {
    encoding: 'base64',
    sha256: sha256(originalInputBytes),
    bytesBase64: originalInputBytes.toString('base64'),
  },
  effectiveSpecification: {
    encoding: 'json-with-signed-zero',
    sha256: sha256(effectiveSpecificationJson),
    json: effectiveSpecificationJson,
  },
  sourceIdentity,
  sourceRoster,
}
const inputRecordBytes = Buffer.byteLength(`${JSON.stringify(inputRecord, null, 2)}\n`)
let reservedBytes = inputRecordBytes + TERMINAL_BYTES
for (let tick = 1; tick <= specification.steps; tick++) {
  const samples = Math.floor((tick * 16000) / 120) - Math.floor(((tick - 1) * 16000) / 120)
  const rawBytes =
    [...plan.scene.rgbCameras, ...plan.scene.thermalCameras]
      .filter((camera) => tick % camera.periodTicks === 0)
      .reduce((sum, camera) => sum + camera.width * camera.height * 4, 0) +
    plan.scene.microphones.length * samples * 8
  reservedBytes += observationEnvelopeBytes(plan.profile, rawBytes) + 1
}
assert(
  Number.isSafeInteger(reservedBytes) && reservedBytes <= MAX_EXPORT_BYTES,
  'Planned example export exceeds 128 MiB'
)
await mkdir(outputPath, { mode: 0o700 })
let writtenBytes = 0
async function save(name: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  assert(writtenBytes + bytes.length <= MAX_EXPORT_BYTES)
  const file = await open(resolve(outputPath, name), 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
    writtenBytes += bytes.length
  } finally {
    await file.close()
  }
}
await save('input.json', inputRecord)
let owner: EnvironmentOwner | undefined
let graphics: OwnedGraphicsProcess | undefined
let outputFile: Awaited<ReturnType<typeof open>> | undefined
let durableSteps = 0
try {
  owner = await EnvironmentOwner.prepare(
    plan,
    nodeExecutable === undefined
      ? undefined
      : async (json) => {
          const { OwnedGraphicsProcess } =
            await import('../../scripts/lib/owned-graphics-process.mjs')
          graphics = await OwnedGraphicsProcess.prepare(json, { timeoutMs: 30000, nodeExecutable })
          return graphics
        }
  )
  for (const action of specification.actions) owner.schedule(action)
  outputFile = await open(resolve(outputPath, 'observations.jsonl'), 'wx', 0o600)
  for (let tick = 1; tick <= specification.steps; tick++) {
    const handle = await owner.advance()
    const bytes = Buffer.from(`${owner.readObservation(handle)}\n`)
    assert(writtenBytes + bytes.length + TERMINAL_BYTES <= MAX_EXPORT_BYTES)
    await outputFile.writeFile(bytes)
    await outputFile.sync()
    writtenBytes += bytes.length
    durableSteps = tick
    owner.releaseObservation(handle)
  }
  const sourceDrift = []
  for (const row of sourceRoster)
    if (sha256(await readFile(resolve(root, row.path))) !== row.sha256) sourceDrift.push(row.path)
  assert.equal(sourceDrift.length, 0, 'Source changed during this engineering run')
  const diagnostics = graphics?.diagnostics() ?? null
  await owner.retire()
  const status = owner.status()
  await save('result.json', {
    status: 'completed',
    durableSteps,
    owner: status,
    diagnostics,
    sourceIdentity,
    sourceDrift,
  })
  console.log(`Completed ${durableSteps} explicit physics steps. Export: ${resolve(outputPath)}`)
} catch (error) {
  // A failed write does not relabel an accepted physical observation as unexecuted.
  console.error(
    JSON.stringify({
      status: 'incomplete',
      durableSteps,
      owner: owner?.status(),
      failure: owner?.failure(),
      error: String(error),
    })
  )
  process.exitCode = 1
} finally {
  await outputFile?.close()
  await owner?.retire()
}
