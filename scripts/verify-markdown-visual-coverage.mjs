#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, extname, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_MANIFEST = 'docs/markdown-visual-coverage.json'

const ALT_TEXT_MIN_CHARACTERS = 20
const ALT_TEXT_MAX_CHARACTERS = 100
const ALT_TEXT_MIN_WORDS = 3
const TEXT_ALTERNATIVE_MIN_CHARACTERS = 80
const TEXT_ALTERNATIVE_MAX_CHARACTERS = 800
const TEXT_ALTERNATIVE_MIN_WORDS = 12

const CLASSIFICATIONS = new Set([
  'active-technical',
  'frozen-evidence',
  'generated-output',
  'historical-record',
  'legal-community',
  'project-process',
  'vendored-upstream',
])

const PRESERVED_CLASSIFICATIONS = new Set([
  'frozen-evidence',
  'generated-output',
  'historical-record',
  'legal-community',
  'vendored-upstream',
])

function fail(message) {
  throw new Error(`Markdown visual coverage verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function toRepoPath(root, path) {
  const absolute = resolve(root, path)
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  assert(absolute === root || absolute.startsWith(rootPrefix), `path escapes repository: ${path}`)
  return absolute
}

function normalizeRepoPath(path) {
  const normalized = posix.normalize(path.replaceAll('\\', '/'))
  assert(
    normalized !== '..' && !normalized.startsWith('../') && !posix.isAbsolute(normalized),
    `invalid repository path: ${path}`
  )
  return normalized
}

function isContainedRegularFile(root, path) {
  try {
    const absolute = toRepoPath(root, path)
    const metadata = lstatSync(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false
    const realRoot = realpathSync(root)
    const realPath = realpathSync(absolute)
    const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    return realPath.startsWith(rootPrefix)
  } catch {
    return false
  }
}

function listTracked(root, pattern) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '--', pattern], {
    encoding: 'utf8',
  })
  return output
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .sort()
}

function listDiagramAssets(root) {
  const diagramRoot = resolve(root, 'assets/diagrams')
  if (!existsSync(diagramRoot)) return []
  return readdirSync(diagramRoot, { withFileTypes: true })
    .filter((entry) => extname(entry.name).toLowerCase() === '.svg')
    .map((entry) => `assets/diagrams/${entry.name}`)
    .sort()
}

function readAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  return match?.[2] ?? null
}

function stripDestinationDecorators(destination) {
  const withoutTitle = destination.trim().replace(/\s+["'][^"']*["']\s*$/, '')
  const unwrapped =
    withoutTitle.startsWith('<') && withoutTitle.endsWith('>')
      ? withoutTitle.slice(1, -1)
      : withoutTitle
  return unwrapped.split(/[?#]/, 1)[0]
}

function resolveLocalSvg(docPath, destination) {
  const path = stripDestinationDecorators(destination)
  if (!path.toLowerCase().endsWith('.svg')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return null
  let decoded
  try {
    decoded = decodeURIComponent(path)
  } catch {
    fail(`${docPath} contains an invalid URI-encoded image path: ${path}`)
  }
  return normalizeRepoPath(posix.join(posix.dirname(docPath), decoded))
}

function maskHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
}

function maskNonRenderedMarkdown(source) {
  const lines = maskHtmlComments(source).match(/[^\n]*(?:\n|$)/g) ?? []
  let fence = null
  const withoutFencedCode = lines
    .map((line) => {
      const body = line.replace(/\r?\n$/, '')
      if (fence) {
        const closing = body.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)
        if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
          fence = null
        }
        return line.replace(/[^\r\n]/g, ' ')
      }

      const opening = body.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
      if (!opening) return line
      fence = { character: opening[1][0], length: opening[1].length }
      return line.replace(/[^\r\n]/g, ' ')
    })
    .join('')

  return withoutFencedCode.replace(/(`+)([^`\n]*?)\1/g, (code) => code.replace(/[^\r\n]/g, ' '))
}

function wordsIn(source) {
  return source.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) ?? []
}

function isMeaningfulConciseAltText(alt) {
  const normalized = alt.replace(/\s+/g, ' ').trim()
  const words = wordsIn(normalized)
  return (
    normalized === alt &&
    normalized.length >= ALT_TEXT_MIN_CHARACTERS &&
    normalized.length <= ALT_TEXT_MAX_CHARACTERS &&
    words.length >= ALT_TEXT_MIN_WORDS &&
    !/[<>\[\]{}]/.test(normalized)
  )
}

export function collectLocalSvgReferences(docPath, source) {
  const references = []
  const visibleSource = maskNonRenderedMarkdown(source)

  const markdownImage = /!\[([^\]]*)\]\(([^)]+)\)/g
  for (const match of visibleSource.matchAll(markdownImage)) {
    const asset = resolveLocalSvg(docPath, match[2])
    if (asset) {
      references.push({
        asset,
        alt: match[1].trim(),
        index: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  const htmlImage = /<img\b[^>]*>/gi
  for (const match of visibleSource.matchAll(htmlImage)) {
    const src = readAttribute(match[0], 'src')
    const asset = src ? resolveLocalSvg(docPath, src) : null
    if (asset) {
      references.push({
        asset,
        alt: (readAttribute(match[0], 'alt') ?? '').trim(),
        index: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return references.sort((left, right) => left.index - right.index)
}

function collectLocalDiagramPaths(docPath, source) {
  const pathPattern = /(?:\.\.\/|\.\/)*assets\/diagrams\/[a-z0-9._~%+-]+\.svg(?:[?#][^\s"'<>)]*)?/gi
  return [...maskNonRenderedMarkdown(source).matchAll(pathPattern)].map((match) =>
    resolveLocalSvg(docPath, match[0])
  )
}

function collectDiagramAssets(
  docPath,
  source,
  imageReferences = collectLocalSvgReferences(docPath, source)
) {
  return new Set([
    ...collectLocalDiagramPaths(docPath, source),
    ...imageReferences
      .map((reference) => reference.asset)
      .filter((asset) => asset.startsWith('assets/diagrams/')),
  ])
}

function adjacentTextAlternative(source, reference) {
  const window = maskNonRenderedMarkdown(source).slice(reference.end, reference.end + 2000)
  const nextImage = window.search(/(?:<img\b|!\[)/i)
  const nextHeading = window.search(/\n#{1,6}\s+/)
  const boundaries = [nextImage, nextHeading].filter((index) => index >= 0)
  const section = window.slice(0, boundaries.length > 0 ? Math.min(...boundaries) : undefined)
  const afterWrapper = section.replace(/^\s*(?:<\/(?:p|div|figure)>\s*)*/i, '')
  const firstBlock = afterWrapper.split(/\n[ \t]*\n/, 1)[0]
  const match = firstBlock.match(/^Text alternative:[ \t]*([\s\S]*?)\s*$/i)
  if (!match) return null

  const rawText = match[1].trim()
  if (/(?:^|\n)[ \t]*(?:```|~~~|#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s|\|)/.test(rawText)) {
    return null
  }

  const plainText = rawText
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const words = wordsIn(plainText)
  if (
    plainText.length < TEXT_ALTERNATIVE_MIN_CHARACTERS ||
    plainText.length > TEXT_ALTERNATIVE_MAX_CHARACTERS ||
    words.length < TEXT_ALTERNATIVE_MIN_WORDS ||
    !/[.!?]["')\]]*$/.test(plainText)
  ) {
    return null
  }

  return plainText
}

function countTextAlternativeLabels(source) {
  return [...maskNonRenderedMarkdown(source).matchAll(/(?:^|\n)[ \t]*Text alternative:/gi)].length
}

function verifySvgAccessibility(path, source) {
  const rootTag = source.match(/<svg\b[^>]*>/i)?.[0]
  assert(rootTag, `${path} has no SVG root element`)
  assert(readAttribute(rootTag, 'role') === 'img', `${path} must use role="img"`)
  assert(readAttribute(rootTag, 'viewBox'), `${path} must define a viewBox`)

  const labelledBy = (readAttribute(rootTag, 'aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
  assert(labelledBy.length === 2, `${path} must reference one title and one description`)

  const title = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const description = source.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/i)
  assert(title, `${path} must include a title`)
  assert(description, `${path} must include a description`)
  const titleId = readAttribute(title[0], 'id')
  const descriptionId = readAttribute(description[0], 'id')
  assert(title[1].replace(/<[^>]+>/g, '').trim(), `${path} title must not be empty`)
  assert(description[1].replace(/<[^>]+>/g, '').trim(), `${path} description must not be empty`)
  assert(titleId !== descriptionId, `${path} title and description IDs must be distinct`)
  assert(titleId && labelledBy.includes(titleId), `${path} title must be in aria-labelledby`)
  assert(
    descriptionId && labelledBy.includes(descriptionId),
    `${path} description must be in aria-labelledby`
  )

  assert(!/<script\b/i.test(source), `${path} must not contain scripts`)
  assert(!/<foreignObject\b/i.test(source), `${path} must not contain foreignObject`)
  assert(!/<(?:image|feImage)\b/i.test(source), `${path} must not embed image resources`)
  assert(!/<!DOCTYPE\b|<!ENTITY\b/i.test(source), `${path} must not declare external entities`)
  assert(!/\son[a-z]+\s*=/i.test(source), `${path} must not contain event handlers`)
  assert(!/@import\b/i.test(source), `${path} must not import stylesheets`)
  assert(!/\bvar\s*\(/i.test(source), `${path} must not depend on CSS variables`)
  for (const match of source.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) {
    assert(match[2].trim().startsWith('#'), `${path} must not load external resources`)
  }
  for (const match of source.matchAll(/\burl\s*\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    assert(match[2].trim().startsWith('#'), `${path} must not load external or data URL resources`)
  }

  const ids = [...source.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2])
  assert(new Set(ids).size === ids.length, `${path} must not contain duplicate IDs`)
}

function validateManifestShape(manifest) {
  assert(manifest?.schema_version === 1, 'manifest schema_version must be 1')
  assert(
    typeof manifest.policy === 'string' && manifest.policy.trim().length >= 80,
    'manifest needs a specific visual-coverage policy'
  )
  assert(Array.isArray(manifest.documents), 'manifest documents must be an array')
  assert(manifest.documents.length > 0, 'manifest documents must not be empty')

  const paths = manifest.documents.map((entry) => entry?.path)
  assert(
    paths.every((path) => typeof path === 'string' && path.length > 0),
    'every entry needs a path'
  )
  assert(new Set(paths).size === paths.length, 'manifest contains duplicate document paths')
  assert(
    paths.every((path, index) => index === 0 || paths[index - 1] < path),
    'manifest document paths must use strict lexical order'
  )
}

export function verifyMarkdownVisualCoverage({
  root = DEFAULT_ROOT,
  manifest = JSON.parse(readFileSync(resolve(root, DEFAULT_MANIFEST), 'utf8')),
  trackedMarkdown = listTracked(root, '*.md'),
  diagramAssets = listDiagramAssets(root),
  readText = (path) => readFileSync(toRepoPath(root, path), 'utf8'),
  pathExists = (path) => existsSync(toRepoPath(root, path)),
  pathIsRegular = (path) => isContainedRegularFile(root, path),
} = {}) {
  validateManifestShape(manifest)

  const trackedSet = new Set(trackedMarkdown)
  const entries = new Map(manifest.documents.map((entry) => [entry.path, entry]))
  const missing = trackedMarkdown.filter((path) => !entries.has(path))
  const stale = [...entries.keys()].filter((path) => !trackedSet.has(path))
  assert(missing.length === 0, `unclassified tracked Markdown: ${missing.join(', ')}`)
  assert(stale.length === 0, `manifest lists untracked Markdown: ${stale.join(', ')}`)

  const referencedDiagrams = new Set()
  let visualDocuments = 0
  let exemptDocuments = 0

  for (const path of trackedMarkdown) {
    assert(pathIsRegular(path), `${path} must be a regular in-repository file`)
    const entry = entries.get(path)
    assert(CLASSIFICATIONS.has(entry.classification), `${path} has an invalid classification`)
    const hasVisuals = Array.isArray(entry.visuals) && entry.visuals.length > 0
    const hasExemption = entry.exemption !== undefined
    assert(hasVisuals !== hasExemption, `${path} must have visuals or one exemption, not both`)

    if (PRESERVED_CLASSIFICATIONS.has(entry.classification)) {
      assert(hasExemption, `${path} is preserved and must be exempt from visual edits`)
    }

    if (hasExemption) {
      assert(
        typeof entry.exemption?.kind === 'string' && entry.exemption.kind.trim().length > 0,
        `${path} exemption needs a kind`
      )
      assert(
        typeof entry.exemption?.reason === 'string' && entry.exemption.reason.trim().length >= 20,
        `${path} exemption needs a specific reason`
      )
      const diagrams = collectDiagramAssets(path, readText(path))
      assert(diagrams.size === 0, `${path} is exempt but references a technical diagram`)
      exemptDocuments += 1
      continue
    }

    assert(
      entry.visuals.every((asset) => typeof asset === 'string'),
      `${path} visuals must contain asset paths`
    )
    assert(new Set(entry.visuals).size === entry.visuals.length, `${path} repeats a visual asset`)

    const source = readText(path)
    const references = collectLocalSvgReferences(path, source)
    const declaredAssets = new Set(entry.visuals.map(normalizeRepoPath))
    const actualAssets = collectDiagramAssets(path, source, references)
    const diagramReferences = references.filter((reference) =>
      reference.asset.startsWith('assets/diagrams/')
    )
    const undeclared = [...actualAssets].filter((asset) => !declaredAssets.has(asset))
    assert(
      undeclared.length === 0,
      `${path} references undeclared diagrams: ${undeclared.join(', ')}`
    )
    for (const rawAsset of entry.visuals) {
      const asset = normalizeRepoPath(rawAsset)
      assert(asset.startsWith('assets/diagrams/'), `${path} uses a non-diagram visual: ${asset}`)
      assert(pathExists(asset), `${path} references a missing visual: ${asset}`)
      assert(pathIsRegular(asset), `${asset} must be a regular in-repository file`)
      const matching = references.filter((reference) => reference.asset === asset)
      assert(matching.length === 1, `${path} must reference ${asset} exactly once`)
      assert(
        isMeaningfulConciseAltText(matching[0].alt),
        `${path} needs meaningful, concise alt text for ${asset}`
      )
      assert(
        adjacentTextAlternative(source, matching[0]),
        `${path} needs an adjacent prose text alternative for ${asset}`
      )
      referencedDiagrams.add(asset)
    }
    assert(
      countTextAlternativeLabels(source) === diagramReferences.length,
      `${path} has orphan text-alternative labels without a diagram`
    )
    visualDocuments += 1
  }

  const normalizedDiagramAssets = diagramAssets.map(normalizeRepoPath)
  for (const asset of normalizedDiagramAssets) {
    assert(
      asset.startsWith('assets/diagrams/'),
      `diagram inventory contains a non-diagram path: ${asset}`
    )
    assert(pathIsRegular(asset), `${asset} must be a regular in-repository file`)
  }

  const orphaned = normalizedDiagramAssets.filter((asset) => !referencedDiagrams.has(asset))
  assert(orphaned.length === 0, `unreferenced diagram assets: ${orphaned.join(', ')}`)

  for (const asset of referencedDiagrams) verifySvgAccessibility(asset, readText(asset))

  return {
    documents: trackedMarkdown.length,
    visualDocuments,
    exemptDocuments,
    diagramAssets: referencedDiagrams.size,
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const result = verifyMarkdownVisualCoverage()
    console.log(
      `OK: ${result.documents} tracked Markdown files accounted for ` +
        `(${result.visualDocuments} visual, ${result.exemptDocuments} exempt; ` +
        `${result.diagramAssets} accessible diagram assets)`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
