#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoForbiddenRuntimeCapabilities } from './check-production-authority-boundary.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/fixtures/production-boundary-invalid-cases.json'), 'utf8')
)

if (
  fixture.schema_version !== 1 ||
  !Array.isArray(fixture.cases) ||
  fixture.cases.length === 0 ||
  !Array.isArray(fixture.allowed_cases) ||
  fixture.allowed_cases.length === 0
) {
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

let allowed = 0
for (const testCase of fixture.allowed_cases) {
  try {
    assertNoForbiddenRuntimeCapabilities(`${testCase.id}.js`, testCase.source)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    throw new Error(`${testCase.id}: allowed fixture was rejected: ${failure}`)
  }
  allowed += 1
}

assertNoForbiddenRuntimeCapabilities('approved-vendor-constructor.js', "new Function('return 1')", {
  allowVendorFunctionConstructors: true,
})
for (const [id, source] of [
  [
    'aliased-vendor-constructor',
    "const DynamicFunction = Function; new DynamicFunction('return 1')",
  ],
  ['global-vendor-constructor', "new globalThis.Function('return 1')"],
  ['reflective-vendor-constructor', "Reflect.construct(Function, ['return 1'])"],
]) {
  try {
    assertNoForbiddenRuntimeCapabilities(`${id}.js`, source, {
      allowVendorFunctionConstructors: true,
    })
  } catch {
    continue
  }
  throw new Error(`${id}: non-canonical vendor Function constructor was accepted`)
}

console.log(
  `OK: production authority artifact self-test passed (${passed} fail-closed, ${allowed} allowed fixtures, exact vendor constructor scope)`
)
