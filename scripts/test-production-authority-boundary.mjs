#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertNoForbiddenRuntimeCapabilities,
  assertQualifiedProductionModules,
} from './check-production-authority-boundary.mjs'
import { AUDITED_DATA_COPIER_PATH } from './verify-phase0-baseline.mjs'

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
    assertNoForbiddenRuntimeCapabilities(`${testCase.id}.js`, testCase.source, {
      rejectPropertyDescriptors: true,
      rejectUnknownCallableMembers: true,
    })
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
    assertNoForbiddenRuntimeCapabilities(`${testCase.id}.js`, testCase.source, {
      rejectPropertyDescriptors: true,
      rejectUnknownCallableMembers: true,
    })
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

const copierSource = readFileSync(resolve(ROOT, AUDITED_DATA_COPIER_PATH), 'utf8')
const strictSourceOptions = { rejectPropertyDescriptors: true, rejectUnknownCallableMembers: true }
assertNoForbiddenRuntimeCapabilities(AUDITED_DATA_COPIER_PATH, copierSource, strictSourceOptions)
allowed += 1
const copierMutations = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/fixtures/phase0-baseline-invalid-cases.json'), 'utf8')
).cases.filter(
  (testCase) =>
    testCase.id.startsWith('audited-data-copy-') ||
    testCase.id === 'data-descriptor-outside-audited-node'
)
for (const testCase of copierMutations) {
  const { mutation } = testCase
  const original = readFileSync(resolve(ROOT, mutation.file), 'utf8')
  if (mutation.type === 'replace-source' && !original.includes(mutation.needle)) {
    throw new Error(`${testCase.id}: missing source mutation target`)
  }
  const changed =
    mutation.type === 'append-source'
      ? original + mutation.value
      : original.replace(mutation.needle, mutation.value)
  let failure = ''
  try {
    assertNoForbiddenRuntimeCapabilities(mutation.file, changed, strictSourceOptions)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const expected =
    mutation.file === AUDITED_DATA_COPIER_PATH
      ? 'audited plain-data copier source digest mismatch'
      : 'property descriptor access'
  if (!failure.includes(expected))
    throw new Error(`${testCase.id}: expected ${expected}, got ${failure || 'acceptance'}`)
  passed += 1
}

assertQualifiedProductionModules('ordinary.js', ['src/main.tsx', 'src/lib/boundedFetch.ts'])
allowed += 1
let unqualifiedFailure = ''
try {
  assertQualifiedProductionModules('unqualified.js', ['src/main.tsx', AUDITED_DATA_COPIER_PATH])
} catch (error) {
  unqualifiedFailure = error instanceof Error ? error.message : String(error)
}
if (!unqualifiedFailure.includes('without finalized-call qualification'))
  throw new Error('unqualified audited copier production module was accepted')
passed += 1

console.log(
  `OK: production authority artifact self-test passed (${passed} fail-closed, ${allowed} allowed fixtures, exact vendor constructor scope)`
)
