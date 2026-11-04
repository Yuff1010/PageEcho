import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { CHANNELS } from '../../src/shared/contracts'
import { colorContrast } from '../../src/renderer/src/reader-settings'
import type { ComponentSetupState } from '../../src/shared/component'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { openCompanionTools } from '../helpers/ui'
import {
  transcriptionProgressFixture,
  transcriptionProgressFixtureAvailable,
  transcriptionProgressFixtureRequirement,
} from '../helpers/transcription-progress-fixture'

const recorded = (page: Page) => page.locator('audio[data-player="persistent"]')
const tools = (page: Page) => page.getByRole('dialog', { name: '伴读工具', exact: true })

async function observeSessions(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }, channel) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
      string,
      (...args: unknown[]) => unknown
    >
    const original = handlers.get(channel)!
    const sessions: string[] = []
    Reflect.set(globalThis, 'compactToolsSavedSessions', sessions)
    handlers.set(channel, (...args) => {
      sessions.push((args[1] as { sessionId: string }).sessionId)
      return original(...args)
    })
  }, CHANNELS.saveProgress)
}

async function rememberAudio(page: Page) {
  await expect
    .poll(() => recorded(page).evaluate((node: HTMLAudioElement) => node.paused))
    .toBe(false)
  return recorded(page).evaluate((node: HTMLAudioElement) => {
    Reflect.set(window, 'compactToolsAudio', { node, source: node.src })
    return node.currentTime
  })
}

async function audioContinues(page: Page, after: number) {
  expect(
    await recorded(page).evaluate((node: HTMLAudioElement) => {
      const original = Reflect.get(window, 'compactToolsAudio') as {
        node: HTMLAudioElement
        source: string
      }
      return node === original.node && node.src === original.source && !node.paused
    }),
  ).toBe(true)
  await expect
    .poll(() => recorded(page).evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBeGreaterThan(after + 0.1)
}

async function oneSavedSession(app: ElectronApplication) {
  await expect
    .poll(() =>
      app.evaluate(() => (Reflect.get(globalThis, 'compactToolsSavedSessions') as string[]).length),
    )
    .toBeGreaterThan(0)
  const sessions = await app.evaluate(
    () => Reflect.get(globalThis, 'compactToolsSavedSessions') as string[],
  )
  expect(sessions.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  expect(new Set(sessions).size).toBe(1)
}

async function formalFixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 简洁字幕工具 '))
  const file = join(root, '简洁字幕.wav')
  const wav = Buffer.alloc(44 + 90 * 16000)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(wav.length - 44, 40)
  writeFileSync(file, wav)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(file, 'file'))
  const book = store.listBooks()[0]!
  const episode = book.episodes[0]!
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 90000 }],
    segments: Array.from({ length: 75 }, (_, index) => ({
      id: `compact-sentence-${index}`,
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      text: `第${index}段，少年沿着山路前进，山风轻轻吹过树梢。`,
    })),
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 90000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const componentDirectory =
    'D:\\合成组件资料\\完整可信组件与历史版本\\PageEcho-ASR-0.8.0-sec.1-win-x64'
  const component: ComponentSetupState = {
    configured: true,
    currentDirectory: componentDirectory,
    candidates: Array.from({ length: 6 }, (_, index) => ({
      id: randomUUID(),
      label: `合成字幕组件-${index + 1}`,
      directory: `${componentDirectory}\\候选组件-${index + 1}`,
      configPath: `${componentDirectory}\\候选组件-${index + 1}\\component.json`,
      available: true,
      problem: null,
    })),
    check: {
      checkedAt: new Date().toISOString(),
      ready: true,
      pythonVersion: '3.12',
      cudaName: null,
      freeBytes: null,
      issues: [],
      level: 'imports-and-files',
      capabilities: [
        { engine: 'paraformer', device: 'cpu', available: true, message: '合成可用诊断' },
        { engine: 'paraformer', device: 'cuda', available: false, message: '合成设备不可用' },
        { engine: 'whisperx', device: 'cpu', available: true, message: '合成可用诊断' },
      ],
    },
  }
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    // Only capability/installation presentation is synthetic. Audio, transcript,
    // settings requests, native controls and progress/session saves stay real.
    await app.evaluate(
      ({ ipcMain }, { channels, component }) => {
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => unknown
        >
        handlers.set(channels.detectTranscriptionComponents, () => ({ ok: true, value: component }))
        Reflect.set(globalThis, 'compactToolsInstallationReads', 0)
        handlers.set(channels.componentInstallations, () => {
          Reflect.set(
            globalThis,
            'compactToolsInstallationReads',
            Number(Reflect.get(globalThis, 'compactToolsInstallationReads')) + 1,
          )
          return {
            ok: true,
            value: {
              onlineSourceConfigured: false,
              activity: null,
              installations: [],
              activating: null,
            },
          }
        })
      },
      { channels: CHANNELS, component },
    )
    await observeSessions(app)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await expect(page.locator('.transcript-sentence-text').first()).toBeVisible()
    return {
      app,
      page,
      componentDirectory,
      target: { episodeId: episode.id, audioHash: episode.contentHash },
    }
  } catch (error) {
    await closeOwnedElectron(app)
    throw error
  }
}

test('subtitle tools use the reading-settings scale, optional component details and one scroll area in both themes and widths', async ({}, info) => {
  test.setTimeout(120000)
  const { app, page, componentDirectory, target } = await formalFixture()
  try {
    const started = await rememberAudio(page)
    const initial = await page.evaluate((target) => window.desktop.getTranscript(target), target)
    for (const width of [1144, 720]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(width, width === 720 ? 600 : 761),
        width,
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((theme) => {
          localStorage.setItem('ralb:app:theme:v1', theme)
          dispatchEvent(new Event('ralb:app-theme'))
        }, theme)
        await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
        await page.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
        const preferences = page.getByRole('dialog', { name: '伴读阅读设置', exact: true })
        await preferences.getByRole('tab', { name: '外观', exact: true }).click()
        await preferences
          .getByRole('button', {
            name: theme === 'dark' ? '主题：夜间' : '主题：纸白',
            exact: true,
          })
          .click()
        const reference = await preferences.evaluate((node) => ({
          width: node.getBoundingClientRect().width,
          titleSize: getComputedStyle(node.querySelector('h2')!).fontSize,
        }))
        await preferences.getByRole('button', { name: '关闭伴读面板', exact: true }).click()
        const paper = await page.locator('.transcript-viewport').evaluate((node) => {
          const box = node.getBoundingClientRect()
          return { left: box.left, top: box.top, width: box.width, height: box.height }
        })
        const installationReads = await app.evaluate(() =>
          Number(Reflect.get(globalThis, 'compactToolsInstallationReads')),
        )
        await openCompanionTools(page)
        const panel = tools(page)
        await expect(panel).toBeVisible()
        await expect(panel.getByRole('heading', { name: '当前文稿', exact: true })).toBeInViewport({
          ratio: 1,
        })
        await expect(panel.getByRole('combobox', { name: '字幕引擎', exact: true })).toBeHidden()
        await expect(panel.locator('.component-setup-management')).toHaveCount(0)
        expect(await panel.innerText()).not.toContain(componentDirectory)
        expect(await panel.innerText()).not.toContain('合成字幕组件-1')
        const geometry = await panel.evaluate((node) => ({
          width: node.getBoundingClientRect().width,
          titleSize: getComputedStyle(node.querySelector('h2')!).fontSize,
          overflow: node.scrollWidth > node.clientWidth,
        }))
        expect(geometry.width).toBeCloseTo(reference.width, 0)
        expect(geometry.titleSize).toBe(reference.titleSize)
        expect(geometry.overflow).toBe(false)
        expect(
          await page.locator('.transcript-viewport').evaluate((node) => {
            const box = node.getBoundingClientRect()
            return { left: box.left, top: box.top, width: box.width, height: box.height }
          }),
        ).toEqual(paper)
        for (const action of await panel
          .locator(
            '.reader-primary-actions .reader-action, .subtitle-document-action-row > .reader-action',
          )
          .all()) {
          expect((await action.textContent())?.trim()).toBe('')
          expect(await action.getAttribute('aria-label')).toBeTruthy()
          expect(await action.getAttribute('title')).toBeNull()
        }
        const importAction = panel.getByRole('button', { name: '导入 SRT/WebVTT', exact: true })
        await importAction.hover()
        await expect(
          page.locator('.action-tooltip').filter({ hasText: /^导入 SRT\/WebVTT$/ }),
        ).toBeVisible()
        await importAction.focus()
        await expect(importAction).toHaveAttribute('aria-describedby', /.+/)
        await page.keyboard.press('Escape')
        await expect(panel).toBeVisible()
        await page.screenshot({
          path: info.outputPath(`subtitle-tools-${width}-${theme}.png`),
          animations: 'disabled',
        })
        const exportMenu = panel.locator('.subtitle-export-menu')
        const exportAction = exportMenu.locator(':scope > summary')
        await exportAction.focus()
        await exportAction.press('Enter')
        await expect(exportAction).toHaveAttribute('aria-expanded', 'true')
        await expect(
          exportMenu.getByRole('combobox', { name: '文稿字幕格式', exact: true }),
        ).toBeVisible()
        await exportAction.hover()
        await expect(page.locator('.action-tooltip').filter({ hasText: /^字幕导出$/ })).toHaveCount(
          0,
        )
        await exportAction.press('Escape')
        await expect(exportMenu).not.toHaveAttribute('open', '')
        await expect(exportAction).toBeFocused()
        await expect(panel).toBeVisible()
        await panel.locator('.transcription-controls > details > summary').click()
        await panel.getByRole('button', { name: '调整字幕方案', exact: true }).click()
        const component = panel.getByRole('region', { name: '本地字幕组件', exact: true })
        await expect(component.locator('.component-setup-management')).toHaveCount(0)
        expect(
          await app.evaluate(() =>
            Number(Reflect.get(globalThis, 'compactToolsInstallationReads')),
          ),
        ).toBe(installationReads)
        await component.getByRole('button', { name: '字幕组件详情说明', exact: true }).focus()
        await expect(
          page.getByRole('tooltip').filter({ hasText: componentDirectory }),
        ).toBeVisible()
        await page.keyboard.press('Escape')
        await component.getByRole('button', { name: '管理字幕组件', exact: true }).click()
        await expect
          .poll(() =>
            app.evaluate(() => Number(Reflect.get(globalThis, 'compactToolsInstallationReads'))),
          )
          .toBeGreaterThan(installationReads)
        await expect(component.locator('.component-candidates > li')).toHaveCount(6)
        await component.locator('.component-installation > summary').click()
        await expect(
          component.getByRole('combobox', { name: '安装目标引擎', exact: true }),
        ).toBeVisible()
        const body = panel.locator('.subtitle-tools-content')
        await expect
          .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight))
          .toBeGreaterThan(10)
        const scrollOwners = await panel.evaluate((node) =>
          [node, ...node.querySelectorAll<HTMLElement>('*')]
            .filter(
              (element) =>
                element.getClientRects().length &&
                /auto|scroll/.test(getComputedStyle(element).overflowY) &&
                element.scrollHeight > element.clientHeight + 1,
            )
            .map((element) => element.className),
        )
        expect(scrollOwners).toEqual(['subtitle-tools-content'])
        expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
        await body.evaluate((node) => {
          node.scrollTop = node.scrollHeight
        })
        const close = panel.getByRole('button', { name: '关闭伴读面板', exact: true })
        await expect(close).toBeInViewport({ ratio: 1 })
        expect(
          await close.evaluate((node) => {
            const box = node.getBoundingClientRect()
            return node.contains(
              document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
            )
          }),
        ).toBe(true)
        await page.screenshot({
          path: info.outputPath(`subtitle-tools-expanded-${width}-${theme}.png`),
          animations: 'disabled',
        })
        await panel.getByRole('button', { name: '取消本次生成', exact: true }).click()
        await close.click()
        await audioContinues(page, started)
      }
    }
    // Compose the actual CSS background over the actual reading paper. A
    // preblended surface with alpha applied twice makes these mixed themes fail.
    for (const appTheme of ['light', 'dark'] as const) {
      await page.evaluate((theme) => {
        localStorage.setItem('ralb:app:theme:v1', theme)
        dispatchEvent(new Event('ralb:app-theme'))
      }, appTheme)
      await page.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
      const preferences = page.getByRole('dialog', { name: '伴读阅读设置', exact: true })
      await preferences.getByRole('tab', { name: '外观', exact: true }).click()
      await preferences
        .getByRole('button', {
          name: appTheme === 'light' ? '主题：夜间' : '主题：纸白',
          exact: true,
        })
        .click()
      await preferences.getByLabel('电子书面板透明度', { exact: true }).fill('50')
      await preferences.getByRole('button', { name: '关闭伴读面板', exact: true }).click()
      await openCompanionTools(page)
      const colors = await tools(page).evaluate((panel) => {
        const canvas = document.createElement('canvas'),
          ctx = canvas.getContext('2d')!
        canvas.width = canvas.height = 1
        ctx.fillStyle = getComputedStyle(panel.closest('.companion-page')!).backgroundColor
        ctx.fillRect(0, 0, 1, 1)
        ctx.fillStyle = getComputedStyle(panel).backgroundColor
        ctx.fillRect(0, 0, 1, 1)
        const hex = () =>
          '#' +
          [...ctx.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')
        const painted = hex()
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = getComputedStyle(panel.querySelector('h2')!).color
        ctx.fillRect(0, 0, 1, 1)
        return {
          painted,
          ink: hex(),
          paper: getComputedStyle(panel.closest('.companion-page')!).backgroundColor,
          background: getComputedStyle(panel).backgroundColor,
          reference: getComputedStyle(panel).getPropertyValue('--reader-panel-solid'),
        }
      })
      writeFileSync(
        info.outputPath(`subtitle-tools-transparency-${appTheme}.json`),
        JSON.stringify(colors),
      )
      expect(colorContrast(colors.painted, colors.ink)).toBeGreaterThanOrEqual(4.5)
      await tools(page).getByRole('button', { name: '关闭伴读面板', exact: true }).click()
    }
    expect(await page.evaluate((target) => window.desktop.getTranscript(target), target)).toEqual(
      initial,
    )
    await oneSavedSession(app)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('opening compact tools during real partial transcription keeps playback and cancellation preserves the saved document', async ({}, info) => {
  test.skip(!transcriptionProgressFixtureAvailable, transcriptionProgressFixtureRequirement)
  const data = await transcriptionProgressFixture({ releaseProbe: true })
  try {
    const { app, page, target } = data
    await observeSessions(app)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const beforeTime = await rememberAudio(page)
    const dock = page.getByRole('region', { name: '播放器', exact: true })
    const activity = dock.getByRole('region', { name: '字幕生成进度', exact: true })
    data.gate('recognize')
    data.gate('first')
    await expect(page.locator('.transcript-sentence-text')).toHaveText(['第一段已经生成的字幕。'])
    const before = await page.evaluate(
      (target) => window.desktop.getTranscriptionState(target),
      target,
    )
    if (!before.ok || !before.value.job || before.value.transcript.status !== 'ready')
      throw new Error('Expected a real partial job/document')
    const beforeJob = before.value.job
    for (let index = 0; index < 2; index++) {
      await openCompanionTools(page)
      const panel = tools(page)
      const settings = panel.locator('.transcription-controls > details')
      if ((await settings.getAttribute('open')) === null)
        await settings.locator(':scope > summary').click()
      await expect(panel.getByRole('button', { name: '调整字幕方案', exact: true })).toBeDisabled()
      await panel.getByRole('button', { name: '关闭伴读面板', exact: true }).click()
      await audioContinues(page, beforeTime)
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    await openCompanionTools(page)
    await expect(
      activity.getByRole('button', { name: '取消字幕生成', exact: true }),
    ).toBeInViewport({ ratio: 1 })
    await activity.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect
      .poll(async () => {
        const state = await page.evaluate(
          (target) => window.desktop.getTranscriptionState(target),
          target,
        )
        return state.ok ? state.value.job?.status : 'error'
      })
      .toBe('canceled')
    const after = await page.evaluate(
      (target) => window.desktop.getTranscriptionState(target),
      target,
    )
    if (!after.ok) throw new Error(after.error.message)
    expect(after.value.transcript).toEqual(before.value.transcript)
    expect(after.value.job).toMatchObject({
      id: beforeJob.id,
      attempt: beforeJob.attempt,
      status: 'canceled',
    })
    data.gate('second')
    data.gate('finish')
    await expect(page.locator('.transcript-sentence-text')).toHaveText(['第一段已经生成的字幕。'])
    await audioContinues(page, beforeTime)
    expect(data.submissions()).toBe(1)
    await oneSavedSession(app)
    await page.screenshot({
      path: info.outputPath('subtitle-tools-partial-canceled.png'),
      animations: 'disabled',
    })
  } finally {
    await data.close()
  }
})
