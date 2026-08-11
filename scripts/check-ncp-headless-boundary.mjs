#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_MANIFEST = resolve(ROOT, 'src-tauri/Cargo.toml')
const PACKAGE_ROOT = resolve(ROOT, 'src-tauri/crates/ncp-headless')
const PACKAGE_MANIFEST = resolve(PACKAGE_ROOT, 'Cargo.toml')
const BRIDGE_SOURCE = resolve(ROOT, 'src-tauri/src/ncp/mod.rs')
const EXPECTED_PACKAGE = 'crebain-ncp-headless'
const EXPECTED_BINARY = 'crebain-ncp-headless'
const EXPECTED_RUNTIME_DEPENDENCIES = new Set([
  'ncp-core',
  'ncp-zenoh',
  'serde',
  'serde_json',
  'tokio',
  'zenoh',
])
const EXPECTED_DEV_DEPENDENCIES = new Set(['tempfile'])
const EXPECTED_NCP_FEATURE = new Set([
  'dep:ncp-core',
  'dep:ncp-zenoh',
  'dep:serde',
  'dep:serde_json',
  'dep:tokio',
  'dep:zenoh',
])
const FORBIDDEN_SOURCE_TOKENS = [
  'ActionBuffer',
  'CommandFrame',
  'CommandPlant',
  'SensorFrame',
  'VelocityCmd',
  'candle_core',
  'candle_nn',
  'crebain_lib',
  'crebain_plant_authority',
  'image',
  'ort',
  'open_realm',
  'publish_sensor',
  'put_sensor',
  'subscribe_commands',
  'tauri',
  'QuietDevelopment',
]
const FORBIDDEN_DEPENDENCY_CLOSURE = new Set([
  'candle-core',
  'candle-nn',
  'crebain',
  'crebain-plant-authority',
  'image',
  'ort',
  'tauri',
])

function fail(message) {
  throw new Error(`Headless NCP boundary check failed: ${message}`)
}

function compareSets(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort()
  const extra = [...actual].filter((value) => !expected.has(value)).sort()
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${label} drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`
    )
  }
}

function sectionName(line) {
  const match = line.trim().match(/^\[([^\]]+)\]$/)
  return match?.[1] ?? null
}

function dependencyKeys(manifestSource) {
  const runtime = new Set()
  const development = new Set()
  const build = new Set()
  let section = null
  for (const line of manifestSource.split(/\r?\n/u)) {
    const nextSection = sectionName(line)
    if (nextSection !== null) {
      section = nextSection
      continue
    }
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u)
    if (match === null) continue
    if (section === 'dependencies') runtime.add(match[1])
    else if (section === 'dev-dependencies') development.add(match[1])
    else if (section === 'build-dependencies' || section?.endsWith('.build-dependencies')) {
      build.add(match[1])
    } else if (section?.endsWith('.dependencies')) {
      runtime.add(match[1])
    }
  }
  return { runtime, development, build }
}

function tableBody(manifestSource, header) {
  const startPattern = new RegExp(
    `^\\[${header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*$`,
    'mu'
  )
  const match = startPattern.exec(manifestSource)
  if (match === null) fail(`[${header}] is missing`)
  const start = match.index + match[0].length
  const remaining = manifestSource.slice(start)
  const next = remaining.search(/^\s*\[/mu)
  return next === -1 ? remaining : remaining.slice(0, next)
}

function arrayValue(table, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'mu').exec(table)
  if (match === null) fail(`${key} array is missing`)
  return new Set([...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]))
}

export function assertHeadlessManifestBoundary(manifestSource) {
  const dependencies = dependencyKeys(manifestSource)
  compareSets(dependencies.runtime, EXPECTED_RUNTIME_DEPENDENCIES, 'runtime dependency set')
  compareSets(dependencies.development, EXPECTED_DEV_DEPENDENCIES, 'development dependency set')
  if (dependencies.build.size > 0) {
    fail(`build dependencies are forbidden: ${[...dependencies.build].sort().join(', ')}`)
  }
  const packageTable = tableBody(manifestSource, 'package')
  const buildSetting = /^\s*build\s*=\s*(.+?)\s*$/mu.exec(packageTable)?.[1]
  if (buildSetting !== undefined && buildSetting !== 'false') {
    fail('custom package build scripts are forbidden')
  }

  const features = tableBody(manifestSource, 'features')
  compareSets(arrayValue(features, 'default'), new Set(), 'default feature set')
  compareSets(arrayValue(features, 'ncp'), EXPECTED_NCP_FEATURE, 'ncp feature set')

  const binary = tableBody(manifestSource, '[bin]')
  if (!/^\s*name\s*=\s*"crebain-ncp-headless"\s*$/mu.test(binary)) {
    fail(`binary must be named ${EXPECTED_BINARY}`)
  }
  compareSets(arrayValue(binary, 'required-features'), new Set(['ncp']), 'binary feature gate')
  if (!/^\s*unsafe_code\s*=\s*"forbid"\s*$/mu.test(tableBody(manifestSource, 'lints.rust'))) {
    fail('manifest must forbid unsafe code')
  }
}

export function assertNoImplicitBuildScript(fileNames) {
  if (fileNames.includes('build.rs')) fail('implicit package build.rs is forbidden')
}

function rustRawStringEnd(source, index) {
  if (index > 0 && /[A-Za-z0-9_]/u.test(source[index - 1])) return null
  let cursor
  if (source.startsWith('br', index) || source.startsWith('cr', index)) cursor = index + 2
  else if (source[index] === 'r') cursor = index + 1
  else return null
  let hashes = 0
  while (source[cursor + hashes] === '#') hashes += 1
  if (source[cursor + hashes] !== '"') return null
  const terminator = `"${'#'.repeat(hashes)}`
  const closing = source.indexOf(terminator, cursor + hashes + 1)
  if (closing === -1) fail('unterminated Rust raw string')
  return closing + terminator.length
}

function rustCharacterEnd(source, index) {
  if (source[index] !== "'") return null
  let cursor = index + 1
  if (source[cursor] === '\\') {
    if (source[cursor + 1] === 'u' && source[cursor + 2] === '{') {
      const brace = source.indexOf('}', cursor + 3)
      if (brace === -1) return null
      cursor = brace + 1
    } else if (source[cursor + 1] === 'x') cursor += 4
    else cursor += 2
  } else {
    const codePoint = source.codePointAt(cursor)
    if (codePoint === undefined || source[cursor] === '\n') return null
    cursor += String.fromCodePoint(codePoint).length
  }
  return source[cursor] === "'" ? cursor + 1 : null
}

function blank(source, start, end) {
  return source.slice(start, end).replace(/[^\n]/gu, ' ')
}

function rustCode(source) {
  let output = ''
  let index = 0
  while (index < source.length) {
    const rawEnd = rustRawStringEnd(source, index)
    if (rawEnd !== null) {
      output += blank(source, index, rawEnd)
      index = rawEnd
      continue
    }
    const characterEnd = rustCharacterEnd(source, index)
    if (characterEnd !== null) {
      output += blank(source, index, characterEnd)
      index = characterEnd
      continue
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2)
      const end = newline === -1 ? source.length : newline
      output += blank(source, index, end)
      index = end
      continue
    }
    if (source.startsWith('/*', index)) {
      const start = index
      let depth = 1
      index += 2
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) {
          depth += 1
          index += 2
        } else if (source.startsWith('*/', index)) {
          depth -= 1
          index += 2
        } else index += 1
      }
      if (depth !== 0) fail('unterminated Rust block comment')
      output += blank(source, start, index)
      continue
    }
    if (source[index] === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < source.length) {
        const character = source[index]
        index += 1
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') break
      }
      if (source[index - 1] !== '"') fail('unterminated Rust string')
      output += blank(source, start, index)
      continue
    }
    output += source[index]
    index += 1
  }
  return output
}

export function assertHeadlessRustBoundary(path, source) {
  const code = rustCode(source)
  for (const token of FORBIDDEN_SOURCE_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, 'u').test(code)) {
      fail(`${path} contains forbidden source capability '${token}'`)
    }
  }
  if (/\bunsafe\b/u.test(code)) fail(`${path} contains unsafe Rust`)
  if (path.endsWith('src/lib.rs')) {
    const boundedSecureOpens = [
      ...code.matchAll(
        /\bZenohBus\s*::\s*with_config\s*\(\s*self\s*\.\s*config\s*\.\s*clone\s*\(\s*\)\s*,\s*keys\s*\)/gu
      ),
    ]
    if (boundedSecureOpens.length !== 1) {
      fail(`${path} must contain exactly one bounded ZenohBus::with_config connector`)
    }
    const strictValidations = [
      ...code.matchAll(
        /\bvalidate_secure_client_config\s*\(\s*&\s*secure_config\s*\.\s*config\s*\)/gu
      ),
    ]
    if (strictValidations.length !== 1) {
      fail(`${path} must validate exactly one bounded secure-config snapshot before opening`)
    }
    if (/\bZenohBus\s*::\s*open_secure\b/gu.test(code)) {
      fail(`${path} must not reopen NCP_ZENOH_CONFIG after bounded preflight`)
    }
  }
}

function rustFunctionBody(source, functionName) {
  const code = rustCode(source)
  const signature = new RegExp(`\\bpub\\s+async\\s+fn\\s+${functionName}\\b`, 'u').exec(code)
  if (signature === null) fail(`NcpBridge::${functionName} is missing`)
  const bodyStart = code.indexOf('{', signature.index + signature[0].length)
  if (bodyStart === -1) fail(`NcpBridge::${functionName} has no body`)

  let depth = 0
  for (let index = bodyStart; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1
    else if (code[index] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(bodyStart + 1, index)
    }
  }
  fail(`NcpBridge::${functionName} has an unterminated body`)
}

function assertCallsBefore(body, functionName, requiredCalls, guardedCall) {
  const guardedIndex = body.search(guardedCall)
  if (guardedIndex === -1) fail(`NcpBridge::${functionName} is missing its lifecycle lock`)
  for (const [label, pattern] of requiredCalls) {
    const validationIndex = body.search(pattern)
    if (validationIndex === -1) {
      fail(`NcpBridge::${functionName} is missing ${label} validation`)
    }
    if (validationIndex > guardedIndex) {
      fail(`NcpBridge::${functionName} must perform ${label} validation before lifecycle locking`)
    }
  }
}

export function assertBridgeDelegationValidationOrder(source) {
  const sessionValidation = /\bvalidate_session_id\s*\(\s*session_id\s*\)\s*\?/u
  const lifecycleLock = /\bself\s*\.\s*lifecycle_lock\s*\(\s*session_id\s*\)\s*\?/u
  assertCallsBefore(
    rustFunctionBody(source, 'open_feature_neuron'),
    'open_feature_neuron',
    [
      ['session ID', sessionValidation],
      ['model', /\bvalidate_model_name\s*\(\s*model\s*\)\s*\?/u],
    ],
    lifecycleLock
  )
  assertCallsBefore(
    rustFunctionBody(source, 'step_feature_neuron'),
    'step_feature_neuron',
    [
      ['session ID', sessionValidation],
      ['step input', /\bvalidate_step_inputs\s*\(\s*drive_pa\s*,\s*advance_ms\s*\)\s*\?/u],
    ],
    lifecycleLock
  )
  assertCallsBefore(
    rustFunctionBody(source, 'close'),
    'close',
    [['session ID', sessionValidation]],
    lifecycleLock
  )
}

function walkRustFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) fail(`symbolic links are forbidden: ${relative(ROOT, path)}`)
    if (entry.isDirectory()) files.push(...walkRustFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path)
  }
  return files.sort()
}

function cargoMetadata() {
  try {
    return JSON.parse(
      execFileSync(
        'cargo',
        [
          'metadata',
          '--locked',
          '--format-version',
          '1',
          '--no-deps',
          '--manifest-path',
          WORKSPACE_MANIFEST,
        ],
        { cwd: ROOT, encoding: 'utf8' }
      )
    )
  } catch (error) {
    fail(`cargo metadata failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function assertMetadataDependencyBoundary(dependencies) {
  const byKind = {
    build: new Set(),
    development: new Set(),
    runtime: new Set(),
  }
  for (const dependency of dependencies) {
    const kind =
      dependency.kind === null
        ? 'runtime'
        : dependency.kind === 'dev'
          ? 'development'
          : dependency.kind === 'build'
            ? 'build'
            : null
    if (kind === null) fail(`unknown Cargo dependency kind '${dependency.kind}'`)
    if (dependency.rename !== null) {
      fail(`dependency aliases are forbidden: ${dependency.rename} resolves to ${dependency.name}`)
    }
    if (dependency.target !== null) {
      fail(`target-specific dependency is forbidden: ${dependency.name}`)
    }
    const shouldBeOptional = kind === 'runtime'
    if (dependency.optional !== shouldBeOptional) {
      fail(
        `${kind} dependency ${dependency.name} must${shouldBeOptional ? '' : ' not'} be optional`
      )
    }
    byKind[kind].add(dependency.name)
  }
  compareSets(byKind.runtime, EXPECTED_RUNTIME_DEPENDENCIES, 'metadata runtime dependency set')
  compareSets(byKind.development, EXPECTED_DEV_DEPENDENCIES, 'metadata development dependency set')
  compareSets(byKind.build, new Set(), 'metadata build dependency set')
}

function verifyMetadata() {
  const metadata = cargoMetadata()
  const packageEntry = metadata.packages.find(
    (entry) => realpathSync(entry.manifest_path) === realpathSync(PACKAGE_MANIFEST)
  )
  if (packageEntry === undefined) fail('workspace package is missing from cargo metadata')
  if (packageEntry.name !== EXPECTED_PACKAGE) fail(`package must be named ${EXPECTED_PACKAGE}`)
  assertMetadataDependencyBoundary(packageEntry.dependencies)
  if (packageEntry.targets.some((target) => target.kind.includes('custom-build'))) {
    fail('Cargo metadata contains a custom-build target')
  }
  if (packageEntry.features.default?.length !== 0) fail('Cargo default feature set must be empty')
  compareSets(
    new Set(packageEntry.features.ncp ?? []),
    EXPECTED_NCP_FEATURE,
    'metadata ncp feature'
  )
  const binary = packageEntry.targets.find((target) => target.kind.includes('bin'))
  if (binary?.name !== EXPECTED_BINARY) fail(`metadata binary must be named ${EXPECTED_BINARY}`)
  const requiredFeatures = binary['required-features'] ?? []
  if (!requiredFeatures.includes('ncp') || requiredFeatures.length !== 1) {
    fail('metadata binary must require only the ncp feature')
  }
}

function verifyDependencyClosure() {
  let tree
  try {
    tree = execFileSync(
      'cargo',
      [
        'tree',
        '--locked',
        '--manifest-path',
        WORKSPACE_MANIFEST,
        '-p',
        EXPECTED_PACKAGE,
        '--features',
        'ncp',
        '--edges',
        'normal',
        '--prefix',
        'none',
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
  } catch (error) {
    fail(`cargo tree failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const packages = new Set(
    tree
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Za-z0-9_-]+)\s+v/u)?.[1])
      .filter(Boolean)
  )
  const forbidden = [...FORBIDDEN_DEPENDENCY_CLOSURE].filter((name) => packages.has(name)).sort()
  if (forbidden.length > 0) fail(`forbidden dependency closure: ${forbidden.join(', ')}`)
}

export function verifyNcpHeadlessBoundary() {
  if (!existsSync(PACKAGE_MANIFEST)) fail('package manifest is missing')
  if (lstatSync(PACKAGE_MANIFEST).isSymbolicLink()) fail('package manifest must not be a symlink')
  assertHeadlessManifestBoundary(readFileSync(PACKAGE_MANIFEST, 'utf8'))
  assertNoImplicitBuildScript(readdirSync(PACKAGE_ROOT))
  for (const file of walkRustFiles(PACKAGE_ROOT)) {
    const canonical = realpathSync(file)
    const fromPackage = relative(realpathSync(PACKAGE_ROOT), canonical)
    if (fromPackage === '..' || fromPackage.startsWith('../')) {
      fail(`Rust source escapes package root: ${file}`)
    }
    assertHeadlessRustBoundary(relative(ROOT, file), readFileSync(file, 'utf8'))
  }
  assertBridgeDelegationValidationOrder(readFileSync(BRIDGE_SOURCE, 'utf8'))
  verifyMetadata()
  verifyDependencyClosure()
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  verifyNcpHeadlessBoundary()
  console.log(
    'OK: headless NCP boundary verified (empty defaults, strict-client-config opt-in, isolated dependency closure, no action/sensor/Tauri/plant imports)'
  )
}
