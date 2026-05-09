import { describe, expect, it } from 'vitest'
import { createDroneApproachScenario } from '../scenarioFixtures'

describe('scenarioFixtures', () => {
  it('creates a coherent two-camera drone approach fixture', () => {
    const scenario = createDroneApproachScenario()
    const cameraIds = scenario.cameras.map(camera => camera.id)

    expect(scenario.name).toBe('two-camera-drone-approach')
    expect(scenario.frameWidth).toBe(1280)
    expect(scenario.frameHeight).toBe(720)
    expect(cameraIds).toEqual(['cam-left', 'cam-right'])
    expect(Object.keys(scenario.detectionsByCamera).sort()).toEqual([...cameraIds].sort())
    expect(scenario.expectedTrack.contributingCameras.sort()).toEqual([...cameraIds].sort())
  })

  it('keeps fixture detections inside frame bounds', () => {
    const scenario = createDroneApproachScenario()
    const detections = Object.values(scenario.detectionsByCamera).flat()

    expect(detections.length).toBe(2)
    for (const detection of detections) {
      const [x1, y1, x2, y2] = detection.bbox
      expect(detection.class).toBe(scenario.expectedTrack.class)
      expect(detection.confidence).toBeGreaterThanOrEqual(scenario.expectedTrack.minConfidence)
      expect(detection.frameWidth).toBe(scenario.frameWidth)
      expect(detection.frameHeight).toBe(scenario.frameHeight)
      expect(x1).toBeGreaterThanOrEqual(0)
      expect(y1).toBeGreaterThanOrEqual(0)
      expect(x2).toBeLessThanOrEqual(scenario.frameWidth)
      expect(y2).toBeLessThanOrEqual(scenario.frameHeight)
      expect(x2).toBeGreaterThan(x1)
      expect(y2).toBeGreaterThan(y1)
      expect(scenario.expectedTrack.contributingCameras).toContain(detection.sensorSources?.[0])
    }
  })
})
