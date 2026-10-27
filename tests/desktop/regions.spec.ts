import {
  closeCompanionPanel,
  openCompanionProofreading,
  openCompanionSettings,
  openTranscriptImport,
} from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import type { TranscriptDocument } from '../../src/shared/transcript'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '听读 广告片段 ')),
    audio = join(root, '第32集.wav')
  await copyFile(resolve('tests/fixtures/第32集-伴读样本.wav'), audio)
  const document = JSON.parse(
    await readFile(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
  ) as TranscriptDocument
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(audio, 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  store.saveTranscript(episode.id, document)
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 1000,
    durationMs: 16360,
    rate: 1,
    volume: 1,
  })
  store.close()
  return {
    root,
    audio,
    document,
    target: { episodeId: episode.id, audioHash: episode.contentHash },
  }
}
const launch = (root: string) => {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}
async function readerFor(app: ElectronApplication) {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await openCompanionProofreading(page)
  return { page, reader: page.getByRole('region', { name: '同步伴读', exact: true }) }
}
async function choose(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
}
async function seek(page: Page, milliseconds: number) {
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(milliseconds))
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeCloseTo(milliseconds / 1000, 2)
}

test('manual intro, advertisement and recap marks fold independently, retain media coordinates and survive restart', async ({}, info) => {
  const t = await fixture()
  let app = await launch(t.root)
  try {
    let { page, reader } = await readerFor(app)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const before = await page.evaluate((target) => window.desktop.getTranscript(target), t.target)
    for (const [index, kind] of ['intro', 'advertisement', 'recap'].entries()) {
      await reader.getByRole('button', { name: `标注第 ${index + 1} 句`, exact: true }).click()
      const editor = reader.getByRole('form', { name: '片段标注', exact: true })
      await editor.getByRole('combobox', { name: '片段类型' }).selectOption(kind)
      if (index === 0) {
        await editor.getByRole('spinbutton', { name: '标注开始秒' }).fill('0.25')
        await editor.getByRole('spinbutton', { name: '标注结束秒' }).fill('5.2')
      }
      await editor.getByRole('button', { name: '保存片段标注', exact: true }).click()
      await expect(editor).toHaveCount(0)
    }
    await openCompanionSettings(reader)
    await reader.getByRole('checkbox', { name: '折叠已标注片段', exact: true }).check()
    await closeCompanionPanel(reader)
    await expect(reader.locator('.folded-region')).toHaveCount(3)
    await expect(reader.locator('.transcript-sentence')).toHaveCount(0)
    await seek(page, 1500)
    await expect(reader.locator('.folded-region-heading[aria-current="true"]')).toContainText(
      '片头',
    )
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(1.9)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime),
    ).toBeLessThan(4)
    await reader.getByRole('button', { name: '跳到前情回顾片段', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(10.825, 2)
    await expect(reader.locator('.folded-region-heading[aria-current="true"]')).toContainText(
      '前情回顾',
    )
    await reader.getByRole('button', { name: '展开广告片段', exact: true }).click()
    await expect(reader.locator('[data-segment-id="s2"]')).toBeVisible()
    await reader.locator('[data-segment-id="s2"]').click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(5.335, 2)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    await reader.getByRole('button', { name: '折叠广告片段', exact: true }).click()
    expect(await page.evaluate((target) => window.desktop.getTranscript(target), t.target)).toEqual(
      before,
    )
    await openCompanionSettings(reader)
    await reader.getByRole('tab', { name: '外观', exact: true }).click()
    await reader.getByRole('button', { name: '主题：夜间', exact: true }).click()
    await expect(reader).toHaveAttribute('data-theme', 'dark')
    await closeCompanionPanel(reader)
    await page.screenshot({ path: info.outputPath('regions-dark.png'), fullPage: true })
    await app.close()
    app = await launch(t.root)
    ;({ page, reader } = await readerFor(app))
    await openCompanionSettings(reader)
    await expect(reader.getByRole('checkbox', { name: '折叠已标注片段' })).toBeChecked()
    await closeCompanionPanel(reader)
    await expect(reader.locator('.folded-region')).toHaveCount(3)
    await expect(reader.locator('.folded-region-heading[aria-current="true"]')).toContainText(
      '广告',
    )
    const marks = await page.evaluate(
      (target) => window.desktop.getTranscriptRegions(target),
      t.target,
    )
    expect(marks.ok && marks.value.regions.map((region) => region.kind)).toEqual([
      'intro',
      'advertisement',
      'recap',
    ])
    await reader.getByRole('button', { name: '展开广告片段', exact: true }).click()
    await openCompanionProofreading(reader)
    await reader.getByRole('button', { name: '标注第 2 句', exact: true }).click()
    await reader.getByRole('combobox', { name: '片段类型' }).selectOption('')
    await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
    await expect(reader.locator('.folded-region')).toHaveCount(2)
    await expect(reader.locator('[data-segment-id="s2"]')).toContainText(
      t.document.segments[1]!.text,
    )
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('new segmentation keeps partial boundaries visible; stale mark writers cannot overwrite current ranges or another audio version', async ({}, info) => {
  const t = await fixture(),
    store = new LibraryStore(join(t.root, 'data', 'library.sqlite3'))
  store.markTranscriptRegion({
    ...t.target,
    revision: 0,
    startMs: 1000,
    endMs: 6000,
    kind: 'advertisement',
  })
  store.close()
  const app = await launch(t.root)
  try {
    const { page, reader } = await readerFor(app)
    await openCompanionSettings(reader)
    await reader.getByRole('checkbox', { name: '折叠已标注片段' }).check()
    await closeCompanionPanel(reader)
    await expect(reader.locator('.folded-region')).toHaveCount(1)
    await expect(reader.locator('[data-segment-id="s2"]')).toBeVisible()
    await expect(reader.getByText('广告 · 与标注边界部分重叠，保持展开')).toBeVisible()
    const replacement = join(t.root, '新分句.json')
    await writeFile(
      replacement,
      JSON.stringify({
        ...t.document,
        segments: [
          { id: 'regenerated', startMs: 900, endMs: 7000, text: '片头、广告和正文在新的句子内。' },
        ],
        coverage: [{ startMs: 0, endMs: 16360 }],
      }),
    )
    await choose(app, replacement)
    await openTranscriptImport(reader)
    await reader.getByRole('button', { name: '重新导入文稿', exact: true }).click()
    await expect(reader.locator('.folded-region')).toHaveCount(0)
    await expect(reader.locator('[data-segment-id="regenerated"]')).toBeVisible()
    const original = await page.evaluate(
      (target) => window.desktop.getTranscriptRegions(target),
      t.target,
    )
    expect(original.ok && original.value.revision).toBe(1)
    await openCompanionProofreading(reader)
    await reader.getByRole('button', { name: '标注第 1 句', exact: true }).click()
    await reader.getByRole('combobox', { name: '片段类型' }).selectOption('intro')
    const concurrent = await page.evaluate(
      (target) =>
        window.desktop.markTranscriptRegion({
          ...target,
          revision: 1,
          startMs: 8000,
          endMs: 10000,
          kind: 'recap',
        }),
      t.target,
    )
    expect(concurrent.ok).toBe(true)
    await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
    await expect(reader.getByRole('alert')).toContainText('标注已更新')
    expect(
      await page.evaluate((target) => window.desktop.getTranscriptRegions(target), t.target),
    ).toEqual(concurrent)
    const wrongAsset = await page.evaluate(
      (target) =>
        window.desktop.markTranscriptRegion({
          ...target,
          audioHash: '0'.repeat(64),
          revision: 2,
          startMs: 0,
          endMs: 1000,
          kind: 'intro',
        }),
      t.target,
    )
    expect(wrongAsset.ok).toBe(false)
    if (!wrongAsset.ok) expect(wrongAsset.error.code).toBe('FILE_CHANGED')
    await reader.getByRole('button', { name: '取消标注', exact: true }).click()
    await reader.locator('.region-manager > summary').click()
    const manager = reader.locator('.region-manager')
    await manager.getByRole('button', { name: '按时间新增标注', exact: true }).click()
    await reader.getByRole('combobox', { name: '片段类型' }).selectOption('intro')
    await reader.getByRole('spinbutton', { name: '标注开始秒' }).fill('0')
    await reader.getByRole('spinbutton', { name: '标注结束秒' }).fill('0.5')
    await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
    const silentIntro = manager.getByRole('listitem').filter({ hasText: '片头 · 0–0.5 秒' })
    await expect(silentIntro).toBeVisible()
    await silentIntro.getByRole('button', { name: '定位范围', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(0, 2)
    await expect(manager.locator('[aria-current="true"]')).toContainText('片头')
    await silentIntro.getByRole('button', { name: '修改标注', exact: true }).click()
    await reader.getByRole('spinbutton', { name: '标注开始秒' }).fill('0.1')
    await reader.getByRole('spinbutton', { name: '标注结束秒' }).fill('0.4')
    await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
    await expect(silentIntro).toHaveCount(0)
    const resizedIntro = manager.getByRole('listitem').filter({ hasText: '片头 · 0.1–0.4 秒' })
    await expect(resizedIntro).toBeVisible()
    await resizedIntro.getByRole('button', { name: '修改标注', exact: true }).click()
    await reader.getByRole('spinbutton', { name: '标注开始秒' }).fill('0.55')
    await reader.getByRole('spinbutton', { name: '标注结束秒' }).fill('0.8')
    await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
    await expect(resizedIntro).toHaveCount(0)
    const movedIntro = manager.getByRole('listitem').filter({ hasText: '片头 · 0.55–0.8 秒' })
    await expect(movedIntro).toBeVisible()
    await movedIntro.getByRole('button', { name: '修改标注', exact: true }).click()
    await reader.getByRole('combobox', { name: '片段类型' }).selectOption('')
    await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
    await expect(movedIntro).toHaveCount(0)
    await expect(manager.getByRole('listitem')).toHaveCount(2)
    await page.setViewportSize({ width: 820, height: 650 })
    await page.screenshot({ path: info.outputPath('partial-boundary.png'), fullPage: true })
  } finally {
    await app.close()
  }
})

test('a marked range crossing three bounded reading windows follows the real clock and expansion keeps pagination bounded', async () => {
  const t = await fixture(),
    store = new LibraryStore(join(t.root, 'data', 'library.sqlite3'))
  store.saveTranscript(t.target.episodeId, {
    ...t.document,
    coverage: [{ startMs: 0, endMs: 16360 }],
    segments: Array.from({ length: 130 }, (_, index) => ({
      id: `page-${index}`,
      startMs: index * 100 + 10,
      endMs: index * 100 + 80,
      text: `独立阅读片段 ${index + 1}。`,
    })),
  })
  store.markTranscriptRegion({
    ...t.target,
    revision: 0,
    startMs: 0,
    endMs: 12500,
    kind: 'advertisement',
  })
  store.close()
  const app = await launch(t.root)
  try {
    const { page, reader } = await readerFor(app)
    await openCompanionSettings(reader)
    await reader.getByRole('checkbox', { name: '折叠已标注片段' }).check()
    await closeCompanionPanel(reader)
    await expect(reader.locator('.folded-region')).toContainText('本页 60 句已折叠')
    await seek(page, 12250)
    await expect(reader.locator('.folded-region-heading [data-sentence]')).toHaveAttribute(
      'data-sentence',
      '120',
    )
    await expect(reader.locator('.folded-region-heading[aria-current="true"]')).toContainText(
      '本页 5 句已折叠',
    )
    await expect(reader.locator('.transcript-sentence')).toHaveCount(5)
    await reader.getByRole('button', { name: '展开广告片段', exact: true }).click()
    await expect(reader.locator('.transcript-sentence')).toHaveCount(10)
    const audioBeforeBrowse = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
      time: audio.currentTime,
      paused: audio.paused,
    }))
    const previous = reader
      .getByRole('navigation', { name: '文稿翻页', exact: true })
      .getByRole('button', { name: '上一页', exact: true })
    // Measured screens can share one bounded data window. Traverse them before
    // asserting that the adjacent window is rendered, rather than inventing a
    // global page number from sentenceCount / 60.
    for (
      let screen = 0;
      screen < 12 &&
      (await reader.locator('[data-segment-id]').first().getAttribute('data-segment-id')) !==
        'page-60';
      screen++
    )
      await previous.click()
    await expect(reader.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      'page-60',
    )
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
        time: audio.currentTime,
        paused: audio.paused,
      })),
    ).toEqual(audioBeforeBrowse)
    await expect(reader.locator('.transcript-sentence')).toHaveCount(60)
    await expect(reader.locator('.folded-region')).toHaveCount(0)
    await reader.getByRole('button', { name: '折叠广告片段', exact: true }).first().click()
    await expect(reader.locator('.folded-region')).toContainText('本页 60 句已折叠')
    await reader.getByRole('button', { name: '回到当前播放位置', exact: true }).click()
    await expect(reader.locator('.folded-region-heading [data-sentence]')).toHaveAttribute(
      'data-sentence',
      '120',
    )
    await expect(reader.locator('.folded-region-heading[aria-current="true"]')).toContainText(
      '广告',
    )
  } finally {
    await app.close()
  }
})
