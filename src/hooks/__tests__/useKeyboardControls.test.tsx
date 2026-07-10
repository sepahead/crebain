import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKeyboardControls } from '../useKeyboardControls'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let controls: ReturnType<typeof useKeyboardControls>

function Harness({ enabled, onEmergency }: { enabled: boolean; onEmergency?: () => void }) {
  controls = useKeyboardControls({ enabled, onEmergency })
  return null
}

async function renderControls(enabled = true, onEmergency?: () => void) {
  const container = document.createElement('div')
  const root = createRoot(container)

  const render = async (nextEnabled: boolean) => {
    await act(async () => {
      root.render(<Harness enabled={nextEnabled} onEmergency={onEmergency} />)
    })
  }

  await render(enabled)
  return { root, render }
}

function dispatchKey(
  type: 'keydown' | 'keyup',
  key: string,
  target: Window | HTMLElement = window
) {
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key }))
}

async function unmount(root: Root) {
  await act(async () => root.unmount())
}

describe('useKeyboardControls', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('clears a held movement key and smoothed input when the window loses focus', async () => {
    const { root } = await renderControls()

    await act(async () => dispatchKey('keydown', 'w'))
    expect(controls.getControlInput().pitch).toBeGreaterThan(0)

    await act(async () => window.dispatchEvent(new Event('blur')))

    expect(controls.keyState.forward).toBe(false)
    expect(controls.keyState.activeKeys).toEqual(new Set())
    expect(controls.getControlInput()).toEqual({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 })

    await unmount(root)
  })

  it('does not restore stale controls after disabling and re-enabling the hook', async () => {
    const { root, render } = await renderControls()

    await act(async () => dispatchKey('keydown', 'w'))
    expect(controls.getControlInput().pitch).toBeGreaterThan(0)

    await render(false)
    expect(controls.keyState.forward).toBe(false)
    expect(controls.getControlInput().pitch).toBe(0)

    await render(true)
    expect(controls.keyState.activeKeys).toEqual(new Set())
    expect(controls.getControlInput().pitch).toBe(0)

    await unmount(root)
  })

  it('triggers and releases Escape from an input while normal controls are disabled', async () => {
    const onEmergency = vi.fn()
    const { root } = await renderControls(false, onEmergency)
    const input = document.createElement('input')
    document.body.append(input)

    await act(async () => dispatchKey('keydown', 'Escape', input))

    expect(onEmergency).toHaveBeenCalledTimes(1)
    expect(controls.keyState.emergency).toBe(true)

    await act(async () => dispatchKey('keyup', 'Escape', input))
    expect(controls.keyState.emergency).toBe(false)
    expect(controls.keyState.activeKeys).toEqual(new Set())

    await unmount(root)
    onEmergency.mockClear()
    dispatchKey('keydown', 'Escape', input)
    expect(onEmergency).not.toHaveBeenCalled()
  })

  it('clears every transient key and smoothed axis when the document becomes hidden', async () => {
    const { root } = await renderControls()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

    await act(async () => {
      dispatchKey('keydown', 'w')
      dispatchKey('keydown', 'a')
      dispatchKey('keydown', 'q')
      dispatchKey('keydown', 'c')
      dispatchKey('keydown', ' ')
    })
    const activeInput = controls.getControlInput()
    expect(activeInput.pitch).toBeGreaterThan(0)
    expect(activeInput.roll).toBeLessThan(0)
    expect(activeInput.yaw).toBeLessThan(0)
    expect(activeInput.throttle).toBeGreaterThan(0.5)

    await act(async () => document.dispatchEvent(new Event('visibilitychange')))

    expect(controls.keyState).toMatchObject({
      forward: false,
      left: false,
      yawLeft: false,
      cameraSwitch: false,
      emergency: false,
    })
    expect(controls.keyState.activeKeys).toEqual(new Set())
    expect(controls.getControlInput()).toEqual({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 })

    await unmount(root)
  })
})
