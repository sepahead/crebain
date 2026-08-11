import type { Position } from '../hooks/useDraggable'

export type PanelId =
  'drone' | 'droneSpawn' | 'rosConnection' | 'sensorFusion' | 'performance' | 'saveLoad'

export interface PanelPositionConfig {
  initialPosition: Position
  side: 'left' | 'right'
  /** Stable vertical slot used by the non-overlapping magnified layout. */
  magnifiedSlot: 0 | 1 | 2
  snapDistance?: number
  edgePadding?: number
}

/**
 * Default positions keep the left and right panel stacks from overlapping.
 * A right-side x value of zero snaps the panel to the configured edge padding.
 */
export const PANEL_POSITIONS: Record<PanelId, PanelPositionConfig> = {
  drone: {
    initialPosition: { x: 12, y: 80 },
    side: 'left',
    magnifiedSlot: 0,
    snapDistance: 20,
    edgePadding: 12,
  },
  droneSpawn: {
    initialPosition: { x: 12, y: 340 },
    side: 'left',
    magnifiedSlot: 1,
    snapDistance: 20,
    edgePadding: 12,
  },
  rosConnection: {
    initialPosition: { x: 12, y: 580 },
    side: 'left',
    magnifiedSlot: 2,
    snapDistance: 20,
    edgePadding: 12,
  },
  sensorFusion: {
    initialPosition: { x: 0, y: 80 },
    side: 'right',
    magnifiedSlot: 0,
    snapDistance: 20,
    edgePadding: 12,
  },
  performance: {
    initialPosition: { x: 0, y: 400 },
    side: 'right',
    magnifiedSlot: 1,
    snapDistance: 20,
    edgePadding: 12,
  },
  saveLoad: {
    initialPosition: { x: 0, y: 720 },
    side: 'right',
    magnifiedSlot: 2,
    snapDistance: 20,
    edgePadding: 12,
  },
}
