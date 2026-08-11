import { createContext } from 'react'

export const UI_SCALE_CONFIG = {
  MIN: 0.8,
  MAX: 2.0,
  DEFAULT: 1.0,
  STEP: 0.1,
  PRESETS: [0.8, 1.0, 1.2, 1.5] as const,
  STORAGE_KEY: 'crebain-ui-scale',
} as const

/**
 * Floating panels use fixed slots once text enlargement makes free placement
 * too dense for the supported minimum window.
 */
export const DOCKED_PANEL_LAYOUT_MIN_SCALE = 1.5
export const MAGNIFIED_UI_MIN_SCALE = 1.5
export const FREE_PANEL_LAYOUT_MIN_WIDTH = 1_200
export const FREE_PANEL_LAYOUT_MIN_HEIGHT = 1_080

export function usesDockedPanelLayout(
  scale: number,
  viewportWidth: number,
  viewportHeight: number
): boolean {
  if (![scale, viewportWidth, viewportHeight].every(Number.isFinite)) return true
  return (
    scale >= DOCKED_PANEL_LAYOUT_MIN_SCALE ||
    viewportWidth < FREE_PANEL_LAYOUT_MIN_WIDTH ||
    viewportHeight < FREE_PANEL_LAYOUT_MIN_HEIGHT
  )
}

export function usesMagnifiedUiLayout(scale: number): boolean {
  return Number.isFinite(scale) && scale >= MAGNIFIED_UI_MIN_SCALE
}

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
  isDocked: boolean
  isAtMin: boolean
  isAtMax: boolean
}

export const UIScaleContext = createContext<UIScaleContextValue | null>(null)

export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return UI_SCALE_CONFIG.DEFAULT
  return Math.min(UI_SCALE_CONFIG.MAX, Math.max(UI_SCALE_CONFIG.MIN, value))
}

type UIScaleStorage = Pick<Storage, 'getItem' | 'setItem'>
type UIScaleStorageProvider = () => UIScaleStorage
type StorageErrorHandler = (error: unknown) => void

export function readStoredScale(
  storageProvider: UIScaleStorageProvider,
  onError?: StorageErrorHandler
): number | null {
  try {
    const stored = storageProvider().getItem(UI_SCALE_CONFIG.STORAGE_KEY)
    if (stored === null || stored.trim() === '') return null

    const parsed = Number(stored)
    return Number.isFinite(parsed) ? clampScale(parsed) : null
  } catch (error) {
    onError?.(error)
    return null
  }
}

export function writeStoredScale(
  storageProvider: UIScaleStorageProvider,
  scale: number,
  onError?: StorageErrorHandler
): boolean {
  try {
    if (!Number.isFinite(scale)) {
      throw new TypeError('UI scale must be finite')
    }
    storageProvider().setItem(UI_SCALE_CONFIG.STORAGE_KEY, clampScale(scale).toString())
    return true
  } catch (error) {
    onError?.(error)
    return false
  }
}
