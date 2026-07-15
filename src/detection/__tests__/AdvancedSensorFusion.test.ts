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

function measurement(timestampMs: number): SensorMeasurement {
  return {
    sensor_id: 'camera-1',
    modality: 'visual',
    timestamp_ms: timestampMs,
    position: [1, 2, 3],
    covariance: [1, 1, 1],
    confidence: 0.9,
    class_label: 'drone',
    metadata: {},
  }
}

function track(overrides: Partial<FusedTrack> = {}): FusedTrack {
  return {
    id: 'track-1',
    position: [1, 2, 3],
    velocity: [0.1, 0.2, 0.3],
    position_uncertainty: [0.5, 0.5, 0.5],
    velocity_uncertainty: [0.1, 0.1, 0.1],
    class_label: 'drone',
    confidence: 0.95,
    sensor_sources: ['visual', 'thermal'],
    last_update_ms: 250,
    age: 0,
    state: 'Confirmed',
    threat_level: 3,
    ...overrides,
  }
}

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

    await processMeasurements([measurement], 123, 7)

    expect(invokeMock).toHaveBeenCalledWith('fusion_process', {
      measurements: [measurement],
      timestampMs: 123,
      upstreamDroppedMeasurements: 7,
    })
  })

  it('derives one exact frame time from co-temporal measurements', async () => {
    const expectedTrack = track()
    const measurements = [measurement(250), measurement(250)]
    invokeMock.mockResolvedValue([expectedTrack])

    await expect(processMeasurements(measurements)).resolves.toEqual([expectedTrack])

    expect(invokeMock).toHaveBeenCalledWith('fusion_process', {
      measurements,
      timestampMs: 250,
      upstreamDroppedMeasurements: 0,
    })
  })

  it('rejects mixed or explicitly mismatched measurement timestamps before IPC', async () => {
    await expect(processMeasurements([measurement(100), measurement(250)])).rejects.toThrow(
      'all measurements in one frame must have the same timestamp_ms'
    )
    await expect(processMeasurements([measurement(100)], 250)).rejects.toThrow(
      'timestampMs must equal every measurement timestamp_ms'
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('requires an explicit measurement-domain timestamp for an empty frame', async () => {
    await expect(processMeasurements([])).rejects.toThrow(
      'timestampMs is required when processing an empty measurement frame'
    )
    expect(invokeMock).not.toHaveBeenCalled()
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

    await expect(processMeasurements([measurement], 123)).rejects.toThrow(
      'Invalid fusion response: tracks[0].sensor_sources must contain known modalities'
    )
  })

  it('rejects out-of-range track fields and oversized responses', async () => {
    const input = measurement(123)
    const cases: Array<[unknown, string]> = [
      [[track({ confidence: 1.1 })], 'tracks[0].confidence must be between 0 and 1'],
      [[track({ age: -1 })], 'tracks[0].age must be a safe integer'],
      [[track({ threat_level: 2.5 })], 'tracks[0].threat_level must be a safe integer'],
      [
        [track({ position_uncertainty: [-1, 0, 0] })],
        'tracks[0].position_uncertainty entries must be non-negative',
      ],
      [Array.from({ length: 1_025 }, () => track()), 'tracks must contain at most 1024 entries'],
    ]

    for (const [response, message] of cases) {
      invokeMock.mockResolvedValueOnce(response)
      await expect(processMeasurements([input], 123)).rejects.toThrow(message)
    }
  })

  it('rejects malformed fusion stats responses', async () => {
    invokeMock.mockResolvedValue({ algorithm: 'Unknown' })

    await expect(getFusionStats()).rejects.toThrow(
      'Invalid fusion response: stats.algorithm must be a known algorithm'
    )
  })

  it('rejects fractional or internally inconsistent fusion statistics', async () => {
    invokeMock
      .mockResolvedValueOnce({
        total_tracks: 1.5,
        confirmed_tracks: 0,
        tentative_tracks: 0,
        coasting_tracks: 0,
        multi_sensor_tracks: 0,
        algorithm: 'ExtendedKalman',
        frame_count: 1,
      })
      .mockResolvedValueOnce({
        total_tracks: 2,
        confirmed_tracks: 1,
        tentative_tracks: 1,
        coasting_tracks: 1,
        multi_sensor_tracks: 0,
        algorithm: 'ExtendedKalman',
        frame_count: 1,
      })

    await expect(getFusionStats()).rejects.toThrow('stats.total_tracks must be a safe integer')
    await expect(getFusionStats()).rejects.toThrow(
      'stats state counts must not exceed stats.total_tracks'
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
