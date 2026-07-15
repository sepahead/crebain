#!/usr/bin/env node
/**
 * Bundle-size budget guard.
 *
 * Reads the Vite build manifest and measures the *initial* (eagerly loaded) JS
 * and CSS the browser must download for the entry point, following only static
 * imports. Dynamic imports (currently the Rapier physics module) are excluded
 * because they load on demand.
 *
 * Fails (exit 1) if the gzipped initial payload exceeds the budget below, so a
 * dependency accidentally pulled into the eager graph is caught in CI.
 *
 * Run after `vite build`:  node scripts/check-bundle-size.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { isAbsolute, join, relative, resolve } from 'node:path'

// Gzipped budget for the initial load (entry + its static import graph).
const BUDGET_BYTES = 700 * 1024

const distDir = join(process.cwd(), 'dist')
const manifestPath = join(distDir, '.vite', 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error(`✖ Manifest not found at ${manifestPath}. Run \`bun run build\` first.`)
  process.exit(1)
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** @param {string} file */
function assertSafeBundlePath(file) {
  assert(file.length > 0, 'Manifest asset path must not be empty.')
  assert(!isAbsolute(file), `Manifest asset path must be relative: ${JSON.stringify(file)}`)
  const resolved = resolve(distDir, file)
  const fromDist = relative(distDir, resolved)
  assert(
    fromDist !== '..' && !fromDist.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
    `Manifest asset path escapes dist: ${JSON.stringify(file)}`
  )
}

try {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    'Vite manifest root must be an object.'
  )
  /** @type {Record<string, unknown>} */
  const manifest = parsed
  const entryKeys = Object.keys(manifest).filter((key) => {
    const chunk = manifest[key]
    return (
      typeof chunk === 'object' && chunk !== null && !Array.isArray(chunk) && chunk.isEntry === true
    )
  })
  assert(entryKeys.length > 0, 'No entry chunk found in manifest.')

  // Collect every entry and everything reachable through STATIC imports only.
  const seen = new Set()
  const files = new Set()
  const queue = [...entryKeys]
  while (queue.length > 0) {
    const key = queue.shift()
    if (!key || seen.has(key)) continue
    seen.add(key)
    assert(
      Object.prototype.hasOwnProperty.call(manifest, key),
      `Manifest static import references missing chunk ${JSON.stringify(key)}.`
    )
    const value = manifest[key]
    assert(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      `Manifest chunk ${JSON.stringify(key)} must be an object.`
    )
    const chunk = /** @type {Record<string, unknown>} */ (value)
    assert(
      typeof chunk.file === 'string',
      `Manifest chunk ${JSON.stringify(key)} must carry a string file path.`
    )
    assertSafeBundlePath(chunk.file)
    files.add(chunk.file)

    const css = chunk.css ?? []
    assert(Array.isArray(css), `Manifest chunk ${JSON.stringify(key)} css must be an array.`)
    for (const stylesheet of css) {
      assert(
        typeof stylesheet === 'string',
        `Manifest chunk ${JSON.stringify(key)} contains a non-string CSS path.`
      )
      assertSafeBundlePath(stylesheet)
      files.add(stylesheet)
    }

    const imports = chunk.imports ?? []
    assert(
      Array.isArray(imports),
      `Manifest chunk ${JSON.stringify(key)} imports must be an array.`
    )
    for (const importedKey of imports) {
      assert(
        typeof importedKey === 'string' && importedKey.length > 0,
        `Manifest chunk ${JSON.stringify(key)} contains an invalid static import key.`
      )
      assert(
        Object.prototype.hasOwnProperty.call(manifest, importedKey),
        `Manifest static import references missing chunk ${JSON.stringify(importedKey)}.`
      )
      queue.push(importedKey)
    }
    // NOTE: chunk.dynamicImports is intentionally NOT followed.
  }

  let total = 0
  const rows = []
  for (const file of files) {
    const assetPath = join(distDir, file)
    assert(existsSync(assetPath), `Manifest asset is missing from dist: ${JSON.stringify(file)}.`)
    const bytes = gzipSync(readFileSync(assetPath)).length
    total += bytes
    rows.push({ file, kb: (bytes / 1024).toFixed(1) })
  }

  rows.sort((a, b) => Number(b.kb) - Number(a.kb))
  console.log(
    `Initial load for ${entryKeys.length} entr${entryKeys.length === 1 ? 'y' : 'ies'} (gzipped, static import graph union):`
  )
  for (const { file, kb } of rows) console.log(`  ${kb.padStart(8)} kB  ${file}`)

  const totalKb = (total / 1024).toFixed(1)
  const budgetKb = (BUDGET_BYTES / 1024).toFixed(1)
  console.log(`  ${'─'.repeat(20)}`)
  console.log(`  ${totalKb.padStart(8)} kB  total (budget ${budgetKb} kB)`)

  if (total > BUDGET_BYTES) {
    throw new Error(
      `Initial bundle ${totalKb} kB exceeds budget ${budgetKb} kB.\n` +
        `Move newly-eager dependencies behind a dynamic import(), or raise the ` +
        `budget in scripts/check-bundle-size.mjs with justification.`
    )
  }
  console.log(`\n✓ Initial bundle within budget (${totalKb} / ${budgetKb} kB gzipped).`)
} catch (error) {
  console.error(
    `✖ Bundle-size check failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
