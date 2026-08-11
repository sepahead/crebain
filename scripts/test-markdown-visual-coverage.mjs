#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyMarkdownVisualCoverage } from './verify-markdown-visual-coverage.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = resolve(ROOT, 'docs/markdown-visual-coverage.json')
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const trackedMarkdown = execFileSync('git', ['-C', ROOT, 'ls-files', '--', '*.md'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .sort()

function cloneManifest() {
  return structuredClone(manifest)
}

let rejectedMutations = 0

function expectFailure(id, mutate, expected) {
  const candidate = cloneManifest()
  const overrides = mutate(candidate) ?? {}
  assert.throws(
    () => verifyMarkdownVisualCoverage({ root: ROOT, manifest: candidate, ...overrides }),
    (error) => {
      assert.match(String(error), expected, `${id}: unexpected failure`)
      return true
    },
    `${id}: invalid fixture was accepted`
  )
  rejectedMutations += 1
}

const baseline = verifyMarkdownVisualCoverage({ root: ROOT, manifest })
assert.equal(baseline.documents, trackedMarkdown.length)

expectFailure(
  'missing-document',
  (candidate) => {
    candidate.documents.shift()
  },
  /unclassified tracked Markdown/
)

expectFailure(
  'missing-policy',
  (candidate) => {
    delete candidate.policy
  },
  /manifest needs a specific visual-coverage policy/
)

expectFailure(
  'stale-document',
  (candidate) => {
    candidate.documents.push({
      path: 'zz-untracked.md',
      classification: 'project-process',
      exemption: { kind: 'fixture', reason: 'This fixture path is intentionally untracked.' },
    })
  },
  /manifest lists untracked Markdown/
)

expectFailure(
  'duplicate-document',
  (candidate) => {
    candidate.documents.splice(1, 0, structuredClone(candidate.documents[0]))
  },
  /duplicate document paths/
)

expectFailure(
  'unsorted-documents',
  (candidate) => {
    ;[candidate.documents[0], candidate.documents[1]] = [
      candidate.documents[1],
      candidate.documents[0],
    ]
  },
  /strict lexical order/
)

expectFailure(
  'unknown-classification',
  (candidate) => {
    candidate.documents[0].classification = 'decorative'
  },
  /invalid classification/
)

expectFailure(
  'blank-exemption-reason',
  (candidate) => {
    const entry = candidate.documents.find((item) => item.exemption)
    entry.exemption.reason = ' '.repeat(40)
  },
  /exemption needs a specific reason/
)

const firstVisual = manifest.documents.find((entry) => Array.isArray(entry.visuals))
assert(firstVisual, 'The coverage manifest must have at least one visual document')
const secondVisualAsset = manifest.documents
  .flatMap((entry) => entry.visuals ?? [])
  .find((asset) => asset !== firstVisual.visuals[0])
assert(secondVisualAsset, 'The coverage manifest must have at least two visual assets')

function replaceFirstVisualSource(source) {
  return {
    readText: (path) =>
      path === firstVisual.visuals[0] ? source : readFileSync(resolve(ROOT, path), 'utf8'),
  }
}

expectFailure(
  'visual-and-exemption',
  (candidate) => {
    const entry = candidate.documents.find((item) => item.path === firstVisual.path)
    entry.exemption = {
      kind: 'fixture',
      reason: 'A document cannot select both coverage outcomes.',
    }
  },
  /must have visuals or one exemption, not both/
)

expectFailure(
  'undeclared-second-diagram',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      if (path !== firstVisual.path) return source
      const relativeAsset = posix.relative(posix.dirname(firstVisual.path), secondVisualAsset)
      return `${source}\n<img alt="Undeclared second technical diagram fixture" src="${relativeAsset}">\n`
    },
  }),
  /references undeclared diagrams/
)

expectFailure(
  'commented-out-visual',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(/<img\b[^>]*assets\/diagrams\/[^>]*>/i, '<!--$&-->')
        : source
    },
  }),
  /must reference .* exactly once/
)

expectFailure(
  'fenced-code-visual',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      if (path !== firstVisual.path) return source
      return source.replace(
        /<p\b[^>]*>\s*(<img\b[^>]*assets\/diagrams\/[^>]*>)\s*<\/p>/i,
        '```html\n$1\n```'
      )
    },
  }),
  /must reference .* exactly once/
)

expectFailure(
  'missing-visual',
  (candidate) => {
    const entry = candidate.documents.find((item) => item.path === firstVisual.path)
    entry.visuals = ['assets/diagrams/not-present.svg']
    return {
      readText: (path) => {
        const source = readFileSync(resolve(ROOT, path), 'utf8')
        return path === firstVisual.path
          ? source.replace(firstVisual.visuals[0], 'assets/diagrams/not-present.svg')
          : source
      },
    }
  },
  /references a missing visual/
)

expectFailure(
  'nonregular-visual',
  () => ({
    pathIsRegular: (path) => path !== firstVisual.visuals[0],
  }),
  /must be a regular in-repository file/
)

expectFailure(
  'missing-alt',
  () => {
    const baseRead = (path) => readFileSync(resolve(ROOT, path), 'utf8')
    return {
      readText: (path) => {
        const source = baseRead(path)
        return path === firstVisual.path
          ? source.replace(/(<img\b[^>]*\balt=)["'][^"']*["']/i, '$1""')
          : source
      },
    }
  },
  /meaningful, concise alt text/
)

expectFailure(
  'missing-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(/\nText alternative:[\s\S]*?(?=\n\s*\n)/i, '')
        : source
    },
  }),
  /needs an adjacent prose text alternative/
)

expectFailure(
  'orphan-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? `${source}\n\nText alternative: This complete sentence is intentionally detached from every declared technical diagram and must be rejected.\n`
        : source
    },
  }),
  /orphan text-alternative labels/
)

expectFailure(
  'detached-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /\nText alternative:/i,
            '\nThis intervening paragraph separates the image from its required equivalent.\n\nText alternative:'
          )
        : source
    },
  }),
  /needs an adjacent prose text alternative/
)

expectFailure(
  'non-prose-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /Text alternative:[\s\S]*?(?=\n\s*\n)/i,
            `Text alternative: ${'-'.repeat(120)}`
          )
        : source
    },
  }),
  /needs an adjacent prose text alternative/
)

expectFailure(
  'short-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /Text alternative:[\s\S]*?(?=\n\s*\n)/i,
            'Text alternative: This summary is too short.'
          )
        : source
    },
  }),
  /needs an adjacent prose text alternative/
)

expectFailure(
  'code-block-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /Text alternative:[\s\S]*?(?=\n\s*\n)/i,
            'Text alternative:\n```text\nThis code block is not an adjacent prose equivalent of the diagram.\n```'
          )
        : source
    },
  }),
  /needs an adjacent prose text alternative/
)

expectFailure(
  'overlong-text-alternative',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /Text alternative:[\s\S]*?(?=\n\s*\n)/i,
            `Text alternative: ${'This repeated sentence does not stay concise. '.repeat(24)}`
          )
        : source
    },
  }),
  /needs an adjacent prose text alternative/
)

expectFailure(
  'overlong-alt',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /(<img\b[^>]*\balt=)["'][^"']*["']/i,
            `$1"${'Excessively verbose technical diagram description '.repeat(3)}"`
          )
        : source
    },
  }),
  /meaningful, concise alt text/
)

expectFailure(
  'padded-alt',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(
            /(<img\b[^>]*\balt=)["'][^"']*["']/i,
            '$1"CREBAIN              technical              diagram"'
          )
        : source
    },
  }),
  /meaningful, concise alt text/
)

expectFailure(
  'invalid-uri-encoding',
  () => ({
    readText: (path) => {
      const source = readFileSync(resolve(ROOT, path), 'utf8')
      return path === firstVisual.path
        ? source.replace(firstVisual.visuals[0], 'assets/diagrams/%ZZ.svg')
        : source
    },
  }),
  /Markdown visual coverage verification failed: .*invalid URI-encoded image path/
)

expectFailure(
  'inaccessible-svg',
  () =>
    replaceFirstVisualSource('<svg viewBox="0 0 10 10" role="img"><title>Fixture</title></svg>'),
  /must reference one title and one description/
)

expectFailure(
  'duplicate-aria-ids',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="same same"><title id="same">Title</title><desc id="same">Description</desc></svg>'
    ),
  /title and description IDs must be distinct/
)

expectFailure(
  'duplicate-element-ids',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">Title</title><desc id="d">Description</desc><g id="duplicate"/><g id="duplicate"/></svg>'
    ),
  /must not contain duplicate IDs/
)

expectFailure(
  'empty-description',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">Title</title><desc id="d"> </desc></svg>'
    ),
  /description must not be empty/
)

expectFailure(
  'css-variable',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">Title</title><desc id="d">Description</desc><style>.x { fill: var(--color); }</style></svg>'
    ),
  /must not depend on CSS variables/
)

expectFailure(
  'external-css-resource',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">Title</title><desc id="d">Description</desc><style>@import url("https://example.com/a.css");</style></svg>'
    ),
  /must not import stylesheets/
)

expectFailure(
  'embedded-image-resource',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">Title</title><desc id="d">Description</desc><image href="data:image/png;base64,AA==" /></svg>'
    ),
  /must not embed image resources/
)

expectFailure(
  'data-href-resource',
  () =>
    replaceFirstVisualSource(
      '<svg viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">Title</title><desc id="d">Description</desc><use href="data:image/svg+xml,fixture" /></svg>'
    ),
  /must not load external resources/
)

expectFailure(
  'orphaned-svg',
  () => ({
    diagramAssets: [
      ...new Set(manifest.documents.flatMap((entry) => entry.visuals ?? [])),
      'assets/diagrams/orphan.svg',
    ].sort(),
    pathIsRegular: () => true,
  }),
  /unreferenced diagram assets/
)

expectFailure(
  'nonregular-diagram-entry',
  () => ({
    diagramAssets: [
      ...new Set(manifest.documents.flatMap((entry) => entry.visuals ?? [])),
      'assets/diagrams/nonregular-fixture.svg',
    ].sort(),
    pathIsRegular: (path) => path !== 'assets/diagrams/nonregular-fixture.svg',
  }),
  /nonregular-fixture\.svg must be a regular in-repository file/
)

expectFailure(
  'preserved-document-visual',
  (candidate) => {
    const entry = candidate.documents.find((item) => item.classification === 'frozen-evidence')
    delete entry.exemption
    entry.visuals = [firstVisual.visuals[0]]
  },
  /is preserved and must be exempt/
)

console.log(
  `OK: Markdown visual coverage self-test rejected ${rejectedMutations} invalid policy mutations`
)
