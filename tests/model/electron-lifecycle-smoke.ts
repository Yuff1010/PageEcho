// Actual source-app recovery and deliberately blocked test-process shutdown.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeOwnedElectron } from './electron-lifecycle'

if (process.platform !== 'win32') throw new Error('This ownership/launcher check targets Windows')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--failed-report')
  throw new Error('Usage: npm run test:audiobook:lifecycle -- --failed-report <report.json>')
const failed = JSON.parse(await readFile(resolve(args[1]!), 'utf8')) as {
  status: string
  userData: string
}
if (failed.status !== 'failed')
  throw new Error('Recovery input must preserve a terminal failed test')
const directory = resolve(
  'cache/asr-evaluation/electron-lifecycle',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
const report: Record<string, unknown> = {
  status: 'running',
  sourceReport: resolve(args[1]!),
  checks: [],
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      !['electron_run_as_node', 'ralb_executable'].includes(key.toLowerCase()),
  ),
) as Record<string, string>
const dbFile = join(failed.userData, 'data', 'library.sqlite3')
for (const suffix of ['', '-wal', '-shm']) {
  try {
    await stat(dbFile + suffix)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && suffix) continue
    throw error
  }
  await copyFile(dbFile + suffix, join(directory, 'database-before.sqlite3' + suffix))
}
const db = new DatabaseSync(dbFile, { readOnly: true })
const saved = db
  .prepare(
    'SELECT id,position_ms AS positionMs FROM episodes WHERE id=(SELECT current_episode_id FROM books LIMIT 1)',
  )
  .get() as { id: string; positionMs: number }
db.close()
expect(saved.positionMs).toBeGreaterThan(0)
report.savedBeforeRecovery = saved
let app: ElectronApplication | undefined
const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  windowsHide: true,
  stdio: 'ignore',
})
try {
  app = await electron.launch({
    args: [resolve('.')],
    env: { ...env, RALB_USER_DATA: failed.userData },
  })
  report.recoveryMainPid = await app.evaluate(() => process.pid)
  const page = await app.firstWindow()
  await expect
    .poll(() =>
      page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000),
    )
    .toBeCloseTo(saved.positionMs, -2)
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
  const state = await page.evaluate(() => window.desktop.getState())
  expect(state.ok && state.value.currentEpisodeId).toBe(saved.id)
  await page.screenshot({ path: join(directory, 'recovered-paused.png'), fullPage: true })
  report.recoveredPaused = true
  report.normalClose = await closeOwnedElectron(app)
  expect((report.normalClose as { kind: string }).kind).toBe('graceful')
  await expect
    .poll(() => {
      try {
        process.kill(report.recoveryMainPid as number, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    })
    .toBe(false)
  app = undefined
  const isolated = await mkdtemp(join(tmpdir(), '听读关闭故障验收 '))
  app = await electron.launch({ args: [resolve('.')], env: { ...env, RALB_USER_DATA: isolated } })
  await app.firstWindow()
  report.blockedMainPid = await app.evaluate(() => process.pid)
  await app.evaluate(({ app }) => {
    app.on('before-quit', (event) => event.preventDefault())
  })
  report.blockedClose = await closeOwnedElectron(app, 1000)
  expect((report.blockedClose as { kind: string }).kind).toBe('forced')
  await expect
    .poll(() => {
      try {
        process.kill(report.blockedMainPid as number, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    })
    .toBe(false)
  report.bothElectronMainProcessesExited = true
  app = undefined
  expect(control.exitCode).toBe(null)
  expect(control.pid).toBeDefined()
  process.kill(control.pid!, 0)
  report.unrelatedSiblingStillAlive = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.exitCode = 1
} finally {
  if (app)
    report.finalCleanup = await closeOwnedElectron(app).catch((error: unknown) => ({
      error: String(error),
    }))
  control.kill()
  report.finishedAt = new Date().toISOString()
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
