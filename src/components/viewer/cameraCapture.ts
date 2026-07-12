import type * as THREE from 'three'

type CameraCaptureRenderer = Pick<
  THREE.WebGLRenderer,
  'getRenderTarget' | 'setRenderTarget' | 'render' | 'readRenderTargetPixels'
>

interface CaptureCameraPixelsOptions {
  renderer: CameraCaptureRenderer
  scene: THREE.Scene
  camera: THREE.Camera
  renderTarget: THREE.WebGLRenderTarget
  buffer: Uint8Array
  renderedAt: number | undefined
  maxAgeMs: number
  now?: () => number
}

export interface CameraPixelCapture {
  refreshed: boolean
  renderedAt: number
}

/**
 * Run work against one off-screen target without leaking it into the viewer's
 * main render loop. Restoration also runs when rendering or readback throws.
 */
export function withCameraRenderTarget<T>(
  renderer: Pick<THREE.WebGLRenderer, 'getRenderTarget' | 'setRenderTarget'>,
  renderTarget: THREE.WebGLRenderTarget,
  operation: () => T
): T {
  const previousRenderTarget = renderer.getRenderTarget()
  try {
    renderer.setRenderTarget(renderTarget)
    return operation()
  } finally {
    renderer.setRenderTarget(previousRenderTarget)
  }
}

/**
 * Read one camera target, refreshing that target first only when its cached
 * render is missing or stale. The caller chooses the camera, so this function
 * cannot expand one detection cycle into an all-camera render pass.
 */
export function captureCameraPixels({
  renderer,
  scene,
  camera,
  renderTarget,
  buffer,
  renderedAt,
  maxAgeMs,
  now = performance.now.bind(performance),
}: CaptureCameraPixelsOptions): CameraPixelCapture {
  const needsRefresh = renderedAt === undefined || now() - renderedAt > maxAgeMs

  if (!needsRefresh) {
    renderer.readRenderTargetPixels(
      renderTarget,
      0,
      0,
      renderTarget.width,
      renderTarget.height,
      buffer
    )
    return { refreshed: false, renderedAt }
  }

  let refreshedAt = 0
  withCameraRenderTarget(renderer, renderTarget, () => {
    renderer.render(scene, camera)
    refreshedAt = now()
    renderer.readRenderTargetPixels(
      renderTarget,
      0,
      0,
      renderTarget.width,
      renderTarget.height,
      buffer
    )
  })

  return { refreshed: true, renderedAt: refreshedAt }
}
