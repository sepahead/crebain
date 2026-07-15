import * as THREE from 'three'
import type { CameraParams, Detection, FusedTrack } from './types'

export interface DetectionFusionScenarioFixture {
  name: string
  frameWidth: number
  frameHeight: number
  cameras: CameraParams[]
  detectionsByCamera: Record<string, Detection[]>
  expectedTrack: Pick<FusedTrack, 'class' | 'threatLevel' | 'contributingCameras'> & {
    minConfidence: number
    approximatePosition: [number, number, number]
    positionTolerance: number
  }
}

export interface DetectionFusionInputs {
  detections: Map<string, Detection[]>
  cameras: Map<string, CameraParams>
}

const FRAME_WIDTH = 1280
const FRAME_HEIGHT = 720
const TIMESTAMP = 1_700_000_000_000

function camera(id: string, position: THREE.Vector3, target: THREE.Vector3): CameraParams {
  const camera = new THREE.PerspectiveCamera(60, FRAME_WIDTH / FRAME_HEIGHT, 0.1, 1000)
  camera.position.copy(position)
  camera.lookAt(target)

  return {
    id,
    position: position.clone(),
    rotation: camera.rotation.clone(),
    fov: 60,
    aspectRatio: FRAME_WIDTH / FRAME_HEIGHT,
    near: 0.1,
    far: 1000,
  }
}

function detection(
  id: string,
  cameraId: string,
  bbox: [number, number, number, number],
  confidence: number
): Detection {
  return {
    id,
    class: 'drone',
    confidence,
    bbox,
    timestamp: TIMESTAMP,
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    sensorSources: [cameraId],
    threatLevel: 2,
  }
}

export function createDroneApproachScenario(): DetectionFusionScenarioFixture {
  const target = new THREE.Vector3(0, 10, 57)
  const cameras = [
    camera('cam-left', new THREE.Vector3(-8, 0, 12), target),
    camera('cam-right', new THREE.Vector3(8, 0, 12), target),
  ]

  return {
    name: 'two-camera-drone-approach',
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    cameras,
    detectionsByCamera: {
      'cam-left': [detection('left-drone-1', 'cam-left', [603, 323, 677, 397], 0.91)],
      'cam-right': [detection('right-drone-1', 'cam-right', [603, 323, 677, 397], 0.89)],
    },
    expectedTrack: {
      class: 'drone',
      threatLevel: 4,
      contributingCameras: ['cam-left', 'cam-right'],
      minConfidence: 0.85,
      approximatePosition: [0, 10, 57],
      positionTolerance: 0.5,
    },
  }
}

export function toFusionInputs(scenario: DetectionFusionScenarioFixture): DetectionFusionInputs {
  return {
    detections: new Map(Object.entries(scenario.detectionsByCamera)),
    cameras: new Map(scenario.cameras.map((camera) => [camera.id, camera])),
  }
}
