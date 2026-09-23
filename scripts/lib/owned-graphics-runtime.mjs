import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { verifyPinnedProductionVendorInstallation } from './production-vendor-boundary.mjs'
import { sourceCleanupFailure } from '../../src/environment/GraphicsSourceErrors.js'
import {
  SOURCE_PLAN_BYTES,
  SOURCE_INPUT_BYTES,
  SourceGraphicsTransferError,
  parseSourceJson,
  closedSourceObject,
  sourceIntegrity,
} from './source-graphics-codec.mjs'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MAX_INPUT_BYTES = 1024 * 1024

function parseInput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INPUT_BYTES)
    throw new Error('Graphics input must be bounded primitive JSON text')
  return JSON.parse(text)
}

/**
 * Development component launcher, not the installed scalar NCP sandbox.
 * Each instance owns one private Chromium process group and private Vite cache.
 */
export class OwnedGraphicsRuntime {
  #server
  #browserServer
  #browser
  #owner
  #cache
  #phase = 'preparing'
  #timeoutMs
  #diagnostics
  #generation = randomUUID()
  #sourceMode = false
  #sourceRetirement = null
  #browserRetirement = null

  static prepare(planJson, options = {}) {
    return OwnedGraphicsRuntime.#prepare(planJson, options, false)
  }

  static prepareSources(planJson, options = {}) {
    return OwnedGraphicsRuntime.#prepare(planJson, options, true)
  }

  static async #prepare(planJson, { timeoutMs = 15000, onBrowserProcess = () => {} }, sourceMode) {
    const plan = sourceMode ? parseSourceJson(planJson, SOURCE_PLAN_BYTES) : parseInput(planJson)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error('Graphics watchdog must be between 100 and 60000 milliseconds')
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      throw new Error('Private graphics process groups are not qualified on this platform')
    verifyPinnedProductionVendorInstallation(PROJECT_ROOT)
    const owner = new OwnedGraphicsRuntime()
    owner.#timeoutMs = timeoutMs
    owner.#sourceMode = sourceMode
    try {
      owner.#cache = await mkdtemp(join(tmpdir(), 'crebain-owned-graphics-'))
      owner.#server = await createServer({
        configFile: false,
        root: PROJECT_ROOT,
        cacheDir: owner.#cache,
        publicDir: false,
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
        plugins: [
          {
            name: 'crebain-private-environment-page',
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                if (request.url !== '/environment-owner') return next()
                response.setHeader('Content-Type', 'text/html')
                response.end(
                  '<!doctype html><html lang="en"><title>Private CREBAIN graphics owner</title><body></body></html>'
                )
              })
            },
          },
        ],
      })
      await owner.#server.listen()
      const address = owner.#server.httpServer.address()
      if (!address || typeof address === 'string')
        throw new Error('Private graphics listener unavailable')
      const origin = `http://127.0.0.1:${address.port}`
      owner.#browserServer = await chromium.launchServer({
        executablePath: chromium.executablePath(),
        headless: true,
        timeout: timeoutMs,
        args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
      })
      onBrowserProcess(owner.#browserServer.process().pid)
      owner.#browser = await chromium.connect(owner.#browserServer.wsEndpoint())
      const context = await owner.#browser.newContext({
        viewport: { width: 32, height: 32 },
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
      })
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort('blockedbyclient')
      )
      const page = await context.newPage()
      await owner.#bounded(async () => {
        await page.goto(`${origin}/environment-owner`)
        owner.#owner = await page.evaluateHandle(
          async ({ input, sourceMode }) => {
            const { GraphicsOwner } = await import('/src/environment/GraphicsOwner.ts')
            if (sourceMode) {
              const { GraphicsSourceRetention } =
                await import('/src/environment/GraphicsSourceRetention.ts')
              return GraphicsSourceRetention.prepare(input, (value) =>
                GraphicsOwner.prepareSources(value)
              )
            }
            return GraphicsOwner.prepare(input)
          },
          { input: plan, sourceMode }
        )
        owner.#diagnostics = {
          generation: owner.#generation,
          pid: owner.#browserServer.process().pid,
          browserVersion: owner.#browser.version(),
          planSha256: await owner.#owner.evaluate((instance) => instance.planSha256),
          graphics: await owner.#owner.evaluate((instance) => instance.runtimeIdentity()),
          distributionScope: 'development-component',
          ...(sourceMode
            ? {
                sourceRetentionBytes: await owner.#owner.evaluate(
                  (instance) => instance.capacityBytes
                ),
              }
            : {}),
        }
      })
      if (owner.#phase !== 'preparing')
        throw new Error('Retired graphics preparation cannot publish')
      owner.#phase = 'active'
      return owner
    } catch (error) {
      if (sourceMode) return owner.#sourceFailure(error)
      await owner.retire()
      throw error
    }
  }

  diagnostics() {
    return structuredClone(this.#diagnostics)
  }

  async #bounded(operation) {
    let timer
    let expired = false
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        this.#phase = 'retired'
        // Playwright's pinned POSIX launcher kills the detached process group with SIGKILL.
        // Reject only after it observes process exit. Merely abandoning the Promise is insufficient.
        this.#killBrowser().then(
          () => reject(new Error('Graphics watchdog expired; owned process group terminated')),
          (cause) =>
            reject(new Error('Graphics watchdog termination could not be confirmed', { cause }))
        )
      }, this.#timeoutMs)
    })
    try {
      const result = await Promise.race([Promise.resolve().then(operation), timeout])
      if (expired || this.#phase === 'retired')
        throw new Error('Retired graphics generation cannot publish')
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async capture(inputJson) {
    if (this.#sourceMode) throw new Error('Individual source mode cannot capture aggregate frames')
    if (this.#phase !== 'active') throw new Error(`Graphics process is ${this.#phase}`)
    const input = parseInput(inputJson)
    this.#phase = 'busy'
    try {
      const result = await this.#bounded(async () => {
        const frames = await this.#owner.evaluateHandle(
          (instance, value) => instance.capture(value),
          input
        )
        try {
          return await frames.evaluate((value) => {
            const encode = (bytes) => {
              let binary = ''
              for (let start = 0; start < bytes.length; start += 8192)
                binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
              return btoa(binary)
            }
            return {
              planSha256: value.planSha256,
              inputSha256: value.inputSha256,
              tick: value.tick,
              rowOrigin: value.rowOrigin,
              rgb: value.rgb.map(({ pixels, ...metadata }) => ({
                ...metadata,
                bytesBase64: encode(pixels),
              })),
              thermal: value.thermal.map(({ radiance, ...metadata }) => {
                const buffer = new ArrayBuffer(radiance.length * 4)
                const view = new DataView(buffer)
                radiance.forEach((sample, index) => view.setFloat32(index * 4, sample, true))
                return {
                  ...metadata,
                  encoding: 'float32-le',
                  bytesBase64: encode(new Uint8Array(buffer)),
                }
              }),
            }
          })
        } finally {
          await frames.dispose()
        }
      })
      if (this.#phase !== 'busy') throw new Error('Retired graphics capture cannot publish')
      this.#phase = 'active'
      return { generation: this.#generation, ...result }
    } catch (error) {
      await this.retire()
      throw error
    }
  }

  async #sourceFailure(primary) {
    try {
      await this.retire()
    } catch (cleanup) {
      throw sourceCleanupFailure(primary, cleanup, 'Source graphics failed with unresolved cleanup')
    }
    throw primary
  }

  #killBrowser() {
    if (!this.#sourceMode) return this.#browserServer.kill()
    this.#browserRetirement ??= this.#browserServer.kill()
    return this.#browserRetirement
  }

  /** These operations exist only for the explicitly selected private source mode. */
  async sourceOperation(operation, body) {
    if (!this.#sourceMode || this.#phase !== 'active')
      throw sourceIntegrity('Individual source runtime is unavailable')
    let value
    if (operation === 'capture_source') {
      closedSourceObject(body, ['inputJson', 'source'])
      value = { input: parseSourceJson(body.inputJson, SOURCE_INPUT_BYTES), source: body.source }
    } else if (operation === 'read_source') {
      value = closedSourceObject(body, ['sequence', 'originalSha256', 'offset'])
    } else if (operation === 'release_source') {
      value = closedSourceObject(body, ['sequence', 'originalSha256'])
    } else throw sourceIntegrity('Unknown individual source operation')
    this.#phase = 'busy'
    try {
      const reply = await this.#bounded(() =>
        this.#owner.evaluate(
          async (instance, request) => {
            const { GraphicsSourceAcquisitionError } =
              await import('/src/environment/GraphicsSourceRetention.ts')
            try {
              const body = request.body
              if (request.operation === 'capture_source')
                return { kind: 'value', value: await instance.capture(body.input, body.source) }
              if (request.operation === 'release_source') {
                instance.release(body.sequence, body.originalSha256)
                return { kind: 'value', value: { ...body, released: true } }
              }
              const chunk = await instance.read(body.sequence, body.originalSha256, body.offset)
              let binary = ''
              for (let offset = 0; offset < chunk.bytes.length; offset += 8192)
                binary += String.fromCharCode(...chunk.bytes.subarray(offset, offset + 8192))
              return {
                kind: 'value',
                value: {
                  sequence: chunk.sequence,
                  originalSha256: chunk.originalSha256,
                  offset: chunk.offset,
                  bytesBase64: btoa(binary),
                  chunkSha256: chunk.chunkSha256,
                },
              }
            } catch (error) {
              // Only this exact local acquisition class can select the source-failure route.
              let message = 'Unprintable private source error'
              try {
                if (typeof error?.message === 'string') message = error.message.slice(0, 256)
              } catch {
                /* Diagnostic only. */
              }
              return {
                kind: 'failure',
                category:
                  error instanceof GraphicsSourceAcquisitionError ? 'acquisition' : 'integrity',
                message,
              }
            }
          },
          { operation, body: value }
        )
      )
      if (this.#phase !== 'busy') throw sourceIntegrity('Retired source runtime cannot publish')
      if (reply?.kind === 'failure') {
        closedSourceObject(reply, ['kind', 'category', 'message'])
        if (typeof reply.message !== 'string' || reply.message.length > 256)
          throw sourceIntegrity('Invalid source failure summary')
        throw new SourceGraphicsTransferError(reply.category, reply.message)
      }
      closedSourceObject(reply, ['kind', 'value'])
      if (reply.kind !== 'value') throw sourceIntegrity('Unknown browser source result')
      this.#phase = 'active'
      return reply.value
    } catch (error) {
      return this.#sourceFailure(error)
    }
  }

  async retire() {
    this.#phase = 'retired'
    if (this.#sourceMode) {
      this.#sourceRetirement ??= (async () => {
        const failures = []
        for (const operation of [
          async () => {
            if (this.#browserServer) await this.#killBrowser()
          },
          async () => {
            if (this.#server) await this.#server.close()
          },
          async () => {
            if (this.#cache) await rm(this.#cache, { recursive: true, force: true })
          },
        ]) {
          try {
            await operation()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length)
          throw new AggregateError(failures, 'Source runtime cleanup unresolved', {
            cause: failures[0],
          })
      })()
      return this.#sourceRetirement
    }
    try {
      if (this.#browserServer) await this.#browserServer.kill()
    } finally {
      try {
        if (this.#server) await this.#server.close()
      } finally {
        if (this.#cache) await rm(this.#cache, { recursive: true, force: true })
      }
    }
  }
}
