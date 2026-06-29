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
 * Requires Playwright (not a runtime dep):  npx playwright install chromium
 * Run against a live dev server:            bun run dev   # in another shell
 *                                           node scripts/perf-smoke.mjs
 * Optional env: BASE_URL (default http://localhost:5173), SPLAT (default a light splat).
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const SPLAT = process.env.SPLAT ?? '/splats/bicycle-mini.splat'

// FPS floors (mean over a few seconds). Tune as the renderer evolves; these guard
// against gross regressions (e.g. a per-frame alloc or an N-camera feed re-render).
const THRESHOLDS = { empty: 50, lightSplat: 25, splatWithFeeds: 12 }

const PROBE = `() => {
  const w = window; w.__perf = { t: [] };
  const loop = () => { w.__perf.t.push(performance.now()); if (w.__perf.t.length > 6000) w.__perf.t.shift(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  w.__reset = () => { w.__perf.t = []; };
  w.__fps = () => { const a = w.__perf.t; if (a.length < 5) return { fps: 0, frames: a.length };
    const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
    const mean = d.reduce((s, x) => s + x, 0) / d.length; d.sort((x, y) => x - y);
    return { fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(2), p95: +d[Math.floor(0.95 * d.length)].toFixed(1), frames: d.length }; };
  return true;
}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(page, seconds) {
  await page.evaluate('() => window.__reset()')
  await sleep(seconds * 1000)
  return page.evaluate('() => window.__fps()')
}
async function dropSplat(page, path) {
  await page.evaluate((p) => {
    const url = location.origin + p
    const c = document.querySelector('div[tabindex="0"]')
    const dt = new DataTransfer(); dt.setData('text/plain', url)
    c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, path)
}
async function placeCamera(page, fx, fy) {
  await page.keyboard.press('1')
  await page.evaluate(([x, y]) => {
    const c = document.querySelector('div[tabindex="0"]'); const r = c.getBoundingClientRect()
    c.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true, cancelable: true, view: window }))
  }, [fx, fy])
}

const results = {}
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(BASE_URL, { waitUntil: 'load' })
  await page.evaluate(PROBE)
  await sleep(2000)

  results.empty = await measure(page, 5)
  await dropSplat(page, SPLAT)
  await sleep(8000) // load + auto-frame
  results.lightSplat = await measure(page, 5)

  await placeCamera(page, 0.5, 0.6)
  await placeCamera(page, 0.42, 0.6)
  await page.keyboard.press('v') // feeds on
  await sleep(1000)
  results.splatWithFeeds = await measure(page, 5)
} finally {
  await browser.close()
}

let failed = false
console.log('\nCREBAIN perf smoke:')
for (const [k, floor] of Object.entries(THRESHOLDS)) {
  const r = results[k] || { fps: 0 }
  const ok = r.fps >= floor
  if (!ok) failed = true
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(16)} fps=${r.fps} (floor ${floor})  p95=${r.p95 ?? '-'}ms`)
}
process.exit(failed ? 1 : 0)
