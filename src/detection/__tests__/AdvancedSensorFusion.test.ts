import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import {
  clearTracks,
  getAlgorithms,
  getFusionStats,
  getModalities,
  getTracks,
  initFusion,
  processMeasurements,
  setFusionConfig,
  type FusedTrack,
  type FusionConfig,
  type SensorMeasurement,
} from '../AdvancedSensorFusion'

describe('AdvancedSensorFusion IPC', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes fusion initialization through the centralized command name', async () => {
    invokeMock.mockResolvedValue(undefined)

    await initFusion({ algorithm: 'IMM' })

    expect(invokeMock).toHaveBeenCalledWith('fusion_init', {
      config: {
        algorithm: 'IMM',
        process_noise: 1,
        measurement_noise: 2,
        association_threshold: 11.345,
        max_missed_detections: 5,
        min_confirmation_hits: 3,
        confirmation_window: 5,
        max_position_cov_volume: 1e6,
        particle_count: 100,
      },
    })
  })

  it('routes measurement processing with explicit timestamps', async () => {
    invokeMock.mockResolvedValue([])
    const measurement: SensorMeasurement = {
      sensor_id: 'camera-1',
      modality: 'visual',
      timestamp_ms: 123,
      position: [1, 2, 3],
      covariance: [1, 1, 1],
      confidence: 0.9,
      class_label: 'drone',
      metadata: {},
    }

    await processMeasurements([measurement], 456, 7)

    expect(invokeMock).toHaveBeenCalledWith('fusion_process', {
      measurements: [measurement],
      timestampMs: 456,
      upstreamDroppedMeasurements: 7,
    })
  })

  it('uses a deterministic clock fallback and returns fused tracks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const track: FusedTrack = {
      id: 'track-1',
      position: [1, 2, 3],
      velocity: [0.1, 0.2, 0.3],
      position_uncertainty: [0.5, 0.5, 0.5],
      velocity_uncertainty: [0.1, 0.1, 0.1],
      class_label: 'drone',
      confidence: 0.95,
      sensor_sources: ['visual', 'thermal'],
      last_update_ms: 1_700_000_000_000,
      age: 0,
      state: 'Confirmed',
      threat_level: 3,
    }
    const measurement: SensorMeasurement = {
      sensor_id: 'camera-1',
      modality: 'visual',
      timestamp_ms: 1_700_000_000_000,
      position: [1, 2, 3],
      covariance: [1, 1, 1],
      confidence: 0.9,
      class_label: 'drone',
      metadata: {},
    }
    invokeMock.mockResolvedValue([track])

    await expect(processMeasurements([measurement])).resolves.toEqual([track])

    expect(invokeMock).toHaveBeenCalledWith('fusion_process', {
      measurements: [measurement],
      timestampMs: 1_700_000_000_000,
      upstreamDroppedMeasurements: 0,
    })
  })

  it('rejects malformed fused track responses', async () => {
    const measurement: SensorMeasurement = {
      sensor_id: 'camera-1',
      modality: 'visual',
      timestamp_ms: 123,
      position: [1, 2, 3],
      covariance: [1, 1, 1],
      confidence: 0.9,
      class_label: 'drone',
      metadata: {},
    }
    invokeMock.mockResolvedValue([{ id: 'track-1', position: [1, 2] }])

    await expect(processMeasurements([measurement], 456)).rejects.toThrow(
      'Invalid fusion response: tracks[0].sensor_sources must contain known modalities'
    )
  })

  it('rejects malformed fusion stats responses', async () => {
    invokeMock.mockResolvedValue({ algorithm: 'Unknown' })

    await expect(getFusionStats()).rejects.toThrow(
      'Invalid fusion response: stats.algorithm must be a known algorithm'
    )
  })

  it('routes query and mutation commands', async () => {
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({
        total_tracks: 0,
        confirmed_tracks: 0,
        tentative_tracks: 0,
        coasting_tracks: 0,
        multi_sensor_tracks: 0,
        algorithm: 'ExtendedKalman',
        frame_count: 0,
      })
      .mockResolvedValue(undefined)
    const config: FusionConfig = {
      algorithm: 'ExtendedKalman',
      process_noise: 1,
      measurement_noise: 2,
      association_threshold: 10,
      max_missed_detections: 5,
      min_confirmation_hits: 3,
      particle_count: 100,
    }

    await getTracks()
    await getFusionStats()
    await setFusionConfig(config)
    await clearTracks()
    await getAlgorithms()
    await getModalities()

    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'fusion_get_tracks',
      'fusion_get_stats',
      'fusion_set_config',
      'fusion_clear',
      'fusion_get_algorithms',
      'fusion_get_modalities',
    ])
    expect(invokeMock).toHaveBeenCalledWith('fusion_set_config', { config })
  })
})
