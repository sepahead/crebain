#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_MANIFEST = resolve(ROOT, 'src-tauri/Cargo.toml')
const PLANT_ROOT = resolve(ROOT, 'src-tauri/crates/plant-authority')
const PLANT_MANIFEST = resolve(PLANT_ROOT, 'Cargo.toml')
const EXPECTED_PACKAGE = 'crebain-plant-authority'
const EXPECTED_BINARY = 'crebain-plantd'
const EXPECTED_TARGETS = [
  {
    name: 'crebain_plant_authority',
    kind: 'lib',
    crateType: 'lib',
    source: 'src/lib.rs',
  },
  { name: EXPECTED_BINARY, kind: 'bin', crateType: 'bin', source: 'src/main.rs' },
  { name: 'channel_stress', kind: 'test', crateType: 'bin', source: 'tests/channel_stress.rs' },
  {
    name: 'frame_golden_vectors',
    kind: 'test',
    crateType: 'bin',
    source: 'tests/frame_golden_vectors.rs',
  },
  { name: 'headless', kind: 'test', crateType: 'bin', source: 'tests/headless.rs' },
  {
    name: 'lifecycle_properties',
    kind: 'test',
    crateType: 'bin',
    source: 'tests/lifecycle_properties.rs',
  },
]

const FORBIDDEN_SOURCE_TOKENS = [
  'crebain_lib',
  'tauri',
  'ncp_core',
  'ncp_zenoh',
  'zenoh',
  'tokio',
  'ort',
  'candle_core',
  'sensor_fusion',
  'inference',
  'simulation',
  'rosbridge',
  'gazebo',
  'mavros',
]

function fail(message) {
  throw new Error(`Plant authority boundary check failed: ${message}`)
}

function walkRustFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) fail(`symbolic links are forbidden under ${relative(ROOT, path)}`)
    if (entry.isDirectory()) files.push(...walkRustFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path)
  }
  return files.sort()
}

function assertCanonicalPathWithin(path, root, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${relative(ROOT, path)}`)
  if (lstatSync(path).isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  const canonicalPath = realpathSync(path)
  const canonicalRoot = realpathSync(root)
  const fromRoot = relative(canonicalRoot, canonicalPath)
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    fail(`${label} escapes the plant package root: ${canonicalPath}`)
  }
  if (isAbsolute(fromRoot)) fail(`${label} escapes the plant package root: ${canonicalPath}`)
  return canonicalPath
}

function rustRawStringEnd(source, index) {
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
  if (closing === -1) fail('unterminated Rust raw string in plant source')
  return closing + terminator.length
}

function blankRustSegment(source, start, end) {
  return source.slice(start, end).replace(/[^\n]/g, ' ')
}

function rustCharLiteralEnd(source, index) {
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
    const rawEnd = rustRawStringEnd(source, index)
    if (rawEnd !== null) {
      output += blankRustSegment(source, index, rawEnd)
      index = rawEnd
      continue
    }
    const charEnd = rustCharLiteralEnd(source, index)
    if (charEnd !== null) {
      output += blankRustSegment(source, index, charEnd)
      index = charEnd
      continue
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      const next = end === -1 ? source.length : end
      output += blankRustSegment(source, index, next)
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
      if (depth !== 0) fail('unterminated Rust block comment in plant source')
      output += blankRustSegment(source, start, index)
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
      if (source[index - 1] !== '"') fail('unterminated Rust string in plant source')
      output += blankRustSegment(source, start, index)
      continue
    }
    output += source[index]
    index += 1
  }
  return output
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

function verify() {
  if (!existsSync(PLANT_MANIFEST)) fail('plant package manifest is missing')
  if (lstatSync(PLANT_ROOT).isSymbolicLink()) fail('plant package root must not be a symbolic link')
  assertCanonicalPathWithin(PLANT_MANIFEST, PLANT_ROOT, 'plant manifest')
  if (existsSync(resolve(PLANT_ROOT, 'build.rs')))
    fail('plant package must not have a build script')

  const metadata = cargoMetadata()
  const plant = metadata.packages.find((candidate) => candidate.name === EXPECTED_PACKAGE)
  if (!plant) fail(`${EXPECTED_PACKAGE} is not a workspace member`)
  if (realpathSync(plant.manifest_path) !== realpathSync(PLANT_MANIFEST))
    fail('plant manifest path is not canonical')
  if (plant.dependencies.length !== 0) fail('plant package must remain dependency-free')
  if (Object.keys(plant.features).length !== 0)
    fail('plant package must not hide boundary changes in features')

  const rootPackage = metadata.packages.find((candidate) => candidate.name === 'crebain')
  if (!rootPackage) fail('CREBAIN application package is missing')
  if (rootPackage.dependencies.some((dependency) => dependency.name === EXPECTED_PACKAGE)) {
    fail('Tauri application must not link the headless plant package')
  }
  if (
    metadata.workspace_default_members.length !== 1 ||
    metadata.workspace_default_members[0] !== rootPackage.id
  ) {
    fail('default Cargo operations must remain scoped to the existing application package')
  }

  if (plant.targets.some((target) => target.kind.includes('custom-build'))) {
    fail('plant package must not expose a custom build target')
  }
  if (plant.targets.length !== EXPECTED_TARGETS.length) {
    fail('plant package Cargo target inventory drift')
  }
  for (const expected of EXPECTED_TARGETS) {
    const target = plant.targets.find((candidate) => candidate.name === expected.name)
    if (
      !target ||
      target.kind.length !== 1 ||
      target.kind[0] !== expected.kind ||
      target.crate_types.length !== 1 ||
      target.crate_types[0] !== expected.crateType
    ) {
      fail(`plant package Cargo target inventory drift at '${expected.name}'`)
    }
    assertCanonicalPathWithin(target.src_path, PLANT_ROOT, `Cargo target '${target.name}' source`)
    if (realpathSync(target.src_path) !== realpathSync(resolve(PLANT_ROOT, expected.source))) {
      fail(`Cargo target '${target.name}' source path drift`)
    }
  }

  const rustFiles = walkRustFiles(PLANT_ROOT)
  const runtimeSourceRoot = `${realpathSync(resolve(PLANT_ROOT, 'src'))}${process.platform === 'win32' ? '\\' : '/'}`
  if (rustFiles.length === 0) fail('plant package contains no Rust sources')
  for (const path of rustFiles) {
    const source = readFileSync(path, 'utf8')
    const code = rustBoundaryCode(source)
    const relativePath = relative(ROOT, path)
    if (/\b(?:r#)?path\s*=/.test(code)) {
      fail(`external #[path] modules are forbidden in ${relativePath}`)
    }
    if (/\b(?:include|include_str|include_bytes)\b/.test(code)) {
      fail(`include macros are forbidden in ${relativePath}`)
    }
    if (realpathSync(path).startsWith(runtimeSourceRoot)) {
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
        fail(`process, network, or device I/O capability is forbidden in ${relativePath}`)
      }
    }
    if (/\bunsafe\b/.test(code.replaceAll('#![forbid(unsafe_code)]', ''))) {
      fail(`unsafe token is forbidden in ${relativePath}`)
    }
    for (const token of FORBIDDEN_SOURCE_TOKENS) {
      if (new RegExp(`\\b${token}\\b`, 'i').test(code)) {
        fail(`forbidden dependency/domain token '${token}' found in ${relativePath}`)
      }
    }
  }

  return { files: rustFiles.length, packages: metadata.workspace_members.length }
}

try {
  const result = verify()
  console.log(
    `OK: inert plant boundary verified (${result.files} Rust files, ${result.packages} workspace packages, zero dependencies)`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
