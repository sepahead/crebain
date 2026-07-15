import { describe, it, expect, vi, afterEach } from 'vitest'
import * as THREE from 'three'
import { SensorFusion } from '../SensorFusion'
import type { CameraParams, Detection } from '../types'

function makeCameraParams(
  id: string,
  position: THREE.Vector3,
  target: THREE.Vector3
): CameraParams {
  const obj = new THREE.PerspectiveCamera(60, 640 / 480, 0.1, 1000)
  obj.position.copy(position)
  obj.lookAt(target)
  return {
    id,
    position: position.clone(),
    rotation: obj.rotation.clone(),
    fov: 60,
    aspectRatio: 640 / 480,
    near: 0.1,
    far: 1000,
  }
}

const FW = 640
const FH = 480
function centeredDetection(id: string, confidence = 0.9, withFrameDims = true): Detection {
  const cx = FW / 2
  const cy = FH / 2
  return {
    id,
    class: 'drone',
    confidence,
    bbox: [cx - 10, cy - 10, cx + 10, cy + 10],
    timestamp: 1_700_000_000_000,
    threatLevel: 3,
    ...(withFrameDims ? { frameWidth: FW, frameHeight: FH } : {}),
  }
}

// Inverse of rayFromDetection: the centered bbox whose ray points at `p` from `cam`.
function bboxForPoint(cam: CameraParams, p: THREE.Vector3): [number, number, number, number] {
  const dirWorld = p.clone().sub(cam.position).normalize()
  const q = new THREE.Quaternion().setFromEuler(cam.rotation)
  const dirCam = dirWorld.clone().applyQuaternion(q.clone().invert())
  const tan = Math.tan((cam.fov * Math.PI) / 360)
  const ndcX = dirCam.x / -dirCam.z / (tan * cam.aspectRatio)
  const ndcY = dirCam.y / -dirCam.z / tan
  const cx = ((ndcX + 1) / 2) * FW
  const cy = ((1 - ndcY) / 2) * FH
  return [cx - 10, cy - 10, cx + 10, cy + 10]
}

function movingDroneDetection(
  id: string,
  cam: CameraParams,
  p: THREE.Vector3,
  ts: number
): Detection {
  return {
    id,
    class: 'drone',
    confidence: 0.9,
    bbox: bboxForPoint(cam, p),
    timestamp: ts,
    threatLevel: 3,
    frameWidth: FW,
    frameHeight: FH,
  }
}

describe('SensorFusion cross-camera geometric gate (#8)', () => {
  it('does not triangulate a phantom from non-intersecting rays', () => {
    // Two parallel cameras 12 m apart with centered detections: the back-projected
    // rays run ~12 m apart, so the closest-approach gate (DEFAULT_RAY_GATE_DISTANCE_M
    // = 3) rejects the correspondence. The two detections must NOT be triangulated
    // together into one phantom 3-D point — observable as the absence of any valid
    // two-camera triangulation (triangulationError stays non-finite). Without the
    // gate they would correlate and produce a finite (phantom) triangulation.
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10))
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(12, 0, 0), new THREE.Vector3(12, 0, 10))
    const detections = new Map<string, Detection[]>([
      ['cam1', [centeredDetection('d1', 0.9)]],
      ['cam2', [centeredDetection('d2', 0.9)]],
    ])
    const cameras = new Map<string, CameraParams>([
      ['cam1', cam1],
      ['cam2', cam2],
    ])
    const fusion = new SensorFusion()
    const tracks = fusion.processFrame(detections, cameras)
    for (const t of tracks) {
      expect(Number.isFinite(t.triangulationError)).toBe(false)
    }
  })

  it('merges two cameras that intersect on one target', () => {
    // Converging cameras both looking at the origin with centered detections — the
    // rays nearly intersect (distance ≈ 0 < 3) and meet in front of both cameras, so
    // the gate accepts the correspondence and produces ONE fused track.
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-1, 0, 5), new THREE.Vector3(0, 0, 0))
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(1, 0, 5), new THREE.Vector3(0, 0, 0))
    const detections = new Map<string, Detection[]>([
      ['cam1', [centeredDetection('d1')]],
      ['cam2', [centeredDetection('d2')]],
    ])
    const cameras = new Map<string, CameraParams>([
      ['cam1', cam1],
      ['cam2', cam2],
    ])
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const tracks = fusion.processFrame(detections, cameras)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].contributingCameras.sort()).toEqual(['cam1', 'cam2'])
  })

  it('rejects a non-transitive three-camera correspondence', () => {
    // A intersects B at z=-10 and C at z=-100, but the B/C rays remain more
    // than the 3 m correlation gate apart. Seed-only correlation would merge all
    // three and promote a finite least-squares point unsupported by one ray pair.
    const cameraA = makeCameraParams(
      'camera-a',
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -10)
    )
    const cameraB = makeCameraParams(
      'camera-b',
      new THREE.Vector3(5, 0, 0),
      new THREE.Vector3(0, 0, -10)
    )
    const cameraC = makeCameraParams(
      'camera-c',
      new THREE.Vector3(0, 5, 0),
      new THREE.Vector3(0, 0, -100)
    )
    const tracks = new SensorFusion({ correlationThreshold: 0.1 }).processFrame(
      new Map<string, Detection[]>([
        ['camera-a', [centeredDetection('a')]],
        ['camera-b', [centeredDetection('b')]],
        ['camera-c', [centeredDetection('c')]],
      ]),
      new Map<string, CameraParams>([
        ['camera-a', cameraA],
        ['camera-b', cameraB],
        ['camera-c', cameraC],
      ])
    )

    expect(tracks).toHaveLength(2)
    expect(tracks.some((track) => track.contributingCameras.length === 3)).toBe(false)
    expect(
      tracks.some(
        (track) =>
          track.contributingCameras.includes('camera-a') &&
          track.contributingCameras.includes('camera-b')
      )
    ).toBe(true)
  })

  it('rejects a triangulation beyond both cameras far planes', () => {
    const cameraA = makeCameraParams(
      'camera-a',
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -7_000)
    )
    const cameraB = makeCameraParams(
      'camera-b',
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -7_000)
    )
    const tracks = new SensorFusion({ correlationThreshold: 0.1 }).processFrame(
      new Map<string, Detection[]>([
        ['camera-a', [centeredDetection('a')]],
        ['camera-b', [centeredDetection('b')]],
      ]),
      new Map<string, CameraParams>([
        ['camera-a', cameraA],
        ['camera-b', cameraB],
      ])
    )

    expect(tracks).toHaveLength(2)
    expect(tracks.every((track) => !Number.isFinite(track.triangulationError))).toBe(true)
  })

  it('rejects an intersection behind both cameras', () => {
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-1, 0, 5), new THREE.Vector3(-2, 0, 10))
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(1, 0, 5), new THREE.Vector3(2, 0, 10))
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const tracks = fusion.processFrame(
      new Map<string, Detection[]>([
        ['cam1', [centeredDetection('d1')]],
        ['cam2', [centeredDetection('d2')]],
      ]),
      new Map<string, CameraParams>([
        ['cam1', cam1],
        ['cam2', cam2],
      ])
    )

    expect(tracks).toHaveLength(2)
    expect(tracks.every((track) => track.contributingCameras.length === 1)).toBe(true)
  })

  it('keeps equal detector IDs distinct across camera namespaces', () => {
    const target = new THREE.Vector3(0, 0, 20)
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-2, 0, 0), target)
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(2, 0, 0), target)
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const tracks = fusion.processFrame(
      new Map<string, Detection[]>([
        ['cam1', [movingDroneDetection('shared-id', cam1, target, 1)]],
        ['cam2', [movingDroneDetection('shared-id', cam2, target, 1)]],
      ]),
      new Map<string, CameraParams>([
        ['cam1', cam1],
        ['cam2', cam2],
      ])
    )

    expect(tracks).toHaveLength(1)
    expect(tracks[0].contributingCameras.sort()).toEqual(['cam1', 'cam2'])
  })

  it('falls back to class/temporal correlation when frame dims are missing', () => {
    // Without frameWidth/frameHeight the rays would collapse to the camera forward
    // axis, so the geometric gate is skipped and legacy class+temporal correlation
    // applies. Both cameras look at the origin, so the forward rays still intersect
    // → one track (legacy behavior preserved).
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-1, 0, 5), new THREE.Vector3(0, 0, 0))
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(1, 0, 5), new THREE.Vector3(0, 0, 0))
    const detections = new Map<string, Detection[]>([
      ['cam1', [centeredDetection('d1', 0.9, false)]],
      ['cam2', [centeredDetection('d2', 0.9, false)]],
    ])
    const cameras = new Map<string, CameraParams>([
      ['cam1', cam1],
      ['cam2', cam2],
    ])
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const tracks = fusion.processFrame(detections, cameras)
    expect(tracks).toHaveLength(1)
  })

  it('creates a distinct track for a far same-class target on other cameras', () => {
    const c1 = makeCameraParams('cam1', new THREE.Vector3(-3, 0, 0), new THREE.Vector3(0, 0, 30))
    const c2 = makeCameraParams('cam2', new THREE.Vector3(3, 0, 0), new THREE.Vector3(0, 0, 30))
    const c3 = makeCameraParams('cam3', new THREE.Vector3(-3, 5, 0), new THREE.Vector3(0, 5, 60))
    const c4 = makeCameraParams('cam4', new THREE.Vector3(3, 5, 0), new THREE.Vector3(0, 5, 60))
    const cameras = new Map<string, CameraParams>([
      ['cam1', c1],
      ['cam2', c2],
      ['cam3', c3],
      ['cam4', c4],
    ])
    const fusion = new SensorFusion() // default correlationThreshold = 0.5
    const p1 = new THREE.Vector3(0, 0, 30)
    const firstTrack = fusion.processFrame(
      new Map<string, Detection[]>([
        ['cam1', [movingDroneDetection('a1', c1, p1, 1)]],
        ['cam2', [movingDroneDetection('a2', c2, p1, 1)]],
      ]),
      cameras
    )[0]
    // Re-detection from cam3/cam4 (no shared cameras), >15 m away.
    const p2 = new THREE.Vector3(0, 5, 60)
    const tracks = fusion.processFrame(
      new Map<string, Detection[]>([
        ['cam3', [movingDroneDetection('b1', c3, p2, 2)]],
        ['cam4', [movingDroneDetection('b2', c4, p2, 2)]],
      ]),
      cameras
    )
    expect(tracks).toHaveLength(2)
    expect(tracks.some((track) => track.id === firstTrack.id)).toBe(true)
    expect(tracks.some((track) => track.id !== firstTrack.id)).toBe(true)
  })

  it('updates an existing track at most once when two groups compete for it', () => {
    const target = new THREE.Vector3(0, 0, 20)
    const camera = makeCameraParams('cam1', new THREE.Vector3(0, 0, 0), target)
    const cameras = new Map<string, CameraParams>([['cam1', camera]])
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })

    fusion.processFrame(
      new Map<string, Detection[]>([['cam1', [movingDroneDetection('seed', camera, target, 1)]]]),
      cameras
    )
    const tracks = fusion.processFrame(
      new Map<string, Detection[]>([
        [
          'cam1',
          [
            movingDroneDetection('left', camera, new THREE.Vector3(-1, 0, 20), 2),
            movingDroneDetection('right', camera, new THREE.Vector3(1, 0, 20), 2),
          ],
        ],
      ]),
      cameras
    )

    expect(tracks).toHaveLength(2)
    expect(tracks.map((track) => track.detectionHistory.length).sort()).toEqual([1, 2])
  })

  it('keeps two crossing browser tracks one-to-one without claiming native identity parity', () => {
    const center = new THREE.Vector3(0, 0, 30)
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-6, 0, 0), center)
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(6, 0, 0), center)
    const cameras = new Map<string, CameraParams>([
      ['cam1', cam1],
      ['cam2', cam2],
    ])
    const fusion = new SensorFusion({ positionSmoothing: 1 })
    const frames = [
      [new THREE.Vector3(-4, 0, 30), new THREE.Vector3(4, 0, 30)],
      [new THREE.Vector3(-1, 0, 30), new THREE.Vector3(1, 0, 30)],
      [new THREE.Vector3(2, 0, 30), new THREE.Vector3(-2, 0, 30)],
    ]

    frames.forEach(([a, b], frameIndex) => {
      const timestamp = frameIndex + 1
      const tracks = fusion.processFrame(
        new Map<string, Detection[]>([
          [
            'cam1',
            [
              movingDroneDetection(`a-left-${frameIndex}`, cam1, a, timestamp),
              movingDroneDetection(`b-left-${frameIndex}`, cam1, b, timestamp),
            ],
          ],
          [
            'cam2',
            [
              movingDroneDetection(`a-right-${frameIndex}`, cam2, a, timestamp),
              movingDroneDetection(`b-right-${frameIndex}`, cam2, b, timestamp),
            ],
          ],
        ]),
        cameras
      )

      expect(tracks).toHaveLength(2)
      expect(new Set(tracks.map((track) => track.id))).toHaveProperty('size', 2)
      expect(tracks.every((track) => track.detectionHistory.length === frameIndex + 1)).toBe(true)
    })
  })
})

describe('SensorFusion coasting velocity-spike regression (#2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not inflate velocity on re-acquisition after coasting', () => {
    vi.useFakeTimers()
    const lookAt = new THREE.Vector3(0, 0, 20)
    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-3, 0, 0), lookAt)
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(3, 0, 0), lookAt)
    const cameras = new Map<string, CameraParams>([
      ['cam1', cam1],
      ['cam2', cam2],
    ])
    // No smoothing → velocity is the raw frame-to-frame estimate; generous track age
    // so the coasting frames don't prune the track.
    const fusion = new SensorFusion({
      positionSmoothing: 1,
      velocitySmoothing: 1,
      maxTrackAge: 10_000,
      correlationThreshold: 0.1,
    })

    const t0 = 1_700_000_000_000
    const frame = (p: THREE.Vector3, atMs: number) => {
      vi.setSystemTime(t0 + atMs)
      fusion.processFrame(
        new Map<string, Detection[]>([
          ['cam1', [movingDroneDetection('l', cam1, p, t0 + atMs)]],
          ['cam2', [movingDroneDetection('r', cam2, p, t0 + atMs)]],
        ]),
        cameras
      )
    }

    // 3 detected frames: target moving +x at ~2 m/s (dt = 100 ms).
    frame(new THREE.Vector3(0.0, 0, 20), 0)
    frame(new THREE.Vector3(0.2, 0, 20), 100)
    frame(new THREE.Vector3(0.4, 0, 20), 200)

    // 2 coasting frames (no detections).
    vi.setSystemTime(t0 + 300)
    fusion.processFrame(new Map(), cameras)
    vi.setSystemTime(t0 + 400)
    fusion.processFrame(new Map(), cameras)

    // Re-acquire at the true continued position (x = 1.0 at t = 0.5 s).
    vi.setSystemTime(t0 + 500)
    const tracks = fusion.processFrame(
      new Map<string, Detection[]>([
        ['cam1', [movingDroneDetection('l2', cam1, new THREE.Vector3(1.0, 0, 20), t0 + 500)]],
        ['cam2', [movingDroneDetection('r2', cam2, new THREE.Vector3(1.0, 0, 20), t0 + 500)]],
      ]),
      cameras
    )

    expect(tracks).toHaveLength(1)
    // True speed ≈ 2 m/s. Without the coasting fix the re-acquisition velocity would
    // spike to ~6 m/s (a multi-frame displacement over a single-frame dt); the fix
    // records the coasted positions so the estimate stays near the true speed.
    expect(tracks[0].velocity.x).toBeGreaterThan(0.5)
    expect(tracks[0].velocity.x).toBeLessThan(4)
  })
})
