#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..')

const INVENTORY_PATH = 'docs/baselines/phase0-command-surfaces.json'
const HAZARDS_PATH = 'docs/baselines/phase0-hazards.json'
const ECOSYSTEM_PATH = 'docs/baselines/ecosystem-baseline.json'

const KNOWN_CLASSIFICATIONS = new Set([
  'production-authority',
  'telemetry',
  'evidence',
  'simulation-only',
  'maintenance-only',
  'forbidden',
])
const KNOWN_DOMAINS = new Set([
  'renderer',
  'ros_mavros',
  'zenoh_tauri',
  'gazebo',
  'local_sim',
  'dev_ncp',
  'native_ncp',
  'plant_authority',
])
const KNOWN_STATUSES = new Set([
  'registered',
  'live',
  'declared',
  'dormant-unregistered',
  'removed',
])
const KNOWN_DISPOSITIONS = new Set([
  'allowed',
  'read-only',
  'sole-authority',
  'excluded',
  'unregistered',
  'replace-with-typed-intent',
  'maintenance-only',
])
const KNOWN_HAZARD_STATUSES = new Set(['open', 'partial', 'controlled', 'accepted'])
const KNOWN_COMPLETION_LEVELS = new Set(['L0', 'L1', 'L2', 'L3', 'L4'])
const KNOWN_SEVERITIES = new Set(['P0', 'P1', 'P2'])
const KNOWN_CONTROL_STATUSES = new Set(['planned', 'partial', 'implemented', 'verified', 'retired'])
const KNOWN_EVIDENCE_STATUSES = new Set(['planned', 'partial', 'verified', 'unavailable'])
const KNOWN_SURFACE_TEST_STATUSES = new Set([
  'planned',
  'partial',
  'existing',
  'existing-component',
])
const KNOWN_UNSAFE_CONTROL_ACTIONS = new Set([
  'provided-when-unsafe',
  'omitted-when-required',
  'provided-too-early-or-late',
  'applied-too-long-or-stopped-too-soon',
])
const KNOWN_PROFILE_STATUSES = new Set([
  'current-capabilities-mixed',
  'not-implemented',
  'forbidden',
])
const REQUIRED_EXTERNAL_REPOSITORIES = new Set(['NCP', 'Haldir', 'Galadriel', 'pid-rs'])
const REQUIRED_PROFILES = new Set(['dev-sim', 'secure-sitl', 'hil', 'field'])
const REQUIRED_RELEASE_INVOCATION_FILES = new Set([
  'package.json',
  'src-tauri/tauri.conf.json',
  '.github/workflows/release.yml',
])
const REQUIRED_PRODUCTION_BOUNDARY_DIGEST_FILES = new Set([
  'package.json',
  'bun.lock',
  'vite.config.ts',
  'docs/baselines/phase0-command-surfaces.json',
  'scripts/verify-phase0-baseline.mjs',
  'scripts/check-production-authority-boundary.mjs',
  'scripts/test-production-authority-boundary.mjs',
  'scripts/fixtures/production-boundary-invalid-cases.json',
  'scripts/lib/production-vendor-boundary.mjs',
  'scripts/test-production-vendor-boundary.mjs',
])
const REQUIRED_ROUTE_PREFIXES = new Set(['mavros/', 'gazebo/', 'cmd/motor_speed/'])
const REQUIRED_GALADRIEL_EVIDENCE_ROUTES = new Set([
  'ncp://{realm}/session/{epoch}/sensor/galadriel-pid',
  'ncp://{realm}/session/{epoch}/sensor/galadriel-monitor',
])
const REQUIRED_PRODUCTION_ROOTS = new Set([
  'src',
  'src-tauri/src',
  'src-tauri/crates/plant-authority/src',
  'src-tauri/capabilities',
  'ros',
  'public',
])
const REQUIRED_PRODUCTION_CONFIGS = new Set([
  'index.html',
  'package.json',
  'bun.lock',
  'postcss.config.ts',
  'rust-toolchain.toml',
  'flake.nix',
  'flake.lock',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/crates/plant-authority/Cargo.toml',
  'src-tauri/build.rs',
  'src-tauri/deny.toml',
  'src-tauri/tauri.conf.json',
  'tsconfig.json',
  'vite.config.ts',
  'scripts/check-bundle-size.mjs',
  'scripts/check-plant-authority-boundary.mjs',
  'scripts/check-production-authority-boundary.mjs',
  'scripts/lib/production-vendor-boundary.mjs',
  'scripts/test-production-authority-boundary.mjs',
  'scripts/test-production-vendor-boundary.mjs',
])
const REQUIRED_PRODUCTION_EXTENSIONS = new Set([
  '.action',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.launch',
  '.lock',
  '.mjs',
  '.msg',
  '.nix',
  '.proto',
  '.rs',
  '.srv',
  '.toml',
  '.ts',
  '.tsx',
  '.urdf',
  '.xml',
  '.yaml',
  '.yml',
])
const REQUIRED_DEVELOPMENT_NETWORK_MODULES = new Map([
  ['src/ros/ROSBridge.ts', 'src/ros/ROSBridgeDisabled.ts'],
])
const REQUIRED_PRODUCTION_FETCH_MODULES = new Set(['src/lib/boundedFetch.ts'])
const FORBIDDEN_RENDERER_NETWORK_CAPABILITIES = new Set([
  'XMLHttpRequest',
  'EventSource',
  'WebTransport',
  'sendBeacon',
])
const PLANT_AUTHORITY_SOURCE_ROOT = 'src-tauri/crates/plant-authority/src/'
const PLANT_AUTHORITY_MANIFEST = 'src-tauri/crates/plant-authority/Cargo.toml'
const REQUIRED_CONDITIONAL_EXECUTABLE_INPUTS = new Map([
  ['.cargo/config.toml', 'cargo'],
  ['.cargo/config', 'cargo'],
  ['src-tauri/crates/plant-authority/build.rs', 'cargo'],
  ['vite.config.js', 'vite'],
  ['vite.config.mjs', 'vite'],
  ['vite.config.cjs', 'vite'],
  ['vite.config.mts', 'vite'],
  ['vite.config.cts', 'vite'],
  ['vite.config.jsx', 'vite'],
  ['vite.config.tsx', 'vite'],
  ['.env', 'vite'],
  ['.env.local', 'vite'],
  ['.env.production', 'vite'],
  ['.env.production.local', 'vite'],
  ['.env.development', 'vite'],
  ['.env.development.local', 'vite'],
  ['.env.test', 'vite'],
  ['.env.test.local', 'vite'],
  ['src-tauri/tauri.macos.conf.json', 'tauri'],
  ['src-tauri/tauri.linux.conf.json', 'tauri'],
  ['src-tauri/tauri.windows.conf.json', 'tauri'],
  ['src-tauri/tauri.android.conf.json', 'tauri'],
  ['src-tauri/tauri.ios.conf.json', 'tauri'],
])
const NON_EXECUTABLE_ENV_EXAMPLES = new Set(['.env.example'])
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'window', 'self', 'top', 'parent'])
const DESCRIPTOR_METHODS = new Map([
  ['Object', new Set(['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors'])],
  ['Reflect', new Set(['getOwnPropertyDescriptor'])],
])
const REQUIRED_FORBIDDEN_CAPABILITIES = new Set([
  'callService',
  'call_service',
  'publish',
  'publishVehicleCommand',
  'publish_pose',
  'publish_twist_stamped',
  'publish_velocity',
  'sendCommand',
  'send_command',
  'spawn_gazebo_model',
  'transport_publish_pose',
  'transport_publish_twist_stamped',
  'transport_publish_velocity',
  'transport_spawn_gazebo_model',
])

function fail(message) {
  throw new Error(`Phase 0 baseline verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function assertExactVocabulary(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`)
  const actualSet = new Set(actual)
  assert(actualSet.size === actual.length, `${label} contains duplicates`)
  const missing = [...expected].filter((value) => !actualSet.has(value))
  const unknown = [...actualSet].filter((value) => !expected.has(value))
  assert(
    missing.length === 0 && unknown.length === 0,
    `${label} mismatch; missing=${missing.join(',') || '-'} unknown=${unknown.join(',') || '-'}`
  )
}

function assertString(value, label) {
  assert(typeof value === 'string' && value.trim().length > 0, `${label} is missing or empty`)
}

function assertSafeRelativePath(value, label) {
  assertString(value, label)
  assert(
    !value.startsWith('/') && !value.split('/').includes('..'),
    `${label} must be a safe relative path`
  )
}

function parseJsonFile(root, relativePath) {
  const path = resolve(root, relativePath)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(
      `${relativePath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function sourceReader(root, sourceOverrides) {
  return (relativePath) => {
    if (Object.hasOwn(sourceOverrides, relativePath)) return sourceOverrides[relativePath]
    const path = resolve(root, relativePath)
    assert(existsSync(path), `source file is missing: ${relativePath}`)
    return readFileSync(path, 'utf8')
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fileExtension(path) {
  const match = path.match(/(\.[A-Za-z0-9]+)$/)
  return match?.[1] ?? ''
}

function isProductionFile(path, extensions) {
  const segments = path.split('/')
  const name = segments.at(-1) ?? ''
  return (
    !segments.includes('__tests__') &&
    !segments.includes('test') &&
    !segments.includes('fixtures') &&
    !/\.(?:test|spec)\.[^.]+$/.test(name) &&
    extensions.has(fileExtension(path))
  )
}

export function walkFiles(root, relativeRoot) {
  const absoluteRoot = resolve(root, relativeRoot)
  assert(existsSync(absoluteRoot), `production scan root is missing: ${relativeRoot}`)
  const files = []
  const walk = (absoluteDirectory, relativeDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const relativePath = `${relativeDirectory}/${entry.name}`
      assert(!entry.isSymbolicLink(), `production scan rejects symbolic link: ${relativePath}`)
      if (entry.isDirectory()) walk(resolve(absoluteDirectory, entry.name), relativePath)
      else if (entry.isFile()) files.push(relativePath)
      else fail(`production scan encountered unsupported filesystem entry: ${relativePath}`)
    }
  }
  walk(absoluteRoot, relativeRoot)
  return files
}

function collectProductionFiles(root, scanPolicy, sourceOverrides) {
  assertExactVocabulary(
    scanPolicy.production_roots,
    REQUIRED_PRODUCTION_ROOTS,
    'scan_policy.production_roots'
  )
  assertExactVocabulary(
    scanPolicy.production_config_files,
    REQUIRED_PRODUCTION_CONFIGS,
    'scan_policy.production_config_files'
  )
  assertExactVocabulary(
    scanPolicy.production_extensions,
    REQUIRED_PRODUCTION_EXTENSIONS,
    'scan_policy.production_extensions'
  )
  const extensions = new Set(scanPolicy.production_extensions)
  const files = new Set(scanPolicy.production_config_files)
  for (const productionRoot of scanPolicy.production_roots) {
    assertSafeRelativePath(productionRoot, 'scan_policy.production_roots entry')
    for (const path of walkFiles(root, productionRoot)) {
      if (isProductionFile(path, extensions)) files.add(path)
    }
  }
  for (const path of Object.keys(sourceOverrides)) {
    const inProductionRoot = scanPolicy.production_roots.some(
      (productionRoot) => path === productionRoot || path.startsWith(`${productionRoot}/`)
    )
    if (inProductionRoot && isProductionFile(path, extensions)) files.add(path)
    if (scanPolicy.production_config_files.includes(path)) files.add(path)
  }
  return [...files].sort()
}

function verifyConditionalExecutableInputs(root, scanPolicy, sourceOverrides) {
  assert(
    Array.isArray(scanPolicy.conditional_executable_inputs),
    'scan_policy.conditional_executable_inputs must be an array'
  )
  const declared = new Map()
  for (const input of scanPolicy.conditional_executable_inputs) {
    assertSafeRelativePath(input?.path, 'conditional executable input path')
    assert(
      input.state === 'absent',
      `${input.path} conditional executable input state must be 'absent'`
    )
    assertString(input.consumer, `${input.path} conditional executable input consumer`)
    assert(!declared.has(input.path), `duplicate conditional executable input '${input.path}'`)
    declared.set(input.path, input.consumer)
  }
  compareSets(
    new Set([...declared].map(([path, consumer]) => `${path}\u0000${consumer}`)),
    new Set(
      [...REQUIRED_CONDITIONAL_EXECUTABLE_INPUTS].map(
        ([path, consumer]) => `${path}\u0000${consumer}`
      )
    ),
    'conditional executable input policy'
  )

  for (const path of REQUIRED_CONDITIONAL_EXECUTABLE_INPUTS.keys()) {
    assert(
      !existsSync(resolve(root, path)) && !Object.hasOwn(sourceOverrides, path),
      `conditional executable input expected absent: ${path}`
    )
  }

  const rootEnvInputs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('.env'))
    .map((entry) => entry.name)
  const overriddenEnvInputs = Object.keys(sourceOverrides).filter(
    (path) => !path.includes('/') && path.startsWith('.env')
  )
  for (const path of new Set([...rootEnvInputs, ...overriddenEnvInputs])) {
    assert(
      NON_EXECUTABLE_ENV_EXAMPLES.has(path) || REQUIRED_CONDITIONAL_EXECUTABLE_INPUTS.has(path),
      `undeclared root Vite environment input: ${path}`
    )
  }

  const rootViteConfigs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('vite.config.'))
    .map((entry) => entry.name)
  const overriddenViteConfigs = Object.keys(sourceOverrides).filter(
    (path) => !path.includes('/') && path.startsWith('vite.config.')
  )
  for (const path of new Set([...rootViteConfigs, ...overriddenViteConfigs])) {
    assert(
      path === 'vite.config.ts' || REQUIRED_CONDITIONAL_EXECUTABLE_INPUTS.has(path),
      `undeclared root Vite configuration input: ${path}`
    )
  }

  const tauriDirectory = resolve(root, 'src-tauri')
  const tauriPlatformConfigs = readdirSync(tauriDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('tauri.') && entry.name.endsWith('.conf.json'))
    .map((entry) => `src-tauri/${entry.name}`)
  const overriddenTauriConfigs = Object.keys(sourceOverrides).filter(
    (path) =>
      path.startsWith('src-tauri/tauri.') &&
      path.endsWith('.conf.json') &&
      !path.slice('src-tauri/'.length).includes('/')
  )
  for (const path of new Set([...tauriPlatformConfigs, ...overriddenTauriConfigs])) {
    assert(
      path === 'src-tauri/tauri.conf.json' || REQUIRED_CONDITIONAL_EXECUTABLE_INPUTS.has(path),
      `undeclared Tauri platform configuration input: ${path}`
    )
  }
}

function findMatchingBrace(source, openingBrace) {
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === "'") {
      // Rust lifetimes and labels (`'static`, `'a`, `'retry:`) are not character
      // literals. Treat an identifier after the apostrophe as a lifetime unless
      // it is immediately closed by another apostrophe (`'a'`). Without this,
      // one lifetime inside a cfg(test) module can hide its closing brace and
      // make the fail-closed production scan reject valid Rust.
      const lifetimeStart = /[A-Za-z_]/.test(next ?? '')
      if (lifetimeStart) {
        let end = index + 2
        while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end += 1
        if (source[end] !== "'") continue
      }
      quote = char
      continue
    }
    if (char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function stripRustTestItems(source) {
  let output = source
  const marker = '#[cfg(test)]'
  let start = output.indexOf(marker)
  while (start !== -1) {
    const openingBrace = output.indexOf('{', start + marker.length)
    const semicolon = output.indexOf(';', start + marker.length)
    let end
    if (semicolon !== -1 && (openingBrace === -1 || semicolon < openingBrace)) {
      end = semicolon + 1
    } else {
      assert(openingBrace !== -1, 'could not parse a #[cfg(test)] production-scan item')
      const closingBrace = findMatchingBrace(output, openingBrace)
      assert(closingBrace !== -1, 'could not match a #[cfg(test)] production-scan item')
      end = closingBrace + 1
    }
    output = `${output.slice(0, start)}${' '.repeat(end - start)}${output.slice(end)}`
    start = output.indexOf(marker, start + 1)
  }
  return output
}

function stripComments(source, rustSource = false) {
  let output = ''
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') {
        lineComment = false
        output += '\n'
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === '<' && source.slice(index, index + 4) === '<!--') {
      const close = source.indexOf('-->', index + 4)
      if (close === -1) return output
      index = close + 2
      continue
    }
    output += char
    if (char === '"' || char === '`') quote = char
    if (char === "'") {
      const rustLifetime = rustSource && /[A-Za-z_]/.test(next ?? '') && source[index + 2] !== "'"
      if (!rustLifetime) quote = char
    }
  }
  return output
}

function productionSource(path, source) {
  const withoutTests = path.endsWith('.rs') ? stripRustTestItems(source) : source
  return stripComments(withoutTests, path.endsWith('.rs'))
}

function rustBoundaryRawStringEnd(source, index) {
  if (index > 0 && /[A-Za-z0-9_]/.test(source[index - 1])) return null
  let cursor
  if (source.startsWith('br', index) || source.startsWith('cr', index)) cursor = index + 2
  else if (source[index] === 'r') cursor = index + 1
  else return null
  let hashes = 0
  while (source[cursor + hashes] === '#') hashes += 1
  if (source[cursor + hashes] !== '"') return null
  const terminator = `"${'#'.repeat(hashes)}`
  const closing = source.indexOf(terminator, cursor + hashes + 1)
  if (closing === -1) fail('unterminated Rust raw string in plant authority source')
  return closing + terminator.length
}

function blankRustBoundarySegment(source, start, end) {
  return source.slice(start, end).replace(/[^\n]/g, ' ')
}

function rustBoundaryCharLiteralEnd(source, index) {
  if (source[index] !== "'") return null
  let cursor = index + 1
  if (source[cursor] === '\\') {
    const escape = source[cursor + 1]
    if (escape === 'u' && source[cursor + 2] === '{') {
      const brace = source.indexOf('}', cursor + 3)
      if (brace === -1) return null
      cursor = brace + 1
    } else if (escape === 'x') cursor += 4
    else cursor += 2
  } else {
    const codePoint = source.codePointAt(cursor)
    if (codePoint === undefined || source[cursor] === '\n') return null
    cursor += String.fromCodePoint(codePoint).length
  }
  return source[cursor] === "'" ? cursor + 1 : null
}

function rustBoundaryCode(source) {
  let output = ''
  let index = 0
  while (index < source.length) {
    const rawEnd = rustBoundaryRawStringEnd(source, index)
    if (rawEnd !== null) {
      output += blankRustBoundarySegment(source, index, rawEnd)
      index = rawEnd
      continue
    }
    const charEnd = rustBoundaryCharLiteralEnd(source, index)
    if (charEnd !== null) {
      output += blankRustBoundarySegment(source, index, charEnd)
      index = charEnd
      continue
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      const next = end === -1 ? source.length : end
      output += blankRustBoundarySegment(source, index, next)
      index = next
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
      if (depth !== 0) fail('unterminated Rust block comment in plant authority source')
      output += blankRustBoundarySegment(source, start, index)
      continue
    }
    if (source[index] === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < source.length) {
        const char = source[index]
        index += 1
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') break
      }
      if (source[index - 1] !== '"') fail('unterminated Rust string in plant authority source')
      output += blankRustBoundarySegment(source, start, index)
      continue
    }
    output += source[index]
    index += 1
  }
  return output
}

function verifyPlantAuthorityRustBoundary(path, source) {
  const code = rustBoundaryCode(source)
  if (/\b(?:r#)?path\s*=/.test(code))
    fail(`plant authority external #[path] module is forbidden in ${path}`)
  if (/\b(?:include|include_str|include_bytes)\b/.test(code))
    fail(`plant authority include macro is forbidden in ${path}`)

  const runtimeBoundarySource = code.replace(
    /^\s*use\s+std\s*::\s*process\s*::\s*ExitCode\s*;\s*$/gm,
    ''
  )
  if (
    /\b(?:process|Command|Stdio|Child|net|TcpStream|TcpListener|UdpSocket|UnixStream|UnixListener|UnixDatagram|ToSocketAddrs)\b/.test(
      runtimeBoundarySource
    ) ||
    /\b(?:fs|File|OpenOptions|io|Write|write_all|os|AsRawFd|OwnedFd|RawFd|AsFd|BorrowedFd)\b/.test(
      runtimeBoundarySource
    )
  ) {
    fail(`plant authority process, network, or device I/O capability is forbidden in ${path}`)
  }
}

function verifyPlantAuthorityManifestBoundary(source) {
  if (/^\s*build\s*=\s*(?!false\b)/m.test(source))
    fail('plant authority custom build target is forbidden')
  if (/^\s*\[(?:dev-|build-)?dependencies\s*\]/m.test(source))
    fail('plant authority dependency section is forbidden')
  if (/^\s*\[features\s*\]/m.test(source)) fail('plant authority feature section is forbidden')
  if (/^\s*\[\[(?:example|bench)\s*\]\]/m.test(source))
    fail('plant authority unexpected Cargo target is forbidden')
  for (const match of source.matchAll(/^\s*path\s*=\s*["']([^"']+)["']/gm)) {
    const targetPath = match[1]
    if (targetPath.startsWith('/') || targetPath.split(/[\\/]/).includes('..'))
      fail(`plant authority Cargo target path escapes package root: ${targetPath}`)
  }
}

const SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx'])

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function staticArray(expression, bindings, seen = new Set()) {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null
    const initializer = bindings.get(current.text)
    if (!initializer) return null
    const nextSeen = new Set(seen)
    nextSeen.add(current.text)
    return staticArray(initializer, bindings, nextSeen)
  }
  if (!ts.isArrayLiteralExpression(current)) return null
  const values = []
  for (const element of current.elements) {
    if (ts.isSpreadElement(element)) return null
    const value = staticString(element, bindings, seen)
    if (value === null) return null
    values.push(value)
  }
  return values
}

function staticString(expression, bindings, seen = new Set()) {
  const current = unwrapExpression(expression)
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text
  }
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null
    const initializer = bindings.get(current.text)
    if (!initializer) return null
    const nextSeen = new Set(seen)
    nextSeen.add(current.text)
    return staticString(initializer, bindings, nextSeen)
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(current.left, bindings, seen)
    const right = staticString(current.right, bindings, seen)
    return left === null || right === null ? null : left + right
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text
    for (const span of current.templateSpans) {
      const substitution = staticString(span.expression, bindings, seen)
      if (substitution === null) return null
      value += substitution + span.literal.text
    }
    return value
  }
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === 'join'
  ) {
    const values = staticArray(current.expression.expression, bindings, seen)
    if (!values || current.arguments.length > 1) return null
    const separator =
      current.arguments.length === 0 ? ',' : staticString(current.arguments[0], bindings, seen)
    return separator === null ? null : values.join(separator)
  }
  return null
}

function memberName(expression, bindings) {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text
  if (ts.isPropertyAccessExpression(current)) return current.name.text
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, bindings)
  }
  return null
}

function resolvedObjectName(expression, bindings, seen = new Set()) {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null
    const initializer = bindings.get(current.text)
    if (!initializer) return current.text
    const nextSeen = new Set(seen)
    nextSeen.add(current.text)
    return resolvedObjectName(initializer, bindings, nextSeen)
  }
  return memberName(current, bindings)
}

function resolvedExpression(expression, bindings, seen = new Set()) {
  const current = unwrapExpression(expression)
  if (!ts.isIdentifier(current)) return current
  if (seen.has(current.text)) return current
  const initializer = bindings.get(current.text)
  if (!initializer) return current
  const nextSeen = new Set(seen)
  nextSeen.add(current.text)
  return resolvedExpression(initializer, bindings, nextSeen)
}

function isGlobalObject(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (GLOBAL_OBJECT_NAMES.has(resolvedObjectName(current, bindings))) return true
  return (
    (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
    memberName(current, bindings) === 'defaultView' &&
    resolvedObjectName(current.expression, bindings) === 'document'
  )
}

function resolvedMethod(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (
    ts.isCallExpression(current) &&
    (ts.isPropertyAccessExpression(current.expression) ||
      ts.isElementAccessExpression(current.expression)) &&
    memberName(current.expression, bindings) === 'bind'
  ) {
    return resolvedMethod(current.expression.expression, bindings)
  }
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return null
  }
  return {
    owner: resolvedObjectName(current.expression, bindings),
    name: memberName(current, bindings),
  }
}

function descriptorMethod(expression, bindings) {
  const method = resolvedMethod(expression, bindings)
  return method && DESCRIPTOR_METHODS.get(method.owner)?.has(method.name) ? method : null
}

function descriptorInvocationTarget(node, bindings) {
  let method = descriptorMethod(node.expression, bindings)
  let args = [...node.arguments]
  const callee = resolvedExpression(node.expression, bindings)
  if (!method && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
    const wrapper = memberName(callee, bindings)
    if (wrapper === 'call' || wrapper === 'apply') {
      method = descriptorMethod(callee.expression, bindings)
      if (wrapper === 'call') args = args.slice(1)
      else {
        const applied = args[1] ? resolvedExpression(args[1], bindings) : null
        args = applied && ts.isArrayLiteralExpression(applied) ? [...applied.elements] : []
      }
    }
  }
  if (!method) return undefined
  return args[0] ?? null
}

function bindingElementName(element, bindings) {
  if (!element.propertyName) return ts.isIdentifier(element.name) ? element.name.text : null
  if (ts.isComputedPropertyName(element.propertyName)) {
    return staticString(element.propertyName.expression, bindings)
  }
  return ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
    ? element.propertyName.text
    : null
}

function objectLiteralPropertyName(property, bindings) {
  if (!property.name) return null
  if (ts.isComputedPropertyName(property.name)) {
    return staticString(property.name.expression, bindings)
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null
}

function dynamicConstructorKind(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (ts.isIdentifier(current) && current.text === 'Function') return 'Function'
  if (
    ts.isCallExpression(current) &&
    (ts.isPropertyAccessExpression(current.expression) ||
      ts.isElementAccessExpression(current.expression)) &&
    memberName(current.expression, bindings) === 'bind'
  ) {
    return dynamicConstructorKind(current.expression.expression, bindings)
  }
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return null
  }
  const name = memberName(current, bindings)
  if (name === 'call' || name === 'apply' || name === 'bind') {
    return dynamicConstructorKind(current.expression, bindings)
  }
  if (name === 'Function' && isGlobalObject(current.expression, bindings)) return 'Function'
  return name === 'constructor' ? 'callable.constructor' : null
}

function reflectMethod(expression, bindings) {
  const current = unwrapExpression(expression)
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return null
  }
  return resolvedObjectName(current.expression, bindings) === 'Reflect'
    ? memberName(current, bindings)
    : null
}

function sourceLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${line + 1}:${character + 1}`
}

function routeFromStaticValue(value, knownPrefixes) {
  for (const prefix of knownPrefixes) {
    const start = value.indexOf(prefix)
    if (start === -1) continue
    const route = value.slice(start).match(/^[A-Za-z0-9_*/.$\-{}<>]+/)?.[0]
    if (route) return normalizeKnownRoute(route)
  }
  return null
}

function analyzeScriptSource(relativePath, source, knownPrefixes, forbiddenCapabilities) {
  const kind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind)
  const bindings = new Map()
  const ambiguousBindings = new Set()
  const routes = new Set()
  const capabilities = new Set()
  const websocketReferences = []
  const fetchCalls = []
  const forbiddenNetworkReferences = []
  const directDevImports = []
  const unresolvedComputedCalls = []
  const dynamicCode = []
  const reflectiveCapabilities = []
  const capabilityRecovery = []

  const collectBindings = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (bindings.has(node.name.text) || ambiguousBindings.has(node.name.text)) {
        bindings.delete(node.name.text)
        ambiguousBindings.add(node.name.text)
      } else {
        bindings.set(node.name.text, node.initializer)
      }
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(sourceFile)
  const recoverableCapabilities = new Set([
    ...forbiddenCapabilities,
    'WebSocket',
    'fetch',
    ...FORBIDDEN_RENDERER_NETWORK_CAPABILITIES,
    'Function',
    'eval',
  ])

  const visit = (node) => {
    if (ts.isExpression(node)) {
      const value = staticString(node, bindings)
      if (value !== null) {
        const route = routeFromStaticValue(value, knownPrefixes)
        if (route) routes.add(route)
      }
    }

    if (ts.isCallExpression(node)) {
      const name = memberName(node.expression, bindings)
      if (name && forbiddenCapabilities.has(name)) {
        capabilities.add(`${relativePath}:${sourceLocation(sourceFile, node)}:${name}`)
      }
      if (name === 'fetch') fetchCalls.push(sourceLocation(sourceFile, node))
      if (name === 'WebSocket') websocketReferences.push(sourceLocation(sourceFile, node))
      if (name && FORBIDDEN_RENDERER_NETWORK_CAPABILITIES.has(name)) {
        forbiddenNetworkReferences.push(`${name}@${sourceLocation(sourceFile, node)}`)
      }
      if (ts.isElementAccessExpression(unwrapExpression(node.expression)) && name === null) {
        unresolvedComputedCalls.push(sourceLocation(sourceFile, node))
      }
      if (name === 'eval' || name === 'Function') dynamicCode.push(sourceLocation(sourceFile, node))
      const descriptorTarget = descriptorInvocationTarget(node, bindings)
      if (
        descriptorTarget !== undefined &&
        (descriptorTarget === null || isGlobalObject(descriptorTarget, bindings))
      ) {
        capabilityRecovery.push(sourceLocation(sourceFile, node))
      }
      if (dynamicConstructorKind(node.expression, bindings)) {
        dynamicCode.push(sourceLocation(sourceFile, node))
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      reflectMethod(node, bindings) === 'get'
    ) {
      reflectiveCapabilities.push(sourceLocation(sourceFile, node))
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      descriptorMethod(node, bindings)
    ) {
      capabilityRecovery.push(sourceLocation(sourceFile, node))
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      resolvedObjectName(node.initializer, bindings) === 'Reflect'
    ) {
      for (const element of node.name.elements) {
        const name = element.propertyName
          ? ts.isComputedPropertyName(element.propertyName)
            ? staticString(element.propertyName.expression, bindings)
            : ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
              ? element.propertyName.text
              : null
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null
        if (name === 'get') reflectiveCapabilities.push(sourceLocation(sourceFile, element))
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const owner = resolvedObjectName(node.initializer, bindings)
      const descriptorNames = DESCRIPTOR_METHODS.get(owner)
      if (descriptorNames) {
        for (const element of node.name.elements) {
          if (descriptorNames.has(bindingElementName(element, bindings))) {
            capabilityRecovery.push(sourceLocation(sourceFile, element))
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isGlobalObject(node.initializer, bindings)
    ) {
      for (const element of node.name.elements) {
        const name = bindingElementName(element, bindings)
        if (
          element.dotDotDotToken ||
          !ts.isIdentifier(element.name) ||
          (element.propertyName &&
            ts.isComputedPropertyName(element.propertyName) &&
            name === null) ||
          (name !== null && recoverableCapabilities.has(name))
        ) {
          capabilityRecovery.push(sourceLocation(sourceFile, element))
        }
      }
    }
    if (ts.isElementAccessExpression(node) && isGlobalObject(node.expression, bindings)) {
      const name = staticString(node.argumentExpression, bindings)
      if (name === null || (name !== null && recoverableCapabilities.has(name))) {
        capabilityRecovery.push(sourceLocation(sourceFile, node))
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(unwrapExpression(node.left)) &&
      isGlobalObject(node.right, bindings)
    ) {
      for (const property of unwrapExpression(node.left).properties) {
        const name = objectLiteralPropertyName(property, bindings)
        if (
          ts.isSpreadAssignment(property) ||
          (ts.isPropertyAssignment(property) &&
            ts.isObjectLiteralExpression(property.initializer)) ||
          (property.name && ts.isComputedPropertyName(property.name) && name === null) ||
          (name !== null && recoverableCapabilities.has(name))
        ) {
          capabilityRecovery.push(sourceLocation(sourceFile, property))
        }
      }
    }
    if (ts.isElementAccessExpression(node) && memberName(node, bindings) === 'WebSocket') {
      websocketReferences.push(sourceLocation(sourceFile, node))
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name
    ) {
      const name = ts.isComputedPropertyName(node.name)
        ? staticString(node.name.expression, bindings)
        : ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : null
      if (name && forbiddenCapabilities.has(name)) {
        capabilities.add(`${relativePath}:${sourceLocation(sourceFile, node)}:${name}`)
      }
    }
    if (ts.isNewExpression(node) && memberName(node.expression, bindings) === 'WebSocket') {
      websocketReferences.push(sourceLocation(sourceFile, node))
    }
    if (
      ts.isNewExpression(node) &&
      FORBIDDEN_RENDERER_NETWORK_CAPABILITIES.has(memberName(node.expression, bindings))
    ) {
      forbiddenNetworkReferences.push(
        `${memberName(node.expression, bindings)}@${sourceLocation(sourceFile, node)}`
      )
    }
    if (
      ts.isNewExpression(node) &&
      ts.isElementAccessExpression(unwrapExpression(node.expression)) &&
      memberName(node.expression, bindings) === null
    ) {
      unresolvedComputedCalls.push(sourceLocation(sourceFile, node))
    }
    if (ts.isNewExpression(node) && memberName(node.expression, bindings) === 'Function') {
      dynamicCode.push(sourceLocation(sourceFile, node))
    }
    if (ts.isNewExpression(node) && dynamicConstructorKind(node.expression, bindings)) {
      dynamicCode.push(sourceLocation(sourceFile, node))
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'WebSocket' &&
      !ts.isPropertyAccessExpression(node.parent) &&
      !ts.isPropertyAssignment(node.parent)
    ) {
      websocketReferences.push(sourceLocation(sourceFile, node))
    }
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      fetchCalls.push(sourceLocation(sourceFile, node))
    }
    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_RENDERER_NETWORK_CAPABILITIES.has(node.text) &&
      !ts.isPropertyAssignment(node.parent)
    ) {
      forbiddenNetworkReferences.push(`${node.text}@${sourceLocation(sourceFile, node)}`)
    }
    if (ts.isIdentifier(node) && (node.text === 'Function' || node.text === 'eval')) {
      dynamicCode.push(sourceLocation(sourceFile, node))
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberName(node, bindings) === 'constructor'
    ) {
      dynamicCode.push(sourceLocation(sourceFile, node))
    }
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|\/)ROSBridge(?:\.(?:ts|js))?$/.test(node.moduleSpecifier.text)
    ) {
      directDevImports.push(sourceLocation(sourceFile, node))
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      staticString(node.arguments[0], bindings)?.match(/(?:^|\/)ROSBridge(?:\.(?:ts|js))?$/)
    ) {
      directDevImports.push(sourceLocation(sourceFile, node))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return {
    routes,
    capabilities,
    websocketReferences,
    fetchCalls,
    forbiddenNetworkReferences,
    directDevImports,
    unresolvedComputedCalls,
    dynamicCode,
    reflectiveCapabilities,
    capabilityRecovery,
  }
}

function findMatchingSquareBracket(source, openingBracket) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openingBracket; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') depth += 1
    if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function extractTauriHandlers(source) {
  const macroOccurrences = [...source.matchAll(/\btauri::generate_handler!\s*\[/g)]
  assert(
    macroOccurrences.length === 1,
    `expected exactly one runtime Tauri generate_handler list, found ${macroOccurrences.length}`
  )
  const invokeOccurrences = [
    ...source.matchAll(/\.invoke_handler\s*\(\s*tauri::generate_handler!\s*\[/g),
  ]
  assert(
    invokeOccurrences.length === 1,
    `expected exactly one Tauri invoke_handler registration, found ${invokeOccurrences.length}`
  )
  const match = invokeOccurrences[0]
  const openingBracket = match.index + match[0].lastIndexOf('[')
  const closingBracket = findMatchingSquareBracket(source, openingBracket)
  assert(closingBracket !== -1, 'could not match the runtime Tauri generate_handler list')
  assert(
    /^\s*\)/.test(source.slice(closingBracket + 1)),
    'runtime Tauri generate_handler list is not the direct invoke_handler argument'
  )
  const handlers = source
    .slice(openingBracket + 1, closingBracket)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  for (const handler of handlers) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(handler), `invalid Tauri handler token '${handler}'`)
  }
  assert(
    new Set(handlers).size === handlers.length,
    'registered Tauri handler list contains duplicates'
  )
  return new Set(handlers)
}

function normalizeKnownRoute(match) {
  const normalized = match
    .replace(/^\/+/, '')
    .replace(/\$\{[^}]*\}|\{[^}]*\}|<[^>]*>/g, '{*}')
    .replace(/\/+$/, '')
  if (normalized.startsWith('cmd/motor_speed/')) return '/cmd/motor_speed/*'
  return `/${normalized}`
}

function extractKnownRoutes(source, knownPrefixes) {
  const routes = new Set()
  // Removing string delimiters, whitespace, and concatenation operators makes
  // `'/mav' + 'ros/cmd/arming'` visible to the same scan as a single literal.
  // A dynamic prefix variable is still caught as the incomplete `/mavros`
  // route and therefore fails inventory comparison.
  const collapsed = source.replace(/["'`\s+]/g, '')
  const prefixPattern = [...knownPrefixes].map(escapeRegex).join('|')
  const pattern = new RegExp(`(?:${prefixPattern})(?:[A-Za-z0-9_*/.$\\{}<>-]|\\$\\{[^}]*\\})*`, 'g')
  for (const match of collapsed.matchAll(pattern)) routes.add(normalizeKnownRoute(match[0]))
  return routes
}

function decodeRustStringLiteral(literal) {
  if (literal.startsWith('r')) {
    const firstQuote = literal.indexOf('"')
    const hashes = literal.slice(1, firstQuote)
    return literal.slice(firstQuote + 1, -(hashes.length + 1))
  }
  try {
    return JSON.parse(literal)
  } catch {
    return null
  }
}

function findMatchingParenthesis(source, openingParenthesis) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openingParenthesis; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"') {
      quote = char
      continue
    }
    if (char === "'") {
      const rustLifetime = /[A-Za-z_]/.test(next ?? '') && source[index + 2] !== "'"
      if (!rustLifetime) quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function extractRustMacroRoutes(source, knownPrefixes) {
  const routeBuildingMacros = new Set()
  const macroPattern = /\b(?:concat|format|format_args|stringify)!\s*\(/g
  const literalPattern = /r(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"/g
  const stringConstants = new Map()
  const constantPattern = /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*([^;]+);/g
  for (const declaration of source.matchAll(constantPattern)) {
    const literal = declaration[2].trim().match(/^(r(#+)?"[\s\S]*?"\2|"(?:\\.|[^"\\])*")$/)
    if (!literal) continue
    const value = decodeRustStringLiteral(literal[1])
    if (value !== null) stringConstants.set(declaration[1], value)
  }

  const routeLike = (value) => {
    const normalized = value.trim()
    if (normalized.startsWith('/')) return true
    if ([...knownPrefixes].some((prefix) => normalized.includes(prefix))) return true
    return /(?:^|\/)(?:mav(?:ros)?|ros|gazebo|cmd|motor_speed)(?:\/|$)/i.test(normalized)
  }

  for (const macro of source.matchAll(macroPattern)) {
    const openingParenthesis = macro.index + macro[0].lastIndexOf('(')
    const closingParenthesis = findMatchingParenthesis(source, openingParenthesis)
    assert(closingParenthesis !== -1, 'could not match a Rust route-building macro invocation')
    const body = source.slice(openingParenthesis + 1, closingParenthesis)
    const values = [...body.matchAll(literalPattern)]
      .map((match) => decodeRustStringLiteral(match[0]))
      .filter((value) => value !== null)
    const referencedConstants = [...stringConstants]
      .filter(([name]) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(body))
      .map(([, value]) => value)
    const signals = [...values, ...referencedConstants, values.join('')]
    if (signals.some(routeLike)) {
      routeBuildingMacros.add(`${macro[0].slice(0, macro[0].indexOf('!'))}!@${macro.index}`)
    }
  }
  return routeBuildingMacros
}

function verifyTestEvidence(inventory, getSource) {
  assert(Array.isArray(inventory.test_evidence), 'test_evidence must be an array')
  const registry = new Map()
  for (const evidence of inventory.test_evidence) {
    assertString(evidence?.id, 'test_evidence.id')
    assert(!registry.has(evidence.id), `duplicate test evidence '${evidence.id}'`)
    assert(
      evidence.locator && typeof evidence.locator === 'object',
      `${evidence.id}.locator is missing`
    )
    assertSafeRelativePath(evidence.locator.file, `${evidence.id}.locator.file`)
    assertString(evidence.locator.selector, `${evidence.id}.locator.selector`)
    const isCheckedTestSource =
      /(?:__tests__|\.(?:test|spec)\.|\.rs$)/.test(evidence.locator.file) ||
      evidence.locator.file === 'scripts/test-plant-frame-conventions.mjs'
    assert(isCheckedTestSource, `${evidence.id} locator is not a checked test source`)
    assert(
      getSource(evidence.locator.file).includes(evidence.locator.selector),
      `${evidence.id} selector not found in ${evidence.locator.file}`
    )
    for (const field of ['hazard_ids', 'control_ids']) {
      if (!Object.hasOwn(evidence, field)) continue
      assert(
        Array.isArray(evidence[field]) && evidence[field].length > 0,
        `${evidence.id}.${field} must be non-empty when declared`
      )
      assert(
        new Set(evidence[field]).size === evidence[field].length,
        `${evidence.id}.${field} contains duplicates`
      )
      for (const value of evidence[field]) assertString(value, `${evidence.id}.${field} entry`)
    }
    registry.set(evidence.id, evidence)
  }
  return registry
}

function compareSets(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort()
  const extra = [...actual].filter((value) => !expected.has(value)).sort()
  assert(
    missing.length === 0 && extra.length === 0,
    `${label} drift; missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`
  )
}

function verifyHazards(root, hazards, oddDocument, testEvidence, allowFixtureEvidence) {
  assert(hazards?.schema_version === 1, 'hazard schema_version must be 1')
  assertExactVocabulary(
    hazards.vocabularies?.completion_levels,
    KNOWN_COMPLETION_LEVELS,
    'hazard completion-level vocabulary'
  )
  assertExactVocabulary(
    hazards.vocabularies?.severities,
    KNOWN_SEVERITIES,
    'hazard severity vocabulary'
  )
  assertExactVocabulary(
    hazards.vocabularies?.hazard_statuses,
    KNOWN_HAZARD_STATUSES,
    'hazard status vocabulary'
  )
  assertExactVocabulary(
    hazards.vocabularies?.control_statuses,
    KNOWN_CONTROL_STATUSES,
    'control status vocabulary'
  )
  assertExactVocabulary(
    hazards.vocabularies?.evidence_statuses,
    KNOWN_EVIDENCE_STATUSES,
    'evidence status vocabulary'
  )
  assertExactVocabulary(
    hazards.vocabularies?.unsafe_control_actions,
    KNOWN_UNSAFE_CONTROL_ACTIONS,
    'unsafe-control-action vocabulary'
  )
  assert(
    hazards.current_completion_level === 'L0',
    `hazard current_completion_level must be L0, got '${hazards.current_completion_level}'`
  )
  assert(
    hazards.target_completion_level === 'L1',
    `hazard target_completion_level must be L1, got '${hazards.target_completion_level}'`
  )
  assertExactVocabulary(
    hazards.status_policy?.allowed,
    KNOWN_HAZARD_STATUSES,
    'status_policy.allowed'
  )
  assertExactVocabulary(
    hazards.status_policy?.l1_blocking,
    new Set(['open', 'partial']),
    'status_policy.l1_blocking'
  )
  assertExactVocabulary(
    hazards.status_policy?.acceptance_requires,
    new Set(['approver', 'rationale', 'scope', 'expiry']),
    'status_policy.acceptance_requires'
  )
  assert(
    Array.isArray(hazards.losses) && hazards.losses.length > 0,
    'hazard losses must be non-empty'
  )
  assert(
    Array.isArray(hazards.controls) && hazards.controls.length > 0,
    'hazard controls must be non-empty'
  )
  assert(Array.isArray(hazards.hazards) && hazards.hazards.length > 0, 'hazards must be non-empty')

  const lossIds = new Set()
  for (const loss of hazards.losses) {
    assertString(loss.id, 'loss.id')
    assert(/^LOSS-[0-9]{3}$/.test(loss.id), `invalid loss ID '${loss.id}'`)
    assert(!lossIds.has(loss.id), `duplicate loss ID '${loss.id}'`)
    lossIds.add(loss.id)
    assertString(loss.statement, `${loss.id}.statement`)
  }

  const controlsById = new Map()
  for (const control of hazards.controls) {
    assertString(control.id, 'control.id')
    assert(/^CTL-[0-9]{3}$/.test(control.id), `invalid control ID '${control.id}'`)
    assert(!controlsById.has(control.id), `duplicate control ID '${control.id}'`)
    controlsById.set(control.id, control)
    assertString(control.owner, `${control.id}.owner`)
    assert(
      KNOWN_CONTROL_STATUSES.has(control.status),
      `${control.id} has unknown control status '${control.status}'`
    )
    assertString(control.statement, `${control.id}.statement`)
  }

  const hazardIds = new Set()
  for (const hazard of hazards.hazards) {
    const required = [
      'id',
      'title',
      'severity',
      'status',
      'owner',
      'unsafe_control_actions',
      'loss_ids',
      'cause_categories',
      'control_ids',
      'odd_clauses',
      'evidence',
      'residual_risk',
    ]
    for (const field of required)
      assert(Object.hasOwn(hazard, field), `hazard is missing required field '${field}'`)
    assert(/^HAZ-[0-9]{3}$/.test(hazard.id), `invalid hazard ID '${hazard.id}'`)
    assert(!hazardIds.has(hazard.id), `duplicate hazard ID '${hazard.id}'`)
    hazardIds.add(hazard.id)
    assertString(hazard.title, `${hazard.id}.title`)
    assert(
      KNOWN_SEVERITIES.has(hazard.severity),
      `${hazard.id} has invalid severity '${hazard.severity}'`
    )
    assert(
      KNOWN_HAZARD_STATUSES.has(hazard.status),
      `${hazard.id} has unknown status '${hazard.status}'`
    )
    assertString(hazard.owner, `${hazard.id}.owner`)
    for (const field of [
      'unsafe_control_actions',
      'loss_ids',
      'cause_categories',
      'control_ids',
      'odd_clauses',
      'evidence',
    ]) {
      assert(
        Array.isArray(hazard[field]) && hazard[field].length > 0,
        `${hazard.id}.${field} must be non-empty`
      )
    }
    for (const action of hazard.unsafe_control_actions)
      assert(
        KNOWN_UNSAFE_CONTROL_ACTIONS.has(action),
        `${hazard.id} has unknown unsafe control action '${action}'`
      )
    for (const category of hazard.cause_categories)
      assertString(category, `${hazard.id}.cause_categories entry`)
    for (const lossId of hazard.loss_ids)
      assert(lossIds.has(lossId), `${hazard.id} references unknown loss '${lossId}'`)
    for (const controlId of hazard.control_ids)
      assert(controlsById.has(controlId), `${hazard.id} references unknown control '${controlId}'`)
    for (const clause of hazard.odd_clauses)
      assert(/^ODD-[0-9]{2}$/.test(clause), `${hazard.id} has invalid ODD clause '${clause}'`)
    for (const evidence of hazard.evidence) {
      assertString(evidence.test_id, `${hazard.id}.evidence.test_id`)
      assert(
        KNOWN_EVIDENCE_STATUSES.has(evidence.status),
        `${hazard.id} has unknown evidence status '${evidence.status}'`
      )
      assertString(evidence.artifact, `${hazard.id}.evidence.artifact`)
      if (evidence.status === 'verified') {
        const verification = evidence.verification
        assert(
          verification && typeof verification === 'object',
          `${hazard.id} verified evidence '${evidence.test_id}' verification is missing`
        )
        assert(
          verification.hazard_id === hazard.id,
          `${hazard.id} verified evidence '${evidence.test_id}' is bound to hazard '${verification.hazard_id}'`
        )
        assert(
          Array.isArray(verification.control_ids) && verification.control_ids.length > 0,
          `${hazard.id} verified evidence '${evidence.test_id}' control_ids must be non-empty`
        )
        assert(
          new Set(verification.control_ids).size === verification.control_ids.length,
          `${hazard.id} verified evidence '${evidence.test_id}' control_ids contains duplicates`
        )
        for (const controlId of verification.control_ids) {
          assert(
            hazard.control_ids.includes(controlId),
            `${hazard.id} verified evidence '${evidence.test_id}' references unrelated control '${controlId}'`
          )
        }
        assertString(
          verification.command,
          `${hazard.id} verified evidence '${evidence.test_id}'.verification.command`
        )
        assert(
          verification.result &&
            verification.result.outcome === 'passed' &&
            verification.result.exit_code === 0,
          `${hazard.id} verified evidence '${evidence.test_id}' result must be passed with exit_code 0`
        )
        assert(
          /^[0-9a-f]{40}$/.test(verification.candidate_commit) &&
            !/^0{40}$/.test(verification.candidate_commit),
          `${hazard.id} verified evidence '${evidence.test_id}' candidate_commit is not an immutable commit`
        )
        assertSafeRelativePath(
          verification.artifact_path,
          `${hazard.id} verified evidence '${evidence.test_id}'.verification.artifact_path`
        )
        assert(
          /^[0-9a-f]{64}$/.test(verification.artifact_sha256),
          `${hazard.id} verified evidence '${evidence.test_id}' artifact_sha256 is not SHA-256`
        )
        const artifactPath = resolve(root, verification.artifact_path)
        assert(
          existsSync(artifactPath),
          `${hazard.id} verified evidence artifact is missing: ${verification.artifact_path}`
        )
        const artifactBytes = readFileSync(artifactPath)
        const artifactHash = createHash('sha256').update(artifactBytes).digest('hex')
        assert(
          artifactHash === verification.artifact_sha256,
          `${hazard.id} verified evidence artifact hash mismatch for ${verification.artifact_path}`
        )
        let artifactRecord
        try {
          artifactRecord = JSON.parse(artifactBytes.toString('utf8'))
        } catch {
          fail(
            `${hazard.id} verified evidence artifact is not a typed JSON record: ${verification.artifact_path}`
          )
        }
        assert(
          artifactRecord?.schema_version === 1 &&
            artifactRecord.hazard_id === verification.hazard_id &&
            artifactRecord.command === verification.command &&
            artifactRecord.candidate_commit === verification.candidate_commit &&
            artifactRecord.result?.outcome === verification.result.outcome &&
            artifactRecord.result?.exit_code === verification.result.exit_code,
          `${hazard.id} verified evidence artifact binding does not match its verification record`
        )
        assert(
          artifactRecord.fixture_only !== true || allowFixtureEvidence,
          `${hazard.id} verified evidence cannot use a self-test fixture artifact`
        )
        compareSets(
          new Set(artifactRecord.control_ids ?? []),
          new Set(verification.control_ids),
          `${hazard.id} verified evidence artifact control binding`
        )
        const declaration = testEvidence.get(evidence.test_id)
        assert(
          declaration,
          `${hazard.id} verified evidence '${evidence.test_id}' has no checked test declaration`
        )
        assert(
          declaration.hazard_ids?.includes(hazard.id),
          `${hazard.id} verified evidence '${evidence.test_id}' test declaration is not bound to this hazard`
        )
        for (const controlId of verification.control_ids)
          assert(
            declaration.control_ids?.includes(controlId),
            `${hazard.id} verified evidence '${evidence.test_id}' test declaration is not bound to control '${controlId}'`
          )
      }
    }
    if (hazard.status === 'controlled') {
      for (const controlId of hazard.control_ids) {
        assert(
          controlsById.get(controlId).status === 'verified',
          `${hazard.id} is controlled but referenced control '${controlId}' is not verified`
        )
      }
      assert(
        hazard.evidence.every((evidence) => evidence.status === 'verified'),
        `${hazard.id} is controlled but not all evidence is verified`
      )
      compareSets(
        new Set(hazard.evidence.flatMap((evidence) => evidence.verification?.control_ids ?? [])),
        new Set(hazard.control_ids),
        `${hazard.id} controlled evidence-to-control coverage`
      )
    }
    if (hazard.status === 'accepted') {
      for (const field of ['approver', 'rationale', 'scope', 'expiry'])
        assertString(hazard[field], `${hazard.id}.${field}`)
    }
    assertString(hazard.residual_risk, `${hazard.id}.residual_risk`)
  }
  for (const declaration of testEvidence.values()) {
    for (const hazardId of declaration.hazard_ids ?? [])
      assert(
        hazardIds.has(hazardId),
        `${declaration.id} test declaration references unknown hazard '${hazardId}'`
      )
    for (const controlId of declaration.control_ids ?? [])
      assert(
        controlsById.has(controlId),
        `${declaration.id} test declaration references unknown control '${controlId}'`
      )
  }
  const documentedOddIds = new Set(oddDocument.match(/ODD-[0-9]{2}/g) ?? [])
  assert(documentedOddIds.size > 0, 'L1_ODD.md contains no ODD clause IDs')
  const referencedOddIds = new Set(hazards.hazards.flatMap((hazard) => hazard.odd_clauses))
  compareSets(referencedOddIds, documentedOddIds, 'hazard-to-ODD clause coverage')
  return hazardIds
}

function verifyInventory(root, inventory, hazardIds, getSource, sourceOverrides, testEvidence) {
  assert(inventory?.schema_version === 1, 'inventory schema_version must be 1')
  assert(
    inventory.current_completion_level === 'L0',
    `inventory current_completion_level must be L0, got '${inventory.current_completion_level}'`
  )
  assert(
    inventory.target_completion_level === 'L1',
    `inventory target_completion_level must be L1, got '${inventory.target_completion_level}'`
  )
  assert(
    inventory.profile_semantics?.current === 'audit-applicability-not-live-reachability' &&
      inventory.profile_semantics?.member_reachability ===
        'members[].status plus members[].source_assertion',
    'inventory profile_semantics must distinguish group applicability from member reachability'
  )
  assertExactVocabulary(
    inventory.classifications,
    KNOWN_CLASSIFICATIONS,
    'inventory classifications'
  )
  assertExactVocabulary(inventory.domains, KNOWN_DOMAINS, 'inventory domains')
  assertExactVocabulary(inventory.statuses, KNOWN_STATUSES, 'inventory statuses')
  assertExactVocabulary(
    inventory.secure_sitl_dispositions,
    KNOWN_DISPOSITIONS,
    'inventory secure_sitl_dispositions'
  )
  assert(
    Array.isArray(inventory.surface_groups) && inventory.surface_groups.length > 0,
    'surface_groups must be non-empty'
  )

  const groupIds = new Set()
  const surfaceIds = new Set()
  const referencedExistingTests = new Set()
  const surfaces = []
  for (const group of inventory.surface_groups) {
    const groupRequired = [
      'group_id',
      'domain',
      'kind',
      'classification',
      'owner',
      'profiles',
      'hazard_ids',
      'tests',
      'members',
    ]
    for (const field of groupRequired)
      assert(Object.hasOwn(group, field), `surface group is missing required field '${field}'`)
    assertString(group.group_id, 'surface group.group_id')
    assert(!groupIds.has(group.group_id), `duplicate group ID '${group.group_id}'`)
    groupIds.add(group.group_id)
    assert(
      KNOWN_DOMAINS.has(group.domain),
      `${group.group_id} has unknown domain '${group.domain}'`
    )
    assertString(group.kind, `${group.group_id}.kind`)
    assert(
      KNOWN_CLASSIFICATIONS.has(group.classification),
      `${group.group_id} has unknown classification '${group.classification}'`
    )
    assertString(group.owner, `${group.group_id}.owner`)
    assert(
      group.profiles && Array.isArray(group.profiles.current) && group.profiles.current.length > 0,
      `${group.group_id}.profiles.current must be non-empty`
    )
    assert(
      new Set(group.profiles.current).size === group.profiles.current.length,
      `${group.group_id}.profiles.current contains duplicates`
    )
    for (const profile of group.profiles.current)
      assertString(profile, `${group.group_id}.profiles.current entry`)
    assert(
      KNOWN_DISPOSITIONS.has(group.profiles.secure_sitl),
      `${group.group_id} has unknown secure-SITL disposition '${group.profiles.secure_sitl}'`
    )
    if (group.classification === 'production-authority')
      assert(
        group.profiles.secure_sitl === 'sole-authority',
        `${group.group_id} production authority must be sole-authority at L1`
      )
    if (group.classification === 'simulation-only')
      assert(
        group.profiles.secure_sitl === 'excluded',
        `${group.group_id} simulation-only surface must be excluded at L1`
      )
    if (group.classification === 'telemetry' || group.classification === 'evidence')
      assert(
        ['read-only', 'excluded'].includes(group.profiles.secure_sitl),
        `${group.group_id} ${group.classification} surface must be read-only or excluded at L1`
      )
    if (group.classification === 'forbidden')
      assert(
        ['excluded', 'replace-with-typed-intent'].includes(group.profiles.secure_sitl),
        `${group.group_id} forbidden surface has unsafe L1 disposition`
      )
    assert(
      Array.isArray(group.hazard_ids) && group.hazard_ids.length > 0,
      `${group.group_id}.hazard_ids must be non-empty`
    )
    assert(
      new Set(group.hazard_ids).size === group.hazard_ids.length,
      `${group.group_id}.hazard_ids contains duplicates`
    )
    for (const hazardId of group.hazard_ids)
      assert(hazardIds.has(hazardId), `${group.group_id} references unknown hazard '${hazardId}'`)
    assert(
      Array.isArray(group.tests) && group.tests.length > 0,
      `${group.group_id}.tests must be non-empty`
    )
    const testIds = new Set()
    for (const test of group.tests) {
      assertString(test.id, `${group.group_id}.tests.id`)
      assert(!testIds.has(test.id), `${group.group_id} has duplicate test ID '${test.id}'`)
      testIds.add(test.id)
      assert(
        KNOWN_SURFACE_TEST_STATUSES.has(test.status),
        `${group.group_id} has unknown test status '${test.status}'`
      )
      if (test.status === 'existing' || test.status === 'existing-component') {
        assert(
          testEvidence.has(test.id),
          `${group.group_id} existing test '${test.id}' has no checked evidence locator`
        )
        referencedExistingTests.add(test.id)
      }
    }
    assert(
      Array.isArray(group.members) && group.members.length > 0,
      `${group.group_id}.members must be non-empty`
    )

    for (const member of group.members) {
      const memberRequired = ['id', 'name', 'route', 'locator', 'status', 'source_assertion']
      for (const field of memberRequired)
        assert(
          Object.hasOwn(member, field),
          `${group.group_id} member is missing required field '${field}'`
        )
      assert(/^SURF-[0-9]{3}$/.test(member.id), `invalid surface ID '${member.id}'`)
      assert(!surfaceIds.has(member.id), `duplicate surface ID '${member.id}'`)
      surfaceIds.add(member.id)
      assertString(member.name, `${member.id}.name`)
      assertString(member.route, `${member.id}.route`)
      assert(
        member.locator && typeof member.locator === 'object',
        `${member.id}.locator is missing`
      )
      assertSafeRelativePath(member.locator.file, `${member.id}.locator.file`)
      assertString(member.locator.symbol, `${member.id}.locator.symbol`)
      assert(
        KNOWN_STATUSES.has(member.status),
        `${member.id} has unknown status '${member.status}'`
      )
      assert(
        member.source_assertion && typeof member.source_assertion === 'object',
        `${member.id}.source_assertion is missing`
      )
      const assertionType = member.source_assertion.type
      assert(
        ['tauri-handler', 'contains', 'not-contains', 'absent-file'].includes(assertionType),
        `${member.id} has unknown source assertion '${assertionType}'`
      )
      if (member.status === 'removed')
        assert(
          ['not-contains', 'absent-file'].includes(assertionType),
          `${member.id} removed surface must assert source absence`
        )
      else
        assert(
          !['not-contains', 'absent-file'].includes(assertionType),
          `${member.id} active surface cannot assert source absence`
        )
      if (assertionType === 'absent-file') {
        assert(
          !existsSync(resolve(root, member.locator.file)),
          `${member.id} expected removed file to remain absent: ${member.locator.file}`
        )
      } else {
        const source = getSource(member.locator.file)
        if (assertionType === 'contains' || assertionType === 'not-contains') {
          assertString(member.source_assertion.needle, `${member.id}.source_assertion.needle`)
          if (assertionType === 'contains')
            assert(
              source.includes(member.source_assertion.needle),
              `${member.id} source assertion not found in ${member.locator.file}`
            )
          else
            assert(
              !source.includes(member.source_assertion.needle),
              `${member.id} removed source assertion reappeared in ${member.locator.file}`
            )
        }
      }
      surfaces.push({ ...group, ...member })
    }
  }

  assert(
    inventory.scan_policy && typeof inventory.scan_policy === 'object',
    'scan_policy is missing'
  )
  assertSafeRelativePath(inventory.scan_policy.tauri_handler_file, 'scan_policy.tauri_handler_file')
  const handlerSource = productionSource(
    inventory.scan_policy.tauri_handler_file,
    getSource(inventory.scan_policy.tauri_handler_file)
  )
  const actualHandlers = extractTauriHandlers(handlerSource)
  const inventoriedHandlers = new Set(
    surfaces
      .filter((surface) => surface.kind === 'tauri-command' && surface.status === 'registered')
      .map((surface) => surface.route)
  )
  compareSets(actualHandlers, inventoriedHandlers, 'registered Tauri command inventory')
  for (const surface of surfaces.filter((value) => value.status === 'dormant-unregistered')) {
    assert(
      !actualHandlers.has(surface.route),
      `${surface.id} is marked unregistered but appears in the Tauri handler list`
    )
  }

  const galadrielEvidenceRoutes = new Set(
    surfaces
      .filter(
        (surface) =>
          surface.domain === 'native_ncp' &&
          surface.classification === 'evidence' &&
          surface.status === 'live' &&
          surface.route.startsWith('ncp://')
      )
      .map((surface) => surface.route)
  )
  compareSets(
    galadrielEvidenceRoutes,
    REQUIRED_GALADRIEL_EVIDENCE_ROUTES,
    'exact Galadriel evidence route inventory'
  )

  compareSets(
    referencedExistingTests,
    new Set(testEvidence.keys()),
    'existing test evidence registry'
  )

  assertExactVocabulary(
    inventory.scan_policy.known_route_prefixes,
    REQUIRED_ROUTE_PREFIXES,
    'scan_policy.known_route_prefixes'
  )
  assertExactVocabulary(
    inventory.scan_policy.forbidden_command_capabilities,
    REQUIRED_FORBIDDEN_CAPABILITIES,
    'scan_policy.forbidden_command_capabilities'
  )
  assert(
    Array.isArray(inventory.scan_policy.development_network_modules),
    'scan_policy.development_network_modules must be an array'
  )
  const developmentNetworkModules = new Map()
  for (const module of inventory.scan_policy.development_network_modules) {
    assertSafeRelativePath(module?.path, 'development_network_modules.path')
    assertSafeRelativePath(
      module?.production_replacement,
      'development_network_modules.production_replacement'
    )
    assert(
      module.capability === 'rosbridge-subscriptions-only',
      `${module.path} has an invalid development network capability`
    )
    assert(
      !developmentNetworkModules.has(module.path),
      `duplicate development network module '${module.path}'`
    )
    developmentNetworkModules.set(module.path, module.production_replacement)
  }
  compareSets(
    new Set(
      [...developmentNetworkModules].map(([path, replacement]) => `${path}\u0000${replacement}`)
    ),
    new Set(
      [...REQUIRED_DEVELOPMENT_NETWORK_MODULES].map(
        ([path, replacement]) => `${path}\u0000${replacement}`
      )
    ),
    'development network module policy'
  )
  assertExactVocabulary(
    inventory.scan_policy.production_fetch_modules,
    REQUIRED_PRODUCTION_FETCH_MODULES,
    'scan_policy.production_fetch_modules'
  )
  assert(
    /^[0-9a-f]{64}$/.test(inventory.scan_policy.production_file_manifest_sha256),
    'scan_policy.production_file_manifest_sha256 is not SHA-256'
  )
  verifyConditionalExecutableInputs(root, inventory.scan_policy, sourceOverrides)
  const productionFiles = collectProductionFiles(root, inventory.scan_policy, sourceOverrides)
  const productionManifest = createHash('sha256')
    .update(`${productionFiles.join('\n')}\n`)
    .digest('hex')
  assert(
    productionManifest === inventory.scan_policy.production_file_manifest_sha256,
    `production source manifest drift; expected ${inventory.scan_policy.production_file_manifest_sha256}, got ${productionManifest}`
  )

  const knownRoutePrefixes = new Set(inventory.scan_policy.known_route_prefixes)
  const actualRoutes = new Set()
  const forbiddenCapabilities = new Set()
  const productionFetchModules = new Set(inventory.scan_policy.production_fetch_modules)
  for (const relativePath of productionFiles) {
    const rawSource = getSource(relativePath)
    const source = productionSource(relativePath, rawSource)
    if (relativePath.startsWith(PLANT_AUTHORITY_SOURCE_ROOT) && relativePath.endsWith('.rs'))
      verifyPlantAuthorityRustBoundary(relativePath, rawSource)
    if (relativePath === PLANT_AUTHORITY_MANIFEST) verifyPlantAuthorityManifestBoundary(source)
    for (const route of extractKnownRoutes(source, knownRoutePrefixes)) actualRoutes.add(route)
    if (relativePath.endsWith('.rs')) {
      const macroRoutes = extractRustMacroRoutes(source, knownRoutePrefixes)
      if (macroRoutes.size > 0) {
        fail(
          `Rust macro route construction is forbidden in ${relativePath}: ${[...macroRoutes].sort().join(', ')}`
        )
      }
    }
    if (SCRIPT_EXTENSIONS.has(fileExtension(relativePath))) {
      const analysis = analyzeScriptSource(
        relativePath,
        source,
        knownRoutePrefixes,
        new Set(inventory.scan_policy.forbidden_command_capabilities)
      )
      for (const route of analysis.routes) actualRoutes.add(route)
      for (const capability of analysis.capabilities) forbiddenCapabilities.add(capability)
      if (analysis.websocketReferences.length > 0 && !developmentNetworkModules.has(relativePath)) {
        fail(
          `undeclared renderer WebSocket capability in ${relativePath}:${analysis.websocketReferences.join(',')}`
        )
      }
      if (analysis.fetchCalls.length > 0 && !productionFetchModules.has(relativePath)) {
        fail(
          `undeclared renderer fetch capability in ${relativePath}:${analysis.fetchCalls.join(',')}`
        )
      }
      if (analysis.forbiddenNetworkReferences.length > 0) {
        fail(
          `forbidden renderer network capability in ${relativePath}:${analysis.forbiddenNetworkReferences.join(',')}`
        )
      }
      if (analysis.directDevImports.length > 0 && !developmentNetworkModules.has(relativePath)) {
        fail(
          `direct runtime import of the development rosbridge module in ${relativePath}:${analysis.directDevImports.join(',')}`
        )
      }
      if (analysis.capabilityRecovery.length > 0) {
        fail(
          `global capability recovery is forbidden in ${relativePath}:${analysis.capabilityRecovery.join(',')}`
        )
      }
      if (analysis.unresolvedComputedCalls.length > 0) {
        fail(
          `unresolved computed call capability in ${relativePath}:${analysis.unresolvedComputedCalls.join(',')}`
        )
      }
      if (analysis.dynamicCode.length > 0) {
        fail(
          `dynamic code construction is forbidden in ${relativePath}:${analysis.dynamicCode.join(',')}`
        )
      }
      if (analysis.reflectiveCapabilities.length > 0) {
        fail(
          `reflective capability lookup is forbidden in ${relativePath}:${analysis.reflectiveCapabilities.join(',')}`
        )
      }
    } else {
      const capabilitySource = relativePath.endsWith('Cargo.toml')
        ? source.replace(/^\s*publish\s*=.*$/gm, '')
        : source
      for (const capability of inventory.scan_policy.forbidden_command_capabilities) {
        if (new RegExp(`\\b${escapeRegex(capability)}\\b`).test(capabilitySource)) {
          forbiddenCapabilities.add(`${relativePath}:${capability}`)
        }
      }
    }
  }
  for (const [developmentModule, replacement] of developmentNetworkModules) {
    const developmentAnalysis = analyzeScriptSource(
      developmentModule,
      productionSource(developmentModule, getSource(developmentModule)),
      knownRoutePrefixes,
      new Set(inventory.scan_policy.forbidden_command_capabilities)
    )
    assert(
      developmentAnalysis.websocketReferences.length > 0,
      `${developmentModule} is classified as a development network module but has no WebSocket client`
    )
    const replacementAnalysis = analyzeScriptSource(
      replacement,
      productionSource(replacement, getSource(replacement)),
      knownRoutePrefixes,
      new Set(inventory.scan_policy.forbidden_command_capabilities)
    )
    assert(
      replacementAnalysis.websocketReferences.length === 0 &&
        replacementAnalysis.fetchCalls.length === 0 &&
        replacementAnalysis.forbiddenNetworkReferences.length === 0,
      `${replacement} production replacement must be network-free`
    )
  }
  assert(
    forbiddenCapabilities.size === 0,
    `forbidden generic command capability detected: ${[...forbiddenCapabilities].sort().join(', ')}`
  )
  const inventoriedRoutes = new Set(
    surfaces
      .filter((surface) => surface.status !== 'removed')
      .map((surface) => surface.route)
      .filter(
        (route) =>
          route.startsWith('/mavros/') ||
          route.startsWith('/gazebo/') ||
          route === '/cmd/motor_speed/*'
      )
  )
  compareSets(actualRoutes, inventoriedRoutes, 'known actuator/telemetry route inventory')

  return { surfaces, actualHandlers, actualRoutes, productionFiles }
}

function verifyEcosystem(root, ecosystem) {
  assert(ecosystem?.schema_version === 1, 'ecosystem schema_version must be 1')
  assert(
    ecosystem.crebain_source && typeof ecosystem.crebain_source === 'object',
    'crebain_source is missing'
  )
  assert(
    ecosystem.crebain_source.commit === null,
    'CREBAIN commit must remain null to avoid a self-referential in-tree claim'
  )
  assert(
    ecosystem.crebain_source.whole_repository_hash === null,
    'CREBAIN whole_repository_hash must remain null'
  )
  assertString(ecosystem.crebain_source.commit_resolution, 'crebain_source.commit_resolution')

  assert(Array.isArray(ecosystem.external_repositories), 'external_repositories must be an array')
  const repoNames = new Set()
  for (const repository of ecosystem.external_repositories) {
    for (const field of [
      'name',
      'repository',
      'verified_remote',
      'branch',
      'commit',
      'remote_main_at_capture',
      'availability',
      'role',
      'l1_status',
    ])
      assertString(repository[field], `external repository ${field}`)
    assert(!repoNames.has(repository.name), `duplicate external repository '${repository.name}'`)
    repoNames.add(repository.name)
    assert(/^[0-9a-f]{40}$/.test(repository.commit), `${repository.name} commit is not 40-hex`)
    assert(
      /^[0-9a-f]{40}$/.test(repository.remote_main_at_capture),
      `${repository.name} remote_main_at_capture is not 40-hex`
    )
    if (repository.branch === 'main') {
      assert(
        repository.commit === repository.remote_main_at_capture,
        `${repository.name} main commit does not match remote_main_at_capture`
      )
    } else {
      assert(
        /^[0-9a-f]{40}$/.test(repository.remote_branch_at_capture),
        `${repository.name} remote_branch_at_capture is not 40-hex`
      )
      assert(
        repository.commit === repository.remote_branch_at_capture,
        `${repository.name} commit does not match remote_branch_at_capture`
      )
    }
    assert(
      repository.availability === 'remote-verified',
      `${repository.name} availability must be remote-verified`
    )
  }
  compareSets(repoNames, REQUIRED_EXTERNAL_REPOSITORIES, 'required external repository baseline')

  assert(Array.isArray(ecosystem.excluded_repositories), 'excluded_repositories must be an array')
  const excludedRepoNames = new Set()
  for (const repository of ecosystem.excluded_repositories) {
    assertString(repository.name, 'excluded repository name')
    assert(
      !repoNames.has(repository.name) && !excludedRepoNames.has(repository.name),
      `duplicate or conflicting excluded repository '${repository.name}'`
    )
    excludedRepoNames.add(repository.name)
    assertString(repository.reason, `${repository.name}.reason`)
    assertString(repository.required_follow_up, `${repository.name}.required_follow_up`)
    for (const field of ['base_commit', 'migration_commit', 'remote_main_at_capture']) {
      if (Object.hasOwn(repository, field))
        assert(
          /^[0-9a-f]{40}$/.test(repository[field]),
          `${repository.name}.${field} is not 40-hex`
        )
    }
    if (Object.hasOwn(repository, 'target_mirror_ref'))
      assertString(repository.target_mirror_ref, `${repository.name}.target_mirror_ref`)
    if (Object.hasOwn(repository, 'target_wire_version'))
      assertString(repository.target_wire_version, `${repository.name}.target_wire_version`)
  }

  const ncp = ecosystem.ncp_release_contract
  assert(
    ncp && ncp.release_tag === 'v0.8.0' && ncp.wire_version === '0.8',
    'NCP release contract must pin v0.8.0/wire 0.8'
  )
  for (const field of ['tag_object', 'commit', 'crebain_cargo_resolution'])
    assert(/^[0-9a-f]{40}$/.test(ncp[field]), `ncp_release_contract.${field} is not 40-hex`)
  assert(/^[0-9a-f]{16}$/.test(ncp.contract_hash), 'NCP contract_hash is not 16-hex')
  assert(/^[0-9a-f]{64}$/.test(ncp.proto_sha256), 'NCP proto_sha256 is not SHA-256')

  assert(
    Array.isArray(ecosystem.toolchains) && ecosystem.toolchains.length > 0,
    'toolchains must be non-empty'
  )
  const toolchainNames = new Set()
  for (const toolchain of ecosystem.toolchains) {
    assertString(toolchain.name, 'toolchain.name')
    assert(!toolchainNames.has(toolchain.name), `duplicate toolchain '${toolchain.name}'`)
    toolchainNames.add(toolchain.name)
    assertString(toolchain.version, `${toolchain.name}.version`)
    assertString(toolchain.scope, `${toolchain.name}.scope`)
    assertString(toolchain.source, `${toolchain.name}.source`)
  }

  assert(
    Array.isArray(ecosystem.crebain_configuration_artifacts) &&
      ecosystem.crebain_configuration_artifacts.length > 0,
    'crebain_configuration_artifacts must be non-empty'
  )
  const configPaths = new Set()
  for (const artifact of ecosystem.crebain_configuration_artifacts) {
    assertSafeRelativePath(artifact.path, 'configuration artifact path')
    assert(
      !configPaths.has(artifact.path),
      `duplicate CREBAIN configuration artifact '${artifact.path}'`
    )
    configPaths.add(artifact.path)
    assert(/^[0-9a-f]{64}$/.test(artifact.sha256), `${artifact.path} digest is not SHA-256`)
    assert(
      existsSync(resolve(root, artifact.path)),
      `configuration artifact is missing: ${artifact.path}`
    )
    const bytes = readFileSync(resolve(root, artifact.path))
    const actual = createHash('sha256').update(bytes).digest('hex')
    assert(
      actual === artifact.sha256,
      `${artifact.path} configuration digest drift; expected ${artifact.sha256}, got ${actual}`
    )
  }
  for (const path of REQUIRED_RELEASE_INVOCATION_FILES) {
    assert(configPaths.has(path), `release invocation artifact is not pinned: ${path}`)
  }
  for (const path of REQUIRED_PRODUCTION_BOUNDARY_DIGEST_FILES) {
    assert(configPaths.has(path), `production boundary artifact is not digest-pinned: ${path}`)
  }

  assert(
    Array.isArray(ecosystem.external_configuration_digests) &&
      ecosystem.external_configuration_digests.length > 0,
    'external_configuration_digests must be non-empty'
  )
  const externalConfigurationKeys = new Set()
  for (const artifact of ecosystem.external_configuration_digests) {
    assertString(artifact.repository, 'external configuration repository')
    assert(
      repoNames.has(artifact.repository),
      `external configuration references unknown repository '${artifact.repository}'`
    )
    assertSafeRelativePath(artifact.path, `${artifact.repository} external configuration path`)
    const key = `${artifact.repository}\u0000${artifact.path}`
    assert(
      !externalConfigurationKeys.has(key),
      `duplicate external configuration artifact '${artifact.repository}:${artifact.path}'`
    )
    externalConfigurationKeys.add(key)
    assert(
      /^[0-9a-f]{64}$/.test(artifact.sha256),
      `${artifact.repository}:${artifact.path} digest is not SHA-256`
    )
  }

  assert(
    Array.isArray(ecosystem.profiles) && ecosystem.profiles.length > 0,
    'profiles must be non-empty'
  )
  const profileNames = new Set()
  for (const profile of ecosystem.profiles) {
    assertString(profile.name, 'profile.name')
    assert(!profileNames.has(profile.name), `duplicate profile '${profile.name}'`)
    profileNames.add(profile.name)
    assert(
      KNOWN_PROFILE_STATUSES.has(profile.status),
      `${profile.name} has unknown profile status '${profile.status}'`
    )
    assertString(profile.authority, `${profile.name}.authority`)
  }
  compareSets(profileNames, REQUIRED_PROFILES, 'ecosystem profile baseline')
}

function verifyRequiredDocs(root) {
  for (const path of [
    'docs/PHASE0_BASELINE.md',
    'docs/COMPLETION_LEVELS.md',
    'docs/L1_ODD.md',
    'docs/SYSTEM_CONTEXT.md',
    'docs/HAZARD_LOG.md',
  ])
    assert(existsSync(resolve(root, path)), `required Phase 0 document is missing: ${path}`)
}

function verifyTrackedConfigurationInvocations(getSource) {
  for (const path of REQUIRED_RELEASE_INVOCATION_FILES) {
    const source = getSource(path)
    assert(
      !/\bTAURI_CONFIG\b/.test(source) && !/(?:^|\s)--config(?:\s|=)/m.test(source),
      `explicit configuration override is forbidden in tracked invocation file: ${path}`
    )
  }
}

export function loadPhase0Baseline(root = DEFAULT_ROOT) {
  return {
    inventory: parseJsonFile(root, INVENTORY_PATH),
    hazards: parseJsonFile(root, HAZARDS_PATH),
    ecosystem: parseJsonFile(root, ECOSYSTEM_PATH),
  }
}

export function verifyPhase0Baseline({
  root = DEFAULT_ROOT,
  inventory,
  hazards,
  ecosystem,
  sourceOverrides = {},
  allowFixtureEvidence = false,
} = {}) {
  const loaded =
    inventory && hazards && ecosystem ? { inventory, hazards, ecosystem } : loadPhase0Baseline(root)
  const getSource = sourceReader(root, sourceOverrides)
  verifyTrackedConfigurationInvocations(getSource)
  const testEvidence = verifyTestEvidence(loaded.inventory, getSource)
  const hazardIds = verifyHazards(
    root,
    loaded.hazards,
    getSource('docs/L1_ODD.md'),
    testEvidence,
    allowFixtureEvidence
  )
  const inventoryResult = verifyInventory(
    root,
    loaded.inventory,
    hazardIds,
    getSource,
    sourceOverrides,
    testEvidence
  )
  verifyEcosystem(root, loaded.ecosystem)
  verifyRequiredDocs(root)
  return {
    surfaces: inventoryResult.surfaces.length,
    hazards: hazardIds.size,
    tauriHandlers: inventoryResult.actualHandlers.size,
    knownRoutes: inventoryResult.actualRoutes.size,
    productionFiles: inventoryResult.productionFiles.length,
    configurationArtifacts: loaded.ecosystem.crebain_configuration_artifacts.length,
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    const result = verifyPhase0Baseline()
    console.log(
      `OK: Phase 0 baseline verified (${result.surfaces} surfaces, ${result.hazards} hazards, ` +
        `${result.tauriHandlers} Tauri handlers, ${result.knownRoutes} known routes, ` +
        `${result.productionFiles} production files, ` +
        `${result.configurationArtifacts} pinned CREBAIN configs)`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
