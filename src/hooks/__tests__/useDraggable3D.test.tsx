import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDraggable3D, type Draggable3DReturn } from '../useDraggable3D'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let drag: Draggable3DReturn

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, pointerId })
}

describe('useDraggable3D', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  function setup(options: {
    object: THREE.Object3D
    onDrag?: (object: THREE.Object3D, position: THREE.Vector3) => void
    onDragStart?: (object: THREE.Object3D) => void
  }) {
    const container = document.createElement('div')
    document.body.append(container)
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const scene = new THREE.Scene()
    scene.add(options.object.parent ?? options.object)
    scene.updateMatrixWorld(true)
    const controls = { enabled: true } as OrbitControls
    const root = createRoot(document.createElement('div'))

    function Harness() {
      drag = useDraggable3D({
        containerRef: { current: container },
        cameraRef: { current: camera },
        sceneRef: { current: scene },
        controlsRef: { current: controls },
        draggableObjects: [options.object],
        enableFloorSnap: false,
        onDrag: options.onDrag,
        onDragStart: options.onDragStart,
      })
      return null
    }

    return { camera, container, controls, root, Harness }
  }

  it('converts world-space drag results through a transformed parent', async () => {
    const parent = new THREE.Group()
    parent.position.x = 5
    parent.scale.setScalar(2)
    const object = new THREE.Object3D()
    object.position.set(2, 1, 0)
    parent.add(object)
    const onDrag = vi.fn()
    const { container, controls, root, Harness } = setup({ object, onDrag })

    await act(async () => root.render(<Harness />))
    await act(async () =>
      drag.startDrag(object, new MouseEvent('mousedown', { clientX: 50, clientY: 50 }))
    )
    expect(controls.enabled).toBe(false)

    await act(async () => container.dispatchEvent(pointerEvent('pointermove', 60, 50)))

    const worldPosition = object.getWorldPosition(new THREE.Vector3())
    const callbackPosition = onDrag.mock.calls.at(-1)?.[1] as THREE.Vector3
    expect(callbackPosition.x).toBeCloseTo(worldPosition.x)
    expect(callbackPosition.y).toBeCloseTo(worldPosition.y)
    expect(callbackPosition.z).toBeCloseTo(worldPosition.z)
    expect(worldPosition.x).toBeCloseTo(10.1547005)
    expect(object.position.x).toBeCloseTo((worldPosition.x - 5) / 2)

    await act(async () => container.dispatchEvent(pointerEvent('pointerup', 60, 50)))
    expect(controls.enabled).toBe(true)
    expect(drag.isDragging).toBe(false)
    await act(async () => root.unmount())
  })

  it('releases capture, restores controls, and rolls back motion on unmount', async () => {
    const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    const originalPosition = object.position.clone()
    const { container, controls, root, Harness } = setup({ object })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(container, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })

    await act(async () => root.render(<Harness />))
    vi.spyOn(drag.raycaster, 'intersectObjects').mockReturnValue([
      { distance: 0, point: new THREE.Vector3(), object },
    ])
    await act(async () => container.dispatchEvent(pointerEvent('pointerdown', 50, 50, 7)))
    await act(async () => container.dispatchEvent(pointerEvent('pointermove', 60, 50, 7)))
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(controls.enabled).toBe(false)
    expect(object.position.equals(originalPosition)).toBe(false)

    await act(async () => root.unmount())

    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(controls.enabled).toBe(true)
    expect(object.position.equals(originalPosition)).toBe(true)
  })

  it('restores lifecycle state when the drag-start callback fails', async () => {
    const object = new THREE.Object3D()
    const failure = new Error('drag start failed')
    const { controls, root, Harness } = setup({
      object,
      onDragStart: () => {
        throw failure
      },
    })
    await act(async () => root.render(<Harness />))

    expect(() =>
      drag.startDrag(object, new MouseEvent('mousedown', { clientX: 50, clientY: 50 }))
    ).toThrow(failure)
    expect(controls.enabled).toBe(true)
    expect(drag.isDragging).toBe(false)

    await act(async () => root.unmount())
  })
})
