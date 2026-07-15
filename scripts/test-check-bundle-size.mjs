#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = resolve('scripts/check-bundle-size.mjs')

function runFixture(manifest, assets = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crebain-bundle-check-'))
  const manifestPath = join(root, 'dist', '.vite', 'manifest.json')
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest))
  for (const [name, contents] of Object.entries(assets)) {
    const path = join(root, 'dist', name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
  rmSync(root, { recursive: true, force: true })
  return result
}

{
  const result = runFixture(
    {
      'entry-a.js': { file: 'assets/a.js', isEntry: true, imports: ['shared.js'] },
      'entry-b.js': { file: 'assets/b.js', isEntry: true },
      'shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
    },
    {
      'assets/a.js': 'a',
      'assets/b.js': 'b',
      'assets/shared.js': 'shared',
      'assets/shared.css': 'css',
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /2 entries/)
  for (const asset of ['assets/a.js', 'assets/b.js', 'assets/shared.js', 'assets/shared.css']) {
    assert.match(result.stdout, new RegExp(asset.replace('.', '\\.')))
  }
}

{
  const result = runFixture({
    'entry.js': { file: 'assets/entry.js', isEntry: true, imports: ['missing.js'] },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing chunk "missing\.js"/)
}

{
  const result = runFixture(
    { 'entry.js': { file: '../escape.js', isEntry: true } },
    { '../escape.js': 'escape' }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /escapes dist/)
}

console.log('Bundle-size checker regression tests passed.')
