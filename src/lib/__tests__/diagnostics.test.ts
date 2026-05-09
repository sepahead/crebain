import { describe, expect, it } from 'vitest'
import { getBackendHealth, normalizeSystemInfo, summarizeSystemInfo } from '../diagnostics'

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
})
