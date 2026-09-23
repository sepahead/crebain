import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import test from 'node:test'

// Exact maintained worker bytes run in directly owned Node children with a synthetic runtime.
// This establishes IPC dispatch and child exit only; it runs no browser or simulator.
const runtime = `
import { SourceGraphicsTransferError } from './source-graphics-codec.mjs'
export class OwnedGraphicsRuntime {
  constructor(mode, source) { this.mode = mode; this.source = source }
  static async prepare(text) { return new OwnedGraphicsRuntime(JSON.parse(text).mode, false) }
  static async prepareSources(text) { return new OwnedGraphicsRuntime(JSON.parse(text).mode, true) }
  diagnostics() { return { synthetic: true, sourceMode: this.source } }
  async capture() { if (this.source) throw new Error('aggregate forbidden'); return { aggregate: true } }
  async sourceOperation(operation, body) {
    if (!this.source) throw new Error('source mode required')
    if (this.mode === 'acquisition' || this.mode === 'cleanup') throw new SourceGraphicsTransferError('acquisition', 'synthetic selected acquisition failed')
    return { operation, body }
  }
  async retire() { if (this.mode === 'cleanup') throw new Error('synthetic cleanup unknown') }
}
`

async function childControl(run) {
  const directory = await mkdtemp(join(tmpdir(), 'crebain-source-worker-'))
  const root = new URL('../', import.meta.url)
  const workerRelative = 'scripts/lib/owned-graphics-worker.mjs'
  const roster = [
    workerRelative,
    'scripts/lib/source-graphics-codec.mjs',
    'src/environment/GraphicsSourceErrors.js',
  ]
  const originals = new Map()
  let child
  let stderr = ''
  try {
    for (const relative of roster) {
      const bytes = await readFile(new URL(relative, root))
      originals.set(relative, bytes)
      const path = join(directory, relative)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes, { flag: 'wx' })
    }
    await writeFile(join(directory, 'package.json'), '{"type":"module"}', { flag: 'wx' })
    await writeFile(join(directory, 'scripts/lib/owned-graphics-runtime.mjs'), runtime, {
      flag: 'wx',
    })
    child = fork(join(directory, workerRelative), [], {
      execPath: process.execPath,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    child.stderr.on('data', (bytes) => {
      if (stderr.length < 8192) stderr += String(bytes).slice(0, 8192 - stderr.length)
    })
    const exited = once(child, 'exit')
    let sequence = 0
    async function request(operation, body) {
      const selected = ++sequence
      return await new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message.sequence === selected) {
            cleanup()
            resolve(message)
          }
        }
        const onExit = () => {
          cleanup()
          reject(new Error('Owned test worker exited before reply: ' + stderr))
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('Owned test worker response deadline'))
        }, 3000)
        const cleanup = () => {
          clearTimeout(timer)
          child.off('message', onMessage)
          child.off('exit', onExit)
        }
        child.on('message', onMessage)
        child.on('exit', onExit)
        child.send({ operation, body, sequence: selected, timeoutMs: 1000 }, (error) => {
          if (error) {
            cleanup()
            reject(error)
          }
        })
      })
    }
    await run(request)
    child.disconnect()
    let timer
    try {
      await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Owned test worker exit deadline')), 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    assert.equal(child.signalCode, null)
    for (const [relative, bytes] of originals) {
      assert.deepEqual(await readFile(new URL(relative, root)), bytes)
      assert.deepEqual(await readFile(join(directory, relative)), bytes)
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}

test('real owned worker selects the source route and forwards source operations', async () => {
  await childControl(async (request) => {
    const prepared = await request('prepare_sources', '{"mode":"healthy"}')
    assert.equal(prepared.kind, 'result')
    assert.equal(prepared.result.sourceMode, true)
    for (const operation of ['capture_source', 'read_source', 'release_source']) {
      const body = { sequence: 1, originalSha256: 'a'.repeat(64) }
      const reply = await request(operation, body)
      assert.deepEqual(reply.result, { operation, body })
    }
    assert.deepEqual((await request('retire', null)).result, { retired: true })
  })
})

test('real owned legacy worker preserves aggregate dispatch and rejects source operations', async () => {
  await childControl(async (request) => {
    assert.equal((await request('prepare', '{"mode":"healthy"}')).result.sourceMode, false)
    assert.deepEqual((await request('capture', '{}')).result, { aggregate: true })
    const failure = await request('capture_source', {})
    assert.equal(failure.kind, 'error')
    assert.match(failure.error, /Source graphics worker is not prepared/)
    assert.equal(Object.hasOwn(failure, 'category'), false)
  })
})

test('real owned source worker cannot select aggregate capture', async () => {
  await childControl(async (request) => {
    await request('prepare_sources', '{"mode":"healthy"}')
    const failure = await request('capture', '{}')
    assert.equal(failure.kind, 'error')
    assert.equal(failure.category, 'integrity')
  })
})

for (const [mode, category] of [
  ['acquisition', 'acquisition'],
  ['cleanup', 'integrity'],
]) {
  test(`real owned worker reports ${category} when ${mode} fails`, async () => {
    await childControl(async (request) => {
      await request('prepare_sources', JSON.stringify({ mode }))
      const failure = await request('capture_source', {})
      assert.equal(failure.kind, 'error')
      assert.equal(failure.category, category)
      const later = await request('read_source', {})
      assert.equal(later.kind, 'error')
      assert.match(later.error, /Invalid graphics worker request/)
    })
  })
}
