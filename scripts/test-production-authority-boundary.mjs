#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoForbiddenRuntimeCapabilities } from './check-production-authority-boundary.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/fixtures/production-boundary-invalid-cases.json'), 'utf8')
)

if (fixture.schema_version !== 1 || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
  throw new Error('Invalid production-boundary self-test fixture manifest')
}

let passed = 0
for (const testCase of fixture.cases) {
  let failure = null
  try {
    assertNoForbiddenRuntimeCapabilities(`${testCase.id}.js`, testCase.source)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (failure === null) throw new Error(`${testCase.id}: invalid artifact fixture was accepted`)
  if (!failure.includes(testCase.expected_error)) {
    throw new Error(`${testCase.id}: expected '${testCase.expected_error}', got '${failure}'`)
  }
  passed += 1
}

console.log(`OK: production authority artifact self-test passed (${passed} fail-closed fixtures)`)
