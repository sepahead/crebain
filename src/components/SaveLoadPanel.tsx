/**
 * CREBAIN Save/Load Panel
 * UI for saving and loading complete scene state
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { sceneStateManager, type SceneState } from '../state/SceneState'
import { BasePanel } from './BasePanel'
import { sceneLogger as log } from '../lib/logger'

interface SaveLoadPanelProps {
  onCreateSnapshot?: (sceneName: string) => SceneState
  onSave?: (state: SceneState) => void
  onLoad?: (state: SceneState) => void | Promise<void>
  currentSceneName?: string
  isExpanded?: boolean
  onToggleExpand?: () => void
  canLoad?: boolean
}

export function SaveLoadPanel({
  onCreateSnapshot,
  onSave,
  onLoad,
  currentSceneName = 'Unbenannte Szene',
  isExpanded = true,
  onToggleExpand,
  canLoad = true,
}: SaveLoadPanelProps) {
  const [sceneName, setSceneName] = useState(currentSceneName)
  const [savedStates, setSavedStates] = useState<
    Array<{ key: string; name: string; timestamp: number }>
  >([])
  const [showLoadMenu, setShowLoadMenu] = useState(false)
  const [lastSaveTime, setLastSaveTime] = useState<number | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [autosaveEnabled, setAutosaveEnabled] = useState(() =>
    sceneStateManager.isAutosaveEnabled()
  )
  const [isLoading, setIsLoading] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const statusResetRef = useRef<number | null>(null)
  const loadInFlightRef = useRef(false)
  const mountedRef = useRef(true)

  const AUTOSAVE_INTERVAL_S = 30

  const setTransientSaveStatus = useCallback((status: 'saved' | 'error', resetAfterMs: number) => {
    if (statusResetRef.current !== null) window.clearTimeout(statusResetRef.current)
    setSaveStatus(status)
    statusResetRef.current = window.setTimeout(() => {
      setSaveStatus('idle')
      statusResetRef.current = null
    }, resetAfterMs)
  }, [])

  const createSnapshot = useCallback((): SceneState => {
    const normalizedName = sceneName.trim()
    if (!normalizedName || normalizedName.length > 256) {
      throw new Error('Der Szenenname muss 1 bis 256 Zeichen enthalten')
    }
    const state =
      onCreateSnapshot?.(normalizedName) ??
      sceneStateManager.getState() ??
      sceneStateManager.createNew(normalizedName)
    sceneStateManager.updateState({ name: normalizedName })
    return sceneStateManager.getState() ?? state
  }, [onCreateSnapshot, sceneName])
  const createSnapshotRef = useRef(createSnapshot)
  createSnapshotRef.current = createSnapshot

  const toggleAutosave = useCallback(() => {
    setAutosaveEnabled((enabled) => !enabled)
  }, [])

  const handleAutosaveError = useCallback((error: Error) => {
    log.error('Autosave stopped', { error })
    if (!mountedRef.current) return
    setAutosaveEnabled(false)
    setOperationError(error.message)
    setSaveStatus('error')
  }, [])

  useEffect(() => {
    if (autosaveEnabled) {
      sceneStateManager.enableAutosave(
        AUTOSAVE_INTERVAL_S,
        () => createSnapshotRef.current(),
        handleAutosaveError
      )
    } else {
      sceneStateManager.disableAutosave()
    }
    return () => sceneStateManager.disableAutosave()
  }, [autosaveEnabled, handleAutosaveError])

  // Refresh saved states list
  const refreshSavedStates = useCallback(() => {
    const states = sceneStateManager.listSavedStates()
    setSavedStates(states)
  }, [])

  // Save to localStorage
  const handleQuickSave = useCallback(() => {
    setSaveStatus('saving')
    setOperationError(null)
    try {
      const state = createSnapshot()
      if (!sceneStateManager.saveToLocalStorage(`crebain_scene_${Date.now()}`)) {
        throw new Error('Local scene storage is unavailable or full')
      }
      setLastSaveTime(Date.now())
      setTransientSaveStatus('saved', 2000)
      onSave?.(state)
      refreshSavedStates()
    } catch (error) {
      log.error('Failed to quick-save scene', { error })
      setOperationError(error instanceof Error ? error.message : 'Speichern fehlgeschlagen')
      setTransientSaveStatus('error', 3000)
    }
  }, [createSnapshot, onSave, refreshSavedStates, setTransientSaveStatus])

  // Save to file
  const handleSaveToFile = useCallback(async () => {
    setSaveStatus('saving')
    setOperationError(null)
    try {
      const state = createSnapshot()
      const safeSceneName =
        sceneName
          .trim()
          .replace(/[^a-zA-Z0-9._-]+/g, '_')
          .replace(/^\.+/, '') || 'scene'
      await sceneStateManager.saveToFileSystem(`crebain_${safeSceneName}_${Date.now()}.json`)
      if (!mountedRef.current) return
      setLastSaveTime(Date.now())
      setTransientSaveStatus('saved', 2000)
      onSave?.(state)
    } catch (error) {
      log.error('Failed to save scene to file', { error })
      if (mountedRef.current) {
        setOperationError(error instanceof Error ? error.message : 'Export fehlgeschlagen')
        setTransientSaveStatus('error', 3000)
      }
    }
  }, [createSnapshot, sceneName, onSave, setTransientSaveStatus])

  const performLoad = useCallback(
    async (readState: () => SceneState | null | Promise<SceneState | null>) => {
      if (loadInFlightRef.current || !canLoad) return
      loadInFlightRef.current = true
      setIsLoading(true)
      setOperationError(null)
      const shouldResumeAutosave = autosaveEnabled
      let restoreMayBePartial = false
      sceneStateManager.disableAutosave()
      try {
        const state = await readState()
        if (!state) throw new Error('Scene state is unavailable or invalid')
        restoreMayBePartial = true
        await onLoad?.(state)
        restoreMayBePartial = false
        if (!mountedRef.current) return
        setSceneName(state.name)
        setShowLoadMenu(false)
      } catch (error) {
        log.error('Failed to load scene', { error })
        if (mountedRef.current) {
          setOperationError(error instanceof Error ? error.message : 'Laden fehlgeschlagen')
          setTransientSaveStatus('error', 3000)
        }
      } finally {
        loadInFlightRef.current = false
        if (mountedRef.current) {
          setIsLoading(false)
          if (shouldResumeAutosave && !restoreMayBePartial) {
            sceneStateManager.enableAutosave(
              AUTOSAVE_INTERVAL_S,
              () => createSnapshotRef.current(),
              handleAutosaveError
            )
          } else if (restoreMayBePartial) {
            setAutosaveEnabled(false)
            log.warn('Autosave remains disabled after a partial scene restore failure')
          }
        }
      }
    },
    [autosaveEnabled, canLoad, handleAutosaveError, onLoad, setTransientSaveStatus]
  )

  // Load from localStorage
  const handleLoadFromStorage = useCallback(
    (key: string) => performLoad(() => sceneStateManager.loadFromLocalStorage(key)),
    [performLoad]
  )

  // Load from file
  const handleLoadFromFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        void performLoad(() => sceneStateManager.loadFromFile(file))
      }
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [performLoad]
  )

  // Delete saved state
  const handleDelete = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.stopPropagation()
      sceneStateManager.deleteSavedState(key)
      refreshSavedStates()
    },
    [refreshSavedStates]
  )

  // Format timestamp
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Initialize saved states list on mount
  useEffect(() => {
    refreshSavedStates()
  }, [refreshSavedStates])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (statusResetRef.current !== null) window.clearTimeout(statusResetRef.current)
    }
  }, [])

  return (
    <BasePanel
      panelId="saveLoad"
      title="SZENEN VERWALTUNG"
      theme="orange"
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      widthClass="w-52"
      collapsedContent={
        <div className="flex items-center gap-2">
          <span className="text-[#ffaa4a]">SZENEN</span>
          <span className="text-[#505050]">|</span>
          <span className={autosaveEnabled ? 'text-[#3a6b4a]' : 'text-[#505050]'}>
            AUTOSAVE {autosaveEnabled ? '●' : '○'}
          </span>
        </div>
      }
    >
      {/* Scene Name */}
      <div className="p-2 border-b border-[#1a1a1a]">
        <label htmlFor="scene-name" className="text-[#606060] block mb-1">
          SZENENNAME:
        </label>
        <input
          id="scene-name"
          type="text"
          value={sceneName}
          onChange={(e) => setSceneName(e.target.value)}
          required
          maxLength={256}
          aria-invalid={!sceneName.trim() || sceneName.trim().length > 256}
          className="min-h-10 w-full border border-[#2a2a2a] bg-[#0a0a0a] px-2 text-[#c0c0c0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ffaa4a]"
        />
      </div>

      {/* Quick Actions */}
      <div className="p-2 border-b border-[#1a1a1a] space-y-1">
        {/* Quick Save */}
        <button
          type="button"
          onClick={handleQuickSave}
          disabled={saveStatus === 'saving' || isLoading}
          className={`flex min-h-10 w-full items-center justify-center gap-1 border px-2 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#aaff4a] ${
            saveStatus === 'saved'
              ? 'bg-[#1a3a1a] border-[#2a5a2a] text-[#4aff4a]'
              : saveStatus === 'error'
                ? 'bg-[#3a1a1a] border-[#5a2a2a] text-[#ff4a4a]'
                : 'bg-[#2a3a1a] border-[#3a5a2a] text-[#aaff4a] hover:bg-[#3a4a2a]'
          }`}
        >
          {saveStatus === 'saving'
            ? '⏳ SPEICHERN...'
            : saveStatus === 'saved'
              ? '✓ GESPEICHERT'
              : saveStatus === 'error'
                ? '✗ FEHLER'
                : '💾 SCHNELLSPEICHERN'}
        </button>

        {/* Save to File */}
        <button
          type="button"
          onClick={() => void handleSaveToFile()}
          disabled={saveStatus === 'saving' || isLoading}
          className="min-h-10 w-full border border-[#2a4a5a] bg-[#1a2a3a] px-2 font-bold text-[#69aaff] hover:bg-[#2a3a4a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#69aaff]"
        >
          📁 ALS DATEI EXPORTIEREN
        </button>

        {/* Load Menu Toggle */}
        <button
          type="button"
          onClick={() => {
            setShowLoadMenu(!showLoadMenu)
            if (!showLoadMenu) refreshSavedStates()
          }}
          disabled={isLoading || !canLoad}
          className="min-h-10 w-full border border-[#4a4a2a] bg-[#2a2a1a] px-2 font-bold text-[#ffb866] hover:bg-[#3a3a2a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ffb866]"
          aria-expanded={showLoadMenu}
        >
          {isLoading
            ? '⏳ WIRD GELADEN...'
            : !canLoad
              ? 'PHYSIK WIRD INITIALISIERT...'
              : showLoadMenu
                ? '▲ SCHLIESSEN'
                : '📂 LADEN...'}
        </button>
      </div>

      {/* Load Menu */}
      {showLoadMenu && (
        <div className="p-2 border-b border-[#1a1a1a] bg-[#0e0e0e]">
          {/* Load from File */}
          <div className="mb-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleLoadFromFile}
              disabled={isLoading || !canLoad}
              className="sr-only"
              tabIndex={-1}
              id="scene-file-input"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || !canLoad}
              className="block min-h-10 w-full border border-[#2a2a4a] bg-[#1a1a2a] py-1 text-center text-[#9a9aff] hover:bg-[#2a2a3a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9a9aff]"
            >
              📁 DATEI IMPORTIEREN
            </button>
          </div>

          {/* Saved States List */}
          <div className="text-[#606060] mb-1">GESPEICHERTE SZENEN:</div>
          {savedStates.length === 0 ? (
            <div className="text-[#404040] text-center py-2">Keine gespeicherten Szenen</div>
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {savedStates.map(({ key, name, timestamp }) => (
                <div key={key} className="flex bg-[#0a0a0a] border border-[#1a1a1a]">
                  <button
                    type="button"
                    onClick={() => void handleLoadFromStorage(key)}
                    disabled={isLoading || !canLoad}
                    className="min-h-10 min-w-0 flex-1 px-2 py-1 text-left hover:bg-[#121212] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ffaa4a]"
                    aria-label={`Szene ${name} vom ${formatTime(timestamp)} laden`}
                  >
                    <div className="text-[#c0c0c0]">{name}</div>
                    <div className="text-[#505050] text-[0.875em]">{formatTime(timestamp)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDelete(key, e)}
                    disabled={isLoading}
                    className="min-h-10 min-w-10 px-2 text-[#ff6a6a] hover:text-[#ff8a8a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ff8a8a]"
                    title="Löschen"
                    aria-label={`Szene ${name} löschen`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Status */}
      {lastSaveTime && (
        <div className="px-2 py-1 text-[#404040] text-[0.875em]">
          Zuletzt gespeichert: {formatTime(lastSaveTime)}
        </div>
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {isLoading
          ? 'Szene wird geladen'
          : saveStatus === 'saving'
            ? 'Szene wird gespeichert'
            : (operationError ?? (saveStatus === 'saved' ? 'Szene gespeichert' : ''))}
      </div>
      {operationError && (
        <div role="alert" className="border-t border-[#4a2525] px-2 py-2 text-[#e58b8b]">
          {operationError}
        </div>
      )}

      {/* Autosave Toggle */}
      <div className="px-2 py-1 border-t border-[#1a1a1a] flex items-center justify-between">
        <span className="text-[#606060]">AUTOSAVE:</span>
        <button
          type="button"
          onClick={toggleAutosave}
          disabled={isLoading}
          aria-pressed={autosaveEnabled}
          className={
            autosaveEnabled
              ? 'min-h-10 px-2 bg-[#1a2a1a] border border-[#2a4a2a] text-[#74ff74] text-[0.875em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#74ff74]'
              : 'min-h-10 px-2 bg-[#1a1a1a] border border-[#2a2a2a] text-[#808080] text-[0.875em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#808080]'
          }
        >
          {autosaveEnabled ? `● AKTIV (${AUTOSAVE_INTERVAL_S}s)` : '○ AUS'}
        </button>
      </div>
    </BasePanel>
  )
}

export default SaveLoadPanel
