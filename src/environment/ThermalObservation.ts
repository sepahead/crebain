import { copyPlainData } from '../lib/copyPlainData'
import { closedKeys, finiteRange } from './SceneSpec'

/** Stefan–Boltzmann constant rounded to the displayed precision, W/(m² K⁴). */
export const STEFAN_BOLTZMANN = 5.670374419e-8

export interface ThermalConfig {
  profile: 'crebain.lumped-gray-thermal.v1'
  ambientK: number
  initialK: number
  capacityJPerK: number
  areaM2: number
  convectionWPerM2K: number
  emissivity: number
  motorEfficiency: number
}

export function ownThermalConfig(input: ThermalConfig): ThermalConfig {
  const config = copyPlainData(input)
  closedKeys(config, [
    'profile',
    'ambientK',
    'initialK',
    'capacityJPerK',
    'areaM2',
    'convectionWPerM2K',
    'emissivity',
    'motorEfficiency',
  ])
  if (config.profile !== 'crebain.lumped-gray-thermal.v1')
    throw new Error('Unsupported thermal model')
  finiteRange(config.ambientK, 150, 400)
  finiteRange(config.initialK, 150, 800)
  finiteRange(config.capacityJPerK, 1, 100_000)
  finiteRange(config.areaM2, 0.001, 100)
  finiteRange(config.convectionWPerM2K, 0, 1000)
  finiteRange(config.emissivity, 0, 1)
  finiteRange(config.motorEfficiency, 0.05, 1)
  return config
}

/** Ideal diffuse bolometric radiance, W/(m² sr); all wavelengths, not an IR sensor band. */
export function grayRadiance(
  temperatureK: number,
  emissivity: number,
  backgroundK: number
): number {
  finiteRange(temperatureK, 150, 800)
  finiteRange(backgroundK, 150, 800)
  finiteRange(emissivity, 0, 1)
  return (
    (STEFAN_BOLTZMANN / Math.PI) *
    (emissivity * temperatureK ** 4 + (1 - emissivity) * backgroundK ** 4)
  )
}

/** Backward Euler, solved by a fixed bisection count on a strictly increasing heat balance. */
function thermalStep(previousK: number, lossW: number, dt: number, config: ThermalConfig): number {
  finiteRange(previousK, 150, 800)
  finiteRange(lossW, 0, 100_000)
  finiteRange(dt, Number.MIN_VALUE, 1)
  const residual = (temperature: number): number =>
    (config.capacityJPerK * (temperature - previousK)) / dt -
    lossW +
    config.convectionWPerM2K * config.areaM2 * (temperature - config.ambientK) +
    config.emissivity * STEFAN_BOLTZMANN * config.areaM2 * (temperature ** 4 - config.ambientK ** 4)
  let low = Math.min(previousK, config.ambientK)
  let high = Math.max(previousK, config.ambientK) + (lossW * dt) / config.capacityJPerK
  if (high > 800 && residual(800) < 0) throw new Error('Thermal transition exceeds 800 kelvin')
  high = Math.min(800, high)
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2
    if (residual(middle) > 0) high = middle
    else low = middle
  }
  return (low + high) / 2
}

/** Project-owned heat state. Input mechanical power comes from actual rotor torque × speed. */
export class ThermalState {
  readonly #config: ThermalConfig
  #temperatures: number[]
  #tick = 0

  constructor(config: ThermalConfig, entityCount: number) {
    this.#config = ownThermalConfig(config)
    if (!Number.isInteger(entityCount) || entityCount < 1 || entityCount > 256)
      throw new Error('Thermal entity roster is outside the operating envelope')
    this.#temperatures = Array<number>(entityCount).fill(this.#config.initialK)
  }

  advance(mechanicalPowerW: number[]): void {
    mechanicalPowerW = copyPlainData(mechanicalPowerW)
    if (this.#tick >= 7200) throw new Error('Thermal duration budget exhausted')
    if (mechanicalPowerW.length !== this.#temperatures.length)
      throw new Error('Thermal source roster changed')
    const next = mechanicalPowerW.map((power, index) => {
      finiteRange(power, 0, 5000)
      const lossW = power * (1 / this.#config.motorEfficiency - 1)
      return thermalStep(this.#temperatures[index], lossW, 1 / 120, this.#config)
    })
    this.#temperatures = next
    this.#tick++
  }

  temperatures(): number[] {
    return [...this.#temperatures]
  }

  radiances(): number[] {
    return this.#temperatures.map((temperature) =>
      grayRadiance(temperature, this.#config.emissivity, this.#config.ambientK)
    )
  }

  checkpoint(): { config: ThermalConfig; tick: number; temperaturesK: number[] } {
    return { config: this.#config, tick: this.#tick, temperaturesK: [...this.#temperatures] }
  }
}
