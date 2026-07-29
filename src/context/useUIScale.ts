import { useContext } from 'react'
import { UIScaleContext, type UIScaleContextValue } from './uiScale'

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
