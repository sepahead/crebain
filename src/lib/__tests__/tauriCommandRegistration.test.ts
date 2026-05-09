import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { TAURI_COMMANDS } from '../tauriCommands'

const BACKEND = readFileSync(`${process.cwd()}/src-tauri/src/lib.rs`, 'utf8')
const TRANSPORT_COMMANDS = readFileSync(`${process.cwd()}/src-tauri/src/transport/commands.rs`, 'utf8')
const ONNX_DETECTOR = readFileSync(`${process.cwd()}/src-tauri/src/onnx_detector.rs`, 'utf8')
const COMMAND_SOURCES = `${BACKEND}\n${TRANSPORT_COMMANDS}`

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
    .map(line => line.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
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
      TAURI_COMMANDS.transport.publishVelocity,
      TAURI_COMMANDS.transport.publishTwistStamped,
      TAURI_COMMANDS.transport.publishPose,
    ]) {
      const block = commandBlock(TRANSPORT_COMMANDS, command)
      expect(block.indexOf('validate_topic(&topic)?;')).toBeGreaterThanOrEqual(0)
      expect(block.indexOf('validate_topic(&topic)?;')).toBeLessThan(block.indexOf('TRANSPORT_ENGINE.lock()'))
    }
  })

  it('keeps scene file commands guarded by path, size, and JSON validation', () => {
    const saveBlock = commandBlock(BACKEND, TAURI_COMMANDS.scene.saveFile)
    const loadBlock = commandBlock(BACKEND, TAURI_COMMANDS.scene.loadFile)

    expect(saveBlock).toContain('if json.is_empty()')
    expect(saveBlock).toContain('json.len() > MAX_SCENE_STATE_BYTES')
    expect(saveBlock).toContain('validate_scene_file_path(&path, &scenes_dir)?')
    expect(saveBlock).toContain('serde_json::from_str(&json)')

    expect(loadBlock).toContain('validate_scene_file_path(&path, &scenes_dir)?')
    expect(loadBlock).toContain('meta.len() as usize > MAX_SCENE_STATE_BYTES')
    expect(loadBlock).toContain('serde_json::from_str(&contents)')
  })

  it('keeps model path environment variables guarded by model-path validation', () => {
    expect(BACKEND).toContain('validate_model_path(&custom_path, Some(&["mlmodelc"]))')
    expect(ONNX_DETECTOR).toContain('validate_model_path(&custom_path, Some(&["onnx"]))')
    expect(ONNX_DETECTOR).toContain('CREBAIN_ONNX_MODEL')
    expect(ONNX_DETECTOR).toContain('CREBAIN_MODEL_PATH')
  })
})
