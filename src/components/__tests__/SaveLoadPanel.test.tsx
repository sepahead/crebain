import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { SceneState } from '../../state/SceneState'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  updateState: vi.fn(),
  saveToFileSystem: vi.fn(),
  listSavedStates: vi.fn(),
  saveToLocalStorage: vi.fn(),
  loadFromLocalStorage: vi.fn(),
  deleteSavedState: vi.fn(),
  loadFromFile: vi.fn(),
}))

vi.mock('../../state/SceneState', () => ({
  sceneStateManager: mocks,
}))

vi.mock('../BasePanel', () => ({
  BasePanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))

vi.mock('../../lib/logger', () => ({
  sceneLogger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { SaveLoadPanel } from '../SaveLoadPanel'

function testScene(name: string): SceneState {
  return {
    version: '1.0.0',
    timestamp: 1,
    name,
    cameras: [],
    drones: [],
    recentDetections: [],
    settings: {
      detectionEnabled: true,
      showDetectionPanel: true,
      showPerformancePanel: true,
      renderQuality: 'medium',
      physicsEnabled: true,
      sensorSimulationEnabled: true,
    },
    viewCamera: {
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
    },
  }
}

describe('SaveLoadPanel backend wiring', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(12345)
    mocks.listSavedStates.mockReturnValue([])
    mocks.saveToFileSystem.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => root.unmount())
    container.remove()
  })

  it('routes visible file exports through the backend filesystem save path', async () => {
    const scene = testScene('Original Scene')
    const onSave = vi.fn()
    mocks.getState.mockReturnValue(scene)

    await act(async () => {
      root.render(<SaveLoadPanel currentSceneName="Desktop Scene" onSave={onSave} />)
    })

    const exportButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('ALS DATEI EXPORTIEREN'))
    expect(exportButton).toBeDefined()

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.updateState).toHaveBeenCalledWith({ name: 'Desktop Scene' })
    expect(mocks.saveToFileSystem).toHaveBeenCalledWith('crebain_Desktop_Scene_12345.json')
    expect(mocks.saveToLocalStorage).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(scene)
  })
})
