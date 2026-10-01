import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/sheet.css'
import App from './App.tsx'
import './styles/mobile.css' // must stay last: mobile overrides win the cascade
import { LayoutDebugOverlay } from './components/dev/LayoutDebugOverlay.tsx'

// Registered in prod always; in dev only when explicitly opted in via
// VITE_ENABLE_SW=true (needed to test notifications/push locally), since a
// dev-registered SW can otherwise interfere with HMR-served assets.
if ((import.meta.env.PROD || import.meta.env.VITE_ENABLE_SW === "true") && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {import.meta.env.DEV ? <LayoutDebugOverlay /> : null}
  </StrictMode>,
)
