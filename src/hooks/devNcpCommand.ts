import {
  ActionBuffer,
  assertWireFrame,
  maxHorizonLen,
  MAX_TTL_MS,
  type CommandLike,
  type Mode,
  type WireChannels,
} from '@sepahead/ncp'
import { MAX_SCENE_DRONES } from '../lib/sceneLimits'

const MAX_DEV_NCP_CHANNELS = 64
const MAX_DEV_NCP_CHANNEL_VALUES = 64
const MAX_DEV_NCP_HORIZON_STEPS = 1_000
const MAX_DEV_NCP_NAME_BYTES = 128
const MAX_DEV_NCP_UNIT_BYTES = 32
const MAX_DEV_NCP_DT_S = 0.5
const INITIAL_DEV_NCP_DT_S = 0.05
export const MAX_DEV_NCP_KINEMATIC_SCALE = 100
export const MAX_DEV_NCP_ENTITIES = MAX_SCENE_DRONES
const utf8Encoder = new TextEncoder()

export interface DevNcpCommandFrame {
  kind?: unknown
  ncp_version?: unknown
  mode?: unknown
  // Wire 0.8: the old top-level `seq` is gone. `stream` is this frame's own
  // position. `source` is correlation only. The session fields bind the live
  // incarnation.
  stream?: unknown
  source?: unknown
  session?: unknown
  session_id?: unknown
  t?: unknown
  frame_id?: unknown
  ttl_ms?: unknown
  channels?: unknown
  horizon?: unknown
  horizon_dt_ms?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8Length(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

function containsUnsafeText(value: string): boolean {
  return Array.from(value).some(
    (character) => /\s/u.test(character) || character.charCodeAt(0) < 32 || character === '\u007f'
  )
}

/** Keep the development-only kinematic spawn from poisoning the scene graph. */
export function validateDevNcpKinematicSpawn(x: number, y: number, z: number, scale: number): void {
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error('NCP kinematic spawn position must contain finite values')
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_DEV_NCP_KINEMATIC_SCALE) {
    throw new Error(`NCP kinematic spawn scale must be within (0, ${MAX_DEV_NCP_KINEMATIC_SCALE}]`)
  }
}

/** Keep the development harness inside the same entity ceiling as the scene. */
export function assertDevNcpEntityCapacity(kinematicCount: number, physicsCount: number): void {
  if (
    !Number.isSafeInteger(kinematicCount) ||
    kinematicCount < 0 ||
    !Number.isSafeInteger(physicsCount) ||
    physicsCount < 0 ||
    kinematicCount + physicsCount >= MAX_DEV_NCP_ENTITIES
  ) {
    throw new Error(`NCP development entity limit of ${MAX_DEV_NCP_ENTITIES} reached`)
  }
}

function isWireMode(value: unknown): value is Mode {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8Length(value) <= MAX_DEV_NCP_NAME_BYTES &&
    !containsUnsafeText(value)
  )
}

function parseWireChannels(value: unknown, label: string): WireChannels {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }

  // A null-prototype map prevents special keys such as `__proto__` from
  // mutating the normalized channel container.
  const channels = Object.create(null) as WireChannels
  let channelCount = 0
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue
    if (channelCount >= MAX_DEV_NCP_CHANNELS) {
      throw new Error(`${label} exceeds ${MAX_DEV_NCP_CHANNELS} channels`)
    }
    channelCount += 1
    if (
      name.length === 0 ||
      utf8Length(name) > MAX_DEV_NCP_NAME_BYTES ||
      containsUnsafeText(name)
    ) {
      throw new Error(`${label} contains an invalid channel name`)
    }
    const rawChannel = value[name]
    if (!isRecord(rawChannel)) {
      throw new Error(`${label}.${name}.data must be an array`)
    }
    const data = rawChannel.data
    if (!Array.isArray(data)) {
      throw new Error(`${label}.${name}.data must be an array`)
    }
    if (data.length > MAX_DEV_NCP_CHANNEL_VALUES) {
      throw new Error(`${label}.${name}.data exceeds ${MAX_DEV_NCP_CHANNEL_VALUES} values`)
    }
    if (
      !data.every((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    ) {
      throw new Error(`${label}.${name}.data must contain only finite numbers`)
    }
    const unit = rawChannel.unit
    if (
      unit !== undefined &&
      unit !== null &&
      (typeof unit !== 'string' ||
        utf8Length(unit) > MAX_DEV_NCP_UNIT_BYTES ||
        containsUnsafeText(unit))
    ) {
      throw new Error(`${label}.${name}.unit must be a short string or null`)
    }
    channels[name] = { data: [...data], unit }
  }
  return channels
}

function requireVelocitySetpoint(channels: WireChannels, label: string): void {
  const velocity = channels.velocity_setpoint
  if (
    velocity?.unit !== 'm/s' ||
    velocity.data.length !== 3 ||
    !velocity.data.every(Number.isFinite)
  ) {
    throw new Error(`${label}.velocity_setpoint must be a finite m/s vec3`)
  }
}

/** Normalize and validate the dev-only NCP action ingress against published wire 0.8. */
export function normalizeDevNcpCommand(input: unknown): CommandLike {
  if (!isRecord(input)) throw new Error('NCP command must be an object')
  if (input.kind !== 'command_frame') {
    throw new Error('NCP command kind must be command_frame')
  }
  const mode = input.mode === undefined ? 'hold' : input.mode
  if (!isWireMode(mode)) throw new Error('NCP command mode is invalid')

  const stream = input.stream
  if (!isRecord(stream)) throw new Error('NCP command stream must be an object')
  const seq = stream.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error('NCP command stream.seq must be a safe integer greater than zero')
  }
  const ncpVersion = input.ncp_version
  if (typeof ncpVersion !== 'string') {
    throw new Error('NCP command ncp_version must be a string')
  }

  const streamOut: CommandLike['stream'] = { epoch: stream.epoch as string, seq }
  const session = input.session as CommandLike['session']
  const sessionId = input.session_id as CommandLike['session_id']

  // Fail-safe modes never retain attacker-controlled channel or horizon data.
  if (mode !== 'active') {
    const normalized = {
      kind: 'command_frame',
      ncp_version: ncpVersion,
      mode,
      stream: streamOut,
      session,
      session_id: sessionId,
      ttl_ms: 200,
      channels: Object.create(null) as WireChannels,
    }
    assertWireFrame(normalized, 'command_frame')
    return normalized
  }

  const ttlMs = input.ttl_ms === undefined ? 200 : input.ttl_ms
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new Error(`NCP command ttl_ms must be within (0, ${MAX_TTL_MS}]`)
  }
  if (input.t !== undefined && (typeof input.t !== 'number' || !Number.isFinite(input.t))) {
    throw new Error('NCP command timestamp must be finite')
  }
  if (
    input.frame_id !== undefined &&
    (typeof input.frame_id !== 'string' ||
      utf8Length(input.frame_id) > MAX_DEV_NCP_NAME_BYTES ||
      containsUnsafeText(input.frame_id))
  ) {
    throw new Error('NCP command frame_id is invalid')
  }

  const channels = parseWireChannels(input.channels ?? {}, 'NCP command channels')
  requireVelocitySetpoint(channels, 'NCP command channels')

  let horizon: WireChannels[] | undefined
  let horizonDtMs: number | null | undefined
  if (input.horizon_dt_ms !== undefined && input.horizon_dt_ms !== null) {
    if (
      typeof input.horizon_dt_ms !== 'number' ||
      !Number.isFinite(input.horizon_dt_ms) ||
      input.horizon_dt_ms <= 0
    ) {
      throw new Error('NCP command horizon_dt_ms must be finite and positive')
    }
    horizonDtMs = input.horizon_dt_ms
  } else {
    horizonDtMs = input.horizon_dt_ms
  }
  if (input.horizon !== undefined) {
    if (!Array.isArray(input.horizon)) throw new Error('NCP command horizon must be an array')
    if (input.horizon.length > MAX_DEV_NCP_HORIZON_STEPS) {
      throw new Error(`NCP command horizon exceeds ${MAX_DEV_NCP_HORIZON_STEPS} steps`)
    }
    if (input.horizon.length > 0 && typeof horizonDtMs !== 'number') {
      throw new Error('NCP command horizon requires horizon_dt_ms')
    }
    const allowedSteps =
      typeof horizonDtMs === 'number'
        ? Math.min(MAX_DEV_NCP_HORIZON_STEPS, maxHorizonLen(ttlMs, horizonDtMs))
        : 0
    if (input.horizon.length > allowedSteps) {
      throw new Error(
        `NCP command horizon exceeds its ttl or ${MAX_DEV_NCP_HORIZON_STEPS}-step cap`
      )
    }
    horizon = input.horizon.map((entry, index) => {
      const step = parseWireChannels(entry, `NCP command horizon[${index}]`)
      requireVelocitySetpoint(step, `NCP command horizon[${index}]`)
      return step
    })
  }

  const normalized = {
    kind: 'command_frame',
    ncp_version: ncpVersion,
    mode,
    stream: streamOut,
    session,
    session_id: sessionId,
    t: typeof input.t === 'number' ? input.t : undefined,
    frame_id: typeof input.frame_id === 'string' ? input.frame_id : undefined,
    ttl_ms: ttlMs,
    channels,
    horizon,
    horizon_dt_ms: horizonDtMs,
  }
  // Ask the pinned NCP implementation to validate only the bounded, copied
  // frame. It must never traverse the original caller-owned object first.
  assertWireFrame(normalized, 'command_frame')
  return normalized
}

/** Latch raw ESTOP first, then admit only a fully validated wire-0.8 command. */
export function ingestDevNcpCommand(
  buffer: ActionBuffer,
  nowS: number,
  input: unknown
): CommandLike {
  if (isRecord(input) && input.mode === 'estop') {
    buffer.onCommand(nowS, { mode: 'estop', stream: { epoch: '', seq: 0 }, channels: {} })
  }
  if (!Number.isFinite(nowS) || nowS < 0) throw new Error('NCP receive time is invalid')
  const command = normalizeDevNcpCommand(input)
  buffer.onCommand(nowS, command)
  return command
}

/** Per-entity command state. Reset replaces the buffer so old commands cannot revive. */
export class DevNcpCommandStream {
  private buffer = new ActionBuffer()

  ingest(nowS: number, input: unknown): CommandLike {
    return ingestDevNcpCommand(this.buffer, nowS, input)
  }

  active(nowS: number): WireChannels | null {
    return this.buffer.active(nowS)
  }

  isEstopped(): boolean {
    return this.buffer.isEstopped()
  }

  reset(): void {
    this.buffer = new ActionBuffer()
  }
}

/** Integrate only monotonic local elapsed time. */
export function boundedDevNcpElapsed(previousS: number | null, nowS: number): number {
  if (!Number.isFinite(nowS)) return 0
  if (previousS === null) return INITIAL_DEV_NCP_DT_S
  if (!Number.isFinite(previousS) || nowS < previousS) return 0
  return Math.min(nowS - previousS, MAX_DEV_NCP_DT_S)
}
