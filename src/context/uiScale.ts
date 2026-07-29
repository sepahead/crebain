import { createContext } from 'react'

export const UI_SCALE_CONFIG = {
  MIN: 0.8,
  MAX: 2.0,
  DEFAULT: 1.0,
  STEP: 0.1,
  PRESETS: [0.8, 1.0, 1.2, 1.5] as const,
  STORAGE_KEY: 'crebain-ui-scale',
} as const

export type UIScalePreset = (typeof UI_SCALE_CONFIG.PRESETS)[number]

export interface UIScaleContextValue {
  scale: number
  setScale: (scale: number) => void
  increaseScale: () => void
  decreaseScale: () => void
  resetScale: () => void
  setPreset: (preset: UIScalePreset) => void
  scalePercent: number
  cssVar: { '--ui-scale': number }
  isAtMin: boolean
  isAtMax: boolean
}

export const UIScaleContext = createContext<UIScaleContextValue | null>(null)

export function clampScale(value: number): number {
  return Math.min(UI_SCALE_CONFIG.MAX, Math.max(UI_SCALE_CONFIG.MIN, value))
}
