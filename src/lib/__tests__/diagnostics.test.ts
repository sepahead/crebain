import { describe, expect, it } from 'vitest'
import { calculateLatencyStats, getBackendHealth, normalizeSystemInfo, summarizeSystemInfo } from '../diagnostics'

describe('diagnostics', () => {
  it('normalizes malformed system info payloads', () => {
    expect(normalizeSystemInfo(null)).toEqual({
      platform: 'unknown',
      arch: 'unknown',
      coremlAvailable: false,
      onnxAvailable: false,
      backend: 'Unknown',
      mode: 'unknown',
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
    })

    expect(info).toEqual({
      platform: 'unknown',
      arch: 'unknown',
      coremlAvailable: false,
      onnxAvailable: false,
      backend: 'Unknown',
      mode: 'unknown',
      onnxDetector: undefined,
      sensorFusion: undefined,
    })
  })

  it('classifies backend health', () => {
    expect(getBackendHealth({ backend: 'No Backend Available', coremlAvailable: false, onnxAvailable: false })).toBe('unavailable')
    expect(getBackendHealth({ backend: 'ONNX Runtime', coremlAvailable: false, onnxAvailable: true })).toBe('ready')
    expect(getBackendHealth({ backend: 'TensorRT', coremlAvailable: false, onnxAvailable: false })).toBe('ready')
    expect(getBackendHealth({ backend: 'Custom Backend', coremlAvailable: false, onnxAvailable: false })).toBe('unknown')
  })

  it('summarizes system info for diagnostics UI', () => {
    const summary = summarizeSystemInfo(normalizeSystemInfo({
      platform: 'linux',
      arch: 'x86_64',
      onnxAvailable: true,
      backend: 'ONNX Runtime CUDA',
      mode: 'zero-copy',
      sensorFusion: { algorithm: 'IMM' },
    }))

    expect(summary).toEqual({
      platform: 'linux',
      arch: 'x86_64',
      backend: 'ONNX Runtime CUDA',
      mode: 'zero-copy',
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

  it('rejects empty latency samples', () => {
    expect(() => calculateLatencyStats([])).toThrow('empty sample')
  })
})
