import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { closeOwnedElectron } from '../model/electron-lifecycle'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'player-icons-'))
  const path = join(root, '山间来信与远方的风景，一个较长的章节标题.wav')
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
  writeFileSync(path, wav)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(path, 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  store.recordSourceDuration(episode.id, episode.contentHash, 90000)
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [
      { startMs: 0, endMs: 30000 },
      { startMs: 60000, endMs: 90000 },
    ],
    segments: [{ id: 's0', startMs: 61000, endMs: 89000, text: '山间来信写下了远方的风景。' }],
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 65000,
    durationMs: 90000,
    rate: 2,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  return { app, page: await app.firstWindow() }
}

for (const [width, height] of [
  [1180, 800],
  [720, 600],
]) {
  test(`player icons expose action help and exact subtitle numbers without losing one audio session at ${width}px`, async ({}, info) => {
    const { app, page } = await fixture()
    try {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height)
        },
        { width: width!, height: height! },
      )
      const panel = page.getByRole('region', { name: '播放器', exact: true })
      await expect(panel.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
      const audio = page.locator('audio[data-player="persistent"]')
      const original = await audio.evaluate((node: HTMLAudioElement) => ({
        source: node.currentSrc,
        time: node.currentTime,
        paused: node.paused,
      }))
      expect(original.paused).toBe(true)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
        await panel.getByRole('button', { name: '字幕与伴读', exact: true }).click()
        const tools = page.getByRole('dialog', { name: '收听工具', exact: true })
        await expect(tools.getByRole('tab', { name: '字幕与缓存', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        )
        await tools.getByRole('button', { name: '关闭收听工具', exact: true }).click()
        for (const name of ['字幕与伴读', '伴读阅读']) {
          const action = panel.getByRole('button', { name, exact: true })
          await expect(action).toHaveText('')
          await expect(action.locator('svg')).toBeVisible()
          await expect(action).toBeInViewport({ ratio: 1 })
          await action.focus()
          await expect(page.getByRole('tooltip')).toBeVisible()
          await expect(action).not.toHaveAttribute('title')
          await page.keyboard.press('Escape')
          await expect(page.getByRole('tooltip')).toHaveCount(0)
          await expect(action).toBeFocused()
        }
        const summary = panel.locator('.subtitle-status-player > summary')
        await expect(summary).toHaveAccessibleName(
          /字幕部分已备.*已备 01:00 \/ 01:30.*2×可听约 12 秒/,
        )
        await expect(summary.locator('.subtitle-status-value')).toHaveText('01:00')
        await expect(summary.locator('.subtitle-status-lead')).toHaveText('12s')
        await expect(summary).not.toContainText('领先')
        const coverage = summary.getByRole('progressbar', { name: '已保存字幕覆盖', exact: true })
        await expect(coverage).toHaveAttribute('value', '60000')
        await expect(coverage).toHaveAttribute('max', '90000')
        await summary.focus()
        await expect(page.getByRole('tooltip')).toContainText('覆盖 00:00–00:30、01:00–01:30')
        await page.keyboard.press('Escape')
        await summary.press('Enter')
        await expect(panel.getByRole('group', { name: '字幕准备状态', exact: true })).toContainText(
          '25 秒音频，2×可听约 12 秒',
        )
        await panel.getByRole('button', { name: '收起字幕状态', exact: true }).click()
        const fit = await panel.evaluate((node) => {
          const bounds = node.getBoundingClientRect()
          return [
            ...node.querySelectorAll<HTMLElement>(
              '.audio-settings button, .audio-settings select, .transport button',
            ),
          ]
            .filter((el) => el.getClientRects().length)
            .every((el) => {
              const box = el.getBoundingClientRect()
              return (
                box.left >= bounds.left &&
                box.right <= bounds.right &&
                box.top >= bounds.top &&
                box.bottom <= bounds.bottom
              )
            })
        })
        expect(fit).toBe(true)
        await page.screenshot({
          path: info.outputPath(`player-${width}-${theme}.png`),
          animations: 'disabled',
        })
      }
      await panel.getByRole('button', { name: '伴读阅读', exact: true }).click()
      await expect(page.getByRole('region', { name: '同步伴读', exact: true })).toBeVisible()
      await expect(page.getByRole('region', { name: '播放器', exact: true })).toHaveCount(1)
      await expect(audio).toHaveCount(1)
      expect(
        await audio.evaluate((node: HTMLAudioElement) => ({
          source: node.currentSrc,
          time: node.currentTime,
          paused: node.paused,
        })),
      ).toEqual(original)
    } finally {
      await closeOwnedElectron(app)
    }
  })
}
