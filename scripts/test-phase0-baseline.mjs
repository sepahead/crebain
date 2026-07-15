#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPhase0Baseline, verifyPhase0Baseline, walkFiles } from './verify-phase0-baseline.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_PATH = resolve(ROOT, 'scripts/fixtures/phase0-baseline-invalid-cases.json')

function clone(value) {
  return structuredClone(value)
}

function valueAt(root, path) {
  return path.reduce((value, key) => value[key], root)
}

function parentAt(root, path) {
  return valueAt(root, path.slice(0, -1))
}

function applyDataMutation(documents, mutation) {
  const document = documents[mutation.document]
  if (mutation.type === 'remove-configuration-artifact') {
    const artifacts = document.crebain_configuration_artifacts
    const index = artifacts.findIndex((artifact) => artifact.path === mutation.value)
    if (index === -1) {
      throw new Error(`Self-test could not locate configuration artifact '${mutation.value}'`)
    }
    artifacts.splice(index, 1)
    return
  }
  if (mutation.type === 'set') {
    parentAt(document, mutation.path)[mutation.path.at(-1)] = mutation.value
    return
  }
  if (mutation.type === 'delete') {
    delete parentAt(document, mutation.path)[mutation.path.at(-1)]
    return
  }
  if (mutation.type === 'copy') {
    parentAt(document, mutation.to)[mutation.to.at(-1)] = valueAt(document, mutation.from)
    return
  }
  throw new Error(`Unsupported data fixture mutation: ${mutation.type}`)
}

function applySourceMutation(sourceOverrides, mutation) {
  const original = Object.hasOwn(sourceOverrides, mutation.file)
    ? sourceOverrides[mutation.file]
    : mutation.type === 'add-source'
      ? ''
      : readFileSync(resolve(ROOT, mutation.file), 'utf8')
  if (mutation.type === 'add-source') {
    sourceOverrides[mutation.file] = mutation.value
    return
  }
  if (mutation.type === 'append-source') {
    sourceOverrides[mutation.file] = original + mutation.value
    return
  }
  if (mutation.type === 'replace-source') {
    if (!original.includes(mutation.needle)) {
      throw new Error(`Self-test could not locate source text in ${mutation.file}`)
    }
    sourceOverrides[mutation.file] = original.replace(mutation.needle, mutation.value)
    return
  }
  if (mutation.type === 'append-tauri-handler') {
    const marker = /transport_get_stats\s*\]\)/
    if (!marker.test(original)) throw new Error('Self-test could not locate the Tauri handler tail')
    sourceOverrides[mutation.file] = original.replace(
      marker,
      `transport_get_stats,\n            ${mutation.value}\n        ])`
    )
    return
  }
  if (mutation.type === 'shadow-and-append-tauri-handler') {
    const invocation = original.match(
      /\.invoke_handler\s*\(\s*tauri::generate_handler!\s*\[[\s\S]*?\]\s*\)/
    )?.[0]
    if (!invocation) throw new Error('Self-test could not locate the Tauri handler invocation')
    const marker = /transport_get_stats\s*\]\)/
    if (!marker.test(original)) throw new Error('Self-test could not locate the Tauri handler tail')
    const modified = original.replace(
      marker,
      `transport_get_stats,\n            ${mutation.value}\n        ])`
    )
    const shadow =
      mutation.comment_style === 'line'
        ? `// ${invocation.replace(/\s+/g, ' ')}\n`
        : `/* ${invocation} */\n`
    sourceOverrides[mutation.file] = shadow + modified
    return
  }
  throw new Error(`Unsupported source fixture mutation: ${mutation.type}`)
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
if (fixture.schema_version !== 1 || !Array.isArray(fixture.cases)) {
  throw new Error('Invalid Phase 0 self-test fixture manifest')
}

const baseline = loadPhase0Baseline(ROOT)
const positive = verifyPhase0Baseline({ root: ROOT, ...baseline })
let passed = 0

const symlinkRoot = mkdtempSync(join(tmpdir(), 'crebain-phase0-symlink-'))
try {
  mkdirSync(resolve(symlinkRoot, 'src'))
  writeFileSync(resolve(symlinkRoot, 'outside.ts'), 'new WebSocket(url)\n')
  symlinkSync('../outside.ts', resolve(symlinkRoot, 'src/alias.ts'))
  let symlinkFailure = ''
  try {
    walkFiles(symlinkRoot, 'src')
  } catch (error) {
    symlinkFailure = error instanceof Error ? error.message : String(error)
  }
  if (!symlinkFailure.includes('production scan rejects symbolic link')) {
    throw new Error(`production symlink fixture was accepted: ${symlinkFailure || '<no error>'}`)
  }
  passed += 1
} finally {
  rmSync(symlinkRoot, { recursive: true, force: true })
}

for (const testCase of fixture.cases) {
  const documents = clone(baseline)
  const sourceOverrides = {}
  const mutations = testCase.mutations ?? [testCase.mutation]
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new Error(`${testCase.id}: mutations must be a non-empty array`)
  }
  for (const mutation of mutations) {
    if (['set', 'delete', 'copy', 'remove-configuration-artifact'].includes(mutation.type)) {
      applyDataMutation(documents, mutation)
    } else {
      applySourceMutation(sourceOverrides, mutation)
    }
  }

  let failure = null
  try {
    verifyPhase0Baseline({
      root: ROOT,
      ...documents,
      sourceOverrides,
      allowFixtureEvidence: true,
    })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (failure === null) throw new Error(`${testCase.id}: invalid fixture was accepted`)
  if (!failure.includes(testCase.expected_error)) {
    throw new Error(`${testCase.id}: expected '${testCase.expected_error}', got '${failure}'`)
  }
  passed += 1
}

console.log(
  `OK: Phase 0 verifier self-test passed (${positive.surfaces} positive surfaces; ` +
    `${passed} fail-closed fixtures)`
)
