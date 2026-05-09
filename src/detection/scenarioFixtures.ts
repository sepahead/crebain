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
  }
}

export interface DetectionFusionInputs {
  detections: Map<string, Detection[]>
  cameras: Map<string, CameraParams>
}

const FRAME_WIDTH = 1280
const FRAME_HEIGHT = 720
const TIMESTAMP = 1_700_000_000_000

function camera(id: string, x: number, y: number, yaw: number): CameraParams {
  return {
    id,
    position: new THREE.Vector3(x, y, 12),
    rotation: new THREE.Euler(-0.35, yaw, 0),
    fov: 60,
    aspectRatio: FRAME_WIDTH / FRAME_HEIGHT,
    near: 0.1,
    far: 1000,
  }
}

function detection(id: string, cameraId: string, bbox: [number, number, number, number], confidence: number): Detection {
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
  const cameras = [
    camera('cam-left', -8, 0, 0.18),
    camera('cam-right', 8, 0, -0.18),
  ]

  return {
    name: 'two-camera-drone-approach',
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    cameras,
    detectionsByCamera: {
      'cam-left': [detection('left-drone-1', 'cam-left', [602, 236, 676, 312], 0.91)],
      'cam-right': [detection('right-drone-1', 'cam-right', [594, 238, 668, 314], 0.89)],
    },
    expectedTrack: {
      class: 'drone',
      threatLevel: 2,
      contributingCameras: ['cam-left', 'cam-right'],
      minConfidence: 0.85,
      approximatePosition: [0, 42, 18],
    },
  }
}

export function toFusionInputs(scenario: DetectionFusionScenarioFixture): DetectionFusionInputs {
  return {
    detections: new Map(Object.entries(scenario.detectionsByCamera)),
    cameras: new Map(scenario.cameras.map(camera => [camera.id, camera])),
  }
}
