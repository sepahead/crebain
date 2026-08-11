import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import ObjectTransformControls from '../ObjectTransformControls'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe('ObjectTransformControls keyboard lifecycle', () => {
  it('registers shortcuts only while visible and documents the implemented keys', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const object = new THREE.Object3D()
    const onTransform = vi.fn()

    await act(async () => {
      root.render(
        <ObjectTransformControls object={object} onTransform={onTransform} visible={false} />
      )
    })
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' })))
    expect(object.rotation.x).toBe(0)
    expect(onTransform).not.toHaveBeenCalled()

    await act(async () => {
      root.render(<ObjectTransformControls object={object} onTransform={onTransform} visible />)
    })
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' })))
    expect(object.rotation.x).toBeCloseTo(-Math.PI / 8)
    expect(onTransform).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('ROT: I/K J/L ,/.')
    expect(container.textContent).not.toContain('U/O')
    expect(container.textContent).not.toContain('LÖSCHEN: ⌫')

    await act(async () => {
      root.render(
        <ObjectTransformControls object={object} onTransform={onTransform} visible={false} />
      )
    })
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })))
    expect(object.rotation.x).toBeCloseTo(-Math.PI / 8)
    expect(onTransform).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
  })

  it('ignores shortcuts from editable controls', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const object = new THREE.Object3D()

    await act(async () => {
      root.render(<ObjectTransformControls object={object} visible />)
    })
    const input = document.createElement('input')
    document.body.append(input)
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }))
    )
    expect(object.rotation.x).toBe(0)
    input.remove()

    await act(async () => root.unmount())
  })

  it('uses separate drag and keyboard disclosure surfaces', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const object = new THREE.Object3D()
    object.name = 'camera-rig'

    await act(async () => {
      root.render(<ObjectTransformControls object={object} visible />)
    })

    const dragSurface = container.querySelector<HTMLElement>('[data-drag-handle]')
    const disclosure = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse transform controls for camera-rig"]'
    )
    expect(dragSurface?.tagName).toBe('DIV')
    expect(disclosure?.hasAttribute('data-drag-handle')).toBe(false)
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => disclosure?.click())
    expect(container.querySelector('#object-transform-controls-content')).toBeNull()
    expect(
      container.querySelector('[aria-label="Expand transform controls for camera-rig"]')
    ).not.toBeNull()

    await act(async () => root.unmount())
  })
})
