export interface SystemInfo {
  platform: string
  arch: string
  coremlAvailable: boolean
  onnxAvailable: boolean
  backend: string
  mode: string
  availableBackends: string[]
  experimentalMlxEnabled: boolean
  onnxDetector?: unknown
  sensorFusion?: unknown
}

export type BackendHealth = 'ready' | 'unavailable' | 'unknown'

export interface LatencyStats {
  mean: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  fps: number
}

const UNKNOWN_SYSTEM_INFO: SystemInfo = {
  platform: 'unknown',
  arch: 'unknown',
  coremlAvailable: false,
  onnxAvailable: false,
  backend: 'Unknown',
  mode: 'unknown',
  availableBackends: [],
  experimentalMlxEnabled: false,
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function readBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

export function normalizeSystemInfo(value: unknown): SystemInfo {
  if (!value || typeof value !== 'object') return { ...UNKNOWN_SYSTEM_INFO }

  const record = value as Record<string, unknown>

  return {
    platform: readString(record.platform, UNKNOWN_SYSTEM_INFO.platform),
    arch: readString(record.arch, UNKNOWN_SYSTEM_INFO.arch),
    coremlAvailable: readBoolean(record.coremlAvailable),
    onnxAvailable: readBoolean(record.onnxAvailable),
    backend: readString(record.backend, UNKNOWN_SYSTEM_INFO.backend),
    mode: readString(record.mode, UNKNOWN_SYSTEM_INFO.mode),
    availableBackends: readStringArray(record.availableBackends),
    experimentalMlxEnabled: readBoolean(record.experimentalMlxEnabled),
    onnxDetector: record.onnxDetector,
    sensorFusion: record.sensorFusion,
  }
}

export function getBackendHealth(
  info: Pick<SystemInfo, 'backend' | 'coremlAvailable' | 'onnxAvailable'>
): BackendHealth {
  const backend = info.backend.toLowerCase()

  if (backend.includes('no backend') || backend.includes('not available') || backend === 'unknown')
    return 'unavailable'
  if (info.coremlAvailable || info.onnxAvailable) return 'ready'
  if (
    backend.includes('coreml') ||
    backend.includes('onnx') ||
    backend.includes('cuda') ||
    backend.includes('tensorrt')
  ) {
    return 'ready'
  }

  return 'unknown'
}

export function summarizeSystemInfo(info: SystemInfo) {
  return {
    platform: info.platform,
    arch: info.arch,
    backend: info.backend,
    mode: info.mode,
    availableBackends: info.availableBackends,
    experimentalMlxEnabled: info.experimentalMlxEnabled,
    backendHealth: getBackendHealth(info),
    fusionReady: info.sensorFusion != null,
  }
}

export function calculateLatencyStats(times: number[]): LatencyStats {
  if (times.length === 0) {
    throw new Error('Cannot calculate latency stats for an empty sample')
  }
  if (times.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new Error('Cannot calculate latency stats for invalid samples')
  }

  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const sorted = [...times].sort((a, b) => a - b)
  // Nearest-rank percentile: rank ceil(n·p) (1-based), i.e. index ceil(n·p)-1.
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]

  return {
    mean,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    fps: mean > 0 ? 1000 / mean : 0,
  }
}
