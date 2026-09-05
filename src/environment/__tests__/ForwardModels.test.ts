// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AcousticState, type AcousticConfig, type MechanicalSource } from '../AcousticObservation'
import {
  ThermalState,
  grayRadiance,
  STEFAN_BOLTZMANN,
  type ThermalConfig,
} from '../ThermalObservation'
import { createCityBlockScene, ownSceneSpec, segmentBlocked, type SceneSpec } from '../SceneSpec'

const acoustic = (): AcousticConfig => ({
  profile: 'crebain.discrete-direct-acoustic.v1',
  sampleRateHz: 16000,
  soundSpeedMps: 320,
  maximumRangeM: 32,
  referenceDistanceM: 1,
  referencePressurePa: 1,
  bladeCount: 2,
  blockedGain: 0,
  noiseStdPa: 0,
  seed: 17,
})
const thermal = (): ThermalConfig => ({
  profile: 'crebain.lumped-gray-thermal.v1',
  ambientK: 293.15,
  initialK: 333.15,
  capacityJPerK: 100,
  areaM2: 1,
  convectionWPerM2K: 20,
  emissivity: 0,
  motorEfficiency: 0.5,
})
const source = (): MechanicalSource => ({ position: [0, 2, 0], rpm: [6000, 6000, 6000, 6000] })
function scene(): SceneSpec {
  return ownSceneSpec({
    ...createCityBlockScene(),
    solids: [],
    rgbCameras: [],
    thermalCameras: [],
    microphones: [
      { id: 'mic-a', position: [1, 2, 0] },
      { id: 'mic-b', position: [2, 2, 0] },
    ],
  })
}

describe('owned scene specification', () => {
  it('creates immutable shared city geometry and rejects unrelated fields and false calibration', () => {
    const value = createCityBlockScene()
    expect(value.solids).toHaveLength(16)
    expect(Object.isFrozen(value.solids[0].shape.center)).toBe(true)
    expect(() => ownSceneSpec({ ...value, frame: 'enu' } as unknown as SceneSpec)).toThrow('frame')
    expect(() => ownSceneSpec({ ...value, modelValidated: true } as unknown as SceneSpec)).toThrow(
      'closed'
    )
    expect(() =>
      ownSceneSpec({ ...value, materials: [{ ...value.materials[0], emissivity: 2 }] })
    ).toThrow('finite')
    expect(() =>
      ownSceneSpec({
        ...value,
        rgbCameras: [{ ...value.rgbCameras[0], target: value.rgbCameras[0].position }],
      })
    ).toThrow('nonzero')
  })

  it('uses the actual rotated cuboid geometry for obstruction and clear-path controls', () => {
    const solids = [
      {
        shape: {
          id: 'wall',
          center: [0, 2, 0] as [number, number, number],
          halfExtents: [2, 2, 0.1] as [number, number, number],
          yaw: Math.PI / 2,
          friction: 0.5,
          restitution: 0,
        },
        materialId: 'concrete',
      },
    ]
    expect(segmentBlocked([-1, 2, 0], [1, 2, 0], solids)).toBe(true)
    expect(segmentBlocked([-1, 5, 0], [1, 5, 0], solids)).toBe(false)
    expect(segmentBlocked([-1, 2, 3], [1, 2, 3], solids)).toBe(false)
  })
})

describe('actual generated microphone pressure', () => {
  it('matches an independently evaluated fixed-source waveform, delay, and spreading law', () => {
    const model = new AcousticState(acoustic(), scene(), 1)
    const captured: number[][] = [[], []]
    for (let tick = 0; tick < 12; tick++) {
      const block = model.advance([source()])
      block.channels.forEach((channel, index) => captured[index].push(...channel))
    }
    expect(captured[0]).toHaveLength(1600)
    for (let microphone = 0; microphone < 2; microphone++) {
      const distance = microphone + 1
      for (let sample = 0; sample < 1600; sample++) {
        const emission = sample - distance * 50
        const phase = (2 * Math.PI * 200 * emission) / 16000
        const expected =
          emission < 0
            ? 0
            : (0.16 / distance) *
              (Math.sin(phase) + 0.3 * Math.sin(phase * 2) + 0.1 * Math.sin(phase * 3))
        expect(captured[microphone][sample]).toBeCloseTo(expected, 10)
      }
    }
    expect(captured[0].some((pressure) => Math.abs(pressure) > 0.1)).toBe(true)
  })

  it('generates silence, blocked paths, and changed motor effects through the same model', () => {
    const empty = new AcousticState(acoustic(), scene(), 1)
    expect(
      Array.from(empty.advance([{ ...source(), rpm: [0, 0, 0, 0] }]).channels[0]).every(
        (sample) => sample === 0
      )
    ).toBe(true)
    const blockedScene = {
      ...scene(),
      solids: [
        {
          shape: {
            id: 'wall',
            center: [0.5, 2, 0] as [number, number, number],
            halfExtents: [0.1, 2, 2] as [number, number, number],
            yaw: 0,
            friction: 0.5,
            restitution: 0,
          },
          materialId: 'concrete',
        },
      ],
    }
    const blocked = new AcousticState(acoustic(), blockedScene, 1)
    const active = new AcousticState(acoustic(), scene(), 1)
    const b = blocked.advance([source()]).channels[0]
    const a = active.advance([source()]).channels[0]
    expect(Array.from(b).every((sample) => sample === 0)).toBe(true)
    expect(Array.from(a).some((sample) => sample !== 0)).toBe(true)
    const fast = new AcousticState(acoustic(), scene(), 1)
    expect(fast.advance([{ ...source(), rpm: [9000, 9000, 9000, 9000] }]).channels[0]).not.toEqual(
      a
    )
  })

  it('reconstructs complete phase, delay-buffer, noise, and scheduling state', () => {
    const config = { ...acoustic(), noiseStdPa: 0.01 }
    const a = new AcousticState(config, scene(), 1)
    const b = new AcousticState(config, scene(), 1)
    for (let tick = 0; tick < 121; tick++) {
      expect(a.advance([source()])).toEqual(b.advance([source()]))
    }
    expect(a.checkpoint()).toEqual(b.checkpoint())
    const retained = b.checkpoint()
    const output = a.advance([source()])
    output.channels[0].fill(999)
    expect(b.checkpoint()).toEqual(retained)
    expect(a.advance([source()]).channels[0][0]).not.toBe(999)
  })

  it('rejects malformed input without consuming samples or invoking ordinary getters', () => {
    const model = new AcousticState(acoustic(), scene(), 1)
    const before = model.checkpoint()
    expect(() => model.advance([{ ...source(), rpm: [16000, 0, 0, 0] }])).toThrow('finite')
    expect(model.checkpoint()).toEqual(before)
    const getter = vi.fn(() => [0, 0, 0, 0])
    const hostile = {
      ...source(),
      get rpm() {
        return getter()
      },
    }
    expect(() => model.advance([hostile as MechanicalSource])).toThrow('accessors')
    expect(getter).not.toHaveBeenCalled()
    expect(model.checkpoint()).toEqual(before)
    expect(model.advance([source()]).sampleEnd).toBe(133)
    expect(() => new AcousticState({ ...acoustic(), soundSpeedMps: 0 }, scene(), 1)).toThrow(
      'finite'
    )
  })
})

describe('thermal state and bolometric radiance', () => {
  it('matches the independent backward-Euler solution when radiative loss is disabled', () => {
    const config = thermal()
    const model = new ThermalState(config, 1)
    model.advance([50])
    const dt = 1 / 120
    const expected =
      ((config.capacityJPerK / dt) * config.initialK +
        50 +
        config.convectionWPerM2K * config.areaM2 * config.ambientK) /
      (config.capacityJPerK / dt + config.convectionWPerM2K * config.areaM2)
    expect(model.temperatures()[0]).toBeCloseTo(expected, 12)
  })

  it('preserves equilibrium and monotonically cools without energy input', () => {
    const equilibrium = new ThermalState({ ...thermal(), initialK: 293.15, emissivity: 0.9 }, 1)
    const cooling = new ThermalState({ ...thermal(), emissivity: 0.9 }, 1)
    let previous = cooling.temperatures()[0]
    for (let tick = 0; tick < 240; tick++) {
      equilibrium.advance([0])
      cooling.advance([0])
      const current = cooling.temperatures()[0]
      expect(current).toBeLessThan(previous)
      expect(current).toBeGreaterThan(293.15)
      previous = current
    }
    expect(equilibrium.temperatures()).toEqual([293.15])
  })

  it('responds to actual mechanical input and distinguishes temperature from reflected background', () => {
    const cold = new ThermalState({ ...thermal(), initialK: 293.15, emissivity: 0.9 }, 1)
    const hot = new ThermalState({ ...thermal(), initialK: 293.15, emissivity: 0.9 }, 1)
    for (let tick = 0; tick < 120; tick++) {
      cold.advance([0])
      hot.advance([100])
    }
    expect(hot.temperatures()[0]).toBeGreaterThan(cold.temperatures()[0])
    expect(hot.radiances()[0]).toBeGreaterThan(cold.radiances()[0])
    expect(grayRadiance(400, 0, 300)).toBeCloseTo((STEFAN_BOLTZMANN * 300 ** 4) / Math.PI, 12)
    expect(grayRadiance(400, 1, 300)).toBeCloseTo((STEFAN_BOLTZMANN * 400 ** 4) / Math.PI, 12)
  })

  it('rejects invalid power and temperature envelopes without partial state changes', () => {
    const state = new ThermalState(thermal(), 2)
    const before = state.checkpoint()
    expect(() => state.advance([1, Infinity])).toThrow('finite')
    expect(state.checkpoint()).toEqual(before)
    state.advance([0, 0])
    expect(state.checkpoint()).not.toEqual(before)
    expect(() => new ThermalState({ ...thermal(), motorEfficiency: 0 }, 1)).toThrow('finite')
    expect(() => grayRadiance(20, 0.9, 293)).toThrow('finite')
  })
})
