import type * as THREE from 'three'
import { attachObject3DToScene, disposeObject3D } from '../../lib/three/sceneObjects'

export interface FloorCleanupFailure {
  phase: 'attach-candidate' | 'detach-previous' | 'dispose-previous'
  error: unknown
}

function disposeDetachedFloor(mesh: THREE.Mesh, errors: unknown[], label: string): void {
  if (mesh.parent !== null) {
    errors.push(new Error(`${label} remains attached and cannot be disposed safely`))
    return
  }
  try {
    disposeObject3D(mesh)
  } catch (error) {
    errors.push(error)
  }
}

function rollBackFloorCandidate(
  scene: THREE.Scene,
  candidate: THREE.Mesh,
  errors: unknown[],
  message: string,
  cause: unknown
): never {
  try {
    scene.remove(candidate)
  } catch (cleanupError) {
    errors.push(cleanupError)
  }
  disposeDetachedFloor(candidate, errors, 'Floor candidate')
  throw new AggregateError(errors, message, { cause })
}

/**
 * Admit a replacement floor before releasing the previous floor.
 *
 * A failed admission rolls the candidate back and keeps the previous floor
 * owned by the scene. Cleanup of an admitted replacement is best-effort and
 * reported to the caller because the new floor is already the live owner.
 */
export function activateFloorMesh(
  scene: THREE.Scene,
  previous: THREE.Mesh | null,
  candidate: THREE.Mesh
): FloorCleanupFailure[] {
  const attachment = attachObject3DToScene(scene, candidate, 'floor candidate')
  if (!attachment.attached) {
    rollBackFloorCandidate(
      scene,
      candidate,
      [...attachment.errors],
      'Floor admission and candidate cleanup failed',
      attachment.errors[0]
    )
  }

  const failures: FloorCleanupFailure[] = attachment.errors.map((error) => ({
    phase: 'attach-candidate',
    error,
  }))
  if (!previous || previous === candidate) return failures

  try {
    scene.remove(previous)
  } catch (error) {
    if (previous.parent !== null) {
      rollBackFloorCandidate(
        scene,
        candidate,
        [...attachment.errors, error],
        'Floor replacement rolled back because the previous floor stayed attached',
        error
      )
    }
    failures.push({ phase: 'detach-previous', error })
  }
  if (previous.parent !== null) {
    const error = new Error('Previous floor remains attached and cannot be disposed safely')
    rollBackFloorCandidate(
      scene,
      candidate,
      [...attachment.errors, error],
      'Floor replacement rolled back because the previous floor stayed attached',
      error
    )
  } else {
    try {
      disposeObject3D(previous)
    } catch (error) {
      failures.push({ phase: 'dispose-previous', error })
    }
  }
  return failures
}
