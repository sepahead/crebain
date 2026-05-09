import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROS_SENSOR_CONFIG,
  acousticToMeasurement,
  clampFusionRateHz,
  lidarToMeasurement,
  mergeROSSensorConfig,
  radarToMeasurement,
  thermalToMeasurement,
} from '../useROSSensors'
import type { AcousticDetection, Header, LidarDetection, RadarDetection, ThermalDetection } from '../types'

const header: Header = {
  stamp: { secs: 10, nsecs: 500_000_000 },
  frame_id: 'sensor_frame',
}

describe('useROSSensors helpers', () => {
  it('clamps fusion rates to a safe interval range', () => {
    expect(clampFusionRateHz(Number.NaN)).toBe(DEFAULT_ROS_SENSOR_CONFIG.fusionRateHz)
    expect(clampFusionRateHz(0)).toBe(1)
    expect(clampFusionRateHz(120)).toBe(60)
    expect(clampFusionRateHz(20)).toBe(20)
  })

  it('deep merges partial topic configuration', () => {
    const config = mergeROSSensorConfig({
      rosUrl: 'ws://example:9090',
      topics: { radar: '/custom/radar' },
      fusionRateHz: 120,
    })

    expect(config.rosUrl).toBe('ws://example:9090')
    expect(config.topics.radar).toBe('/custom/radar')
    expect(config.topics.thermal).toBe(DEFAULT_ROS_SENSOR_CONFIG.topics.thermal)
    expect(config.topics.acoustic).toBe(DEFAULT_ROS_SENSOR_CONFIG.topics.acoustic)
    expect(config.fusionRateHz).toBe(60)
  })

  it('converts thermal detections to fusion measurements', () => {
    const detection: ThermalDetection = {
      header,
      id: 'thermal-1',
      position: { x: 1, y: 2, z: 3 },
      temperature_kelvin: 320,
      signature_area: 1.5,
      confidence: 0.8,
      classification: 'drone',
    }

    expect(thermalToMeasurement(detection, 'thermal_sensor')).toMatchObject({
      sensor_id: 'thermal_sensor',
      modality: 'thermal',
      timestamp_ms: 10500,
      position: [1, 2, 3],
      covariance: [2, 2, 2],
      confidence: 0.8,
      class_label: 'drone',
      metadata: { temperature_k: 320, signature_area: 1.5 },
    })
  })

  it('converts acoustic detections from spherical coordinates', () => {
    const detection: AcousticDetection = {
      header,
      id: 'acoustic-1',
      azimuth: Math.PI / 2,
      elevation: 0,
      range_estimate: 10,
      spl_db: 70,
      dominant_frequency_hz: 120,
      doppler_hz: 5,
      confidence: 0.7,
      classification: 'drone',
    }

    const measurement = acousticToMeasurement(detection, 'acoustic_sensor')

    expect(measurement.modality).toBe('acoustic')
    expect(measurement.timestamp_ms).toBe(10500)
    expect(measurement.position[0]).toBeCloseTo(0, 6)
    expect(measurement.position[1]).toBeCloseTo(10, 6)
    expect(measurement.position[2]).toBeCloseTo(0, 6)
    expect(measurement.velocity?.[0]).toBeCloseTo(0, 6)
    expect(measurement.velocity?.[1]).toBeCloseTo(0.5, 6)
    expect(measurement.metadata.frequency_hz).toBe(120)
  })

  it('omits acoustic velocity when doppler is zero', () => {
    const detection: AcousticDetection = {
      header,
      id: 'acoustic-2',
      azimuth: 0,
      elevation: 0,
      range_estimate: 3,
      spl_db: 60,
      dominant_frequency_hz: 90,
      doppler_hz: 0,
      confidence: 0.5,
      classification: 'unknown',
    }

    expect(acousticToMeasurement(detection, 'acoustic_sensor').velocity).toBeUndefined()
  })

  it('converts radar detections from spherical coordinates', () => {
    const detection: RadarDetection = {
      header,
      id: 'radar-1',
      range: 20,
      azimuth: 0,
      elevation: 0,
      radial_velocity: 4,
      rcs_dbsm: -5,
      confidence: 0.9,
      classification: 'drone',
    }

    expect(radarToMeasurement(detection, 'radar_sensor')).toMatchObject({
      sensor_id: 'radar_sensor',
      modality: 'radar',
      timestamp_ms: 10500,
      position: [20, 0, 0],
      velocity: [4, 0, 0],
      covariance: [0.5, 1, 1],
      metadata: { rcs_dbsm: -5, radial_velocity: 4 },
    })
  })

  it('converts lidar detections with bounding box metadata', () => {
    const detection: LidarDetection = {
      header,
      id: 'lidar-1',
      centroid: { x: 1, y: 2, z: 3 },
      bbox_min: { x: 0, y: 0, z: 1 },
      bbox_max: { x: 2, y: 4, z: 5 },
      velocity: { x: 0.1, y: 0.2, z: 0.3 },
      num_points: 42,
      confidence: 0.85,
      classification: 'drone',
    }

    expect(lidarToMeasurement(detection, 'lidar_sensor')).toMatchObject({
      sensor_id: 'lidar_sensor',
      modality: 'lidar',
      timestamp_ms: 10500,
      position: [1, 2, 3],
      velocity: [0.1, 0.2, 0.3],
      covariance: [0.1, 0.1, 0.1],
      metadata: {
        num_points: 42,
        bbox_size_x: 2,
        bbox_size_y: 4,
        bbox_size_z: 4,
      },
    })
  })
})
