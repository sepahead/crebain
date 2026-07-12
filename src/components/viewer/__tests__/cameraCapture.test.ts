import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureCameraPixels } from '../cameraCapture'

type CaptureRenderer = Parameters<typeof captureCameraPixels>[0]['renderer']

function createRenderer(previousRenderTarget: THREE.WebGLRenderTarget) {
  let currentRenderTarget: THREE.RenderTarget | null = previousRenderTarget
  const getRenderTarget = vi.fn(() => currentRenderTarget)
  const setRenderTarget = vi.fn((target: THREE.RenderTarget | null) => {
    currentRenderTarget = target
  })
  const render = vi.fn()
  const readRenderTargetPixels = vi.fn()

  return {
    renderer: {
      getRenderTarget,
      setRenderTarget,
      render,
      readRenderTargetPixels,
    } as unknown as CaptureRenderer,
    get currentRenderTarget() {
      return currentRenderTarget
    },
    getRenderTarget,
    setRenderTarget,
    render,
    readRenderTargetPixels,
  }
}

describe('captureCameraPixels', () => {
  const renderTargets: THREE.WebGLRenderTarget[] = []

  function renderTarget(): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(2, 2)
    renderTargets.push(target)
    return target
  }

  afterEach(() => {
    renderTargets.splice(0).forEach((target) => target.dispose())
    vi.restoreAllMocks()
  })

  it.each([
    { label: 'never-rendered', renderedAt: undefined },
    { label: 'stale', renderedAt: 499 },
  ])('refreshes a $label target before reading it', ({ renderedAt }) => {
    const previousTarget = renderTarget()
    const selectedTarget = renderTarget()
    const renderer = createRenderer(previousTarget)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const buffer = new Uint8Array(16)

    const capture = captureCameraPixels({
      renderer: renderer.renderer,
      scene,
      camera,
      renderTarget: selectedTarget,
      buffer,
      renderedAt,
      maxAgeMs: 500,
      now: () => 1_000,
    })

    expect(capture).toEqual({ refreshed: true, renderedAt: 1_000 })
    expect(renderer.render).toHaveBeenCalledWith(scene, camera)
    expect(renderer.readRenderTargetPixels).toHaveBeenCalledWith(selectedTarget, 0, 0, 2, 2, buffer)
    expect(renderer.render.mock.invocationCallOrder[0]).toBeLessThan(
      renderer.readRenderTargetPixels.mock.invocationCallOrder[0]
    )
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, selectedTarget)
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(2, previousTarget)
    expect(renderer.currentRenderTarget).toBe(previousTarget)
  })

  it('reads a fresh cached target without a redundant render or target switch', () => {
    const previousTarget = renderTarget()
    const selectedTarget = renderTarget()
    const renderer = createRenderer(previousTarget)
    const buffer = new Uint8Array(16)

    const capture = captureCameraPixels({
      renderer: renderer.renderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderTarget: selectedTarget,
      buffer,
      renderedAt: 750,
      maxAgeMs: 500,
      now: () => 1_000,
    })

    expect(capture).toEqual({ refreshed: false, renderedAt: 750 })
    expect(renderer.render).not.toHaveBeenCalled()
    expect(renderer.getRenderTarget).not.toHaveBeenCalled()
    expect(renderer.setRenderTarget).not.toHaveBeenCalled()
    expect(renderer.readRenderTargetPixels).toHaveBeenCalledOnce()
    expect(renderer.currentRenderTarget).toBe(previousTarget)
  })

  it.each(['render', 'readback'] as const)(
    'restores the prior render target when %s throws',
    (failureStage) => {
      const previousTarget = renderTarget()
      const selectedTarget = renderTarget()
      const renderer = createRenderer(previousTarget)
      const failure = new Error(`${failureStage} failed`)
      if (failureStage === 'render') {
        renderer.render.mockImplementation(() => {
          throw failure
        })
      } else {
        renderer.readRenderTargetPixels.mockImplementation(() => {
          throw failure
        })
      }

      expect(() =>
        captureCameraPixels({
          renderer: renderer.renderer,
          scene: new THREE.Scene(),
          camera: new THREE.PerspectiveCamera(),
          renderTarget: selectedTarget,
          buffer: new Uint8Array(16),
          renderedAt: undefined,
          maxAgeMs: 500,
          now: () => 1_000,
        })
      ).toThrow(failure)

      expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, selectedTarget)
      expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(2, previousTarget)
      expect(renderer.currentRenderTarget).toBe(previousTarget)
    }
  )
})
