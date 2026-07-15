import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { TAURI_COMMANDS } from '../tauriCommands'

const BACKEND = readFileSync(`${process.cwd()}/src-tauri/src/lib.rs`, 'utf8')
const TRANSPORT_COMMANDS = readFileSync(
  `${process.cwd()}/src-tauri/src/transport/commands.rs`,
  'utf8'
)
const ONNX_DETECTOR = readFileSync(`${process.cwd()}/src-tauri/src/onnx_detector.rs`, 'utf8')
const COMMAND_SOURCES = `${BACKEND}\n${TRANSPORT_COMMANDS}`
const FRONTEND_SOURCES = readSourceFiles(`${process.cwd()}/src`)

function readSourceFiles(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== '__tests__')
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) return [readSourceFiles(path)]
      if (
        !entry.isFile() ||
        !/\.(ts|tsx)$/.test(entry.name) ||
        /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      )
        return []
      if (statSync(path).size === 0) return []
      return [readFileSync(path, 'utf8')]
    })
    .join('\n')
}

function commandValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(commandValues)
}

function invokeHandlerCommands(source: string): string[] {
  const handler = source.match(/generate_handler!\[([\s\S]*?)\]\)/)
  if (!handler) return []
  return handler[1]
    .split('\n')
    .map((line) =>
      line
        .replace(/\/\/.*$/, '')
        .trim()
        .replace(/,$/, '')
    )
    .filter(Boolean)
}

function commandBlock(source: string, command: string): string {
  const start = source.indexOf(`fn ${command}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const nextDoc = source.indexOf('\n///', start + command.length)
  return nextDoc === -1 ? source.slice(start) : source.slice(start, nextDoc)
}

describe('Tauri command registration', () => {
  it('registers every frontend command constant in the backend invoke handler', () => {
    const registered = new Set(invokeHandlerCommands(BACKEND))

    for (const command of commandValues(TAURI_COMMANDS)) {
      expect(registered.has(command)).toBe(true)
    }
  })

  it('exposes every registered backend command through the frontend command contract', () => {
    const frontendCommands = new Set(commandValues(TAURI_COMMANDS))

    for (const command of invokeHandlerCommands(BACKEND)) {
      expect(frontendCommands.has(command)).toBe(true)
    }
  })

  it('keeps frontend invokes routed through centralized command constants', () => {
    expect(FRONTEND_SOURCES).not.toMatch(/invoke(?:<[^>]+>)?\(\s*['"`][a-z0-9_]+['"`]/)
  })

  it('keeps registered command symbols backed by command functions', () => {
    for (const command of invokeHandlerCommands(BACKEND)) {
      expect(COMMAND_SOURCES).toMatch(new RegExp(`(?:async\\s+)?fn\\s+${command}\\b`))
    }
  })

  it('validates transport topics before using the backend transport engine', () => {
    for (const command of [
      TAURI_COMMANDS.transport.subscribeCamera,
      TAURI_COMMANDS.transport.subscribeCameraInfo,
      TAURI_COMMANDS.transport.subscribeImu,
      TAURI_COMMANDS.transport.subscribePose,
      TAURI_COMMANDS.transport.subscribeModelStates,
      TAURI_COMMANDS.transport.unsubscribe,
    ]) {
      const block = commandBlock(TRANSPORT_COMMANDS, command)
      // The engine is acquired either via the current_bridge() helper or a
      // direct TRANSPORT_ENGINE.lock(); validation must come first either way.
      const engineIndexes = [
        block.indexOf('current_bridge('),
        block.indexOf('TRANSPORT_ENGINE.lock()'),
      ].filter((index) => index >= 0)
      expect(engineIndexes.length).toBeGreaterThan(0)
      expect(block.indexOf('validate_topic(&topic)?;')).toBeGreaterThanOrEqual(0)
      expect(block.indexOf('validate_topic(&topic)?;')).toBeLessThan(Math.min(...engineIndexes))
    }
  })

  it('excludes direct inference and transport mutation bypass commands', () => {
    const registered = new Set(invokeHandlerCommands(BACKEND))
    const frontendCommands = new Set(commandValues(TAURI_COMMANDS))
    const forbidden = [
      'detect_coreml',
      'detect_coreml_raw',
      'detect_onnx',
      'transport_publish_velocity',
      'transport_publish_twist_stamped',
      'transport_publish_pose',
      'transport_spawn_gazebo_model',
    ]

    for (const command of forbidden) {
      expect(registered.has(command), command).toBe(false)
      expect(frontendCommands.has(command), command).toBe(false)
      expect(COMMAND_SOURCES, command).not.toMatch(new RegExp(`(?:async\\s+)?fn\\s+${command}\\b`))
    }
  })

  it('keeps the production renderer free of legacy authority routes', () => {
    expect(FRONTEND_SOURCES).not.toMatch(
      /getGazeboController|\b(?:GazeboController|WaypointManager)\b/
    )
    expect(FRONTEND_SOURCES).not.toMatch(
      /\.callService\(|\.publishSetpoint|transport_(?:publish|spawn)_/
    )
    expect(FRONTEND_SOURCES).not.toMatch(
      /mavros\/(?:setpoint|set_mode|cmd\/arming)|gazebo\/(?:pause|unpause|reset|spawn|delete|set_model)/
    )
    expect(existsSync(`${process.cwd()}/src/ros/GazeboController.ts`)).toBe(false)
    expect(existsSync(`${process.cwd()}/src/ros/WaypointManager.ts`)).toBe(false)
  })

  it('keeps scene file commands guarded by path, size, and JSON validation', () => {
    const saveBlock = commandBlock(BACKEND, TAURI_COMMANDS.scene.saveFile)
    const loadBlock = commandBlock(BACKEND, TAURI_COMMANDS.scene.loadFile)
    const boundedReadBlock = commandBlock(BACKEND, 'read_scene_file_bounded')

    expect(saveBlock).toContain('if json.is_empty()')
    expect(saveBlock).toContain('json.len() > MAX_SCENE_STATE_BYTES')
    expect(saveBlock).toContain('validate_scene_file_path(&path, &scenes_dir)?')
    expect(saveBlock).toContain('serde_json::from_str(&json)')

    expect(loadBlock).toContain('validate_scene_file_path(&path, &scenes_dir)?')
    expect(loadBlock).toContain('read_scene_file_bounded(&validated_path, MAX_SCENE_STATE_BYTES)?')
    expect(loadBlock).toContain('serde_json::from_str(&contents)')

    expect(boundedReadBlock).toContain('.checked_add(1)')
    expect(boundedReadBlock).toContain('.take(read_limit)')
    expect(boundedReadBlock).toContain('bytes.len() > max_bytes')
  })

  it('keeps model path environment variables guarded by model-path validation', () => {
    expect(BACKEND).toContain('validate_model_path(&custom_path, Some(&["mlmodelc"]))')
    expect(ONNX_DETECTOR).toContain('validate_model_path(&custom_path, Some(&["onnx"]))')
    expect(ONNX_DETECTOR).toContain('CREBAIN_ONNX_MODEL')
    expect(ONNX_DETECTOR).toContain('CREBAIN_MODEL_PATH')
  })
})
