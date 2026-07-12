import { describe, expect, it } from 'vitest'
import { TAURI_COMMANDS } from '../tauriCommands'

describe('TAURI_COMMANDS', () => {
  it('centralizes detection and scene command names', () => {
    expect(TAURI_COMMANDS.detection.nativeRaw).toBe('detect_native_raw')
    expect(TAURI_COMMANDS.detection.systemInfo).toBe('get_system_info')
    expect(TAURI_COMMANDS.scene.saveFile).toBe('scene_save_file')
    expect(TAURI_COMMANDS.scene.loadFile).toBe('scene_load_file')
  })

  it('centralizes fusion command names', () => {
    expect(Object.values(TAURI_COMMANDS.fusion)).toEqual([
      'fusion_init',
      'fusion_process',
      'fusion_get_tracks',
      'fusion_get_stats',
      'fusion_set_config',
      'fusion_clear',
      'fusion_get_algorithms',
      'fusion_get_modalities',
    ])
  })

  it('centralizes transport command names', () => {
    expect(TAURI_COMMANDS.transport.connect).toBe('transport_connect')
    expect(TAURI_COMMANDS.transport.disconnect).toBe('transport_disconnect')
    expect(TAURI_COMMANDS.transport.subscribeModelStates).toBe('transport_subscribe_model_states')
  })

  it('does not expose direct inference or transport mutation bypasses', () => {
    const commandNames = JSON.stringify(TAURI_COMMANDS)

    expect(commandNames).not.toMatch(/detect_(?:coreml|onnx)/)
    expect(commandNames).not.toMatch(/transport_(?:publish|spawn)/)
  })
})
