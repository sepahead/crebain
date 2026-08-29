#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeV2EvidenceFixture } from './managed-simulation-v2-test-fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  throw new Error(`Engram model oracle failed: ${message}`)
}

function parseArguments(arguments_) {
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index]
    const value = arguments_[index + 1]
    if (!['--engram-root', '--engram-commit', '--python'].includes(option) || value === undefined) {
      fail('use --engram-root, --engram-commit, and optional --python')
    }
    if (values.has(option)) fail(`duplicate option: ${option}`)
    values.set(option, value)
  }
  if (!values.has('--engram-root') || !values.has('--engram-commit')) {
    fail('use --engram-root and --engram-commit')
  }
  return {
    engramRoot: resolve(values.get('--engram-root')),
    engramCommit: values.get('--engram-commit'),
    python: values.get('--python') ?? 'python3',
  }
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  const fixture = makeV2EvidenceFixture(ROOT)
  const directory = mkdtempSync(resolve(tmpdir(), 'crebain-engram-model-oracle-'))
  try {
    const captures = []
    for (const row of fixture.index.captures) {
      const path = resolve(directory, row.path)
      writeFileSync(path, fixture.captures.get(row.path), { flag: 'wx', mode: 0o600 })
      captures.push(path)
    }
    const environment = {
      LANG: 'C',
      LC_ALL: 'C',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      PYTHONDONTWRITEBYTECODE: '1',
      TZ: 'UTC',
    }
    const result = spawnSync(
      arguments_.python,
      [
        '-I',
        '-B',
        resolve(ROOT, 'scripts/verify-managed-simulation-engram-model-oracle.py'),
        '--engram-root',
        arguments_.engramRoot,
        '--engram-commit',
        arguments_.engramCommit,
        ...captures.flatMap((path) => ['--capture', path]),
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    if (result.error !== undefined) fail(`Python launch failed: ${result.error.message}`)
    if (result.status !== 0) {
      fail(result.stderr.trim() || `Python exited with status ${result.status}`)
    }
    process.stdout.write(result.stdout)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

main()
