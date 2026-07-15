#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileDigest, verifyProductProfiles } from './verify-product-profiles.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, 'docs/baselines/product-profiles-0.9.0.json'), 'utf8')
)

function clone(value) {
  return structuredClone(value)
}

function expectRejected(label, mutate, expected) {
  const document = clone(fixture)
  mutate(document)
  let message = ''
  try {
    verifyProductProfiles(document)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (!message.includes(expected)) {
    throw new Error(`${label}: expected '${expected}', got '${message || '<accepted>'}'`)
  }
}

verifyProductProfiles(fixture)

expectRejected(
  'authority widening',
  (document) => {
    const profile = document.profiles.find(({ name }) => name === 'ReadOnlyTelemetry')
    profile.authority = 'apply'
    profile.contract_digest = profileDigest(profile)
  },
  'authority=none'
)

expectRejected(
  'unavailable selectable',
  (document) => {
    const profile = document.profiles.find(({ name }) => name === 'HaldirGate')
    profile.selectable = true
    profile.contract_digest = profileDigest(profile)
  },
  'unavailable profile is reachable'
)

expectRejected(
  'development packaged',
  (document) => {
    const profile = document.profiles.find(({ name }) => name === 'Development')
    profile.packaged = true
    profile.contract_digest = profileDigest(profile)
  },
  'Development must not be packaged'
)

expectRejected(
  'digest drift',
  (document) => {
    document.profiles[0].claim += ' changed'
  },
  'contract_digest mismatch'
)

expectRejected(
  'duplicate profile',
  (document) => {
    document.profiles[1].name = 'Analysis'
    document.profiles[1].contract_digest = profileDigest(document.profiles[1])
  },
  'duplicate profile'
)

expectRejected(
  'missing profile',
  (document) => {
    document.profiles.pop()
  },
  'profile count mismatch'
)

expectRejected(
  'unknown feature',
  (document) => {
    const profile = document.profiles[0]
    profile.required_features.push('authority')
    profile.contract_digest = profileDigest(profile)
  },
  'unknown feature'
)

console.log('OK: product-profile self-test rejected 7 authority/reachability/integrity mutations')
