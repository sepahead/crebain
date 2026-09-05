import * as THREE from 'three'
import { SparkRenderer, SparkViewpoint } from '@sparkjsdev/spark'
import { copyPlainData } from '../lib/copyPlainData'
import { closedKeys, finiteRange, ownSceneSpec, type SceneCamera } from './SceneSpec'
import { grayRadiance, ownThermalConfig } from './ThermalObservation'
import { createSceneProjection, type SceneProjection } from './SceneProjection'

import {
  graphicsInputDigest,
  type GraphicsPlan,
  type GraphicsInput,
  type GraphicsFrames,
} from './GraphicsContract'
export type { GraphicsPlan, GraphicsInput, GraphicsFrames } from './GraphicsContract'

function camera(row: SceneCamera): THREE.PerspectiveCamera {
  const result = new THREE.PerspectiveCamera(row.fovDegrees, row.width / row.height, 0.05, 4000)
  result.position.fromArray(row.position)
  result.lookAt(new THREE.Vector3().fromArray(row.target))
  result.updateMatrixWorld(true)
  return result
}

/**
 * One private graphics context. The process parent must enforce a termination watchdog.
 * Local retirement prevents publication after failure; it cannot interrupt a stuck GPU.
 */
export class GraphicsOwner {
  readonly planSha256: string
  readonly #plan: GraphicsPlan
  readonly #renderer: THREE.WebGLRenderer
  readonly #spark: SparkRenderer
  readonly #projection: SceneProjection
  readonly #views: SparkViewpoint[]
  readonly #thermalTargets: THREE.WebGLRenderTarget[]
  #phase: 'active' | 'busy' | 'retired' = 'active'
  #staticCollectionPrepared = false

  private constructor(
    plan: GraphicsPlan,
    digest: string,
    renderer: THREE.WebGLRenderer,
    projection: SceneProjection
  ) {
    this.#plan = plan
    this.planSha256 = digest
    this.#renderer = renderer
    this.#projection = projection
    this.#spark = new SparkRenderer({
      renderer,
      autoUpdate: false,
      view: { autoUpdate: false, stochastic: false },
    })
    this.#spark.time = 0
    this.#spark.deltaTime = 0
    projection.rgb.add(this.#spark)
    this.#views = plan.scene.rgbCameras.map(
      (row) =>
        new SparkViewpoint({
          spark: this.#spark,
          autoUpdate: false,
          stochastic: false,
          camera: camera(row),
          target: { width: row.width, height: row.height },
        })
    )
    this.#thermalTargets = plan.scene.thermalCameras.map(
      (row) =>
        new THREE.WebGLRenderTarget(row.width, row.height, {
          type: THREE.FloatType,
          format: THREE.RGBAFormat,
          colorSpace: THREE.NoColorSpace,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          depthBuffer: true,
        })
    )
    for (const solid of plan.scene.solids) {
      const material = plan.scene.materials.find((row) => row.id === solid.materialId)!
      projection.thermalMaterials.get(`solid:${solid.shape.id}`)!.uniforms.radiance.value =
        grayRadiance(material.temperatureK, material.emissivity, plan.thermal.ambientK)
    }
    projection.thermalMaterials.get('ground')!.uniforms.radiance.value = grayRadiance(
      plan.thermal.ambientK,
      1,
      plan.thermal.ambientK
    )
    Object.freeze(this)
  }

  static async prepare(input: GraphicsPlan): Promise<GraphicsOwner> {
    const plan = copyPlainData(input)
    closedKeys(plan, ['profile', 'sourceIdentity', 'scene', 'droneIds', 'thermal'])
    if (
      plan.profile !== 'crebain.owned-city-graphics.v1' ||
      !/^[a-f0-9]{64}$/.test(plan.sourceIdentity)
    )
      throw new Error('Unsupported graphics profile or source identity')
    ownSceneSpec(plan.scene)
    ownThermalConfig(plan.thermal)
    if (!Array.isArray(plan.droneIds) || plan.droneIds.length < 1 || plan.droneIds.length > 256)
      throw new Error('Graphics drone roster outside the operating envelope')
    let previous = ''
    for (const id of plan.droneIds) {
      if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || id <= previous)
        throw new Error('Graphics drone IDs must be sorted and unique')
      previous = id
    }
    const digest = await graphicsInputDigest(plan)
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    })
    try {
      renderer.setPixelRatio(1)
      renderer.toneMapping = THREE.NoToneMapping
      renderer.outputColorSpace = THREE.SRGBColorSpace
      if (!renderer.extensions.has('EXT_color_buffer_float'))
        throw new Error('Float thermal render targets are unavailable')
      const projection = await createSceneProjection(plan.scene, plan.droneIds)
      return new GraphicsOwner(plan, digest, renderer, projection)
    } catch (error) {
      renderer.dispose()
      renderer.forceContextLoss()
      throw error
    }
  }

  private ownInput(input: GraphicsInput): GraphicsInput {
    const value = copyPlainData(input)
    closedKeys(value, ['planSha256', 'tick', 'drones'])
    if (
      value.planSha256 !== this.planSha256 ||
      !Number.isInteger(value.tick) ||
      value.tick < 0 ||
      value.tick > 7200
    )
      throw new Error('Graphics plan or tick binding changed')
    if (!Array.isArray(value.drones) || value.drones.length !== this.#plan.droneIds.length)
      throw new Error('Graphics drone roster changed')
    value.drones.forEach((row, index) => {
      closedKeys(row, ['id', 'position', 'orientation', 'temperatureK'])
      if (row.id !== this.#plan.droneIds[index]) throw new Error('Graphics drone identity changed')
      if (
        !Array.isArray(row.position) ||
        row.position.length !== 3 ||
        !Array.isArray(row.orientation) ||
        row.orientation.length !== 4
      )
        throw new Error('Graphics pose axes changed')
      row.position.forEach((component) => finiteRange(component, -1000, 1000))
      row.orientation.forEach((component) => finiteRange(component, -1, 1))
      if (Math.abs(Math.hypot(...row.orientation) - 1) > 1e-5)
        throw new Error('Graphics orientation must be a unit quaternion')
      finiteRange(row.temperatureK, 150, 800)
    })
    return value
  }

  /** Observed driver strings, not hardware or source attestation. */
  runtimeIdentity(): { version: string; renderer: string; vendor: string } {
    const context = this.#renderer.getContext()
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    const text = (value: unknown): string =>
      typeof value === 'string' ? value.slice(0, 256) : 'unavailable'
    return {
      version: text(context.getParameter(context.VERSION)),
      renderer: text(context.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER)),
      vendor: text(context.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? context.VENDOR)),
    }
  }

  async capture(input: GraphicsInput): Promise<GraphicsFrames> {
    if (this.#phase !== 'active') throw new Error(`Graphics owner is ${this.#phase}`)
    const value = this.ownInput(input)
    this.#phase = 'busy'
    const previousTarget = this.#renderer.getRenderTarget()
    const previousColor = this.#renderer.getClearColor(new THREE.Color())
    const previousAlpha = this.#renderer.getClearAlpha()
    try {
      // Bind the complete admitted scene, camera roster, tick, and source pose before rendering.
      const inputSha256 = await graphicsInputDigest(value)
      this.#spark.time = value.tick / 120
      this.#spark.deltaTime = 1 / 120
      for (const row of value.drones) {
        for (const model of [
          this.#projection.rgbDrones.get(row.id)!,
          this.#projection.thermalDrones.get(row.id)!,
        ]) {
          model.position.fromArray(row.position)
          model.quaternion.fromArray(row.orientation)
        }
        this.#projection.thermalMaterials.get(`drone:${row.id}`)!.uniforms.radiance.value =
          grayRadiance(row.temperatureK, this.#plan.thermal.emissivity, this.#plan.thermal.ambientK)
      }
      this.#projection.rgb.updateMatrixWorld(true)
      this.#projection.thermal.updateMatrixWorld(true)
      const result: GraphicsFrames = {
        planSha256: this.planSha256,
        inputSha256,
        tick: value.tick,
        rowOrigin: 'bottom-left',
        rgb: [],
        thermal: [],
      }
      for (const [index, row] of this.#plan.scene.rgbCameras.entries()) {
        if (value.tick % row.periodTicks !== 0) continue
        const shared = await this.#views[index].prepareRenderPixels({
          scene: this.#projection.rgb,
          // This profile has immutable authored Gaussians and dynamic mesh drones only.
          // Prepare the collection once at the fixed world origin; every view still sorts.
          update: !this.#staticCollectionPrepared,
          forceOrigin: false,
        })
        // Spark reuses this buffer. Copy before any later await or frame publication.
        const pixels = Uint8Array.from(shared)
        this.#staticCollectionPrepared = true
        if (pixels.length !== row.width * row.height * 4)
          throw new Error('RGB pixel extent changed')
        result.rgb.push({
          cameraId: row.id,
          width: row.width,
          height: row.height,
          encoding: 'rgba8-srgb',
          pixels,
        })
      }
      this.#renderer.setClearColor(
        new THREE.Color(
          grayRadiance(this.#plan.thermal.ambientK, 1, this.#plan.thermal.ambientK),
          0,
          0
        ),
        1
      )
      for (const [index, row] of this.#plan.scene.thermalCameras.entries()) {
        if (value.tick % row.periodTicks !== 0) continue
        const target = this.#thermalTargets[index]
        this.#renderer.setRenderTarget(target)
        this.#renderer.render(this.#projection.thermal, camera(row))
        const rgba = new Float32Array(row.width * row.height * 4)
        await this.#renderer.readRenderTargetPixelsAsync(target, 0, 0, row.width, row.height, rgba)
        const radiance = new Float32Array(row.width * row.height)
        for (let pixel = 0; pixel < radiance.length; pixel++) {
          const offset = pixel * 4
          if (
            !Number.isFinite(rgba[offset]) ||
            rgba[offset] < 0 ||
            rgba[offset] > 10000 ||
            rgba[offset + 1] !== 0 ||
            rgba[offset + 2] !== 0 ||
            rgba[offset + 3] !== 1
          )
            throw new Error('Invalid float thermal pixel')
          radiance[pixel] = rgba[offset]
        }
        result.thermal.push({
          cameraId: row.id,
          width: row.width,
          height: row.height,
          unit: 'W/(m2 sr)',
          radiance,
        })
      }
      if (this.#renderer.getContext().isContextLost()) throw new Error('Graphics context was lost')
      return result
    } catch (error) {
      this.#phase = 'retired'
      throw new Error('Required graphics observation failed; process must retire', { cause: error })
    } finally {
      this.#renderer.setRenderTarget(previousTarget)
      this.#renderer.setClearColor(previousColor, previousAlpha)
      if (this.#phase === 'busy') this.#phase = 'active'
    }
  }

  /** Normal local cleanup. The owner process is still terminated by its parent. */
  retire(): void {
    if (this.#phase === 'busy')
      throw new Error('Busy graphics context requires process termination')
    this.#phase = 'retired'
    this.#views.forEach((view) => view.dispose())
    this.#thermalTargets.forEach((target) => target.dispose())
    this.#spark.defaultView.dispose()
    this.#renderer.dispose()
    this.#renderer.forceContextLoss()
  }
}
