import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { engine } from './engine/client'
import { useEditor } from './state/store'

// Read-only debugging handle (DevTools / E2E assertions).
Object.assign(window, { __trailer: { store: useEditor, engine } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
