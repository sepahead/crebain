/**
 * CREBAIN ROS Connection Panel
 * Adaptive Response & Awareness System (ARAS)
 *
 * Telemetry-only panel for managing ROS-Gazebo observation connections.
 */

import { useState } from 'react'
import { BasePanel } from './BasePanel'
import { RENDERER_ROSBRIDGE_AVAILABLE } from '#renderer-rosbridge'
import type { ConnectionState } from '../ros/ROSBridge'
import type { DroneState } from '../hooks/useGazeboDrones'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ROSConnectionPanelProps {
  connectionState: ConnectionState
  transport: 'websocket' | 'zenoh'
  onTransportChange: (transport: 'websocket' | 'zenoh') => void
  rosUrl: string
  onUrlChange: (url: string) => void
  onConnect: () => void
  onDisconnect: () => void
  error: string | null
  drones: DroneState[]
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export function ROSConnectionPanel({
  connectionState,
  transport,
  onTransportChange,
  rosUrl,
  onUrlChange,
  onConnect,
  onDisconnect,
  error,
  drones,
}: ROSConnectionPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const [showDrones, setShowDrones] = useState(true)

  const statusColor = {
    disconnected: 'bg-gray-500',
    connecting: 'bg-yellow-500 animate-pulse',
    connected: 'bg-green-500',
    reconnecting: 'bg-orange-500 animate-pulse',
  }[connectionState]

  const statusText = {
    disconnected: 'GETRENNT',
    connecting: 'VERBINDE...',
    connected: 'VERBUNDEN',
    reconnecting: 'WIEDERVERBINDEN...',
  }[connectionState]

  const friendlyDrones = drones.filter((d) => d.type === 'friendly')
  const hostileDrones = drones.filter((d) => d.type === 'hostile')

  return (
    <BasePanel
      panelId="rosConnection"
      title="ROS-GAZEBO TELEMETRIE"
      theme="green"
      isExpanded={isExpanded}
      onToggleExpand={() => setIsExpanded((prev) => !prev)}
      zLevel="highest"
      widthClass="w-80"
      headerRight={
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${statusColor}`} />
          <span className="text-green-400/60 font-mono text-xs">{statusText}</span>
        </div>
      }
      collapsedContent={
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${statusColor}`} />
          <span className="text-green-400 font-mono text-sm font-bold">ROS TELEMETRIE</span>
          <span className="text-green-400/60 font-mono text-xs">{statusText}</span>
        </div>
      }
    >
      <div className="mb-3 rounded border border-amber-500/40 bg-amber-950/20 px-2 py-1.5">
        <p className="font-mono text-[10px] font-bold text-amber-300">
          NUR TELEMETRIE · NOAUTHORITY · HOLD
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-amber-300/70">
          Keine Flug-, Missions- oder Gazebo-Befehle verfügbar.
        </p>
      </div>

      {/* Connection Section */}
      <div className="mb-4 space-y-3">
        <div>
          <label className="text-green-400/80 font-mono text-xs block mb-1">TRANSPORT</label>
          <select
            value={transport}
            onChange={(e) => onTransportChange(e.target.value as 'websocket' | 'zenoh')}
            disabled={connectionState === 'connected'}
            className="w-full bg-black/50 border border-green-500/30 rounded px-2 py-1
                     text-green-400 font-mono text-sm focus:outline-none focus:border-green-500
                     disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="zenoh">ZENOH (TAURI)</option>
            {RENDERER_ROSBRIDGE_AVAILABLE && (
              <option value="websocket">ROSBRIDGE (WEBSOCKET, DEV)</option>
            )}
          </select>
          {transport === 'zenoh' && (
            <>
              <p className="text-green-400/50 font-mono text-[10px] mt-1">
                Zenoh uses the Tauri transport backend; no URL required.
              </p>
              {!RENDERER_ROSBRIDGE_AVAILABLE && (
                <p className="text-amber-300/70 font-mono text-[10px] mt-1">
                  Custom ROS sensor topics use the development-only rosbridge profile.
                </p>
              )}
            </>
          )}
        </div>

        {RENDERER_ROSBRIDGE_AVAILABLE && transport === 'websocket' && (
          <div>
            <label className="text-green-400/80 font-mono text-xs block mb-1">ROSBRIDGE URL</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={rosUrl}
                onChange={(e) => onUrlChange(e.target.value)}
                disabled={connectionState === 'connected'}
                className="flex-1 bg-black/50 border border-green-500/30 rounded px-2 py-1
                         text-green-400 font-mono text-sm focus:outline-none focus:border-green-500
                         disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="ws://localhost:9090"
              />
              {connectionState === 'connected' ? (
                <button
                  onClick={onDisconnect}
                  className="px-3 py-1 bg-red-600/20 border border-red-500/50 rounded
                           text-red-400 font-mono text-xs hover:bg-red-600/30 transition-colors"
                >
                  TRENNEN
                </button>
              ) : (
                <button
                  onClick={onConnect}
                  disabled={connectionState === 'connecting'}
                  className="px-3 py-1 bg-green-600/20 border border-green-500/50 rounded
                           text-green-400 font-mono text-xs hover:bg-green-600/30 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  VERBINDEN
                </button>
              )}
            </div>
          </div>
        )}

        {transport === 'zenoh' && (
          <div className="flex justify-end">
            {connectionState === 'connected' ? (
              <button
                onClick={onDisconnect}
                className="px-3 py-1 bg-red-600/20 border border-red-500/50 rounded
                         text-red-400 font-mono text-xs hover:bg-red-600/30 transition-colors"
              >
                TRENNEN
              </button>
            ) : (
              <button
                onClick={onConnect}
                disabled={connectionState === 'connecting'}
                className="px-3 py-1 bg-green-600/20 border border-green-500/50 rounded
                         text-green-400 font-mono text-xs hover:bg-green-600/30 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                VERBINDEN
              </button>
            )}
          </div>
        )}

        {error && <p className="text-red-400 font-mono text-xs">{error}</p>}
      </div>

      {/* Drones Section */}
      <div className="mb-4">
        <div
          className="flex items-center justify-between cursor-pointer mb-2"
          onClick={() => setShowDrones(!showDrones)}
        >
          <span className="text-green-400 font-mono text-xs font-bold">
            DROHNEN ({drones.length})
          </span>
          <span className="text-green-400/40">{showDrones ? '▼' : '▶'}</span>
        </div>

        {showDrones && (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {/* Friendly Drones */}
            {friendlyDrones.map((drone) => (
              <div
                key={drone.id}
                className="flex items-center gap-2 p-1.5 bg-green-900/20 rounded border border-green-500/20"
              >
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-green-400 font-mono text-xs flex-1 truncate">
                  {drone.name}
                </span>
                <span className="text-green-400/60 font-mono text-xs">
                  {drone.altitude.toFixed(1)}m
                </span>
                <span className="text-green-400/60 font-mono text-xs">
                  {drone.speed.toFixed(1)}m/s
                </span>
              </div>
            ))}

            {/* Hostile Drones */}
            {hostileDrones.map((drone) => (
              <div
                key={drone.id}
                className="flex items-center gap-2 p-1.5 bg-red-900/20 rounded border border-red-500/20"
              >
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-red-400 font-mono text-xs flex-1 truncate">{drone.name}</span>
                <span className="text-red-400/60 font-mono text-xs">
                  {drone.altitude.toFixed(1)}m
                </span>
              </div>
            ))}

            {drones.length === 0 && (
              <p className="text-green-400/40 font-mono text-xs text-center py-2">
                Keine Drohnen erkannt
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="mt-3 pt-2 border-t border-green-500/20">
        <div className="flex justify-between text-green-400/40 font-mono text-xs">
          <span>Freundlich: {friendlyDrones.length}</span>
          <span>Feindlich: {hostileDrones.length}</span>
        </div>
      </div>
    </BasePanel>
  )
}

export default ROSConnectionPanel
