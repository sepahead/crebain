import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { verifyPinnedProductionVendorInstallation } from './production-vendor-boundary.mjs'

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

  static async prepare(planJson, { timeoutMs = 15000, onBrowserProcess = () => {} } = {}) {
    const plan = parseInput(planJson)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error('Graphics watchdog must be between 100 and 60000 milliseconds')
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      throw new Error('Private graphics process groups are not qualified on this platform')
    verifyPinnedProductionVendorInstallation(PROJECT_ROOT)
    const owner = new OwnedGraphicsRuntime()
    owner.#timeoutMs = timeoutMs
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
        owner.#owner = await page.evaluateHandle(async (input) => {
          const { GraphicsOwner } = await import('/src/environment/GraphicsOwner.ts')
          return GraphicsOwner.prepare(input)
        }, plan)
        owner.#diagnostics = {
          generation: owner.#generation,
          pid: owner.#browserServer.process().pid,
          browserVersion: owner.#browser.version(),
          planSha256: await owner.#owner.evaluate((instance) => instance.planSha256),
          graphics: await owner.#owner.evaluate((instance) => instance.runtimeIdentity()),
          distributionScope: 'development-component',
        }
      })
      if (owner.#phase !== 'preparing')
        throw new Error('Retired graphics preparation cannot publish')
      owner.#phase = 'active'
      return owner
    } catch (error) {
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
        this.#browserServer.kill().then(
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

  async retire() {
    this.#phase = 'retired'
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
