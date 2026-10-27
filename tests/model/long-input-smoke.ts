import { setVolume } from '../helpers/ui'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installLongInputIsolation, setLongInputLocked } from './long-input-isolation'
import { closeOwnedElectron } from './electron-lifecycle'

const directory = resolve(
  'cache/asr-evaluation/long-input-isolation',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), '听读长测输入隔离 '))
const env = { ...process.env, RALB_USER_DATA: userData }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
const report: Record<string, unknown> = {
  status: 'running',
  userData,
  scope:
    'Actual stock Electron 0.8.4 app: locked UI and invoked registered media-action callbacks; unlock restores ordinary UI pause. No physical hardware key delivery or whole-source duration claim.',
}
let app: ElectronApplication | undefined
try {
  app = await electron.launch({ args: [resolve('.')], env })
  const page = await app.firstWindow()
  await setVolume(page, '0')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, resolve('tests/fixtures/第32集-伴读样本.wav'))
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  const clock = () =>
    page.locator('audio').evaluate((a: HTMLAudioElement) => ({
      position: a.currentTime,
      paused: a.paused,
      volume: a.volume,
      rate: a.playbackRate,
    }))
  await expect.poll(async () => (await clock()).position).toBeGreaterThan(0.1)
  await page.evaluate('globalThis.__name ??= (fn => fn)')
  await page.evaluate(() => {
    Reflect.set(window, 'RALB_LONG_EVENTS', [])
    const captured = new Map<MediaSessionAction, MediaSessionActionHandler>()
    Reflect.set(window, 'RALB_SMOKE_MEDIA_ACTIONS', captured)
    const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession)
    navigator.mediaSession.setActionHandler = (action, handler) => {
      if (handler) captured.set(action, handler)
      else captured.delete(action)
      original(action, handler)
    }
  })
  report.installed = await installLongInputIsolation(page, '输入隔离检查')
  await page.getByRole('button', { name: '调整音量', exact: true }).click()
  await setLongInputLocked(page, true)
  const before = await clock()
  await page.getByRole('slider', { name: '音量', exact: true }).fill('0.8')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('2')
  await page.evaluate(() => {
    const actions = Reflect.get(window, 'RALB_SMOKE_MEDIA_ACTIONS') as Map<
      MediaSessionAction,
      MediaSessionActionHandler
    >
    actions.get('pause')!({ action: 'pause' })
    actions.get('seekforward')!({ action: 'seekforward', seekOffset: 15 })
  })
  await expect.poll(async () => (await clock()).position).toBeGreaterThan(before.position + 0.2)
  const locked = await clock()
  expect(locked.paused).toBe(false)
  expect(locked.volume).toBe(0)
  expect(locked.rate).toBe(1)
  report.events = await page.evaluate(() => Reflect.get(window, 'RALB_LONG_EVENTS'))
  expect(
    (report.events as { type: string }[]).some((e) => e.type === 'external-input-ignored'),
  ).toBe(true)
  expect(
    (report.events as { type: string }[]).filter((e) => e.type === 'external-media-action-ignored'),
  ).toHaveLength(2)
  await setLongInputLocked(page, false)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await expect.poll(async () => (await clock()).paused).toBe(true)
  expect(
    await page.evaluate(
      () =>
        (
          Reflect.get(window, 'RALB_SMOKE_MEDIA_ACTIONS') as Map<
            MediaSessionAction,
            MediaSessionActionHandler
          >
        ).size,
    ),
  ).toBe(0)
  report.before = before
  report.locked = locked
  report.unlocked = await clock()
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (app) {
    const cleanup = await closeOwnedElectron(app)
    report.cleanup = cleanup
    if (cleanup.kind !== 'graceful') {
      report.status = 'failed'
      process.exitCode = 1
    }
  }
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
