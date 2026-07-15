export interface SystemInfo {
  platform: string
  arch: string
  coremlAvailable: boolean
  onnxAvailable: boolean
  backend: string
  mode: string
  availableBackends: string[]
  experimentalMlxEnabled: boolean
  inferenceReady: boolean | null
  onnxDetector?: unknown
  sensorFusion?: unknown
}

export type BackendHealth = 'ready' | 'unavailable' | 'initializing' | 'busy' | 'unknown'
export type DiagnosticsConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting'

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
  inferenceReady: null,
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function readBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false
}

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
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
    inferenceReady: readOptionalBoolean(record.inferenceReady),
    onnxDetector: record.onnxDetector,
    sensorFusion: record.sensorFusion,
  }
}

export function getBackendHealth(
  info: Pick<SystemInfo, 'backend' | 'coremlAvailable' | 'onnxAvailable'> & {
    inferenceReady?: boolean | null
  }
): BackendHealth {
  const backend = info.backend.toLowerCase()

  // State words take precedence over provider-name substrings and legacy
  // availability flags. For example, "Inference Runtime Busy" and
  // "CoreML Not Initialized" must never become ready merely because they
  // contain a recognized backend name.
  if (backend.includes('busy')) return 'busy'
  if (
    backend.includes('not initialized') ||
    backend.includes('uninitialized') ||
    backend.includes('initializing')
  ) {
    return 'initializing'
  }
  if (
    backend.includes('no backend') ||
    backend.includes('not available') ||
    backend.includes('unavailable') ||
    backend.includes('failed') ||
    backend.includes('error') ||
    backend === 'unknown'
  ) {
    return 'unavailable'
  }
  if (info.inferenceReady === false) return 'unknown'
  if (info.inferenceReady === true) return 'ready'
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

export function getBackendHealthLabel(health: BackendHealth): string {
  return {
    ready: 'BEREIT',
    unavailable: 'NICHT VERFÜGBAR',
    initializing: 'NICHT INITIALISIERT',
    busy: 'BESCHÄFTIGT',
    unknown: 'UNBEKANNT',
  }[health]
}

export function getConnectionStatusLabel(state: DiagnosticsConnectionState): string {
  return {
    disconnected: 'GETRENNT',
    connecting: 'VERBINDE...',
    connected: 'VERBUNDEN',
    reconnecting: 'WIEDERVERBINDEN...',
  }[state]
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
