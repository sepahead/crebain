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
  }
}

try {
  const result = verify()
  console.log(
    `OK: inert plant boundary verified (${result.files} Rust files, ${result.packages} workspace packages, zero dependencies, ${result.healthNegativeMutations} health-boundary mutations rejected)`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
