import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import protocolVector from '../../../integrations/engram/engram.host.v1.vector.json'
import protocolVectorLock from '../../../integrations/engram/engram.host.v1.vector.lock.json'
import protocolVectorSource from '../../../integrations/engram/engram.host.v1.vector.json?raw'
import manifest from '../../../integrations/engram/manifest.json'
import manifestLock from '../../../integrations/engram/manifest.lock.json'
import manifestSource from '../../../integrations/engram/manifest.json?raw'
import {
  CREBAIN_EXTENSION_ID,
  ENGRAM_HOST_MESSAGE_MAX_BYTES,
  ENGRAM_HOST_PROTOCOL,
  assertArtifactExchangeAllowed,
  assertExternalTelemetryAllowed,
  assertNativeBackendAllowed,
  isAllowedEngramHostNonce,
  isAllowedEngramHostOrigin,
  isEngramEmbeddedMode,
  isNativeBackendAvailable,
  readEngramHostConfig,
  startEngramHostBridge,
} from '../engramHost'

const HOST_ORIGIN = protocolVector.host_origin
const HOST_NONCE = protocolVector.session_nonce
const CONTEXT_NONCE = protocolVector.context_nonce

function hostSearch(origin = HOST_ORIGIN, nonce = HOST_NONCE): string {
  const parameters = new URLSearchParams({
    engramHost: '1',
    hostOrigin: origin,
    hostNonce: nonce,
  })
  return `?${parameters.toString()}`
}

function createHostWindow(search = hostSearch()) {
  const listeners = new Set<(event: MessageEvent) => void>()
  const parent = { postMessage: vi.fn() }
  const hostWindow = {
    location: { search },
    parent,
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.delete(listener)
    }),
  } as unknown as Window

  return {
    hostWindow,
    parent,
    emit(data: unknown, origin = HOST_ORIGIN, source: unknown = parent) {
      const event = { data, origin, source } as MessageEvent
      for (const listener of listeners) listener(event)
    },
    listenerCount: () => listeners.size,
  }
}

function contextEnvelope(patch: Record<string, unknown> = {}) {
  return {
    ...protocolVector.host_context,
    ...patch,
  }
}

describe('Engram embedded runtime boundary', () => {
  it('publishes the read-only supervised entrypoint contract', () => {
    expect(manifest).toEqual({
      schema_version: '1.0',
      id: CREBAIN_EXTENSION_ID,
      name: 'CREBAIN',
      version: '0.9.0',
      description: 'Read-only supervised embedding for the CREBAIN research visualization runtime.',
      host_api: { minimum: '1.0', maximum: '1.0' },
      entrypoint: {
        kind: 'supervised-local-web',
        url: 'http://127.0.0.1:5173/',
        embedded_query: 'engramHost=1',
      },
      runtime: { ownership: 'external', standalone: true },
      requested_capabilities: ['status.read', 'ui.embed'],
      authority: 'read-only',
      artifacts: { accepts: [], produces: [] },
      ncp: { wire: '0.8', engram_wire: '1.0', compatible: false },
      standalone: {
        available: true,
        development_command: 'bun run dev',
        desktop_command: 'bun run tauri:dev',
      },
      boundaries: [
        'Embedded mode disables every Tauri and native backend path.',
        'Embedded mode disables external telemetry connections.',
        'Embedded mode accepts and produces no artifacts.',
        'The host bridge accepts bounded context only.',
        'The host bridge cannot activate NCP or plant control.',
      ],
    })
  })

  it('binds the source manifest to the shared cross-repository byte lock', () => {
    expect(manifestLock).toEqual({
      schema_version: 1,
      id: CREBAIN_EXTENSION_ID,
      hash_revision: 'file_bytes_v1',
      sha256: '013fe3ebba9e4ef776980eba5271315daf17c0e4e88b876ab0f980255a9c21d1',
    })
    expect(createHash('sha256').update(manifestSource).digest('hex')).toBe(manifestLock.sha256)
  })

  it('binds the host handshake to the shared cross-repository protocol vector', () => {
    expect(protocolVectorLock).toEqual({
      schema_version: 1,
      protocol: ENGRAM_HOST_PROTOCOL,
      hash_revision: 'file_bytes_v1',
      sha256: 'c7cb0c356962a3728efb09c8d2f1a42c0454abbdfb918da71d1400290b447c72',
    })
    expect(createHash('sha256').update(protocolVectorSource).digest('hex')).toBe(
      protocolVectorLock.sha256
    )
    expect(protocolVector).toMatchObject({
      schema_version: 1,
      protocol: ENGRAM_HOST_PROTOCOL,
      extension_id: CREBAIN_EXTENSION_ID,
    })
  })

  it('leaves standalone native detection unchanged', () => {
    const nativeProbe = vi.fn(() => true)

    expect(isEngramEmbeddedMode('?view=default')).toBe(false)
    expect(isNativeBackendAvailable('?view=default', nativeProbe)).toBe(true)
    expect(nativeProbe).toHaveBeenCalledOnce()
  })

  it('fails closed for incomplete or duplicated embedded handshakes', () => {
    for (const search of [
      '?engramHost=1',
      '?engramHost=1&hostOrigin=https%3A%2F%2Fexample.com&hostNonce=invalid',
      `${hostSearch()}&engramHost=1`,
    ]) {
      const nativeProbe = vi.fn(() => true)
      expect(isEngramEmbeddedMode(search)).toBe(true)
      expect(isNativeBackendAvailable(search, nativeProbe)).toBe(false)
      expect(nativeProbe).not.toHaveBeenCalled()
      expect(() => assertNativeBackendAllowed(search)).toThrow('disabled')
      expect(() => assertExternalTelemetryAllowed(search)).toThrow('disabled')
      expect(() => assertArtifactExchangeAllowed(search)).toThrow('disabled')
    }
  })

  it('latches embedded mode for one document after same-document query mutation', () => {
    const hostWindow = {
      location: { search: hostSearch() },
    } as unknown as Window

    expect(isEngramEmbeddedMode(undefined, hostWindow)).toBe(true)
    hostWindow.location.search = '?view=standalone'
    expect(isEngramEmbeddedMode(undefined, hostWindow)).toBe(true)
    expect(isEngramEmbeddedMode('?view=standalone', hostWindow)).toBe(false)
  })

  it('accepts only exact loopback or Tauri origins and bounded nonces', () => {
    for (const origin of [
      'http://localhost:5174',
      'https://127.0.0.1:43821',
      'http://[::1]:5174',
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://tauri.localhost:1420',
    ]) {
      expect(isAllowedEngramHostOrigin(origin)).toBe(true)
    }
    for (const origin of [
      'https://example.com',
      'https://localhost.example.com',
      'http://user@localhost:5174',
      'http://localhost:5174/path',
      'null',
    ]) {
      expect(isAllowedEngramHostOrigin(origin)).toBe(false)
    }

    expect(isAllowedEngramHostNonce(HOST_NONCE)).toBe(true)
    expect(isAllowedEngramHostNonce('short')).toBe(false)
    expect(isAllowedEngramHostNonce(`${'a'.repeat(16)}!`)).toBe(false)
  })

  it('requires one exact value for every handshake parameter', () => {
    expect(readEngramHostConfig(hostSearch())).toEqual({
      origin: HOST_ORIGIN,
      nonce: HOST_NONCE,
    })
    expect(readEngramHostConfig(hostSearch('https://example.com'))).toBeNull()
    expect(readEngramHostConfig(hostSearch(HOST_ORIGIN, 'short'))).toBeNull()
    expect(readEngramHostConfig(`${hostSearch()}&hostNonce=${HOST_NONCE}`)).toBeNull()
  })
})

describe('Engram postMessage bridge', () => {
  it('sends ready and bounded read-only status to the exact host origin', () => {
    const host = createHostWindow()
    const bridge = startEngramHostBridge(host.hostWindow)

    expect(bridge).toMatchObject({ active: true, embedded: true })
    expect(host.listenerCount()).toBe(1)
    expect(host.parent.postMessage).toHaveBeenCalledTimes(2)
    expect(host.parent.postMessage).toHaveBeenNthCalledWith(
      1,
      protocolVector.extension_ready,
      HOST_ORIGIN
    )
    const status = host.parent.postMessage.mock.calls[1]?.[0]
    expect(status).toEqual(protocolVector.initial_status)
    expect(new TextEncoder().encode(JSON.stringify(status)).byteLength).toBeLessThanOrEqual(
      ENGRAM_HOST_MESSAGE_MAX_BYTES
    )

    bridge.stop()
    bridge.stop()
    expect(host.listenerCount()).toBe(0)
  })

  it('returns one active bridge for repeated startup and permits restart after stop', () => {
    const host = createHostWindow()
    const first = startEngramHostBridge(host.hostWindow)
    const second = startEngramHostBridge(host.hostWindow)

    expect(second).toBe(first)
    expect(host.listenerCount()).toBe(1)
    expect(host.parent.postMessage).toHaveBeenCalledTimes(2)

    first.stop()
    expect(first.active).toBe(false)
    const restarted = startEngramHostBridge(host.hostWindow)
    expect(restarted).not.toBe(first)
    expect(restarted.active).toBe(true)
    expect(host.listenerCount()).toBe(1)
    expect(host.parent.postMessage).toHaveBeenCalledTimes(4)
    restarted.stop()
  })

  it('accepts only a matching bounded host.context envelope', () => {
    const host = createHostWindow()
    startEngramHostBridge(host.hostWindow)
    const initialPosts = host.parent.postMessage.mock.calls.length
    const throwingEnvelope = contextEnvelope()
    Object.defineProperty(throwingEnvelope, 'protocol', {
      enumerable: true,
      get: () => {
        throw new Error('malicious accessor')
      },
    })

    const invalidCases: Array<{
      data: unknown
      origin?: string
      source?: unknown
    }> = [
      { data: contextEnvelope(), origin: 'http://localhost:43821' },
      { data: contextEnvelope(), source: { postMessage: vi.fn() } },
      { data: contextEnvelope({ protocol: 'engram.host.v2' }) },
      { data: contextEnvelope({ kind: 'extension.status' }) },
      { data: contextEnvelope({ extension_id: 'sepahead.prisoma' }) },
      { data: contextEnvelope({ nonce: `${HOST_NONCE}x` }) },
      { data: { ...contextEnvelope(), extra: true } },
      { data: contextEnvelope({ payload: 'not-an-object' }) },
      {
        data: contextEnvelope({
          payload: {
            host_api: '1.0',
            authority: 'read-only',
            ncp: { wire: '1.0', extension_wire: '0.8', compatible: true },
            context_nonce: CONTEXT_NONCE,
          },
        }),
      },
      {
        data: contextEnvelope({
          payload: {
            host_api: '1.0',
            authority: 'read-only',
            ncp: { wire: '1.0', extension_wire: '0.8', compatible: false },
            context_nonce: 'short',
          },
        }),
      },
      { data: contextEnvelope({ payload: { study_id: 'unexpected' } }) },
      { data: contextEnvelope({ payload: { text: 'x'.repeat(ENGRAM_HOST_MESSAGE_MAX_BYTES) } }) },
      { data: contextEnvelope({ payload: { value: Number.NaN } }) },
      { data: throwingEnvelope },
    ]

    for (const invalid of invalidCases) {
      host.emit(invalid.data, invalid.origin, invalid.source)
    }
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts)

    host.emit(contextEnvelope())
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts + 1)
    expect(host.parent.postMessage.mock.calls.at(-1)?.[0]).toEqual(protocolVector.accepted_status)

    host.emit(contextEnvelope())
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts + 1)
  })

  it('does not start for standalone or an invalid host handshake', () => {
    for (const search of [
      '?view=standalone',
      hostSearch('https://example.com'),
      hostSearch(HOST_ORIGIN, 'short'),
    ]) {
      const host = createHostWindow(search)
      const bridge = startEngramHostBridge(host.hostWindow)
      expect(bridge.active).toBe(false)
      expect(host.listenerCount()).toBe(0)
      expect(host.parent.postMessage).not.toHaveBeenCalled()
    }
  })

  it('keeps the embedded UI available when the parent rejects a status post', () => {
    const host = createHostWindow()
    host.parent.postMessage.mockImplementation(() => {
      throw new DOMException('Host navigated', 'SecurityError')
    })

    expect(() => startEngramHostBridge(host.hostWindow)).not.toThrow()
    expect(host.listenerCount()).toBe(1)
  })
})
