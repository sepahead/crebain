#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PATH = resolve(ROOT, 'docs/baselines/product-profiles-0.9.0.json')
const REQUIRED_NAMES = new Set([
  'Analysis',
  'SimulationNoAuthority',
  'ReadOnlyTelemetry',
  'Observed',
  'EngramFederated',
  'ExternalAuthority',
  'HaldirGate',
  'Development',
])
const IMPLEMENTATION_STATUSES = new Set([
  'documented-nonruntime',
  'implemented-research-prototype',
  'component-tested',
  'component-tested-opt-in',
  'not-implemented-for-0.9.0',
  'development-only',
])
const MUTATION_SCOPES = new Set(['none', 'local-simulation-only'])
const TRANSPORT_SCOPES = new Set([
  'none',
  'subscription-only-native-telemetry',
  'two-route-advisory-evidence-only',
  'development-rosbridge-subscriptions-only',
])
const ALLOWED_FEATURES = new Set(['ncp', 'zenoh-transport'])

function fail(message) {
  throw new Error(`Product-profile verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function strictJson(text) {
  // JSON.parse is last-key-wins. A compact structural scanner rejects duplicate
  // object keys before parsing while honoring strings and escapes.
  const stack = []
  let index = 0
  const whitespace = () => {
    while (/\s/.test(text[index] ?? '')) index += 1
  }
  const string = () => {
    assert(text[index] === '"', `expected string at byte ${index}`)
    const start = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const character = text[index++]
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') return JSON.parse(text.slice(start, index))
    }
    fail('unterminated JSON string')
  }
  const value = () => {
    whitespace()
    if (text[index] === '{') {
      index += 1
      const keys = new Set()
      stack.push(keys)
      whitespace()
      if (text[index] === '}') index += 1
      else {
        while (true) {
          whitespace()
          const key = string()
          assert(!keys.has(key), `duplicate JSON key '${key}'`)
          keys.add(key)
          whitespace()
          assert(text[index++] === ':', `expected ':' after '${key}'`)
          value()
          whitespace()
          const delimiter = text[index++]
          if (delimiter === '}') break
          assert(delimiter === ',', `expected ',' or '}' at byte ${index - 1}`)
        }
      }
      stack.pop()
    } else if (text[index] === '[') {
      index += 1
      whitespace()
      if (text[index] === ']') index += 1
      else {
        while (true) {
          value()
          whitespace()
          const delimiter = text[index++]
          if (delimiter === ']') break
          assert(delimiter === ',', `expected ',' or ']' at byte ${index - 1}`)
        }
      }
    } else if (text[index] === '"') string()
    else {
      const match = text
        .slice(index)
        .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
      assert(match, `invalid JSON value at byte ${index}`)
      index += match[0].length
    }
  }
  value()
  whitespace()
  assert(index === text.length, `trailing JSON content at byte ${index}`)
  return JSON.parse(text)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function profileDigest(profile) {
  const body = { ...profile }
  delete body.contract_digest
  return createHash('sha256').update(canonical(body)).digest('hex')
}

export function verifyProductProfiles(document) {
  assert(
    document && typeof document === 'object' && !Array.isArray(document),
    'root is not an object'
  )
  assert(document.schema_version === 1, 'schema_version must be 1')
  assert(document.release_target === '0.9.0', 'release_target must be 0.9.0')
  assert(
    document.authority_invariant ===
      'No CREBAIN 0.9.0 profile authorizes or applies output to an external plant.',
    'authority invariant drift'
  )
  assert(Array.isArray(document.profiles), 'profiles must be an array')
  const names = new Set()
  for (const profile of document.profiles) {
    assert(
      profile && typeof profile === 'object' && !Array.isArray(profile),
      'profile is not an object'
    )
    const exactKeys = new Set([
      'name',
      'implementation_status',
      'packaged',
      'selectable',
      'authority',
      'mutation_scope',
      'transport_scope',
      'required_features',
      'forbidden_features',
      'claim',
      'contract_digest',
    ])
    assert(
      Object.keys(profile).length === exactKeys.size &&
        Object.keys(profile).every((key) => exactKeys.has(key)),
      `${profile.name ?? '<unnamed>'} has unknown or missing fields`
    )
    assert(REQUIRED_NAMES.has(profile.name), `unknown profile '${profile.name}'`)
    assert(!names.has(profile.name), `duplicate profile '${profile.name}'`)
    names.add(profile.name)
    assert(
      IMPLEMENTATION_STATUSES.has(profile.implementation_status),
      `${profile.name} has invalid implementation_status`
    )
    assert(typeof profile.packaged === 'boolean', `${profile.name}.packaged is not boolean`)
    assert(typeof profile.selectable === 'boolean', `${profile.name}.selectable is not boolean`)
    assert(profile.authority === 'none', `${profile.name} must have authority=none for 0.9.0`)
    assert(
      MUTATION_SCOPES.has(profile.mutation_scope),
      `${profile.name} has invalid mutation_scope`
    )
    assert(
      TRANSPORT_SCOPES.has(profile.transport_scope),
      `${profile.name} has invalid transport_scope`
    )
    for (const field of ['required_features', 'forbidden_features']) {
      assert(Array.isArray(profile[field]), `${profile.name}.${field} must be an array`)
      assert(
        new Set(profile[field]).size === profile[field].length,
        `${profile.name}.${field} has duplicates`
      )
      assert(
        profile[field].every((feature) => ALLOWED_FEATURES.has(feature)),
        `${profile.name}.${field} has an unknown feature`
      )
    }
    assert(
      !profile.required_features.some((feature) => profile.forbidden_features.includes(feature)),
      `${profile.name} both requires and forbids a feature`
    )
    assert(
      typeof profile.claim === 'string' && profile.claim.length > 20,
      `${profile.name} claim is empty`
    )
    assert(
      /^[0-9a-f]{64}$/.test(profile.contract_digest) &&
        profile.contract_digest === profileDigest(profile),
      `${profile.name} contract_digest mismatch`
    )
    if (profile.implementation_status.startsWith('not-implemented')) {
      assert(
        !profile.packaged && !profile.selectable,
        `${profile.name} unavailable profile is reachable`
      )
      assert(
        profile.transport_scope === 'none',
        `${profile.name} unavailable profile has transport`
      )
    }
    if (profile.name === 'Observed') {
      assert(
        !profile.packaged && !profile.selectable,
        'Observed must remain outside default packages'
      )
      assert(profile.required_features.includes('ncp'), 'Observed must require the ncp feature')
    } else {
      assert(!profile.required_features.includes('ncp'), `${profile.name} must not require ncp`)
    }
    if (profile.name === 'Development') {
      assert(!profile.packaged, 'Development must not be packaged')
    }
  }
  assert(names.size === REQUIRED_NAMES.size, 'profile count mismatch')
  for (const name of REQUIRED_NAMES) assert(names.has(name), `missing profile '${name}'`)
  return { profiles: names.size }
}

export function loadAndVerifyProductProfiles(path = DEFAULT_PATH) {
  const document = strictJson(readFileSync(path, 'utf8'))
  return verifyProductProfiles(document)
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    const result = loadAndVerifyProductProfiles(process.argv[2] && resolve(process.argv[2]))
    console.log(
      `OK: ${result.profiles} immutable 0.9.0 product profiles are coherent and NoAuthority`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
