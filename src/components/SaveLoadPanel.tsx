/**
 * CREBAIN Save/Load Panel
 * UI for saving and loading complete scene state
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { sceneStateManager, type SceneState } from '../state/SceneState'
import { BasePanel } from './BasePanel'
import { sceneLogger as log } from '../lib/logger'

interface SaveLoadPanelProps {
  onSave?: (state: SceneState) => void
  onLoad?: (state: SceneState) => void
  currentSceneName?: string
  isExpanded?: boolean
  onToggleExpand?: () => void
}

export function SaveLoadPanel({
  onSave,
  onLoad,
  currentSceneName = 'Unbenannte Szene',
  isExpanded = true,
  onToggleExpand,
}: SaveLoadPanelProps) {
  const [sceneName, setSceneName] = useState(currentSceneName)
  const [savedStates, setSavedStates] = useState<Array<{ key: string; name: string; timestamp: number }>>([])
  const [showLoadMenu, setShowLoadMenu] = useState(false)
  const [lastSaveTime, setLastSaveTime] = useState<number | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Refresh saved states list
  const refreshSavedStates = useCallback(() => {
    const states = sceneStateManager.listSavedStates()
    setSavedStates(states)
  }, [])

  // Save to localStorage
  const handleQuickSave = useCallback(() => {
    setSaveStatus('saving')
    try {
      const state = sceneStateManager.getState()
      if (state) {
        state.name = sceneName
        sceneStateManager.updateState({ name: sceneName })
        sceneStateManager.saveToLocalStorage(`crebain_scene_${Date.now()}`)
        setLastSaveTime(Date.now())
        setSaveStatus('saved')
        onSave?.(state)
        refreshSavedStates()
        setTimeout(() => setSaveStatus('idle'), 2000)
      }
    } catch (e) {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [sceneName, onSave, refreshSavedStates])

  // Save to file
  const handleSaveToFile = useCallback(async () => {
    const state = sceneStateManager.getState()
    if (state) {
      setSaveStatus('saving')
      try {
        state.name = sceneName
        sceneStateManager.updateState({ name: sceneName })
        await sceneStateManager.saveToFileSystem(`crebain_${sceneName.replace(/\s+/g, '_')}_${Date.now()}.json`)
        setLastSaveTime(Date.now())
        setSaveStatus('saved')
        onSave?.(state)
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch (error) {
        log.error('Failed to save scene to file', { error })
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }
  }, [sceneName, onSave])

  // Load from localStorage
  const handleLoadFromStorage = useCallback((key: string) => {
    const state = sceneStateManager.loadFromLocalStorage(key)
    if (state) {
      setSceneName(state.name)
      onLoad?.(state)
      setShowLoadMenu(false)
    }
  }, [onLoad])

  // Load from file
  const handleLoadFromFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      sceneStateManager.loadFromFile(file).then(state => {
        setSceneName(state.name)
        onLoad?.(state)
        setShowLoadMenu(false)
      }).catch(err => {
        log.error('Failed to load scene', { error: err })
      })
    }
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [onLoad])

  // Delete saved state
  const handleDelete = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    sceneStateManager.deleteSavedState(key)
    refreshSavedStates()
  }, [refreshSavedStates])

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
          <span className="text-[#3a6b4a]">AUTOSAVE ●</span>
        </div>
      }
    >
      {/* Scene Name */}
      <div className="p-2 border-b border-[#1a1a1a]">
        <label className="text-[#606060] block mb-1">SZENENNAME:</label>
        <input
          type="text"
          value={sceneName}
          onChange={(e) => setSceneName(e.target.value)}
          className="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-[#c0c0c0] px-1 py-0.5"
        />
      </div>

      {/* Quick Actions */}
      <div className="p-2 border-b border-[#1a1a1a] space-y-1">
        {/* Quick Save */}
        <button
          onClick={handleQuickSave}
          disabled={saveStatus === 'saving'}
          className={`w-full py-1 border font-bold flex items-center justify-center gap-1 ${
            saveStatus === 'saved'
              ? 'bg-[#1a3a1a] border-[#2a5a2a] text-[#4aff4a]'
              : saveStatus === 'error'
              ? 'bg-[#3a1a1a] border-[#5a2a2a] text-[#ff4a4a]'
              : 'bg-[#2a3a1a] border-[#3a5a2a] text-[#aaff4a] hover:bg-[#3a4a2a]'
          }`}
        >
          {saveStatus === 'saving' ? '⏳ SPEICHERN...' : 
           saveStatus === 'saved' ? '✓ GESPEICHERT' :
           saveStatus === 'error' ? '✗ FEHLER' :
           '💾 SCHNELLSPEICHERN'}
        </button>

        {/* Save to File */}
        <button
          onClick={handleSaveToFile}
          disabled={saveStatus === 'saving'}
          className="w-full py-1 bg-[#1a2a3a] border border-[#2a4a5a] text-[#4a9aff] hover:bg-[#2a3a4a] font-bold"
        >
          📁 ALS DATEI EXPORTIEREN
        </button>

        {/* Load Menu Toggle */}
        <button
          onClick={() => {
            setShowLoadMenu(!showLoadMenu)
            if (!showLoadMenu) refreshSavedStates()
          }}
          className="w-full py-1 bg-[#2a2a1a] border border-[#4a4a2a] text-[#ffaa4a] hover:bg-[#3a3a2a] font-bold"
        >
          {showLoadMenu ? '▲ SCHLIESSEN' : '📂 LADEN...'}
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
              className="hidden"
              id="scene-file-input"
            />
            <label
              htmlFor="scene-file-input"
              className="block w-full py-1 bg-[#1a1a2a] border border-[#2a2a4a] text-[#9a9aff] hover:bg-[#2a2a3a] text-center cursor-pointer"
            >
              📁 DATEI IMPORTIEREN
            </label>
          </div>

          {/* Saved States List */}
          <div className="text-[#606060] mb-1">GESPEICHERTE SZENEN:</div>
          {savedStates.length === 0 ? (
            <div className="text-[#404040] text-center py-2">
              Keine gespeicherten Szenen
            </div>
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {savedStates.map(({ key, name, timestamp }) => (
                <div
                  key={key}
                  onClick={() => handleLoadFromStorage(key)}
                  className="p-1 bg-[#0a0a0a] border border-[#1a1a1a] hover:border-[#2a2a2a] cursor-pointer flex items-center justify-between"
                >
                  <div>
                    <div className="text-[#c0c0c0]">{name}</div>
                    <div className="text-[#505050] text-[0.875em]">{formatTime(timestamp)}</div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(key, e)}
                    className="text-[#ff4a4a] hover:text-[#ff6a6a] px-1"
                    title="Löschen"
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

      {/* Autosave Toggle */}
      <div className="px-2 py-1 border-t border-[#1a1a1a] flex items-center justify-between">
        <span className="text-[#606060]">AUTOSAVE:</span>
        <button
          onClick={() => {
            // Toggle autosave - for now just show status
            sceneStateManager.enableAutosave(30)
          }}
          className="px-2 py-0.5 bg-[#1a2a1a] border border-[#2a4a2a] text-[#4aff4a] text-[0.875em]"
        >
          ● AKTIV (30s)
        </button>
      </div>
    </BasePanel>
  )
}

export default SaveLoadPanel
