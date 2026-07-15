import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useObjectSelection, type ObjectSelectionReturn } from '../useObjectSelection'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let selection: ObjectSelectionReturn

describe('useObjectSelection', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('places nested-object rings in world space and runs selection effects once', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
    const parent = new THREE.Group()
    parent.position.set(10, 2, 20)
    const nestedObject = new THREE.Group()
    nestedObject.position.set(2, 3, 4)
    nestedObject.userData.id = 'nested-object'
    nestedObject.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)))
    parent.add(nestedObject)
    scene.add(parent)
    scene.updateMatrixWorld(true)
    const containerRef = { current: container }
    const cameraRef = { current: camera }
    const sceneRef = { current: scene }

    const onSelectionChange = vi.fn()
    const root = createRoot(document.createElement('div'))

    function Harness() {
      selection = useObjectSelection({
        containerRef,
        cameraRef,
        sceneRef,
        selectableObjects: [nestedObject],
        onSelectionChange,
      })
      return null
    }

    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>
      )
    })
    await act(async () => selection.select(nestedObject))

    const ring = scene.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.userData.isSelectionIndicator === true
    )
    expect(ring).toBeDefined()
    expect(ring?.position.x).toBeCloseTo(12)
    expect(ring?.position.z).toBeCloseTo(24)
    expect(selection.selectedObjects).toEqual([nestedObject])
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith([nestedObject])

    await act(async () => root.unmount())
    expect(scene.children).not.toContain(ring)
  })
})
