export const TAURI_COMMANDS = {
  detection: {
    nativeRaw: 'detect_native_raw',
    systemInfo: 'get_system_info',
  },
  scene: {
    saveFile: 'scene_save_file',
    loadFile: 'scene_load_file',
  },
  fusion: {
    init: 'fusion_init',
    process: 'fusion_process',
    getTracks: 'fusion_get_tracks',
    getStats: 'fusion_get_stats',
    setConfig: 'fusion_set_config',
    clear: 'fusion_clear',
    getAlgorithms: 'fusion_get_algorithms',
    getModalities: 'fusion_get_modalities',
  },
  transport: {
    connect: 'transport_connect',
    disconnect: 'transport_disconnect',
    subscribeCamera: 'transport_subscribe_camera',
    subscribeCameraInfo: 'transport_subscribe_camera_info',
    subscribeImu: 'transport_subscribe_imu',
    subscribePose: 'transport_subscribe_pose',
    subscribeModelStates: 'transport_subscribe_model_states',
    unsubscribe: 'transport_unsubscribe',
    getStats: 'transport_get_stats',
  },
} as const
