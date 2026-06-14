/**
 * Neuro-Control Protocol (NCP) client for CREBAIN.
 *
 * Lets CREBAIN ask Engram (Paper2Brain) for a neural simulation — declare what to
 * record (membrane potential / spikes / rate from a neuron, synapse, or
 * population) and what stimuli to inject — then step/run and read the neural data
 * back, for perception, action, both, or neither. Transport-agnostic: provide any
 * `send(message) => Promise<reply>` (see `ws.ts` for a WebSocket implementation
 * against Engram's `/api/neurocontrol/ws`, or wire it to ZenohBridge).
 *
 * Non-invasive: this module is self-contained and touches no existing CREBAIN
 * code. Message shapes mirror Engram's `backend/neurocontrol/schemas/*.schema.json`
 * and `ncp.proto`. Spec: NEURO_CONTROL_PROTOCOL.md.
 */

export const NCP_VERSION = '0.1'

export type Observable = 'spikes' | 'V_m' | 'rate' | 'weight'
export type StimulusKind = 'current_pA' | 'rate_hz' | 'spike_times' | 'weight_set'
export type NetworkRefKind = 'handle' | 'builtin' | 'model_id' | 'spec'

export interface ChannelValue {
  data: number[]
  unit?: string | null
}

export interface NetworkRef {
  kind: NetworkRefKind
  ref: string
  population_sizes?: Record<string, number>
  params?: Record<string, number>
}

export interface RecordTarget {
  port: string
  target: string
  observable: Observable
  ids?: number[]
  cadence_ms?: number
}

export interface StimulusTarget {
  port: string
  target: string
  kind: StimulusKind
  ids?: number[]
}

export interface SimConfig {
  dt_ms?: number
  chunk_ms?: number
  seed?: number | null
  mode?: 'stream' | 'batch'
  duration_ms?: number | null
}

export interface Observation {
  port: string
  target: string
  observable: Observable
  times: number[]
  values: number[]
  senders: number[]
  unit?: string | null
}

export interface NcpReply {
  kind: string
  session_id?: string
  ok?: boolean
  error?: string
}

export interface SessionOpened extends NcpReply {
  kind: 'session_opened'
  backend: string
  resolved: Record<string, number>
}

export interface ObservationFrame extends NcpReply {
  kind: 'observation_frame'
  t: number
  sim_time_ms: number
  records: Record<string, Observation>
  calibrated_posterior: boolean
  is_simulation_output: boolean
}

/** Any transport: serialize `message`, deliver it to Engram's SessionService, and
 *  resolve with the typed reply. */
export type Send = (message: Record<string, unknown>) => Promise<NcpReply>

export class NeuroSimClient {
  constructor(private readonly send: Send) {}

  async open(
    sessionId: string,
    network: NetworkRef,
    record: RecordTarget[],
    stimulus: StimulusTarget[],
    sim: SimConfig = {}
  ): Promise<SessionOpened> {
    const reply = await this.send({
      kind: 'open_session',
      ncp_version: NCP_VERSION,
      session_id: sessionId,
      network,
      record: { targets: record },
      stimulus: { targets: stimulus },
      sim,
    })
    return reply as SessionOpened
  }

  async step(
    sessionId: string,
    stimulus: Record<string, ChannelValue> = {},
    advanceMs?: number
  ): Promise<ObservationFrame> {
    const reply = await this.send({
      kind: 'step_request',
      ncp_version: NCP_VERSION,
      session_id: sessionId,
      advance_ms: advanceMs ?? null,
      stimulus: { kind: 'stimulus_frame', session_id: sessionId, values: stimulus },
    })
    return reply as ObservationFrame
  }

  async run(
    sessionId: string,
    durationMs: number,
    stimulus: Record<string, ChannelValue> = {}
  ): Promise<ObservationFrame> {
    const reply = await this.send({
      kind: 'run_request',
      ncp_version: NCP_VERSION,
      session_id: sessionId,
      duration_ms: durationMs,
      stimulus: { kind: 'stimulus_frame', session_id: sessionId, values: stimulus },
    })
    return reply as ObservationFrame
  }

  async close(sessionId: string): Promise<NcpReply> {
    return this.send({
      kind: 'close_session',
      ncp_version: NCP_VERSION,
      session_id: sessionId,
    })
  }
}
