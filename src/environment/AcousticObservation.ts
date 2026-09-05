import { copyPlainData } from '../lib/copyPlainData'
import {
  closedKeys,
  finiteRange,
  ownSceneSpec,
  segmentBlocked,
  type SceneSpec,
  type Vec3,
} from './SceneSpec'

export interface AcousticConfig {
  profile: 'crebain.discrete-direct-acoustic.v1'
  sampleRateHz: 16000
  soundSpeedMps: number
  maximumRangeM: number
  referenceDistanceM: number
  referencePressurePa: number
  bladeCount: 2
  blockedGain: number
  noiseStdPa: number
  seed: number
}

export interface MechanicalSource {
  position: Vec3
  /** Actual four-rotor state, in the existing physics roster order. */
  rpm: [number, number, number, number]
}

export interface PressureBlock {
  sampleStart: number
  sampleEnd: number
  sampleRateHz: 16000
  unit: 'pascal'
  /** Each row follows the plan's ordered microphone roster. No truth-position labels. */
  channels: Float64Array[]
}

export function ownAcousticConfig(input: AcousticConfig): AcousticConfig {
  const config = copyPlainData(input)
  closedKeys(config, [
    'profile',
    'sampleRateHz',
    'soundSpeedMps',
    'maximumRangeM',
    'referenceDistanceM',
    'referencePressurePa',
    'bladeCount',
    'blockedGain',
    'noiseStdPa',
    'seed',
  ])
  if (
    config.profile !== 'crebain.discrete-direct-acoustic.v1' ||
    config.sampleRateHz !== 16000 ||
    config.bladeCount !== 2
  )
    throw new Error('Unsupported acoustic model')
  finiteRange(config.soundSpeedMps, 300, 400)
  finiteRange(config.maximumRangeM, 1, 128)
  finiteRange(config.referenceDistanceM, 0.1, config.maximumRangeM)
  finiteRange(config.referencePressurePa, 0, 10)
  finiteRange(config.blockedGain, 0, 1)
  finiteRange(config.noiseStdPa, 0, 1)
  finiteRange(config.seed, 0, 0xffff_ffff)
  if (!Number.isSafeInteger(config.seed)) throw new Error('Acoustic seed must be an integer')
  return config
}

/**
 * Explicit discrete forward model. Poses/RPM are held within each 120 Hz block.
 * It omits moving-source retarded geometry, diffraction, echoes, and calibrated directivity.
 */
export class AcousticState {
  readonly #config: AcousticConfig
  readonly #microphones: Vec3[]
  readonly #solids: SceneSpec['solids']
  readonly #history: Float64Array[]
  readonly #phases: number[][]
  #noise: number[]
  #tick = 0
  #sample = 0

  constructor(config: AcousticConfig, scene: SceneSpec, entityCount: number) {
    this.#config = ownAcousticConfig(config)
    if (!Number.isSafeInteger(entityCount) || entityCount < 1 || entityCount > 256)
      throw new Error('Acoustic entity roster is outside the operating envelope')
    const ownedScene = ownSceneSpec(scene)
    this.#microphones = copyPlainData(ownedScene.microphones.map((row) => row.position))
    this.#solids = ownedScene.solids
    if (this.#microphones.length > 4) throw new Error('Acoustic microphone roster is over budget')
    const length = Math.ceil((this.#config.maximumRangeM / this.#config.soundSpeedMps) * 16000) + 2
    this.#history = Array.from({ length: entityCount }, () => new Float64Array(length))
    this.#phases = Array.from({ length: entityCount }, () => [0, 0, 0, 0])
    this.#noise = this.#microphones.map(
      (_position, index) => (this.#config.seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0
    )
  }

  private normal(channel: number): number {
    const uniform = (): number => {
      this.#noise[channel] = (Math.imul(1664525, this.#noise[channel]) + 1013904223) >>> 0
      return (this.#noise[channel] + 1) / 0x1_0000_0001
    }
    return Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
  }

  advance(sources: MechanicalSource[]): PressureBlock {
    sources = copyPlainData(sources)
    if (this.#tick >= 7200) throw new Error('Acoustic duration budget exhausted')
    if (sources.length !== this.#history.length) throw new Error('Acoustic source roster changed')
    for (const source of sources) {
      closedKeys(source, ['position', 'rpm'])
      if (source.position.length !== 3 || source.rpm.length !== 4)
        throw new Error('Invalid acoustic source axes')
      source.position.forEach((value) => finiteRange(value, -1000, 1000))
      source.rpm.forEach((value) => finiteRange(value, 0, 15000))
    }
    const start = this.#sample
    const end = Math.floor(((this.#tick + 1) * 16000) / 120)
    const channels = this.#microphones.map(() => new Float64Array(end - start))
    const paths = this.#microphones.map((microphone) =>
      sources.map((source) => {
        const distance = Math.hypot(
          ...microphone.map((value, axis) => value - source.position[axis])
        )
        const delay =
          (Math.max(distance, this.#config.referenceDistanceM) / this.#config.soundSpeedMps) * 16000
        const gain =
          distance > this.#config.maximumRangeM
            ? 0
            : (this.#config.referenceDistanceM /
                Math.max(distance, this.#config.referenceDistanceM)) *
              (segmentBlocked(source.position, microphone, this.#solids)
                ? this.#config.blockedGain
                : 1)
        return { delay, gain }
      })
    )
    const historyLength = this.#history[0].length
    for (let sample = start; sample < end; sample++) {
      sources.forEach((source, sourceIndex) => {
        let pressure = 0
        source.rpm.forEach((rpm, rotor) => {
          const phase = this.#phases[sourceIndex][rotor]
          const fundamental =
            Math.sin(phase) + 0.3 * Math.sin(phase * 2) + 0.1 * Math.sin(phase * 3)
          pressure += (this.#config.referencePressurePa * (rpm / 15000) ** 2 * fundamental) / 4
          this.#phases[sourceIndex][rotor] =
            (phase + (2 * Math.PI * this.#config.bladeCount * rpm) / 60 / 16000) % (2 * Math.PI)
        })
        this.#history[sourceIndex][sample % historyLength] = pressure
      })
      channels.forEach((channel, microphone) => {
        let pressure = this.#config.noiseStdPa * this.normal(microphone)
        paths[microphone].forEach(({ delay, gain }, source) => {
          if (gain === 0) return
          const at = sample - delay
          const lower = Math.floor(at)
          const fraction = at - lower
          const read = (index: number): number =>
            index < 0 ? 0 : this.#history[source][index % historyLength]
          pressure += gain * ((1 - fraction) * read(lower) + fraction * read(lower + 1))
        })
        channel[sample - start] = pressure
      })
    }
    this.#sample = end
    this.#tick++
    return { sampleStart: start, sampleEnd: end, sampleRateHz: 16000, unit: 'pascal', channels }
  }

  checkpoint(): unknown {
    return {
      config: this.#config,
      microphones: this.#microphones,
      solids: this.#solids,
      phases: this.#phases.map((row) => [...row]),
      history: this.#history.map((row) => Array.from(row)),
      noiseStates: [...this.#noise],
      tick: this.#tick,
      sample: this.#sample,
    }
  }
}
