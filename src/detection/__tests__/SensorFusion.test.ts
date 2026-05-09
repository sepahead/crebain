import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { SensorFusion } from '../SensorFusion'
import { createDroneApproachScenario, toFusionInputs } from '../scenarioFixtures'
import type { CameraParams, Detection } from '../types'

function makeCameraParams(
  id: string,
  position: THREE.Vector3,
  target: THREE.Vector3,
  fov: number,
  aspectRatio: number
): CameraParams {
  const obj = new THREE.Object3D()
  obj.position.copy(position)
  obj.lookAt(target)

  return {
    id,
    position: position.clone(),
    rotation: obj.rotation.clone(),
    fov,
    aspectRatio,
    near: 0.1,
    far: 1000,
  }
}

describe('SensorFusion triangulation', () => {
  it('triangulates near the ray intersection for two cameras', () => {
    const target = new THREE.Vector3(0, 0, 0)

    const cam1 = makeCameraParams(
      'cam1',
      new THREE.Vector3(-1, 0, 5),
      target,
      60,
      640 / 480
    )
    const cam2 = makeCameraParams(
      'cam2',
      new THREE.Vector3(1, 0, 5),
      target,
      60,
      640 / 480
    )

    const frameWidth = 640
    const frameHeight = 480
    const cx = frameWidth / 2
    const cy = frameHeight / 2
    const timestamp = Date.now()

    const det1: Detection = {
      id: 'd1',
      class: 'drone',
      confidence: 0.9,
      bbox: [cx - 10, cy - 10, cx + 10, cy + 10],
      timestamp,
      threatLevel: 3,
      frameWidth,
      frameHeight,
    }

    const det2: Detection = {
      id: 'd2',
      class: 'drone',
      confidence: 0.92,
      bbox: [cx - 8, cy - 8, cx + 8, cy + 8],
      timestamp,
      threatLevel: 3,
      frameWidth,
      frameHeight,
    }

    const detections = new Map<string, Detection[]>()
    detections.set('cam1', [det1])
    detections.set('cam2', [det2])

    const cameras = new Map<string, CameraParams>()
    cameras.set('cam1', cam1)
    cameras.set('cam2', cam2)

    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const tracks = fusion.processFrame(detections, cameras)

    expect(tracks).toHaveLength(1)
    expect(tracks[0].triangulatedPosition.distanceTo(target)).toBeLessThan(1e-3)
    expect(tracks[0].triangulationError).toBeLessThan(1e-3)
  })

  it('processes the drone approach scenario fixture into one fused track', () => {
    const scenario = createDroneApproachScenario()
    const inputs = toFusionInputs(scenario)
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })

    const tracks = fusion.processFrame(inputs.detections, inputs.cameras)
    const [track] = tracks

    expect(tracks).toHaveLength(1)
    expect(track.class).toBe(scenario.expectedTrack.class)
    expect(track.fusedConfidence).toBeGreaterThanOrEqual(scenario.expectedTrack.minConfidence)
    expect(track.contributingCameras).toEqual(expect.arrayContaining(scenario.expectedTrack.contributingCameras))
    expect(track.triangulatedPosition.toArray().every(Number.isFinite)).toBe(true)
    expect(Number.isFinite(track.triangulationError)).toBe(true)
    expect(fusion.getStats()).toMatchObject({
      totalTracks: 1,
      tentativeTracks: 1,
      multiCameraTracks: 1,
      frameCount: 1,
    })
  })
})

