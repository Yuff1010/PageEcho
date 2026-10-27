import './design-tokens.css'
import './styles.css'
import './shell.css'
import './appearance.css'
import './reader-page.css'
import './motion.css'
import './select.css'
import './shell-navigation.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ReaderDockProvider } from './ReaderDock'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReaderDockProvider>
      <App />
    </ReaderDockProvider>
  </StrictMode>,
)
