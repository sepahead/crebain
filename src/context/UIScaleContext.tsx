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

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES & CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** UI Scale configuration limits */
export const UI_SCALE_CONFIG = {
  MIN: 0.8,
  MAX: 2.0,
  DEFAULT: 1.0,
  STEP: 0.1,
  /** Preset scale values for quick selection */
  PRESETS: [0.8, 1.0, 1.2, 1.5] as const,
  /** Local storage key for persistence */
  STORAGE_KEY: 'crebain-ui-scale',
} as const

export type UIScalePreset = (typeof UI_SCALE_CONFIG.PRESETS)[number]

export interface UIScaleContextValue {
  /** Current UI scale factor (1.0 = 100%) */
  scale: number
  /** Set scale to a specific value (clamped to min/max) */
  setScale: (scale: number) => void
  /** Increase scale by one step */
  increaseScale: () => void
  /** Decrease scale by one step */
  decreaseScale: () => void
  /** Reset scale to default */
  resetScale: () => void
  /** Set scale to a preset value */
  setPreset: (preset: UIScalePreset) => void
  /** Scale as percentage (e.g., 100 for 1.0) */
  scalePercent: number
  /** CSS variable value for use in style objects */
  cssVar: { '--ui-scale': number }
  /** Whether scale is at minimum */
  isAtMin: boolean
  /** Whether scale is at maximum */
  isAtMax: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

const UIScaleContext = createContext<UIScaleContextValue | null>(null)

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
      const stored = localStorage.getItem(UI_SCALE_CONFIG.STORAGE_KEY)
      if (stored) {
        const parsed = parseFloat(stored)
        if (!isNaN(parsed)) {
          return clampScale(parsed)
        }
      }
    }
    return UI_SCALE_CONFIG.DEFAULT
  })

  // Persist to localStorage when scale changes
  useEffect(() => {
    if (persist && typeof window !== 'undefined') {
      localStorage.setItem(UI_SCALE_CONFIG.STORAGE_KEY, scale.toString())
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

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to access UI scale context.
 * Must be used within a UIScaleProvider.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const { scale, increaseScale, decreaseScale, cssVar } = useUIScale()
 *
 *   return (
 *     <div style={cssVar}>
 *       <button onClick={decreaseScale}>-</button>
 *       <span>{scale * 100}%</span>
 *       <button onClick={increaseScale}>+</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useUIScale(): UIScaleContextValue {
  const context = useContext(UIScaleContext)

  if (context === null) {
    throw new Error(
      'useUIScale must be used within a UIScaleProvider. ' +
        'Wrap your app with <UIScaleProvider> in App.tsx or main.tsx.'
    )
  }

  return context
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamps a scale value to the configured min/max range
 */
function clampScale(value: number): number {
  return Math.min(UI_SCALE_CONFIG.MAX, Math.max(UI_SCALE_CONFIG.MIN, value))
}

/**
 * Higher-order component for components that need UI scale
 * Useful for class components or when you want to inject scale as a prop
 */
export function withUIScale<P extends object>(
  Component: React.ComponentType<P & { uiScale: UIScaleContextValue }>
): React.FC<P> {
  return function WithUIScale(props: P) {
    const uiScale = useUIScale()
    return <Component {...props} uiScale={uiScale} />
  }
}

export default UIScaleContext
