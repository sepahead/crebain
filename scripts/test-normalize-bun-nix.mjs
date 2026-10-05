#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { normalizeBunNix } from './normalize-bun-nix.mjs'

const lock = readFileSync('bun.lock', 'utf8')
const generated = `{
  "@sepahead/ncp@github:sepahead/NCP#2819dae" = fetchurl {
    url = "https://registry.npmjs.org/@sepahead/ncp/-/ncp-github:sepahead/NCP#2819dae.tgz";
    hash = "sha512-1ZzbfQ0egAFA+8WnEKZIDn/vlzIHRksyx2si9605XQyCqWCAO+0yBYq9rlF/JRTzdTSNyyhNjg7IXHfRHVbcWg==";
  };
}
`

const normalized = normalizeBunNix(generated, lock)
if (!normalized.includes('"github:sepahead-NCP-2819dae" = fetchFromGitHub')) {
  throw new Error("normalizer omitted Bun's GitHub NCP cache identity")
}
if (normalized.includes('"@sepahead/ncp@github:sepahead/NCP#2819dae" =')) {
  throw new Error('normalizer retained the invalid npm-style NCP cache identity')
}
if (!normalized.includes('2819dae3b6338bb1df6d105ebb5b7433936a993d')) {
  throw new Error('normalizer omitted the full NCP commit')
}
if (!normalized.includes('sha256-8NGiapsQXwtPZdD7Amp5grNqn8YR/fsYgTBKE0abBh4=')) {
  throw new Error('normalizer omitted the fixed-output NCP hash')
}

for (const mutation of [
  () => normalizeBunNix('{}\n', lock),
  () => normalizeBunNix(generated, lock.replace('sepahead-NCP-2819dae', 'changed')),
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
if (!tracked.includes('"github:sepahead-NCP-2819dae" = fetchFromGitHub')) {
  throw new Error("tracked bun.nix omits Bun's GitHub NCP cache identity")
}
if (tracked.includes('"@sepahead/ncp@github:sepahead/NCP#2819dae" =')) {
  throw new Error('tracked bun.nix retains the invalid npm-style NCP cache identity')
}
if (!tracked.includes('2819dae3b6338bb1df6d105ebb5b7433936a993d')) {
  throw new Error('tracked bun.nix does not bind the full NCP commit')
}

console.log('OK: bun.nix normalizer rejected Git identity and generator-shape mutations')
