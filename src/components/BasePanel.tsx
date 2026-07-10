/**
 * CREBAIN Base Panel Component
 * Adaptive Response & Awareness System (ARAS)
 *
 * Reusable draggable panel wrapper that provides consistent styling and behavior.
 * All tactical panels should use this component for uniform appearance and positioning.
 */

import { type ReactNode, useState, useCallback } from 'react'
import { useDraggablePanel } from '../hooks/useDraggablePanel'
import type { Position } from '../hooks/useDraggable'

// ─────────────────────────────────────────────────────────────────────────────
// PANEL POSITION REGISTRY
// Centralized default positions to prevent panel overlap
// ─────────────────────────────────────────────────────────────────────────────

export type PanelId =
  'drone' | 'droneSpawn' | 'rosConnection' | 'sensorFusion' | 'performance' | 'saveLoad'

export interface PanelPositionConfig {
  initialPosition: Position
  side: 'left' | 'right'
  snapDistance?: number
  edgePadding?: number
}

/**
 * Default panel positions organized to prevent overlapping.
 *
 * Layout:
 *
 * LEFT SIDE (x offset from left):
 *   - DronePanel:         y=80  (top)
 *   - DroneSpawnPanel:    y=320 (middle)
 *   - ROSConnectionPanel: y=560 (bottom)
 *
 * RIGHT SIDE (x is transform offset, 0 = snapped to right edge):
 *   - SensorFusionPanel:  y=80  (top)
 *   - PerformancePanel:   y=320 (middle)
 *   - SaveLoadPanel:      y=520 (bottom)
 */
export const PANEL_POSITIONS: Record<PanelId, PanelPositionConfig> = {
  // Left side panels - stacked vertically with spacing
  drone: {
    initialPosition: { x: 12, y: 80 },
    side: 'left',
    snapDistance: 20,
    edgePadding: 12,
  },
  droneSpawn: {
    initialPosition: { x: 12, y: 340 },
    side: 'left',
    snapDistance: 20,
    edgePadding: 12,
  },
  rosConnection: {
    initialPosition: { x: 12, y: 580 },
    side: 'left',
    snapDistance: 20,
    edgePadding: 12,
  },

  // Right side panels - stacked vertically with spacing
  sensorFusion: {
    initialPosition: { x: 0, y: 80 },
    side: 'right',
    snapDistance: 20,
    edgePadding: 12,
  },
  performance: {
    initialPosition: { x: 0, y: 340 },
    side: 'right',
    snapDistance: 20,
    edgePadding: 12,
  },
  saveLoad: {
    initialPosition: { x: 0, y: 540 },
    side: 'right',
    snapDistance: 20,
    edgePadding: 12,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface BasePanelProps {
  /** Unique panel identifier for position registry lookup */
  panelId: PanelId
  /** Panel title displayed in header */
  title: string
  /** Optional icon before title */
  icon?: ReactNode
  /** Whether panel is expanded or collapsed */
  isExpanded?: boolean
  /** Callback when expand state changes */
  onToggleExpand?: () => void
  /** Optional right-side header content (e.g., status indicators) */
  headerRight?: ReactNode
  /** Main panel content */
  children: ReactNode
  /** Content to show when collapsed (optional - defaults to title + icon) */
  collapsedContent?: ReactNode
  /** Panel width class (default: 'w-64') */
  widthClass?: string
  /** Custom position override (optional) */
  customPosition?: PanelPositionConfig
  /** Additional CSS classes for the panel container */
  className?: string
  /** Z-index level: 'default' (z-20) | 'high' (z-40) | 'highest' (z-50) */
  zLevel?: 'default' | 'high' | 'highest'
  /** Panel color theme */
  theme?: 'default' | 'green' | 'blue' | 'orange'
}

// ─────────────────────────────────────────────────────────────────────────────
// THEME STYLES
// ─────────────────────────────────────────────────────────────────────────────

const THEME_STYLES = {
  default: {
    border: 'border-[#2a2a2a]',
    headerBg: 'bg-[#0e0e0e]',
    headerText: 'text-[#707070]',
    headerBorder: 'border-[#1a1a1a]',
  },
  green: {
    border: 'border-green-500/50',
    headerBg: 'bg-black/80',
    headerText: 'text-green-400',
    headerBorder: 'border-green-500/30',
  },
  blue: {
    border: 'border-[#4a9aff]/50',
    headerBg: 'bg-[#0e0e0e]',
    headerText: 'text-[#4a9aff]',
    headerBorder: 'border-[#1a1a1a]',
  },
  orange: {
    border: 'border-[#ffaa4a]/50',
    headerBg: 'bg-[#0e0e0e]',
    headerText: 'text-[#ffaa4a]',
    headerBorder: 'border-[#1a1a1a]',
  },
} as const

const Z_LEVELS = {
  default: 'z-20',
  high: 'z-40',
  highest: 'z-50',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export function BasePanel({
  panelId,
  title,
  icon,
  isExpanded: controlledExpanded,
  onToggleExpand,
  headerRight,
  children,
  collapsedContent,
  widthClass = 'w-64',
  customPosition,
  className = '',
  zLevel = 'default',
  theme = 'default',
}: BasePanelProps) {
  // Use internal state if not controlled
  const [internalExpanded, setInternalExpanded] = useState(true)
  const isExpanded = controlledExpanded ?? internalExpanded

  const handleToggle = useCallback(() => {
    if (onToggleExpand) {
      onToggleExpand()
    } else {
      setInternalExpanded((prev) => !prev)
    }
  }, [onToggleExpand])

  // Get position config from registry or custom override
  const positionConfig = customPosition ?? PANEL_POSITIONS[panelId]

  // Use combined draggable panel hook
  const { panelStyle, handleMouseDown, handleHeaderClick, elementRef } = useDraggablePanel({
    initialPosition: positionConfig.initialPosition,
    snapDistance: positionConfig.snapDistance ?? 20,
    edgePadding: positionConfig.edgePadding ?? 12,
    side: positionConfig.side,
    onHeaderClick: handleToggle,
  })

  const themeStyles = THEME_STYLES[theme]
  const zClass = Z_LEVELS[zLevel]

  // For right-side panels, we need to add 'right' positioning via className
  const sideClass = positionConfig.side === 'right' ? 'right-3' : ''

  // Collapsed view
  if (!isExpanded) {
    return (
      <div
        ref={elementRef}
        className={`fixed ${zClass} ${sideClass}`}
        style={panelStyle}
        onMouseDown={handleMouseDown}
      >
        <div
          data-drag-handle
          className={`p-2 border ${themeStyles.border} bg-[#0a0a0a]/90 ${themeStyles.headerText} hover:border-[#3a3a3a] cursor-grab select-none`}
          onClick={handleHeaderClick}
          title={`${title} öffnen`}
        >
          {collapsedContent ?? (
            <div className="flex items-center gap-2">
              {icon && <span>{icon}</span>}
              <span className="font-bold tracking-wider">{title}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Expanded view
  return (
    <div
      ref={elementRef}
      className={`fixed ${zClass} ${sideClass} ${widthClass} border ${themeStyles.border} bg-[#0a0a0a]/95 backdrop-blur-sm font-mono ${className}`}
      style={panelStyle}
      onMouseDown={handleMouseDown}
    >
      {/* Header - Drag Handle */}
      <div
        data-drag-handle
        className={`flex items-center justify-between p-2 border-b ${themeStyles.headerBorder} ${themeStyles.headerBg} cursor-grab select-none`}
        onClick={handleHeaderClick}
      >
        <div className={`flex items-center gap-2 ${themeStyles.headerText} font-bold`}>
          {icon && <span>{icon}</span>}
          <span className="tracking-wider">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {headerRight}
          <button className="text-[#505050] hover:text-[#707070]">{isExpanded ? '▼' : '▶'}</button>
        </div>
      </div>

      {/* Content */}
      {children}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER HOOK FOR PANELS THAT NEED MORE CONTROL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to get panel position config for a given panel ID.
 * Use this when you need the raw position config without the BasePanel wrapper.
 */
export function usePanelPosition(panelId: PanelId): PanelPositionConfig {
  return PANEL_POSITIONS[panelId]
}

export default BasePanel
