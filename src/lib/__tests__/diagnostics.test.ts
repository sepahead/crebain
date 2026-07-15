import { describe, expect, it } from 'vitest'
import {
  calculateLatencyStats,
  getBackendHealth,
  getBackendHealthLabel,
  getConnectionStatusLabel,
  normalizeSystemInfo,
  summarizeSystemInfo,
} from '../diagnostics'

describe('diagnostics', () => {
  it('normalizes malformed system info payloads', () => {
    expect(normalizeSystemInfo(null)).toEqual({
      platform: 'unknown',
      arch: 'unknown',
      coremlAvailable: false,
      onnxAvailable: false,
      backend: 'Unknown',
      mode: 'unknown',
      availableBackends: [],
      experimentalMlxEnabled: false,
      inferenceReady: null,
    })
  })

  it('normalizes partial system info payloads', () => {
    const info = normalizeSystemInfo({
      platform: 'macos',
      arch: 'aarch64',
      coremlAvailable: true,
      backend: 'CoreML Native FFI',
      sensorFusion: { tracks: 0 },
    })

    expect(info).toMatchObject({
      platform: 'macos',
      arch: 'aarch64',
      coremlAvailable: true,
      onnxAvailable: false,
      backend: 'CoreML Native FFI',
      mode: 'unknown',
      availableBackends: [],
      experimentalMlxEnabled: false,
      inferenceReady: null,
      sensorFusion: { tracks: 0 },
    })
  })

  it('falls back for blank strings and non-boolean availability flags', () => {
    const info = normalizeSystemInfo({
      platform: '',
      arch: '',
      coremlAvailable: 'true',
      onnxAvailable: 1,
      backend: '',
      mode: '',
      availableBackends: ['', 'ONNX', 1],
      experimentalMlxEnabled: 'yes',
    })

    expect(info).toEqual({
      platform: 'unknown',
      arch: 'unknown',
      coremlAvailable: false,
      onnxAvailable: false,
      backend: 'Unknown',
      mode: 'unknown',
      availableBackends: ['ONNX'],
      experimentalMlxEnabled: false,
      inferenceReady: null,
      onnxDetector: undefined,
      sensorFusion: undefined,
    })
  })

  it('classifies backend health', () => {
    expect(
      getBackendHealth({
        backend: 'No Backend Available',
        coremlAvailable: false,
        onnxAvailable: false,
      })
    ).toBe('unavailable')
    expect(
      getBackendHealth({ backend: 'ONNX Runtime', coremlAvailable: false, onnxAvailable: true })
    ).toBe('ready')
    expect(
      getBackendHealth({ backend: 'TensorRT', coremlAvailable: false, onnxAvailable: false })
    ).toBe('ready')
    expect(
      getBackendHealth({ backend: 'Custom Backend', coremlAvailable: false, onnxAvailable: false })
    ).toBe('unknown')
    expect(
      getBackendHealth({
        backend: 'Not Initialized',
        coremlAvailable: true,
        onnxAvailable: false,
        inferenceReady: false,
      })
    ).toBe('initializing')
    expect(
      getBackendHealth({
        backend: 'Inference Runtime Busy',
        coremlAvailable: true,
        onnxAvailable: true,
        inferenceReady: false,
      })
    ).toBe('busy')
    expect(
      getBackendHealth({
        backend: 'TensorRT',
        coremlAvailable: false,
        onnxAvailable: false,
        inferenceReady: false,
      })
    ).toBe('unknown')
    expect(
      getBackendHealth({
        backend: 'Unknown Backend',
        coremlAvailable: false,
        onnxAvailable: false,
        inferenceReady: true,
      })
    ).toBe('ready')
  })

  it('provides honest labels for backend and telemetry states', () => {
    expect(getBackendHealthLabel('initializing')).toBe('NICHT INITIALISIERT')
    expect(getBackendHealthLabel('busy')).toBe('BESCHÄFTIGT')
    expect(getConnectionStatusLabel('disconnected')).toBe('GETRENNT')
    expect(getConnectionStatusLabel('connecting')).toBe('VERBINDE...')
    expect(getConnectionStatusLabel('connected')).toBe('VERBUNDEN')
    expect(getConnectionStatusLabel('reconnecting')).toBe('WIEDERVERBINDEN...')
  })

  it('summarizes system info for diagnostics UI', () => {
    const summary = summarizeSystemInfo(
      normalizeSystemInfo({
        platform: 'linux',
        arch: 'x86_64',
        onnxAvailable: true,
        backend: 'ONNX Runtime CUDA',
        mode: 'raw-rgba',
        availableBackends: ['ONNX', 'CUDA'],
        experimentalMlxEnabled: true,
        inferenceReady: true,
        sensorFusion: { algorithm: 'IMM' },
      })
    )

    expect(summary).toEqual({
      platform: 'linux',
      arch: 'x86_64',
      backend: 'ONNX Runtime CUDA',
      mode: 'raw-rgba',
      availableBackends: ['ONNX', 'CUDA'],
      experimentalMlxEnabled: true,
      backendHealth: 'ready',
      fusionReady: true,
    })
  })

  it('calculates latency stats for benchmark samples', () => {
    expect(calculateLatencyStats([10, 20, 30, 40, 50])).toEqual({
      mean: 30,
      p50: 30,
      p95: 50,
      p99: 50,
      min: 10,
      max: 50,
      fps: 1000 / 30,
    })
  })

  it('calculates latency stats for single-sample benchmarks', () => {
    expect(calculateLatencyStats([25])).toEqual({
      mean: 25,
      p50: 25,
      p95: 25,
      p99: 25,
      min: 25,
      max: 25,
      fps: 40,
    })
  })

  it('uses nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1) // 1..100
    const stats = calculateLatencyStats(samples)

    // Nearest-rank: index ceil(n*p) - 1. The previous floor(n*p) indexing sat
    // one rank high (e.g. p99 of 100 samples returned the max).
    expect(stats.p50).toBe(50)
    expect(stats.p95).toBe(95)
    expect(stats.p99).toBe(99)
    expect(stats.max).toBe(100)
  })

  it('rejects empty latency samples', () => {
    expect(() => calculateLatencyStats([])).toThrow('empty sample')
  })

  it('rejects invalid latency samples', () => {
    expect(() => calculateLatencyStats([10, Number.POSITIVE_INFINITY])).toThrow('invalid samples')
    expect(() => calculateLatencyStats([10, -1])).toThrow('invalid samples')
  })
})
