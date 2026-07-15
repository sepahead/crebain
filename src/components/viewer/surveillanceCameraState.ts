import * as THREE from 'three'

import { disposeObject3D } from '../../lib/three/sceneObjects'
import type { SurveillanceCamera } from './types'

export interface SurveillanceCameraStore {
  current: SurveillanceCamera[]
}

export type CommitSurveillanceCameras = (cameras: SurveillanceCamera[]) => void

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

  const camera = current[cameraIndex]
  const nextPan = pan ?? camera.pan
  const nextTilt = tilt === undefined ? camera.tilt : THREE.MathUtils.clamp(tilt, -85, 85)
  const nextZoom = zoom === undefined ? camera.zoom : THREE.MathUtils.clamp(zoom, 5, 120)
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
  scene?.remove(camera.helper)
  camera.helper.dispose()
  scene?.remove(camera.mesh)
  camera.renderTarget.dispose()
  disposeObject3D(camera.mesh)
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
  commit?.(next)
  current.forEach((camera) => disposeSurveillanceCamera(scene, camera))
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
  commit(next)
  disposeSurveillanceCamera(scene, camera)
  onRemoved(camera)
  return camera
}
