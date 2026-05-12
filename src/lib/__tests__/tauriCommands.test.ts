import { describe, expect, it } from 'vitest'
import { TAURI_COMMANDS } from '../tauriCommands'

describe('TAURI_COMMANDS', () => {
  it('centralizes detection and scene command names', () => {
    expect(TAURI_COMMANDS.detection.coremlBase64).toBe('detect_coreml')
    expect(TAURI_COMMANDS.detection.coremlRaw).toBe('detect_coreml_raw')
    expect(TAURI_COMMANDS.detection.nativeRaw).toBe('detect_native_raw')
    expect(TAURI_COMMANDS.detection.onnxRaw).toBe('detect_onnx')
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
    expect(TAURI_COMMANDS.transport.publishTwistStamped).toBe('transport_publish_twist_stamped')
    expect(TAURI_COMMANDS.transport.spawnGazeboModel).toBe('transport_spawn_gazebo_model')
    expect(TAURI_COMMANDS.transport.subscribeModelStates).toBe('transport_subscribe_model_states')
  })
})
