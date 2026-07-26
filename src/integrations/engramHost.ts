import { invoke, isTauri } from '@tauri-apps/api/core'

export const ENGRAM_HOST_PROTOCOL = 'engram.host.v1'
export const CREBAIN_EXTENSION_ID = 'sepahead.crebain'
export const ENGRAM_HOST_MESSAGE_MAX_BYTES = 8 * 1024
export const ENGRAM_HOST_PEER_MESSAGE_RATE_MAX = 32
export const ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS = 1_000

const HOST_MODE_PARAMETER = 'engramHost'
const HOST_ORIGIN_PARAMETER = 'hostOrigin'
const HOST_NONCE_PARAMETER = 'hostNonce'
const HOST_NONCE_MIN_LENGTH = 16
const HOST_NONCE_MAX_LENGTH = 128
const HOST_ORIGIN_MAX_LENGTH = 256
const HOST_NONCE_PATTERN = /^[A-Za-z0-9_-]+$/
const ENGRAM_HOST_SECURITY_CANARY_COMMAND = 'get_extension_host_security'
const TAURI_HOST_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
])
const activeHostBridges = new WeakMap<Window, EngramHostBridgeHandle>()
const embeddedHostDocuments = new WeakSet<Window>()

export interface EngramHostConfig {
  origin: string
  nonce: string
}

export interface EngramHostBridgeHandle {
  active: boolean
  embedded: boolean
  stop: () => void
}

export interface EngramHostBridgeOptions {
  nativeIpcProbe?: () => Promise<boolean>
  /** Injectable monotonic clock for deterministic boundary tests. */
  monotonicNow?: () => number
}

interface EngramHostEnvelope {
  protocol: typeof ENGRAM_HOST_PROTOCOL
  kind: 'extension.ready' | 'extension.status' | 'host.context'
  extension_id: typeof CREBAIN_EXTENSION_ID
  nonce: string
  payload: unknown
}

const utf8Encoder = new TextEncoder()

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}

function exactParameter(parameters: URLSearchParams, name: string): string | null {
  const values = parameters.getAll(name)
  return values.length === 1 ? values[0] : null
}

function queryRequestsEmbeddedMode(search: string): boolean {
  return new URLSearchParams(search).getAll(HOST_MODE_PARAMETER).includes('1')
}

/**
 * Return true when the URL requests restricted Engram hosting.
 *
 * A duplicate or incomplete handshake remains embedded. This fail-closed rule
 * prevents malformed host parameters from restoring native access. Default
 * runtime calls latch this state for the lifetime of the current document.
 */
export function isEngramEmbeddedMode(
  search?: string,
  hostWindow: Window | undefined = typeof window === 'undefined' ? undefined : window
): boolean {
  if (search !== undefined) return queryRequestsEmbeddedMode(search)
  if (hostWindow === undefined) return false
  if (embeddedHostDocuments.has(hostWindow)) return true
  if (!queryRequestsEmbeddedMode(hostWindow.location.search)) return false
  embeddedHostDocuments.add(hostWindow)
  return true
}

export function isAllowedEngramHostOrigin(origin: string): boolean {
  if (origin.length === 0 || origin.length > HOST_ORIGIN_MAX_LENGTH) return false
  if (TAURI_HOST_ORIGINS.has(origin)) return true

  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || parsed.username !== '' || parsed.password !== '') return false
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === 'tauri.localhost'
    )
  } catch {
    return false
  }
}

export function isAllowedEngramHostNonce(nonce: string): boolean {
  return (
    nonce.length >= HOST_NONCE_MIN_LENGTH &&
    nonce.length <= HOST_NONCE_MAX_LENGTH &&
    HOST_NONCE_PATTERN.test(nonce)
  )
}

export function readEngramHostConfig(search: string = currentSearch()): EngramHostConfig | null {
  const parameters = new URLSearchParams(search)
  if (exactParameter(parameters, HOST_MODE_PARAMETER) !== '1') return null

  const origin = exactParameter(parameters, HOST_ORIGIN_PARAMETER)
  const nonce = exactParameter(parameters, HOST_NONCE_PARAMETER)
  if (origin === null || nonce === null) return null
  if (!isAllowedEngramHostOrigin(origin) || !isAllowedEngramHostNonce(nonce)) return null

  return Object.freeze({ origin, nonce })
}

/** Return false for every native backend probe in restricted embedded mode. */
export function isNativeBackendAvailable(
  search?: string,
  tauriProbe: () => boolean = isTauri
): boolean {
  if (isEngramEmbeddedMode(search)) return false
  return tauriProbe()
}

/** Reject a direct native entry point when a caller bypasses a UI availability check. */
export function assertNativeBackendAllowed(search?: string): void {
  if (isEngramEmbeddedMode(search)) {
    throw new Error('Native backend access is disabled in Engram embedded mode')
  }
}

/** Reject external telemetry connections from the Phase 0 embedded view. */
export function assertExternalTelemetryAllowed(search?: string): void {
  if (isEngramEmbeddedMode(search)) {
    throw new Error('External telemetry is disabled in Engram embedded mode')
  }
}

/** Reject artifact ingress, persistence, and export from the Phase 0 embedded view. */
export function assertArtifactExchangeAllowed(search?: string): void {
  if (isEngramEmbeddedMode(search)) {
    throw new Error('Artifact exchange is disabled in Engram embedded mode')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Reflect.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false
  if (Object.hasOwn(value, 'toJSON')) return false
  const expectedKeys = new Set(expected)
  let keyCount = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) return false
    keyCount += 1
    if (keyCount > expected.length || !expectedKeys.has(key)) return false
  }
  return keyCount === expected.length
}

function hasExactEnvelopeKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['protocol', 'kind', 'extension_id', 'nonce', 'payload'])
}

function isExactString(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.length === expected.length && value === expected
}

/**
 * Measure only locally constructed envelopes.
 *
 * The inbound parser copies validated primitives into a new envelope first.
 * It never passes the untrusted MessageEvent object to JSON.stringify.
 */
function hasBoundedSerializedSize(value: unknown): boolean {
  try {
    return utf8Encoder.encode(JSON.stringify(value)).byteLength <= ENGRAM_HOST_MESSAGE_MAX_BYTES
  } catch {
    return false
  }
}

function readValidHostContextNonce(value: unknown, config: EngramHostConfig): string | null {
  if (!isRecord(value) || !hasExactEnvelopeKeys(value)) return null
  if (!isExactString(value.protocol, ENGRAM_HOST_PROTOCOL)) return null
  if (!isExactString(value.kind, 'host.context')) return null
  if (!isExactString(value.extension_id, CREBAIN_EXTENSION_ID)) return null
  if (!isExactString(value.nonce, config.nonce)) return null

  const payload = value.payload
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['host_api', 'authority', 'ncp', 'context_nonce'])
  ) {
    return null
  }
  if (!isExactString(payload.host_api, '1.0')) return null
  if (!isExactString(payload.authority, 'read-only')) return null

  const ncp = payload.ncp
  if (!isRecord(ncp) || !hasExactKeys(ncp, ['wire', 'extension_wire', 'compatible'])) {
    return null
  }
  if (!isExactString(ncp.wire, '1.0')) return null
  if (!isExactString(ncp.extension_wire, '0.8')) return null
  if (ncp.compatible !== false) return null

  const contextNonce = payload.context_nonce
  if (typeof contextNonce !== 'string' || !isAllowedEngramHostNonce(contextNonce)) return null

  const normalized = createEnvelope('host.context', config.nonce, {
    host_api: '1.0',
    authority: 'read-only',
    ncp: { wire: '1.0', extension_wire: '0.8', compatible: false },
    context_nonce: contextNonce,
  })
  return hasBoundedSerializedSize(normalized) ? contextNonce : null
}

function createEnvelope(
  kind: EngramHostEnvelope['kind'],
  nonce: string,
  payload: unknown
): EngramHostEnvelope {
  return {
    protocol: ENGRAM_HOST_PROTOCOL,
    kind,
    extension_id: CREBAIN_EXTENSION_ID,
    nonce,
    payload,
  }
}

/**
 * Start the read-only Engram bridge for this document.
 *
 * The bridge accepts context only. It has no command, NCP, plant, or native
 * backend message path.
 */
export function startEngramHostBridge(
  hostWindow: Window = window,
  options: EngramHostBridgeOptions = {}
): EngramHostBridgeHandle {
  const embedded = isEngramEmbeddedMode(undefined, hostWindow)
  const config = readEngramHostConfig(hostWindow.location.search)
  if (!embedded || config === null || hostWindow.parent === hostWindow) {
    return { active: false, embedded, stop: () => undefined }
  }
  const existing = activeHostBridges.get(hostWindow)
  if (existing?.active) return existing

  let hostContextReceived = false
  let hostContextNonce: string | null = null
  let heartbeatSequence = 0
  let tauriIpcAccessible: boolean | null =
    options.nativeIpcProbe === undefined && !isTauri() ? false : null
  let active = true
  let handle: EngramHostBridgeHandle | null = null
  const peerMessageTimes = new Array<number>(ENGRAM_HOST_PEER_MESSAGE_RATE_MAX)
  let oldestPeerMessageIndex = 0
  let peerMessageCount = 0
  let lastPeerMessageAt: number | null = null
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const post = (kind: 'extension.ready' | 'extension.status', payload: unknown) => {
    const envelope = createEnvelope(kind, config.nonce, payload)
    if (hasBoundedSerializedSize(envelope)) {
      try {
        hostWindow.parent.postMessage(envelope, config.origin)
      } catch {
        // A host navigation or rejected custom origin must not stop CREBAIN.
      }
    }
  }
  const postStatus = () => {
    post('extension.status', {
      mode: 'embedded-read-only',
      authority: 'read-only',
      native_backend: false,
      external_telemetry: false,
      artifact_exchange: false,
      ncp: { wire: '0.8', compatible: false, active: false },
      plant_control: false,
      tauri_ipc_accessible: tauriIpcAccessible,
      heartbeat_sequence: heartbeatSequence,
      host_context_received: hostContextReceived,
      context_nonce: hostContextNonce,
    })
  }

  const revoke = () => {
    if (!active) return
    active = false
    hostWindow.removeEventListener('message', onMessage)
    if (handle !== null && activeHostBridges.get(hostWindow) === handle) {
      activeHostBridges.delete(hostWindow)
    }
  }
  const consumePeerMessageBudget = (): boolean => {
    const now = monotonicNow()
    if (!Number.isFinite(now)) return false
    if (lastPeerMessageAt !== null && now < lastPeerMessageAt) return false
    lastPeerMessageAt = now

    while (peerMessageCount > 0) {
      const oldestMessageAt = peerMessageTimes[oldestPeerMessageIndex]
      if (now - oldestMessageAt < ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS) break
      oldestPeerMessageIndex = (oldestPeerMessageIndex + 1) % ENGRAM_HOST_PEER_MESSAGE_RATE_MAX
      peerMessageCount -= 1
    }
    if (peerMessageCount >= ENGRAM_HOST_PEER_MESSAGE_RATE_MAX) return false

    const nextIndex =
      (oldestPeerMessageIndex + peerMessageCount) % ENGRAM_HOST_PEER_MESSAGE_RATE_MAX
    peerMessageTimes[nextIndex] = now
    peerMessageCount += 1
    return true
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== hostWindow.parent || event.origin !== config.origin) return
    if (event.isTrusted !== true) return
    if (!consumePeerMessageBudget()) {
      revoke()
      return
    }
    let contextNonce: string | null
    try {
      contextNonce = readValidHostContextNonce(event.data, config)
    } catch {
      return
    }
    if (contextNonce === null) return
    if (hostContextReceived && contextNonce !== hostContextNonce) return
    hostContextNonce = contextNonce
    hostContextReceived = true
    heartbeatSequence = (heartbeatSequence + 1) % 4_294_967_296
    postStatus()
  }

  hostWindow.addEventListener('message', onMessage)
  post('extension.ready', {
    mode: 'embedded-read-only',
    standalone_available: true,
    native_backend: false,
    ncp: { wire: '0.8', compatible: false },
  })
  postStatus()

  if (tauriIpcAccessible === null) {
    const probe =
      options.nativeIpcProbe ??
      (async () => {
        try {
          await invoke(ENGRAM_HOST_SECURITY_CANARY_COMMAND)
          return true
        } catch {
          return false
        }
      })
    void probe()
      .then((accessible) => {
        if (!active) return
        tauriIpcAccessible = accessible
        postStatus()
      })
      .catch(() => {
        if (!active) return
        tauriIpcAccessible = false
        postStatus()
      })
  }

  handle = {
    get active() {
      return active
    },
    embedded: true,
    stop: revoke,
  }
  activeHostBridges.set(hostWindow, handle)
  return handle
}
