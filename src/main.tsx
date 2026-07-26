import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { startEngramHostBridge } from './integrations/engramHost'

const engramHostBridge = startEngramHostBridge()

if (import.meta.hot) {
  import.meta.hot.dispose(() => engramHostBridge.stop())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
