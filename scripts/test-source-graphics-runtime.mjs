import assert from 'node:assert/strict'
import { controlledModule } from './test-support/source-graphics-module.mjs'
import test from 'node:test'
import {
  sourceDigest,
  encodeSourceJson,
  SOURCE_PLAN_BYTES,
  SOURCE_INPUT_BYTES,
  SourceGraphicsTransferError,
} from './lib/source-graphics-codec.mjs'

// Execute the maintained runtime control flow with explicitly synthetic browser/server ports.
// No Chromium, GPU, native simulator, or operating-system cleanup claim is made here.
const state = {}
class Acquisition extends Error {}
const { OwnedGraphicsRuntime } = await controlledModule(
  new URL('./lib/owned-graphics-runtime.mjs', import.meta.url),
  {
    playwright: {
      chromium: {
        executablePath: (...args) => state.chromium.executablePath(...args),
        launchServer: (...args) => state.chromium.launchServer(...args),
        connect: (...args) => state.chromium.connect(...args),
      },
    },
    vite: { createServer: (...args) => state.createServer(...args) },
    'node:fs/promises': {
      mkdtemp: (...args) => state.mkdtemp(...args),
      rm: (...args) => state.rm(...args),
    },
    './production-vendor-boundary.mjs': { verifyPinnedProductionVendorInstallation() {} },
    '/src/environment/GraphicsSourceRetention.ts': { GraphicsSourceAcquisitionError: Acquisition },
  }
)

class Handle {
  constructor(value) {
    this.value = value
  }
  evaluate(fn, arg) {
    return fn(this.value, arg)
  }
  async evaluateHandle(fn, arg) {
    return new Handle(await fn(this.value, arg))
  }
  async dispose() {
    state.disposedFrames++
  }
}
function reset() {
  Object.assign(state, {
    killed: 0,
    closed: 0,
    removed: 0,
    disposedFrames: 0,
    selections: [],
    killError: null,
    closeError: null,
    rmError: null,
    gotoError: null,
    captureError: null,
    captureWait: null,
    released: 0,
  })
  const raw = new Uint8Array([1, 2, 3, 4])
  const sourceOwner = {
    planSha256: 'a'.repeat(64),
    capacityBytes: 4,
    runtimeIdentity() {
      return { version: 'synthetic', renderer: 'synthetic', vendor: 'synthetic' }
    },
    async capture(input, source) {
      if (state.captureWait) await state.captureWait
      if (state.captureError) throw state.captureError
      if (source)
        return {
          schema: 'crebain.private-graphics-source.v1',
          sequence: 1,
          originalSha256: sourceDigest(raw),
          receipt: {
            planSha256: this.planSha256,
            inputSha256: sourceDigest(encodeSourceJson(input, SOURCE_INPUT_BYTES)),
            tick: input.tick,
            kind: source.kind,
            cameraId: source.cameraId,
            width: 1,
            height: 1,
            rowOrigin: 'bottom-left',
            encoding: 'rgba8-srgb',
            byteLength: 4,
          },
        }
      return {
        planSha256: this.planSha256,
        inputSha256: 'b'.repeat(64),
        tick: input.tick,
        rowOrigin: 'bottom-left',
        rgb: [{ cameraId: 'rgb', width: 1, height: 1, encoding: 'rgba8-srgb', pixels: raw }],
        thermal: [],
      }
    },
    async read(sequence, originalSha256, offset) {
      return { sequence, originalSha256, offset, bytes: raw, chunkSha256: sourceDigest(raw) }
    },
    release() {
      state.released++
    },
  }
  const page = {
    async goto() {
      if (state.gotoError) throw state.gotoError
    },
    async evaluateHandle(_fn, selection) {
      state.selections.push(selection.sourceMode)
      return new Handle(sourceOwner)
    },
  }
  const server = {
    httpServer: { address: () => ({ port: 12345 }) },
    async listen() {},
    async close() {
      state.closed++
      if (state.closeError) throw state.closeError
    },
  }
  const browserServer = {
    process: () => ({ pid: 34567 }),
    wsEndpoint: () => 'synthetic://private',
    async kill() {
      state.killed++
      if (state.killError) throw state.killError
    },
  }
  const chromium = {
    executablePath: () => '/synthetic/owned-chromium',
    async launchServer() {
      return browserServer
    },
    async connect() {
      return {
        version: () => 'synthetic',
        async newContext() {
          return {
            async route() {},
            async newPage() {
              return page
            },
          }
        },
      }
    },
  }
  Object.assign(state, {
    chromium,
    async createServer() {
      return server
    },
    async mkdtemp() {
      return '/synthetic/owner-private-cache'
    },
    async rm() {
      state.removed++
      if (state.rmError) throw state.rmError
    },
  })
  return { sourceOwner, raw }
}
function setup() {
  return reset()
}
const plan = { profile: 'crebain.owned-force-city-source-graphics.v1' }
const input = {
  planSha256: 'a'.repeat(64),
  tick: 0,
  drones: [{ id: 'drone', position: [-0, 1, 2] }],
}
const source = { kind: 'rgb', cameraId: 'rgb' }
const capture = { inputJson: encodeSourceJson(input, SOURCE_INPUT_BYTES), source }

test('source runtime executes capture/read/release while aggregate selection remains separate', async () => {
  const { raw } = setup()
  let announced
  const owner = await OwnedGraphicsRuntime.prepareSources(
    encodeSourceJson(plan, SOURCE_PLAN_BYTES),
    {
      timeoutMs: 1000,
      onBrowserProcess: (pid) => {
        announced = pid
      },
    }
  )
  assert.equal(announced, 34567)
  assert.deepEqual(state.selections, [true])
  assert.equal(owner.diagnostics().sourceRetentionBytes, 4)
  await assert.rejects(owner.capture('{}'), /aggregate/)
  const lease = await owner.sourceOperation('capture_source', capture)
  const join = { sequence: lease.sequence, originalSha256: lease.originalSha256 }
  const chunk = await owner.sourceOperation('read_source', { ...join, offset: 0 })
  assert.deepEqual(Buffer.from(chunk.bytesBase64, 'base64'), Buffer.from(raw))
  assert.deepEqual(await owner.sourceOperation('release_source', join), { ...join, released: true })
  await owner.retire()
  await owner.retire()
  assert.equal(state.killed, 1)
  assert.equal(state.closed, 1)
  assert.equal(state.removed, 1)
})

test('legacy preparation still selects aggregate capture and rejects individual source operations', async () => {
  const { raw } = setup()
  const owner = await OwnedGraphicsRuntime.prepare('{}', { timeoutMs: 1000 })
  assert.deepEqual(state.selections, [false])
  assert.equal(Object.hasOwn(owner.diagnostics(), 'sourceRetentionBytes'), false)
  await assert.rejects(owner.sourceOperation('capture_source', capture), /unavailable/)
  const result = await owner.capture(JSON.stringify(input))
  assert.deepEqual(Buffer.from(result.rgb[0].bytesBase64, 'base64'), Buffer.from(raw))
  assert.equal(state.disposedFrames, 1)
  await owner.retire()
})

test('actual acquisition error remains a source failure after successful bounded cleanup', async () => {
  setup()
  state.captureError = new Acquisition('selected actual source unavailable')
  const owner = await OwnedGraphicsRuntime.prepareSources('{}', { timeoutMs: 1000 })
  await assert.rejects(
    owner.sourceOperation('capture_source', capture),
    (error) => error instanceof SourceGraphicsTransferError && error.category === 'acquisition'
  )
  assert.equal(state.killed, 1)
  assert.equal(state.closed, 1)
  assert.equal(state.removed, 1)
  await assert.rejects(owner.sourceOperation('capture_source', capture), /unavailable/)
  await owner.retire()
  assert.equal(state.killed, 1)
})

test('malformed browser-source failure cannot select the acquisition category', async () => {
  setup()
  state.captureError = new Error('metadata has changed')
  const owner = await OwnedGraphicsRuntime.prepareSources('{}', { timeoutMs: 1000 })
  await assert.rejects(
    owner.sourceOperation('capture_source', capture),
    (error) => error instanceof SourceGraphicsTransferError && error.category === 'integrity'
  )
  await owner.retire()
})

test('source preparation preserves primary and every cleanup error, and attempts each cleanup', async () => {
  setup()
  const primary = new Error('source construction failed')
  const failures = [
    new Error('browser exit unknown'),
    new Error('server close failed'),
    new Error('cache cleanup failed'),
  ]
  state.gotoError = primary
  ;[state.killError, state.closeError, state.rmError] = failures
  await assert.rejects(OwnedGraphicsRuntime.prepareSources('{}', { timeoutMs: 1000 }), (error) => {
    assert.equal(error.category, 'integrity')
    assert.equal(error.cause.cause, primary)
    assert.equal(error.cause.errors[0], primary)
    assert.deepEqual(error.cause.errors[1].errors, failures)
    return true
  })
  assert.equal(state.killed, 1)
  assert.equal(state.closed, 1)
  assert.equal(state.removed, 1)
})

test('failed retirement remains unresolved after underlying ports later become callable', async () => {
  setup()
  const owner = await OwnedGraphicsRuntime.prepareSources('{}', { timeoutMs: 1000 })
  const primary = new Error('browser retirement unknown')
  state.killError = primary
  const first = await owner.retire().catch((error) => error)
  state.killError = null
  await assert.rejects(owner.retire(), (error) => error === first)
  assert.equal(first.errors[0], primary)
  assert.equal(state.killed, 1)
})

test('retirement while capture waits prevents late publication', async () => {
  setup()
  let resolve
  state.captureWait = new Promise((done) => {
    resolve = done
  })
  const owner = await OwnedGraphicsRuntime.prepareSources('{}', { timeoutMs: 1000 })
  const pending = owner.sourceOperation('capture_source', capture).catch((error) => error)
  await new Promise((done) => setImmediate(done))
  await owner.retire()
  resolve()
  const error = await pending
  assert.match(error.message, /Retired/)
  assert.equal(state.killed, 1)
})
