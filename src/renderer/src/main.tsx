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
import { restoreBackupPreferences } from './backup-preferences'

async function start() {
  let startupNotice = ''
  try {
    const result = await window.desktop.getRestoredPreferences()
    if (!result.ok) startupNotice = result.error.message
    else if (result.value && !result.value.acknowledged) {
      restoreBackupPreferences(localStorage, result.value.settings)
      const acknowledged = await window.desktop.acknowledgeRestoredPreferences()
      startupNotice = acknowledged.ok
        ? '书库和阅读设置已恢复，可在备份与存储中查看详情。'
        : acknowledged.error.message
    }
  } catch {
    startupNotice = '阅读设置恢复未完成，请在备份与存储中检查后重新启动。'
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ReaderDockProvider>
        <App startupNotice={startupNotice} />
      </ReaderDockProvider>
    </StrictMode>,
  )
}
void start()
