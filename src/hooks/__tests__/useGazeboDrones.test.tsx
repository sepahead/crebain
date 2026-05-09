import { afterEach, describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useGazeboDrones, type UseGazeboDronesReturn } from '../useGazeboDrones'
import type { ModelStates } from '../../ros/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let result: UseGazeboDronesReturn

function Harness({ bridge, tick, config = {} }: { bridge: any; tick: number; config?: Record<string, unknown> }) {
  // tick forces re-render when we change the bridge's internal connection state
  void tick
  result = useGazeboDrones({ bridge, ...config })
  return null
}

function modelStates(names: string[], positions: Array<{ x: number; y: number; z: number }>): ModelStates {
  return {
    name: names,
    pose: positions.map(position => ({
      position,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    })),
    twist: positions.map((_, index) => ({
      linear: { x: index + 1, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    })),
  }
}

describe('useGazeboDrones', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes when the bridge becomes connected', async () => {
    let connected = false
    const unsubscribe = vi.fn()

    const bridge = {
      isConnected: () => connected,
      subscribeToModelStates: vi.fn(() => unsubscribe),
    }

    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness bridge={bridge} tick={0} />)
    })

    expect(bridge.subscribeToModelStates).not.toHaveBeenCalled()

    connected = true
    await act(async () => {
      root.render(<Harness bridge={bridge} tick={1} />)
    })

    expect(bridge.subscribeToModelStates).toHaveBeenCalledTimes(1)

    connected = false
    await act(async () => {
      root.render(<Harness bridge={bridge} tick={2} />)
    })

    expect(unsubscribe).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.unmount()
    })
  })

  it('converts model states into classified drones and predictions', async () => {
    let modelStatesCallback: ((msg: ModelStates) => void) | undefined
    const bridge = {
      isConnected: () => true,
      subscribeToModelStates: vi.fn((callback) => {
        modelStatesCallback = callback
        return vi.fn()
      }),
    }
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness bridge={bridge} tick={0} config={{ throttleRateMs: 0, maxHistoryLength: 2 }} />)
    })
    await act(async () => {
      modelStatesCallback?.(modelStates(
        ['friendly_drone_1', 'hostile_drone_target_1', 'ground_vehicle'],
        [{ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 20 }, { x: 100, y: 0, z: 0 }]
      ))
    })

    expect(result.drones.size).toBe(2)
    expect(result.friendlyDrones.map(drone => drone.id)).toEqual(['friendly_drone_1'])
    expect(result.hostileDrones.map(drone => drone.id)).toEqual(['hostile_drone_target_1'])
    expect(result.getDrone('hostile_drone_target_1')).toEqual(expect.objectContaining({
      type: 'hostile',
      altitude: 20,
      speed: 2,
      status: 'airborne',
    }))
    expect(result.getClosestHostile({ x: 0, y: 0, z: 0 })?.id).toBe('hostile_drone_target_1')
    expect(result.predictPosition('hostile_drone_target_1', 1_000)).toEqual({ x: 12, y: 0, z: 20 })

    await act(async () => root.unmount())
  })

  it('caps position history and removes stale drones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let modelStatesCallback: ((msg: ModelStates) => void) | undefined
    const bridge = {
      isConnected: () => true,
      subscribeToModelStates: vi.fn((callback) => {
        modelStatesCallback = callback
        return vi.fn()
      }),
    }
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness bridge={bridge} tick={0} config={{ throttleRateMs: 0, maxHistoryLength: 2 }} />)
    })
    await act(async () => {
      modelStatesCallback?.(modelStates(['friendly_drone', 'hostile_drone_target'], [{ x: 0, y: 0, z: 1 }, { x: 5, y: 0, z: 5 }]))
      modelStatesCallback?.(modelStates(['friendly_drone', 'hostile_drone_target'], [{ x: 1, y: 0, z: 1 }, { x: 6, y: 0, z: 5 }]))
      modelStatesCallback?.(modelStates(['friendly_drone', 'hostile_drone_target'], [{ x: 2, y: 0, z: 1 }, { x: 7, y: 0, z: 5 }]))
    })

    expect(result.getDrone('friendly_drone')?.positionHistory).toEqual([
      { x: 1, y: 0, z: 1 },
      { x: 2, y: 0, z: 1 },
    ])

    vi.setSystemTime(7_001)
    await act(async () => {
      modelStatesCallback?.(modelStates(['friendly_drone'], [{ x: 3, y: 0, z: 1 }]))
    })

    expect(result.getDrone('friendly_drone')).toBeDefined()
    expect(result.getDrone('hostile_drone_target')).toBeUndefined()

    await act(async () => root.unmount())
  })
})
