#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(ROOT, 'docs/baselines/ipc-contract-registry.json')
const FRONTEND_CONTRACT = 'src/lib/tauriCommands.ts'
const BACKEND_HANDLER = 'src-tauri/src/lib.rs'
const TRANSPORT_COMMANDS = 'src-tauri/src/transport/commands.rs'
const TRANSPORT_EVENTS = 'src/lib/transportEvents.ts'
const TRANSPORT_FRONTEND = 'src/ros/ZenohBridge.ts'
const MESSAGE_REGISTRY = 'src/ros/MessageRegistry.ts'
const MESSAGE_TYPES = 'src/ros/types.ts'
const SOURCE_PATHS = [
  FRONTEND_CONTRACT,
  BACKEND_HANDLER,
  TRANSPORT_COMMANDS,
  TRANSPORT_EVENTS,
  TRANSPORT_FRONTEND,
  MESSAGE_REGISTRY,
  MESSAGE_TYPES,
]
const LIFECYCLE_GENERATION_INPUT_COMMANDS = [
  'transport_ack_camera_frame',
  'transport_disconnect',
  'transport_subscribe_camera',
  'transport_subscribe_camera_info',
  'transport_subscribe_imu',
  'transport_subscribe_model_states',
  'transport_subscribe_pose',
  'transport_take_camera_frame',
  'transport_unsubscribe',
]

function fail(message) {
  throw new Error(`IPC registry generation failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function source(path) {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  fail('TAURI_COMMANDS contains a computed or unsupported property name')
}

function frontendCommands() {
  const file = ts.createSourceFile(
    FRONTEND_CONTRACT,
    source(FRONTEND_CONTRACT),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let root = null
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'TAURI_COMMANDS'
    ) {
      root = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert(root && ts.isObjectLiteralExpression(root), 'TAURI_COMMANDS object was not found')

  const commands = []
  const walk = (object, keys = []) => {
    for (const property of object.properties) {
      assert(
        ts.isPropertyAssignment(property),
        'TAURI_COMMANDS must contain property assignments only'
      )
      const key = propertyName(property.name)
      const value = ts.isAsExpression(property.initializer)
        ? property.initializer.expression
        : property.initializer
      if (ts.isObjectLiteralExpression(value)) walk(value, [...keys, key])
      else {
        assert(
          ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value),
          `TAURI_COMMANDS.${[...keys, key].join('.')} is not a static string`
        )
        commands.push({ symbol: `TAURI_COMMANDS.${[...keys, key].join('.')}`, name: value.text })
      }
    }
  }
  walk(root)
  assert(
    new Set(commands.map(({ name }) => name)).size === commands.length,
    'duplicate frontend command'
  )
  return commands
}

function matchingBracket(text, opening, open, close) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = opening; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === open) depth += 1
    if (character === close && --depth === 0) return index
  }
  return -1
}

function backendCommands() {
  const rust = source(BACKEND_HANDLER)
  const matches = [...rust.matchAll(/\.invoke_handler\s*\(\s*tauri::generate_handler!\s*\[/g)]
  assert(matches.length === 1, `expected one production handler list, found ${matches.length}`)
  const opening = matches[0].index + matches[0][0].lastIndexOf('[')
  const closing = matchingBracket(rust, opening, '[', ']')
  assert(closing >= 0, 'production handler list has no closing bracket')
  const names = rust
    .slice(opening + 1, closing)
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  assert(
    names.every((name) => /^[a-z][a-z0-9_]*$/.test(name)),
    'invalid handler token'
  )
  assert(new Set(names).size === names.length, 'duplicate handler token')
  return names
}

function commandPolicy(name) {
  if (name.startsWith('transport_')) {
    return {
      domain: 'transport',
      capability:
        name === 'transport_take_camera_frame' || name === 'transport_ack_camera_frame'
          ? 'bounded-camera-delivery'
          : name.startsWith('transport_subscribe_')
            ? 'read-only-subscription'
            : name === 'transport_unsubscribe'
              ? 'read-only-subscription-lifecycle'
              : name.endsWith('get_stats')
                ? 'read-only-status'
                : 'transport-lifecycle',
      authority: 'none',
      backend_source: TRANSPORT_COMMANDS,
    }
  }
  if (name.startsWith('fusion_')) {
    return {
      domain: 'fusion',
      capability:
        name === 'fusion_set_config' || name === 'fusion_clear' ? 'local-state' : 'local-analysis',
      authority: 'none',
      backend_source: BACKEND_HANDLER,
    }
  }
  if (name.startsWith('scene_')) {
    return {
      domain: 'scene',
      capability: 'bounded-local-persistence',
      authority: 'none',
      backend_source: BACKEND_HANDLER,
    }
  }
  if (name === 'detect_native_raw' || name === 'get_system_info') {
    return {
      domain: 'detection',
      capability: name === 'detect_native_raw' ? 'local-inference' : 'read-only-status',
      authority: 'none',
      backend_source: BACKEND_HANDLER,
    }
  }
  fail(`no explicit policy for command '${name}'`)
}

function recursiveSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) fail(`source scan encountered symlink ${relative(ROOT, path)}`)
    if (entry.isDirectory()) return recursiveSourceFiles(path)
    if (!entry.isFile() || !/\.(?:rs|ts|tsx)$/.test(entry.name)) return []
    if (statSync(path).size === 0) return []
    return [path]
  })
}

function staticEventNames() {
  const rustSources = recursiveSourceFiles(resolve(ROOT, 'src-tauri/src'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  const frontendSources = recursiveSourceFiles(resolve(ROOT, 'src'))
    .filter((path) => !path.includes('/__tests__/') && !/\.(?:test|spec)\./.test(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  const emitted = new Set(
    [...rustSources.matchAll(/\.emit\s*\(\s*"([A-Za-z0-9_:/-]+)"/g)].map((match) => match[1])
  )
  const listened = new Set(
    [...frontendSources.matchAll(/\blisten(?:<[^>]+>)?\s*\(\s*['"]([A-Za-z0-9_:/-]+)['"]/g)].map(
      (match) => match[1]
    )
  )
  return { emitted: [...emitted].sort(), listened: [...listened].sort() }
}

export function createRegistry() {
  const frontend = frontendCommands()
  const backend = backendCommands()
  const frontendNames = new Set(frontend.map(({ name }) => name))
  const backendNames = new Set(backend)
  assert(
    frontendNames.size === backendNames.size &&
      [...frontendNames].every((name) => backendNames.has(name)),
    'frontend and backend command sets differ'
  )
  const commandSources = `${source(BACKEND_HANDLER)}\n${source(TRANSPORT_COMMANDS)}`
  for (const name of backend) {
    assert(
      new RegExp(`(?:async\\s+)?fn\\s+${name}\\b`).test(commandSources),
      `${name} has no handler function`
    )
  }
  const events = staticEventNames()
  assert(JSON.stringify(events.emitted) === '["show-about"]', 'undocumented static backend event')
  assert(JSON.stringify(events.listened) === '["show-about"]', 'undocumented static frontend event')
  const prefixMatch = source(TRANSPORT_EVENTS).match(
    /TRANSPORT_EVENT_PREFIX\s*=\s*['"]([^'"]+)['"]/
  )
  const rustPrefixMatch = source(TRANSPORT_COMMANDS).match(
    /TRANSPORT_EVENT_PREFIX:\s*&str\s*=\s*"([^"]+)"/
  )
  assert(
    prefixMatch && rustPrefixMatch && prefixMatch[1] === rustPrefixMatch[1],
    'transport event prefix drift'
  )

  return {
    schema_version: 2,
    release_target: '0.9.0',
    generated_from: SOURCE_PATHS.map((path) => ({ path, sha256: sha256(source(path)) })),
    transport_identity_contract: {
      lifecycle_generation: {
        wire_encoding: 'canonical-positive-u64-decimal-string',
        native_encoding: 'u64',
        connect_result_command: 'transport_connect',
        input_commands: LIFECYCLE_GENERATION_INPUT_COMMANDS,
        camera_ready_event_field: 'generation',
      },
    },
    commands: frontend
      .map(({ symbol, name }) => ({ name, frontend_symbol: symbol, ...commandPolicy(name) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    events: [
      {
        name: 'show-about',
        kind: 'static',
        direction: 'rust-to-frontend',
        payload: 'unit',
        authority: 'none',
      },
      {
        name: `${prefixMatch[1]}{bijective-escaped-validated-topic}`,
        kind: 'bounded-dynamic-pattern',
        direction: 'rust-to-frontend',
        payload:
          'validated registered telemetry schema, or exact camera-ready delivery descriptor with canonical-positive-u64-decimal-string generation, deliveryId, and cameraSubscriptionId fields for image subscriptions',
        authority: 'none',
      },
    ],
    prohibited_capabilities: [
      'generic publish',
      'ROS service call',
      'plant apply',
      'Gazebo mutation through packaged IPC',
      'dormant NCP action command registration',
    ],
  }
}

export function formattedRegistry() {
  return `${JSON.stringify(createRegistry(), null, 2)}\n`
}

export function verifyRegistry(path = OUTPUT) {
  assert(existsSync(path), `registry is missing: ${relative(ROOT, path)}`)
  const expected = formattedRegistry()
  const actual = readFileSync(path, 'utf8')
  assert(
    actual === expected,
    'registry drift; run `node scripts/generate-ipc-contract-registry.mjs --write`'
  )
  return JSON.parse(actual)
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    if (process.argv.includes('--write')) writeFileSync(OUTPUT, formattedRegistry())
    const registry = verifyRegistry()
    console.log(
      `OK: IPC registry covers ${registry.commands.length} commands and ${registry.events.length} event contracts`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
