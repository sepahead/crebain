#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NCP_KEY = '@sepahead/ncp@github:sepahead/NCP#54008b1'
const NCP_COMMIT = '2f5bd586d4bb20c90362bb6f5698b7f64057ba4e'
const NCP_NAR_HASH = 'sha256-GaYmp35xnxlZ0TClyKsFNYswzulgyaCA+TPzF6bJMVk='
const NCP_INTEGRITY =
  'sha512-khEm3dk8N9A1ugKBJwYuMycUChCVI6BQjM7enpfBcm1e8twmQc0vY35rT+kSV5N3FOFkG7cCOkred3CBcIh2jQ=='

function fail(message) {
  throw new Error(`bun.nix normalization failed: ${message}`)
}

export function normalizeBunNix(raw, lockText) {
  const expectedTuple = `"@sepahead/ncp": ["${NCP_KEY}", {}, "sepahead-NCP-54008b1", "${NCP_INTEGRITY}"]`
  if (lockText.split(expectedTuple).length - 1 !== 1) {
    fail('Bun NCP lock identity differs from the reviewed v0.8.0 tuple')
  }

  const invalidBlock = `  "${NCP_KEY}" = fetchurl {
    url = "https://registry.npmjs.org/@sepahead/ncp/-/ncp-github:sepahead/NCP#54008b1.tgz";
    hash = "${NCP_INTEGRITY}";
  };`
  const occurrences = raw.split(invalidBlock).length - 1
  if (occurrences !== 1) {
    fail(`expected one known bun2nix 2.1.1 Git misclassification, found ${occurrences}`)
  }

  const fixedBlock = `  # bun2nix 2.1.1 misclassifies Bun 1.3's four-field GitHub lock entry.
  # Bind the package to the full peeled commit shared with Cargo.lock.
  "${NCP_KEY}" = fetchFromGitHub {
    owner = "sepahead";
    repo = "NCP";
    rev = "${NCP_COMMIT}";
    hash = "${NCP_NAR_HASH}";
  };`
  const normalized = raw.replace(invalidBlock, fixedBlock)
  if (normalized.includes('registry.npmjs.org/@sepahead/ncp')) {
    fail('invalid NCP registry URL remains after normalization')
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
