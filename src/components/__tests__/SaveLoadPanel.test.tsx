import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { SceneState } from '../../state/SceneState'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  createNew: vi.fn(),
  updateState: vi.fn(),
  saveToFileSystem: vi.fn(),
  listSavedStates: vi.fn(),
  saveToLocalStorage: vi.fn(),
  loadFromLocalStorage: vi.fn(),
  deleteSavedState: vi.fn(),
  loadFromFile: vi.fn(),
  isAutosaveEnabled: vi.fn(() => true),
  enableAutosave: vi.fn(),
  disableAutosave: vi.fn(),
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
    mocks.saveToLocalStorage.mockReturnValue(true)
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

    const exportButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('ALS DATEI EXPORTIEREN')
    )
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

  it('creates an initial scene before a fresh-install quick save', async () => {
    const scene = testScene('Fresh Scene')
    const onSave = vi.fn()
    mocks.getState.mockReturnValue(null)
    mocks.createNew.mockReturnValue(scene)

    await act(async () => {
      root.render(<SaveLoadPanel currentSceneName="Fresh Scene" onSave={onSave} />)
    })

    const quickSave = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('SCHNELLSPEICHERN')
    )
    await act(async () => {
      quickSave!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.createNew).toHaveBeenCalledWith('Fresh Scene')
    expect(mocks.saveToLocalStorage).toHaveBeenCalledWith('crebain_scene_12345')
    expect(onSave).toHaveBeenCalledWith(scene)
    expect(container.textContent).toContain('GESPEICHERT')
  })

  it('reports local storage failures instead of claiming a successful save', async () => {
    const scene = testScene('Quota Scene')
    const onSave = vi.fn()
    mocks.getState.mockReturnValue(scene)
    mocks.saveToLocalStorage.mockReturnValue(false)

    await act(async () => {
      root.render(<SaveLoadPanel currentSceneName="Quota Scene" onSave={onSave} />)
    })

    const quickSave = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('SCHNELLSPEICHERN')
    )
    await act(async () => {
      quickSave!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('FEHLER')
  })

  it('captures live state before exporting it', async () => {
    const scene = testScene('Live Snapshot')
    const onCreateSnapshot = vi.fn(() => scene)
    mocks.getState.mockReturnValue(scene)

    await act(async () => {
      root.render(
        <SaveLoadPanel currentSceneName="Live Snapshot" onCreateSnapshot={onCreateSnapshot} />
      )
    })

    const exportButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('ALS DATEI EXPORTIEREN')
    )
    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onCreateSnapshot).toHaveBeenCalledWith('Live Snapshot')
    expect(mocks.saveToFileSystem).toHaveBeenCalledOnce()
  })

  it('captures current viewer state on each autosave tick', async () => {
    const scene = testScene('Autosave Snapshot')
    const onCreateSnapshot = vi.fn(() => scene)
    mocks.getState.mockReturnValue(scene)

    await act(async () => {
      root.render(<SaveLoadPanel onCreateSnapshot={onCreateSnapshot} />)
    })

    expect(mocks.enableAutosave).toHaveBeenCalledWith(
      30,
      expect.any(Function),
      expect.any(Function)
    )
    const capture = mocks.enableAutosave.mock.calls.at(-1)?.[1] as (() => SceneState) | undefined
    expect(capture?.()).toBe(scene)
    expect(onCreateSnapshot).toHaveBeenCalledWith('Unbenannte Szene')
  })

  it('allows only one scene restoration at a time', async () => {
    const scene = testScene('Stored Scene')
    mocks.listSavedStates.mockReturnValue([
      { key: 'crebain_scene_one', name: scene.name, timestamp: 1 },
    ])
    mocks.loadFromLocalStorage.mockReturnValue(scene)
    let finishLoad: (() => void) | undefined
    const onLoad = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve
        })
    )

    await act(async () => {
      root.render(<SaveLoadPanel onLoad={onLoad} />)
    })
    const menuButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('LADEN')
    )
    await act(async () => menuButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const loadButton = container.querySelector(
      'button[aria-label^="Szene Stored Scene"]'
    ) as HTMLButtonElement

    await act(async () => {
      loadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      loadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.loadFromLocalStorage).toHaveBeenCalledTimes(1)
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('WIRD GELADEN')
    expect(mocks.disableAutosave).toHaveBeenCalled()
    expect(mocks.enableAutosave).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishLoad?.()
      await Promise.resolve()
    })
    expect(mocks.enableAutosave).toHaveBeenCalledTimes(2)
  })

  it('keeps autosave disabled after a partial restore failure', async () => {
    const scene = testScene('Broken Restore')
    mocks.listSavedStates.mockReturnValue([
      { key: 'crebain_scene_broken', name: scene.name, timestamp: 1 },
    ])
    mocks.loadFromLocalStorage.mockReturnValue(scene)
    const onLoad = vi.fn(async () => {
      throw new Error('asset restore failed')
    })

    await act(async () => root.render(<SaveLoadPanel onLoad={onLoad} />))
    const menuButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('LADEN')
    )
    await act(async () => menuButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const loadButton = container.querySelector(
      'button[aria-label^="Szene Broken Restore"]'
    ) as HTMLButtonElement
    await act(async () => {
      loadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onLoad).toHaveBeenCalledOnce()
    expect(mocks.enableAutosave).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('○ AUS')
  })
})
