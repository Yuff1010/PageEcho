import { test, expect, type Page, type Locator } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  transcriptionProgressFixture,
  transcriptionProgressFixtureAvailable,
  transcriptionProgressFixtureRequirement,
} from '../helpers/transcription-progress-fixture'
import type { TranscriptRequest } from '../../src/shared/transcript'

test.skip(!transcriptionProgressFixtureAvailable, transcriptionProgressFixtureRequirement)

const playerPanel = (page: Page) => page.getByRole('region', { name: '播放器', exact: true })
const companion = (page: Page) => page.getByRole('region', { name: '同步伴读', exact: true })
const activity = (page: Page) =>
  playerPanel(page).getByRole('region', { name: '字幕生成进度', exact: true })
const progress = (root: Locator) =>
  root.getByRole('progressbar', { name: '字幕生成进度条', exact: true })

async function transcription(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate((value) => window.desktop.getTranscriptionState(value), target)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function dockMetrics(page: Page) {
  return companion(page).evaluate((root) => {
    const visible = (selector: string) =>
      Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
        (element) => element.getClientRects().length > 0,
      )
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect()
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        right: value.right,
        bottom: value.bottom,
      }
    }
    const toolbar = visible('.book-reader-toolbar')!
    const dock = visible('.player-panel[data-reader-dock="true"]')!
    const stage = visible('.companion-reading-stage')!
    const row = visible('.reader-dock-row')!
    const controls = (host: HTMLElement, selector: string) =>
      Array.from(host.querySelectorAll<HTMLElement>(selector))
        .filter(
          (element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden',
        )
        .map((element) => ({
          name:
            element.getAttribute('aria-label') ??
            element.getAttribute('title') ??
            element.textContent?.trim().slice(0, 80) ??
            element.tagName,
          slot: element.closest('.reader-dock-slot')?.className ?? 'player-controls',
          tag: element.tagName,
          ...rect(element),
        }))
    const viewport = visible(
      '.companion-book-viewport, [aria-label="文稿阅读区"], [aria-label="原文阅读区"]',
    )
    return {
      window: { width: innerWidth, height: innerHeight },
      toolbar: rect(toolbar),
      dock: rect(dock),
      stage: rect(stage),
      viewport: viewport ? rect(viewport) : null,
      dockRow: rect(row),
      rowControls: controls(
        row,
        '.reader-dock-slot button, .reader-dock-slot input, .reader-dock-slot label, .reader-dock-slot select',
      ),
      playerControls: controls(
        dock,
        '.player-heading button, .player-center button, .player-center input, .player-right button, .player-right input, .player-right select',
      ),
      sourceInPlayer: !!visible('[aria-label="伴读文字来源"]')?.closest('.player-panel'),
      activityInPlayer: !!visible('.transcription-activity-inline')?.closest('.player-panel'),
      footers: Array.from(root.querySelectorAll<HTMLElement>('.book-reader-footer'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ inPlayer: !!element.closest('.player-panel'), ...rect(element) })),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
}

async function assertSingleDock(page: Page) {
  const reader = companion(page)
  const dock = playerPanel(page)
  await expect(dock).toHaveCount(1)
  await expect(dock).toHaveAttribute('data-reader-dock', 'true')
  await expect(reader.locator('.player-panel')).toHaveCount(1)
  await expect(reader.locator(':scope > .companion-source-bar')).toHaveCount(0)
  await expect(reader.locator(':scope > .companion-source-tabs')).toHaveCount(0)
  await expect(dock.locator('.reader-dock-row')).toHaveCount(1)
  await expect(dock.getByRole('group', { name: '伴读文字来源', exact: true })).toBeVisible()
  await expect(
    dock.locator('.reader-dock-slot--activity .transcription-activity-inline'),
  ).toHaveCount(1)
  await expect(reader.locator('.transcription-activity:visible')).toHaveCount(0)
  await expect(page.locator('audio[data-player="persistent"]')).toHaveCount(1)
  const metrics = await dockMetrics(page)
  await test.info().attach('reader-dock-control-bounds', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  expect(metrics.sourceInPlayer).toBe(true)
  expect(metrics.activityInPlayer).toBe(true)
  expect(metrics.footers.every((footer) => footer.inPlayer)).toBe(true)
  expect(metrics.stage.height).toBeGreaterThan(metrics.window.height * 0.65)
  const available = metrics.window.height - metrics.toolbar.height - metrics.dock.height
  expect(metrics.stage.height).toBeGreaterThan(available * 0.9)
  expect(metrics.stage.bottom).toBeLessThanOrEqual(metrics.dock.y + 1)
  expect(metrics.overflow).toBe(false)
  expect(metrics.rowControls.length).toBeGreaterThan(0)
  for (const control of metrics.rowControls) {
    const label = `${control.slot}: ${control.tag} ${control.name}`
    expect(control.x, `${label} must stay inside the dock row's left edge`).toBeGreaterThanOrEqual(
      metrics.dockRow.x - 1,
    )
    expect(
      control.right,
      `${label} must stay inside the dock row's right edge`,
    ).toBeLessThanOrEqual(metrics.dockRow.right + 1)
    expect(control.y, `${label} must stay inside the dock row's top edge`).toBeGreaterThanOrEqual(
      metrics.dockRow.y - 1,
    )
    expect(
      control.bottom,
      `${label} must stay inside the dock row's bottom edge`,
    ).toBeLessThanOrEqual(metrics.dockRow.bottom + 1)
  }
  const collisions = metrics.rowControls.flatMap((rowControl) =>
    metrics.playerControls.flatMap((playerControl) => {
      const width =
        Math.min(rowControl.right, playerControl.right) - Math.max(rowControl.x, playerControl.x)
      const height =
        Math.min(rowControl.bottom, playerControl.bottom) - Math.max(rowControl.y, playerControl.y)
      return width > 1 && height > 1
        ? [{ row: rowControl.name, player: playerControl.name, width, height }]
        : []
    }),
  )
  expect(
    collisions,
    'source, generation and pagination controls must not overlap the audio controls',
  ).toEqual([])
  return metrics
}

for (const [width, height] of [
  [1144, 761],
  [720, 600],
] as const) {
  test(`reader dock combines source, live generation and navigation with one player at ${width}×${height}`, async ({}, info) => {
    const data = await transcriptionProgressFixture({ linkedOriginal: true })
    try {
      await data.page.emulateMedia({ reducedMotion: 'reduce' })
      await data.app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
        { width, height },
      )
      await data.page.getByRole('button', { name: '继续播放', exact: true }).click()
      await data.page.getByRole('button', { name: '伴读阅读', exact: true }).click()
      await expect.poll(() => existsSync(join(data.gates, 'probe-started'))).toBe(true)
      const source = playerPanel(data.page).getByRole('group', {
        name: '伴读文字来源',
        exact: true,
      })
      await source.getByRole('button', { name: '转写字幕', exact: true }).click()
      const inline = activity(data.page)
      await expect(inline).toHaveAttribute('data-state', 'running')
      await expect(inline.getByRole('button', { name: '字幕生成详情', exact: true })).toContainText(
        '检查字幕组件',
      )
      await expect(progress(inline)).toBeVisible()
      expect(await progress(inline).getAttribute('value')).toBeNull()
      expect(await progress(inline).getAttribute('aria-valuenow')).toBeNull()
      await expect(
        inline.getByRole('button', { name: '取消字幕生成', exact: true }),
      ).toBeInViewport()
      const checking = await assertSingleDock(data.page)
      data.gate('probe-release')
      data.gate('recognize')
      data.gate('first')
      await expect
        .poll(async () => (await transcription(data.page, data.target)).job?.completedChunks)
        .toBe(1)
      await expect(inline.locator('.transcription-inline-count')).toHaveAttribute(
        'aria-label',
        '已完成 1 / 3 段',
      )
      await expect(progress(inline)).toHaveAttribute('value', '1')
      await expect(progress(inline)).toHaveAttribute('max', '3')
      await expect(
        playerPanel(data.page).getByRole('navigation', { name: '文稿翻页', exact: true }),
      ).toBeVisible()
      await expect(companion(data.page).locator('.transcript-sentence-text')).toHaveText([
        '第一段已经生成的字幕。',
      ])
      const partial = await assertSingleDock(data.page)
      expect(partial.footers).toHaveLength(1)
      await source.getByRole('button', { name: '小说原文', exact: true }).click()
      await expect(
        playerPanel(data.page).getByRole('navigation', { name: '原文分页', exact: true }),
      ).toBeVisible()
      const original = await assertSingleDock(data.page)
      expect(original.footers).toHaveLength(1)
      await source.getByRole('button', { name: '转写字幕', exact: true }).click()
      const before = await transcription(data.page, data.target)
      await inline.getByRole('button', { name: '取消字幕生成', exact: true }).click()
      await expect
        .poll(async () => (await transcription(data.page, data.target)).job?.status)
        .toBe('canceled')
      expect((await transcription(data.page, data.target)).transcript).toEqual(before.transcript)
      await expect(progress(inline)).toBeHidden()
      const audio = data.page.locator('audio[data-player="persistent"]')
      expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(false)
      const time = await audio.evaluate((node: HTMLAudioElement) => node.currentTime)
      await expect
        .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
        .toBeGreaterThan(time + 0.2)
      await data.page.screenshot({
        path: info.outputPath(`reader-dock-${width}.png`),
        animations: 'disabled',
      })
      await info.attach('reader-dock-metrics', {
        body: JSON.stringify({ checking, partial, original }, null, 2),
        contentType: 'application/json',
      })
    } finally {
      await data.close()
    }
  })
}
