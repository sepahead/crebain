// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'
import { GraphicsOwner } from '../GraphicsOwner'
import { ForceCityEnvironment, CityEnvironmentError } from '../ForceCityEnvironment'
import {
  graphicsInputDigest,
  type GraphicsPlan,
  type GraphicsInput,
  type SourceGraphicsPlan,
  type SourceGraphicsInput,
} from '../GraphicsContract'
import { citySha256 } from '../CitySourceContract'
import { cityPlan, citySet } from './CitySourceFixtures'

const harness = vi.hoisted(() => ({
  floatExtension: true,
  contextLost: false,
  rendererCount: 0,
  rendererDisposals: 0,
  contextLosses: 0,
  viewDisposals: 0,
  targetDisposals: 0,
  defaultDisposals: 0,
  invalidThermal: false,
  readbacks: [] as Float32Array[],
  renderCalls: 0,
  viewCalls: [] as Array<{ x: number; update: boolean }>,
  shared: [] as Uint8Array[],
  failViewX: null as number | null,
  primary: new Error('view acquisition failed'),
  restoreError: null as Error | null,
  disposeError: null as Error | null,
  projectionError: null as Error | null,
}))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof THREE>()
  class Renderer {
    extensions = { has: () => harness.floatExtension }
    target: THREE.WebGLRenderTarget | null = null
    color = new actual.Color(0, 0, 0)
    alpha = 1
    constructor() {
      harness.rendererCount++
    }
    setPixelRatio() {}
    getRenderTarget() {
      return this.target
    }
    getClearColor(result: THREE.Color) {
      return result.copy(this.color)
    }
    getClearAlpha() {
      return this.alpha
    }
    setRenderTarget(target: THREE.WebGLRenderTarget | null) {
      this.target = target
    }
    setClearColor(color: THREE.Color, alpha: number) {
      if (harness.restoreError) throw harness.restoreError
      this.color.copy(color)
      this.alpha = alpha
    }
    render() {
      harness.renderCalls++
    }
    async readRenderTargetPixelsAsync(
      _target: unknown,
      _x: number,
      _y: number,
      width: number,
      height: number,
      output: Float32Array
    ) {
      harness.readbacks.push(output)
      for (let pixel = 0; pixel < width * height; pixel++) {
        output[pixel * 4] = harness.invalidThermal ? NaN : 133.29733
        output[pixel * 4 + 1] = 0
        output[pixel * 4 + 2] = 0
        output[pixel * 4 + 3] = 1
      }
    }
    getContext() {
      return { isContextLost: () => harness.contextLost }
    }
    dispose() {
      harness.rendererDisposals++
      if (harness.disposeError) throw harness.disposeError
    }
    forceContextLoss() {
      harness.contextLosses++
    }
  }
  class Target extends actual.WebGLRenderTarget {
    override dispose() {
      harness.targetDisposals++
      super.dispose()
    }
  }
  return { ...actual, WebGLRenderer: Renderer, WebGLRenderTarget: Target }
})

vi.mock('@sparkjsdev/spark', async () => {
  const actual = await vi.importActual<typeof THREE>('three')
  return {
    SparkRenderer: class extends actual.Object3D {
      defaultView = {
        dispose: () => {
          harness.defaultDisposals++
        },
      }
    },
    SparkViewpoint: class {
      readonly x: number
      readonly pixels: Uint8Array
      constructor(input: {
        camera: THREE.PerspectiveCamera
        target: { width: number; height: number }
      }) {
        this.x = input.camera.position.x
        this.pixels = new Uint8Array(input.target.width * input.target.height * 4)
        harness.shared.push(this.pixels)
      }
      async prepareRenderPixels(input: { update: boolean }) {
        harness.viewCalls.push({ x: this.x, update: input.update })
        if (harness.failViewX === this.x) throw harness.primary
        this.pixels.fill(20 + this.x)
        return this.pixels
      }
      dispose() {
        harness.viewDisposals++
      }
    },
  }
})

vi.mock('../SceneProjection', async () => {
  const actual = await vi.importActual<typeof THREE>('three')
  return {
    createSceneProjection: async (scene: SourceGraphicsPlan['scene'], ids: string[]) => {
      if (harness.projectionError) throw harness.projectionError
      return {
        rgb: new actual.Scene(),
        thermal: new actual.Scene(),
        rgbDrones: new Map(ids.map((id) => [id, new actual.Object3D()])),
        thermalDrones: new Map(ids.map((id) => [id, new actual.Object3D()])),
        thermalMaterials: new Map(
          [
            'ground',
            ...ids.map((id) => `drone:${id}`),
            ...scene.solids.map((row) => `solid:${row.shape.id}`),
          ].map((id) => [id, { uniforms: { radiance: { value: 0 } } }])
        ),
      }
    },
  }
})

const owners = new Set<GraphicsOwner>()
beforeEach(() => {
  Object.assign(harness, {
    floatExtension: true,
    contextLost: false,
    rendererCount: 0,
    rendererDisposals: 0,
    contextLosses: 0,
    viewDisposals: 0,
    targetDisposals: 0,
    defaultDisposals: 0,
    invalidThermal: false,
    readbacks: [],
    renderCalls: 0,
    viewCalls: [],
    shared: [],
    failViewX: null,
    restoreError: null,
    disposeError: null,
    projectionError: null,
  })
})
afterEach(() => {
  harness.disposeError = null
  for (const owner of owners) owner.retire()
  owners.clear()
})
function graphicsPlan(legacy = false): SourceGraphicsPlan | GraphicsPlan {
  const plan = cityPlan(2, { rgb: 2, thermal: 2, pressure: 0 })
  return {
    profile: legacy
      ? 'crebain.owned-city-graphics.v1'
      : 'crebain.owned-force-city-source-graphics.v1',
    sourceIdentity: plan.world.sourceIdentity,
    scene: plan.scene,
    droneIds: plan.world.drones.map((row) => row.id),
    thermal: plan.thermal!,
  }
}
function input(owner: GraphicsOwner, thermal = true, tick = 1): SourceGraphicsInput {
  return {
    planSha256: owner.planSha256,
    tick,
    drones: [0, 1].map((index) => ({
      id: `drone-00${index}`,
      position: [index * 3, 23 + index, 0],
      orientation: [0, 0, 0, 1],
      temperatureK: thermal ? 293.15 : null,
    })),
  }
}
async function sourceOwner(plan = graphicsPlan() as SourceGraphicsPlan) {
  const owner = await GraphicsOwner.prepareSources(plan)
  owners.add(owner)
  return owner
}

describe('opt-in source capture control flow with synthetic renderer primitives', () => {
  it('preserves aggregate legacy bytes, source identity, and shared readback detachment', async () => {
    const legacy = await GraphicsOwner.prepare(graphicsPlan(true) as GraphicsPlan)
    owners.add(legacy)
    const frames = await legacy.capture(input(legacy) as GraphicsInput)
    const sources = await sourceOwner(),
      request = input(sources)
    for (const row of frames.rgb) {
      const output = new Uint8Array(row.pixels.length)
      const receipt = await sources.captureSourceInto(
        request,
        { kind: 'rgb', cameraId: row.cameraId },
        output
      )
      expect(output).toEqual(row.pixels)
      expect(receipt).toMatchObject({
        inputSha256: await graphicsInputDigest(request),
        tick: 1,
        cameraId: row.cameraId,
        rowOrigin: 'bottom-left',
        encoding: 'rgba8-srgb',
        byteLength: output.length,
      })
      harness.shared.forEach((buffer) => buffer.fill(250))
      expect(output).toEqual(row.pixels)
    }
    for (const row of frames.thermal) {
      const output = new Uint8Array(row.radiance.byteLength)
      await sources.captureSourceInto(request, { kind: 'thermal', cameraId: row.cameraId }, output)
      const view = new DataView(output.buffer)
      expect(
        Array.from({ length: row.radiance.length }, (_, index) => view.getFloat32(index * 4, true))
      ).toEqual(Array.from(row.radiance))
    }
    expect(harness.readbacks[2].buffer).toBe(harness.readbacks[3].buffer)
    expect(harness.readbacks[0].buffer).not.toBe(harness.readbacks[1].buffer)
    expect(harness.viewCalls.map((row) => row.update)).toEqual([true, false, true, false])
    await expect(
      legacy.captureSourceInto(
        input(legacy),
        { kind: 'rgb', cameraId: 'rgb-0' },
        new Uint8Array(256)
      )
    ).rejects.toThrow('unavailable')
    await expect(sources.capture(input(sources) as GraphicsInput)).rejects.toThrow('individual')
  })

  it('pre-admits destinations, identities, poses, and due ticks without touching the renderer', async () => {
    const plan = graphicsPlan() as SourceGraphicsPlan
    plan.scene.rgbCameras[0].periodTicks = 2
    const owner = await sourceOwner(plan),
      target = new Uint8Array(256),
      request = input(owner)
    for (const [value, selection, bytes] of [
      [request, { kind: 'rgb', cameraId: 'rgb-0' }, target],
      [{ ...request, tick: 2 }, { kind: 'rgb', cameraId: 'foreign' }, target],
      [{ ...request, tick: 2 }, { kind: 'rgb', cameraId: 'rgb-0' }, new Uint8Array(255)],
      [
        { ...request, tick: 2, planSha256: '0'.repeat(64) },
        { kind: 'rgb', cameraId: 'rgb-0' },
        target,
      ],
      [
        { ...request, tick: 2, drones: [...request.drones].reverse() },
        { kind: 'rgb', cameraId: 'rgb-0' },
        target,
      ],
    ] as const)
      await expect(owner.captureSourceInto(value, selection, bytes)).rejects.toThrow()
    expect(harness.viewCalls).toEqual([])
    await owner.captureSourceInto(
      { ...request, tick: 2 },
      { kind: 'rgb', cameraId: 'rgb-0' },
      target
    )
    expect(harness.viewCalls).toHaveLength(1)
  })

  it('requires float capability only for selected thermal sources while preserving the legacy requirement', async () => {
    harness.floatExtension = false
    const plan = graphicsPlan() as SourceGraphicsPlan
    plan.scene.thermalCameras = []
    plan.thermal = null
    const owner = await sourceOwner(plan)
    await owner.captureSourceInto(
      input(owner, false),
      { kind: 'rgb', cameraId: 'rgb-0' },
      new Uint8Array(256)
    )
    await expect(
      owner.captureSourceInto(input(owner), { kind: 'rgb', cameraId: 'rgb-0' }, new Uint8Array(256))
    ).rejects.toThrow('Unrequested thermal')
    await expect(GraphicsOwner.prepare(graphicsPlan(true) as GraphicsPlan)).rejects.toThrow(
      'Float thermal'
    )
    await expect(
      GraphicsOwner.prepareSources(graphicsPlan() as SourceGraphicsPlan)
    ).rejects.toThrow('preparation failed')
  })

  it('retains original peers when the second view fails inside GraphicsOwner', async () => {
    const plan = cityPlan(3, { rgb: 2, thermal: 1, pressure: 1 })
    const environment = await ForceCityEnvironment.prepare(plan, (value) =>
      GraphicsOwner.prepareSources(value)
    )
    harness.failViewX = 3
    try {
      let caught: unknown
      try {
        await environment.advance(citySet(plan))
      } catch (error) {
        caught = error
      }
      const error = caught as CityEnvironmentError
      expect(error).toBeInstanceOf(CityEnvironmentError)
      expect((error.cause as AggregateError).cause).toBe(harness.primary)
      const handle = error.handle!,
        observation = environment.observation(handle)
      expect(observation.slots.map((row) => row.status)).toEqual([
        'produced',
        'failed',
        'absent',
        'produced',
      ])
      const first = observation.slots[0]
      if (first.status !== 'produced') throw new Error('Fixture requires first source')
      const bytes = environment.readChunk(handle, first.requestId, first.originalSha256, 0)
      expect([...new Set(bytes)]).toEqual([20])
      harness.shared.forEach((buffer) => buffer.fill(253))
      expect(
        await citySha256(environment.readChunk(handle, first.requestId, first.originalSha256, 0))
      ).toBe(first.originalSha256)
      expect(error.outcome.componentCleanup).toBe('confirmed')
      expect(harness.rendererDisposals).toBe(1)
      expect(harness.contextLosses).toBe(1)
    } finally {
      await environment.retire()
    }
  })

  it.each(['thermal', 'context'])(
    'retires an invalid %s acquisition and forbids later publication',
    async (failure) => {
      const owner = await sourceOwner(),
        request = input(owner)
      harness.invalidThermal = failure === 'thermal'
      harness.contextLost = failure === 'context'
      await expect(
        owner.captureSourceInto(
          request,
          { kind: 'thermal', cameraId: 'thermal-0' },
          new Uint8Array(256)
        )
      ).rejects.toThrow('Individual graphics source failed')
      harness.invalidThermal = false
      harness.contextLost = false
      await expect(
        owner.captureSourceInto(request, { kind: 'rgb', cameraId: 'rgb-0' }, new Uint8Array(256))
      ).rejects.toThrow('unavailable')
    }
  )

  it('keeps primary, restoration, and cleanup errors, attempts all disposal, and never retries unknown cleanup', async () => {
    const owner = await sourceOwner()
    harness.failViewX = 0
    harness.restoreError = new Error('restore failed')
    let caught: unknown
    try {
      await owner.captureSourceInto(
        input(owner),
        { kind: 'rgb', cameraId: 'rgb-0' },
        new Uint8Array(256)
      )
    } catch (error) {
      caught = error
    }
    expect((caught as AggregateError).cause).toBe(harness.primary)
    expect((caught as AggregateError).errors).toEqual([harness.primary, harness.restoreError])
    harness.disposeError = new Error('dispose unknown')
    expect(() => owner.retire()).toThrow('cleanup remains unresolved')
    expect(() => owner.retire()).toThrow('cleanup remains unresolved')
    expect(harness.viewDisposals).toBe(2)
    expect(harness.targetDisposals).toBe(2)
    expect(harness.defaultDisposals).toBe(1)
    expect(harness.rendererDisposals).toBe(1)
    expect(harness.contextLosses).toBe(1)
    owners.delete(owner)
  })

  it('preserves preparation failure when renderer disposal also fails', async () => {
    harness.projectionError = new Error('projection construction failed')
    harness.disposeError = new Error('renderer disposal failed')
    let caught: unknown
    try {
      await GraphicsOwner.prepareSources(graphicsPlan() as SourceGraphicsPlan)
    } catch (error) {
      caught = error
    }
    expect((caught as AggregateError).cause).toBe(harness.projectionError)
    expect((caught as AggregateError).errors).toEqual([
      harness.projectionError,
      harness.disposeError,
    ])
    expect(harness.rendererDisposals).toBe(1)
    expect(harness.contextLosses).toBe(1)
  })
})
