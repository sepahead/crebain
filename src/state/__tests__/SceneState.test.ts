import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

import { MAX_SCENE_STATE_BYTES, SceneStateManager, type SceneState } from '../SceneState'

function validScene(name = 'Valid Scene'): SceneState {
  return {
    version: '1.0.0',
    timestamp: 123,
    name,
    description: 'Nested validation fixture',
    splatScene: {
      url: '/scene.splat',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    assets: [
      {
        id: 'asset-1',
        name: 'Remote model',
        type: 'glb',
        source: '/models/remote.glb',
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 0.5, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ],
    cameras: [
      {
        id: 'cam-1',
        name: 'Camera 1',
        type: 'patrol',
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0.1, y: 0.2, z: 0.3 },
        fov: 60,
        near: 0.1,
        far: 1000,
        isActive: true,
        resolution: [640, 480],
        pan: 0,
        tilt: 0,
        zoom: 1,
        patrolPoints: [{ x: 4, y: 5, z: 6 }],
        patrolSpeed: 1,
      },
    ],
    activeCameraId: 'cam-1',
    drones: [
      {
        id: 'drone-1',
        type: 'maverick',
        position: { x: 1, y: 2, z: 3 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        velocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        armed: false,
        battery: 90,
        targetAltitude: 10,
        targetPosition: { x: 1, y: 2, z: 10 },
        flightMode: 'manual',
        waypoints: [{ x: 10, y: 0, z: 5 }],
      },
    ],
    recentDetections: [
      {
        id: 'det-1',
        cameraId: 'cam-1',
        class: 'drone',
        confidence: 0.9,
        bbox: [1, 2, 3, 4],
        timestamp: 456,
        threatLevel: 3,
      },
    ],
    settings: {
      detectionEnabled: true,
      showDetectionPanel: true,
      showPerformancePanel: true,
      renderQuality: 'high',
      physicsEnabled: true,
      sensorSimulationEnabled: true,
    },
    viewCamera: {
      position: { x: 0, y: 5, z: 10 },
      target: { x: 0, y: 0, z: 0 },
    },
    metadata: { source: 'test' },
  }
}

describe('SceneStateManager filesystem IPC', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(false)
    localStorage.clear()
  })

  it('saves current scene state through the Tauri filesystem command', async () => {
    invokeMock.mockResolvedValue(undefined)
    const manager = new SceneStateManager()
    manager.createNew('IPC Scene')

    await manager.saveToFileSystem('/tmp/ipc-scene.json')

    expect(invokeMock).toHaveBeenCalledWith('scene_save_file', {
      path: '/tmp/ipc-scene.json',
      json: expect.stringContaining('"name": "IPC Scene"'),
    })
  })

  it('does not call IPC when no scene state exists', async () => {
    const manager = new SceneStateManager()

    await manager.saveToFileSystem('/tmp/empty.json')

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('falls back to browser file save using the path basename when IPC save fails', async () => {
    invokeMock.mockRejectedValue(new Error('not in tauri'))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new SceneStateManager()
    const saveToFile = vi.spyOn(manager, 'saveToFile').mockImplementation(() => undefined)
    manager.createNew('Fallback Scene')

    try {
      await manager.saveToFileSystem('/tmp/fallback-scene.json')
    } finally {
      consoleWarn.mockRestore()
    }

    expect(saveToFile).toHaveBeenCalledWith('fallback-scene.json')
  })

  it('surfaces Tauri filesystem save failures without browser fallback', async () => {
    const error = new Error('permission denied')
    invokeMock.mockRejectedValue(error)
    isTauriMock.mockReturnValue(true)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new SceneStateManager()
    const saveToFile = vi.spyOn(manager, 'saveToFile').mockImplementation(() => undefined)
    manager.createNew('Desktop Scene')

    try {
      await expect(manager.saveToFileSystem('/tmp/desktop-scene.json')).rejects.toThrow(
        'permission denied'
      )
    } finally {
      consoleWarn.mockRestore()
    }

    expect(saveToFile).not.toHaveBeenCalled()
  })

  it('loads scene state through the Tauri filesystem command', async () => {
    const json = JSON.stringify(validScene('Loaded Scene'))
    invokeMock.mockResolvedValue(json)
    const manager = new SceneStateManager()

    const state = await manager.loadFromFileSystem('/tmp/loaded-scene.json')

    expect(invokeMock).toHaveBeenCalledWith('scene_load_file', { path: '/tmp/loaded-scene.json' })
    expect(state?.name).toBe('Loaded Scene')
    expect(manager.getState()?.name).toBe('Loaded Scene')
  })

  it('accepts valid nested scene state content', () => {
    const manager = new SceneStateManager()
    const state = manager.deserialize(JSON.stringify(validScene('Nested Scene')))

    expect(state.cameras[0]?.resolution).toEqual([640, 480])
    expect(state.assets?.[0]?.source).toBe('/models/remote.glb')
    expect(state.drones[0]?.battery).toBe(90)
    expect(state.recentDetections[0]?.confidence).toBe(0.9)
    expect(manager.getState()?.name).toBe('Nested Scene')
  })

  it('rejects malformed scene state without replacing the current scene', () => {
    const manager = new SceneStateManager()
    manager.createNew('Current Scene')

    expect(() =>
      manager.deserialize(JSON.stringify({ version: '1.0.0', name: 'Broken Scene' }))
    ).toThrow('Invalid scene state file')
    expect(manager.getState()?.name).toBe('Current Scene')
  })

  it('rejects invalid nested scene content without replacing the current scene', () => {
    const manager = new SceneStateManager()
    manager.deserialize(JSON.stringify(validScene('Current Scene')))
    const malformed = validScene('Broken Nested Scene')
    malformed.cameras[0].resolution = [0, 480]
    malformed.drones[0].battery = 101
    malformed.recentDetections[0].confidence = Number.NaN

    expect(() => manager.deserialize(JSON.stringify(malformed))).toThrow('Invalid scene state file')
    expect(manager.getState()?.name).toBe('Current Scene')
  })

  it('rejects non-reloadable asset URLs and invalid transforms', () => {
    const manager = new SceneStateManager()
    const unsafeSource = validScene('Unsafe Asset')
    unsafeSource.assets![0].source = 'data:model/gltf-binary;base64,AAAA'
    expect(() => manager.deserialize(JSON.stringify(unsafeSource))).toThrow(
      'Invalid scene state file'
    )

    const invalidScale = validScene('Invalid Asset Scale')
    invalidScale.assets![0].scale.x = 0
    expect(() => manager.deserialize(JSON.stringify(invalidScale))).toThrow(
      'Invalid scene state file'
    )

    const insecureRemote = validScene('Insecure remote asset')
    insecureRemote.assets![0].source = 'http://example.com/model.glb'
    expect(() => manager.deserialize(JSON.stringify(insecureRemote))).toThrow(
      'Invalid scene state file'
    )

    const externalGltf = validScene('External glTF')
    externalGltf.assets![0].source = 'https://example.com/model.gltf'
    expect(() => manager.deserialize(JSON.stringify(externalGltf))).toThrow(
      'Invalid scene state file'
    )

    const missingAssetId = validScene('Missing asset id')
    missingAssetId.assets![0].id = ''
    expect(() => manager.deserialize(JSON.stringify(missingAssetId))).toThrow(
      'Invalid scene state file'
    )

    const oversizedAssetName = validScene('Oversized asset name')
    oversizedAssetName.assets![0].name = 'x'.repeat(257)
    expect(() => manager.deserialize(JSON.stringify(oversizedAssetName))).toThrow(
      'Invalid scene state file'
    )
  })

  it('rejects non-reloadable splats, orphan detections, and excessive camera GPU budgets', () => {
    const manager = new SceneStateManager()

    const localOnlySplat = validScene('Local-only splat')
    localOnlySplat.splatScene = {
      url: '',
      localPath: '/tmp/private.splat',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    }
    expect(() => manager.deserialize(JSON.stringify(localOnlySplat))).toThrow(
      'Invalid scene state file'
    )

    const orphanDetection = validScene('Orphan detection')
    orphanDetection.recentDetections[0].cameraId = 'missing-camera'
    expect(() => manager.deserialize(JSON.stringify(orphanDetection))).toThrow(
      'Invalid scene state file'
    )

    const excessiveTargets = validScene('Excessive render targets')
    excessiveTargets.cameras[0].resolution = [4096, 4096]
    excessiveTargets.cameras.push({
      ...excessiveTargets.cameras[0],
      id: 'cam-2',
      name: 'Camera 2',
    })
    expect(() => manager.deserialize(JSON.stringify(excessiveTargets))).toThrow(
      'Invalid scene state file'
    )
  })

  it('rejects non-unit drone orientations and unsafe patrol speeds', () => {
    const manager = new SceneStateManager()
    const invalidQuaternion = validScene('Invalid quaternion')
    invalidQuaternion.drones[0].orientation = { x: 0, y: 0, z: 0, w: 2 }
    expect(() => manager.deserialize(JSON.stringify(invalidQuaternion))).toThrow(
      'Invalid scene state file'
    )

    const invalidPatrol = validScene('Invalid patrol')
    invalidPatrol.cameras[0].patrolSpeed = 1.1
    expect(() => manager.deserialize(JSON.stringify(invalidPatrol))).toThrow(
      'Invalid scene state file'
    )
  })

  it('rejects scene files with an unsupported version with a clear error', () => {
    const manager = new SceneStateManager()
    const future = { ...validScene('Future Scene'), version: '2.0.0' }

    expect(() => manager.deserialize(JSON.stringify(future))).toThrow(
      'Unsupported scene state version "2.0.0" (expected "1.0.0")'
    )
  })

  it('dispatches migration on the raw version before strict validation', () => {
    const manager = new SceneStateManager()

    // A minimal old-format file that does NOT satisfy the current strict
    // schema: the version dispatch must fire first with a clear error instead
    // of a generic validation failure.
    expect(() => manager.deserialize(JSON.stringify({ version: '0.9.0', name: 'Old' }))).toThrow(
      'Unsupported scene state version "0.9.0" (expected "1.0.0")'
    )
  })

  it('migrates supported legacy and missing-version scenes with safe defaults', () => {
    const manager = new SceneStateManager()
    const legacy = manager.deserialize(JSON.stringify({ version: '0.4.0', name: 'Legacy' }))
    expect(legacy).toMatchObject({
      version: '1.0.0',
      name: 'Legacy',
      cameras: [],
      drones: [],
      recentDetections: [],
    })
    expect(legacy.settings.renderQuality).toBe('high')
    expect(legacy.viewCamera.position).toEqual({ x: 0, y: 5, z: 10 })

    const missingVersion = validScene('No Version') as unknown as Record<string, unknown>
    delete missingVersion.version
    expect(manager.deserialize(JSON.stringify(missingVersion)).version).toBe('1.0.0')
  })

  it('rejects oversized and non-JSON browser scene files before reading them', async () => {
    const manager = new SceneStateManager()
    const readOversized = vi.fn(async () => JSON.stringify(validScene()))
    const oversized = {
      name: 'oversized.json',
      size: MAX_SCENE_STATE_BYTES + 1,
      text: readOversized,
    } as unknown as File

    await expect(manager.loadFromFile(oversized)).rejects.toThrow('Scene state exceeds')
    expect(readOversized).not.toHaveBeenCalled()

    const readWrongType = vi.fn(async () => JSON.stringify(validScene()))
    const wrongType = {
      name: 'scene.txt',
      size: 10,
      text: readWrongType,
    } as unknown as File
    await expect(manager.loadFromFile(wrongType)).rejects.toThrow('must end with .json')
    expect(readWrongType).not.toHaveBeenCalled()
  })

  it('skips malformed localStorage scene entries when listing saved states', () => {
    localStorage.setItem(
      'crebain_scene_good',
      JSON.stringify({ ...validScene('Good Scene'), timestamp: 2 })
    )
    localStorage.setItem(
      'crebain_scene_bad',
      JSON.stringify({ version: '1.0.0', name: 'Bad Scene' })
    )
    const manager = new SceneStateManager()

    expect(manager.listSavedStates()).toEqual([
      { key: 'crebain_scene_good', name: 'Good Scene', timestamp: 2 },
    ])
  })

  it('lists the autosave as a recoverable scene entry', () => {
    localStorage.setItem(
      'crebain_autosave',
      JSON.stringify({ ...validScene('Recovered Autosave'), timestamp: 10 })
    )
    const manager = new SceneStateManager()

    expect(manager.listSavedStates()).toContainEqual({
      key: 'crebain_autosave',
      name: 'Recovered Autosave',
      timestamp: 10,
    })
  })

  it('reports localStorage quota failures to the caller', () => {
    const manager = new SceneStateManager()
    manager.createNew('Quota Scene')
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })

    try {
      expect(manager.saveToLocalStorage('crebain_scene_quota')).toBe(false)
    } finally {
      setItem.mockRestore()
    }
  })

  it('captures a fresh snapshot before autosaving', () => {
    vi.useFakeTimers()
    const manager = new SceneStateManager()
    manager.createNew('Stale Scene')
    const capture = vi.fn(() => validScene('Live Autosave'))

    try {
      manager.enableAutosave(1, capture)
      vi.advanceTimersByTime(1_000)

      expect(capture).toHaveBeenCalledOnce()
      expect(JSON.parse(localStorage.getItem('crebain_autosave') ?? '{}').name).toBe(
        'Live Autosave'
      )
    } finally {
      manager.disableAutosave()
      vi.useRealTimers()
    }
  })

  it('stops autosave and reports storage failures', () => {
    vi.useFakeTimers()
    const manager = new SceneStateManager()
    manager.createNew('Quota Autosave')
    const onError = vi.fn()
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })

    try {
      manager.enableAutosave(1, undefined, onError)
      vi.advanceTimersByTime(1_000)
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }))
      expect(manager.isAutosaveEnabled()).toBe(false)
    } finally {
      setItem.mockRestore()
      manager.disableAutosave()
      vi.useRealTimers()
    }
  })

  it('refuses to serialize corrupted live scene state', () => {
    const manager = new SceneStateManager()
    manager.deserialize(JSON.stringify(validScene('Live Scene')))
    manager.updateState({
      viewCamera: {
        position: { x: Number.NaN, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
      },
    })

    expect(() => manager.serialize()).toThrow('Current scene state is invalid')
    expect(manager.saveToLocalStorage('crebain_scene_corrupt')).toBe(false)
  })

  it('refuses to serialize a scene larger than the load limit', () => {
    const manager = new SceneStateManager()
    manager.deserialize(JSON.stringify(validScene('Oversized export')))
    manager.updateState({ metadata: { padding: 'x'.repeat(MAX_SCENE_STATE_BYTES) } })

    expect(() => manager.serialize()).toThrow('Scene state exceeds')
  })

  it('returns null when IPC load fails', async () => {
    invokeMock.mockRejectedValue(new Error('missing file'))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new SceneStateManager()

    let state
    try {
      state = await manager.loadFromFileSystem('/tmp/missing.json')
    } finally {
      consoleWarn.mockRestore()
    }

    expect(state).toBeNull()
  })
})
