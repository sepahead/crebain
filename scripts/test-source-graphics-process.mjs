import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { controlledModule } from './test-support/source-graphics-module.mjs'
import test from 'node:test'
import {
  encodeSourceJson,
  SOURCE_PLAN_BYTES,
  SOURCE_INPUT_BYTES,
  sourceDigest,
  SourceGraphicsTransferError,
} from './lib/source-graphics-codec.mjs'
import { isGraphicsSourceIntegrityError } from '../src/environment/GraphicsSourceErrors.js'

// These are process-parent state-machine controls with synthetic OS and IPC ports.
// No operating-system process is signaled, and no simulator or browser is executed.
let state
const { OwnedGraphicsProcess } = await controlledModule(
  new URL('./lib/owned-graphics-process.mjs', import.meta.url),
  {
    'node:child_process': {
      fork: (...args) => state.fork(...args),
      execFileSync: (...args) => state.ps(...args),
    },
    playwright: { chromium: { executablePath: () => '/synthetic/chromium' } },
  }
)
const originalKill = process.kill
process.kill = (pid, signal) => {
  assert.equal(pid, -600002, 'Synthetic process test must never signal any real process')
  assert.equal(signal, 'SIGKILL')
  state.signals.push({ pid, signal })
  if (state.signalError) throw state.signalError
  state.browserLive = false
  return true
}

function setup() {
  const current = {
    workerLive: true,
    browserLive: false,
    signals: [],
    operations: [],
    sourceMode: false,
    changedBrowser: false,
    suppressAnnouncement: false,
    prepareError: null,
    failCapture: false,
    signalError: null,
    delays: {},
    closed: false,
  }
  const plan = {
    scene: {
      rgbCameras: [{ id: 'camera', width: 128, height: 128, periodTicks: 1 }],
      thermalCameras: [],
    },
  }
  const planSha256 = sourceDigest(encodeSourceJson(plan, SOURCE_PLAN_BYTES))
  const input = { planSha256, tick: 0, drones: [{ position: [-0, 1, 2] }] }
  const raw = new Uint8Array(65536)
  for (let i = 0; i < raw.length; i++) raw[i] = i % 251
  const digest = sourceDigest(raw)
  const worker = new EventEmitter()
  Object.assign(worker, { pid: 600001, connected: true, stderr: new EventEmitter() })
  worker.kill = (signal) => {
    assert.equal(signal, 'SIGKILL')
    current.workerLive = false
    worker.connected = false
    return true
  }
  worker.send = (request, callback) => {
    callback(null)
    current.operations.push(request.operation)
    void (async () => {
      const delay = current.delays[request.operation] ?? 0
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if (!current.workerLive) return
      let result
      if (request.operation === 'prepare' || request.operation === 'prepare_sources') {
        current.sourceMode = request.operation === 'prepare_sources'
        current.browserLive = true
        if (!current.suppressAnnouncement) worker.emit('message', { kind: 'browser', pid: 600002 })
        if (current.prepareError) {
          worker.emit('error', current.prepareError)
          return
        }
        result = {
          pid: 600002,
          planSha256,
          generation: 'synthetic',
          ...(current.sourceMode ? { sourceRetentionBytes: raw.length } : {}),
        }
      } else if (request.operation === 'capture') result = { aggregate: true }
      else if (request.operation === 'capture_source') {
        if (current.failCapture) {
          worker.emit('message', {
            kind: 'error',
            sequence: request.sequence,
            error: 'selected source failed',
            category: 'acquisition',
          })
          return
        }
        result = {
          schema: 'crebain.private-graphics-source.v1',
          sequence: 1,
          originalSha256: digest,
          receipt: {
            planSha256,
            inputSha256: sourceDigest(encodeSourceJson(input, SOURCE_INPUT_BYTES)),
            tick: 0,
            kind: 'rgb',
            cameraId: 'camera',
            width: 128,
            height: 128,
            rowOrigin: 'bottom-left',
            encoding: 'rgba8-srgb',
            byteLength: raw.length,
          },
        }
      } else if (request.operation === 'read_source') {
        const bytes = raw.slice(request.body.offset, request.body.offset + 32768)
        result = {
          ...request.body,
          bytesBase64: Buffer.from(bytes).toString('base64'),
          chunkSha256: sourceDigest(bytes),
        }
      } else if (request.operation === 'release_source')
        result = { ...request.body, released: true }
      else if (request.operation === 'retire') {
        current.browserLive = false
        result = { retired: true }
      } else throw new Error('Unexpected source operation')
      worker.emit('message', { kind: 'result', sequence: request.sequence, result })
    })().catch((error) => worker.emit('error', error))
  }
  current.fork = (_path, _argv, options) => {
    assert.equal(options.execPath, '/synthetic/node')
    return worker
  }
  current.ps = (command, argv) => {
    assert.equal(command, '/bin/ps')
    assert.equal(argv[0], '-axo')
    const rows = []
    if (current.workerLive)
      rows.push('600001 600000 600000 Wed Sep 23 08:00:00 2026 S /synthetic/node worker')
    if (current.browserLive)
      rows.push(
        `600002 600001 600002 Wed Sep 23 08:00:01 2026 S ${current.changedBrowser ? '/foreign/process' : '/synthetic/chromium --private'}`
      )
    return rows.join('\n')
  }
  state = current
  return { current, plan, input, raw, destination: new Uint8Array(raw.length) }
}
const options = { nodeExecutable: '/synthetic/node', timeoutMs: 1000 }
const selected = { kind: 'rgb', cameraId: 'camera' }

test('opt-in parent copies and releases one original while preserving legacy mode separation', async () => {
  const f = setup()
  const owner = await OwnedGraphicsProcess.prepareSources(
    encodeSourceJson(f.plan, SOURCE_PLAN_BYTES),
    options
  )
  assert.equal(owner.planSha256, f.input.planSha256)
  await assert.rejects(owner.capture('{}'), /aggregate/)
  await owner.captureSourceInto(f.input, selected, f.destination)
  assert.deepEqual(f.destination, f.raw)
  assert.deepEqual(f.current.operations, [
    'prepare_sources',
    'capture_source',
    'read_source',
    'read_source',
    'release_source',
  ])
  await owner.retire()
  await owner.retire()
  assert.equal(f.current.workerLive, false)
  assert.equal(f.current.browserLive, false)
})

test('legacy parent still selects old prepare/capture operations', async () => {
  const f = setup()
  const owner = await OwnedGraphicsProcess.prepare('{}', options)
  await assert.rejects(owner.captureSourceInto(f.input, selected, f.destination), /unavailable/)
  assert.deepEqual(await owner.capture('{}'), { aggregate: true })
  assert.deepEqual(f.current.operations, ['prepare', 'capture'])
  await owner.retire()
})

test('one absolute deadline covers capture and every chunk, and prevents release after exhaustion', async () => {
  const f = setup()
  f.current.delays = { capture_source: 55, read_source: 85 }
  const owner = await OwnedGraphicsProcess.prepareSources(
    encodeSourceJson(f.plan, SOURCE_PLAN_BYTES),
    { ...options, timeoutMs: 200 }
  )
  const error = await owner
    .captureSourceInto(f.input, selected, f.destination)
    .catch((value) => value)
  assert.equal(isGraphicsSourceIntegrityError(error), true)
  assert.equal(f.current.operations.includes('release_source'), false)
  assert.equal(f.current.workerLive, false)
  assert.equal(f.current.browserLive, false)
  assert.deepEqual(f.current.signals, [{ pid: -600002, signal: 'SIGKILL' }])
  await owner.retire()
})

test('actual acquisition category survives only confirmed parent cleanup', async () => {
  const f = setup()
  f.current.failCapture = true
  const owner = await OwnedGraphicsProcess.prepareSources(
    encodeSourceJson(f.plan, SOURCE_PLAN_BYTES),
    options
  )
  const error = await owner
    .captureSourceInto(f.input, selected, f.destination)
    .catch((value) => value)
  assert.ok(error instanceof SourceGraphicsTransferError)
  assert.equal(error.category, 'acquisition')
  assert.equal(isGraphicsSourceIntegrityError(error), false)
  assert.equal(f.current.workerLive, false)
  assert.equal(f.current.browserLive, false)
  assert.equal(f.current.operations.includes('read_source'), false)
  await owner.retire()
})

test('changed browser identity withholds its signal and preserves primary plus unknown cleanup', async () => {
  const f = setup()
  f.current.failCapture = true
  const owner = await OwnedGraphicsProcess.prepareSources(
    encodeSourceJson(f.plan, SOURCE_PLAN_BYTES),
    options
  )
  f.current.changedBrowser = true
  const error = await owner
    .captureSourceInto(f.input, selected, f.destination)
    .catch((value) => value)
  assert.equal(isGraphicsSourceIntegrityError(error), true)
  assert.equal(error.cause.errors[0].category, 'acquisition')
  assert.match(error.cause.errors[1].message, /cleanup unresolved/)
  assert.equal(f.current.signals.length, 0)
  assert.equal(f.current.browserLive, true)
  await assert.rejects(owner.retire(), /cleanup unresolved/)
})

test('pre-yield direct child failure survives successful emergency cleanup', async () => {
  const f = setup()
  const primary = new Error('actual worker channel failed')
  f.current.prepareError = primary
  await assert.rejects(
    OwnedGraphicsProcess.prepareSources(encodeSourceJson(f.plan, SOURCE_PLAN_BYTES), options),
    (error) => {
      assert.equal(isGraphicsSourceIntegrityError(error), true)
      assert.equal(error.cause, primary)
      return true
    }
  )
  assert.equal(f.current.workerLive, false)
  assert.equal(f.current.browserLive, false)
})

test('missing browser announcement never proves cleanup or authorizes a browser signal', async () => {
  const f = setup()
  f.current.suppressAnnouncement = true
  await assert.rejects(
    OwnedGraphicsProcess.prepareSources(encodeSourceJson(f.plan, SOURCE_PLAN_BYTES), options),
    (error) => {
      assert.equal(isGraphicsSourceIntegrityError(error), true)
      assert.match(error.cause.errors[0].message, /independently joined/)
      assert.match(error.cause.errors[1].message, /cleanup unresolved/)
      return true
    }
  )
  assert.equal(f.current.signals.length, 0)
  assert.equal(f.current.browserLive, true)
})

test.after(() => {
  process.kill = originalKill
})
