#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { startPreviewServer, waitForServer } from './preview-server.mjs'

const DEFAULT_BASE_URL = 'http://127.0.0.1:4173'
const BASE_URL = process.env.BASE_URL ?? DEFAULT_BASE_URL
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL
const PAGE_READY_TIMEOUT_MS = 20_000
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
    preview = startPreviewServer(BASE_URL)
    await preview.ready
  }
  await waitForServer(BASE_URL, preview)
  browser = await chromium.launch({
    headless: true,
    ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
  })
  for (const testCase of CASES) {
    preview?.assertRunning()
    await inspectCase(browser, testCase)
    preview?.assertRunning()
  }
  console.log(`OK: responsive browser smoke passed (${CASES.length} viewport/scale cases)`)
} catch (error) {
  if (preview?.diagnostics) process.stderr.write(preview.diagnostics)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  try {
    await browser?.close()
  } finally {
    await preview?.stop()
  }
}
