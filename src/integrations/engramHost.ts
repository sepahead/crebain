import { invoke, isTauri } from '@tauri-apps/api/core'

export const ENGRAM_HOST_PROTOCOL = 'engram.host.v1'
export const CREBAIN_EXTENSION_ID = 'sepahead.crebain'
export const ENGRAM_HOST_MESSAGE_MAX_BYTES = 8 * 1024

const HOST_MODE_PARAMETER = 'engramHost'
const HOST_ORIGIN_PARAMETER = 'hostOrigin'
const HOST_NONCE_PARAMETER = 'hostNonce'
const HOST_NONCE_MIN_LENGTH = 16
const HOST_NONCE_MAX_LENGTH = 128
const HOST_ORIGIN_MAX_LENGTH = 256
const HOST_CONTEXT_MAX_DEPTH = 4
const HOST_CONTEXT_MAX_ENTRIES = 32
const HOST_CONTEXT_MAX_STRING_LENGTH = 1024
const HOST_NONCE_PATTERN = /^[A-Za-z0-9_-]+$/
const ENGRAM_HOST_SECURITY_CANARY_COMMAND = 'get_extension_host_security'
const UNSAFE_CONTEXT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
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
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const expectedKeys = [...expected].sort()
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  )
}

function hasExactEnvelopeKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['protocol', 'kind', 'extension_id', 'nonce', 'payload'])
}

function isBoundedContextValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= HOST_CONTEXT_MAX_STRING_LENGTH
  if (depth >= HOST_CONTEXT_MAX_DEPTH || typeof value !== 'object') return false

  if (Array.isArray(value)) {
    return (
      value.length <= HOST_CONTEXT_MAX_ENTRIES &&
      value.every((entry) => isBoundedContextValue(entry, depth + 1))
    )
  }

  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= HOST_CONTEXT_MAX_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 &&
        key.length <= HOST_CONTEXT_MAX_STRING_LENGTH &&
        !UNSAFE_CONTEXT_KEYS.has(key) &&
        isBoundedContextValue(entry, depth + 1)
    )
  )
}

function hasBoundedSerializedSize(value: unknown): boolean {
  try {
    return utf8Encoder.encode(JSON.stringify(value)).byteLength <= ENGRAM_HOST_MESSAGE_MAX_BYTES
  } catch {
    return false
  }
}

function isValidHostContextPayload(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['host_api', 'authority', 'ncp', 'context_nonce'])) return false
  if (value.host_api !== '1.0' || value.authority !== 'read-only' || !isRecord(value.ncp)) {
    return false
  }
  return (
    typeof value.context_nonce === 'string' &&
    isAllowedEngramHostNonce(value.context_nonce) &&
    hasExactKeys(value.ncp, ['wire', 'extension_wire', 'compatible']) &&
    value.ncp.wire === '1.0' &&
    value.ncp.extension_wire === '0.8' &&
    value.ncp.compatible === false
  )
}

function readValidHostContextNonce(value: unknown, config: EngramHostConfig): string | null {
  if (!isRecord(value) || !hasExactEnvelopeKeys(value)) return null
  if (value.protocol !== ENGRAM_HOST_PROTOCOL) return null
  if (value.kind !== 'host.context') return null
  if (value.extension_id !== CREBAIN_EXTENSION_ID) return null
  if (value.nonce !== config.nonce) return null
  if (
    !isRecord(value.payload) ||
    !isBoundedContextValue(value.payload) ||
    !isValidHostContextPayload(value.payload)
  ) {
    return null
  }
  if (!hasBoundedSerializedSize(value)) return null
  return value.payload.context_nonce as string
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

  const onMessage = (event: MessageEvent) => {
    if (event.source !== hostWindow.parent || event.origin !== config.origin) return
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

  const handle: EngramHostBridgeHandle = {
    get active() {
      return active
    },
    embedded: true,
    stop: () => {
      if (!active) return
      active = false
      hostWindow.removeEventListener('message', onMessage)
      if (activeHostBridges.get(hostWindow) === handle) activeHostBridges.delete(hostWindow)
    },
  }
  activeHostBridges.set(hostWindow, handle)
  return handle
}
