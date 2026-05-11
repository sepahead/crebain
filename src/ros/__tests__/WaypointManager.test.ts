import { describe, expect, it, vi } from 'vitest'
import { WaypointCommand, WaypointFrame, WaypointManager } from '../WaypointManager'
import type { ROSBridge } from '../ROSBridge'
import type { WaypointList } from '../types'

function createBridge(response: { success: boolean; wp_received: number }) {
  let waypointCallback: ((msg: WaypointList) => void) | null = null
  const unsubscribe = vi.fn()
  const bridge = {
    subscribe: vi.fn((_topic: string, _type: string, callback: (msg: WaypointList) => void) => {
      waypointCallback = callback
      return unsubscribe
    }),
    callService: vi.fn(async () => response),
  } as unknown as ROSBridge

  return { bridge, unsubscribe, emitWaypoints: (msg: WaypointList) => waypointCallback?.(msg) }
}

describe('WaypointManager', () => {
  it('builds downloaded missions from MAVROS waypoint lists', async () => {
    const manager = new WaypointManager()
    const { bridge, unsubscribe, emitWaypoints } = createBridge({ success: true, wp_received: 1 })
    manager.connect(bridge)

    const download = manager.downloadMission()
    emitWaypoints({
      waypoints: [{
        frame: WaypointFrame.GLOBAL_RELATIVE_ALT,
        command: WaypointCommand.NAV_WAYPOINT,
        is_current: true,
        autocontinue: true,
        param1: 2,
        param2: 3,
        param3: 4,
        param4: 90,
        x_lat: 50,
        y_long: 8,
        z_alt: 120,
      }],
    })

    const mission = await download

    expect(mission?.items).toHaveLength(1)
    expect(mission?.items[0]).toMatchObject({
      frame: WaypointFrame.GLOBAL_RELATIVE_ALT,
      command: WaypointCommand.NAV_WAYPOINT,
      latitude: 50,
      longitude: 8,
      altitude: 120,
    })
    expect(mission?.isUploaded).toBe(true)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('rejects invalid waypoint counts from mission pull responses', async () => {
    const manager = new WaypointManager()
    const { bridge, unsubscribe } = createBridge({ success: true, wp_received: -1 })
    manager.connect(bridge)

    await expect(manager.downloadMission()).resolves.toBeNull()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
