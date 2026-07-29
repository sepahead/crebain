/**
 * CREBAIN UI Scale Context
 * Adaptive Response & Awareness System (ARAS)
 *
 * Provides centralized UI scaling management across all components.
 * Uses React Context pattern for optimal state sharing without prop drilling.
 *
 * Design Principles:
 * - Single Source of Truth: One state for UI scale across entire app
 * - Separation of Concerns: Scale logic isolated from UI components
 * - Dependency Inversion: Components depend on abstraction (hook), not implementation
 * - Open/Closed: Easy to extend with new scale-related features
 */

import { useState, useCallback, useMemo, useEffect, type ReactNode } from 'react'
import {
  clampScale,
  readStoredScale,
  UIScaleContext,
  UI_SCALE_CONFIG,
  writeStoredScale,
  type UIScaleContextValue,
  type UIScalePreset,
} from './uiScale'
import { logger } from '../lib/logger'

const log = logger.scope('UI Scale')
const browserStorage = () => window.localStorage
const reportStorageReadError = (error: unknown) => {
  log.warn('Cannot read the persisted UI scale', { error })
}
const reportStorageWriteError = (error: unknown) => {
  log.warn('Cannot persist the UI scale', { error })
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

interface UIScaleProviderProps {
  children: ReactNode
  /** Initial scale value (defaults to stored value or 1.0) */
  initialScale?: number
  /** Whether to persist scale to localStorage */
  persist?: boolean
}

export function UIScaleProvider({ children, initialScale, persist = true }: UIScaleProviderProps) {
  // Initialize from localStorage or provided value
  const [scale, setScaleInternal] = useState<number>(() => {
    if (initialScale !== undefined) {
      return clampScale(initialScale)
    }
    if (persist && typeof window !== 'undefined') {
      const storedScale = readStoredScale(browserStorage, reportStorageReadError)
      if (storedScale !== null) return storedScale
    }
    return UI_SCALE_CONFIG.DEFAULT
  })

  // Persist to localStorage when scale changes
  useEffect(() => {
    if (persist && typeof window !== 'undefined') {
      writeStoredScale(browserStorage, scale, reportStorageWriteError)
    }
  }, [scale, persist])

  // Apply CSS variable to document root for global access
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', scale.toString())
    return () => {
      document.documentElement.style.removeProperty('--ui-scale')
    }
  }, [scale])

  const setScale = useCallback((newScale: number) => {
    setScaleInternal(clampScale(newScale))
  }, [])

  const increaseScale = useCallback(() => {
    setScaleInternal((prev) => clampScale(prev + UI_SCALE_CONFIG.STEP))
  }, [])

  const decreaseScale = useCallback(() => {
    setScaleInternal((prev) => clampScale(prev - UI_SCALE_CONFIG.STEP))
  }, [])

  const resetScale = useCallback(() => {
    setScaleInternal(UI_SCALE_CONFIG.DEFAULT)
  }, [])

  const setPreset = useCallback((preset: UIScalePreset) => {
    setScaleInternal(preset)
  }, [])

  const value = useMemo<UIScaleContextValue>(
    () => ({
      scale,
      setScale,
      increaseScale,
      decreaseScale,
      resetScale,
      setPreset,
      scalePercent: Math.round(scale * 100),
      cssVar: { '--ui-scale': scale },
      isAtMin: scale <= UI_SCALE_CONFIG.MIN,
      isAtMax: scale >= UI_SCALE_CONFIG.MAX,
    }),
    [scale, setScale, increaseScale, decreaseScale, resetScale, setPreset]
  )

  return <UIScaleContext.Provider value={value}>{children}</UIScaleContext.Provider>
}
