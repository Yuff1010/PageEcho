import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const env = {
  ...process.env,
  RALB_USER_DATA: mkdtempSync(join(tmpdir(), '听读 dev ')),
  REMOTE_DEBUGGING_PORT: '0',
}
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
const child = spawn(
  process.execPath,
  [resolve('node_modules/electron-vite/bin/electron-vite.js'), 'dev'],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
)

const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit))
const endpoint = new Promise<string>((resolveEndpoint, reject) => {
  const timer = setTimeout(() => reject(new Error('Development startup timed out')), 30_000)
  let output = ''
  function read(data: Buffer) {
    const text = data.toString()
    process.stdout.write(text)
    output += text
    const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (match?.[1]) {
      clearTimeout(timer)
      resolveEndpoint(match[1])
    }
  }
  child.stdout.on('data', read)
  child.stderr.on('data', read)
  child.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
  child.once('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`Development process exited: ${code}`))
  })
})

try {
  const browser = await chromium.connectOverCDP(await endpoint)
  try {
    const context = browser.contexts()[0]!
    const page = context.pages()[0] ?? (await context.waitForEvent('page'))
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    expect(page.url()).toMatch(/^http:\/\/localhost:\d+\/$/)
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok).toBe(true)
    expect(errors).toEqual([])
    await page.evaluate(() => window.desktop.quitApp())
    let closeTimer: NodeJS.Timeout | undefined
    try {
      expect(
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error('Development shutdown timed out')),
              10_000,
            )
          }),
        ]),
      ).toBe(0)
    } finally {
      clearTimeout(closeTimer)
    }
    console.log('Development window, IPC, SQLite and graceful shutdown passed.')
  } finally {
    await browser.close()
  }
} finally {
  if (child.exitCode === null && child.pid) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    else child.kill()
  }
}
