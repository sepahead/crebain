#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const DEFAULT_BASE_URL = 'http://127.0.0.1:4173'
const BASE_URL = process.env.BASE_URL ?? DEFAULT_BASE_URL
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL
const SERVER_START_TIMEOUT_MS = 20_000
const PAGE_READY_TIMEOUT_MS = 20_000
const PREVIEW_READY_TIMEOUT_MS = 20_000
const SETTLE_MS = 500
const GEOMETRY_TOLERANCE_PX = 1

const CASES = [
  { name: 'large free-layout desktop', width: 1_600, height: 1_200, scale: 1 },
  { name: 'desktop', width: 1_600, height: 1_000, scale: 1 },
  { name: 'minimum', width: 1_024, height: 720, scale: 1 },
  { name: 'minimum at 200 percent', width: 1_024, height: 720, scale: 2 },
]

function fail(message) {
  throw new Error(`Responsive smoke failed: ${message}`)
}

async function waitForServer(url) {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.ok) return
      lastError = new Error(`preview returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`preview did not become ready: ${String(lastError)}`)
}

function startPreviewServer() {
  const url = new URL(BASE_URL)
  const child = spawn(
    'bun',
    ['run', 'preview', '--', '--host', url.hostname, '--port', url.port || '4173', '--strictPort'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  const diagnostics = []
  let previewOutput = ''
  let settleReady
  const ready = new Promise((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('launched preview did not report readiness'))
    }, PREVIEW_READY_TIMEOUT_MS)
    settleReady = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      if (error) reject(error)
      else resolve()
    }
  })
  const retain = (chunk) => {
    const text = String(chunk)
    diagnostics.push(text)
    if (diagnostics.length > 20) diagnostics.shift()
    previewOutput = `${previewOutput}${text}`.slice(-8_192)
    if (/\bLocal:\s+https?:\/\/[^\s]+/u.test(previewOutput)) settleReady()
  }
  child.stdout.on('data', retain)
  child.stderr.on('data', retain)
  child.once('exit', (code, signal) => {
    const outcome =
      signal === null ? `preview exited with code ${String(code)}` : `preview exited on ${signal}`
    settleReady(new Error(outcome))
  })
  return { child, diagnostics, ready }
}

async function stopPreviewServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function exerciseScrollableRegion(page, label) {
  const region = page.getByRole('region', { name: label, exact: true })
  const dimensions = await region.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  if (dimensions.scrollWidth <= dimensions.clientWidth + GEOMETRY_TOLERANCE_PX) return

  await region.focus()
  await region.press('End')
  const atEnd = await region.evaluate((element) => element.scrollLeft)
  if (!(atEnd > 0)) fail(`${label} cannot reach horizontal overflow with End`)
  await region.press('Home')
  const atStart = await region.evaluate((element) => element.scrollLeft)
  if (atStart !== 0) fail(`${label} cannot return to its start with Home`)
}

async function exerciseVerticallyScrollableRegion(page, label) {
  const region = page.getByRole('region', { name: label, exact: true })
  const dimensions = await region.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  if (dimensions.scrollHeight <= dimensions.clientHeight + GEOMETRY_TOLERANCE_PX) return

  await region.focus()
  await region.press('End')
  const atEnd = await region.evaluate((element) => element.scrollTop)
  if (!(atEnd > 0)) fail(`${label} cannot reach vertical overflow with End`)
  await region.press('Home')
  const atStart = await region.evaluate((element) => element.scrollTop)
  if (atStart !== 0) fail(`${label} cannot return to its start with Home`)
}

async function inspectCase(browser, testCase) {
  const context = await browser.newContext({
    viewport: { width: testCase.width, height: testCase.height },
    reducedMotion: 'reduce',
  })
  await context.addInitScript((scale) => {
    localStorage.setItem('crebain-ui-scale', String(scale))
  }, testCase.scale)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: PAGE_READY_TIMEOUT_MS })
    await page.getByRole('region', { name: 'Primary status and controls' }).waitFor()
    await page.waitForTimeout(SETTLE_MS)

    const result = await page.evaluate((tolerance) => {
      const errors = []
      const regions = [...document.querySelectorAll('[role="region"]')]
      const byLabel = (label) =>
        regions.find((element) => element.getAttribute('aria-label') === label) ?? null
      const primary = byLabel('Primary status and controls')
      const status = byLabel('Detection and sensor status')
      const footer = byLabel('Simulation controls and shortcuts')
      const chrome = [primary, status, footer]
      if (chrome.some((element) => element === null)) {
        errors.push('required chrome regions are missing')
        return errors
      }

      if (document.documentElement.scrollWidth > innerWidth + tolerance) {
        errors.push('document has hidden horizontal overflow')
      }
      if (document.documentElement.scrollHeight > innerHeight + tolerance) {
        errors.push('document has hidden vertical overflow')
      }

      for (const element of chrome) {
        const label = element.getAttribute('aria-label') ?? 'unnamed chrome region'
        if (element.scrollHeight > element.clientHeight + tolerance) {
          errors.push(`${label} clips vertically`)
        }
        if (
          element.scrollWidth > element.clientWidth + tolerance &&
          (!['auto', 'scroll'].includes(getComputedStyle(element).overflowX) ||
            element.tabIndex < 0)
        ) {
          errors.push(`${label} has inaccessible horizontal overflow`)
        }
      }

      const footerTop = footer.getBoundingClientRect().top
      const statusBottom = status.getBoundingClientRect().bottom
      const overlayRail = document.querySelector('[data-viewer-overlay-rail]')
      if (overlayRail === null) {
        errors.push('viewer overlay rail is missing')
      } else if (document.documentElement.dataset.uiLayout === 'docked') {
        const railRect = overlayRail.getBoundingClientRect()
        const railStyle = getComputedStyle(overlayRail)
        if (
          railRect.left < -tolerance ||
          railRect.right > innerWidth + tolerance ||
          railRect.top < statusBottom - tolerance ||
          railRect.bottom > footerTop + tolerance
        ) {
          errors.push('viewer overlay rail leaves the usable viewport')
        }
        if (
          overlayRail.scrollHeight > overlayRail.clientHeight + tolerance &&
          (!['auto', 'scroll'].includes(railStyle.overflowY) || overlayRail.tabIndex < 0)
        ) {
          errors.push('viewer overlay rail has inaccessible vertical overflow')
        }

        const overlays = [...overlayRail.querySelectorAll(':scope > [data-viewer-overlay]')]
        for (let left = 0; left < overlays.length; left += 1) {
          const a = overlays[left].getBoundingClientRect()
          for (let right = left + 1; right < overlays.length; right += 1) {
            const b = overlays[right].getBoundingClientRect()
            if (
              a.left < b.right - tolerance &&
              a.right > b.left + tolerance &&
              a.top < b.bottom - tolerance &&
              a.bottom > b.top + tolerance
            ) {
              errors.push('viewer information overlays overlap inside the docked rail')
            }
          }
        }
      } else if (overlayRail.hasAttribute('role') || overlayRail.hasAttribute('tabindex')) {
        errors.push('free-layout overlay wrapper creates an invisible keyboard stop')
      }
      const panels = [...document.querySelectorAll('[data-floating-panel]')].map((element) => ({
        id: element.getAttribute('data-floating-panel') ?? 'unknown',
        element,
        rect: element.getBoundingClientRect(),
      }))
      for (const panel of panels) {
        const style = getComputedStyle(panel.element)
        if (
          panel.rect.left < -tolerance ||
          panel.rect.right > innerWidth + tolerance ||
          panel.rect.top < statusBottom - tolerance ||
          panel.rect.bottom > footerTop + tolerance
        ) {
          errors.push(`${panel.id} panel leaves the usable viewport`)
        }
        if (
          panel.element.scrollHeight > panel.element.clientHeight + tolerance &&
          (!['auto', 'scroll'].includes(style.overflowY) || panel.element.tabIndex < 0)
        ) {
          errors.push(`${panel.id} panel has inaccessible vertical overflow`)
        }
      }

      for (let left = 0; left < panels.length; left += 1) {
        for (let right = left + 1; right < panels.length; right += 1) {
          const a = panels[left]
          const b = panels[right]
          if (
            a.rect.left < b.rect.right - tolerance &&
            a.rect.right > b.rect.left + tolerance &&
            a.rect.top < b.rect.bottom - tolerance &&
            a.rect.bottom > b.rect.top + tolerance
          ) {
            errors.push(`${a.id} and ${b.id} panels overlap`)
          }
        }
      }

      const performanceButton = document.querySelector('[data-performance-header] button')
      const performanceStatus = document.querySelector('[data-performance-status]')
      if (performanceButton && performanceStatus) {
        const a = performanceButton.getBoundingClientRect()
        const b = performanceStatus.getBoundingClientRect()
        if (
          a.left < b.right - tolerance &&
          a.right > b.left + tolerance &&
          a.top < b.bottom - tolerance &&
          a.bottom > b.top + tolerance
        ) {
          errors.push('performance title and backend status overlap')
        }
      }
      return errors
    }, GEOMETRY_TOLERANCE_PX)

    if (pageErrors.length > 0) fail(`${testCase.name}: page error: ${pageErrors.join('; ')}`)
    if (result.length > 0) fail(`${testCase.name}: ${result.join('; ')}`)

    await exerciseScrollableRegion(page, 'Primary status and controls')
    await exerciseScrollableRegion(page, 'Detection and sensor status')
    await exerciseScrollableRegion(page, 'Simulation controls and shortcuts')
    const isDocked = await page.evaluate(
      () => document.documentElement.dataset.uiLayout === 'docked'
    )
    if (isDocked) {
      await exerciseVerticallyScrollableRegion(page, 'Viewer information overlays')
    }
  } finally {
    await context.close()
  }
}

let preview
let browser
try {
  if (process.env.BASE_URL === undefined) {
    preview = startPreviewServer()
    await preview.ready
  }
  await waitForServer(BASE_URL)
  browser = await chromium.launch({
    headless: true,
    ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
  })
  for (const testCase of CASES) await inspectCase(browser, testCase)
  console.log(`OK: responsive browser smoke passed (${CASES.length} viewport/scale cases)`)
} catch (error) {
  if (preview?.diagnostics.length) process.stderr.write(preview.diagnostics.join(''))
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await browser?.close()
  if (preview) await stopPreviewServer(preview.child)
}
