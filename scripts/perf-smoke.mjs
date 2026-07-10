#!/usr/bin/env node
/**
 * CREBAIN performance smoke test / regression guard.
 *
 * Boots the running dev server in a real browser, measures render frame-time with
 * a requestAnimationFrame probe across scenes (empty → light splat → splat +
 * camera feeds), and fails if FPS regresses below documented thresholds. This is
 * the harness used to find the splat-render + camera-feed lag and verify the
 * round-robin feed + auto-frame + performance-mode fixes.
 *
 * Requires Playwright + hardware WebGL:      bunx playwright install chromium
 * Run against a live dev server:             bun run dev   # in another shell
 *                                            bun run perf:smoke
 * Optional env: BASE_URL (default http://localhost:5173), SPLAT (default a light splat).
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const SPLAT = process.env.SPLAT ?? '/splats/bicycle-mini.splat'

// FPS floors (mean over a few seconds). Tune as the renderer evolves; these guard
// against gross regressions (e.g. a per-frame alloc or an N-camera feed re-render).
const THRESHOLDS = { empty: 50, lightSplat: 25, splatWithFeeds: 12 }

const VIEWPORT = { width: 1400, height: 900 }
const SAMPLE_SECONDS = 5
const STARTUP_SETTLE_MS = 2_000
const SPLAT_SETTLE_MS = 1_000
const FEED_SETTLE_MS = 1_000
const ACTION_TIMEOUT_MS = 10_000
const NAVIGATION_TIMEOUT_MS = 15_000
const SPLAT_LOAD_TIMEOUT_MS = 20_000
const CLEANUP_TIMEOUT_MS = 5_000
const OVERALL_TIMEOUT_MS = 60_000
const MAX_DIAGNOSTICS = 12
const SOFTWARE_WEBGL_PATTERN = /swiftshader|llvmpipe|software rasterizer/i

const PROBE = () => {
  const w = window
  w.__perf = { t: [] }
  const loop = () => {
    w.__perf.t.push(performance.now())
    if (w.__perf.t.length > 6000) w.__perf.t.shift()
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  w.__reset = () => {
    w.__perf.t = []
  }
  w.__fps = () => {
    const a = w.__perf.t
    if (a.length < 5) return { fps: 0, frames: a.length }
    const d = []
    for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1])
    const mean = d.reduce((sum, frameTime) => sum + frameTime, 0) / d.length
    d.sort((left, right) => left - right)
    return {
      fps: +(1000 / mean).toFixed(1),
      meanMs: +mean.toFixed(2),
      p95: +d[Math.floor(0.95 * d.length)].toFixed(1),
      frames: d.length,
    }
  }
  return true
}

class SmokeTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'SmokeTimeoutError'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withTimeout(label, timeoutMs, operation) {
  let timeout
  const operationPromise = Promise.resolve().then(operation)
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new SmokeTimeoutError(label, timeoutMs)), timeoutMs)
  })

  try {
    return await Promise.race([operationPromise, timeoutPromise])
  } finally {
    clearTimeout(timeout)
  }
}

async function evaluate(page, label, pageFunction, argument) {
  return withTimeout(label, ACTION_TIMEOUT_MS, () => page.evaluate(pageFunction, argument))
}

function assertSample(label, sample) {
  if (
    typeof sample !== 'object' ||
    sample === null ||
    !Number.isFinite(sample.fps) ||
    !Number.isInteger(sample.frames)
  ) {
    throw new Error(`${label} returned invalid frame statistics`)
  }
  return sample
}

async function measure(page, label) {
  await evaluate(page, `reset ${label} sample`, () => window.__reset())
  await sleep(SAMPLE_SECONDS * 1000)
  const sample = await evaluate(page, `collect ${label} sample`, () => window.__fps())
  return assertSample(label, sample)
}

async function dropSplat(page, path) {
  await evaluate(
    page,
    'drop splat asset',
    (splatPath) => {
      const dropTarget = document.querySelector('div[tabindex="0"]')
      if (!(dropTarget instanceof HTMLElement)) {
        throw new Error('3D viewer drop target was not found')
      }

      const url = new URL(splatPath, location.href).href
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/plain', url)
      dropTarget.dispatchEvent(
        new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true })
      )
    },
    path
  )

  const loadingIndicator = page.locator('[aria-busy="true"]')
  await withTimeout('start splat load', ACTION_TIMEOUT_MS, () =>
    loadingIndicator.waitFor({ state: 'attached', timeout: ACTION_TIMEOUT_MS })
  )
  await withTimeout('finish splat load', SPLAT_LOAD_TIMEOUT_MS, () =>
    loadingIndicator.waitFor({ state: 'detached', timeout: SPLAT_LOAD_TIMEOUT_MS })
  )

  const expectedMessage = `GELADEN: ${String(path).split('/').pop() || 'Asset'}`
  await withTimeout('confirm splat load', ACTION_TIMEOUT_MS, () =>
    page
      .getByText(expectedMessage, { exact: false })
      .last()
      .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
  )
}

async function placeCamera(page, fx, fy) {
  await withTimeout('enable camera placement', ACTION_TIMEOUT_MS, () => page.keyboard.press('1'))
  await evaluate(
    page,
    'place camera',
    ([x, y]) => {
      const viewer = document.querySelector('div[tabindex="0"]')
      if (!(viewer instanceof HTMLElement)) {
        throw new Error('3D viewer was not found')
      }

      const rect = viewer.getBoundingClientRect()
      viewer.dispatchEvent(
        new MouseEvent('click', {
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
          bubbles: true,
          cancelable: true,
          view: window,
        })
      )
    },
    [fx, fy]
  )
}

function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function addDiagnostic(diagnostics, message) {
  diagnostics.push(message)
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift()
}

async function inspectBrowserRuntime(browser, page) {
  const graphics = await evaluate(page, 'inspect WebGL runtime', () => {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!context) return null

    const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: String(
        debugInfo
          ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : context.getParameter(context.RENDERER)
      ),
      vendor: String(
        debugInfo
          ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : context.getParameter(context.VENDOR)
      ),
      version: String(context.getParameter(context.VERSION)),
    }
  })

  if (!graphics) {
    throw new Error('hardware-accelerated WebGL is unavailable')
  }
  if (SOFTWARE_WEBGL_PATTERN.test(graphics.renderer)) {
    throw new Error(
      `hardware-accelerated WebGL is required for the FPS budgets; detected ${graphics.renderer}`
    )
  }

  return { browser: browser.version(), ...graphics }
}

async function runSmoke(results, diagnostics) {
  let browserServer
  let browser
  let closingBrowser = false

  try {
    browserServer = await withTimeout('launch Chromium', NAVIGATION_TIMEOUT_MS, () =>
      // Playwright's `chromium` channel opts into Chrome's full new-headless
      // implementation. The smaller legacy headless shell forces SwiftShader on
      // macOS; Spark's raw `.splat` renderer can wedge that software WebGL path.
      chromium.launchServer({ channel: 'chromium', timeout: NAVIGATION_TIMEOUT_MS })
    )
    browser = await withTimeout('connect to Chromium', ACTION_TIMEOUT_MS, () =>
      chromium.connect(browserServer.wsEndpoint(), { timeout: ACTION_TIMEOUT_MS })
    )
    browser.on('disconnected', () => {
      if (!closingBrowser) addDiagnostic(diagnostics, 'browser: disconnected unexpectedly')
    })

    const page = await withTimeout('create browser page', ACTION_TIMEOUT_MS, () =>
      browser.newPage({ viewport: VIEWPORT })
    )
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        addDiagnostic(diagnostics, `console ${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => addDiagnostic(diagnostics, `page error: ${error.message}`))
    page.on('crash', () => addDiagnostic(diagnostics, 'page: renderer crashed'))

    await withTimeout(`navigate to ${BASE_URL}`, NAVIGATION_TIMEOUT_MS, () =>
      page.goto(BASE_URL, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
    )
    results.runtime = await inspectBrowserRuntime(browser, page)
    await evaluate(page, 'install frame probe', PROBE)
    await sleep(STARTUP_SETTLE_MS)

    results.empty = await measure(page, 'empty')
    await dropSplat(page, SPLAT)
    await sleep(SPLAT_SETTLE_MS)
    results.lightSplat = await measure(page, 'lightSplat')

    await placeCamera(page, 0.5, 0.6)
    await placeCamera(page, 0.42, 0.6)
    await withTimeout('enable camera feeds', ACTION_TIMEOUT_MS, () => page.keyboard.press('v'))
    await sleep(FEED_SETTLE_MS)
    results.splatWithFeeds = await measure(page, 'splatWithFeeds')
  } finally {
    if (browser?.isConnected()) {
      try {
        closingBrowser = true
        await withTimeout('close Chromium', CLEANUP_TIMEOUT_MS, () => browser.close())
      } catch (error) {
        addDiagnostic(diagnostics, formatError(error))
      }
    }
    if (browserServer) {
      try {
        await withTimeout('terminate Chromium process', CLEANUP_TIMEOUT_MS, () =>
          browserServer.kill()
        )
      } catch (error) {
        addDiagnostic(diagnostics, formatError(error))
        if (browserServer.process().exitCode === null) {
          browserServer.process().kill('SIGKILL')
        }
      }
    }
  }
}

const results = {}
const diagnostics = []
let smokeError

try {
  await withTimeout('complete performance smoke', OVERALL_TIMEOUT_MS, () =>
    runSmoke(results, diagnostics)
  )
} catch (error) {
  smokeError = error
}

let failed = smokeError !== undefined
console.log('\nCREBAIN perf smoke:')
if (results.runtime) {
  console.log(`  Browser: ${results.runtime.browser}`)
  console.log(`  WebGL:   ${results.runtime.renderer}`)
}
for (const [key, floor] of Object.entries(THRESHOLDS)) {
  const result = results[key]
  const ok = result !== undefined && result.fps >= floor
  if (!ok) failed = true
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(16)} fps=${result?.fps ?? '-'} (floor ${floor})  p95=${result?.p95 ?? '-'}ms`
  )
}

if (smokeError !== undefined) {
  console.error(`\nSmoke aborted: ${formatError(smokeError)}`)
}
if (diagnostics.length > 0) {
  console.error('\nBrowser diagnostics:')
  for (const diagnostic of diagnostics) console.error(`  ${diagnostic}`)
}

process.exitCode = failed ? 1 : 0

// Each Playwright operation and the whole run are bounded. Keep a final process
// guard as a backstop for failures below the browser protocol/child-process layer.
const forceExit = setTimeout(() => process.exit(process.exitCode ?? 1), CLEANUP_TIMEOUT_MS)
forceExit.unref()
