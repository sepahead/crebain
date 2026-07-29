import type { Position } from '../hooks/useDraggable'

export type PanelId =
  'drone' | 'droneSpawn' | 'rosConnection' | 'sensorFusion' | 'performance' | 'saveLoad'

export interface PanelPositionConfig {
  initialPosition: Position
  side: 'left' | 'right'
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
