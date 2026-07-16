#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { normalizeBunNix } from './normalize-bun-nix.mjs'

const lock = readFileSync('bun.lock', 'utf8')
const generated = `{
  "@sepahead/ncp@github:sepahead/NCP#54008b1" = fetchurl {
    url = "https://registry.npmjs.org/@sepahead/ncp/-/ncp-github:sepahead/NCP#54008b1.tgz";
    hash = "sha512-khEm3dk8N9A1ugKBJwYuMycUChCVI6BQjM7enpfBcm1e8twmQc0vY35rT+kSV5N3FOFkG7cCOkred3CBcIh2jQ==";
  };
}
`

const normalized = normalizeBunNix(generated, lock)
if (!normalized.includes('"github:sepahead-NCP-54008b1" = fetchFromGitHub')) {
  throw new Error("normalizer omitted Bun's GitHub NCP cache identity")
}
if (normalized.includes('"@sepahead/ncp@github:sepahead/NCP#54008b1" =')) {
  throw new Error('normalizer retained the invalid npm-style NCP cache identity')
}
if (!normalized.includes('2f5bd586d4bb20c90362bb6f5698b7f64057ba4e')) {
  throw new Error('normalizer omitted the full peeled NCP commit')
}
if (!normalized.includes('sha256-GaYmp35xnxlZ0TClyKsFNYswzulgyaCA+TPzF6bJMVk=')) {
  throw new Error('normalizer omitted the fixed-output NCP hash')
}

for (const mutation of [
  () => normalizeBunNix('{}\n', lock),
  () => normalizeBunNix(generated, lock.replace('sepahead-NCP-54008b1', 'changed')),
]) {
  let rejected = false
  try {
    mutation()
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('bun.nix normalizer accepted a mutation')
}

const tracked = readFileSync('bun.nix', 'utf8')
if (tracked.includes('registry.npmjs.org/@sepahead/ncp')) {
  throw new Error('tracked bun.nix retains the invalid generated NCP URL')
}
if (!tracked.includes('"github:sepahead-NCP-54008b1" = fetchFromGitHub')) {
  throw new Error("tracked bun.nix omits Bun's GitHub NCP cache identity")
}
if (tracked.includes('"@sepahead/ncp@github:sepahead/NCP#54008b1" =')) {
  throw new Error('tracked bun.nix retains the invalid npm-style NCP cache identity')
}
if (!tracked.includes('2f5bd586d4bb20c90362bb6f5698b7f64057ba4e')) {
  throw new Error('tracked bun.nix does not bind the full peeled NCP commit')
}

console.log('OK: bun.nix normalizer rejected Git identity and generator-shape mutations')
