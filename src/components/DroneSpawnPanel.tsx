/**
 * CREBAIN Drone Spawn Panel
 * UI for spawning and controlling different drone types
 */

import { useState, useCallback } from 'react'
import * as THREE from 'three'
import { DRONE_TYPES, type DroneTypeDefinition } from '../physics/DroneTypes'
import { BasePanel } from './BasePanel'
import { getCategoryIcon, getCategoryColor } from '../lib/droneCategories'
import {
  isAdmissibleRouteWaypoints,
  MAX_ROUTE_ALTITUDE_M,
  MAX_ROUTE_COORDINATE_MAGNITUDE_M,
  MAX_ROUTE_WAYPOINTS,
  parseWaypointInput,
} from '../lib/routeLimits'
import type { RouteMode, Waypoint, DroneRoute } from '../hooks/useDroneController'

interface DroneSpawnPanelProps {
  onSpawnDrone: (typeId: string, name?: string) => void
  onSelectDrone: (droneId: string | null) => void
  onRemoveDrone: (droneId: string) => void
  onRenameDrone?: (droneId: string, newName: string) => void
  onSetRoute?: (droneId: string, waypoints: Waypoint[], mode: RouteMode) => void
  onClearRoute?: (droneId: string) => void
  onToggleRoute?: (droneId: string, active?: boolean) => void
  activeDrones: Array<{
    id: string
    type: string
    name: string
    armed: boolean
    battery: number
    route?: DroneRoute
  }>
  selectedDroneId: string | null
  isExpanded?: boolean
  onToggleExpand?: () => void
}

export function DroneSpawnPanel({
  onSpawnDrone,
  onSelectDrone,
  onRemoveDrone,
  onRenameDrone,
  onSetRoute,
  onClearRoute,
  onToggleRoute,
  activeDrones,
  selectedDroneId,
  isExpanded = true,
  onToggleExpand,
}: DroneSpawnPanelProps) {
  const [selectedType, setSelectedType] = useState<string>('maverick')
  const [customName, setCustomName] = useState<string>('')
  const [showSpawnMenu, setShowSpawnMenu] = useState(false)
  const [showRouteEditor, setShowRouteEditor] = useState(false)
  const [routeMode, setRouteMode] = useState<RouteMode>('once')
  const [waypointInput, setWaypointInput] = useState({ x: '0', y: '10', z: '0' })
  const [pendingWaypoints, setPendingWaypoints] = useState<Waypoint[]>([])

  const [editingDroneId, setEditingDroneId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const droneTypes = Object.values(DRONE_TYPES)
  const selectedDrone = activeDrones.find((drone) => drone.id === selectedDroneId)
  const maxRouteAltitude =
    (selectedDrone && DRONE_TYPES[selectedDrone.type]?.physics.maxAltitude) ?? MAX_ROUTE_ALTITUDE_M
  const routeAdmissionLimits = { maxAltitude: maxRouteAltitude }
  const parsedWaypointInput = parseWaypointInput(waypointInput, routeAdmissionLimits)
  const waypointLimitReached = pendingWaypoints.length >= MAX_ROUTE_WAYPOINTS
  const canAddWaypoint = parsedWaypointInput !== null && !waypointLimitReached

  const handleSpawn = useCallback(() => {
    onSpawnDrone(selectedType, customName || undefined)
    setCustomName('')
    setShowSpawnMenu(false)
  }, [selectedType, customName, onSpawnDrone])

  const handleAddWaypoint = useCallback(() => {
    const parsed = parseWaypointInput(waypointInput, { maxAltitude: maxRouteAltitude })
    if (!parsed || pendingWaypoints.length >= MAX_ROUTE_WAYPOINTS) return
    const { x, y, z } = parsed

    const waypoint: Waypoint = {
      position: new THREE.Vector3(x, y, z),
      altitude: y,
    }

    setPendingWaypoints((prev) => (prev.length >= MAX_ROUTE_WAYPOINTS ? prev : [...prev, waypoint]))
    setWaypointInput({ x: String(x + 10), y: String(y), z: String(z) })
  }, [waypointInput, pendingWaypoints.length, maxRouteAltitude])

  const handleApplyRoute = useCallback(() => {
    if (
      selectedDroneId &&
      onSetRoute &&
      pendingWaypoints.length > 0 &&
      isAdmissibleRouteWaypoints(pendingWaypoints, { maxAltitude: maxRouteAltitude })
    ) {
      onSetRoute(selectedDroneId, pendingWaypoints, routeMode)
      setShowRouteEditor(false)
    }
  }, [selectedDroneId, onSetRoute, pendingWaypoints, routeMode, maxRouteAltitude])

  const handleClearPendingWaypoints = useCallback(() => {
    setPendingWaypoints([])
  }, [])

  return (
    <BasePanel
      panelId="droneSpawn"
      title="DROHNEN STEUERUNG"
      theme="blue"
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      widthClass="w-56"
      headerRight={
        <span className={activeDrones.length > 0 ? 'text-[#3a6b4a]' : 'text-[#404040]'}>
          {activeDrones.length} AKTIV
        </span>
      }
      collapsedContent={
        <div className="flex items-center gap-2">
          <span className="text-[#4a9aff]">DROHNEN</span>
          <span className="text-[#505050]">|</span>
          <span className={activeDrones.length > 0 ? 'text-[#3a6b4a]' : 'text-[#404040]'}>
            {activeDrones.length} AKTIV
          </span>
        </div>
      }
    >
      {/* Spawn Section */}
      <div className="p-2 border-b border-[#1a1a1a]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[#808080]">NEUE DROHNE</span>
          <button
            onClick={() => setShowSpawnMenu(!showSpawnMenu)}
            className="px-2 py-0.5 bg-[#1a3a1a] border border-[#2a5a2a] text-[#4aff4a] hover:bg-[#2a4a2a]"
          >
            {showSpawnMenu ? '▲ SCHLIESSEN' : '▼ ERSTELLEN'}
          </button>
        </div>

        {showSpawnMenu && (
          <div className="space-y-2 mt-2 p-2 bg-[#0e0e0e] border border-[#1a1a1a]">
            {/* Type Selection */}
            <div>
              <label className="text-[#606060] block mb-1">TYP:</label>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-[#c0c0c0] px-1 py-0.5"
              >
                {droneTypes.map((type: DroneTypeDefinition) => (
                  <option key={type.id} value={type.id}>
                    {getCategoryIcon(type.category)} {type.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Selected Type Info */}
            {selectedType && DRONE_TYPES[selectedType] && (
              <div className="text-[#606060] p-1 bg-[#0a0a0a] border border-[#1a1a1a]">
                <div className="text-[#808080] mb-1">{DRONE_TYPES[selectedType].description}</div>
                <div className="grid grid-cols-2 gap-1 text-[0.875em]">
                  <span>Masse: {DRONE_TYPES[selectedType].physics.mass}kg</span>
                  <span>Vmax: {DRONE_TYPES[selectedType].physics.maxSpeed}m/s</span>
                  <span>Höhe: {DRONE_TYPES[selectedType].physics.maxAltitude}m</span>
                  <span>Dauer: {DRONE_TYPES[selectedType].physics.endurance}min</span>
                </div>
              </div>
            )}

            {/* Custom Name */}
            <div>
              <label className="text-[#606060] block mb-1">NAME (OPTIONAL):</label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="z.B. ALPHA-1"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-[#c0c0c0] px-1 py-0.5 placeholder-[#404040]"
              />
            </div>

            {/* Spawn Button */}
            <button
              onClick={handleSpawn}
              className="w-full py-1 bg-[#2a4a2a] border border-[#3a6a3a] text-[#4aff4a] hover:bg-[#3a5a3a] font-bold"
            >
              ➕ DROHNE SPAWNEN
            </button>
          </div>
        )}
      </div>

      {/* Active Drones List */}
      <div className="p-2">
        <div className="text-[#808080] mb-2">AKTIVE DROHNEN ({activeDrones.length})</div>

        {activeDrones.length === 0 ? (
          <div className="text-[#404040] text-center py-2">Keine aktiven Drohnen</div>
        ) : (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {activeDrones.map((drone) => {
              const droneType = DRONE_TYPES[drone.type]
              const isSelected = drone.id === selectedDroneId

              return (
                <div
                  key={drone.id}
                  onClick={() => onSelectDrone(isSelected ? null : drone.id)}
                  className={`p-1.5 border cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-[#1a2a3a] border-[#4a9aff]'
                      : 'bg-[#0e0e0e] border-[#1a1a1a] hover:border-[#2a2a2a]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    {editingDroneId === drone.id ? (
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => {
                          if (editingName.trim() && onRenameDrone) {
                            onRenameDrone(drone.id, editingName.trim())
                          }
                          setEditingDroneId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (editingName.trim() && onRenameDrone) {
                              onRenameDrone(drone.id, editingName.trim())
                            }
                            setEditingDroneId(null)
                          } else if (e.key === 'Escape') {
                            setEditingDroneId(null)
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                        className="bg-[#0a0a0a] border border-[#4a9aff] text-[#c0c0c0] px-1 py-0 w-24"
                      />
                    ) : (
                      <span
                        className="text-[#c0c0c0]"
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          setEditingDroneId(drone.id)
                          setEditingName(drone.name)
                        }}
                        title="Doppelklick zum Umbenennen"
                      >
                        {getCategoryIcon(droneType?.category || 'quadcopter')} {drone.name}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <span className={drone.armed ? 'text-[#4aff4a]' : 'text-[#ff4a4a]'}>
                        {drone.armed ? '● ARMED' : '○ SAFE'}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onRemoveDrone(drone.id)
                        }}
                        className="text-[#ff4a4a] hover:text-[#ff6a6a] px-1"
                        title="Drohne entfernen"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Battery Bar */}
                  <div className="mt-1 flex items-center gap-1">
                    <span className="text-[#606060]">BAT:</span>
                    <div className="flex-1 h-1 bg-[#1a1a1a] border border-[#2a2a2a]">
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${drone.battery * 100}%`,
                          backgroundColor:
                            drone.battery > 0.3
                              ? '#4aff4a'
                              : drone.battery > 0.1
                                ? '#ffaa4a'
                                : '#ff4a4a',
                        }}
                      />
                    </div>
                    <span className="text-[#808080] w-8 text-right">
                      {Math.round(drone.battery * 100)}%
                    </span>
                  </div>

                  {/* Type indicator */}
                  <div
                    className="mt-0.5 text-[0.875em]"
                    style={{ color: getCategoryColor(droneType?.category || 'quadcopter') }}
                  >
                    {droneType?.name || drone.type}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Controls Help */}
      {selectedDroneId && (
        <div className="p-2 border-t border-[#1a1a1a] bg-[#0e0e0e]">
          <div className="text-[#4a9aff] mb-1">STEUERUNG:</div>
          <div className="grid grid-cols-2 gap-x-2 text-[0.875em] text-[#606060]">
            <span>
              <kbd className="bg-[#1a1a1a] px-1">W</kbd>
              <kbd className="bg-[#1a1a1a] px-1">S</kbd> Pitch
            </span>
            <span>
              <kbd className="bg-[#1a1a1a] px-1">A</kbd>
              <kbd className="bg-[#1a1a1a] px-1">D</kbd> Roll
            </span>
            <span>
              <kbd className="bg-[#1a1a1a] px-1">Q</kbd>
              <kbd className="bg-[#1a1a1a] px-1">E</kbd> Yaw
            </span>
            <span>
              <kbd className="bg-[#1a1a1a] px-1">⎵</kbd>
              <kbd className="bg-[#1a1a1a] px-1">⇧</kbd> Höhe
            </span>
            <span>
              <kbd className="bg-[#1a1a1a] px-1">R</kbd> Arm/Disarm
            </span>
            <span>
              <kbd className="bg-[#1a1a1a] px-1">ESC</kbd> Notaus
            </span>
          </div>
        </div>
      )}

      {/* Route Editor */}
      {selectedDroneId && (
        <div className="p-2 border-t border-[#1a1a1a]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[#808080]">ROUTE</span>
            <button
              onClick={() => setShowRouteEditor(!showRouteEditor)}
              className="px-2 py-0.5 bg-[#1a2a3a] border border-[#2a4a5a] text-[#4a9aff] hover:bg-[#2a3a4a]"
            >
              {showRouteEditor ? '▲ SCHLIESSEN' : '▼ BEARBEITEN'}
            </button>
          </div>

          {/* Current route status */}
          {selectedDrone?.route && selectedDrone.route.waypoints.length > 0 && (
            <div className="mb-2 p-1 bg-[#0a0a0a] border border-[#1a1a1a] text-[0.875em]">
              <div className="flex items-center justify-between">
                <span className="text-[#606060]">
                  {selectedDrone.route.waypoints.length} Wegpunkte
                  {selectedDrone.route.mode === 'patrol' ? ' (PATROUILLE)' : ' (EINMALIG)'}
                </span>
                <span
                  className={selectedDrone.route.isActive ? 'text-[#4aff4a]' : 'text-[#606060]'}
                >
                  {selectedDrone.route.isActive ? '● AKTIV' : '○ INAKTIV'}
                </span>
              </div>
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => onToggleRoute?.(selectedDroneId)}
                  className={`flex-1 py-0.5 border ${
                    selectedDrone.route.isActive
                      ? 'bg-[#3a1a1a] border-[#5a2a2a] text-[#ff4a4a]'
                      : 'bg-[#1a3a1a] border-[#2a5a2a] text-[#4aff4a]'
                  }`}
                >
                  {selectedDrone.route.isActive ? '⏹ STOP' : '▶ START'}
                </button>
                <button
                  onClick={() => onClearRoute?.(selectedDroneId)}
                  className="px-2 py-0.5 bg-[#2a1a1a] border border-[#4a2a2a] text-[#ff6a6a]"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {showRouteEditor && (
            <div className="space-y-2 p-2 bg-[#0e0e0e] border border-[#1a1a1a]">
              {/* Route Mode */}
              <div className="flex gap-1">
                <button
                  onClick={() => setRouteMode('once')}
                  className={`flex-1 py-0.5 border ${
                    routeMode === 'once'
                      ? 'bg-[#1a2a3a] border-[#4a9aff] text-[#4a9aff]'
                      : 'bg-[#0a0a0a] border-[#2a2a2a] text-[#606060]'
                  }`}
                >
                  EINMALIG
                </button>
                <button
                  onClick={() => setRouteMode('patrol')}
                  className={`flex-1 py-0.5 border ${
                    routeMode === 'patrol'
                      ? 'bg-[#1a2a3a] border-[#4a9aff] text-[#4a9aff]'
                      : 'bg-[#0a0a0a] border-[#2a2a2a] text-[#606060]'
                  }`}
                >
                  PATROUILLE
                </button>
              </div>

              {/* Waypoint Input */}
              <div>
                <div className="text-[#606060] mb-1">WEGPUNKT HINZUFÜGEN:</div>
                <div className="grid grid-cols-3 gap-1">
                  <div>
                    <label className="text-[#505050] text-[0.75em]">X</label>
                    <input
                      type="number"
                      min={-MAX_ROUTE_COORDINATE_MAGNITUDE_M}
                      max={MAX_ROUTE_COORDINATE_MAGNITUDE_M}
                      value={waypointInput.x}
                      onChange={(e) => setWaypointInput((prev) => ({ ...prev, x: e.target.value }))}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-[#c0c0c0] px-1 py-0.5"
                    />
                  </div>
                  <div>
                    <label className="text-[#505050] text-[0.75em]">HÖHE</label>
                    <input
                      type="number"
                      min={0}
                      max={maxRouteAltitude}
                      value={waypointInput.y}
                      onChange={(e) => setWaypointInput((prev) => ({ ...prev, y: e.target.value }))}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-[#c0c0c0] px-1 py-0.5"
                    />
                  </div>
                  <div>
                    <label className="text-[#505050] text-[0.75em]">Z</label>
                    <input
                      type="number"
                      min={-MAX_ROUTE_COORDINATE_MAGNITUDE_M}
                      max={MAX_ROUTE_COORDINATE_MAGNITUDE_M}
                      value={waypointInput.z}
                      onChange={(e) => setWaypointInput((prev) => ({ ...prev, z: e.target.value }))}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-[#c0c0c0] px-1 py-0.5"
                    />
                  </div>
                </div>
                <button
                  onClick={handleAddWaypoint}
                  disabled={!canAddWaypoint}
                  className={`w-full mt-1 py-0.5 border ${
                    canAddWaypoint
                      ? 'bg-[#1a2a1a] border-[#2a4a2a] text-[#4aff4a] hover:bg-[#2a3a2a]'
                      : 'bg-[#1a1a1a] border-[#2a2a2a] text-[#404040] cursor-not-allowed'
                  }`}
                >
                  ➕ WEGPUNKT
                </button>
                <div className="mt-1 text-[0.75em] text-[#505050]">
                  {pendingWaypoints.length} / {MAX_ROUTE_WAYPOINTS} WEGPUNKTE
                </div>
                {parsedWaypointInput === null && (
                  <div role="alert" className="mt-1 text-[0.75em] text-[#ff6a6a]">
                    X/Z MÜSSEN ±{MAX_ROUTE_COORDINATE_MAGNITUDE_M.toLocaleString()} UND HÖHE 0–
                    {maxRouteAltitude.toLocaleString()} M EINHALTEN
                  </div>
                )}
              </div>

              {/* Pending Waypoints */}
              {pendingWaypoints.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[#606060]">
                      GEPLANTE ROUTE ({pendingWaypoints.length}):
                    </span>
                    <button
                      onClick={handleClearPendingWaypoints}
                      className="text-[#ff4a4a] hover:text-[#ff6a6a] text-[0.875em]"
                    >
                      LÖSCHEN
                    </button>
                  </div>
                  <div className="max-h-20 overflow-y-auto space-y-0.5">
                    {pendingWaypoints.map((wp, i) => (
                      <div
                        key={i}
                        className="text-[0.875em] text-[#808080] bg-[#0a0a0a] px-1 py-0.5 border border-[#1a1a1a]"
                      >
                        #{i + 1}: X={wp.position.x.toFixed(1)} H={wp.altitude.toFixed(1)} Z=
                        {wp.position.z.toFixed(1)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Apply Route */}
              <button
                onClick={handleApplyRoute}
                disabled={pendingWaypoints.length === 0}
                className={`w-full py-1 font-bold border ${
                  pendingWaypoints.length > 0
                    ? 'bg-[#2a4a2a] border-[#3a6a3a] text-[#4aff4a] hover:bg-[#3a5a3a]'
                    : 'bg-[#1a1a1a] border-[#2a2a2a] text-[#404040] cursor-not-allowed'
                }`}
              >
                ✓ ROUTE ANWENDEN
              </button>
            </div>
          )}
        </div>
      )}
    </BasePanel>
  )
}

export default DroneSpawnPanel
