/**
 * Renderer entry point.
 *
 * The window is deliberately powerless: no Node, no Electron, no network of its
 * own. Everything it can do arrives on `window.api`, and if that is missing
 * there is no point rendering the app — so this says so plainly rather than
 * failing somewhere deep inside a view.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { ErrorBoundary } from './components/Layout'
import './styles.css'

const container = document.getElementById('root')

if (container === null) {
  // Nothing to render into. Write the message straight into the document, since
  // React has nowhere to go.
  const fallback = document.createElement('p')
  fallback.style.cssText = 'margin:3rem;font:16px system-ui,sans-serif'
  fallback.textContent =
    'BIC Archiver could not start because the window did not load properly. Please reinstall the app.'
  document.body.appendChild(fallback)
} else if (typeof window.api !== 'object' || window.api === null) {
  const root = createRoot(container)
  root.render(
    <div className="main-scroll">
      <div className="welcome">
        <h1 className="welcome-title">BIC Archiver could not start</h1>
        <p className="welcome-lead">
          The part of the app that does the archiving did not load, so nothing on screen would work.
          Nothing you have archived before is affected — it is stored in your archive folder.
          Reinstalling the app should fix this.
        </p>
      </div>
    </div>
  )
} else {
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}
