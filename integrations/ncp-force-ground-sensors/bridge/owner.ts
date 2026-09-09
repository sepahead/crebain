import {
  EnvironmentOwner,
  observationEnvelopeBytes,
  type ObservationHandle,
  type EnvironmentGraphics,
} from '../../../src/environment/EnvironmentOwner'
import {
  FORCE_GROUND_PROFILE,
  type EnvironmentPlan,
} from '../../../src/environment/EnvironmentState'
import { exactJson } from '../../../src/environment/ExactJson'
import type { ScheduledDynamicsAction } from '../../../src/physics/DeterministicDroneWorld'
import type { ForceControllerConfig } from '../../../src/physics/ForceAttitudeController'
import { keys, object, payloadBytes, rows, sha256, unwrapFloats, validateFrozen } from './codec'

export interface LeaseOwner {
  readonly ownerId: string
  schedule(action: ScheduledDynamicsAction): void
  advance(): Promise<ObservationHandle>
  readObservation(handle: ObservationHandle): string
  releaseObservation(handle: ObservationHandle): void
  retire(): Promise<void>
}
export type OwnerFactory = (plan: EnvironmentPlan, maximum: number) => Promise<LeaseOwner>
export type GraphicsFactory = (json: string) => Promise<EnvironmentGraphics>

export function actualFactory(graphics: GraphicsFactory): OwnerFactory {
  return (plan, maximum) =>
    EnvironmentOwner.prepare(
      plan,
      graphics,
      maximum,
      observationEnvelopeBytes(plan.profile, maximum)
    )
}

interface Retained {
  handle: ObservationHandle
  payloads: Array<{ sensor_id: string; kind: string; bytes: Buffer }>
}

/** One sequential private owner; no privileged observation is exported. */
export class SensorBridge {
  private owner: LeaseOwner | null = null
  private plan: (EnvironmentPlan & { controller: ForceControllerConfig }) | null = null
  private horizon = 0
  private tick = 0
  private previous: string | null = null
  private accepted: string | null = null
  private retained: Retained | null = null
  private closed = false
  private cleanupFailed = false
  private preparing: Promise<LeaseOwner> | null = null
  private cleanup: Promise<boolean> | null = null
  private scene = ''
  private planSha = ''

  constructor(private readonly factory: OwnerFactory) {}

  async retire(): Promise<boolean> {
    this.closed = true
    this.cleanup ??= (async () => {
      try {
        // Pending construction is an owned resource. An empty owner slot is
        // insufficient evidence of retirement while this promise remains open.
        const owner = this.owner ?? (await this.preparing)
        await owner?.retire()
        this.retained = null
      } catch {
        this.cleanupFailed = true
      }
      return !this.cleanupFailed
    })()
    return this.cleanup
  }

  async command(input: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Retired bridge')
    switch (input.kind) {
      case 'prepare': {
        if (this.owner || this.plan) throw new Error('Already prepared')
        const specification = unwrapFloats(input.specification)
        validateFrozen('Specification', specification, 'application')
        const spec = specification as Omit<
          EnvironmentPlan & { controller: ForceControllerConfig },
          'runId' | 'sourceIdentity'
        >
        if (
          spec.profile !== FORCE_GROUND_PROFILE ||
          spec.drones.length !== 1 ||
          spec.scene.solids.length ||
          !(
            spec.scene.rgbCameras.length ||
            spec.scene.thermalCameras.length ||
            spec.scene.microphones.length
          )
        )
          throw new Error('Force-ground envelope')
        for (const roster of [
          spec.scene.materials,
          spec.scene.rgbCameras,
          spec.scene.thermalCameras,
          spec.scene.microphones,
        ])
          if (roster.some((row, index) => index > 0 && roster[index - 1].id >= row.id))
            throw new Error('Unsorted source roster')
        for (const camera of [...spec.scene.rgbCameras, ...spec.scene.thermalCameras])
          if (camera.position.every((v, i) => v === camera.target[i]))
            throw new Error('Camera direction')
        if (
          spec.scene.thermalCameras.some((c) => c.width > 320 || c.height > 320) ||
          spec.acoustic.referenceDistanceM > spec.acoustic.maximumRangeM
        )
          throw new Error('Source configuration bounds')
        const plan = {
          ...spec,
          runId: `ncp-${String(input.run_id)}`,
          sourceIdentity: String(input.source_identity),
        } as EnvironmentPlan & { controller: ForceControllerConfig }
        const maximum =
          [...plan.scene.rgbCameras, ...plan.scene.thermalCameras].reduce(
            (sum, camera) => sum + camera.width * camera.height * 4,
            0
          ) +
          plan.scene.microphones.length * 134 * 8
        this.plan = plan
        this.horizon = Number(input.planned_ticks)
        this.scene = sha256(exactJson(plan.scene))
        this.planSha = sha256(exactJson(plan))
        this.preparing = this.factory(plan, maximum)
        this.owner = await this.preparing
        if (this.closed) {
          await this.retire()
          throw new Error('Preparation completed after parent retirement')
        }
        return { kind: 'prepared', engine_owner_id: this.owner.ownerId, scene_sha256: this.scene }
      }
      case 'advance': {
        const owner = this.owner
        const plan = this.plan
        if (
          !owner ||
          !plan ||
          this.retained ||
          input.tick !== this.tick + 1 ||
          Number(input.tick) > this.horizon ||
          input.previous_engine_batch_sha256 !== this.previous
        )
          throw new Error('Advance state')
        const action = object(unwrapFloats(input.action))
        validateFrozen('Action', action, 'application')
        if (action.kind === 'hold') {
          if (
            !this.accepted ||
            action.accepted_action_request_digest !== this.accepted ||
            input.accepted_action_request_digest !== this.accepted
          )
            throw new Error('Held target identity')
        } else {
          const delta = Number(action.heading_rad) - plan.controller.referenceHeadingRad
          if (
            Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) > 0.2 ||
            Math.abs(Number(action.altitude_m) - plan.controller.referenceAltitudeM) > 0.5
          )
            throw new Error('Prepared controller neighborhood')
          owner.schedule({
            tick: Number(input.tick),
            droneId: plan.drones[0].id,
            armed: Boolean(action.armed),
            control: {
              kind: 'force_attitude_height',
              roll_rad: Number(action.roll_rad),
              pitch_rad: Number(action.pitch_rad),
              heading_rad: Number(action.heading_rad),
              altitude_m: Number(action.altitude_m),
            },
          })
        }
        const handle = await owner.advance()
        if (this.closed) throw new Error('Advance completed after parent retirement')
        const json = owner.readObservation(handle)
        if (
          handle.ownerId !== owner.ownerId ||
          handle.tick !== input.tick ||
          sha256(json) !== handle.sha256
        )
          throw new Error('Retained lease identity')
        const batch = keys(JSON.parse(json), [
          'profile',
          'environmentProfile',
          'planSha256',
          'privilegedControl',
          'ownerId',
          'ancestry',
          'sourceIdentity',
          'sceneSha256',
          'tick',
          'time',
          'previousBatchSha256',
          'privilegedReference',
          'pressure',
          'graphics',
        ])
        const time = keys(batch.time, ['numerator', 'denominator', 'unit'])
        if (
          batch.profile !== 'crebain.force-ground-observation.v1' ||
          batch.environmentProfile !== FORCE_GROUND_PROFILE ||
          batch.planSha256 !== this.planSha ||
          batch.ownerId !== owner.ownerId ||
          batch.ancestry !== null ||
          batch.sourceIdentity !== plan.sourceIdentity ||
          batch.sceneSha256 !== this.scene ||
          batch.tick !== input.tick ||
          batch.previousBatchSha256 !== this.previous ||
          time.numerator !== input.tick ||
          time.denominator !== 120 ||
          time.unit !== 'second'
        )
          throw new Error('Actual source observation join')
        const graphics = keys(batch.graphics, [
          'generation',
          'planSha256',
          'inputSha256',
          'tick',
          'rowOrigin',
          'rgb',
          'thermal',
        ])
        if (graphics.tick !== input.tick || graphics.rowOrigin !== 'bottom-left')
          throw new Error('Graphics clock and axes')
        const payloads: Retained['payloads'] = []
        for (const [modality, cameras, kind, prefix] of [
          ['rgb', plan.scene.rgbCameras, 'rgba8', 'rgb'],
          ['thermal', plan.scene.thermalCameras, 'radiance', 'thermal'],
        ] as const) {
          const due = cameras.filter((c) => Number(input.tick) % c.periodTicks === 0)
          const actual = rows(graphics[modality])
          if (actual.length !== due.length) throw new Error('Due graphics roster')
          for (let index = 0; index < due.length; index++) {
            const camera = due[index]
            const frame = keys(
              actual[index],
              modality === 'rgb'
                ? ['cameraId', 'width', 'height', 'encoding', 'bytesBase64']
                : ['cameraId', 'width', 'height', 'encoding', 'unit', 'bytesBase64']
            )
            if (
              frame.cameraId !== camera.id ||
              frame.width !== camera.width ||
              frame.height !== camera.height ||
              frame.encoding !== (modality === 'rgb' ? 'rgba8-srgb' : 'float32-le') ||
              (modality === 'thermal' && frame.unit !== 'W/(m2 sr)')
            )
              throw new Error('Graphics tensor identity')
            payloads.push({
              sensor_id: `${prefix}:${camera.id}`,
              kind,
              bytes: payloadBytes(frame.bytesBase64, camera.width * camera.height * 4, kind),
            })
          }
        }
        const pressure = keys(batch.pressure, [
          'sampleStart',
          'sampleEnd',
          'sampleRateHz',
          'unit',
          'channels',
        ])
        const start = Math.floor(((Number(input.tick) - 1) * 16000) / 120)
        const end = Math.floor((Number(input.tick) * 16000) / 120)
        const channels = rows(pressure.channels)
        if (
          pressure.sampleStart !== start ||
          pressure.sampleEnd !== end ||
          pressure.sampleRateHz !== 16000 ||
          pressure.unit !== 'pascal' ||
          channels.length !== plan.scene.microphones.length
        )
          throw new Error('Pressure clock and roster')
        for (let index = 0; index < channels.length; index++) {
          const channel = keys(channels[index], ['microphoneId', 'encoding', 'bytesBase64'])
          const microphone = plan.scene.microphones[index]
          if (channel.microphoneId !== microphone.id || channel.encoding !== 'float64-le')
            throw new Error('Pressure tensor identity')
          payloads.push({
            sensor_id: `pressure:${microphone.id}`,
            kind: 'pressure',
            bytes: payloadBytes(channel.bytesBase64, (end - start) * 8, 'pressure'),
          })
        }
        this.retained = { handle, payloads }
        this.accepted = String(input.accepted_action_request_digest)
        this.tick = Number(input.tick)
        const previous = this.previous
        this.previous = handle.sha256
        return {
          kind: 'advanced',
          batch: {
            engine_owner_id: owner.ownerId,
            source_identity: plan.sourceIdentity,
            scene_sha256: this.scene,
            body_tick: handle.tick,
            engine_batch_sha256: handle.sha256,
            previous_engine_batch_sha256: previous,
            payloads: payloads.map((row) => ({
              sensor_id: row.sensor_id,
              kind: row.kind,
              byte_length: row.bytes.length,
              payload_sha256: sha256(row.bytes),
            })),
          },
        }
      }
      case 'read_chunk': {
        const retained = this.exactLease(input)
        const payload = retained.payloads.find((row) => row.sensor_id === input.sensor_id)
        const offset = Number(input.offset)
        const count = Number(input.max_bytes)
        if (!payload || offset + count > payload.bytes.length) throw new Error('Chunk extent')
        const bytes = payload.bytes.subarray(offset, offset + count)
        return {
          kind: 'chunk',
          tick: retained.handle.tick,
          engine_batch_sha256: retained.handle.sha256,
          sensor_id: payload.sensor_id,
          offset,
          bytes_base64: bytes.toString('base64'),
          chunk_sha256: sha256(bytes),
        }
      }
      case 'release_lease': {
        const retained = this.exactLease(input)
        this.owner?.releaseObservation(retained.handle)
        this.retained = null
        return {
          kind: 'released',
          tick: retained.handle.tick,
          engine_batch_sha256: retained.handle.sha256,
        }
      }
      case 'retire':
        if (!(await this.retire())) throw new Error('Unresolved native retirement')
        return { kind: 'retired', cleanup_confirmed: true }
      default:
        throw new Error('Unknown private operation')
    }
  }

  private exactLease(input: Record<string, unknown>): Retained {
    if (
      !this.retained ||
      this.retained.handle.tick !== input.tick ||
      this.retained.handle.sha256 !== input.engine_batch_sha256
    )
      throw new Error('Stale native lease')
    return this.retained
  }
}
