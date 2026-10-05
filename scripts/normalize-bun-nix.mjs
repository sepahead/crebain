#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NCP_KEY = '@sepahead/ncp@github:sepahead/NCP#2819dae'
const NCP_CACHE_KEY = 'github:sepahead-NCP-2819dae'
const NCP_COMMIT = '2819dae3b6338bb1df6d105ebb5b7433936a993d'
const NCP_NAR_HASH = 'sha256-8NGiapsQXwtPZdD7Amp5grNqn8YR/fsYgTBKE0abBh4='
const NCP_INTEGRITY =
  'sha512-1ZzbfQ0egAFA+8WnEKZIDn/vlzIHRksyx2si9605XQyCqWCAO+0yBYq9rlF/JRTzdTSNyyhNjg7IXHfRHVbcWg=='

function fail(message) {
  throw new Error(`bun.nix normalization failed: ${message}`)
}

export function normalizeBunNix(raw, lockText) {
  const expectedTuple = `"@sepahead/ncp": ["${NCP_KEY}", {}, "sepahead-NCP-2819dae", "${NCP_INTEGRITY}"]`
  if (lockText.split(expectedTuple).length - 1 !== 1) {
    fail('Bun NCP lock identity differs from the reviewed v1.0.0-rc.1 tuple')
  }

  const invalidBlock = `  "${NCP_KEY}" = fetchurl {
    url = "https://registry.npmjs.org/@sepahead/ncp/-/ncp-github:sepahead/NCP#2819dae.tgz";
    hash = "${NCP_INTEGRITY}";
  };`
  const occurrences = raw.split(invalidBlock).length - 1
  if (occurrences !== 1) {
    fail(`expected one known bun2nix 2.1.1 Git misclassification, found ${occurrences}`)
  }

  const fixedBlock = `  # bun2nix 2.1.1 misclassifies Bun 1.3's four-field GitHub lock entry.
  # Bind Bun's GitHub cache key to the full commit shared with Cargo.lock.
  "${NCP_CACHE_KEY}" = fetchFromGitHub {
    owner = "sepahead";
    repo = "NCP";
    rev = "${NCP_COMMIT}";
    hash = "${NCP_NAR_HASH}";
  };`
  const normalized = raw.replace(invalidBlock, fixedBlock)
  if (normalized.includes('registry.npmjs.org/@sepahead/ncp')) {
    fail('invalid NCP registry URL remains after normalization')
  }
  if (normalized.includes(`"${NCP_KEY}" =`)) {
    fail('invalid npm-style NCP cache key remains after normalization')
  }
  return normalized
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const raw = readFileSync(0, 'utf8')
    const lock = readFileSync('bun.lock', 'utf8')
    process.stdout.write(normalizeBunNix(raw, lock))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
