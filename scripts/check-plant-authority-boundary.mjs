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
const HEALTH_SOURCE = resolve(PLANT_ROOT, 'src/health.rs')
const FRESHNESS_SOURCE = resolve(PLANT_ROOT, 'src/freshness.rs')
const SAFE_ACTION_SOURCE = resolve(PLANT_ROOT, 'src/safe_action.rs')
const DEADLINE_MONITOR_SOURCE = resolve(PLANT_ROOT, 'src/deadline_monitor.rs')
const CONTRACT_SOURCE = resolve(PLANT_ROOT, 'src/contract.rs')
const LIFECYCLE_SOURCE = resolve(PLANT_ROOT, 'src/lifecycle.rs')
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

function oneBracedItem(code, headerSource, label) {
  const matches = [...code.matchAll(new RegExp(headerSource, 'g'))]
  if (matches.length !== 1) fail(`${label} must have exactly one unconditional definition`)
  const match = matches[0]
  const opening = code.indexOf('{', match.index + match[0].length)
  if (opening === -1) fail(`${label} has no inspectable body`)
  let depth = 1
  let cursor = opening + 1
  while (cursor < code.length && depth > 0) {
    if (code[cursor] === '{') depth += 1
    else if (code[cursor] === '}') depth -= 1
    cursor += 1
  }
  if (depth !== 0) fail(`${label} has an unterminated body`)
  const prefix = code.slice(Math.max(0, match.index - 200), match.index)
  if (/#[\s]*\[[\s]*cfg(?:_attr)?\b[^\]]*\][\s\S]*$/.test(prefix))
    fail(`${label} must not be conditionally defined`)
  return { body: code.slice(opening + 1, cursor - 1), start: match.index, end: cursor }
}

function structItem(code, name, visibility = 'pub') {
  const visible = visibility === 'pub' ? 'pub\\s+' : 'pub\\s*\\(\\s*crate\\s*\\)\\s+'
  return oneBracedItem(code, `\\b${visible}struct\\s+${name}(?:\\s*<[^>{}]*>)?`, `struct '${name}'`)
}

function enumItem(code, name) {
  return oneBracedItem(code, `\\bpub\\s+enum\\s+${name}`, `enum '${name}'`)
}

function unbracedStructItem(code, name) {
  const matches = [
    ...code.matchAll(
      new RegExp(`\\bpub\\s+struct\\s+${name}(?:\\s*<[^;{}]*>)?\\s*(?:\\([^;{}]*\\))?\\s*;`, 'g')
    ),
  ]
  if (matches.length !== 1) fail(`struct '${name}' must have exactly one unbraced definition`)
  const match = matches[0]
  const prefix = code.slice(Math.max(0, match.index - 200), match.index)
  if (/#[\s]*\[[\s]*cfg(?:_attr)?\b[^\]]*\][\s\S]*$/.test(prefix))
    fail(`struct '${name}' must not be conditionally defined`)
  return {
    declaration: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }
}

function implItem(code, name) {
  return oneBracedItem(code, `\\bimpl\\s+${name}\\b`, `inherent impl '${name}'`)
}

function normalizedRustBody(body) {
  return body.replace(/\s+/g, '')
}

function assertExactBody(item, expected, label) {
  if (normalizedRustBody(item.body) !== normalizedRustBody(expected))
    fail(`${label} closed value shape drift`)
}

function methodNames(item) {
  return [
    ...item.body.matchAll(
      /\bpub(?:\s*\([^)]*\))?\s+(?:(?:const|async|unsafe|extern)\s+)*fn\s+(\w+)\b/g
    ),
  ].map((match) => match[1])
}

function assertExactMethods(item, expected, label) {
  const actual = methodNames(item)
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
    fail(`${label} method surface drift; expected ${expected.join(',')}, got ${actual.join(',')}`)
}

function allMethodNames(item) {
  return [
    ...item.body.matchAll(
      /\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern)\s+)*fn\s+(\w+)\b/g
    ),
  ].map((match) => match[1])
}

function assertExactAllMethods(item, expected, label) {
  const actual = allMethodNames(item)
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
    fail(
      `${label} complete method surface drift; expected ${expected.join(',')}, got ${actual.join(',')}`
    )
}

function topLevelMacroInvocations(code) {
  const invocations = []
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1
      continue
    }
    if (code[index] === '}') {
      depth -= 1
      continue
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(code[index])) continue
    const match = code.slice(index).match(/^([A-Za-z_]\w*(?:::\w+)*)\s*!\s*[([{]/)
    if (!match) continue
    invocations.push(match[1])
  }
  return invocations
}

function assertNoTopLevelMacroInvocations(code, label) {
  const invocations = topLevelMacroInvocations(code)
  if (invocations.length !== 0)
    fail(`${label} must not hide its item surface behind macros; got ${invocations.join(',')}`)
}

function assertNoLocalMacroDefinitions(code, label) {
  if (/\bmacro_rules\s*!/.test(code))
    fail(`${label} must not define source-invisible item surfaces with macro_rules`)
}

function visibleField(body, field) {
  return new RegExp(`(?:^|\\n)\\s*pub(?:\\s*\\([^)]*\\))?\\s+${field}\\s*:`, 'm').test(body)
}

function leadingAttributes(code, itemStart) {
  let cursor = itemStart
  let attributes = ''
  while (cursor > 0) {
    const prefix = code.slice(0, cursor)
    const match = prefix.match(/#\s*\[[^\]]*\]\s*$/)
    if (!match || match.index === undefined) break
    attributes = `${match[0]}${attributes}`
    cursor = match.index
  }
  return attributes
}

function assertExactLeadingAttributes(code, item, expected, label) {
  if (normalizedRustBody(leadingAttributes(code, item.start)) !== normalizedRustBody(expected))
    fail(`${label} attributes drift`)
}

function topLevelVisibleFunctions(code) {
  const functions = []
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1
      continue
    }
    if (code[index] === '}') {
      depth -= 1
      continue
    }
    if (depth !== 0 || !code.startsWith('pub', index)) continue
    const match = code
      .slice(index)
      .match(/^pub(?:\s*\(\s*([^)]*)\s*\))?\s+(?:(?:const|async|unsafe|extern)\s+)*fn\s+(\w+)\b/)
    if (!match) continue
    functions.push(`${match[1]?.replace(/\s+/g, '') ?? 'public'}:${match[2]}`)
  }
  return functions
}

function topLevelFunctions(code) {
  const functions = []
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1
      continue
    }
    if (code[index] === '}') {
      depth -= 1
      continue
    }
    if (depth !== 0) continue
    const match = code
      .slice(index)
      .match(/^(pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern)\s+)*fn\s+(\w+)\b/)
    if (!match) continue
    functions.push(`${match[1] ? 'visible' : 'private'}:${match[2]}`)
    index += match[0].length - 1
  }
  return functions
}

function topLevelAliasDeclarations(code) {
  const aliases = []
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1
      continue
    }
    if (code[index] === '}') {
      depth -= 1
      continue
    }
    if (depth !== 0) continue
    const tail = code.slice(index)
    const typeAlias = tail.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?type\s+(\w+)\b[^;]*;/)
    if (typeAlias) {
      aliases.push(`type:${typeAlias[1]}`)
      index += typeAlias[0].length - 1
      continue
    }
    const importAlias = tail.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]*\bas\b[^;]*);/)
    if (importAlias) {
      aliases.push(`use:${normalizedRustBody(importAlias[1])}`)
      index += importAlias[0].length - 1
    }
  }
  return aliases
}

function topLevelTypeDeclarations(code) {
  const declarations = []
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1
      continue
    }
    if (code[index] === '}') {
      depth -= 1
      continue
    }
    if (depth !== 0) continue
    const match = code.slice(index).match(/^(pub(?:\s*\([^)]*\))?\s+)?(struct|enum)\s+(\w+)\b/)
    if (!match) continue
    declarations.push(`${match[1] ? 'visible' : 'private'}:${match[2]}:${match[3]}`)
    index += match[0].length - 1
  }
  return declarations
}

function topLevelConstantDeclarations(code) {
  const declarations = []
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1
      continue
    }
    if (code[index] === '}') {
      depth -= 1
      continue
    }
    if (depth !== 0) continue
    const match = code.slice(index).match(/^(pub(?:\s*\([^)]*\))?\s+)?const\s+(?!fn\b)(\w+)\s*:/)
    if (!match) continue
    declarations.push(`${match[1] ? 'visible' : 'private'}:${match[2]}`)
    index += match[0].length - 1
  }
  return declarations
}

function traitImplItems(code) {
  const items = []
  const pattern = /\bimpl(?:\s*<[^>{}]*>)?\s+([^{};]+?)\s+for\s+([^{};]+?)\s*\{/g
  for (const match of code.matchAll(pattern)) {
    const opening = code.indexOf('{', match.index + match[0].length - 1)
    let depth = 1
    let cursor = opening + 1
    while (cursor < code.length && depth > 0) {
      if (code[cursor] === '{') depth += 1
      else if (code[cursor] === '}') depth -= 1
      cursor += 1
    }
    if (depth !== 0) fail('trait impl has an unterminated body')
    items.push({ header: match[0], body: code.slice(opening + 1, cursor - 1) })
  }
  return items
}

function inherentImplItems(code) {
  const items = []
  const pattern = /\bimpl(?:\s*<[^>{}]*>)?\s+([^{};]+?)\s*\{/g
  for (const match of code.matchAll(pattern)) {
    const target = match[1].trim()
    if (/\bfor\b/.test(target)) continue
    const opening = code.indexOf('{', match.index + match[0].length - 1)
    let depth = 1
    let cursor = opening + 1
    while (cursor < code.length && depth > 0) {
      if (code[cursor] === '{') depth += 1
      else if (code[cursor] === '}') depth -= 1
      cursor += 1
    }
    if (depth !== 0) fail('inherent impl has an unterminated body')
    items.push({ header: match[0], target, body: code.slice(opening + 1, cursor - 1) })
  }
  return items
}

function verifyVehicleHealthBoundary(overrides = {}) {
  assertCanonicalPathWithin(HEALTH_SOURCE, PLANT_ROOT, 'vehicle health source')
  assertCanonicalPathWithin(FRESHNESS_SOURCE, PLANT_ROOT, 'vehicle health freshness source')
  const healthCode = rustBoundaryCode(overrides.health ?? readFileSync(HEALTH_SOURCE, 'utf8'))
  const freshnessCode = rustBoundaryCode(
    overrides.freshness ?? readFileSync(FRESHNESS_SOURCE, 'utf8')
  )
  const contractCode = rustBoundaryCode(overrides.contract ?? readFileSync(CONTRACT_SOURCE, 'utf8'))
  const lifecycleCode = rustBoundaryCode(
    overrides.lifecycle ?? readFileSync(LIFECYCLE_SOURCE, 'utf8')
  )
  const channelsCode = rustBoundaryCode(
    overrides.channels ?? readFileSync(resolve(PLANT_ROOT, 'src/channels.rs'), 'utf8')
  )
  const runtimeCode = rustBoundaryCode(
    overrides.runtime ?? readFileSync(resolve(PLANT_ROOT, 'src/runtime.rs'), 'utf8')
  )
  const libraryCode = rustBoundaryCode(
    overrides.library ?? readFileSync(resolve(PLANT_ROOT, 'src/lib.rs'), 'utf8')
  )

  const healthModuleDeclarations = [
    ...libraryCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+health\s*;/g),
  ]
  if (
    healthModuleDeclarations.length !== 1 ||
    normalizedRustBody(healthModuleDeclarations[0][0]) !== 'modhealth;' ||
    leadingAttributes(libraryCode, healthModuleDeclarations[0].index) !== ''
  ) {
    fail('vehicle health module must have one private unconditional crate-root declaration')
  }
  const freshnessModuleDeclarations = [
    ...libraryCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+freshness\s*;/g),
  ]
  if (
    freshnessModuleDeclarations.length !== 1 ||
    normalizedRustBody(freshnessModuleDeclarations[0][0]) !== 'modfreshness;' ||
    leadingAttributes(libraryCode, freshnessModuleDeclarations[0].index) !== ''
  ) {
    fail(
      'vehicle health freshness module must have one private unconditional crate-root declaration'
    )
  }
  const healthReexports = oneBracedItem(
    libraryCode,
    '\\bpub\\s+use\\s+health\\s*::',
    'vehicle health crate-root re-export'
  )
  assertExactBody(
    healthReexports,
    `
      vehicle_health_channel, ArmingStateV1, BatteryObservationV1, EstimateValidityV1,
      EstimatorStateV1, FcuFailsafeStateV1, FcuHealthSourceIdentity, FcuLinksV1, FcuModeStateV1,
      FcuStateV1, FenceStateV1, HealthAxisV1, HealthIdentityError, HealthIdentityKind,
      HealthObservationGroupV1, HealthObservationTimesV1, HealthSequenceError,
      HealthStreamEpochIdentity, HealthStreamSequence, HealthVectorKindV1, LandedStateV1,
      LinkStateV1, LocalFrameInstanceIdentity, MeasurementUnavailableReasonV1,
      ObservedVehicleHealthV1, PlantObservationTime, PositionObservationV1, PositionUnitV1,
      ProfileModeCode, VehicleHealthAgesV1, VehicleHealthCommitError, VehicleHealthCommitReceiptV1,
      VehicleHealthContextV1, VehicleHealthDomainV1, VehicleHealthMetadataV1,
      VehicleHealthPublisherV1, VehicleHealthReadError, VehicleHealthReaderV1, VehicleHealthReportV1,
      VehicleHealthSnapshotV1, VehicleHealthStateV1, VehicleHealthTimePointV1, VehicleHealthUnitsV1,
      VehicleIdentity, VelocityObservationV1, VEHICLE_HEALTH_SCHEMA_V1,
    `,
    'vehicle health crate-root re-export'
  )
  const freshnessReexports = oneBracedItem(
    libraryCode,
    '\\bpub\\s+use\\s+freshness\\s*::',
    'vehicle health freshness crate-root re-export'
  )
  assertExactLeadingAttributes(
    libraryCode,
    freshnessReexports,
    '',
    'vehicle health freshness crate-root re-export'
  )
  assertExactBody(
    freshnessReexports,
    `
      VehicleHealthAgeAssessmentErrorV1, VehicleHealthAgeComparisonAtReadV1,
      VehicleHealthAgeLimitsProposalV1, VehicleHealthAgePointV1,
      VehicleHealthAgePolicyConfigurationErrorV1, VehicleHealthAgeRelationAtReadV1,
      VehicleHealthCapturedAgeAssessmentV1, VehicleHealthCapturedAgePolicyV1,
    `,
    'vehicle health freshness crate-root re-export'
  )
  const healthSubmodules = [
    ...healthCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*(?:;|\{)/g),
  ]
  if (healthSubmodules.length !== 1 || healthSubmodules[0][1] !== 'tests')
    fail('vehicle-health implementation must not gain child modules')
  oneBracedItem(
    healthCode,
    '#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)\\s*\\]\\s*mod\\s+tests',
    'vehicle-health test module'
  )
  const freshnessSubmodules = [
    ...freshnessCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*(?:;|\{)/g),
  ]
  if (freshnessSubmodules.length !== 1 || freshnessSubmodules[0][1] !== 'tests')
    fail('vehicle-health freshness implementation must not gain child modules')
  const freshnessTests = oneBracedItem(
    freshnessCode,
    '#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)\\s*\\]\\s*mod\\s+tests',
    'vehicle-health freshness test module'
  )
  const freshnessProductionCode =
    freshnessCode.slice(0, freshnessTests.start) +
    blankRustSegment(freshnessCode, freshnessTests.start, freshnessTests.end) +
    freshnessCode.slice(freshnessTests.end)
  assertNoTopLevelMacroInvocations(healthCode, 'vehicle-health module')
  assertNoTopLevelMacroInvocations(freshnessProductionCode, 'vehicle-health freshness module')
  assertNoTopLevelMacroInvocations(channelsCode, 'plant channel module')
  assertNoTopLevelMacroInvocations(runtimeCode, 'headless runtime module')
  assertNoTopLevelMacroInvocations(libraryCode, 'plant crate root')
  assertNoLocalMacroDefinitions(healthCode, 'vehicle-health module')
  assertNoLocalMacroDefinitions(freshnessProductionCode, 'vehicle-health freshness module')
  assertNoLocalMacroDefinitions(channelsCode, 'plant channel module')
  assertNoLocalMacroDefinitions(runtimeCode, 'headless runtime module')
  assertNoLocalMacroDefinitions(libraryCode, 'plant crate root')
  if (
    !/\bpub\s+struct\s+KernelChannels\s*<\s*CommandValue\s*,\s*AdapterOutput\s*,\s*Evidence\s*>/.test(
      channelsCode
    )
  ) {
    fail('KernelChannels must have exactly three non-health generic parameters')
  }
  if (/\bKernelChannels\s*<\s*CommandValue\s*,\s*Health\b/.test(channelsCode))
    fail('KernelChannels must not restore a substitutable Health generic')
  if (/\bSnapshotChannel\s*<\s*Health\s*>/.test(channelsCode))
    fail('KernelChannels must not restore a raw generic health snapshot')
  const kernel = structItem(channelsCode, 'KernelChannels')
  if (!/\bhealth_snapshot\s*:\s*VehicleHealthChannelV1\s*,/.test(kernel.body))
    fail('KernelChannels must retain one concrete sealed vehicle-health path')
  if (visibleField(kernel.body, 'health_snapshot'))
    fail('KernelChannels health path must not be publicly replaceable')
  const kernelImpl = oneBracedItem(
    channelsCode,
    '\\bimpl\\s*<\\s*CommandValue\\s*,\\s*AdapterOutput\\s*,\\s*Evidence\\s*>\\s*KernelChannels\\s*<\\s*CommandValue\\s*,\\s*AdapterOutput\\s*,\\s*Evidence\\s*>',
    'KernelChannels inherent impl'
  )
  assertNoTopLevelMacroInvocations(kernelImpl.body, 'KernelChannels impl')
  assertExactMethods(
    kernelImpl,
    ['new', 'commit_vehicle_health', 'load_vehicle_health'],
    'KernelChannels'
  )

  const snapshot = structItem(healthCode, 'VehicleHealthSnapshotV1')
  assertExactBody(
    snapshot,
    `
      metadata: VehicleHealthMetadataV1,
      units: VehicleHealthUnitsV1,
      observation_times: HealthObservationTimesV1,
      state: VehicleHealthStateV1,
      received_at: Instant,
    `,
    'VehicleHealthSnapshotV1'
  )
  const snapshotImpl = implItem(healthCode, 'VehicleHealthSnapshotV1')
  const proofSource = healthCode.slice(snapshot.end, snapshotImpl.start)
  if (/#[\s]*\[[\s]*cfg(?:_attr)?\b/.test(proofSource))
    fail('vehicle-health closed-value proof must be unconditional')
  const closedValueProof = oneBracedItem(
    proofSource,
    '\\bconst\\s+_\\s*:\\s*fn\\s*\\(\\s*\\)\\s*=\\s*\\|\\s*\\|',
    'vehicle-health closed-value proof'
  )
  assertExactBody(
    closedValueProof,
    `
      fn assert_closed_value<T: Copy + Send + Sync>() {}
      assert_closed_value::<VehicleHealthMetadataV1>();
      assert_closed_value::<VehicleHealthUnitsV1>();
      assert_closed_value::<HealthObservationTimesV1>();
      assert_closed_value::<VehicleHealthStateV1>();
      assert_closed_value::<Instant>();
    `,
    'vehicle-health closed-value proof'
  )
  for (const type of [
    'VehicleHealthMetadataV1',
    'VehicleHealthUnitsV1',
    'HealthObservationTimesV1',
    'VehicleHealthStateV1',
    'Instant',
  ]) {
    if (
      !new RegExp(`assert_closed_value\\s*::\\s*<\\s*${type}\\s*>\\s*\\(\\s*\\)`).test(proofSource)
    )
      fail(`vehicle-health closed-value proof is missing ${type}`)
  }

  const closedStructs = new Map([
    [
      'VehicleHealthMetadataV1',
      'schema_version:u16,domain:VehicleHealthDomainV1,stream_sequence:HealthStreamSequence,',
    ],
    [
      'VehicleHealthUnitsV1',
      'frame:VelocityFrame,position_unit:PositionUnitV1,velocity_unit:VelocityUnit,',
    ],
    [
      'HealthObservationTimesV1',
      'fcu_state:PlantObservationTime,estimator:PlantObservationTime,position:PlantObservationTime,velocity:PlantObservationTime,battery:PlantObservationTime,fence:PlantObservationTime,links:PlantObservationTime,',
    ],
    [
      'VehicleHealthStateV1',
      'fcu:FcuStateV1,estimator:EstimatorStateV1,position:PositionObservationV1,velocity:VelocityObservationV1,battery:BatteryObservationV1,fence:FenceStateV1,links:FcuLinksV1,',
    ],
    [
      'VehicleHealthDomainV1',
      'profile:ProfileIdentity,vehicle:VehicleIdentity,source:FcuHealthSourceIdentity,stream_epoch:HealthStreamEpochIdentity,runtime_generation:RuntimeGeneration,local_frame_instance:LocalFrameInstanceIdentity,',
    ],
    ['PlantObservationTime', 'generation:RuntimeGeneration,instant:Instant,'],
    [
      'FcuStateV1',
      'arming:ArmingStateV1,landed:LandedStateV1,mode:FcuModeStateV1,failsafe:FcuFailsafeStateV1,',
    ],
    [
      'EstimatorStateV1',
      'attitude:EstimateValidityV1,height:EstimateValidityV1,local_position:EstimateValidityV1,local_velocity:EstimateValidityV1,global_position:EstimateValidityV1,home_position:EstimateValidityV1,',
    ],
    [
      'FcuLinksV1',
      'plant_to_fcu:LinkStateV1,fcu_data_link:LinkStateV1,offboard_control:LinkStateV1,',
    ],
    [
      'VehicleHealthAgesV1',
      'receipt:Duration,fcu_state:Duration,estimator:Duration,position:Duration,velocity:Duration,battery:Duration,fence:Duration,links:Duration,',
    ],
    [
      'ObservedVehicleHealthV1',
      'commit:SnapshotCommit<VehicleHealthSnapshotV1>,ages:VehicleHealthAgesV1,',
    ],
  ])
  for (const [name, expected] of closedStructs)
    assertExactBody(structItem(healthCode, name), expected, name)

  const closedEnums = new Map([
    ['PositionUnitV1', 'Metres,Centimetres,Feet,'],
    ['ArmingStateV1', 'Armed,Disarmed,Unknown,'],
    ['LandedStateV1', 'OnGround,InAir,TakingOff,Landing,Unknown,'],
    ['FcuModeStateV1', 'Reported(ProfileModeCode),Unknown,'],
    ['FcuFailsafeStateV1', 'Inactive,Active,Unknown,'],
    ['EstimateValidityV1', 'Valid,Invalid,Unknown,'],
    ['MeasurementUnavailableReasonV1', 'NotReported,RejectedBySource,ResetInProgress,'],
    ['PositionObservationV1', 'Available([f64;3]),Unavailable(MeasurementUnavailableReasonV1),'],
    ['VelocityObservationV1', 'Available([f64;3]),Unavailable(MeasurementUnavailableReasonV1),'],
    [
      'BatteryObservationV1',
      'Available{remaining_fraction:f64,},Unavailable(MeasurementUnavailableReasonV1),',
    ],
    ['FenceStateV1', 'Inside,Breached,Disabled,Unknown,'],
    ['LinkStateV1', 'Connected,Disconnected,Unknown,'],
  ])
  for (const [name, expected] of closedEnums)
    assertExactBody(enumItem(healthCode, name), expected, name)

  assertExactBody(
    structItem(contractCode, 'ProfileIdentity'),
    'kind:CandidateProfileKind,artifact_digest:[u8;32],',
    'ProfileIdentity'
  )
  const importedClosedEnums = new Map([
    ['CandidateProfileKind', 'DraftL1SitlLocalNed,DraftL1SitlLocalEnu,'],
    ['VelocityFrame', 'LocalNed,LocalEnu,BodyFrd,BodyFlu,'],
    ['VelocityUnit', 'MetresPerSecond,CentimetresPerSecond,FeetPerSecond,'],
  ])
  for (const [name, expected] of importedClosedEnums)
    assertExactBody(enumItem(contractCode, name), expected, name)

  for (const declaration of [
    /\bpub\s+struct\s+VehicleIdentity\s*\(\s*\[\s*u8\s*;\s*16\s*\]\s*\)\s*;/,
    /\bpub\s+struct\s+FcuHealthSourceIdentity\s*\(\s*\[\s*u8\s*;\s*32\s*\]\s*\)\s*;/,
    /\bpub\s+struct\s+HealthStreamEpochIdentity\s*\(\s*\[\s*u8\s*;\s*16\s*\]\s*\)\s*;/,
    /\bpub\s+struct\s+LocalFrameInstanceIdentity\s*\(\s*\[\s*u8\s*;\s*16\s*\]\s*\)\s*;/,
    /\bpub\s+struct\s+HealthStreamSequence\s*\(\s*NonZeroU64\s*\)\s*;/,
    /\bpub\s+struct\s+ProfileModeCode\s*\(\s*u32\s*\)\s*;/,
  ]) {
    if (!declaration.test(healthCode)) fail('vehicle-health closed tuple value shape drift')
  }
  if (!/\bpub\s+struct\s+RuntimeGeneration\s*\(\s*NonZeroU64\s*\)\s*;/.test(lifecycleCode)) {
    fail('vehicle-health imported runtime-generation value shape drift')
  }

  const publisher = structItem(healthCode, 'VehicleHealthPublisherV1')
  assertExactBody(
    publisher,
    'context:VehicleHealthContextV1,sender:SnapshotSender<VehicleHealthSnapshotV1>,last_source_sequence:Option<HealthStreamSequence>,',
    'VehicleHealthPublisherV1'
  )
  const reader = structItem(healthCode, 'VehicleHealthReaderV1')
  assertExactBody(
    reader,
    'receiver:SnapshotReceiver<VehicleHealthSnapshotV1>,',
    'VehicleHealthReaderV1'
  )
  const healthChannel = structItem(healthCode, 'VehicleHealthChannelV1', 'crate')
  assertExactBody(
    healthChannel,
    'publisher:VehicleHealthPublisherV1,reader:VehicleHealthReaderV1,',
    'VehicleHealthChannelV1'
  )
  if (
    /\bClone\b/.test(leadingAttributes(healthCode, publisher.start)) ||
    /\bimpl(?:\s*<[^>{}]*>)?\s+(?:(?:::)?(?:std|core)::clone::)?Clone\s+for\s+VehicleHealthPublisherV1\b/.test(
      healthCode
    )
  ) {
    fail('vehicle-health publisher must remain non-cloneable')
  }
  const publisherImpl = implItem(healthCode, 'VehicleHealthPublisherV1')
  assertNoTopLevelMacroInvocations(publisherImpl.body, 'VehicleHealthPublisherV1 impl')
  assertExactMethods(publisherImpl, ['commit', 'commit_for_test_at'], 'VehicleHealthPublisherV1')
  if (!/\bpub\s+fn\s+commit\s*\(\s*&\s*mut\s+self\s*,/.test(publisherImpl.body))
    fail('vehicle-health publication must require mutable access to the sole writer')
  if (
    !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*pub\s*\(\s*crate\s*\)\s+fn\s+commit_for_test_at\s*\(\s*&\s*mut\s+self\s*,\s*report\s*:\s*&\s*VehicleHealthReportV1\s*,\s*received_at\s*:\s*Instant\s*,?\s*\)/.test(
      publisherImpl.body
    )
  ) {
    fail('vehicle-health controlled commit hook must remain cfg(test) and crate-private')
  }
  const readerImpl = implItem(healthCode, 'VehicleHealthReaderV1')
  assertNoTopLevelMacroInvocations(readerImpl.body, 'VehicleHealthReaderV1 impl')
  assertExactMethods(readerImpl, ['load', 'load_at'], 'VehicleHealthReaderV1')
  if (
    !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*pub\s*\(\s*crate\s*\)\s+fn\s+load_at\s*\(\s*&\s*self\s*,\s*current_generation\s*:\s*RuntimeGeneration\s*,\s*now\s*:\s*Instant\s*,?\s*\)/.test(
      readerImpl.body
    )
  ) {
    fail('vehicle-health controlled read hook must remain cfg(test) and crate-private')
  }
  const observationTimeImpl = implItem(healthCode, 'PlantObservationTime')
  assertExactMethods(observationTimeImpl, ['now', 'generation', 'at'], 'PlantObservationTime')
  if (
    !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*pub\s*\(\s*crate\s*\)\s+const\s+fn\s+at\s*\(\s*generation\s*:\s*RuntimeGeneration\s*,\s*instant\s*:\s*Instant\s*,?\s*\)/.test(
      observationTimeImpl.body
    )
  ) {
    fail('vehicle-health controlled observation-time hook must remain cfg(test) and crate-private')
  }
  const agesImpl = implItem(healthCode, 'VehicleHealthAgesV1')
  assertExactMethods(
    agesImpl,
    ['receipt', 'fcu_state', 'estimator', 'position', 'velocity', 'battery', 'fence', 'links'],
    'VehicleHealthAgesV1'
  )
  const observed = structItem(healthCode, 'ObservedVehicleHealthV1')
  if (normalizedRustBody(leadingAttributes(healthCode, observed.start)) !== '#[derive(Debug)]')
    fail('ObservedVehicleHealthV1 must remain non-cloneable and non-copy')
  const observedImpl = implItem(healthCode, 'ObservedVehicleHealthV1')
  assertExactMethods(
    observedImpl,
    ['snapshot', 'register_sequence', 'ages'],
    'ObservedVehicleHealthV1'
  )

  const freshnessStructs = new Map([
    [
      'VehicleHealthAgeLimitsProposalV1',
      'pub receipt:Duration,pub fcu_state:Duration,pub estimator:Duration,pub position:Duration,pub velocity:Duration,pub battery:Duration,pub fence:Duration,pub links:Duration,',
    ],
    ['VehicleHealthAgePolicyConfigurationErrorV1', 'point:VehicleHealthAgePointV1,'],
    [
      'VehicleHealthCapturedAgePolicyV1',
      'profile:ProfileIdentity,limits:VehicleHealthAgeLimitsProposalV1,',
    ],
    [
      'VehicleHealthAgeAssessmentErrorV1',
      'policy_profile:ProfileIdentity,observed_profile:ProfileIdentity,',
    ],
    [
      'VehicleHealthAgeComparisonAtReadV1',
      'point:VehicleHealthAgePointV1,age:Duration,exclusive_limit:Duration,',
    ],
    [
      'VehicleHealthCapturedAgeAssessmentV1',
      "policy:&'policy VehicleHealthCapturedAgePolicyV1,observed:ObservedVehicleHealthV1,",
    ],
  ])
  const freshnessStructItems = new Map()
  for (const [name, expected] of freshnessStructs) {
    const item = structItem(freshnessProductionCode, name)
    freshnessStructItems.set(name, item)
    assertExactBody(item, expected, name)
  }
  const freshnessEnums = new Map([
    [
      'VehicleHealthAgePointV1',
      'Receipt,FcuState,Estimator,Position,Velocity,Battery,Fence,Links,',
    ],
    [
      'VehicleHealthAgeRelationAtReadV1',
      'WithinExclusiveLimitAtRead,AtOrBeyondExclusiveLimitAtRead,',
    ],
  ])
  const freshnessEnumItems = new Map()
  for (const [name, expected] of freshnessEnums) {
    const item = enumItem(freshnessProductionCode, name)
    freshnessEnumItems.set(name, item)
    assertExactBody(item, expected, name)
  }
  const expectedFreshnessDerives = new Map([
    ['VehicleHealthAgePointV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['VehicleHealthAgeLimitsProposalV1', '#[derive(Debug)]'],
    ['VehicleHealthAgePolicyConfigurationErrorV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['VehicleHealthCapturedAgePolicyV1', '#[derive(Debug)]'],
    ['VehicleHealthAgeAssessmentErrorV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['VehicleHealthAgeRelationAtReadV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['VehicleHealthAgeComparisonAtReadV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['VehicleHealthCapturedAgeAssessmentV1', '#[derive(Debug)]'],
  ])
  for (const [name, expected] of expectedFreshnessDerives) {
    const item = freshnessStructItems.get(name) ?? freshnessEnumItems.get(name)
    assertExactLeadingAttributes(freshnessProductionCode, item, expected, name)
  }

  const configurationErrorImpl = implItem(
    freshnessProductionCode,
    'VehicleHealthAgePolicyConfigurationErrorV1'
  )
  assertExactMethods(
    configurationErrorImpl,
    ['point'],
    'VehicleHealthAgePolicyConfigurationErrorV1'
  )
  const policyImpl = implItem(freshnessProductionCode, 'VehicleHealthCapturedAgePolicyV1')
  assertExactMethods(
    policyImpl,
    ['try_new', 'profile', 'exclusive_limit', 'assess'],
    'VehicleHealthCapturedAgePolicyV1'
  )
  const assessmentErrorImpl = implItem(freshnessProductionCode, 'VehicleHealthAgeAssessmentErrorV1')
  assertExactMethods(
    assessmentErrorImpl,
    ['policy_profile', 'observed_profile'],
    'VehicleHealthAgeAssessmentErrorV1'
  )
  const comparisonImpl = implItem(freshnessProductionCode, 'VehicleHealthAgeComparisonAtReadV1')
  assertExactMethods(
    comparisonImpl,
    ['point', 'age', 'exclusive_limit', 'relation_at_read'],
    'VehicleHealthAgeComparisonAtReadV1'
  )
  const assessmentImpl = oneBracedItem(
    freshnessProductionCode,
    "\\bimpl\\s*<\\s*'policy\\s*>\\s*VehicleHealthCapturedAgeAssessmentV1\\s*<\\s*'policy\\s*>",
    'VehicleHealthCapturedAgeAssessmentV1 inherent impl'
  )
  assertExactMethods(
    assessmentImpl,
    [
      'policy',
      'observed',
      'receipt',
      'fcu_state',
      'estimator',
      'position',
      'velocity',
      'battery',
      'fence',
      'links',
    ],
    'VehicleHealthCapturedAgeAssessmentV1'
  )
  const expectedFreshnessInherentImplCounts = new Map([
    ['VehicleHealthAgeLimitsProposalV1', 0],
    ['VehicleHealthAgePointV1', 0],
    ['VehicleHealthAgeRelationAtReadV1', 0],
    ['VehicleHealthAgePolicyConfigurationErrorV1', 1],
    ['VehicleHealthCapturedAgePolicyV1', 1],
    ['VehicleHealthAgeAssessmentErrorV1', 1],
    ['VehicleHealthAgeComparisonAtReadV1', 1],
    ['VehicleHealthCapturedAgeAssessmentV1', 1],
  ])
  const actualFreshnessInherentImplCounts = new Map(
    [...expectedFreshnessInherentImplCounts.keys()].map((name) => [name, 0])
  )
  for (const item of inherentImplItems(freshnessProductionCode)) {
    for (const name of expectedFreshnessInherentImplCounts.keys()) {
      const protectedTarget = new RegExp(`(?:^|::)${name}(?:\\s*<[^>{}]*>)?(?:\\s+where\\b|\\s*$)`)
      if (protectedTarget.test(item.target)) {
        actualFreshnessInherentImplCounts.set(name, actualFreshnessInherentImplCounts.get(name) + 1)
      }
    }
  }
  for (const [name, expected] of expectedFreshnessInherentImplCounts) {
    const actual = actualFreshnessInherentImplCounts.get(name)
    if (actual !== expected)
      fail(`${name} inherent impl count drift; expected ${expected}, got ${actual}`)
  }
  for (const item of [policyImpl, comparisonImpl, assessmentImpl])
    assertNoTopLevelMacroInvocations(item.body, 'vehicle-health freshness protected impl')

  const expectedFreshnessTraits = [
    'implfmt::DisplayforVehicleHealthAgeAssessmentErrorV1{',
    'implfmt::DisplayforVehicleHealthAgePolicyConfigurationErrorV1{',
    'implstd::error::ErrorforVehicleHealthAgeAssessmentErrorV1{',
    'implstd::error::ErrorforVehicleHealthAgePolicyConfigurationErrorV1{',
  ].sort()
  const freshnessTraits = traitImplItems(freshnessProductionCode)
    .map((item) => normalizedRustBody(item.header))
    .sort()
  if (
    freshnessTraits.length !== expectedFreshnessTraits.length ||
    freshnessTraits.some((header, index) => header !== expectedFreshnessTraits[index])
  ) {
    fail(`vehicle-health freshness trait surface drift; got ${freshnessTraits.join(',')}`)
  }

  if (
    /\b(?:Instant|SystemTime|PlantObservationTime|RuntimeGeneration|VehicleHealthReaderV1|VehicleHealthPublisherV1|VehicleHealthReportV1|VehicleHealthSnapshotV1|SnapshotSender|SnapshotReceiver|SnapshotChannel|KernelChannels|InertAdapter|LifecycleMachine)\b/.test(
      freshnessProductionCode
    )
  ) {
    fail('captured-read age policy must not read clocks, endpoints, lifecycle, or adapters')
  }
  if (/\.\s*state\s*\(/.test(freshnessProductionCode))
    fail('captured-read age policy must not interpret health state')
  if (
    /\bpub(?:\s*\([^)]*\))?\s+(?:(?:const|async|unsafe|extern)\s+)*fn\s+\w+\s*\([^)]*VehicleHealthAgesV1/.test(
      freshnessProductionCode
    )
  ) {
    fail('captured-read age policy must not accept bare ages')
  }
  if (
    /\bpub(?:\s*\([^)]*\))?\s+(?:(?:const|async|unsafe|extern)\s+)*fn\s+\w+\s*\([^)]*\)\s*->\s*bool\b/.test(
      freshnessProductionCode
    )
  ) {
    fail('captured-read age policy must not expose an aggregate boolean verdict')
  }

  const tryNew = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+fn\\s+try_new\\b',
    'VehicleHealthCapturedAgePolicyV1::try_new'
  )
  assertExactBody(
    tryNew,
    `
      for (point, limit) in [
        (VehicleHealthAgePointV1::Receipt, limits.receipt),
        (VehicleHealthAgePointV1::FcuState, limits.fcu_state),
        (VehicleHealthAgePointV1::Estimator, limits.estimator),
        (VehicleHealthAgePointV1::Position, limits.position),
        (VehicleHealthAgePointV1::Velocity, limits.velocity),
        (VehicleHealthAgePointV1::Battery, limits.battery),
        (VehicleHealthAgePointV1::Fence, limits.fence),
        (VehicleHealthAgePointV1::Links, limits.links),
      ] {
        if limit.is_zero() {
          return Err(VehicleHealthAgePolicyConfigurationErrorV1 { point });
        }
      }
      Ok(Self { profile, limits })
    `,
    'VehicleHealthCapturedAgePolicyV1::try_new'
  )
  const policyProfile = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+const\\s+fn\\s+profile\\b',
    'VehicleHealthCapturedAgePolicyV1::profile'
  )
  assertExactBody(policyProfile, 'self.profile', 'VehicleHealthCapturedAgePolicyV1::profile')
  const policyLimit = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+const\\s+fn\\s+exclusive_limit\\b',
    'VehicleHealthCapturedAgePolicyV1::exclusive_limit'
  )
  assertExactBody(
    policyLimit,
    `
      match point {
        VehicleHealthAgePointV1::Receipt => self.limits.receipt,
        VehicleHealthAgePointV1::FcuState => self.limits.fcu_state,
        VehicleHealthAgePointV1::Estimator => self.limits.estimator,
        VehicleHealthAgePointV1::Position => self.limits.position,
        VehicleHealthAgePointV1::Velocity => self.limits.velocity,
        VehicleHealthAgePointV1::Battery => self.limits.battery,
        VehicleHealthAgePointV1::Fence => self.limits.fence,
        VehicleHealthAgePointV1::Links => self.limits.links,
      }
    `,
    'VehicleHealthCapturedAgePolicyV1::exclusive_limit'
  )
  const assess = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+fn\\s+assess\\b',
    'VehicleHealthCapturedAgePolicyV1::assess'
  )
  assertExactBody(
    assess,
    `
      let observed_profile = observed.snapshot().metadata().domain().profile();
      if observed_profile != self.profile {
        return Err(VehicleHealthAgeAssessmentErrorV1 {
          policy_profile: self.profile,
          observed_profile,
        });
      }
      Ok(VehicleHealthCapturedAgeAssessmentV1 {
        policy: self,
        observed,
      })
    `,
    'VehicleHealthCapturedAgePolicyV1::assess'
  )

  const relationAtRead = oneBracedItem(
    comparisonImpl.body,
    '\\bpub\\s+fn\\s+relation_at_read\\b',
    'VehicleHealthAgeComparisonAtReadV1::relation_at_read'
  )
  assertExactBody(
    relationAtRead,
    `
      if self.age < self.exclusive_limit {
        VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead
      } else {
        VehicleHealthAgeRelationAtReadV1::AtOrBeyondExclusiveLimitAtRead
      }
    `,
    'VehicleHealthAgeComparisonAtReadV1::relation_at_read'
  )
  for (const [method, expected] of [
    ['point', 'self.point'],
    ['age', 'self.age'],
    ['exclusive_limit', 'self.exclusive_limit'],
  ]) {
    const accessor = oneBracedItem(
      comparisonImpl.body,
      `\\bpub\\s+const\\s+fn\\s+${method}\\b`,
      `VehicleHealthAgeComparisonAtReadV1::${method}`
    )
    assertExactBody(accessor, expected, `VehicleHealthAgeComparisonAtReadV1::${method}`)
  }

  for (const [method, point] of [
    ['receipt', 'Receipt'],
    ['fcu_state', 'FcuState'],
    ['estimator', 'Estimator'],
    ['position', 'Position'],
    ['velocity', 'Velocity'],
    ['battery', 'Battery'],
    ['fence', 'Fence'],
    ['links', 'Links'],
  ]) {
    const accessor = oneBracedItem(
      assessmentImpl.body,
      `\\bpub\\s+fn\\s+${method}\\b`,
      `VehicleHealthCapturedAgeAssessmentV1::${method}`
    )
    assertExactBody(
      accessor,
      `self.comparison(VehicleHealthAgePointV1::${point})`,
      `VehicleHealthCapturedAgeAssessmentV1::${method}`
    )
  }
  const assessmentPolicy = oneBracedItem(
    assessmentImpl.body,
    '\\bpub\\s+const\\s+fn\\s+policy\\b',
    'VehicleHealthCapturedAgeAssessmentV1::policy'
  )
  assertExactBody(assessmentPolicy, 'self.policy', 'VehicleHealthCapturedAgeAssessmentV1::policy')
  const assessmentObserved = oneBracedItem(
    assessmentImpl.body,
    '\\bpub\\s+const\\s+fn\\s+observed\\b',
    'VehicleHealthCapturedAgeAssessmentV1::observed'
  )
  assertExactBody(
    assessmentObserved,
    '&self.observed',
    'VehicleHealthCapturedAgeAssessmentV1::observed'
  )
  const assessmentComparison = oneBracedItem(
    assessmentImpl.body,
    '\\bfn\\s+comparison\\b',
    'VehicleHealthCapturedAgeAssessmentV1::comparison'
  )
  assertExactBody(
    assessmentComparison,
    `
      let ages = self.observed.ages();
      let age = age_for_point(ages, point);
      VehicleHealthAgeComparisonAtReadV1 {
        point,
        age,
        exclusive_limit: self.policy.exclusive_limit(point),
      }
    `,
    'VehicleHealthCapturedAgeAssessmentV1::comparison'
  )
  const ageForPoint = oneBracedItem(
    freshnessProductionCode,
    '\\bconst\\s+fn\\s+age_for_point\\b',
    'age_for_point'
  )
  assertExactBody(
    ageForPoint,
    `
      match point {
        VehicleHealthAgePointV1::Receipt => ages.receipt(),
        VehicleHealthAgePointV1::FcuState => ages.fcu_state(),
        VehicleHealthAgePointV1::Estimator => ages.estimator(),
        VehicleHealthAgePointV1::Position => ages.position(),
        VehicleHealthAgePointV1::Velocity => ages.velocity(),
        VehicleHealthAgePointV1::Battery => ages.battery(),
        VehicleHealthAgePointV1::Fence => ages.fence(),
        VehicleHealthAgePointV1::Links => ages.links(),
      }
    `,
    'age_for_point'
  )
  const freshnessFunctions = topLevelFunctions(freshnessProductionCode)
  if (freshnessFunctions.length !== 1 || freshnessFunctions[0] !== 'private:age_for_point') {
    fail(`vehicle-health freshness function surface drift; got ${freshnessFunctions.join(',')}`)
  }
  const freshnessAliases = topLevelAliasDeclarations(freshnessProductionCode)
  if (freshnessAliases.length !== 0)
    fail(`vehicle-health freshness aliases are forbidden; got ${freshnessAliases.join(',')}`)
  const healthChannelImpl = implItem(healthCode, 'VehicleHealthChannelV1')
  assertNoTopLevelMacroInvocations(healthChannelImpl.body, 'VehicleHealthChannelV1 impl')
  assertExactMethods(healthChannelImpl, ['commit', 'load'], 'VehicleHealthChannelV1')
  const visibleFunctions = topLevelVisibleFunctions(healthCode)
  const expectedVisibleFunctions = [
    'public:vehicle_health_channel',
    'crate:vehicle_health_channel_set',
  ]
  if (
    visibleFunctions.length !== expectedVisibleFunctions.length ||
    visibleFunctions.some((name, index) => name !== expectedVisibleFunctions[index])
  ) {
    fail(
      `vehicle-health module function surface drift; expected ${expectedVisibleFunctions.join(',')}, got ${visibleFunctions.join(',')}`
    )
  }
  const aliasDeclarations = topLevelAliasDeclarations(healthCode)
  if (aliasDeclarations.length !== 0)
    fail(`vehicle-health endpoint aliases are forbidden; got ${aliasDeclarations.join(',')}`)
  const visibleChannelFunctions = topLevelVisibleFunctions(channelsCode)
  const expectedVisibleChannelFunctions = [
    'public:latest_value',
    'public:snapshot_value',
    'public:bounded_queue',
  ]
  if (
    visibleChannelFunctions.length !== expectedVisibleChannelFunctions.length ||
    visibleChannelFunctions.some((name, index) => name !== expectedVisibleChannelFunctions[index])
  ) {
    fail(
      `plant channel module function surface drift; expected ${expectedVisibleChannelFunctions.join(',')}, got ${visibleChannelFunctions.join(',')}`
    )
  }
  if (
    /\bpub(?:\s*\([^)]*\))?\s+(?:(?:const|async|unsafe|extern)\s+)*fn\s+\w+\s*\([^)]*\)\s*->\s*[^;{]*Snapshot(?:Sender|Receiver|Channel)/.test(
      healthCode
    )
  )
    fail('vehicle-health API must not expose a raw retained-register endpoint')
  const forbiddenTraitSurface =
    /\b(?:ObservedVehicleHealthV1|VehicleHealth(?:PublisherV1|ReaderV1|ChannelV1)|Snapshot(?:Sender|Receiver|Channel)\s*<\s*VehicleHealth)/
  for (const item of traitImplItems(healthCode)) {
    if (forbiddenTraitSurface.test(`${item.header}${item.body}`))
      fail('vehicle-health endpoint must not gain an explicit trait surface')
  }
  for (const item of traitImplItems(channelsCode)) {
    if (/\bKernelChannels\b/.test(`${item.header}${item.body}`))
      fail('KernelChannels must not gain an alternate trait surface')
  }
  if (/\b(?:snapshot_value|SnapshotSender|SnapshotReceiver|SnapshotChannel)\b/.test(runtimeCode))
    fail('headless runtime must use only the typed vehicle-health path')
  for (const path of walkRustFiles(PLANT_ROOT)) {
    if (realpathSync(path) === realpathSync(HEALTH_SOURCE)) continue
    let source = readFileSync(path, 'utf8')
    if (realpathSync(path) === realpathSync(resolve(PLANT_ROOT, 'src/channels.rs')))
      source = overrides.channels ?? source
    else if (realpathSync(path) === realpathSync(resolve(PLANT_ROOT, 'src/runtime.rs')))
      source = overrides.runtime ?? source
    else if (realpathSync(path) === realpathSync(resolve(PLANT_ROOT, 'src/lib.rs')))
      source = overrides.library ?? source
    else if (realpathSync(path) === realpathSync(FRESHNESS_SOURCE))
      source = overrides.freshness ?? source
    else if (realpathSync(path) === realpathSync(CONTRACT_SOURCE))
      source = overrides.contract ?? source
    else if (realpathSync(path) === realpathSync(LIFECYCLE_SOURCE))
      source = overrides.lifecycle ?? source
    const code = rustBoundaryCode(source)
    if (/\bSnapshot(?:Sender|Receiver|Channel)\s*<\s*VehicleHealth/.test(code))
      fail(`raw vehicle-health snapshot endpoint escaped into ${relative(ROOT, path)}`)
  }

  const sourceRoot = resolve(PLANT_ROOT, 'src')
  const freshnessUse =
    /\b(?:freshness|VehicleHealthAge(?:AssessmentError|ComparisonAtRead|LimitsProposal|Point|PolicyConfiguration|RelationAtRead)V1|VehicleHealthCapturedAge(?:Assessment|Policy)V1)\b/
  let libraryWithoutFreshnessSurface = libraryCode
  for (const [start, end] of [
    [
      freshnessModuleDeclarations[0].index,
      freshnessModuleDeclarations[0].index + freshnessModuleDeclarations[0][0].length,
    ],
    [freshnessReexports.start, freshnessReexports.end],
  ]) {
    libraryWithoutFreshnessSurface =
      libraryWithoutFreshnessSurface.slice(0, start) +
      blankRustSegment(libraryWithoutFreshnessSurface, start, end) +
      libraryWithoutFreshnessSurface.slice(end)
  }
  if (freshnessUse.test(libraryWithoutFreshnessSurface))
    fail(
      'captured-read age policy must remain unwired in src-tauri/crates/plant-authority/src/lib.rs'
    )
  for (const path of walkRustFiles(sourceRoot)) {
    const canonical = realpathSync(path)
    if (
      canonical === realpathSync(FRESHNESS_SOURCE) ||
      canonical === realpathSync(resolve(PLANT_ROOT, 'src/lib.rs'))
    ) {
      continue
    }
    let source = readFileSync(path, 'utf8')
    if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/channels.rs')))
      source = overrides.channels ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/runtime.rs')))
      source = overrides.runtime ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/adapter.rs')))
      source = overrides.adapter ?? source
    else if (canonical === realpathSync(HEALTH_SOURCE)) source = overrides.health ?? source
    const code = rustBoundaryCode(source)
    if (freshnessUse.test(code))
      fail(`captured-read age policy must remain unwired in ${relative(ROOT, path)}`)
  }
}

function verifySafeActionBoundary(overrides = {}) {
  assertCanonicalPathWithin(SAFE_ACTION_SOURCE, PLANT_ROOT, 'safe-action source')
  const safeActionCode = rustBoundaryCode(
    overrides.safeAction ?? readFileSync(SAFE_ACTION_SOURCE, 'utf8')
  )
  const libraryCode = rustBoundaryCode(
    overrides.library ?? readFileSync(resolve(PLANT_ROOT, 'src/lib.rs'), 'utf8')
  )

  const moduleDeclarations = [
    ...libraryCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+safe_action\s*;/g),
  ]
  if (
    moduleDeclarations.length !== 1 ||
    normalizedRustBody(moduleDeclarations[0][0]) !== 'modsafe_action;' ||
    leadingAttributes(libraryCode, moduleDeclarations[0].index) !== ''
  ) {
    fail('safe-action module must have one private unconditional crate-root declaration')
  }
  const reexports = oneBracedItem(
    libraryCode,
    '\\bpub\\s+use\\s+safe_action\\s*::',
    'safe-action crate-root re-export'
  )
  assertExactLeadingAttributes(libraryCode, reexports, '', 'safe-action crate-root re-export')
  assertExactBody(
    reexports,
    `
      SafeActionIntentV1, SafeActionPolicyCandidateV1, SafeActionPolicyConfigurationErrorV1,
      SafeActionPolicyRowProposalV1, SafeActionSelectionCandidateV1, SafeActionSelectionErrorV1,
      SafeActionSituationCandidateV1, SafeActionSituationCodeErrorV1, SafeActionSituationCodeV1,
      MAX_SAFE_ACTION_POLICY_ROWS_V1,
    `,
    'safe-action crate-root re-export'
  )

  const submodules = [
    ...safeActionCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*(?:;|\{)/g),
  ]
  if (submodules.length !== 1 || submodules[0][1] !== 'tests')
    fail('safe-action implementation must not gain child modules')
  const tests = oneBracedItem(
    safeActionCode,
    '#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)\\s*\\]\\s*mod\\s+tests',
    'safe-action test module'
  )
  const productionCode =
    safeActionCode.slice(0, tests.start) +
    blankRustSegment(safeActionCode, tests.start, tests.end) +
    safeActionCode.slice(tests.end)
  assertNoTopLevelMacroInvocations(productionCode, 'safe-action module')
  assertNoLocalMacroDefinitions(productionCode, 'safe-action module')

  const expectedTypes = [
    'visible:struct:SafeActionSituationCodeErrorV1',
    'visible:struct:SafeActionSituationCodeV1',
    'visible:enum:SafeActionIntentV1',
    'visible:struct:SafeActionPolicyRowProposalV1',
    'visible:enum:SafeActionPolicyConfigurationErrorV1',
    'visible:struct:SafeActionPolicyCandidateV1',
    'visible:struct:SafeActionSituationCandidateV1',
    'visible:enum:SafeActionSelectionErrorV1',
    'visible:struct:SafeActionSelectionCandidateV1',
  ]
  const actualTypes = topLevelTypeDeclarations(productionCode)
  if (
    actualTypes.length !== expectedTypes.length ||
    actualTypes.some((declaration, index) => declaration !== expectedTypes[index])
  ) {
    fail(`safe-action type surface drift; got ${actualTypes.join(',')}`)
  }
  const aliases = topLevelAliasDeclarations(productionCode)
  if (aliases.length !== 0) fail(`safe-action aliases are forbidden; got ${aliases.join(',')}`)
  const functions = topLevelFunctions(productionCode)
  if (functions.length !== 0)
    fail(`safe-action top-level functions are forbidden; got ${functions.join(',')}`)

  const maximumDeclarations = [
    ...productionCode.matchAll(
      /\bpub\s+const\s+MAX_SAFE_ACTION_POLICY_ROWS_V1\s*:\s*usize\s*=\s*u8\s*::\s*MAX\s+as\s+usize\s*;/g
    ),
  ]
  const constants = topLevelConstantDeclarations(productionCode)
  if (
    maximumDeclarations.length !== 1 ||
    constants.length !== 1 ||
    constants[0] !== 'visible:MAX_SAFE_ACTION_POLICY_ROWS_V1'
  ) {
    fail('safe-action table bound must remain the complete nonzero u8 code space')
  }

  const codeError = unbracedStructItem(productionCode, 'SafeActionSituationCodeErrorV1')
  if (normalizedRustBody(codeError.declaration) !== 'pubstructSafeActionSituationCodeErrorV1;') {
    fail('SafeActionSituationCodeErrorV1 closed value shape drift')
  }
  const situationCode = unbracedStructItem(productionCode, 'SafeActionSituationCodeV1')
  if (
    normalizedRustBody(situationCode.declaration) !==
    'pubstructSafeActionSituationCodeV1(NonZeroU8);'
  ) {
    fail('SafeActionSituationCodeV1 closed value shape drift')
  }

  const structShapes = new Map([
    [
      'SafeActionPolicyRowProposalV1',
      'situation_code:SafeActionSituationCodeV1,intent:SafeActionIntentV1,',
    ],
    [
      'SafeActionPolicyCandidateV1',
      'profile:ProfileIdentity,intents:[Option<SafeActionIntentV1>;MAX_SAFE_ACTION_POLICY_ROWS_V1],row_count:usize,',
    ],
    ['SafeActionSituationCandidateV1', 'profile:ProfileIdentity,code:SafeActionSituationCodeV1,'],
    [
      'SafeActionSelectionCandidateV1',
      "policy:&'policy SafeActionPolicyCandidateV1,situation:SafeActionSituationCandidateV1,intent:SafeActionIntentV1,",
    ],
  ])
  const structItems = new Map()
  for (const [name, expected] of structShapes) {
    const item = structItem(productionCode, name)
    structItems.set(name, item)
    assertExactBody(item, expected, name)
  }

  const enumShapes = new Map([
    [
      'SafeActionIntentV1',
      'InhibitPlantOutput,RequestProfileDefinedPhysicalHold,RequestControlledLand,RequestReturnToLaunch,RequestGroundDisarmTransaction,',
    ],
    [
      'SafeActionPolicyConfigurationErrorV1',
      'EmptyTable,TooManyRows{maximum:usize,received:usize,},DuplicateSituation{situation_code:SafeActionSituationCodeV1,},',
    ],
    [
      'SafeActionSelectionErrorV1',
      'ProfileMismatch{policy_profile:ProfileIdentity,situation_profile:ProfileIdentity,},MissingSituation{situation_code:SafeActionSituationCodeV1,},',
    ],
  ])
  const enumItems = new Map()
  for (const [name, expected] of enumShapes) {
    const item = enumItem(productionCode, name)
    enumItems.set(name, item)
    assertExactBody(item, expected, name)
  }

  const deriveItems = new Map([
    ['SafeActionSituationCodeErrorV1', codeError],
    ['SafeActionSituationCodeV1', situationCode],
    ...structItems,
    ...enumItems,
  ])
  const expectedDerives = new Map([
    ['SafeActionSituationCodeErrorV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['SafeActionSituationCodeV1', '#[derive(Clone,Copy,Debug,Eq,Ord,PartialEq,PartialOrd)]'],
    ['SafeActionIntentV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['SafeActionPolicyRowProposalV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['SafeActionPolicyConfigurationErrorV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['SafeActionPolicyCandidateV1', '#[derive(Debug)]'],
    ['SafeActionSituationCandidateV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['SafeActionSelectionErrorV1', '#[derive(Clone,Copy,Debug,Eq,PartialEq)]'],
    ['SafeActionSelectionCandidateV1', '#[derive(Debug)]'],
  ])
  for (const [name, expected] of expectedDerives)
    assertExactLeadingAttributes(productionCode, deriveItems.get(name), expected, name)

  if (/\bDefault\b/.test(productionCode))
    fail('safe-action policy and selection must not define a default')
  if (/\bfallback\b/i.test(productionCode)) fail('safe-action lookup must not define a fallback')

  const forbiddenDomainSurface =
    /\b(?:health|freshness|lifecycle|channels|runtime|adapter|[A-Za-z_]\w*(?:Health|Freshness)\w*|LifecycleMachine|LifecycleEvent|GuardedEvent|PlantState|Transition|KernelChannels|SnapshotChannel|SnapshotSender|SnapshotReceiver|SafetyLatch|SafetyNotice|ChannelError|InertAdapter|AdapterState|AdapterError|run_self_check|KernelError|SelfCheckReport|RuntimeGeneration|MonotonicExpiryGuard|ProposedAction\w*|CandidateProfileV1|CommandProposalV1|Velocity\w*|RawVelocityV1|FramedVelocityMetresPerSecond|FiniteFramedVelocityMpsV1|Axis)\b/
  if (forbiddenDomainSurface.test(productionCode))
    fail(
      'safe-action lookup must not interpret health, freshness, lifecycle, channels, runtime, adapters, contract actions, or velocity'
    )

  const codeImpl = implItem(productionCode, 'SafeActionSituationCodeV1')
  const rowImpl = implItem(productionCode, 'SafeActionPolicyRowProposalV1')
  const policyImpl = implItem(productionCode, 'SafeActionPolicyCandidateV1')
  const situationImpl = implItem(productionCode, 'SafeActionSituationCandidateV1')
  const selectionImpl = oneBracedItem(
    productionCode,
    "\\bimpl\\s*<\\s*'policy\\s*>\\s*SafeActionSelectionCandidateV1\\s*<\\s*'policy\\s*>",
    'SafeActionSelectionCandidateV1 inherent impl'
  )
  assertExactMethods(codeImpl, ['new', 'get'], 'SafeActionSituationCodeV1')
  assertExactMethods(rowImpl, ['new', 'situation_code', 'intent'], 'SafeActionPolicyRowProposalV1')
  assertExactMethods(
    policyImpl,
    ['try_from_rows', 'profile', 'row_count', 'select'],
    'SafeActionPolicyCandidateV1'
  )
  assertExactMethods(situationImpl, ['new', 'profile', 'code'], 'SafeActionSituationCandidateV1')
  assertExactMethods(
    selectionImpl,
    ['policy', 'situation', 'intent'],
    'SafeActionSelectionCandidateV1'
  )

  const expectedInherentImplCounts = new Map([
    ['SafeActionSituationCodeErrorV1', 0],
    ['SafeActionSituationCodeV1', 1],
    ['SafeActionIntentV1', 0],
    ['SafeActionPolicyRowProposalV1', 1],
    ['SafeActionPolicyConfigurationErrorV1', 0],
    ['SafeActionPolicyCandidateV1', 1],
    ['SafeActionSituationCandidateV1', 1],
    ['SafeActionSelectionErrorV1', 0],
    ['SafeActionSelectionCandidateV1', 1],
  ])
  const actualInherentImplCounts = new Map(
    [...expectedInherentImplCounts.keys()].map((name) => [name, 0])
  )
  for (const item of inherentImplItems(productionCode)) {
    for (const name of expectedInherentImplCounts.keys()) {
      const protectedTarget = new RegExp(`(?:^|::)${name}(?:\\s*<[^>{}]*>)?(?:\\s+where\\b|\\s*$)`)
      if (protectedTarget.test(item.target))
        actualInherentImplCounts.set(name, actualInherentImplCounts.get(name) + 1)
    }
  }
  for (const [name, expected] of expectedInherentImplCounts) {
    const actual = actualInherentImplCounts.get(name)
    if (actual !== expected)
      fail(`${name} inherent impl count drift; expected ${expected}, got ${actual}`)
  }
  for (const item of [codeImpl, rowImpl, policyImpl, situationImpl, selectionImpl]) {
    assertNoTopLevelMacroInvocations(item.body, 'safe-action protected impl')
    if (/\b(?:pub(?:\s*\([^)]*\))?\s+)?const\s+(?!fn\b)\w+\s*:/.test(item.body))
      fail('safe-action protected impls must not expose associated constants')
  }

  const codeNew = oneBracedItem(
    codeImpl.body,
    '\\bpub\\s+fn\\s+new\\s*\\(\\s*value\\s*:\\s*u8\\s*\\)\\s*->\\s*Result\\s*<\\s*Self\\s*,\\s*SafeActionSituationCodeErrorV1\\s*>',
    'SafeActionSituationCodeV1::new'
  )
  assertExactBody(
    codeNew,
    'NonZeroU8::new(value).map(Self).ok_or(SafeActionSituationCodeErrorV1)',
    'SafeActionSituationCodeV1::new'
  )
  const codeGet = oneBracedItem(
    codeImpl.body,
    '\\bpub\\s+const\\s+fn\\s+get\\s*\\(\\s*self\\s*\\)\\s*->\\s*u8',
    'SafeActionSituationCodeV1::get'
  )
  assertExactBody(codeGet, 'self.0.get()', 'SafeActionSituationCodeV1::get')

  const rowNew = oneBracedItem(
    rowImpl.body,
    '\\bpub\\s+const\\s+fn\\s+new\\s*\\(\\s*situation_code\\s*:\\s*SafeActionSituationCodeV1\\s*,\\s*intent\\s*:\\s*SafeActionIntentV1\\s*,?\\s*\\)\\s*->\\s*Self',
    'SafeActionPolicyRowProposalV1::new'
  )
  assertExactBody(rowNew, 'Self { situation_code, intent, }', 'SafeActionPolicyRowProposalV1::new')
  for (const [method, signature, expected] of [
    [
      'situation_code',
      '\\bpub\\s+const\\s+fn\\s+situation_code\\s*\\(\\s*self\\s*\\)\\s*->\\s*SafeActionSituationCodeV1',
      'self.situation_code',
    ],
    [
      'intent',
      '\\bpub\\s+const\\s+fn\\s+intent\\s*\\(\\s*self\\s*\\)\\s*->\\s*SafeActionIntentV1',
      'self.intent',
    ],
  ]) {
    const accessor = oneBracedItem(
      rowImpl.body,
      signature,
      `SafeActionPolicyRowProposalV1::${method}`
    )
    assertExactBody(accessor, expected, `SafeActionPolicyRowProposalV1::${method}`)
  }

  const tryFromRows = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+fn\\s+try_from_rows\\s*\\(\\s*profile\\s*:\\s*ProfileIdentity\\s*,\\s*rows\\s*:\\s*&\\s*\\[\\s*SafeActionPolicyRowProposalV1\\s*\\]\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*Self\\s*,\\s*SafeActionPolicyConfigurationErrorV1\\s*>',
    'SafeActionPolicyCandidateV1::try_from_rows'
  )
  assertExactBody(
    tryFromRows,
    `
      if rows.len() > MAX_SAFE_ACTION_POLICY_ROWS_V1 {
        return Err(SafeActionPolicyConfigurationErrorV1::TooManyRows {
          maximum: MAX_SAFE_ACTION_POLICY_ROWS_V1,
          received: rows.len(),
        });
      }
      if rows.is_empty() {
        return Err(SafeActionPolicyConfigurationErrorV1::EmptyTable);
      }
      let mut intents = [None; MAX_SAFE_ACTION_POLICY_ROWS_V1];
      for row in rows {
        let index = usize::from(row.situation_code.get() - 1);
        if intents[index].is_some() {
          return Err(SafeActionPolicyConfigurationErrorV1::DuplicateSituation {
            situation_code: row.situation_code,
          });
        }
        intents[index] = Some(row.intent);
      }
      Ok(Self {
        profile,
        intents,
        row_count: rows.len(),
      })
    `,
    'SafeActionPolicyCandidateV1::try_from_rows'
  )
  const policyProfile = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+const\\s+fn\\s+profile\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*ProfileIdentity',
    'SafeActionPolicyCandidateV1::profile'
  )
  assertExactBody(policyProfile, 'self.profile', 'SafeActionPolicyCandidateV1::profile')
  const rowCount = oneBracedItem(
    policyImpl.body,
    '\\bpub\\s+const\\s+fn\\s+row_count\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*usize',
    'SafeActionPolicyCandidateV1::row_count'
  )
  assertExactBody(rowCount, 'self.row_count', 'SafeActionPolicyCandidateV1::row_count')
  const select = oneBracedItem(
    policyImpl.body,
    "\\bpub\\s+fn\\s+select\\s*\\(\\s*&\\s*self\\s*,\\s*situation\\s*:\\s*SafeActionSituationCandidateV1\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*SafeActionSelectionCandidateV1\\s*<\\s*'_\\s*>\\s*,\\s*SafeActionSelectionErrorV1\\s*>",
    'SafeActionPolicyCandidateV1::select'
  )
  assertExactBody(
    select,
    `
      if situation.profile != self.profile {
        return Err(SafeActionSelectionErrorV1::ProfileMismatch {
          policy_profile: self.profile,
          situation_profile: situation.profile,
        });
      }
      let index = usize::from(situation.code.get() - 1);
      let intent = self.intents[index].ok_or(SafeActionSelectionErrorV1::MissingSituation {
        situation_code: situation.code,
      })?;
      Ok(SafeActionSelectionCandidateV1 {
        policy: self,
        situation,
        intent,
      })
    `,
    'SafeActionPolicyCandidateV1::select'
  )

  const situationNew = oneBracedItem(
    situationImpl.body,
    '\\bpub\\s+const\\s+fn\\s+new\\s*\\(\\s*profile\\s*:\\s*ProfileIdentity\\s*,\\s*code\\s*:\\s*SafeActionSituationCodeV1\\s*\\)\\s*->\\s*Self',
    'SafeActionSituationCandidateV1::new'
  )
  assertExactBody(situationNew, 'Self { profile, code }', 'SafeActionSituationCandidateV1::new')
  for (const [method, returnType, expected] of [
    ['profile', 'ProfileIdentity', 'self.profile'],
    ['code', 'SafeActionSituationCodeV1', 'self.code'],
  ]) {
    const accessor = oneBracedItem(
      situationImpl.body,
      `\\bpub\\s+const\\s+fn\\s+${method}\\s*\\(\\s*self\\s*\\)\\s*->\\s*${returnType}`,
      `SafeActionSituationCandidateV1::${method}`
    )
    assertExactBody(accessor, expected, `SafeActionSituationCandidateV1::${method}`)
  }

  const selectionAccessors = [
    [
      'policy',
      "\\bpub\\s+const\\s+fn\\s+policy\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*&\\s*'policy\\s+SafeActionPolicyCandidateV1",
      'self.policy',
    ],
    [
      'situation',
      '\\bpub\\s+const\\s+fn\\s+situation\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*SafeActionSituationCandidateV1',
      'self.situation',
    ],
    [
      'intent',
      '\\bpub\\s+const\\s+fn\\s+intent\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*SafeActionIntentV1',
      'self.intent',
    ],
  ]
  for (const [method, signature, expected] of selectionAccessors) {
    const accessor = oneBracedItem(
      selectionImpl.body,
      signature,
      `SafeActionSelectionCandidateV1::${method}`
    )
    assertExactBody(accessor, expected, `SafeActionSelectionCandidateV1::${method}`)
  }

  const expectedTraits = [
    'implfmt::DisplayforSafeActionPolicyConfigurationErrorV1{',
    'implfmt::DisplayforSafeActionSelectionErrorV1{',
    'implfmt::DisplayforSafeActionSituationCodeErrorV1{',
    'implstd::error::ErrorforSafeActionPolicyConfigurationErrorV1{',
    'implstd::error::ErrorforSafeActionSelectionErrorV1{',
    'implstd::error::ErrorforSafeActionSituationCodeErrorV1{',
  ].sort()
  const actualTraits = traitImplItems(productionCode)
    .map((item) => normalizedRustBody(item.header))
    .sort()
  if (
    actualTraits.length !== expectedTraits.length ||
    actualTraits.some((header, index) => header !== expectedTraits[index])
  ) {
    fail(`safe-action trait surface drift; got ${actualTraits.join(',')}`)
  }

  const safeActionUse =
    /\b(?:safe_action|SafeAction[A-Za-z0-9_]*V1|MAX_SAFE_ACTION_POLICY_ROWS_V1)\b/
  let libraryWithoutSafeActionSurface = libraryCode
  for (const [start, end] of [
    [moduleDeclarations[0].index, moduleDeclarations[0].index + moduleDeclarations[0][0].length],
    [reexports.start, reexports.end],
  ]) {
    libraryWithoutSafeActionSurface =
      libraryWithoutSafeActionSurface.slice(0, start) +
      blankRustSegment(libraryWithoutSafeActionSurface, start, end) +
      libraryWithoutSafeActionSurface.slice(end)
  }
  if (safeActionUse.test(libraryWithoutSafeActionSurface))
    fail('safe-action candidate lookup must remain unwired in the plant crate root')

  const sourceRoot = resolve(PLANT_ROOT, 'src')
  for (const path of walkRustFiles(sourceRoot)) {
    const canonical = realpathSync(path)
    if (
      canonical === realpathSync(SAFE_ACTION_SOURCE) ||
      canonical === realpathSync(resolve(PLANT_ROOT, 'src/lib.rs'))
    ) {
      continue
    }
    let source = readFileSync(path, 'utf8')
    if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/runtime.rs')))
      source = overrides.runtime ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/adapter.rs')))
      source = overrides.adapter ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/channels.rs')))
      source = overrides.channels ?? source
    else if (canonical === realpathSync(HEALTH_SOURCE)) source = overrides.health ?? source
    else if (canonical === realpathSync(FRESHNESS_SOURCE)) source = overrides.freshness ?? source
    else if (canonical === realpathSync(CONTRACT_SOURCE)) source = overrides.contract ?? source
    else if (canonical === realpathSync(LIFECYCLE_SOURCE)) source = overrides.lifecycle ?? source
    const code = rustBoundaryCode(source)
    if (safeActionUse.test(code))
      fail(`safe-action candidate lookup must remain unwired in ${relative(ROOT, path)}`)
  }
}

function verifyDeadlineMonitorBoundary(overrides = {}) {
  assertCanonicalPathWithin(DEADLINE_MONITOR_SOURCE, PLANT_ROOT, 'deadline-monitor source')
  const deadlineSource = overrides.deadlineMonitor ?? readFileSync(DEADLINE_MONITOR_SOURCE, 'utf8')
  const deadlineCode = rustBoundaryCode(deadlineSource)
  const contractCode = rustBoundaryCode(overrides.contract ?? readFileSync(CONTRACT_SOURCE, 'utf8'))
  const libraryCode = rustBoundaryCode(
    overrides.library ?? readFileSync(resolve(PLANT_ROOT, 'src/lib.rs'), 'utf8')
  )

  const moduleDeclarations = [
    ...libraryCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+deadline_monitor\s*;/g),
  ]
  if (
    moduleDeclarations.length !== 1 ||
    normalizedRustBody(moduleDeclarations[0][0]) !== 'moddeadline_monitor;' ||
    leadingAttributes(libraryCode, moduleDeclarations[0].index) !== ''
  ) {
    fail('deadline-monitor module must have one private unconditional crate-root declaration')
  }
  const reexports = oneBracedItem(
    libraryCode,
    '\\bpub\\s+use\\s+deadline_monitor\\s*::',
    'deadline-monitor crate-root re-export'
  )
  assertExactLeadingAttributes(libraryCode, reexports, '', 'deadline-monitor crate-root re-export')
  assertExactBody(
    reexports,
    `
      ActiveCommandDeadlineMonitorV1, CommandDeadlineKeyV1, CommandDeadlineTicketErrorV1,
      CommandDeadlineTicketV1, DeadlineAdvanceErrorV1, DeadlineAdvanceReceiptV1,
      DeadlineControlErrorV1, DeadlineDetectionEvidenceV1, DeadlineMonitorStartErrorV1,
      DeadlineMonitorTerminalKindV1, DeadlineMonitorTerminalV1,
    `,
    'deadline-monitor crate-root re-export'
  )

  const submodules = [
    ...deadlineCode.matchAll(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*(?:;|\{)/g),
  ]
  if (submodules.length !== 1 || submodules[0][1] !== 'tests')
    fail('deadline-monitor implementation must not gain child modules')
  const tests = oneBracedItem(
    deadlineCode,
    '#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)\\s*\\]\\s*mod\\s+tests',
    'deadline-monitor test module'
  )
  const productionCode =
    deadlineCode.slice(0, tests.start) +
    blankRustSegment(deadlineCode, tests.start, tests.end) +
    deadlineCode.slice(tests.end)
  assertNoTopLevelMacroInvocations(productionCode, 'deadline-monitor module')
  assertNoLocalMacroDefinitions(productionCode, 'deadline-monitor module')

  const expectedTypes = [
    'visible:struct:CommandDeadlineKeyV1',
    'visible:enum:CommandDeadlineTicketErrorV1',
    'visible:struct:CommandDeadlineTicketV1',
    'visible:enum:DeadlineMonitorTerminalKindV1',
    'visible:struct:DeadlineDetectionEvidenceV1',
    'visible:struct:DeadlineMonitorTerminalV1',
    'visible:struct:DeadlineMonitorStartErrorV1',
    'visible:enum:DeadlineAdvanceErrorV1',
    'visible:struct:DeadlineAdvanceReceiptV1',
    'visible:enum:DeadlineControlErrorV1',
    'private:struct:ActiveDeadline',
    'private:enum:MonitorPhase',
    'private:struct:MonitorState',
    'private:struct:SharedMonitor',
    'visible:struct:ActiveCommandDeadlineMonitorV1',
  ]
  const actualTypes = topLevelTypeDeclarations(productionCode)
  if (
    actualTypes.length !== expectedTypes.length ||
    actualTypes.some((declaration, index) => declaration !== expectedTypes[index])
  ) {
    fail(`deadline-monitor type surface drift; got ${actualTypes.join(',')}`)
  }
  const aliases = topLevelAliasDeclarations(productionCode)
  if (aliases.length !== 0) fail(`deadline-monitor aliases are forbidden; got ${aliases.join(',')}`)
  const functions = topLevelFunctions(productionCode)
  const expectedFunctions = [
    'private:lock_recovering_synchronization_failure',
    'private:publish_worker_panicked',
    'private:panic_injected_worker',
    'private:run_worker',
  ]
  if (
    functions.length !== expectedFunctions.length ||
    functions.some((declaration, index) => declaration !== expectedFunctions[index])
  ) {
    fail(`deadline-monitor top-level function surface drift; got ${functions.join(',')}`)
  }
  const panicHelperMatches = [
    ...productionCode.matchAll(
      /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*#\s*\[\s*cold\s*\]\s*fn\s+panic_injected_worker\s*\(\s*\)\s*->\s*!\s*\{\s*panic\s*!\s*\([^)]*\)\s*\}/g
    ),
  ]
  if (panicHelperMatches.length !== 1)
    fail('deadline-monitor injected worker panic helper must remain cfg(test), cold, and private')
  const panicHelper = panicHelperMatches[0]
  const productionCodeWithoutPanicHelper =
    productionCode.slice(0, panicHelper.index) +
    blankRustSegment(productionCode, panicHelper.index, panicHelper.index + panicHelper[0].length) +
    productionCode.slice(panicHelper.index + panicHelper[0].length)
  const constants = topLevelConstantDeclarations(productionCode)
  if (
    constants.length !== 1 ||
    constants[0] !== 'private:DEADLINE_WORKER_NAME' ||
    !/\bconst\s+DEADLINE_WORKER_NAME\s*:\s*&\s*str\s*=\s*"crebain-command-deadline-v1"\s*;/.test(
      deadlineSource
    )
  ) {
    fail('deadline-monitor worker name must remain one private exact constant')
  }

  const key = structItem(productionCode, 'CommandDeadlineKeyV1')
  const ticketError = enumItem(productionCode, 'CommandDeadlineTicketErrorV1')
  const ticket = structItem(productionCode, 'CommandDeadlineTicketV1')
  const terminalKind = enumItem(productionCode, 'DeadlineMonitorTerminalKindV1')
  const detection = structItem(productionCode, 'DeadlineDetectionEvidenceV1')
  const terminal = structItem(productionCode, 'DeadlineMonitorTerminalV1')
  const startError = structItem(productionCode, 'DeadlineMonitorStartErrorV1')
  const advanceError = enumItem(productionCode, 'DeadlineAdvanceErrorV1')
  const advanceReceipt = structItem(productionCode, 'DeadlineAdvanceReceiptV1')
  const controlError = enumItem(productionCode, 'DeadlineControlErrorV1')
  const activeDeadline = oneBracedItem(
    productionCode,
    '\\bstruct\\s+ActiveDeadline\\b',
    "struct 'ActiveDeadline'"
  )
  const monitorPhase = oneBracedItem(
    productionCode,
    '\\benum\\s+MonitorPhase\\b',
    "enum 'MonitorPhase'"
  )
  const monitorState = oneBracedItem(
    productionCode,
    '\\bstruct\\s+MonitorState\\b',
    "struct 'MonitorState'"
  )
  const sharedMonitor = oneBracedItem(
    productionCode,
    '\\bstruct\\s+SharedMonitor\\b',
    "struct 'SharedMonitor'"
  )
  const monitor = structItem(productionCode, 'ActiveCommandDeadlineMonitorV1')

  for (const [item, expected, label] of [
    [
      key,
      'profile:ProfileIdentity,session:CommandSessionIdentity,stream_sequence:CommandStreamSequence,generation:RuntimeGeneration,',
      'CommandDeadlineKeyV1',
    ],
    [
      ticket,
      'key:CommandDeadlineKeyV1,received_at:PlantReceiptTime,scheduled_ttl:Duration,deadline:Instant,',
      'CommandDeadlineTicketV1',
    ],
    [
      detection,
      'key:CommandDeadlineKeyV1,scheduled_ttl:Duration,admission_age:Duration,detected_age:Duration,late_by:Duration,',
      'DeadlineDetectionEvidenceV1',
    ],
    [
      terminal,
      'kind:DeadlineMonitorTerminalKindV1,active_key:Option<CommandDeadlineKeyV1>,deadline_detection:Option<DeadlineDetectionEvidenceV1>,reported_generation:Option<RuntimeGeneration>,superseding_key:Option<CommandDeadlineKeyV1>,',
      'DeadlineMonitorTerminalV1',
    ],
    [
      startError,
      'initial_key:CommandDeadlineKeyV1,initial_terminal_kind:Option<DeadlineMonitorTerminalKindV1>,',
      'DeadlineMonitorStartErrorV1',
    ],
    [
      advanceReceipt,
      'previous_key:CommandDeadlineKeyV1,accepted_key:CommandDeadlineKeyV1,skipped_sequences:u64,admission_age:Duration,',
      'DeadlineAdvanceReceiptV1',
    ],
    [activeDeadline, 'ticket:CommandDeadlineTicketV1,admission_age:Duration,', 'ActiveDeadline'],
    [
      monitorPhase,
      'Armed(ActiveDeadline),Terminal(Option<DeadlineMonitorTerminalV1>),',
      'MonitorPhase',
    ],
    [
      monitorState,
      'fixed_profile:ProfileIdentity,fixed_session:CommandSessionIdentity,fixed_generation:RuntimeGeneration,last_active_key:CommandDeadlineKeyV1,last_observed:Instant,phase:MonitorPhase,',
      'MonitorState',
    ],
    [
      sharedMonitor,
      'state:Mutex<MonitorState>,wake:Condvar,#[cfg(test)]panic_worker:AtomicBool,',
      'SharedMonitor',
    ],
    [
      monitor,
      'shared:Arc<SharedMonitor>,worker:Option<JoinHandle<()>>,',
      'ActiveCommandDeadlineMonitorV1',
    ],
  ]) {
    assertExactBody(item, expected, label)
  }
  for (const [item, expected, label] of [
    [
      ticketError,
      'GenerationMismatch{candidate:RuntimeGeneration,expected:RuntimeGeneration,},ZeroLocalTtlProposal,LocalTtlExceedsRequested{requested:Duration,proposed:Duration,},UnrepresentableDeadline,',
      'CommandDeadlineTicketErrorV1',
    ],
    [
      terminalKind,
      'DeadlineDetected,ReportedGenerationMismatch,ShutdownAcknowledged,ClockRegressed,SynchronizationFailed,WorkerPanicked,SupersedingReceiptRegressed,SupersedingDeadlineAlreadyExpired,',
      'DeadlineMonitorTerminalKindV1',
    ],
    [
      advanceError,
      'MonitorTerminal,ProfileMismatch{expected:ProfileIdentity,received:ProfileIdentity,},SessionMismatch{expected:CommandSessionIdentity,received:CommandSessionIdentity,},GenerationMismatch{expected:RuntimeGeneration,received:RuntimeGeneration,},SequenceNotAdvanced{current:CommandStreamSequence,received:CommandStreamSequence,},',
      'DeadlineAdvanceErrorV1',
    ],
    [
      controlError,
      'MonitorTerminal,SameGeneration{generation:RuntimeGeneration,},',
      'DeadlineControlErrorV1',
    ],
  ]) {
    assertExactBody(item, expected, label)
  }
  const expectedDerives = new Map([
    ['CommandDeadlineKeyV1', [key, '#[derive(Clone,Copy,Debug,Eq,PartialEq)]']],
    ['CommandDeadlineTicketErrorV1', [ticketError, '#[derive(Clone,Copy,Debug,Eq,PartialEq)]']],
    ['CommandDeadlineTicketV1', [ticket, '']],
    ['DeadlineMonitorTerminalKindV1', [terminalKind, '#[derive(Clone,Copy,Debug,Eq,PartialEq)]']],
    ['DeadlineDetectionEvidenceV1', [detection, '#[derive(Debug,Eq,PartialEq)]']],
    ['DeadlineMonitorTerminalV1', [terminal, '#[derive(Debug,Eq,PartialEq)]']],
    ['DeadlineMonitorStartErrorV1', [startError, '#[derive(Clone,Copy,Debug,Eq,PartialEq)]']],
    ['DeadlineAdvanceErrorV1', [advanceError, '#[derive(Clone,Copy,Debug,Eq,PartialEq)]']],
    ['DeadlineAdvanceReceiptV1', [advanceReceipt, '#[derive(Debug,Eq,PartialEq)]']],
    ['DeadlineControlErrorV1', [controlError, '#[derive(Clone,Copy,Debug,Eq,PartialEq)]']],
    ['ActiveDeadline', [activeDeadline, '#[derive(Debug)]']],
    ['MonitorPhase', [monitorPhase, '#[derive(Debug)]']],
    ['MonitorState', [monitorState, '#[derive(Debug)]']],
    ['SharedMonitor', [sharedMonitor, '#[derive(Debug)]']],
    ['ActiveCommandDeadlineMonitorV1', [monitor, '']],
  ])
  for (const [name, [item, expected]] of expectedDerives)
    assertExactLeadingAttributes(productionCode, item, expected, name)

  const keyImpl = implItem(productionCode, 'CommandDeadlineKeyV1')
  const ticketImpl = implItem(productionCode, 'CommandDeadlineTicketV1')
  const detectionImpl = implItem(productionCode, 'DeadlineDetectionEvidenceV1')
  const terminalImpl = implItem(productionCode, 'DeadlineMonitorTerminalV1')
  const startErrorImpl = implItem(productionCode, 'DeadlineMonitorStartErrorV1')
  const receiptImpl = implItem(productionCode, 'DeadlineAdvanceReceiptV1')
  const stateImpl = implItem(productionCode, 'MonitorState')
  const sharedImpl = inherentImplItems(productionCode).find(
    (item) => item.target === 'SharedMonitor'
  )
  if (!sharedImpl) fail("inherent impl 'SharedMonitor' is missing")
  const monitorImpl = implItem(productionCode, 'ActiveCommandDeadlineMonitorV1')
  assertExactAllMethods(
    keyImpl,
    ['profile', 'session', 'stream_sequence', 'generation'],
    'CommandDeadlineKeyV1'
  )
  assertExactAllMethods(
    ticketImpl,
    ['try_from_candidate', 'key', 'scheduled_ttl'],
    'CommandDeadlineTicketV1'
  )
  assertExactAllMethods(
    detectionImpl,
    ['key', 'scheduled_ttl', 'admission_age', 'detected_age', 'late_by'],
    'DeadlineDetectionEvidenceV1'
  )
  assertExactAllMethods(
    terminalImpl,
    [
      'kind',
      'active_key',
      'deadline_detection',
      'reported_generation',
      'superseding_key',
      'simple',
      'deadline',
      'reported_generation_mismatch',
      'superseding_fault',
      'synchronization_failed',
    ],
    'DeadlineMonitorTerminalV1'
  )
  assertExactAllMethods(
    startErrorImpl,
    ['initial_key', 'initial_terminal_kind'],
    'DeadlineMonitorStartErrorV1'
  )
  assertExactAllMethods(
    receiptImpl,
    ['previous_key', 'accepted_key', 'skipped_sequences', 'admission_age'],
    'DeadlineAdvanceReceiptV1'
  )
  assertExactAllMethods(
    stateImpl,
    [
      'from_initial_at',
      'observe_at',
      'advance_at',
      'report_generation_mismatch_at',
      'shutdown_at',
      'terminalize_worker_panicked',
      'terminalize_synchronization_failure',
      'terminalize',
      'take_terminal',
      'terminal_kind',
    ],
    'MonitorState'
  )
  assertExactAllMethods(sharedImpl, ['new'], 'SharedMonitor')
  assertExactAllMethods(
    monitorImpl,
    [
      'start',
      'submit_next',
      'report_generation_mismatch',
      'wait',
      'shutdown',
      'request_shutdown',
      'join_worker',
      'take_terminal_or_fault',
      'inject_worker_panic',
    ],
    'ActiveCommandDeadlineMonitorV1'
  )
  assertExactMethods(
    monitorImpl,
    ['start', 'submit_next', 'report_generation_mismatch', 'wait', 'shutdown'],
    'ActiveCommandDeadlineMonitorV1'
  )
  if (
    !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*fn\s+inject_worker_panic\s*\(\s*&\s*self\s*\)/.test(
      monitorImpl.body
    )
  ) {
    fail('deadline-monitor worker-panic injection must remain private and cfg(test)')
  }

  const expectedImplCounts = new Map([
    ['CommandDeadlineKeyV1', 1],
    ['CommandDeadlineTicketErrorV1', 0],
    ['CommandDeadlineTicketV1', 1],
    ['DeadlineMonitorTerminalKindV1', 0],
    ['DeadlineDetectionEvidenceV1', 1],
    ['DeadlineMonitorTerminalV1', 1],
    ['DeadlineMonitorStartErrorV1', 1],
    ['DeadlineAdvanceErrorV1', 0],
    ['DeadlineAdvanceReceiptV1', 1],
    ['DeadlineControlErrorV1', 0],
    ['ActiveDeadline', 0],
    ['MonitorPhase', 0],
    ['MonitorState', 1],
    ['SharedMonitor', 1],
    ['ActiveCommandDeadlineMonitorV1', 1],
  ])
  const actualImplCounts = new Map([...expectedImplCounts.keys()].map((name) => [name, 0]))
  for (const item of inherentImplItems(productionCode)) {
    for (const name of expectedImplCounts.keys()) {
      const protectedTarget = new RegExp(`(?:^|::)${name}(?:\\s*<[^>{}]*>)?(?:\\s+where\\b|\\s*$)`)
      if (protectedTarget.test(item.target))
        actualImplCounts.set(name, actualImplCounts.get(name) + 1)
    }
  }
  for (const [name, expected] of expectedImplCounts) {
    const actual = actualImplCounts.get(name)
    if (actual !== expected)
      fail(`${name} inherent impl count drift; expected ${expected}, got ${actual}`)
  }

  const expectedTraits = [
    'implDropforActiveCommandDeadlineMonitorV1{',
    'implfmt::DebugforCommandDeadlineTicketV1{',
    'implfmt::DisplayforCommandDeadlineTicketErrorV1{',
    'implfmt::DisplayforDeadlineAdvanceErrorV1{',
    'implfmt::DisplayforDeadlineControlErrorV1{',
    'implfmt::DisplayforDeadlineMonitorStartErrorV1{',
    'implstd::error::ErrorforCommandDeadlineTicketErrorV1{',
    'implstd::error::ErrorforDeadlineAdvanceErrorV1{',
    'implstd::error::ErrorforDeadlineControlErrorV1{',
    'implstd::error::ErrorforDeadlineMonitorStartErrorV1{',
  ].sort()
  const actualTraits = traitImplItems(productionCode)
    .map((item) => normalizedRustBody(item.header))
    .sort()
  if (
    actualTraits.length !== expectedTraits.length ||
    actualTraits.some((header, index) => header !== expectedTraits[index])
  ) {
    fail(`deadline-monitor trait surface drift; got ${actualTraits.join(',')}`)
  }

  for (const [method, signature, expected] of [
    [
      'active_key',
      '\\bpub\\s+const\\s+fn\\s+active_key\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*Option\\s*<\\s*CommandDeadlineKeyV1\\s*>',
      'self.active_key',
    ],
    [
      'reported_generation',
      '\\bpub\\s+const\\s+fn\\s+reported_generation\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*Option\\s*<\\s*RuntimeGeneration\\s*>',
      'self.reported_generation',
    ],
    [
      'simple',
      '\\bfn\\s+simple\\s*\\(\\s*kind\\s*:\\s*DeadlineMonitorTerminalKindV1\\s*,\\s*active_key\\s*:\\s*CommandDeadlineKeyV1\\s*,?\\s*\\)\\s*->\\s*Self',
      `
        Self {
          kind,
          active_key: Some(active_key),
          deadline_detection: None,
          reported_generation: None,
          superseding_key: None,
        }
      `,
    ],
    [
      'deadline',
      '\\bfn\\s+deadline\\s*\\(\\s*kind\\s*:\\s*DeadlineMonitorTerminalKindV1\\s*,\\s*active_key\\s*:\\s*CommandDeadlineKeyV1\\s*,\\s*ticket\\s*:\\s*&\\s*CommandDeadlineTicketV1\\s*,\\s*admission_age\\s*:\\s*Duration\\s*,\\s*detected_age\\s*:\\s*Duration\\s*,\\s*superseding_key\\s*:\\s*Option\\s*<\\s*CommandDeadlineKeyV1\\s*>\\s*,?\\s*\\)\\s*->\\s*Self',
      `
        Self {
          kind,
          active_key: Some(active_key),
          deadline_detection: Some(DeadlineDetectionEvidenceV1 {
            key: ticket.key,
            scheduled_ttl: ticket.scheduled_ttl,
            admission_age,
            detected_age,
            late_by: detected_age.saturating_sub(ticket.scheduled_ttl),
          }),
          reported_generation: None,
          superseding_key,
        }
      `,
    ],
    [
      'reported_generation_mismatch',
      '\\bfn\\s+reported_generation_mismatch\\s*\\(\\s*active_key\\s*:\\s*CommandDeadlineKeyV1\\s*,\\s*reported_generation\\s*:\\s*RuntimeGeneration\\s*,?\\s*\\)\\s*->\\s*Self',
      `
        Self {
          kind: DeadlineMonitorTerminalKindV1::ReportedGenerationMismatch,
          active_key: Some(active_key),
          deadline_detection: None,
          reported_generation: Some(reported_generation),
          superseding_key: None,
        }
      `,
    ],
    [
      'superseding_fault',
      '\\bfn\\s+superseding_fault\\s*\\(\\s*kind\\s*:\\s*DeadlineMonitorTerminalKindV1\\s*,\\s*active_key\\s*:\\s*CommandDeadlineKeyV1\\s*,\\s*superseding_key\\s*:\\s*CommandDeadlineKeyV1\\s*,?\\s*\\)\\s*->\\s*Self',
      `
        Self {
          kind,
          active_key: Some(active_key),
          deadline_detection: None,
          reported_generation: None,
          superseding_key: Some(superseding_key),
        }
      `,
    ],
    [
      'synchronization_failed',
      '\\bfn\\s+synchronization_failed\\s*\\(\\s*\\)\\s*->\\s*Self',
      `
        Self {
          kind: DeadlineMonitorTerminalKindV1::SynchronizationFailed,
          active_key: None,
          deadline_detection: None,
          reported_generation: None,
          superseding_key: None,
        }
      `,
    ],
  ]) {
    const item = oneBracedItem(terminalImpl.body, signature, `DeadlineMonitorTerminalV1::${method}`)
    assertExactBody(item, expected, `DeadlineMonitorTerminalV1::${method}`)
  }

  for (const [method, signature, expected] of [
    [
      'initial_key',
      '\\bpub\\s+const\\s+fn\\s+initial_key\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*CommandDeadlineKeyV1',
      'self.initial_key',
    ],
    [
      'initial_terminal_kind',
      '\\bpub\\s+const\\s+fn\\s+initial_terminal_kind\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*Option\\s*<\\s*DeadlineMonitorTerminalKindV1\\s*>',
      'self.initial_terminal_kind',
    ],
  ]) {
    const item = oneBracedItem(
      startErrorImpl.body,
      signature,
      `DeadlineMonitorStartErrorV1::${method}`
    )
    assertExactBody(item, expected, `DeadlineMonitorStartErrorV1::${method}`)
  }

  const ticketConstructor = oneBracedItem(
    ticketImpl.body,
    '\\bpub\\s+fn\\s+try_from_candidate\\s*\\(\\s*candidate\\s*:\\s*&\\s*VelocityCommandCandidateV1\\s*,\\s*expected_generation\\s*:\\s*RuntimeGeneration\\s*,\\s*local_ttl_proposal\\s*:\\s*Duration\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*Self\\s*,\\s*CommandDeadlineTicketErrorV1\\s*>',
    'CommandDeadlineTicketV1::try_from_candidate'
  )
  assertExactBody(
    ticketConstructor,
    `
      let candidate_generation = candidate.generation();
      if expected_generation != candidate_generation {
        return Err(CommandDeadlineTicketErrorV1::GenerationMismatch {
          candidate: candidate_generation,
          expected: expected_generation,
        });
      }
      if local_ttl_proposal.is_zero() {
        return Err(CommandDeadlineTicketErrorV1::ZeroLocalTtlProposal);
      }
      let requested = candidate.requested_ttl().get();
      if local_ttl_proposal > requested {
        return Err(CommandDeadlineTicketErrorV1::LocalTtlExceedsRequested {
          requested,
          proposed: local_ttl_proposal,
        });
      }
      let received_at = candidate.received_at();
      let deadline = received_at
        .checked_deadline(local_ttl_proposal)
        .ok_or(CommandDeadlineTicketErrorV1::UnrepresentableDeadline)?;
      Ok(Self {
        key: CommandDeadlineKeyV1 {
          profile: candidate.profile().identity(),
          session: candidate.session(),
          stream_sequence: candidate.stream_sequence(),
          generation: candidate_generation,
        },
        received_at,
        scheduled_ttl: local_ttl_proposal,
        deadline,
      })
    `,
    'CommandDeadlineTicketV1::try_from_candidate'
  )

  const receiptTimeImpl = implItem(contractCode, 'PlantReceiptTime')
  assertExactAllMethods(
    receiptTimeImpl,
    ['checked_deadline', 'elapsed_at', 'is_before', 'from_monotonic_test_instant'],
    'PlantReceiptTime deadline-monitor helper'
  )
  for (const [method, signature, expected] of [
    [
      'checked_deadline',
      '\\bpub\\s*\\(\\s*crate\\s*\\)\\s+fn\\s+checked_deadline\\s*\\(\\s*self\\s*,\\s*ttl\\s*:\\s*Duration\\s*\\)\\s*->\\s*Option\\s*<\\s*Instant\\s*>',
      'self.0.checked_add(ttl)',
    ],
    [
      'elapsed_at',
      '\\bpub\\s*\\(\\s*crate\\s*\\)\\s+fn\\s+elapsed_at\\s*\\(\\s*self\\s*,\\s*observed_at\\s*:\\s*Instant\\s*\\)\\s*->\\s*Option\\s*<\\s*Duration\\s*>',
      'observed_at.checked_duration_since(self.0)',
    ],
    [
      'is_before',
      '\\bpub\\s*\\(\\s*crate\\s*\\)\\s+fn\\s+is_before\\s*\\(\\s*self\\s*,\\s*other\\s*:\\s*Self\\s*\\)\\s*->\\s*bool',
      'self.0 < other.0',
    ],
  ]) {
    const helper = oneBracedItem(receiptTimeImpl.body, signature, `PlantReceiptTime::${method}`)
    assertExactBody(helper, expected, `PlantReceiptTime::${method}`)
  }
  if (
    !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*pub\s*\(\s*crate\s*\)\s+const\s+fn\s+from_monotonic_test_instant\s*\(\s*instant\s*:\s*Instant\s*\)\s*->\s*Self\s*\{\s*Self\s*\(\s*instant\s*\)\s*\}/.test(
      receiptTimeImpl.body
    )
  ) {
    fail('PlantReceiptTime controlled construction hook must remain cfg(test) and crate-private')
  }

  const observeAt = oneBracedItem(
    stateImpl.body,
    '\\bfn\\s+observe_at\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*observed_at\\s*:\\s*Instant\\s*\\)\\s*->\\s*Option\\s*<\\s*Duration\\s*>',
    'MonitorState::observe_at'
  )
  assertExactBody(
    observeAt,
    `
      if matches!(self.phase, MonitorPhase::Terminal(_)) {
        return None;
      }
      if observed_at < self.last_observed {
        self.terminalize(DeadlineMonitorTerminalV1::simple(
          DeadlineMonitorTerminalKindV1::ClockRegressed,
          self.last_active_key,
        ));
        return None;
      }
      self.last_observed = observed_at;
      let due_evidence = match &self.phase {
        MonitorPhase::Armed(active) if observed_at >= active.ticket.deadline => {
          let detected_age = active
            .ticket
            .received_at
            .elapsed_at(observed_at)
            .unwrap_or(Duration::ZERO);
          Some(DeadlineMonitorTerminalV1::deadline(
            DeadlineMonitorTerminalKindV1::DeadlineDetected,
            active.ticket.key,
            &active.ticket,
            active.admission_age,
            detected_age,
            None,
          ))
        }
        MonitorPhase::Armed(_) | MonitorPhase::Terminal(_) => None,
      };
      if let Some(terminal) = due_evidence {
        self.terminalize(terminal);
        return None;
      }
      match &self.phase {
        MonitorPhase::Armed(active) => Some(active.ticket.deadline.duration_since(observed_at)),
        MonitorPhase::Terminal(_) => None,
      }
    `,
    'MonitorState::observe_at'
  )

  const advanceAt = oneBracedItem(
    stateImpl.body,
    '\\bfn\\s+advance_at\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*next\\s*:\\s*CommandDeadlineTicketV1\\s*,\\s*observed_at\\s*:\\s*Instant\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*DeadlineAdvanceReceiptV1\\s*,\\s*DeadlineAdvanceErrorV1\\s*>',
    'MonitorState::advance_at'
  )
  assertExactBody(
    advanceAt,
    `
      if self.observe_at(observed_at).is_none() {
        return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
      }
      let next_key = next.key;
      if next_key.profile != self.fixed_profile {
        return Err(DeadlineAdvanceErrorV1::ProfileMismatch {
          expected: self.fixed_profile,
          received: next_key.profile,
        });
      }
      if next_key.session != self.fixed_session {
        return Err(DeadlineAdvanceErrorV1::SessionMismatch {
          expected: self.fixed_session,
          received: next_key.session,
        });
      }
      if next_key.generation != self.fixed_generation {
        return Err(DeadlineAdvanceErrorV1::GenerationMismatch {
          expected: self.fixed_generation,
          received: next_key.generation,
        });
      }
      let (current_key, current_receipt) = match &self.phase {
        MonitorPhase::Armed(active) => (active.ticket.key, active.ticket.received_at),
        MonitorPhase::Terminal(_) => return Err(DeadlineAdvanceErrorV1::MonitorTerminal),
      };
      if next_key.stream_sequence <= current_key.stream_sequence {
        return Err(DeadlineAdvanceErrorV1::SequenceNotAdvanced {
          current: current_key.stream_sequence,
          received: next_key.stream_sequence,
        });
      }
      if next.received_at.is_before(current_receipt) {
        self.terminalize(DeadlineMonitorTerminalV1::superseding_fault(
          DeadlineMonitorTerminalKindV1::SupersedingReceiptRegressed,
          current_key,
          next_key,
        ));
        return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
      }
      let Some(admission_age) = next.received_at.elapsed_at(observed_at) else {
        self.terminalize(DeadlineMonitorTerminalV1::simple(
          DeadlineMonitorTerminalKindV1::ClockRegressed,
          current_key,
        ));
        return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
      };
      if observed_at >= next.deadline {
        let terminal = DeadlineMonitorTerminalV1::deadline(
          DeadlineMonitorTerminalKindV1::SupersedingDeadlineAlreadyExpired,
          current_key,
          &next,
          admission_age,
          admission_age,
          Some(next_key),
        );
        self.terminalize(terminal);
        return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
      }
      let skipped_sequences =
        next_key.stream_sequence.get() - current_key.stream_sequence.get() - 1;
      self.phase = MonitorPhase::Armed(ActiveDeadline {
        ticket: next,
        admission_age,
      });
      self.last_active_key = next_key;
      Ok(DeadlineAdvanceReceiptV1 {
        previous_key: current_key,
        accepted_key: next_key,
        skipped_sequences,
        admission_age,
      })
    `,
    'MonitorState::advance_at'
  )

  for (const [method, signature, expected] of [
    [
      'report_generation_mismatch_at',
      '\\bfn\\s+report_generation_mismatch_at\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*reported_generation\\s*:\\s*RuntimeGeneration\\s*,\\s*observed_at\\s*:\\s*Instant\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*\\(\\s*\\)\\s*,\\s*DeadlineControlErrorV1\\s*>',
      `
        if self.observe_at(observed_at).is_none() {
          return Err(DeadlineControlErrorV1::MonitorTerminal);
        }
        if reported_generation == self.fixed_generation {
          return Err(DeadlineControlErrorV1::SameGeneration {
            generation: reported_generation,
          });
        }
        self.terminalize(DeadlineMonitorTerminalV1::reported_generation_mismatch(
          self.last_active_key,
          reported_generation,
        ));
        Ok(())
      `,
    ],
    [
      'shutdown_at',
      '\\bfn\\s+shutdown_at\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*observed_at\\s*:\\s*Instant\\s*\\)',
      `
        if self.observe_at(observed_at).is_some() {
          self.terminalize(DeadlineMonitorTerminalV1::simple(
            DeadlineMonitorTerminalKindV1::ShutdownAcknowledged,
            self.last_active_key,
          ));
        }
      `,
    ],
    [
      'terminalize_worker_panicked',
      '\\bfn\\s+terminalize_worker_panicked\\s*\\(\\s*&\\s*mut\\s+self\\s*\\)',
      `
        self.terminalize(DeadlineMonitorTerminalV1::simple(
          DeadlineMonitorTerminalKindV1::WorkerPanicked,
          self.last_active_key,
        ));
      `,
    ],
    [
      'terminalize_synchronization_failure',
      '\\bfn\\s+terminalize_synchronization_failure\\s*\\(\\s*&\\s*mut\\s+self\\s*\\)',
      'self.terminalize(DeadlineMonitorTerminalV1::synchronization_failed());',
    ],
    [
      'terminalize',
      '\\bfn\\s+terminalize\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*terminal\\s*:\\s*DeadlineMonitorTerminalV1\\s*\\)',
      `
        if matches!(self.phase, MonitorPhase::Armed(_)) {
          self.phase = MonitorPhase::Terminal(Some(terminal));
        }
      `,
    ],
    [
      'take_terminal',
      '\\bfn\\s+take_terminal\\s*\\(\\s*&\\s*mut\\s+self\\s*\\)\\s*->\\s*Option\\s*<\\s*DeadlineMonitorTerminalV1\\s*>',
      `
        match &mut self.phase {
          MonitorPhase::Armed(_) => None,
          MonitorPhase::Terminal(terminal) => terminal.take(),
        }
      `,
    ],
    [
      'terminal_kind',
      '\\bfn\\s+terminal_kind\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*Option\\s*<\\s*DeadlineMonitorTerminalKindV1\\s*>',
      `
        match &self.phase {
          MonitorPhase::Armed(_) | MonitorPhase::Terminal(None) => None,
          MonitorPhase::Terminal(Some(terminal)) => Some(terminal.kind),
        }
      `,
    ],
  ]) {
    const item = oneBracedItem(stateImpl.body, signature, `MonitorState::${method}`)
    assertExactBody(item, expected, `MonitorState::${method}`)
  }

  const productionCodeWithoutTestAttributes = productionCode.replace(
    /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g,
    (attribute) => blankRustSegment(attribute, 0, attribute.length)
  )
  const lockRecovering = oneBracedItem(
    productionCodeWithoutTestAttributes,
    "\\bfn\\s+lock_recovering_synchronization_failure\\s*\\(\\s*shared\\s*:\\s*&\\s*SharedMonitor\\s*,?\\s*\\)\\s*->\\s*\\(\\s*MutexGuard\\s*<\\s*'_\\s*,\\s*MonitorState\\s*>\\s*,\\s*bool\\s*\\)",
    'lock_recovering_synchronization_failure'
  )
  assertExactBody(
    lockRecovering,
    `
      match shared.state.lock() {
        Ok(state) => (state, false),
        Err(poisoned) => {
          let mut state = poisoned.into_inner();
          state.terminalize_synchronization_failure();
          (state, true)
        }
      }
    `,
    'lock_recovering_synchronization_failure'
  )
  const publishWorkerPanicked = oneBracedItem(
    productionCodeWithoutTestAttributes,
    '\\bfn\\s+publish_worker_panicked\\s*\\(\\s*shared\\s*:\\s*&\\s*SharedMonitor\\s*\\)',
    'publish_worker_panicked'
  )
  assertExactBody(
    publishWorkerPanicked,
    `
      let mut state = match shared.state.lock() {
        Ok(state) => state,
        Err(poisoned) => {
          let mut state = poisoned.into_inner();
          state.terminalize_synchronization_failure();
          drop(state);
          shared.wake.notify_all();
          return;
        }
      };
      state.terminalize_worker_panicked();
      drop(state);
      shared.wake.notify_all();
    `,
    'publish_worker_panicked'
  )

  const runWorker = oneBracedItem(
    productionCodeWithoutPanicHelper,
    '\\bfn\\s+run_worker\\s*\\(\\s*shared\\s*:\\s*&\\s*SharedMonitor\\s*\\)',
    'run_worker'
  )
  assertExactBody(
    runWorker,
    `
      let (mut state, poisoned) = lock_recovering_synchronization_failure(shared);
      if poisoned {
        drop(state);
        shared.wake.notify_all();
        return;
      }
      loop {
        #[cfg(test)]
        if shared.panic_worker.swap(false, Ordering::SeqCst) {
          drop(state);
          panic_injected_worker();
        }
        let Some(wait_for) = state.observe_at(Instant::now()) else {
          drop(state);
          shared.wake.notify_all();
          return;
        };
        match shared.wake.wait_timeout(state, wait_for) {
          Ok((next_state, _wait_result)) => state = next_state,
          Err(poisoned_wait) => {
            let (mut poisoned_state, _wait_result) = poisoned_wait.into_inner();
            poisoned_state.terminalize_synchronization_failure();
            drop(poisoned_state);
            shared.wake.notify_all();
            return;
          }
        }
      }
    `,
    'run_worker'
  )

  const start = oneBracedItem(
    monitorImpl.body,
    '\\bpub\\s+fn\\s+start\\s*\\(\\s*initial\\s*:\\s*CommandDeadlineTicketV1\\s*\\)\\s*->\\s*Result\\s*<\\s*Self\\s*,\\s*DeadlineMonitorStartErrorV1\\s*>',
    'ActiveCommandDeadlineMonitorV1::start'
  )
  assertExactBody(
    start,
    `
      let latest_key = initial.key;
      let state = MonitorState::from_initial_at(initial, Instant::now());
      let initial_terminal_kind = state.terminal_kind();
      let shared = Arc::new(SharedMonitor::new(state));
      let worker_shared = Arc::clone(&shared);
      let worker = thread::Builder::new()
        .name(DEADLINE_WORKER_NAME.to_owned())
        .spawn(move || {
          let outcome = panic::catch_unwind(AssertUnwindSafe(|| run_worker(&worker_shared)));
          if outcome.is_err() {
            publish_worker_panicked(&worker_shared);
          }
        })
        .map_err(|_| DeadlineMonitorStartErrorV1 {
          initial_key: latest_key,
          initial_terminal_kind,
        })?;
      Ok(Self {
        shared,
        worker: Some(worker),
      })
    `,
    'ActiveCommandDeadlineMonitorV1::start'
  )
  for (const [method, signature, expected] of [
    [
      'submit_next',
      '\\bpub\\s+fn\\s+submit_next\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*next\\s*:\\s*CommandDeadlineTicketV1\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*DeadlineAdvanceReceiptV1\\s*,\\s*DeadlineAdvanceErrorV1\\s*>',
      `
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        let result = state.advance_at(next, Instant::now());
        drop(state);
        self.shared.wake.notify_all();
        result
      `,
    ],
    [
      'report_generation_mismatch',
      '\\bpub\\s+fn\\s+report_generation_mismatch\\s*\\(\\s*&\\s*mut\\s+self\\s*,\\s*reported_generation\\s*:\\s*RuntimeGeneration\\s*,?\\s*\\)\\s*->\\s*Result\\s*<\\s*\\(\\s*\\)\\s*,\\s*DeadlineControlErrorV1\\s*>',
      `
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        let result = state.report_generation_mismatch_at(reported_generation, Instant::now());
        drop(state);
        self.shared.wake.notify_all();
        result
      `,
    ],
    [
      'wait',
      '\\bpub\\s+fn\\s+wait\\s*\\(\\s*mut\\s+self\\s*\\)\\s*->\\s*DeadlineMonitorTerminalV1',
      'self.join_worker(); self.take_terminal_or_fault()',
    ],
    [
      'shutdown',
      '\\bpub\\s+fn\\s+shutdown\\s*\\(\\s*mut\\s+self\\s*\\)\\s*->\\s*DeadlineMonitorTerminalV1',
      'self.request_shutdown(); self.join_worker(); self.take_terminal_or_fault()',
    ],
    [
      'request_shutdown',
      '\\bfn\\s+request_shutdown\\s*\\(\\s*&\\s*self\\s*\\)',
      `
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        state.shutdown_at(Instant::now());
        drop(state);
        self.shared.wake.notify_all();
      `,
    ],
    [
      'join_worker',
      '\\bfn\\s+join_worker\\s*\\(\\s*&\\s*mut\\s+self\\s*\\)',
      `
        if let Some(worker) = self.worker.take() {
          if worker.join().is_err() {
            publish_worker_panicked(&self.shared);
          }
        }
      `,
    ],
    [
      'take_terminal_or_fault',
      '\\bfn\\s+take_terminal_or_fault\\s*\\(\\s*&\\s*self\\s*\\)\\s*->\\s*DeadlineMonitorTerminalV1',
      `
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        let terminal = state.take_terminal();
        drop(state);
        terminal.unwrap_or_else(DeadlineMonitorTerminalV1::synchronization_failed)
      `,
    ],
  ]) {
    const item = oneBracedItem(
      monitorImpl.body,
      signature,
      `ActiveCommandDeadlineMonitorV1::${method}`
    )
    assertExactBody(item, expected, `ActiveCommandDeadlineMonitorV1::${method}`)
  }
  if (
    !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*fn\s+inject_worker_panic\s*\(\s*&\s*self\s*\)\s*\{\s*let\s*\(\s*state\s*,\s*_poisoned\s*\)\s*=\s*lock_recovering_synchronization_failure\s*\(\s*&\s*self\.shared\s*\)\s*;\s*self\.shared\.panic_worker\.store\s*\(\s*true\s*,\s*Ordering::SeqCst\s*\)\s*;\s*drop\s*\(\s*state\s*\)\s*;\s*self\.shared\.wake\.notify_all\s*\(\s*\)\s*;\s*\}/.test(
      monitorImpl.body
    )
  ) {
    fail('deadline-monitor panic injection must set its predicate while holding the state lock')
  }

  const dropImpl = traitImplItems(productionCode).find(
    (item) => normalizedRustBody(item.header) === 'implDropforActiveCommandDeadlineMonitorV1{'
  )
  if (!dropImpl) fail('ActiveCommandDeadlineMonitorV1 Drop impl is missing')
  assertExactBody(
    dropImpl,
    `
      fn drop(&mut self) {
        if self.worker.is_some() {
          self.request_shutdown();
          self.join_worker();
        }
      }
    `,
    'ActiveCommandDeadlineMonitorV1 Drop impl'
  )

  if (
    /\b(?:Vec|VecDeque|LinkedList|BinaryHeap|HashMap|BTreeMap|mpsc|sync_channel|Sender|Receiver)\b/.test(
      productionCode
    )
  ) {
    fail('deadline monitor must remain one fixed active slot with no queue or mailbox')
  }
  if (/\b(?:sleep|park|park_timeout|yield_now|spin_loop|spawn_blocking)\b/.test(productionCode)) {
    fail('deadline-monitor worker must not poll, sleep, park, spin, or detach')
  }
  if (/\b(?:callback|dyn\s+Fn|FnMut|FnOnce)\b/.test(productionCode))
    fail('deadline monitor must not invoke caller callbacks')
  if (/\.\s*notify_one\s*\(/.test(productionCode))
    fail('deadline monitor must wake its worker and terminal waiter with notify_all')
  if ((productionCode.match(/\.\s*spawn\s*\(/g) ?? []).length !== 1)
    fail('deadline monitor must own exactly one worker spawn site')
  if ((productionCode.match(/\.\s*wait_timeout\s*\(/g) ?? []).length !== 1)
    fail('deadline monitor must retain one condition-variable deadline wait')
  const forbiddenDomainSurface =
    /\b(?:safe_action|SafeAction\w*|ProposedAction\w*|SafetyNotice|InertAdapter|AdapterState|AdapterError|KernelChannels|MonotonicExpiryGuard|ExpiryStatus|VehicleHealth\w*|LifecycleMachine|LifecycleEvent|GuardedEvent|PlantState|Transition|run_self_check|SelfCheckReport|RawVelocityV1|FramedVelocityMetresPerSecond)\b/
  if (forbiddenDomainSurface.test(productionCode))
    fail(
      'deadline monitor must not couple deadline evidence to policy, lifecycle, channels, runtime, or adapters'
    )

  const deadlineUse =
    /\b(?:deadline_monitor|ActiveCommandDeadlineMonitorV1|CommandDeadline(?:Key|Ticket|TicketError)V1|DeadlineAdvance(?:Error|Receipt)V1|DeadlineControlErrorV1|DeadlineDetectionEvidenceV1|DeadlineMonitor(?:StartError|TerminalKind|Terminal)V1)\b/
  let libraryWithoutDeadlineSurface = libraryCode
  for (const [startOffset, endOffset] of [
    [moduleDeclarations[0].index, moduleDeclarations[0].index + moduleDeclarations[0][0].length],
    [reexports.start, reexports.end],
  ]) {
    libraryWithoutDeadlineSurface =
      libraryWithoutDeadlineSurface.slice(0, startOffset) +
      blankRustSegment(libraryWithoutDeadlineSurface, startOffset, endOffset) +
      libraryWithoutDeadlineSurface.slice(endOffset)
  }
  if (deadlineUse.test(libraryWithoutDeadlineSurface))
    fail('deadline monitor must remain unwired in the plant crate root')

  const sourceRoot = resolve(PLANT_ROOT, 'src')
  for (const path of walkRustFiles(sourceRoot)) {
    const canonical = realpathSync(path)
    if (
      canonical === realpathSync(DEADLINE_MONITOR_SOURCE) ||
      canonical === realpathSync(resolve(PLANT_ROOT, 'src/lib.rs'))
    ) {
      continue
    }
    let source = readFileSync(path, 'utf8')
    if (canonical === realpathSync(CONTRACT_SOURCE)) source = overrides.contract ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/runtime.rs')))
      source = overrides.runtime ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/adapter.rs')))
      source = overrides.adapter ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/channels.rs')))
      source = overrides.channels ?? source
    else if (canonical === realpathSync(resolve(PLANT_ROOT, 'src/expiry.rs')))
      source = overrides.expiry ?? source
    else if (canonical === realpathSync(HEALTH_SOURCE)) source = overrides.health ?? source
    else if (canonical === realpathSync(FRESHNESS_SOURCE)) source = overrides.freshness ?? source
    else if (canonical === realpathSync(SAFE_ACTION_SOURCE)) source = overrides.safeAction ?? source
    else if (canonical === realpathSync(LIFECYCLE_SOURCE)) source = overrides.lifecycle ?? source
    const code = rustBoundaryCode(source)
    if (deadlineUse.test(code))
      fail(`deadline monitor must remain unwired in ${relative(ROOT, path)}`)
  }
}

function replaced(source, before, after, label) {
  if (!source.includes(before)) fail(`vehicle-health boundary self-test fixture drift: ${label}`)
  return source.replace(before, after)
}

function replacedExactlyOnce(source, before, after, label) {
  const occurrences = source.split(before).length - 1
  if (occurrences !== 1) {
    fail(
      `vehicle-health boundary self-test fixture drift: ${label} expected one anchor, got ${occurrences}`
    )
  }
  return source.replace(before, after)
}

function verifyVehicleHealthBoundaryMutations() {
  const health = readFileSync(HEALTH_SOURCE, 'utf8')
  const freshness = readFileSync(FRESHNESS_SOURCE, 'utf8')
  const channels = readFileSync(resolve(PLANT_ROOT, 'src/channels.rs'), 'utf8')
  const runtime = readFileSync(resolve(PLANT_ROOT, 'src/runtime.rs'), 'utf8')
  const contract = readFileSync(CONTRACT_SOURCE, 'utf8')
  const library = readFileSync(resolve(PLANT_ROOT, 'src/lib.rs'), 'utf8')
  const cases = [
    {
      label: 'replaceable kernel health field',
      overrides: {
        channels: replaced(
          channels,
          '    health_snapshot: VehicleHealthChannelV1,',
          '    pub health_snapshot: VehicleHealthChannelV1,',
          'public kernel health field'
        ),
      },
    },
    {
      label: 'public canonical aggregate',
      overrides: {
        health: replaced(
          health,
          'pub(crate) struct VehicleHealthChannelV1 {',
          'pub struct VehicleHealthChannelV1 {',
          'public aggregate'
        ),
      },
    },
    {
      label: 'replaceable canonical publisher',
      overrides: {
        health: replaced(
          health,
          '    publisher: VehicleHealthPublisherV1,\n    reader: VehicleHealthReaderV1,',
          '    pub(crate) publisher: VehicleHealthPublisherV1,\n    reader: VehicleHealthReaderV1,',
          'visible aggregate publisher'
        ),
      },
    },
    {
      label: 'shared publisher commit',
      overrides: {
        health: replaced(
          health,
          '    pub fn commit(\n        &mut self,\n        report: &VehicleHealthReportV1,',
          '    pub fn commit(\n        &self,\n        report: &VehicleHealthReportV1,',
          'shared publisher commit'
        ),
      },
    },
    {
      label: 'unchecked publisher method',
      overrides: {
        health: replaced(
          health,
          'impl VehicleHealthPublisherV1 {',
          'impl VehicleHealthPublisherV1 {\n    pub fn unchecked_commit(&self) {}',
          'publisher method injection'
        ),
      },
    },
    {
      label: 'macro-generated publisher high-water reset',
      overrides: {
        health: replaced(
          health,
          'impl VehicleHealthPublisherV1 {',
          'macro_rules! reset_health_high_water {\n    () => {\n        /// Deliberately escaping mutation.\n        pub fn reset_source_sequence(&mut self) {\n            self.last_source_sequence = None;\n        }\n    };\n}\n\nimpl VehicleHealthPublisherV1 {\n    reset_health_high_water!();',
          'macro-generated publisher method'
        ),
      },
    },
    {
      label: 'async raw-reader method',
      overrides: {
        health: replaced(
          health,
          'impl VehicleHealthReaderV1 {',
          'impl VehicleHealthReaderV1 {\n    /// Deliberately escaping mutation.\n    pub async fn into_raw(self) -> SnapshotReceiver<VehicleHealthSnapshotV1> {\n        std::future::ready(()).await;\n        self.receiver\n    }',
          'async raw-reader method'
        ),
      },
    },
    {
      label: 'public raw reader',
      overrides: {
        health: replaced(
          health,
          '    receiver: SnapshotReceiver<VehicleHealthSnapshotV1>,',
          '    pub(crate) receiver: SnapshotReceiver<VehicleHealthSnapshotV1>,',
          'visible raw reader'
        ),
      },
    },
    {
      label: 'nested interior-mutable alias field',
      overrides: {
        health: replaced(
          health,
          '    links: FcuLinksV1,\n}\n\nimpl VehicleHealthStateV1',
          "    links: FcuLinksV1,\n    sneaky: &'static std::sync::Mutex<u8>,\n}\n\nimpl VehicleHealthStateV1",
          'nested state field'
        ),
      },
    },
    {
      label: 'imported interior-mutable profile leaf',
      overrides: {
        contract: replaced(
          contract,
          '    artifact_digest: [u8; 32],\n}\n\nimpl ProfileIdentity',
          "    artifact_digest: [u8; 32],\n    sneaky: &'static std::sync::Mutex<u8>,\n}\n\nimpl ProfileIdentity",
          'imported profile leaf field'
        ),
      },
    },
    {
      label: 'missing transitive closed-value proof',
      overrides: {
        health: replaced(
          health,
          '    assert_closed_value::<VehicleHealthStateV1>();',
          '    ',
          'closed-value proof removal'
        ),
      },
    },
    {
      label: 'weakened transitive closed-value proof',
      overrides: {
        health: replaced(
          health,
          '    fn assert_closed_value<T: Copy + Send + Sync>() {}',
          '    fn assert_closed_value<T>() {}',
          'closed-value proof bound'
        ),
      },
    },
    {
      label: 'conditionally disabled closed-value proof',
      overrides: {
        health: replaced(
          health,
          'const _: fn() = || {',
          '#[cfg_attr(all(), cfg(any()))]\nconst _: fn() = || {',
          'closed-value proof condition'
        ),
      },
    },
    {
      label: 'cloneable publisher',
      overrides: {
        health: replaced(
          health,
          '#[derive(Debug)]\npub struct VehicleHealthPublisherV1 {',
          '#[derive(Clone, Debug)]\npub struct VehicleHealthPublisherV1 {',
          'publisher Clone derive'
        ),
      },
    },
    {
      label: 'separately derived cloneable publisher',
      overrides: {
        health: replaced(
          health,
          '#[derive(Debug)]\npub struct VehicleHealthPublisherV1 {',
          '#[derive(Clone)]\n#[derive(Debug)]\npub struct VehicleHealthPublisherV1 {',
          'separate publisher Clone derive'
        ),
      },
    },
    {
      label: 'trait-based raw-reader conversion',
      overrides: {
        health: `${health}\nimpl From<VehicleHealthReaderV1> for SnapshotReceiver<VehicleHealthSnapshotV1> {\n    fn from(reader: VehicleHealthReaderV1) -> Self {\n        reader.receiver\n    }\n}\n`,
      },
    },
    {
      label: 'type-aliased raw-reader conversion',
      overrides: {
        health: `${health}\ntype ReaderAlias = VehicleHealthReaderV1;\ntype RawAlias = SnapshotReceiver<VehicleHealthSnapshotV1>;\nimpl From<ReaderAlias> for RawAlias {\n    fn from(reader: ReaderAlias) -> Self {\n        reader.receiver\n    }\n}\n`,
      },
    },
    {
      label: 'import-aliased raw-reader conversion',
      overrides: {
        health: `${health}\nuse self::VehicleHealthReaderV1 as ReaderAlias;\nuse self::VehicleHealthSnapshotV1 as SnapshotAlias;\nuse crate::channels::SnapshotReceiver as RawAlias;\nimpl From<ReaderAlias> for RawAlias<SnapshotAlias> {\n    fn from(reader: ReaderAlias) -> Self {\n        reader.receiver\n    }\n}\n`,
      },
    },
    {
      label: 'module-level unchecked health commit',
      overrides: {
        health: `${health}\n/// Deliberately bypassing mutation.\npub fn unchecked_health_commit(\n    publisher: &VehicleHealthPublisherV1,\n    report: VehicleHealthReportV1,\n) -> Result<u64, ChannelError<VehicleHealthSnapshotV1>> {\n    let snapshot = VehicleHealthSnapshotV1 {\n        metadata: report.metadata,\n        units: report.units,\n        observation_times: report.observation_times,\n        state: report.state,\n        received_at: Instant::now(),\n    };\n    publisher\n        .sender\n        .commit(report.metadata.domain.runtime_generation, snapshot)\n}\n`,
      },
    },
    {
      label: 'child-module high-water reset',
      overrides: {
        health: replaced(
          health,
          '#[cfg(test)]\nmod tests {',
          'mod escape {\n    /// Deliberately escaping mutation.\n    pub fn reset_source_sequence(publisher: &mut super::VehicleHealthPublisherV1) {\n        publisher.last_source_sequence = None;\n    }\n}\n\n#[cfg(test)]\nmod tests {',
          'vehicle-health child module'
        ),
      },
    },
    {
      label: 'crate-root wildcard health re-export',
      overrides: {
        library: replaced(
          library,
          'pub use health::{',
          'pub use health::*;\npub use health::{',
          'wildcard health re-export'
        ),
      },
    },
    {
      label: 'raw runtime endpoint',
      overrides: {
        runtime: `${runtime}\ntype EscapedHealth = SnapshotSender<VehicleHealthSnapshotV1>;\n`,
      },
    },
    {
      label: 'kernel endpoint accessor',
      overrides: {
        channels: replaced(
          channels,
          'impl<CommandValue, AdapterOutput, Evidence> KernelChannels<CommandValue, AdapterOutput, Evidence> {',
          'impl<CommandValue, AdapterOutput, Evidence> KernelChannels<CommandValue, AdapterOutput, Evidence> {\n    pub fn replace_health_path(&mut self) {}',
          'kernel method injection'
        ),
      },
    },
    {
      label: 'module-level kernel health replacement',
      overrides: {
        channels: `${channels}\n/// Deliberately replacing mutation.\npub(crate) fn replace_kernel_health<C, A, E>(\n    channels: &mut KernelChannels<C, A, E>,\n    context: VehicleHealthContextV1,\n) {\n    channels.health_snapshot = vehicle_health_channel_set(context);\n}\n`,
      },
    },
    {
      label: 'public freshness module',
      expectedError: 'freshness module must have one private',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'mod freshness;',
          'pub mod freshness;',
          'public freshness module'
        ),
      },
    },
    {
      label: 'conditionally disabled freshness module',
      expectedError: 'freshness module must have one private',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'mod freshness;',
          '#[cfg(any())]\nmod freshness;',
          'conditional freshness module'
        ),
      },
    },
    {
      label: 'crate-root wildcard freshness re-export',
      expectedError: 'freshness crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'pub use freshness::{',
          'pub use freshness::*;\npub use freshness::{',
          'wildcard freshness re-export'
        ),
      },
    },
    {
      label: 'conditionally disabled freshness re-export',
      expectedError: 'freshness crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'pub use freshness::{',
          '#[cfg(any())]\npub use freshness::{',
          'conditional freshness re-export'
        ),
      },
    },
    {
      label: 'cloneable age-limit proposal',
      expectedError: 'VehicleHealthAgeLimitsProposalV1 attributes drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '#[derive(Debug)]\npub struct VehicleHealthAgeLimitsProposalV1 {',
          '#[derive(Clone, Debug)]\npub struct VehicleHealthAgeLimitsProposalV1 {',
          'cloneable limit proposal'
        ),
      },
    },
    {
      label: 'default age-limit proposal',
      expectedError: 'VehicleHealthAgeLimitsProposalV1 attributes drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '#[derive(Debug)]\npub struct VehicleHealthAgeLimitsProposalV1 {',
          '#[derive(Debug, Default)]\npub struct VehicleHealthAgeLimitsProposalV1 {',
          'default limit proposal'
        ),
      },
    },
    {
      label: 'positional age-limit proposal constructor',
      expectedError: 'inherent impl count drift',
      overrides: {
        freshness: `${freshness}\nimpl VehicleHealthAgeLimitsProposalV1 {\n    pub fn from_one(limit: Duration) -> Self {\n        Self { receipt: limit, fcu_state: limit, estimator: limit, position: limit, velocity: limit, battery: limit, fence: limit, links: limit }\n    }\n}\n`,
      },
    },
    {
      label: 'omitted zero-limit validation',
      expectedError: 'try_new closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '            (VehicleHealthAgePointV1::Battery, limits.battery),\n',
          '',
          'battery zero-limit validation'
        ),
      },
    },
    {
      label: 'misidentified zero-limit validation point',
      expectedError: 'try_new closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '(VehicleHealthAgePointV1::Velocity, limits.velocity),',
          '(VehicleHealthAgePointV1::Position, limits.velocity),',
          'velocity zero-limit point'
        ),
      },
    },
    {
      label: 'profile kind-only assessment match',
      expectedError: 'assess closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        if observed_profile != self.profile {',
          '        if observed_profile.kind() != self.profile.kind() {',
          'exact profile comparison'
        ),
      },
    },
    {
      label: 'missing profile assessment check',
      expectedError: 'assess closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        if observed_profile != self.profile {\n            return Err(VehicleHealthAgeAssessmentErrorV1 {\n                policy_profile: self.profile,\n                observed_profile,\n            });\n        }\n',
          '',
          'profile mismatch check'
        ),
      },
    },
    {
      label: 'inclusive captured-age comparison',
      expectedError: 'relation_at_read closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        if self.age < self.exclusive_limit {',
          '        if self.age <= self.exclusive_limit {',
          'exclusive age comparator'
        ),
      },
    },
    {
      label: 'truncated captured-age comparison',
      expectedError: 'relation_at_read closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        if self.age < self.exclusive_limit {',
          '        if self.age.as_millis() < self.exclusive_limit.as_millis() {',
          'direct duration comparator'
        ),
      },
    },
    {
      label: 'swapped policy limit field',
      expectedError: 'exclusive_limit closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '            VehicleHealthAgePointV1::Velocity => self.limits.velocity,',
          '            VehicleHealthAgePointV1::Velocity => self.limits.position,',
          'velocity exclusive limit'
        ),
      },
    },
    {
      label: 'swapped captured age field',
      expectedError: 'age_for_point closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        VehicleHealthAgePointV1::Battery => ages.battery(),',
          '        VehicleHealthAgePointV1::Battery => ages.fence(),',
          'battery captured age'
        ),
      },
    },
    {
      label: 'swapped assessment accessor point',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1::position closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        self.comparison(VehicleHealthAgePointV1::Position)',
          '        self.comparison(VehicleHealthAgePointV1::Velocity)',
          'position accessor point'
        ),
      },
    },
    {
      label: 'bare-age assessment entry point',
      expectedError: 'VehicleHealthCapturedAgePolicyV1 method surface drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          'impl VehicleHealthCapturedAgePolicyV1 {',
          'impl VehicleHealthCapturedAgePolicyV1 {\n    pub fn assess_ages(&self, _ages: VehicleHealthAgesV1) {}',
          'bare-age assessment method'
        ),
      },
    },
    {
      label: 'assessment observation decomposition',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1 method surface drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          "impl<'policy> VehicleHealthCapturedAgeAssessmentV1<'policy> {",
          "impl<'policy> VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    pub fn into_observed(self) -> ObservedVehicleHealthV1 { self.observed }",
          'assessment decomposition method'
        ),
      },
    },
    {
      label: 'aggregate within-limit boolean',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1 method surface drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          "impl<'policy> VehicleHealthCapturedAgeAssessmentV1<'policy> {",
          "impl<'policy> VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    pub fn all_within_limits(&self) -> bool { true }",
          'aggregate boolean method'
        ),
      },
    },
    {
      label: 'comparison boolean conversion',
      expectedError: 'freshness trait surface drift',
      overrides: {
        freshness: `${freshness}\nimpl From<VehicleHealthAgeComparisonAtReadV1> for bool {\n    fn from(value: VehicleHealthAgeComparisonAtReadV1) -> Self {\n        matches!(value.relation_at_read(), VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead)\n    }\n}\n`,
      },
    },
    {
      label: 'trait-based assessment decomposition',
      expectedError: 'freshness trait surface drift',
      overrides: {
        freshness: `${freshness}\nimpl<'policy> From<VehicleHealthCapturedAgeAssessmentV1<'policy>> for ObservedVehicleHealthV1 {\n    fn from(value: VehicleHealthCapturedAgeAssessmentV1<'policy>) -> Self {\n        value.observed\n    }\n}\n`,
      },
    },
    {
      label: 'replaceable assessment policy',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1 closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          "pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    policy: &'policy VehicleHealthCapturedAgePolicyV1,\n    observed: ObservedVehicleHealthV1,",
          "pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    pub policy: &'policy VehicleHealthCapturedAgePolicyV1,\n    observed: ObservedVehicleHealthV1,",
          'visible assessment policy'
        ),
      },
    },
    {
      label: 'replaceable assessment observation',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1 closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          "pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    policy: &'policy VehicleHealthCapturedAgePolicyV1,\n    observed: ObservedVehicleHealthV1,",
          "pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    policy: &'policy VehicleHealthCapturedAgePolicyV1,\n    pub observed: ObservedVehicleHealthV1,",
          'visible assessment observation'
        ),
      },
    },
    {
      label: 'borrowed rather than owned assessment observation',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1 closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          "pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    policy: &'policy VehicleHealthCapturedAgePolicyV1,\n    observed: ObservedVehicleHealthV1,",
          "pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    policy: &'policy VehicleHealthCapturedAgePolicyV1,\n    observed: &'policy ObservedVehicleHealthV1,",
          'borrowed assessment observation'
        ),
      },
    },
    {
      label: 'clock recapture during assessment comparison',
      expectedError: 'must not read clocks',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '        let ages = self.observed.ages();',
          '        let _recaptured = std::time::Instant::now();\n        let ages = self.observed.ages();',
          'clock recapture'
        ),
      },
    },
    {
      label: 'freshness child-module bypass',
      expectedError: 'must not gain child modules',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '#[cfg(test)]\nmod tests {',
          'mod escape { pub fn all_fresh() -> bool { true } }\n\n#[cfg(test)]\nmod tests {',
          'freshness child module'
        ),
      },
    },
    {
      label: 'macro-generated freshness bypass',
      expectedError: 'must not define source-invisible item surfaces',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          'impl VehicleHealthCapturedAgePolicyV1 {',
          'macro_rules! freshness_bypass { () => { pub fn all_fresh(&self) -> bool { true } }; }\n\nimpl VehicleHealthCapturedAgePolicyV1 {\n    freshness_bypass!();',
          'freshness macro bypass'
        ),
      },
    },
    {
      label: 'freshness type-alias bypass',
      expectedError: 'freshness aliases are forbidden',
      overrides: {
        freshness: `${freshness}\ntype FreshAssessment<'a> = VehicleHealthCapturedAgeAssessmentV1<'a>;\n`,
      },
    },
    {
      label: 'runtime freshness consumption',
      expectedError: 'must remain unwired',
      overrides: {
        runtime: `${runtime}\ntype RuntimeFreshness<'a> = VehicleHealthCapturedAgeAssessmentV1<'a>;\n`,
      },
    },
    {
      label: 'kernel freshness consumption',
      expectedError: 'must remain unwired',
      overrides: {
        channels: `${channels}\ntype KernelFreshness = VehicleHealthCapturedAgePolicyV1;\n`,
      },
    },
    {
      label: 'production-controlled commit clock injection',
      expectedError: 'controlled commit hook must remain cfg(test)',
      overrides: {
        health: replacedExactlyOnce(
          health,
          '    #[cfg(test)]\n    pub(crate) fn commit_for_test_at(',
          '    pub(crate) fn commit_for_test_at(',
          'commit hook test gate'
        ),
      },
    },
    {
      label: 'production-controlled read clock injection',
      expectedError: 'controlled read hook must remain cfg(test)',
      overrides: {
        health: replacedExactlyOnce(
          health,
          '    #[cfg(test)]\n    pub(crate) fn load_at(',
          '    pub(crate) fn load_at(',
          'read hook test gate'
        ),
      },
    },
    {
      label: 'production-controlled observation clock injection',
      expectedError: 'observation-time hook must remain cfg(test)',
      overrides: {
        health: replacedExactlyOnce(
          health,
          '    #[cfg(test)]\n    pub(crate) const fn at(',
          '    pub(crate) const fn at(',
          'observation hook test gate'
        ),
      },
    },
    {
      label: 'cloneable observed health value',
      expectedError: 'ObservedVehicleHealthV1 must remain non-cloneable',
      overrides: {
        health: replacedExactlyOnce(
          health,
          '#[derive(Debug)]\npub struct ObservedVehicleHealthV1 {',
          '#[derive(Clone, Debug)]\npub struct ObservedVehicleHealthV1 {',
          'cloneable observed health'
        ),
      },
    },
    {
      label: 'cloneable captured-age assessment',
      expectedError: 'VehicleHealthCapturedAgeAssessmentV1 attributes drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          "#[derive(Debug)]\npub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {",
          "#[derive(Clone, Debug)]\npub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {",
          'cloneable captured-age assessment'
        ),
      },
    },
    {
      label: 'public captured-age comparison fields',
      expectedError: 'VehicleHealthAgeComparisonAtReadV1 closed value shape drift',
      overrides: {
        freshness: replacedExactlyOnce(
          freshness,
          '    age: Duration,\n    exclusive_limit: Duration,',
          '    pub age: Duration,\n    pub exclusive_limit: Duration,',
          'public comparison fields'
        ),
      },
    },
    {
      label: 'crate-root aggregate freshness verdict',
      expectedError: 'must remain unwired',
      overrides: {
        library: `${library}\n/// Forbidden aggregate freshness verdict.\npub fn all_captured_ages_within_limits(\n    _assessment: &VehicleHealthCapturedAgeAssessmentV1<'_>,\n) -> bool {\n    true\n}\n`,
      },
    },
    {
      label: 'qualified secondary assessment impl',
      expectedError: 'inherent impl count drift',
      overrides: {
        freshness: `${freshness}\nimpl<'policy> crate::freshness::VehicleHealthCapturedAgeAssessmentV1<'policy> {\n    pub fn release_observation(self) -> ObservedVehicleHealthV1 {\n        self.observed\n    }\n}\n`,
      },
    },
    {
      label: 'qualified secondary policy impl',
      expectedError: 'inherent impl count drift',
      overrides: {
        freshness: `${freshness}\nimpl crate::freshness::VehicleHealthCapturedAgePolicyV1 {\n    pub fn from_unchecked(\n        profile: ProfileIdentity,\n        limits: VehicleHealthAgeLimitsProposalV1,\n    ) -> Self {\n        Self { profile, limits }\n    }\n}\n`,
      },
    },
    {
      label: 'qualified secondary comparison impl',
      expectedError: 'inherent impl count drift',
      overrides: {
        freshness: `${freshness}\nimpl crate::freshness::VehicleHealthAgeComparisonAtReadV1 {\n    pub fn from_unchecked(\n        point: VehicleHealthAgePointV1,\n        age: Duration,\n        exclusive_limit: Duration,\n    ) -> Self {\n        Self {\n            point,\n            age,\n            exclusive_limit,\n        }\n    }\n}\n`,
      },
    },
  ]
  for (const fixture of cases) {
    let rejection = null
    try {
      verifyVehicleHealthBoundary(fixture.overrides)
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error)
    }
    if (rejection === null) fail(`vehicle-health boundary accepted mutation: ${fixture.label}`)
    if (fixture.expectedError && !rejection.includes(fixture.expectedError)) {
      fail(
        `vehicle-health boundary mutation '${fixture.label}' rejected for the wrong reason: ${rejection}`
      )
    }
  }
  return cases.length
}

function verifySafeActionBoundaryMutations() {
  const safeAction = readFileSync(SAFE_ACTION_SOURCE, 'utf8')
  const library = readFileSync(resolve(PLANT_ROOT, 'src/lib.rs'), 'utf8')
  const runtime = readFileSync(resolve(PLANT_ROOT, 'src/runtime.rs'), 'utf8')
  const adapter = readFileSync(resolve(PLANT_ROOT, 'src/adapter.rs'), 'utf8')
  const cases = [
    {
      label: 'public safe-action module',
      expectedError: 'safe-action module must have one private',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'mod safe_action;',
          'pub mod safe_action;',
          'public safe-action module'
        ),
      },
    },
    {
      label: 'conditionally disabled safe-action module',
      expectedError: 'safe-action module must have one private',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'mod safe_action;',
          '#[cfg(any())]\nmod safe_action;',
          'conditional safe-action module'
        ),
      },
    },
    {
      label: 'wildcard safe-action re-export',
      expectedError: 'safe-action crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'pub use safe_action::{',
          'pub use safe_action::*;\npub use safe_action::{',
          'wildcard safe-action re-export'
        ),
      },
    },
    {
      label: 'conditionally disabled safe-action re-export',
      expectedError: 'safe-action crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'pub use safe_action::{',
          '#[cfg(any())]\npub use safe_action::{',
          'conditional safe-action re-export'
        ),
      },
    },
    {
      label: 'expanded safe-action re-export',
      expectedError: 'safe-action crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          '    MAX_SAFE_ACTION_POLICY_ROWS_V1,\n};',
          '    MAX_SAFE_ACTION_POLICY_ROWS_V1, ProfileIdentity,\n};',
          'expanded safe-action re-export'
        ),
      },
    },
    {
      label: 'expanded safe-action table bound',
      expectedError: 'table bound must remain',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          'pub const MAX_SAFE_ACTION_POLICY_ROWS_V1: usize = u8::MAX as usize;',
          'pub const MAX_SAFE_ACTION_POLICY_ROWS_V1: usize = usize::from(u8::MAX) + 1;',
          'expanded safe-action table bound'
        ),
      },
    },
    {
      label: 'public situation-code representation',
      expectedError: 'SafeActionSituationCodeV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          'pub struct SafeActionSituationCodeV1(NonZeroU8);',
          'pub struct SafeActionSituationCodeV1(pub NonZeroU8);',
          'public situation code representation'
        ),
      },
    },
    {
      label: 'resizable safe-action table',
      expectedError: 'SafeActionPolicyCandidateV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '    intents: [Option<SafeActionIntentV1>; MAX_SAFE_ACTION_POLICY_ROWS_V1],',
          '    intents: Vec<Option<SafeActionIntentV1>>,',
          'resizable safe-action table'
        ),
      },
    },
    {
      label: 'missing safe-action row count',
      expectedError: 'SafeActionPolicyCandidateV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '    row_count: usize,\n}',
          '}',
          'missing safe-action row count'
        ),
      },
    },
    {
      label: 'public raw safe-action table',
      expectedError: 'SafeActionPolicyCandidateV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '    intents: [Option<SafeActionIntentV1>; MAX_SAFE_ACTION_POLICY_ROWS_V1],',
          '    pub intents: [Option<SafeActionIntentV1>; MAX_SAFE_ACTION_POLICY_ROWS_V1],',
          'public raw safe-action table'
        ),
      },
    },
    {
      label: 'public safe-action proposal fields',
      expectedError: 'SafeActionPolicyRowProposalV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '    situation_code: SafeActionSituationCodeV1,\n    intent: SafeActionIntentV1,',
          '    pub situation_code: SafeActionSituationCodeV1,\n    pub intent: SafeActionIntentV1,',
          'public safe-action proposal fields'
        ),
      },
    },
    {
      label: 'public safe-action selection fields',
      expectedError: 'SafeActionSelectionCandidateV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          "    policy: &'policy SafeActionPolicyCandidateV1,\n    situation: SafeActionSituationCandidateV1,\n    intent: SafeActionIntentV1,",
          "    pub policy: &'policy SafeActionPolicyCandidateV1,\n    pub situation: SafeActionSituationCandidateV1,\n    pub intent: SafeActionIntentV1,",
          'public safe-action selection fields'
        ),
      },
    },
    {
      label: 'default-derived safe-action policy',
      expectedError: 'SafeActionPolicyCandidateV1 attributes drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '#[derive(Debug)]\npub struct SafeActionPolicyCandidateV1 {',
          '#[derive(Debug, Default)]\npub struct SafeActionPolicyCandidateV1 {',
          'default-derived safe-action policy'
        ),
      },
    },
    {
      label: 'explicit default safe-action policy',
      expectedError: 'must not define a default',
      overrides: {
        safeAction: `${safeAction}\nimpl Default for SafeActionPolicyCandidateV1 {\n    fn default() -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'fallback safe-action intent variant',
      expectedError: 'SafeActionIntentV1 closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '    InhibitPlantOutput,',
          '    Fallback,\n    InhibitPlantOutput,',
          'fallback safe-action intent variant'
        ),
      },
    },
    {
      label: 'missing-row fallback intent',
      expectedError: 'SafeActionPolicyCandidateV1::select closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        let intent = self.intents[index].ok_or(SafeActionSelectionErrorV1::MissingSituation {\n            situation_code: situation.code,\n        })?;',
          '        let intent = self.intents[index]\n            .unwrap_or(SafeActionIntentV1::RequestProfileDefinedPhysicalHold);',
          'missing-row fallback intent'
        ),
      },
    },
    {
      label: 'bare-code safe-action lookup',
      expectedError: 'SafeActionPolicyCandidateV1::select must have exactly one',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        situation: SafeActionSituationCandidateV1,\n    ) -> Result<SafeActionSelectionCandidateV1',
          '        situation: SafeActionSituationCodeV1,\n    ) -> Result<SafeActionSelectionCandidateV1',
          'bare-code safe-action lookup'
        ),
      },
    },
    {
      label: 'profile-kind-only safe-action match',
      expectedError: 'SafeActionPolicyCandidateV1::select closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        if situation.profile != self.profile {',
          '        if situation.profile.kind() != self.profile.kind() {',
          'profile-kind-only safe-action match'
        ),
      },
    },
    {
      label: 'profile-digest-only safe-action match',
      expectedError: 'SafeActionPolicyCandidateV1::select closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        if situation.profile != self.profile {',
          '        if situation.profile.artifact_digest() != self.profile.artifact_digest() {',
          'profile-digest-only safe-action match'
        ),
      },
    },
    {
      label: 'lookup before exact profile rejection',
      expectedError: 'SafeActionPolicyCandidateV1::select closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        if situation.profile != self.profile {\n            return Err(SafeActionSelectionErrorV1::ProfileMismatch {\n                policy_profile: self.profile,\n                situation_profile: situation.profile,\n            });\n        }\n        let index = usize::from(situation.code.get() - 1);',
          '        let index = usize::from(situation.code.get() - 1);\n        if situation.profile != self.profile {\n            return Err(SafeActionSelectionErrorV1::ProfileMismatch {\n                policy_profile: self.profile,\n                situation_profile: situation.profile,\n            });\n        }',
          'lookup before exact profile rejection'
        ),
      },
    },
    {
      label: 'linear safe-action lookup',
      expectedError: 'SafeActionPolicyCandidateV1::select closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        let intent = self.intents[index].ok_or(SafeActionSelectionErrorV1::MissingSituation {',
          '        let intent = self.intents.iter().copied().flatten().next().ok_or(SafeActionSelectionErrorV1::MissingSituation {',
          'linear safe-action lookup'
        ),
      },
    },
    {
      label: 'empty safe-action table accepted',
      expectedError: 'SafeActionPolicyCandidateV1::try_from_rows closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        if rows.is_empty() {\n            return Err(SafeActionPolicyConfigurationErrorV1::EmptyTable);\n        }',
          '',
          'empty safe-action table accepted'
        ),
      },
    },
    {
      label: 'duplicate safe-action row overwritten',
      expectedError: 'SafeActionPolicyCandidateV1::try_from_rows closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '            if intents[index].is_some() {\n                return Err(SafeActionPolicyConfigurationErrorV1::DuplicateSituation {\n                    situation_code: row.situation_code,\n                });\n            }',
          '',
          'duplicate safe-action row overwritten'
        ),
      },
    },
    {
      label: 'unbounded safe-action proposal',
      expectedError: 'SafeActionPolicyCandidateV1::try_from_rows closed value shape drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '        if rows.len() > MAX_SAFE_ACTION_POLICY_ROWS_V1 {\n            return Err(SafeActionPolicyConfigurationErrorV1::TooManyRows {\n                maximum: MAX_SAFE_ACTION_POLICY_ROWS_V1,\n                received: rows.len(),\n            });\n        }',
          '',
          'unbounded safe-action proposal'
        ),
      },
    },
    {
      label: 'cloneable safe-action selection',
      expectedError: 'SafeActionSelectionCandidateV1 attributes drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          "#[derive(Debug)]\npub struct SafeActionSelectionCandidateV1<'policy> {",
          "#[derive(Clone, Debug)]\npub struct SafeActionSelectionCandidateV1<'policy> {",
          'cloneable safe-action selection'
        ),
      },
    },
    {
      label: 'copyable safe-action selection',
      expectedError: 'SafeActionSelectionCandidateV1 attributes drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          "#[derive(Debug)]\npub struct SafeActionSelectionCandidateV1<'policy> {",
          "#[derive(Clone, Copy, Debug)]\npub struct SafeActionSelectionCandidateV1<'policy> {",
          'copyable safe-action selection'
        ),
      },
    },
    {
      label: 'explicit cloneable safe-action selection',
      expectedError: 'safe-action trait surface drift',
      overrides: {
        safeAction: `${safeAction}\nimpl<'policy> Clone for SafeActionSelectionCandidateV1<'policy> {\n    fn clone(&self) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'mutable safe-action selection policy accessor',
      expectedError: 'SafeActionSelectionCandidateV1::policy must have exactly one',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          "    pub const fn policy(&self) -> &'policy SafeActionPolicyCandidateV1 {",
          "    pub fn policy(&mut self) -> &'policy mut SafeActionPolicyCandidateV1 {",
          'mutable safe-action selection policy accessor'
        ),
      },
    },
    {
      label: 'raw safe-action table accessor',
      expectedError: 'method surface drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          'impl SafeActionPolicyCandidateV1 {',
          'impl SafeActionPolicyCandidateV1 {\n    pub fn raw_intents(&self) -> &[Option<SafeActionIntentV1>] { &self.intents }',
          'raw safe-action table accessor'
        ),
      },
    },
    {
      label: 'mutable safe-action table accessor',
      expectedError: 'method surface drift',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          'impl SafeActionPolicyCandidateV1 {',
          'impl SafeActionPolicyCandidateV1 {\n    pub fn raw_intents_mut(&mut self) -> &mut [Option<SafeActionIntentV1>] { &mut self.intents }',
          'mutable safe-action table accessor'
        ),
      },
    },
    {
      label: 'safe-action fallback associated constant',
      expectedError: 'must not define a fallback',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionIntentV1 {\n    pub const FALLBACK: Self = Self::RequestProfileDefinedPhysicalHold;\n}\n`,
      },
    },
    {
      label: 'direct safe-action ingress conversion',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl From<SafeActionSelectionCandidateV1<'_>> for crate::contract::ProposedActionV1 {\n    fn from(_: SafeActionSelectionCandidateV1<'_>) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'direct safe-action velocity conversion',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl From<SafeActionIntentV1> for crate::contract::RawVelocityV1 {\n    fn from(_: SafeActionIntentV1) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action health inference',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionSituationCandidateV1 {\n    pub fn infer_from_health(_: crate::health::VehicleHealthStateV1) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action freshness inference',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionSituationCandidateV1 {\n    pub fn infer_from_freshness(_: crate::freshness::VehicleHealthAgeRelationAtReadV1) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action lifecycle interpretation',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionSituationCandidateV1 {\n    pub fn infer_from_lifecycle(_: crate::lifecycle::PlantState) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action channel interpretation',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionSituationCandidateV1 {\n    pub fn infer_from_channels<C, A, E>(_: &crate::channels::KernelChannels<C, A, E>) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action runtime interpretation',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionSituationCandidateV1 {\n    pub fn infer_from_runtime(_: crate::runtime::SelfCheckReport) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action adapter interpretation',
      expectedError: 'must not interpret health, freshness',
      overrides: {
        safeAction: `${safeAction}\nimpl SafeActionIntentV1 {\n    pub fn into_adapter(self) -> crate::adapter::AdapterState { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'safe-action runtime wiring',
      expectedError: 'must remain unwired',
      overrides: {
        runtime: `${runtime}\nfn select_candidate(_: crate::SafeActionPolicyCandidateV1) {}\n`,
      },
    },
    {
      label: 'safe-action adapter wiring',
      expectedError: 'must remain unwired',
      overrides: {
        adapter: `${adapter}\nfn apply_candidate(_: crate::SafeActionSelectionCandidateV1<'_>) {}\n`,
      },
    },
    {
      label: 'safe-action child module',
      expectedError: 'must not gain child modules',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '#[cfg(test)]\nmod tests {',
          'mod escape {}\n\n#[cfg(test)]\nmod tests {',
          'safe-action child module'
        ),
      },
    },
    {
      label: 'safe-action local macro definition',
      expectedError: 'must not define source-invisible',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '#[cfg(test)]\nmod tests {',
          'macro_rules! candidate_fallback { () => {}; }\n\n#[cfg(test)]\nmod tests {',
          'safe-action local macro definition'
        ),
      },
    },
    {
      label: 'safe-action top-level macro invocation',
      expectedError: 'must not hide its item surface behind macros',
      overrides: {
        safeAction: replacedExactlyOnce(
          safeAction,
          '#[cfg(test)]\nmod tests {',
          'candidate_escape!();\n\n#[cfg(test)]\nmod tests {',
          'safe-action top-level macro invocation'
        ),
      },
    },
    {
      label: 'safe-action type alias',
      expectedError: 'safe-action aliases are forbidden',
      overrides: {
        safeAction: `${safeAction}\ntype PolicyAlias = SafeActionPolicyCandidateV1;\n`,
      },
    },
    {
      label: 'safe-action import alias',
      expectedError: 'safe-action aliases are forbidden',
      overrides: {
        safeAction: `${safeAction}\nuse self::SafeActionPolicyCandidateV1 as PolicyAlias;\n`,
      },
    },
    {
      label: 'safe-action top-level visible function',
      expectedError: 'top-level functions are forbidden',
      overrides: {
        safeAction: `${safeAction}\npub fn select_without_policy() -> SafeActionIntentV1 { SafeActionIntentV1::InhibitPlantOutput }\n`,
      },
    },
    {
      label: 'qualified secondary safe-action policy impl',
      expectedError: 'inherent impl count drift',
      overrides: {
        safeAction: `${safeAction}\nimpl crate::safe_action::SafeActionPolicyCandidateV1 {\n    pub fn unchecked() -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'qualified secondary safe-action selection impl',
      expectedError: 'inherent impl count drift',
      overrides: {
        safeAction: `${safeAction}\nimpl<'policy> crate::safe_action::SafeActionSelectionCandidateV1<'policy> {\n    pub fn duplicate(&self) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'qualified secondary safe-action intent impl',
      expectedError: 'inherent impl count drift',
      overrides: {
        safeAction: `${safeAction}\nimpl crate::safe_action::SafeActionIntentV1 {\n    pub const fn unchecked_intent() -> Self { Self::RequestProfileDefinedPhysicalHold }\n}\n`,
      },
    },
    {
      label: 'qualified safe-action conversion trait',
      expectedError: 'safe-action trait surface drift',
      overrides: {
        safeAction: `${safeAction}\nimpl From<crate::safe_action::SafeActionSelectionCandidateV1<'_>> for crate::safe_action::SafeActionIntentV1 {\n    fn from(selection: crate::safe_action::SafeActionSelectionCandidateV1<'_>) -> Self { selection.intent }\n}\n`,
      },
    },
  ]
  for (const fixture of cases) {
    let rejection = null
    try {
      verifySafeActionBoundary(fixture.overrides)
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error)
    }
    if (rejection === null) fail(`safe-action boundary accepted mutation: ${fixture.label}`)
    if (fixture.expectedError && !rejection.includes(fixture.expectedError)) {
      fail(
        `safe-action boundary mutation '${fixture.label}' rejected for the wrong reason: ${rejection}`
      )
    }
  }
  return cases.length
}

function verifyDeadlineMonitorBoundaryMutations() {
  const deadlineMonitor = readFileSync(DEADLINE_MONITOR_SOURCE, 'utf8')
  const library = readFileSync(resolve(PLANT_ROOT, 'src/lib.rs'), 'utf8')
  const contract = readFileSync(CONTRACT_SOURCE, 'utf8')
  const runtime = readFileSync(resolve(PLANT_ROOT, 'src/runtime.rs'), 'utf8')
  const channels = readFileSync(resolve(PLANT_ROOT, 'src/channels.rs'), 'utf8')
  const adapter = readFileSync(resolve(PLANT_ROOT, 'src/adapter.rs'), 'utf8')
  const expiry = readFileSync(resolve(PLANT_ROOT, 'src/expiry.rs'), 'utf8')
  const safeAction = readFileSync(SAFE_ACTION_SOURCE, 'utf8')
  const cases = [
    {
      label: 'public deadline-monitor module',
      expectedError: 'deadline-monitor module must have one private',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'mod deadline_monitor;',
          'pub mod deadline_monitor;',
          'public deadline-monitor module'
        ),
      },
    },
    {
      label: 'conditionally disabled deadline-monitor module',
      expectedError: 'deadline-monitor module must have one private',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'mod deadline_monitor;',
          '#[cfg(any())]\nmod deadline_monitor;',
          'conditionally disabled deadline-monitor module'
        ),
      },
    },
    {
      label: 'wildcard deadline-monitor re-export',
      expectedError: 'deadline-monitor crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'pub use deadline_monitor::{',
          'pub use deadline_monitor::*;\npub use deadline_monitor::{',
          'wildcard deadline-monitor re-export'
        ),
      },
    },
    {
      label: 'conditionally disabled deadline-monitor re-export',
      expectedError: 'deadline-monitor crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          'pub use deadline_monitor::{',
          '#[cfg(any())]\npub use deadline_monitor::{',
          'conditionally disabled deadline-monitor re-export'
        ),
      },
    },
    {
      label: 'expanded deadline-monitor re-export',
      expectedError: 'deadline-monitor crate-root re-export',
      overrides: {
        library: replacedExactlyOnce(
          library,
          '    DeadlineMonitorTerminalKindV1, DeadlineMonitorTerminalV1,\n};',
          '    DeadlineMonitorTerminalKindV1, DeadlineMonitorTerminalV1, ProfileIdentity,\n};',
          'expanded deadline-monitor re-export'
        ),
      },
    },
    {
      label: 'deadline-monitor child module',
      expectedError: 'deadline-monitor implementation must not gain child modules',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '#[cfg(test)]\nmod tests {',
          'mod escape {}\n\n#[cfg(test)]\nmod tests {',
          'deadline-monitor child module'
        ),
      },
    },
    {
      label: 'deadline-monitor local macro definition',
      expectedError: 'must not define source-invisible',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '#[cfg(test)]\nmod tests {',
          'macro_rules! hidden_worker { () => {}; }\n\n#[cfg(test)]\nmod tests {',
          'deadline-monitor local macro definition'
        ),
      },
    },
    {
      label: 'deadline-monitor top-level macro invocation',
      expectedError: 'must not hide its item surface behind macros',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '#[cfg(test)]\nmod tests {',
          'hidden_worker!();\n\n#[cfg(test)]\nmod tests {',
          'deadline-monitor top-level macro invocation'
        ),
      },
    },
    {
      label: 'synchronization failure claims an active key',
      expectedError: 'DeadlineMonitorTerminalV1::synchronization_failed closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '            kind: DeadlineMonitorTerminalKindV1::SynchronizationFailed,\n            active_key: None,',
          '            kind: DeadlineMonitorTerminalKindV1::SynchronizationFailed,\n            active_key: Some(unimplemented!()),',
          'synchronization failure claims an active key'
        ),
      },
    },
    {
      label: 'poisoned deadline state remains active',
      expectedError: 'lock_recovering_synchronization_failure closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        Err(poisoned) => {\n            let mut state = poisoned.into_inner();\n            state.terminalize_synchronization_failure();\n            (state, true)\n        }',
          '        Err(poisoned) => {\n            let state = poisoned.into_inner();\n            (state, true)\n        }',
          'poisoned deadline state remains active'
        ),
      },
    },
    {
      label: 'deadline-monitor top-level visible function',
      expectedError: 'deadline-monitor top-level function surface drift',
      overrides: {
        deadlineMonitor: `${deadlineMonitor}\npub fn raw_deadline_monitor_entry() {}\n`,
      },
    },
    {
      label: 'public deadline key fields',
      expectedError: 'CommandDeadlineKeyV1 closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    profile: ProfileIdentity,\n    session: CommandSessionIdentity,',
          '    pub profile: ProfileIdentity,\n    pub session: CommandSessionIdentity,',
          'public deadline key fields'
        ),
      },
    },
    {
      label: 'public deadline ticket receipt',
      expectedError: 'CommandDeadlineTicketV1 closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    received_at: PlantReceiptTime,',
          '    pub received_at: PlantReceiptTime,',
          'public deadline ticket receipt'
        ),
      },
    },
    {
      label: 'public deadline detection fields',
      expectedError: 'DeadlineDetectionEvidenceV1 closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    detected_age: Duration,\n    late_by: Duration,',
          '    pub detected_age: Duration,\n    pub late_by: Duration,',
          'public deadline detection fields'
        ),
      },
    },
    {
      label: 'public terminal evidence fields',
      expectedError: 'DeadlineMonitorTerminalV1 closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    active_key: Option<CommandDeadlineKeyV1>,\n    deadline_detection: Option<DeadlineDetectionEvidenceV1>,',
          '    pub active_key: Option<CommandDeadlineKeyV1>,\n    pub deadline_detection: Option<DeadlineDetectionEvidenceV1>,',
          'public terminal evidence fields'
        ),
      },
    },
    {
      label: 'public deadline-monitor internals',
      expectedError: 'ActiveCommandDeadlineMonitorV1 closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    shared: Arc<SharedMonitor>,\n    worker: Option<JoinHandle<()>>,',
          '    pub shared: Arc<SharedMonitor>,\n    pub worker: Option<JoinHandle<()>>,',
          'public deadline-monitor internals'
        ),
      },
    },
    {
      label: 'resizable active deadline phase',
      expectedError: 'MonitorPhase closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    Armed(ActiveDeadline),',
          '    Armed(Vec<ActiveDeadline>),',
          'resizable active deadline phase'
        ),
      },
    },
    {
      label: 'second active deadline phase',
      expectedError: 'MonitorPhase closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    Armed(ActiveDeadline),\n    Terminal(Option<DeadlineMonitorTerminalV1>),',
          '    Armed(ActiveDeadline),\n    Pending(ActiveDeadline),\n    Terminal(Option<DeadlineMonitorTerminalV1>),',
          'second active deadline phase'
        ),
      },
    },
    {
      label: 'second deadline worker handle',
      expectedError: 'ActiveCommandDeadlineMonitorV1 closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '    worker: Option<JoinHandle<()>>,\n}',
          '    worker: Option<JoinHandle<()>>,\n    backup_worker: Option<JoinHandle<()>>,\n}',
          'second deadline worker handle'
        ),
      },
    },
    {
      label: 'cloneable command deadline ticket',
      expectedError: 'CommandDeadlineTicketV1 attributes drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          'pub struct CommandDeadlineTicketV1 {',
          '#[derive(Clone)]\npub struct CommandDeadlineTicketV1 {',
          'cloneable command deadline ticket'
        ),
      },
    },
    {
      label: 'poisoned panic publication misreports worker panic',
      expectedError: 'publish_worker_panicked closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        Err(poisoned) => {\n            let mut state = poisoned.into_inner();\n            state.terminalize_synchronization_failure();\n            drop(state);\n            shared.wake.notify_all();\n            return;\n        }',
          '        Err(poisoned) => {\n            let mut state = poisoned.into_inner();\n            state.terminalize_worker_panicked();\n            drop(state);\n            shared.wake.notify_all();\n            return;\n        }',
          'poisoned panic publication misreports worker panic'
        ),
      },
    },
    {
      label: 'explicit cloneable command deadline ticket',
      expectedError: 'deadline-monitor trait surface drift',
      overrides: {
        deadlineMonitor: `${deadlineMonitor}\nimpl Clone for CommandDeadlineTicketV1 {\n    fn clone(&self) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'cloneable active deadline monitor',
      expectedError: 'ActiveCommandDeadlineMonitorV1 attributes drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          'pub struct ActiveCommandDeadlineMonitorV1 {',
          '#[derive(Clone)]\npub struct ActiveCommandDeadlineMonitorV1 {',
          'cloneable active deadline monitor'
        ),
      },
    },
    {
      label: 'explicit cloneable active deadline monitor',
      expectedError: 'deadline-monitor trait surface drift',
      overrides: {
        deadlineMonitor: `${deadlineMonitor}\nimpl Clone for ActiveCommandDeadlineMonitorV1 {\n    fn clone(&self) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'worker-start error drops initial terminal reason',
      expectedError: 'ActiveCommandDeadlineMonitorV1::start closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        let initial_terminal_kind = state.terminal_kind();',
          '        let initial_terminal_kind = None;',
          'worker-start error drops initial terminal reason'
        ),
      },
    },
    {
      label: 'raw deadline getter',
      expectedError: 'CommandDeadlineTicketV1 complete method surface drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          'impl CommandDeadlineTicketV1 {',
          'impl CommandDeadlineTicketV1 {\n    pub fn raw_deadline(&self) -> Instant { self.deadline }',
          'raw deadline getter'
        ),
      },
    },
    {
      label: 'worker panic predicate set without state lock',
      expectedError: 'panic injection must set its predicate while holding the state lock',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        let (state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);\n        self.shared.panic_worker.store(true, Ordering::SeqCst);\n        drop(state);\n        self.shared.wake.notify_all();',
          '        self.shared.panic_worker.store(true, Ordering::SeqCst);\n        self.shared.wake.notify_all();',
          'worker panic predicate set without state lock'
        ),
      },
    },
    {
      label: 'secondary command deadline ticket impl',
      expectedError: 'CommandDeadlineTicketV1 inherent impl count drift',
      overrides: {
        deadlineMonitor: `${deadlineMonitor}\nimpl crate::deadline_monitor::CommandDeadlineTicketV1 {\n    fn unchecked() -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'secondary active deadline monitor impl',
      expectedError: 'ActiveCommandDeadlineMonitorV1 inherent impl count drift',
      overrides: {
        deadlineMonitor: `${deadlineMonitor}\nimpl crate::deadline_monitor::ActiveCommandDeadlineMonitorV1 {\n    fn rearm(&mut self) {}\n}\n`,
      },
    },
    {
      label: 'ticket constructor takes candidate ownership',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate must have exactly one',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        candidate: &VelocityCommandCandidateV1,',
          '        candidate: VelocityCommandCandidateV1,',
          'ticket constructor takes candidate ownership'
        ),
      },
    },
    {
      label: 'raw-clock ticket constructor',
      expectedError: 'CommandDeadlineTicketV1 complete method surface drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          'impl CommandDeadlineTicketV1 {',
          'impl CommandDeadlineTicketV1 {\n    pub fn from_raw_clock(_: Instant, _: Duration) -> Self { unimplemented!() }',
          'raw-clock ticket constructor'
        ),
      },
    },
    {
      label: 'ticket generation equality omitted',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if expected_generation != candidate_generation {\n            return Err(CommandDeadlineTicketErrorV1::GenerationMismatch {\n                candidate: candidate_generation,\n                expected: expected_generation,\n            });\n        }',
          '',
          'ticket generation equality omitted'
        ),
      },
    },
    {
      label: 'ticket generation check moved after TTL',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if expected_generation != candidate_generation {\n            return Err(CommandDeadlineTicketErrorV1::GenerationMismatch {\n                candidate: candidate_generation,\n                expected: expected_generation,\n            });\n        }\n        if local_ttl_proposal.is_zero() {\n            return Err(CommandDeadlineTicketErrorV1::ZeroLocalTtlProposal);\n        }',
          '        if local_ttl_proposal.is_zero() {\n            return Err(CommandDeadlineTicketErrorV1::ZeroLocalTtlProposal);\n        }\n        if expected_generation != candidate_generation {\n            return Err(CommandDeadlineTicketErrorV1::GenerationMismatch {\n                candidate: candidate_generation,\n                expected: expected_generation,\n            });\n        }',
          'ticket generation check moved after TTL'
        ),
      },
    },
    {
      label: 'zero local deadline TTL accepted',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if local_ttl_proposal.is_zero() {\n            return Err(CommandDeadlineTicketErrorV1::ZeroLocalTtlProposal);\n        }',
          '',
          'zero local deadline TTL accepted'
        ),
      },
    },
    {
      label: 'equal local deadline TTL rejected',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if local_ttl_proposal > requested {',
          '        if local_ttl_proposal >= requested {',
          'equal local deadline TTL rejected'
        ),
      },
    },
    {
      label: 'draft maximum replaces candidate TTL',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        let requested = candidate.requested_ttl().get();',
          '        let requested = crate::contract::DRAFT_L1_MAX_COMMAND_TTL;',
          'draft maximum replaces candidate TTL'
        ),
      },
    },
    {
      label: 'requested TTL replaces local scheduled TTL',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '            .checked_deadline(local_ttl_proposal)',
          '            .checked_deadline(requested)',
          'requested TTL replaces local scheduled TTL'
        ),
      },
    },
    {
      label: 'monitor-start clock anchors ticket deadline',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        let deadline = received_at\n            .checked_deadline(local_ttl_proposal)',
          '        let deadline = PlantReceiptTime::from_monotonic_test_instant(Instant::now())\n            .checked_deadline(local_ttl_proposal)',
          'monitor-start clock anchors ticket deadline'
        ),
      },
    },
    {
      label: 'unchecked receipt deadline arithmetic',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '            .ok_or(CommandDeadlineTicketErrorV1::UnrepresentableDeadline)?;',
          '            .unwrap();',
          'unchecked receipt deadline arithmetic'
        ),
      },
    },
    {
      label: 'profile kind replaces full deadline profile',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '                profile: candidate.profile().identity(),',
          '                profile: candidate.profile().kind(),',
          'profile kind replaces full deadline profile'
        ),
      },
    },
    {
      label: 'deadline ticket session synthesized',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '                session: candidate.session(),',
          '                session: CommandSessionIdentity::new([1; 16]).unwrap(),',
          'deadline ticket session synthesized'
        ),
      },
    },
    {
      label: 'deadline ticket sequence synthesized',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '                stream_sequence: candidate.stream_sequence(),',
          '                stream_sequence: CommandStreamSequence::new(1).unwrap(),',
          'deadline ticket sequence synthesized'
        ),
      },
    },
    {
      label: 'expected generation replaces candidate generation',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '                generation: candidate_generation,',
          '                generation: expected_generation,',
          'expected generation replaces candidate generation'
        ),
      },
    },
    {
      label: 'ticket receipt replaced by current clock',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        let received_at = candidate.received_at();',
          '        let received_at = PlantReceiptTime::from_monotonic_test_instant(Instant::now());',
          'ticket receipt replaced by current clock'
        ),
      },
    },
    {
      label: 'requested TTL stored as scheduled TTL',
      expectedError: 'CommandDeadlineTicketV1::try_from_candidate closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '            scheduled_ttl: local_ttl_proposal,',
          '            scheduled_ttl: requested,',
          'requested TTL stored as scheduled TTL'
        ),
      },
    },
    {
      label: 'public raw plant receipt helper',
      expectedError: 'PlantReceiptTime deadline-monitor helper complete method surface drift',
      overrides: {
        contract: replacedExactlyOnce(
          contract,
          'impl PlantReceiptTime {',
          'impl PlantReceiptTime {\n    pub const fn raw_instant(self) -> Instant { self.0 }',
          'public raw plant receipt helper'
        ),
      },
    },
    {
      label: 'terminal phase bypassed before deadline observation',
      expectedError: 'MonitorState::observe_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if matches!(self.phase, MonitorPhase::Terminal(_)) {\n            return None;\n        }',
          '',
          'terminal phase bypassed before deadline observation'
        ),
      },
    },
    {
      label: 'deadline observation clock regression omitted',
      expectedError: 'MonitorState::observe_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if observed_at < self.last_observed {\n            self.terminalize(DeadlineMonitorTerminalV1::simple(\n                DeadlineMonitorTerminalKindV1::ClockRegressed,\n                self.last_active_key,\n            ));\n            return None;\n        }',
          '',
          'deadline observation clock regression omitted'
        ),
      },
    },
    {
      label: 'exact active deadline remains fresh',
      expectedError: 'MonitorState::observe_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '            MonitorPhase::Armed(active) if observed_at >= active.ticket.deadline => {',
          '            MonitorPhase::Armed(active) if observed_at > active.ticket.deadline => {',
          'exact active deadline remains fresh'
        ),
      },
    },
    {
      label: 'active deadline checked after replacement validation',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if self.observe_at(observed_at).is_none() {\n            return Err(DeadlineAdvanceErrorV1::MonitorTerminal);\n        }\n        let next_key = next.key;',
          '        let next_key = next.key;',
          'active deadline checked after replacement validation'
        ),
      },
    },
    {
      label: 'deadline replacement ignores exact profile',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if next_key.profile != self.fixed_profile {\n            return Err(DeadlineAdvanceErrorV1::ProfileMismatch {\n                expected: self.fixed_profile,\n                received: next_key.profile,\n            });\n        }',
          '',
          'deadline replacement ignores exact profile'
        ),
      },
    },
    {
      label: 'deadline replacement ignores exact session',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if next_key.session != self.fixed_session {\n            return Err(DeadlineAdvanceErrorV1::SessionMismatch {\n                expected: self.fixed_session,\n                received: next_key.session,\n            });\n        }',
          '',
          'deadline replacement ignores exact session'
        ),
      },
    },
    {
      label: 'deadline replacement ignores exact generation',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if next_key.generation != self.fixed_generation {\n            return Err(DeadlineAdvanceErrorV1::GenerationMismatch {\n                expected: self.fixed_generation,\n                received: next_key.generation,\n            });\n        }',
          '',
          'deadline replacement ignores exact generation'
        ),
      },
    },
    {
      label: 'duplicate deadline sequence accepted',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if next_key.stream_sequence <= current_key.stream_sequence {',
          '        if next_key.stream_sequence < current_key.stream_sequence {',
          'duplicate deadline sequence accepted'
        ),
      },
    },
    {
      label: 'lower deadline sequence accepted',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if next_key.stream_sequence <= current_key.stream_sequence {',
          '        if next_key.stream_sequence == current_key.stream_sequence {',
          'lower deadline sequence accepted'
        ),
      },
    },
    {
      label: 'superseding receipt regression accepted',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if next.received_at.is_before(current_receipt) {\n            self.terminalize(DeadlineMonitorTerminalV1::superseding_fault(\n                DeadlineMonitorTerminalKindV1::SupersedingReceiptRegressed,\n                current_key,\n                next_key,\n            ));\n            return Err(DeadlineAdvanceErrorV1::MonitorTerminal);\n        }',
          '',
          'superseding receipt regression accepted'
        ),
      },
    },
    {
      label: 'exact superseding deadline remains fresh',
      expectedError: 'MonitorState::advance_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if observed_at >= next.deadline {',
          '        if observed_at > next.deadline {',
          'exact superseding deadline remains fresh'
        ),
      },
    },
    {
      label: 'generation report bypasses current deadline',
      expectedError: 'MonitorState::report_generation_mismatch_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if self.observe_at(observed_at).is_none() {\n            return Err(DeadlineControlErrorV1::MonitorTerminal);\n        }\n        if reported_generation == self.fixed_generation {',
          '        if reported_generation == self.fixed_generation {',
          'generation report bypasses current deadline'
        ),
      },
    },
    {
      label: 'shutdown bypasses current deadline',
      expectedError: 'MonitorState::shutdown_at closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if self.observe_at(observed_at).is_some() {',
          '        if true {',
          'shutdown bypasses current deadline'
        ),
      },
    },
    {
      label: 'terminal deadline evidence overwritten',
      expectedError: 'MonitorState::terminalize closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if matches!(self.phase, MonitorPhase::Armed(_)) {\n            self.phase = MonitorPhase::Terminal(Some(terminal));\n        }',
          '        self.phase = MonitorPhase::Terminal(Some(terminal));',
          'terminal deadline evidence overwritten'
        ),
      },
    },
    {
      label: 'unnamed deadline worker',
      expectedError: 'worker name must remain one private exact constant',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          'const DEADLINE_WORKER_NAME: &str = "crebain-command-deadline-v1";',
          'const DEADLINE_WORKER_NAME: &str = "deadline-worker";',
          'unnamed deadline worker'
        ),
      },
    },
    {
      label: 'deadline worker uses non-timeout wait',
      expectedError: 'run_worker closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        match shared.wake.wait_timeout(state, wait_for) {',
          '        match shared.wake.wait(state).map(|state| (state, ())) {',
          'deadline worker uses non-timeout wait'
        ),
      },
    },
    {
      label: 'deadline worker panic escapes ownership',
      expectedError: 'ActiveCommandDeadlineMonitorV1::start closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '                let outcome = panic::catch_unwind(AssertUnwindSafe(|| run_worker(&worker_shared)));\n                if outcome.is_err() {\n                    publish_worker_panicked(&worker_shared);\n                }',
          '                run_worker(&worker_shared);',
          'deadline worker panic escapes ownership'
        ),
      },
    },
    {
      label: 'deadline worker detached at join',
      expectedError: 'ActiveCommandDeadlineMonitorV1::join_worker closed value shape drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          '        if let Some(worker) = self.worker.take() {\n            if worker.join().is_err() {\n                publish_worker_panicked(&self.shared);\n            }\n        }',
          '        let _detached = self.worker.take();',
          'deadline worker detached at join'
        ),
      },
    },
    {
      label: 'deadline terminal converts to safe action',
      expectedError: 'deadline-monitor trait surface drift',
      overrides: {
        deadlineMonitor: `${deadlineMonitor}\nimpl From<DeadlineMonitorTerminalV1> for crate::safe_action::SafeActionIntentV1 {\n    fn from(_: DeadlineMonitorTerminalV1) -> Self { unimplemented!() }\n}\n`,
      },
    },
    {
      label: 'deadline monitor interprets lifecycle state',
      expectedError: 'ActiveCommandDeadlineMonitorV1 complete method surface drift',
      overrides: {
        deadlineMonitor: replacedExactlyOnce(
          deadlineMonitor,
          'impl ActiveCommandDeadlineMonitorV1 {',
          'impl ActiveCommandDeadlineMonitorV1 {\n    fn transition(_: crate::lifecycle::PlantState) {}',
          'deadline monitor interprets lifecycle state'
        ),
      },
    },
    {
      label: 'deadline monitor contract wiring',
      expectedError: 'deadline monitor must remain unwired',
      overrides: {
        contract: `${contract}\nfn start_deadline_monitor(_: crate::ActiveCommandDeadlineMonitorV1) {}\n`,
      },
    },
    {
      label: 'deadline monitor runtime wiring',
      expectedError: 'deadline monitor must remain unwired',
      overrides: {
        runtime: `${runtime}\nfn run_deadline_monitor(_: crate::ActiveCommandDeadlineMonitorV1) {}\n`,
      },
    },
    {
      label: 'deadline monitor channel wiring',
      expectedError: 'deadline monitor must remain unwired',
      overrides: {
        channels: `${channels}\nfn publish_deadline(_: crate::DeadlineMonitorTerminalV1) {}\n`,
      },
    },
    {
      label: 'deadline monitor adapter wiring',
      expectedError: 'deadline monitor must remain unwired',
      overrides: {
        adapter: `${adapter}\nfn apply_deadline(_: crate::DeadlineMonitorTerminalV1) {}\n`,
      },
    },
    {
      label: 'deadline monitor safe-action wiring',
      expectedError: 'deadline monitor must remain unwired',
      overrides: {
        safeAction: `${safeAction}\nfn select_for_deadline(_: crate::DeadlineMonitorTerminalV1) {}\n`,
      },
    },
    {
      label: 'deadline monitor passive-expiry wiring',
      expectedError: 'deadline monitor must remain unwired',
      overrides: {
        expiry: `${expiry}\nfn arm_from_deadline(_: crate::CommandDeadlineTicketV1) {}\n`,
      },
    },
  ]
  for (const fixture of cases) {
    let rejection = null
    try {
      verifyDeadlineMonitorBoundary(fixture.overrides)
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error)
    }
    if (rejection === null) fail(`deadline-monitor boundary accepted mutation: ${fixture.label}`)
    if (fixture.expectedError && !rejection.includes(fixture.expectedError)) {
      fail(
        `deadline-monitor boundary mutation '${fixture.label}' rejected for the wrong reason: ${rejection}`
      )
    }
  }
  if (cases.length !== 72)
    fail(`deadline-monitor boundary mutation inventory drift; expected 72, got ${cases.length}`)
  return cases.length
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

  verifyVehicleHealthBoundary()
  const healthNegativeMutations = verifyVehicleHealthBoundaryMutations()
  verifySafeActionBoundary()
  const safeActionNegativeMutations = verifySafeActionBoundaryMutations()
  verifyDeadlineMonitorBoundary()
  const deadlineMonitorNegativeMutations = verifyDeadlineMonitorBoundaryMutations()

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

  return {
    files: rustFiles.length,
    packages: metadata.workspace_members.length,
    healthNegativeMutations,
    safeActionNegativeMutations,
    deadlineMonitorNegativeMutations,
    boundaryNegativeMutations:
      healthNegativeMutations + safeActionNegativeMutations + deadlineMonitorNegativeMutations,
  }
}

try {
  const result = verify()
  console.log(
    `OK: inert plant boundary verified (${result.files} Rust files, ${result.packages} workspace packages, zero dependencies, ${result.boundaryNegativeMutations} plant-authority boundary mutations rejected: ${result.healthNegativeMutations} health/freshness, ${result.safeActionNegativeMutations} safe-action, and ${result.deadlineMonitorNegativeMutations} deadline-monitor)`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
