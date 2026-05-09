import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import * as THREE from 'three'
import {
  deserializeCamera,
  deserializeDroneSpawnData,
  serializeCamera,
  serializeDrone,
  useSceneState,
  type CrebainCamera,
} from '../useSceneState'
import { sceneStateManager, type SceneState } from '../../state/SceneState'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let hook: ReturnType<typeof useSceneState>
let onStateRestored: any

function Harness({ autosaveInterval = 0 }: { autosaveInterval?: number }) {
  hook = useSceneState({ autosaveInterval, onStateRestored })
  return null
}

function emptyScene(name = 'Initial Scene'): SceneState {
  return {
    version: '1.0.0',
    timestamp: Date.now(),
    name,
    cameras: [],
    drones: [],
    recentDetections: [],
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
  }
}

function camera(): CrebainCamera {
  return {
    id: 'cam-1',
    name: 'Camera 1',
    type: 'patrol',
    position: new THREE.Vector3(1, 2, 3),
    rotation: new THREE.Euler(0.1, 0.2, 0.3),
    fov: 60,
    near: 0.1,
    far: 1000,
    isActive: true,
    patrolPath: [new THREE.Vector3(4, 5, 6)],
    patrolSpeed: 3,
  }
}

function drone(): any {
  return {
    id: 'maverick_1',
    type: 'maverick',
    name: 'Maverick 1',
    physicsBody: {
      state: {
        position: new THREE.Vector3(1, 2, 3),
        orientation: new THREE.Quaternion(0, 0, 0, 1),
        velocity: new THREE.Vector3(4, 5, 6),
        angularVelocity: new THREE.Vector3(0.1, 0.2, 0.3),
        armed: true,
        battery: 87,
      },
    },
    flightController: {},
    mesh: null,
    route: { waypoints: [], mode: 'none', currentWaypointIndex: 0, isActive: false, arrivalThreshold: 1 },
  }
}

async function renderHarness() {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  return root
}

describe('useSceneState helpers', () => {
  beforeEach(() => {
    localStorage.clear()
    onStateRestored = vi.fn()
    sceneStateManager.disableAutosave()
    sceneStateManager.deserialize(JSON.stringify(emptyScene()))
  })

  it('serializes and deserializes camera state', () => {
    const serialized = serializeCamera(camera())
    const restored = deserializeCamera(serialized)

    expect(serialized).toMatchObject({
      id: 'cam-1',
      name: 'Camera 1',
      type: 'patrol',
      position: { x: 1, y: 2, z: 3 },
      resolution: [640, 480],
      patrolPoints: [{ x: 4, y: 5, z: 6 }],
      patrolSpeed: 3,
    })
    expect(restored.position).toBeInstanceOf(THREE.Vector3)
    expect(restored.rotation).toBeInstanceOf(THREE.Euler)
    expect(restored.patrolPath?.[0]).toBeInstanceOf(THREE.Vector3)
  })

  it('serializes drone state and derives spawn data', () => {
    const serialized = serializeDrone(drone())
    const spawnData = deserializeDroneSpawnData(serialized)

    expect(serialized).toMatchObject({
      id: 'maverick_1',
      type: 'maverick',
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 4, y: 5, z: 6 },
      armed: true,
      battery: 87,
      flightMode: 'manual',
    })
    expect(spawnData.name).toBe('maverick')
    expect(spawnData.position).toBeInstanceOf(THREE.Vector3)
    expect(spawnData.orientation).toBeInstanceOf(THREE.Quaternion)
  })

  it('saves current scene state through the hook', async () => {
    const root = await renderHarness()

    let state: SceneState | undefined
    await act(async () => {
      state = hook.saveCurrentState(
        'Hook Scene',
        [camera()],
        [drone()],
        { position: new THREE.Vector3(10, 11, 12), target: new THREE.Vector3(0, 1, 2) },
        { detectionEnabled: false, renderQuality: 'medium' },
        '/scene.splat'
      )
    })

    expect(state?.name).toBe('Hook Scene')
    expect(state?.cameras).toHaveLength(1)
    expect(state?.drones).toHaveLength(1)
    expect(state?.settings).toMatchObject({ detectionEnabled: false, renderQuality: 'medium' })
    expect(state?.splatScene?.url).toBe('/scene.splat')
    expect(hook.getCurrentState()?.name).toBe('Hook Scene')

    await act(async () => root.unmount())
  })

  it('saves, lists, loads, and deletes localStorage scene states', async () => {
    const root = await renderHarness()

    await act(async () => {
      hook.saveCurrentState(
        'Stored Scene',
        [],
        [],
        { position: new THREE.Vector3(), target: new THREE.Vector3() },
        {}
      )
      hook.saveToStorage('crebain_scene_test')
    })

    expect(localStorage.getItem('crebain_scene_test')).toContain('Stored Scene')
    expect(hook.listSavedStates()).toEqual([expect.objectContaining({ key: 'crebain_scene_test', name: 'Stored Scene' })])

    const loaded = hook.loadFromStorage('crebain_scene_test')
    expect(loaded?.name).toBe('Stored Scene')
    expect(onStateRestored).toHaveBeenCalledWith(expect.objectContaining({ name: 'Stored Scene' }))

    hook.deleteSavedState('crebain_scene_test')
    expect(localStorage.getItem('crebain_scene_test')).toBeNull()

    await act(async () => root.unmount())
  })

  it('loads scene state from a File through the hook', async () => {
    const root = await renderHarness()
    const file = new File([JSON.stringify(emptyScene('File Scene'))], 'scene.json', { type: 'application/json' })

    const loaded = await hook.loadFromFile(file)

    expect(loaded?.name).toBe('File Scene')
    expect(onStateRestored).toHaveBeenCalledWith(expect.objectContaining({ name: 'File Scene' }))

    await act(async () => root.unmount())
  })
})
