import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MAX_ROUTE_WAYPOINTS, parseWaypointInput } from '../../lib/routeLimits'
import type { RouteMode, Waypoint } from '../../hooks/useDroneController'

vi.mock('../BasePanel', () => ({
  BasePanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))

import { DroneSpawnPanel } from '../DroneSpawnPanel'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  valueSetter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('DroneSpawnPanel route admission', () => {
  let container: HTMLDivElement
  let root: Root
  let onSetRoute: Mock<(droneId: string, waypoints: Waypoint[], mode: RouteMode) => void>

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    onSetRoute = vi.fn<(droneId: string, waypoints: Waypoint[], mode: RouteMode) => void>()
    await act(async () => {
      root.render(
        <DroneSpawnPanel
          onSpawnDrone={vi.fn()}
          onSelectDrone={vi.fn()}
          onRemoveDrone={vi.fn()}
          onSetRoute={onSetRoute}
          activeDrones={[
            {
              id: 'drone-1',
              type: 'maverick',
              name: 'ALPHA',
              armed: false,
              battery: 1,
              route: {
                waypoints: [],
                mode: 'none',
                currentWaypointIndex: 0,
                isActive: false,
                arrivalThreshold: 2,
              },
            },
          ]}
          selectedDroneId="drone-1"
        />
      )
    })
    await act(async () => findButton(container, 'BEARBEITEN').click())
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('parses zero exactly and rejects blank, partial, and non-finite fields', () => {
    expect(parseWaypointInput({ x: '0', y: '0', z: '-0' })).toEqual({ x: 0, y: 0, z: -0 })
    expect(parseWaypointInput({ x: '', y: '0', z: '0' })).toBeNull()
    expect(parseWaypointInput({ x: '1 trailing', y: '0', z: '0' })).toBeNull()
    expect(parseWaypointInput({ x: '1e999', y: '0', z: '0' })).toBeNull()
  })

  it('preserves a valid zero altitude in both route fields', async () => {
    const inputs = Array.from(container.querySelectorAll('input[type="number"]'))
    expect(inputs).toHaveLength(3)
    await act(async () => {
      changeInput(inputs[0] as HTMLInputElement, '5')
      changeInput(inputs[1] as HTMLInputElement, '0')
      changeInput(inputs[2] as HTMLInputElement, '-2')
    })
    await act(async () => findButton(container, 'WEGPUNKT').click())
    await act(async () => findButton(container, 'ROUTE ANWENDEN').click())

    expect(onSetRoute).toHaveBeenCalledTimes(1)
    const waypoint = onSetRoute.mock.calls[0][1][0]
    expect(waypoint.altitude).toBe(0)
    expect(waypoint.position.toArray()).toEqual([5, 0, -2])
  })

  it('enforces the selected drone profile altitude ceiling', async () => {
    const inputs = Array.from(container.querySelectorAll('input[type="number"]'))
    const altitude = inputs[1] as HTMLInputElement
    const addWaypoint = findButton(container, 'WEGPUNKT')

    await act(async () => changeInput(altitude, '501'))
    expect(addWaypoint.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('500')

    await act(async () => changeInput(altitude, '500'))
    expect(addWaypoint.disabled).toBe(false)
  })

  it('rejects invalid input and caps queued waypoints at the named limit', async () => {
    const inputs = Array.from(container.querySelectorAll('input[type="number"]'))
    await act(async () => changeInput(inputs[1] as HTMLInputElement, ''))
    const addWaypoint = findButton(container, 'WEGPUNKT')
    expect(addWaypoint.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    await act(async () => changeInput(inputs[1] as HTMLInputElement, '10'))
    expect(addWaypoint.disabled).toBe(false)
    await act(async () => {
      for (let index = 0; index < MAX_ROUTE_WAYPOINTS + 1; index += 1) addWaypoint.click()
    })

    expect(container.textContent).toContain(
      `${MAX_ROUTE_WAYPOINTS} / ${MAX_ROUTE_WAYPOINTS} WEGPUNKTE`
    )
    expect(findButton(container, 'WEGPUNKT').disabled).toBe(true)
    await act(async () => findButton(container, 'ROUTE ANWENDEN').click())
    expect(onSetRoute.mock.calls[0][1]).toHaveLength(MAX_ROUTE_WAYPOINTS)
  })
})
