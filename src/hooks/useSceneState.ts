/**
 * CREBAIN Scene State Hook
 * Manages full scene state serialization and restoration
 * Including cameras, drones, splat scenes, and viewer settings
 */

import { useCallback, useRef, useEffect } from 'react'
import * as THREE from 'three'
import {
  sceneStateManager,
  type SceneState,
  type CameraState,
  type DroneState,
  type ViewerSettingsState,
  vector3ToState,
  stateToVector3,
  quaternionToState,
  stateToQuaternion,
} from '../state/SceneState'
import type { ManagedDrone } from './useDroneController'
import { sceneLogger as log } from '../lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA TYPE DEFINITION (matches CrebainViewer)
// ─────────────────────────────────────────────────────────────────────────────

export interface CrebainCamera {
  id: string
  name: string
  type: 'static' | 'ptz' | 'patrol'
  position: THREE.Vector3
  rotation: THREE.Euler
  fov: number
  near: number
  far: number
  isActive: boolean
  helper?: THREE.CameraHelper
  camera?: THREE.PerspectiveCamera
  // PTZ specific
  pan?: number
  tilt?: number
  zoom?: number
  // Patrol specific
  patrolPath?: THREE.Vector3[]
  patrolSpeed?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// SERIALIZATION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a camera to state format
 */
export function serializeCamera(camera: CrebainCamera): CameraState {
  return {
    id: camera.id,
    name: camera.name,
    type: camera.type,
    position: vector3ToState(camera.position),
    rotation: {
      x: camera.rotation.x,
      y: camera.rotation.y,
      z: camera.rotation.z,
    },
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    isActive: camera.isActive,
    resolution: [640, 480],
    pan: camera.pan,
    tilt: camera.tilt,
    zoom: camera.zoom,
    patrolPoints: camera.patrolPath?.map(vector3ToState),
    patrolSpeed: camera.patrolSpeed,
  }
}

/**
 * Deserialize camera state to camera object
 */
export function deserializeCamera(state: CameraState): CrebainCamera {
  return {
    id: state.id,
    name: state.name,
    type: state.type,
    position: stateToVector3(state.position),
    rotation: new THREE.Euler(state.rotation.x, state.rotation.y, state.rotation.z),
    fov: state.fov,
    near: state.near,
    far: state.far,
    isActive: state.isActive,
    pan: state.pan,
    tilt: state.tilt,
    zoom: state.zoom,
    patrolPath: state.patrolPoints?.map(stateToVector3),
    patrolSpeed: state.patrolSpeed,
  }
}

/**
 * Serialize a managed drone to state format
 */
export function serializeDrone(drone: ManagedDrone): DroneState {
  const { physicsBody } = drone
  return {
    id: drone.id,
    type: drone.type,
    position: vector3ToState(physicsBody.state.position),
    orientation: quaternionToState(physicsBody.state.orientation),
    velocity: vector3ToState(physicsBody.state.velocity),
    angularVelocity: vector3ToState(physicsBody.state.angularVelocity),
    armed: physicsBody.state.armed,
    // DronePhysics tracks battery as a 0-1 fraction; the persisted scene format
    // (and isDroneState's 0-100 validation) use a percentage.
    battery: physicsBody.state.battery * 100,
    flightMode: 'manual',
  }
}

/**
 * Deserialize drone state (returns data needed to spawn drone)
 */
export function deserializeDroneSpawnData(state: DroneState): {
  type: string
  name: string
  position: THREE.Vector3
  orientation: THREE.Quaternion
  armed: boolean
} {
  return {
    type: state.type,
    name: state.id.split('_')[0] || 'DRONE',
    position: stateToVector3(state.position),
    orientation: stateToQuaternion(state.orientation),
    armed: state.armed,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

interface UseSceneStateOptions {
  autosaveInterval?: number // seconds, 0 to disable
  onStateRestored?: (state: SceneState) => void
}

interface UseSceneStateReturn {
  // Save operations
  saveCurrentState: (
    sceneName: string,
    cameras: CrebainCamera[],
    drones: ManagedDrone[],
    viewCamera: { position: THREE.Vector3; target: THREE.Vector3 },
    settings: Partial<ViewerSettingsState>,
    splatUrl?: string
  ) => SceneState

  saveToStorage: (key?: string) => void
  saveToFile: (filename?: string) => void

  // Load operations
  loadFromStorage: (key: string) => SceneState | null
  loadFromFile: (file: File) => Promise<SceneState | null>

  // State access
  getCurrentState: () => SceneState | null
  listSavedStates: () => Array<{ key: string; name: string; timestamp: number }>
  deleteSavedState: (key: string) => void

  // Autosave
  enableAutosave: () => void
  disableAutosave: () => void
}

export function useSceneState(options: UseSceneStateOptions = {}): UseSceneStateReturn {
  const { autosaveInterval = 30, onStateRestored } = options
  const autosaveEnabledRef = useRef(false)

  // Initialize state manager on mount
  useEffect(() => {
    // Create initial state if none exists
    if (!sceneStateManager.getState()) {
      sceneStateManager.createNew('Neue Szene')
    }

    // Enable autosave if configured
    if (autosaveInterval > 0) {
      sceneStateManager.enableAutosave(autosaveInterval)
      autosaveEnabledRef.current = true
    }

    return () => {
      sceneStateManager.disableAutosave()
    }
  }, [autosaveInterval])

  /**
   * Save current scene state
   */
  const saveCurrentState = useCallback(
    (
      sceneName: string,
      cameras: CrebainCamera[],
      drones: ManagedDrone[],
      viewCamera: { position: THREE.Vector3; target: THREE.Vector3 },
      settings: Partial<ViewerSettingsState>,
      splatUrl?: string
    ): SceneState => {
      // Serialize cameras
      const cameraStates = cameras.map(serializeCamera)

      // Serialize drones
      const droneStates = drones.map(serializeDrone)

      // Build full state
      const state: SceneState = {
        version: '1.0.0',
        timestamp: Date.now(),
        name: sceneName,
        cameras: cameraStates,
        drones: droneStates,
        recentDetections: [],
        settings: {
          detectionEnabled: settings.detectionEnabled ?? true,
          showDetectionPanel: settings.showDetectionPanel ?? true,
          showPerformancePanel: settings.showPerformancePanel ?? true,
          renderQuality: settings.renderQuality ?? 'high',
          physicsEnabled: settings.physicsEnabled ?? true,
          sensorSimulationEnabled: settings.sensorSimulationEnabled ?? true,
        },
        viewCamera: {
          position: vector3ToState(viewCamera.position),
          target: vector3ToState(viewCamera.target),
        },
        splatScene: splatUrl
          ? {
              url: splatUrl,
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            }
          : undefined,
      }

      // Update state manager
      sceneStateManager.updateState(state)

      return state
    },
    []
  )

  /**
   * Save to localStorage
   */
  const saveToStorage = useCallback((key?: string) => {
    const finalKey = key || `crebain_scene_${Date.now()}`
    sceneStateManager.saveToLocalStorage(finalKey)
  }, [])

  /**
   * Save to file
   */
  const saveToFile = useCallback((filename?: string) => {
    sceneStateManager.saveToFile(filename)
  }, [])

  /**
   * Load from localStorage
   */
  const loadFromStorage = useCallback(
    (key: string): SceneState | null => {
      const state = sceneStateManager.loadFromLocalStorage(key)
      if (state) {
        onStateRestored?.(state)
      }
      return state
    },
    [onStateRestored]
  )

  /**
   * Load from file
   */
  const loadFromFile = useCallback(
    async (file: File): Promise<SceneState | null> => {
      try {
        const state = await sceneStateManager.loadFromFile(file)
        if (state) {
          onStateRestored?.(state)
        }
        return state
      } catch (e) {
        log.error('Failed to load scene from file', { error: e })
        return null
      }
    },
    [onStateRestored]
  )

  /**
   * Get current state
   */
  const getCurrentState = useCallback((): SceneState | null => {
    return sceneStateManager.getState()
  }, [])

  /**
   * List saved states
   */
  const listSavedStates = useCallback(() => {
    return sceneStateManager.listSavedStates()
  }, [])

  /**
   * Delete saved state
   */
  const deleteSavedState = useCallback((key: string) => {
    sceneStateManager.deleteSavedState(key)
  }, [])

  /**
   * Enable autosave
   */
  const enableAutosave = useCallback(() => {
    sceneStateManager.enableAutosave(autosaveInterval || 30)
    autosaveEnabledRef.current = true
  }, [autosaveInterval])

  /**
   * Disable autosave
   */
  const disableAutosave = useCallback(() => {
    sceneStateManager.disableAutosave()
    autosaveEnabledRef.current = false
  }, [])

  return {
    saveCurrentState,
    saveToStorage,
    saveToFile,
    loadFromStorage,
    loadFromFile,
    getCurrentState,
    listSavedStates,
    deleteSavedState,
    enableAutosave,
    disableAutosave,
  }
}

export default useSceneState
