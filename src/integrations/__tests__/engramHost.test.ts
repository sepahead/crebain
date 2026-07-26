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
  ENGRAM_HOST_PEER_MESSAGE_RATE_MAX,
  ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS,
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
    emit(data: unknown, origin = HOST_ORIGIN, source: unknown = parent, isTrusted = true) {
      const event = { data, origin, source, isTrusted } as MessageEvent
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
  it('publishes the read-only restricted entrypoint contract', () => {
    expect(manifest).toEqual({
      schema_version: '1.0',
      id: CREBAIN_EXTENSION_ID,
      name: 'CREBAIN',
      version: '0.9.0',
      description: 'Read-only restricted embedding for the CREBAIN research visualization runtime.',
      host_api: { minimum: '1.0', maximum: '1.0' },
      entrypoint: {
        kind: 'restricted-local-web',
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
        'Embedded mode disables every CREBAIN Tauri command and native backend path.',
        'The host must deny Engram native IPC before the embedded view becomes interactive.',
        'Embedded mode disables external telemetry connections.',
        'Embedded mode disables local simulation and scene mutation.',
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
      sha256: 'b7f80f0414f22e7210905e26c59fe8eb16a108aa269282c3551b05149e702eca',
    })
    expect(createHash('sha256').update(manifestSource).digest('hex')).toBe(manifestLock.sha256)
  })

  it('binds the host handshake to the shared cross-repository protocol vector', () => {
    expect(protocolVectorLock).toEqual({
      schema_version: 1,
      protocol: ENGRAM_HOST_PROTOCOL,
      hash_revision: 'file_bytes_v1',
      sha256: '693c38f679bb1b2fbf7a719175cbade90a467022f4607ff443ac9c810eb1873c',
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
    const customPrototypeEnvelope = Object.setPrototypeOf(contextEnvelope(), { inherited: true })
    const cyclicEnvelope = contextEnvelope({
      payload: { ...protocolVector.host_context.payload },
    })
    ;(cyclicEnvelope.payload as Record<string, unknown>).ncp = cyclicEnvelope
    const toJsonEnvelope = contextEnvelope()
    const toJson = vi.fn(() => protocolVector.host_context)
    Object.defineProperty(toJsonEnvelope, 'toJSON', { value: toJson })

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
      { data: customPrototypeEnvelope },
      { data: cyclicEnvelope },
      { data: toJsonEnvelope },
    ]

    for (const invalid of invalidCases) {
      host.emit(invalid.data, invalid.origin, invalid.source)
    }
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts)
    expect(toJson).not.toHaveBeenCalled()

    host.emit(contextEnvelope())
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts + 1)
    expect(host.parent.postMessage.mock.calls.at(-1)?.[0]).toEqual(protocolVector.accepted_status)

    host.emit(contextEnvelope())
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts + 2)
    expect(host.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      payload: {
        heartbeat_sequence: 2,
        host_context_received: true,
        context_nonce: CONTEXT_NONCE,
      },
    })

    host.emit(
      contextEnvelope({
        payload: {
          ...protocolVector.host_context.payload,
          context_nonce: `${CONTEXT_NONCE.slice(0, -1)}2`,
        },
      })
    )
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts + 2)
  })

  it('rejects untrusted synthetic events before reading their data', () => {
    const host = createHostWindow()
    startEngramHostBridge(host.hostWindow)
    const initialPosts = host.parent.postMessage.mock.calls.length
    let reads = 0
    const syntheticEnvelope = contextEnvelope()
    Object.defineProperty(syntheticEnvelope, 'protocol', {
      enumerable: true,
      get: () => {
        reads += 1
        return ENGRAM_HOST_PROTOCOL
      },
    })

    host.emit(syntheticEnvelope, HOST_ORIGIN, host.parent, false)

    expect(reads).toBe(0)
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts)
  })

  it('rejects an extra wide context without traversing its values', () => {
    const host = createHostWindow()
    startEngramHostBridge(host.hostWindow)
    const initialPosts = host.parent.postMessage.mock.calls.length
    let leafReads = 0
    const leaf: Record<string, unknown> = {}
    for (let index = 0; index < 32; index += 1) {
      Object.defineProperty(leaf, `leaf${index}`, {
        enumerable: true,
        get: () => {
          leafReads += 1
          return true
        },
      })
    }
    const branch = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`branch${index}`, leaf])
    )
    const wideTree = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`root${index}`, branch])
    )

    host.emit(
      contextEnvelope({
        payload: {
          ...protocolVector.host_context.payload,
          unexpected: wideTree,
        },
      })
    )

    expect(leafReads).toBe(0)
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts)
  })

  it('revokes the bridge after an expected peer floods invalid messages', () => {
    let monotonicNow = 10
    const host = createHostWindow()
    const bridge = startEngramHostBridge(host.hostWindow, {
      monotonicNow: () => monotonicNow,
    })
    const initialPosts = host.parent.postMessage.mock.calls.length

    for (let index = 0; index < ENGRAM_HOST_PEER_MESSAGE_RATE_MAX; index += 1) {
      host.emit(contextEnvelope({ protocol: 'engram.host.invalid' }))
    }
    expect(bridge.active).toBe(true)
    expect(host.listenerCount()).toBe(1)

    host.emit(contextEnvelope())
    expect(bridge.active).toBe(false)
    expect(host.listenerCount()).toBe(0)
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts)

    monotonicNow += ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS
    host.emit(contextEnvelope())
    expect(host.parent.postMessage).toHaveBeenCalledTimes(initialPosts)
  })

  it('uses a rolling window and fails closed if its monotonic clock regresses', () => {
    let monotonicNow = 1_000
    const host = createHostWindow()
    const bridge = startEngramHostBridge(host.hostWindow, {
      monotonicNow: () => monotonicNow,
    })

    host.emit(contextEnvelope())
    monotonicNow += ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS
    host.emit(contextEnvelope())
    expect(bridge.active).toBe(true)

    monotonicNow -= 1
    host.emit(contextEnvelope())
    expect(bridge.active).toBe(false)
    expect(host.listenerCount()).toBe(0)
  })

  it('rejects a burst that straddles a one-second bucket boundary', () => {
    let monotonicNow = 0
    const host = createHostWindow()
    const bridge = startEngramHostBridge(host.hostWindow, {
      monotonicNow: () => monotonicNow,
    })

    host.emit(contextEnvelope({ protocol: 'engram.host.invalid' }))
    monotonicNow = ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS - 1
    for (let index = 1; index < ENGRAM_HOST_PEER_MESSAGE_RATE_MAX; index += 1) {
      host.emit(contextEnvelope({ protocol: 'engram.host.invalid' }))
    }
    expect(bridge.active).toBe(true)

    monotonicNow = ENGRAM_HOST_PEER_MESSAGE_RATE_WINDOW_MS
    host.emit(contextEnvelope({ protocol: 'engram.host.invalid' }))
    expect(bridge.active).toBe(true)
    host.emit(contextEnvelope({ protocol: 'engram.host.invalid' }))
    expect(bridge.active).toBe(false)
  })

  it('reports whether the restricted frame can reach a Tauri custom command', async () => {
    const host = createHostWindow()
    const bridge = startEngramHostBridge(host.hostWindow, {
      nativeIpcProbe: async () => true,
    })

    expect(host.parent.postMessage.mock.calls[1]?.[0]).toMatchObject({
      payload: { tauri_ipc_accessible: null },
    })
    await vi.waitFor(() => {
      expect(host.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        payload: { tauri_ipc_accessible: true },
      })
    })

    bridge.stop()
  })

  it.each([
    ['an inaccessible command', async () => false],
    [
      'a rejected probe',
      async () => {
        throw new Error('command denied')
      },
    ],
  ])('reports false for %s', async (_case, nativeIpcProbe) => {
    const host = createHostWindow()
    const bridge = startEngramHostBridge(host.hostWindow, { nativeIpcProbe })

    await vi.waitFor(() => {
      expect(host.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        payload: { tauri_ipc_accessible: false },
      })
    })

    bridge.stop()
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
