import { afterEach, describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import {
  hasFiniteMultiCameraTriangulation,
  MAX_BROWSER_FUSION_CAMERAS,
  MAX_BROWSER_FUSION_DETECTIONS,
  MAX_BROWSER_FUSION_GROUPS,
  MAX_BROWSER_FUSION_IMAGE_DIMENSION,
  MAX_BROWSER_FUSION_TRACKS,
  SensorFusion,
} from '../SensorFusion'
import { createDroneApproachScenario, toFusionInputs } from '../scenarioFixtures'
import type { CameraParams, Detection } from '../types'

function makeCameraParams(
  id: string,
  position: THREE.Vector3,
  target: THREE.Vector3,
  fov: number,
  aspectRatio: number
): CameraParams {
  const obj = new THREE.PerspectiveCamera(fov, aspectRatio, 0.1, 1000)
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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('triangulates near the ray intersection for two cameras', () => {
    const target = new THREE.Vector3(0, 0, 0)

    const cam1 = makeCameraParams('cam1', new THREE.Vector3(-1, 0, 5), target, 60, 640 / 480)
    const cam2 = makeCameraParams('cam2', new THREE.Vector3(1, 0, 5), target, 60, 640 / 480)

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
    expect(track.threatLevel).toBe(scenario.expectedTrack.threatLevel)
    expect(track.fusedConfidence).toBeGreaterThanOrEqual(scenario.expectedTrack.minConfidence)
    expect(track.contributingCameras).toEqual(
      expect.arrayContaining(scenario.expectedTrack.contributingCameras)
    )
    expect(track.triangulatedPosition.toArray().every(Number.isFinite)).toBe(true)
    expect(
      track.triangulatedPosition.distanceTo(
        new THREE.Vector3(...scenario.expectedTrack.approximatePosition)
      )
    ).toBeLessThanOrEqual(scenario.expectedTrack.positionTolerance)
    expect(Number.isFinite(track.triangulationError)).toBe(true)
    expect(fusion.getStats()).toMatchObject({
      totalTracks: 1,
      tentativeTracks: 1,
      multiCameraTracks: 1,
      frameCount: 1,
    })
  })

  it('distinguishes finite multi-camera observations from single-camera placeholders', () => {
    const scenario = createDroneApproachScenario()
    const inputs = toFusionInputs(scenario)
    const multiCameraTrack = new SensorFusion({ correlationThreshold: 0.1 }).processFrame(
      inputs.detections,
      inputs.cameras
    )[0]

    const [cameraEntry] = inputs.cameras
    const [detectionEntry] = inputs.detections
    const singleCameraTrack = new SensorFusion({ correlationThreshold: 0.1 }).processFrame(
      new Map([detectionEntry]),
      new Map([cameraEntry])
    )[0]

    expect(hasFiniteMultiCameraTriangulation(multiCameraTrack)).toBe(true)
    expect(singleCameraTrack.triangulationError).toBe(Number.POSITIVE_INFINITY)
    expect(hasFiniteMultiCameraTriangulation(singleCameraTrack)).toBe(false)
  })

  it('keeps parallel-ray range fallback local to visualization', () => {
    const frameWidth = 640
    const frameHeight = 480
    const timestamp = Date.now()
    const cameraA = makeCameraParams(
      'camera-a',
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(-1, 0, -20),
      60,
      4 / 3
    )
    const cameraB = makeCameraParams(
      'camera-b',
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(1, 0, -20),
      60,
      4 / 3
    )
    const detection = (id: string): Detection => ({
      id,
      class: 'drone',
      confidence: 0.9,
      bbox: [310, 230, 330, 250],
      timestamp,
      frameWidth,
      frameHeight,
    })

    const [track] = new SensorFusion({ correlationThreshold: 0.1 }).processFrame(
      new Map([
        ['camera-a', [detection('parallel-a')]],
        ['camera-b', [detection('parallel-b')]],
      ]),
      new Map([
        ['camera-a', cameraA],
        ['camera-b', cameraB],
      ])
    )

    expect(track.contributingCameras).toHaveLength(2)
    expect(track.triangulatedPosition.toArray().every(Number.isFinite)).toBe(true)
    expect(track.triangulationError).toBe(Number.POSITIVE_INFINITY)
    expect(hasFiniteMultiCameraTriangulation(track)).toBe(false)
  })

  it('does not refresh an old triangulation from a single-camera continuation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const inputs = toFusionInputs(createDroneApproachScenario())
    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const first = fusion.processFrame(inputs.detections, inputs.cameras)[0]
    expect(hasFiniteMultiCameraTriangulation(first)).toBe(true)

    vi.setSystemTime(1_700_000_000_100)
    const [cameraId, detections] = inputs.detections.entries().next().value!
    const second = fusion.processFrame(
      new Map([
        [cameraId, detections.map((detection) => ({ ...detection, timestamp: Date.now() }))],
      ]),
      inputs.cameras
    )[0]

    expect(second.id).toBe(first.id)
    expect(second.updatedAt).toBe(Date.now())
    expect(second.contributingCameras.length).toBeGreaterThanOrEqual(2)
    expect(second.triangulationError).toBe(Number.POSITIVE_INFINITY)
    expect(hasFiniteMultiCameraTriangulation(second)).toBe(false)
  })

  it('confirms a continuing multi-camera track across multiple frames', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const scenario = createDroneApproachScenario()
    const inputs = toFusionInputs(scenario)
    const fusion = new SensorFusion({
      correlationThreshold: 0.1,
      minConfirmationFrames: 3,
    })

    const first = fusion.processFrame(inputs.detections, inputs.cameras)[0]
    vi.setSystemTime(1_700_000_000_100)
    const second = fusion.processFrame(inputs.detections, inputs.cameras)[0]
    vi.setSystemTime(1_700_000_000_200)
    const third = fusion.processFrame(inputs.detections, inputs.cameras)[0]

    expect(first.id).toBe(second.id)
    expect(second.id).toBe(third.id)
    expect(third.state).toBe('confirmed')
    expect(third.positionHistory).toHaveLength(3)
    expect(fusion.getStats()).toMatchObject({
      totalTracks: 1,
      confirmedTracks: 1,
      frameCount: 3,
    })
  })

  it('prunes stale tracks after missed frames exceed the configured age', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const scenario = createDroneApproachScenario()
    const inputs = toFusionInputs(scenario)
    const fusion = new SensorFusion({
      correlationThreshold: 0.1,
      maxTrackAge: 100,
      minConfirmationFrames: 2,
    })

    fusion.processFrame(inputs.detections, inputs.cameras)
    vi.setSystemTime(1_700_000_000_050)
    fusion.processFrame(inputs.detections, inputs.cameras)
    vi.setSystemTime(1_700_000_000_075)
    const staleTracks = fusion.processFrame(new Map(), inputs.cameras)
    const staleState = staleTracks[0]?.state
    const staleConfidence = staleTracks[0]?.fusedConfidence
    vi.setSystemTime(1_700_000_000_500)
    const prunedTracks = fusion.processFrame(new Map(), inputs.cameras)

    expect(staleTracks).toHaveLength(1)
    expect(staleState).toBe('confirmed')
    expect(staleConfidence).toBeLessThan(1)
    expect(prunedTracks).toHaveLength(0)
    expect(fusion.getStats()).toMatchObject({
      totalTracks: 0,
      frameCount: 4,
    })
  })
})

describe('SensorFusion browser input envelope', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('bounds the 64-camera/max-detection envelope before dense assignment', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const now = 1_700_000_000_000
    vi.setSystemTime(now)
    const cameras = new Map<string, CameraParams>()
    for (let index = 0; index < MAX_BROWSER_FUSION_CAMERAS; index += 1) {
      cameras.set(
        `camera-${index}`,
        makeCameraParams(
          `camera-${index}`,
          new THREE.Vector3(index, 0, 0),
          new THREE.Vector3(index, 0, 20),
          60,
          4 / 3
        )
      )
    }
    cameras.set(
      'camera-overflow',
      makeCameraParams(
        'camera-overflow',
        new THREE.Vector3(100, 0, 0),
        new THREE.Vector3(100, 0, 20),
        60,
        4 / 3
      )
    )

    const oversized = Array.from(
      { length: MAX_BROWSER_FUSION_DETECTIONS + 88 },
      (_, index): Detection => ({
        id: `detection-${index}`,
        class: 'drone',
        confidence: 0.9,
        bbox: [1, 1, 2, 2],
        timestamp: now,
        threatLevel: 3,
        frameWidth: 640,
        frameHeight: 480,
      })
    )
    const detections = new Map<string, Detection[]>([['camera-0', oversized]])
    for (let index = 1; index < MAX_BROWSER_FUSION_CAMERAS; index += 1) {
      detections.set(`camera-${index}`, [])
    }

    const fusion = new SensorFusion()
    const tracks = fusion.processFrame(detections, cameras, {
      frameId: 'viewer-1:1',
      epoch: 1,
      timestampMs: now,
    })
    const stats = fusion.getStats()

    expect(tracks).toHaveLength(MAX_BROWSER_FUSION_TRACKS)
    expect(MAX_BROWSER_FUSION_TRACKS).toBe(MAX_BROWSER_FUSION_GROUPS)
    expect(stats).toMatchObject({
      totalTracks: MAX_BROWSER_FUSION_TRACKS,
      frameCount: 1,
      lastFrameStatus: 'degraded_capacity',
      lastFrameDroppedDetections: 88,
      lastFrameDroppedGroups: MAX_BROWSER_FUSION_DETECTIONS - MAX_BROWSER_FUSION_GROUPS,
      lastFrameDroppedCameras: 1,
    })
  })

  it('consumes an explicit epoch once and rejects stale/future measurements', () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)
    const camera = makeCameraParams(
      'camera-0',
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 20),
      60,
      4 / 3
    )
    const cameras = new Map<string, CameraParams>([['camera-0', camera]])
    const detection: Detection = {
      id: 'one-observation',
      class: 'drone',
      confidence: 0.9,
      bbox: [1, 1, 2, 2],
      timestamp: now,
    }
    const input = new Map<string, Detection[]>([['camera-0', [detection]]])
    const fusion = new SensorFusion()

    const first = fusion.processFrame(input, cameras, {
      frameId: 'viewer-1:1',
      epoch: 1,
      timestampMs: now,
    })
    expect(fusion.getLastFrameObservedTracks()).toHaveLength(1)
    const replay = fusion.processFrame(input, cameras, {
      frameId: 'viewer-1:1',
      epoch: 1,
      timestampMs: now,
    })
    expect(replay[0].detectionHistory).toHaveLength(1)
    expect(replay[0].updatedAt).toBe(first[0].updatedAt)
    expect(fusion.getLastFrameObservedTracks()).toHaveLength(0)
    expect(fusion.getStats()).toMatchObject({
      frameCount: 1,
      lastFrameStatus: 'rejected_identity',
      lastFrameDroppedDetections: 1,
    })

    fusion.processFrame(input, cameras, {
      frameId: 'viewer-1:2',
      epoch: 2,
      timestampMs: now - 3_001,
    })
    expect(fusion.getStats()).toMatchObject({
      frameCount: 1,
      lastFrameStatus: 'rejected_timestamp',
    })

    fusion.processFrame(
      new Map<string, Detection[]>([
        ['camera-0', [{ ...detection, id: 'stale-observation', timestamp: now - 501 }]],
      ]),
      cameras,
      { frameId: 'viewer-1:3', epoch: 3, timestampMs: now }
    )
    expect(fusion.getStats()).toMatchObject({
      frameCount: 2,
      lastFrameStatus: 'degraded_input',
      lastFrameRejectedDetections: 1,
    })
    expect(fusion.getLastFrameObservedTracks()).toHaveLength(0)

    fusion.processFrame(input, cameras, {
      frameId: 'viewer-1:4',
      epoch: 4,
      timestampMs: now + 251,
    })
    expect(fusion.getStats()).toMatchObject({
      frameCount: 2,
      lastFrameStatus: 'rejected_timestamp',
    })
  })

  it('rejects malformed detections before correlation or track creation', () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)
    const camera = makeCameraParams(
      'camera-0',
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 20),
      60,
      4 / 3
    )
    const valid: Detection = {
      id: 'valid',
      class: 'drone',
      confidence: 0.9,
      bbox: [1, 1, 2, 2],
      timestamp: now,
      frameWidth: 640,
      frameHeight: 480,
    }
    const malformed = [
      { ...valid, id: '' },
      { ...valid, id: 'x'.repeat(257) },
      { ...valid, id: 'bad-class', class: 'vehicle' },
      { ...valid, id: 'nan-confidence', confidence: Number.NaN },
      { ...valid, id: 'negative-confidence', confidence: -0.1 },
      { ...valid, id: 'high-confidence', confidence: 1.1 },
      { ...valid, id: 'nan-bbox', bbox: [Number.NaN, 1, 2, 2] },
      { ...valid, id: 'inverted-bbox', bbox: [2, 1, 1, 2] },
      { ...valid, id: 'outside-frame', bbox: [1, 1, 641, 2] },
      { ...valid, id: 'unsafe-time', timestamp: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, id: 'partial-frame', frameHeight: undefined },
      { ...valid, id: 'zero-frame', frameWidth: 0 },
      {
        ...valid,
        id: 'oversized-frame',
        frameWidth: MAX_BROWSER_FUSION_IMAGE_DIMENSION + 1,
      },
    ] as unknown as Detection[]

    const fusion = new SensorFusion({ correlationThreshold: 0.1 })
    const tracks = fusion.processFrame(
      new Map([['camera-0', malformed]]),
      new Map([['camera-0', camera]]),
      { frameId: 'viewer-1:1', epoch: 1, timestampMs: now }
    )

    expect(tracks).toHaveLength(0)
    expect(fusion.getLastFrameObservedTracks()).toHaveLength(0)
    expect(fusion.getStats()).toMatchObject({
      totalTracks: 0,
      lastFrameStatus: 'degraded_input',
      lastFrameRejectedDetections: malformed.length,
      lastFrameDroppedDetections: 0,
    })
  })

  it('rejects malformed camera geometry before projecting detections', () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)
    const camera = makeCameraParams(
      'camera-0',
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 20),
      60,
      4 / 3
    )
    camera.position.x = Number.NaN
    const detection: Detection = {
      id: 'otherwise-valid',
      class: 'drone',
      confidence: 0.9,
      bbox: [1, 1, 2, 2],
      timestamp: now,
      frameWidth: 640,
      frameHeight: 480,
    }

    const fusion = new SensorFusion()
    const tracks = fusion.processFrame(
      new Map([['camera-0', [detection]]]),
      new Map([['camera-0', camera]]),
      { frameId: 'viewer-1:1', epoch: 1, timestampMs: now }
    )

    expect(tracks).toHaveLength(0)
    expect(fusion.getStats()).toMatchObject({
      totalTracks: 0,
      lastFrameStatus: 'degraded_input',
      lastFrameRejectedCameras: 1,
      lastFrameDroppedDetections: 1,
    })
  })
})
