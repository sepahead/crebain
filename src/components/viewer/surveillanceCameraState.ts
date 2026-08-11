import * as THREE from 'three'

import { disposeObject3D } from '../../lib/three/sceneObjects'
import {
  MAX_SURVEILLANCE_CAMERA_FOV_DEGREES,
  MAX_SURVEILLANCE_CAMERA_PAN_DEGREES,
  MAX_SURVEILLANCE_CAMERA_TILT_DEGREES,
  MIN_SURVEILLANCE_CAMERA_FOV_DEGREES,
  MIN_SURVEILLANCE_CAMERA_PAN_DEGREES,
  MIN_SURVEILLANCE_CAMERA_TILT_DEGREES,
} from '../../lib/surveillanceCameraLimits'
import type { SurveillanceCamera } from './types'

export interface SurveillanceCameraStore {
  current: SurveillanceCamera[]
}

export type CommitSurveillanceCameras = (cameras: SurveillanceCamera[]) => void

export interface DetachedSurveillanceCameraSnapshot {
  cameras: SurveillanceCamera[]
  errors: unknown[]
}

export interface RestoredSurveillanceCameraSnapshot {
  /** Cameras with at least one resource still owned by a scene graph. */
  restored: SurveillanceCamera[]
  /** Cameras whose resources remain fully detached and owned by the caller. */
  retained: SurveillanceCamera[]
  errors: unknown[]
}

/**
 * Apply one PTZ event from the synchronous camera snapshot, then commit a
 * precomputed array. React may replay renders and state processing in
 * development, so Three.js mutation must never live inside a state updater.
 */
export function updateSurveillanceCameraPtz(
  store: SurveillanceCameraStore,
  commit: CommitSurveillanceCameras,
  cameraId: string,
  pan?: number,
  tilt?: number,
  zoom?: number
): boolean {
  const current = store.current
  const cameraIndex = current.findIndex((camera) => camera.id === cameraId)
  if (cameraIndex < 0) return false
  if ([pan, tilt, zoom].some((value) => value !== undefined && !Number.isFinite(value))) {
    return false
  }

  const camera = current[cameraIndex]
  const nextPan =
    pan === undefined
      ? camera.pan
      : THREE.MathUtils.clamp(
          pan,
          MIN_SURVEILLANCE_CAMERA_PAN_DEGREES,
          MAX_SURVEILLANCE_CAMERA_PAN_DEGREES
        )
  const nextTilt =
    tilt === undefined
      ? camera.tilt
      : THREE.MathUtils.clamp(
          tilt,
          MIN_SURVEILLANCE_CAMERA_TILT_DEGREES,
          MAX_SURVEILLANCE_CAMERA_TILT_DEGREES
        )
  const nextZoom =
    zoom === undefined
      ? camera.zoom
      : THREE.MathUtils.clamp(
          zoom,
          MIN_SURVEILLANCE_CAMERA_FOV_DEGREES,
          MAX_SURVEILLANCE_CAMERA_FOV_DEGREES
        )
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(-nextTilt),
    THREE.MathUtils.degToRad(nextPan),
    0,
    'YXZ'
  )

  camera.camera.quaternion.setFromEuler(euler)
  camera.camera.fov = nextZoom
  camera.camera.updateProjectionMatrix()
  camera.mesh.quaternion.copy(camera.camera.quaternion)

  const next = current.slice()
  next[cameraIndex] = {
    ...camera,
    pan: nextPan,
    tilt: nextTilt,
    zoom: nextZoom,
  }
  store.current = next
  commit(next)
  return true
}

export function disposeSurveillanceCamera(
  scene: THREE.Scene | null,
  camera: SurveillanceCamera
): void {
  const errors: unknown[] = []
  const attempt = (operation: () => void) => {
    try {
      operation()
    } catch (error) {
      errors.push(error)
    }
  }
  attempt(() => scene?.remove(camera.helper))
  attempt(() => scene?.remove(camera.mesh))
  const attachedResources = [camera.helper, camera.mesh].filter((object) => object.parent !== null)
  if (attachedResources.length > 0) {
    errors.push(
      new Error(
        `Camera ${camera.id} still has ${attachedResources.length} attached scene object(s)`
      )
    )
  } else {
    attempt(() => camera.helper.dispose())
    attempt(() => camera.renderTarget.dispose())
    attempt(() => disposeObject3D(camera.mesh))
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to fully dispose surveillance camera ${camera.id}`)
  }
}

/**
 * Remove one complete camera snapshot from the live scene without disposing it.
 * The returned resources remain owned by the caller until it restores or
 * disposes the snapshot.
 */
export function detachAllSurveillanceCameras(
  scene: THREE.Scene | null,
  store: SurveillanceCameraStore,
  commit?: CommitSurveillanceCameras
): DetachedSurveillanceCameraSnapshot {
  const current = store.current
  if (current.length === 0) return { cameras: current, errors: [] }

  const next: SurveillanceCamera[] = []
  store.current = next
  const errors: unknown[] = []
  try {
    commit?.(next)
  } catch (error) {
    errors.push(error)
  }
  current.forEach((camera) => {
    try {
      scene?.remove(camera.helper)
    } catch (error) {
      errors.push(error)
    }
    try {
      scene?.remove(camera.mesh)
    } catch (error) {
      errors.push(error)
    }
    if (camera.helper.parent !== null || camera.mesh.parent !== null) {
      errors.push(new Error(`Camera ${camera.id} did not detach from its scene graph`))
    }
  })
  return { cameras: current, errors }
}

/** Restore one previously detached snapshot into an empty camera store. */
export function restoreDetachedSurveillanceCameras(
  scene: THREE.Scene | null,
  store: SurveillanceCameraStore,
  cameras: SurveillanceCamera[],
  commit?: CommitSurveillanceCameras
): RestoredSurveillanceCameraSnapshot {
  if (store.current.length !== 0) {
    throw new Error('Cannot restore cameras into a non-empty camera store')
  }
  // Publish provisional ownership before Three.js events run. Reentrant code
  // must not start a second restoration while an `added` listener is active.
  store.current = cameras
  const errors: unknown[] = []
  const restored: SurveillanceCamera[] = []
  const retained: SurveillanceCamera[] = []
  cameras.forEach((camera) => {
    try {
      scene?.add(camera.helper)
    } catch (error) {
      errors.push(error)
    }
    try {
      scene?.add(camera.mesh)
    } catch (error) {
      errors.push(error)
    }

    // Three.js mutates `parent` before it dispatches `added`. A thrown listener
    // does not imply that the resource remained detached. Keep every camera
    // with an attached resource in the live registry. Only a fully detached
    // camera can remain in the caller-owned snapshot for final disposal.
    if (camera.helper.parent !== null || camera.mesh.parent !== null) {
      restored.push(camera)
    } else {
      retained.push(camera)
      if (scene !== null) {
        errors.push(new Error(`Camera ${camera.id} did not attach to the live scene graph`))
      }
    }
  })
  const committedRestored = retained.length === 0 ? cameras : restored
  store.current = committedRestored
  try {
    commit?.(committedRestored)
  } catch (error) {
    errors.push(error)
  }
  return { restored: committedRestored, retained, errors }
}

/**
 * Tombstone an entire snapshot before disposing any member. Three.js removal
 * and disposal hooks are synchronous, so reentrant single-camera or bulk
 * removal must observe an empty store instead of the resources being retired.
 */
export function disposeAllSurveillanceCamerasOnce(
  scene: THREE.Scene | null,
  store: SurveillanceCameraStore,
  commit?: CommitSurveillanceCameras
): SurveillanceCamera[] {
  const current = store.current
  if (current.length === 0) return current

  const next: SurveillanceCamera[] = []
  store.current = next
  const errors: unknown[] = []
  try {
    commit?.(next)
  } catch (error) {
    errors.push(error)
  }
  const retained: SurveillanceCamera[] = []
  current.forEach((camera) => {
    try {
      disposeSurveillanceCamera(scene, camera)
    } catch (error) {
      errors.push(error)
    }
    if (camera.helper.parent !== null || camera.mesh.parent !== null) {
      retained.push(camera)
    }
  })
  if (retained.length > 0) {
    // Removal failed before the graph released every resource. Restore native
    // ownership after the reentrant disposal window closes so attached camera
    // objects never become untracked.
    store.current = retained
    try {
      commit?.(retained)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to fully dispose all surveillance cameras')
  }
  return current
}

/**
 * Remove and dispose one exact snapshot member. A repeated event observes the
 * already-updated store and therefore cannot dispose or announce it twice.
 */
export function removeSurveillanceCameraOnce(
  scene: THREE.Scene | null,
  store: SurveillanceCameraStore,
  commit: CommitSurveillanceCameras,
  cameraId: string,
  onRemoved: (camera: SurveillanceCamera) => void
): SurveillanceCamera | null {
  const current = store.current
  const camera = current.find((candidate) => candidate.id === cameraId)
  if (!camera) return null

  const next = current.filter((candidate) => candidate.id !== cameraId)
  // Publish the tombstone before any Three.js hook can run. Scene removal and
  // resource disposal may dispatch synchronous user hooks; a reentrant remove
  // must observe absence instead of disposing the same resources twice.
  store.current = next
  const errors: unknown[] = []
  try {
    commit(next)
  } catch (error) {
    errors.push(error)
  }
  try {
    disposeSurveillanceCamera(scene, camera)
  } catch (error) {
    errors.push(error)
  }
  const remainsAttached = camera.helper.parent !== null || camera.mesh.parent !== null
  if (remainsAttached) {
    const restored = next.slice()
    restored.splice(current.indexOf(camera), 0, camera)
    store.current = restored
    try {
      commit(restored)
    } catch (error) {
      errors.push(error)
    }
  } else {
    try {
      onRemoved(camera)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to fully remove surveillance camera ${camera.id}`)
  }
  return camera
}
