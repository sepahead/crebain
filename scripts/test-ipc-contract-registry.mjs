#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, verifyRegistry } from './generate-ipc-contract-registry.mjs'

const registry = createRegistry()
if (registry.schema_version !== 2) {
  throw new Error('unexpected IPC registry schema version')
}
if (registry.commands.length !== 23 || registry.events.length !== 2) {
  throw new Error('unexpected IPC registry cardinality')
}
if (registry.commands.some(({ authority }) => authority !== 'none')) {
  throw new Error('0.9.0 IPC command unexpectedly carries authority')
}
if (new Set(registry.commands.map(({ name }) => name)).size !== registry.commands.length) {
  throw new Error('IPC registry contains duplicate command names')
}
if (!registry.events.some(({ name }) => name === 'show-about')) {
  throw new Error('show-about event is missing')
}
if (!registry.events.some(({ kind }) => kind === 'bounded-dynamic-pattern')) {
  throw new Error('bounded transport event pattern is missing')
}
for (const command of ['transport_take_camera_frame', 'transport_ack_camera_frame']) {
  if (!registry.commands.some(({ name }) => name === command)) {
    throw new Error(`bounded camera delivery command is missing: ${command}`)
  }
}
const lifecycleContract = registry.transport_identity_contract?.lifecycle_generation
if (
  lifecycleContract?.wire_encoding !== 'canonical-positive-u64-decimal-string' ||
  lifecycleContract.native_encoding !== 'u64' ||
  lifecycleContract.connect_result_command !== 'transport_connect' ||
  lifecycleContract.camera_ready_event_field !== 'generation'
) {
  throw new Error('lifecycle-generation identity encoding contract is missing')
}
const expectedGenerationInputs = [
  'transport_ack_camera_frame',
  'transport_disconnect',
  'transport_subscribe_camera',
  'transport_subscribe_camera_info',
  'transport_subscribe_imu',
  'transport_subscribe_model_states',
  'transport_subscribe_pose',
  'transport_take_camera_frame',
  'transport_unsubscribe',
]
if (JSON.stringify(lifecycleContract.input_commands) !== JSON.stringify(expectedGenerationInputs)) {
  throw new Error('lifecycle-generation command coverage is incomplete')
}
if (
  !registry.events.some(
    ({ kind, payload }) =>
      kind === 'bounded-dynamic-pattern' &&
      payload.includes('camera-ready') &&
      payload.includes('canonical-positive-u64-decimal-string generation')
  )
) {
  throw new Error('camera-ready descriptor event contract is missing')
}

const directory = mkdtempSync(join(tmpdir(), 'crebain-ipc-registry-'))
try {
  const path = join(directory, 'registry.json')
  const tracked = JSON.parse(readFileSync('docs/baselines/ipc-contract-registry.json', 'utf8'))
  tracked.commands.pop()
  writeFileSync(path, `${JSON.stringify(tracked, null, 2)}\n`)
  let rejected = false
  try {
    verifyRegistry(path)
  } catch (error) {
    rejected = String(error).includes('registry drift')
  }
  if (!rejected) throw new Error('mutated IPC registry was accepted')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('OK: IPC registry self-test rejected cardinality/authority/drift mutations')
