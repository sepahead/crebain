import { describe, expect, it, vi } from 'vitest'
import { ActionBuffer, NCP_VERSION } from '@sepahead/ncp'
import {
  DevNcpCommandStream,
  boundedDevNcpElapsed,
  commitSimulationPauseState,
  ingestDevNcpCommand,
  normalizeDevNcpCommand,
} from '../useDroneController'

// Wire-0.8 identity fixtures: canonical lowercase UUIDv4 stream.epoch /
// session.generation and a valid session_id, so a fixture passes assertWireFrame.
const TEST_EPOCH = '00000000-0000-4000-8000-000000000001'
const TEST_GEN = '00000000-0000-4000-8000-0000000000a2'
const TEST_SID = 'sess'

function activeCommand(seq = 1) {
  return {
    kind: 'command_frame',
    ncp_version: NCP_VERSION,
    mode: 'active',
    stream: { epoch: TEST_EPOCH, seq },
    session: { generation: TEST_GEN },
    session_id: TEST_SID,
    t: 1,
    frame_id: 'map',
    ttl_ms: 200,
    channels: {
      velocity_setpoint: { data: [1, 2, 3], unit: 'm/s' },
    },
  }
}

describe('dev NCP command ingress', () => {
  it('commits pause transitions from a synchronous snapshot without replayable side effects', () => {
    const pauseState = { current: true }
    const commit = vi.fn<(paused: boolean) => void>()
    const resetTime = vi.fn<() => void>()

    commitSimulationPauseState(pauseState, commit, resetTime, false)
    commitSimulationPauseState(pauseState, commit, resetTime, false)
    commitSimulationPauseState(pauseState, commit, resetTime, true)
    commitSimulationPauseState(pauseState, commit, resetTime, false)

    expect(pauseState.current).toBe(false)
    expect(commit.mock.calls.map(([paused]) => paused)).toEqual([false, false, true, false])
    expect(commit.mock.calls.every(([paused]) => typeof paused === 'boolean')).toBe(true)
    expect(resetTime).toHaveBeenCalledTimes(2)
  })

  it('accepts a complete published wire-0.8 command', () => {
    const command = normalizeDevNcpCommand(activeCommand())
    expect(command.mode).toBe('active')
    expect(command.channels.velocity_setpoint?.data).toEqual([1, 2, 3])
  })

  it('normalizes omitted fail-safe fields to a minimal HOLD', () => {
    const command = normalizeDevNcpCommand({
      kind: 'command_frame',
      ncp_version: NCP_VERSION,
      stream: { epoch: TEST_EPOCH, seq: 1 },
      session: { generation: TEST_GEN },
      session_id: TEST_SID,
    })
    expect(command).toMatchObject({ mode: 'hold', stream: { seq: 1 }, ttl_ms: 200 })
    expect(command.channels).toEqual({})
  })

  it('rejects missing or wrong envelope fields', () => {
    for (const patch of [
      { kind: undefined },
      { kind: 'sensor_frame' },
      { ncp_version: undefined },
      { ncp_version: '0.6' },
      { stream: { epoch: TEST_EPOCH, seq: 0 } },
      { stream: { epoch: TEST_EPOCH, seq: 1.5 } },
      { stream: { epoch: TEST_EPOCH, seq: Number.MAX_SAFE_INTEGER + 1 } },
      { stream: { epoch: 'not-a-uuid', seq: 1 } },
      { session: { generation: 'not-a-uuid' } },
      { session_id: '' },
    ]) {
      expect(() => normalizeDevNcpCommand({ ...activeCommand(), ...patch })).toThrow()
    }
  })

  it('preserves an additive mode but only the literal active mode can actuate', () => {
    const stream = new DevNcpCommandStream()
    const command = stream.ingest(1, { ...activeCommand(), mode: 'future_mode' })
    expect(command.mode).toBe('future_mode')
    expect(command.channels).toEqual({})
    expect(stream.active(1)).toBeNull()
  })

  it('rejects malformed velocity channels', () => {
    for (const velocity_setpoint of [
      { data: [1, 2, 3], unit: 'km/h' },
      { data: [1, 2], unit: 'm/s' },
      { data: [1, 2, 3, 4], unit: 'm/s' },
      { data: [1, Number.NaN, 3], unit: 'm/s' },
      { data: '1,2,3', unit: 'm/s' },
    ]) {
      expect(() =>
        normalizeDevNcpCommand({
          ...activeCommand(),
          channels: { velocity_setpoint },
        })
      ).toThrow()
    }
  })

  it('normalizes channel maps without a prototype and applies UTF-8 text bounds', () => {
    const channels = JSON.parse(
      '{"__proto__":{"data":[0]},"velocity_setpoint":{"data":[1,2,3],"unit":"m/s"}}'
    ) as Record<string, unknown>
    const command = normalizeDevNcpCommand({ ...activeCommand(), channels })
    expect(Object.getPrototypeOf(command.channels)).toBeNull()
    expect(Object.hasOwn(command.channels, '__proto__')).toBe(true)

    expect(() =>
      normalizeDevNcpCommand({
        ...activeCommand(),
        channels: {
          velocity_setpoint: { data: [1, 2, 3], unit: 'm/s' },
          extra: { data: [0], unit: '😀'.repeat(9) },
        },
      })
    ).toThrow(/short string/)
  })

  it('bounds and validates predictive horizons', () => {
    const step = { velocity_setpoint: { data: [0.5, 0, 0], unit: 'm/s' } }
    expect(() =>
      normalizeDevNcpCommand({
        ...activeCommand(),
        ttl_ms: 100,
        horizon_dt_ms: 50,
        horizon: [step, step],
      })
    ).not.toThrow()
    expect(() =>
      normalizeDevNcpCommand({
        ...activeCommand(),
        ttl_ms: 100,
        horizon_dt_ms: 50,
        horizon: [step, step, step],
      })
    ).toThrow(/horizon|ttl/)
    expect(() => normalizeDevNcpCommand({ ...activeCommand(), horizon: [step] })).toThrow(
      /horizon_dt_ms/
    )
    expect(() =>
      normalizeDevNcpCommand({
        ...activeCommand(),
        horizon_dt_ms: 50,
        horizon: [{ velocity_setpoint: { data: [Number.NaN, 0, 0], unit: 'm/s' } }],
      })
    ).toThrow(/finite/)
    expect(() =>
      normalizeDevNcpCommand({
        ...activeCommand(),
        ttl_ms: 60_000,
        horizon_dt_ms: 1,
        horizon: new Array(1_001).fill(step),
      })
    ).toThrow(/1000 steps/)

    let visited = false
    const unvisitedStep = Object.defineProperty({}, 'velocity_setpoint', {
      get() {
        visited = true
        return step.velocity_setpoint
      },
    })
    expect(() =>
      normalizeDevNcpCommand({
        ...activeCommand(),
        ttl_ms: 60_000,
        horizon_dt_ms: 1,
        horizon: new Array(1_001).fill(unvisitedStep),
      })
    ).toThrow(/1000 steps/)
    expect(visited).toBe(false)
  })

  it('does not buffer malformed active commands', () => {
    const buffer = new ActionBuffer()
    expect(() =>
      ingestDevNcpCommand(buffer, 1, { ...activeCommand(), kind: 'sensor_frame' })
    ).toThrow()
    expect(buffer.active(1)).toBeNull()
  })

  it('latches a raw ESTOP before validation', () => {
    const buffer = new ActionBuffer()
    expect(() => ingestDevNcpCommand(buffer, Number.NaN, { mode: 'estop' })).toThrow()
    expect(buffer.isEstopped()).toBe(true)
  })

  it('isolates entity streams and requires a fresh command after reset', () => {
    const first = new DevNcpCommandStream()
    const second = new DevNcpCommandStream()
    first.ingest(1, activeCommand(1))
    second.ingest(1, {
      ...activeCommand(1),
      channels: { velocity_setpoint: { data: [9, 8, 7], unit: 'm/s' } },
    })
    expect(first.active(1)?.velocity_setpoint?.data).toEqual([1, 2, 3])
    expect(second.active(1)?.velocity_setpoint?.data).toEqual([9, 8, 7])

    expect(() => first.ingest(Number.NaN, { mode: 'estop' })).toThrow()
    expect(first.isEstopped()).toBe(true)
    first.reset()
    expect(first.isEstopped()).toBe(false)
    expect(first.active(1)).toBeNull()
    first.ingest(1, activeCommand(1))
    expect(first.active(1)?.velocity_setpoint?.data).toEqual([1, 2, 3])
  })

  it('lets a defaulted HOLD suppress the prior active command', () => {
    const stream = new DevNcpCommandStream()
    stream.ingest(1, activeCommand(1))
    stream.ingest(1.01, {
      kind: 'command_frame',
      ncp_version: NCP_VERSION,
      stream: { epoch: TEST_EPOCH, seq: 2 },
      session: { generation: TEST_GEN },
      session_id: TEST_SID,
    })
    expect(stream.active(1.01)).toBeNull()
  })

  it('derives integration steps from bounded monotonic local time', () => {
    expect(boundedDevNcpElapsed(null, 10)).toBe(0.05)
    expect(boundedDevNcpElapsed(10, 10.01)).toBeCloseTo(0.01)
    expect(boundedDevNcpElapsed(10.01, 10.02)).toBeCloseTo(0.01)
    expect(boundedDevNcpElapsed(10, 9)).toBe(0)
    expect(boundedDevNcpElapsed(10, 20)).toBe(0.5)
  })
})
