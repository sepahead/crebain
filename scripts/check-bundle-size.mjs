#!/usr/bin/env node
/**
 * Bundle-size budget guard.
 *
 * Reads the Vite build manifest and measures the *initial* (eagerly loaded) JS
 * and CSS the browser must download for the entry point, following only static
 * imports. Dynamic imports (rapier physics, the detection Web Worker, optional
 * model backends) are excluded because they load on demand.
 *
 * Fails (exit 1) if the gzipped initial payload exceeds the budget below, so a
 * dependency accidentally pulled into the eager graph is caught in CI.
 *
 * Run after `vite build`:  node scripts/check-bundle-size.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

// Gzipped budget for the initial load (entry + its static import graph).
const BUDGET_BYTES = 700 * 1024

const distDir = join(process.cwd(), 'dist')
const manifestPath = join(distDir, '.vite', 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error(`✖ Manifest not found at ${manifestPath}. Run \`bun run build\` first.`)
  process.exit(1)
}

/** @type {Record<string, { file: string; isEntry?: boolean; imports?: string[]; css?: string[] }>} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry)
if (!entryKey) {
  console.error('✖ No entry chunk found in manifest.')
  process.exit(1)
}

// Collect the entry and everything reachable through STATIC imports only.
const seen = new Set()
const files = new Set()
const queue = [entryKey]
while (queue.length > 0) {
  const key = queue.shift()
  if (!key || seen.has(key)) continue
  seen.add(key)
  const chunk = manifest[key]
  if (!chunk) continue
  files.add(chunk.file)
  for (const css of chunk.css ?? []) files.add(css)
  for (const imp of chunk.imports ?? []) queue.push(imp)
  // NOTE: chunk.dynamicImports is intentionally NOT followed.
}

let total = 0
const rows = []
for (const file of files) {
  const bytes = gzipSync(readFileSync(join(distDir, file))).length
  total += bytes
  rows.push({ file, kb: (bytes / 1024).toFixed(1) })
}

rows.sort((a, b) => Number(b.kb) - Number(a.kb))
console.log('Initial load (gzipped, static import graph only):')
for (const { file, kb } of rows) console.log(`  ${kb.padStart(8)} kB  ${file}`)

const totalKb = (total / 1024).toFixed(1)
const budgetKb = (BUDGET_BYTES / 1024).toFixed(1)
console.log(`  ${'─'.repeat(20)}`)
console.log(`  ${totalKb.padStart(8)} kB  total (budget ${budgetKb} kB)`)

if (total > BUDGET_BYTES) {
  console.error(
    `\n✖ Initial bundle ${totalKb} kB exceeds budget ${budgetKb} kB.\n` +
      `  Move newly-eager dependencies behind a dynamic import(), or raise the\n` +
      `  budget in scripts/check-bundle-size.mjs with justification.`
  )
  process.exit(1)
}
console.log(`\n✓ Initial bundle within budget (${totalKb} / ${budgetKb} kB gzipped).`)
