import {
  closeCompanionPanel,
  leaveCompanionPage,
  openCompanionSettings,
  openCompanionTools,
  openTranscriptImport,
} from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TranscriptDocument } from '../../src/shared/transcript'

const fixtureAudio = resolve('tests/fixtures/第32集-伴读样本.wav')
const fixtureDocument = JSON.parse(
  readFileSync(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
) as TranscriptDocument
function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}
async function choose(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: path === null, filePaths: path ? [path] : [] })
  }, path)
}
async function getState(page: Page) {
  const result = await page.evaluate(() => window.desktop.getState())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function startAudio(app: ElectronApplication, page: Page, path: string) {
  await choose(app, path)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
}
async function importDocument(app: ElectronApplication, page: Page, path: string | null) {
  await choose(app, path)
  await openTranscriptImport(page)
  await page
    .getByRole('region', { name: '同步伴读', exact: true })
    .getByRole('button', { name: /^(导入 JSON 文稿|重新导入文稿)$/ })
    .click()
}
async function seek(page: Page, ms: number) {
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(ms))
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeCloseTo(ms / 1000, 1)
}

test('manual Chinese transcript follows the actual media clock at four speeds, seeks by sentence and identifies gaps and end', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读 M2 同步 '))
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startAudio(app, page, fixtureAudio)
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    const initialActivity = reader
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('region', { name: '字幕生成进度', exact: true })
    const generationDetails = initialActivity.getByRole('button', {
      name: '字幕生成详情',
      exact: true,
    })
    await expect(generationDetails).toHaveText('字幕暂未开始')
    await generationDetails.click()
    const details = initialActivity.getByRole('group', { name: '字幕生成详情', exact: true })
    await expect(details.getByRole('heading', { name: '字幕暂未开始', exact: true })).toBeVisible()
    await expect(details).toContainText('尚未找到字幕组件')
    await generationDetails.press('Escape')
    await expect(details).toBeHidden()
    await expect(reader.locator('.transcript-sentence')).toHaveCount(0)
    await importDocument(app, page, resolve('tests/fixtures/reading-manual.json'))
    await expect(
      reader.getByRole('button', { name: /^(导入 JSON 文稿|重新导入文稿)$/ }),
    ).toBeHidden()
    await openCompanionTools(reader)
    await expect(reader.getByText('3 句 · 版本 1')).toBeVisible()
    await closeCompanionPanel(reader)
    const current = reader.locator('.transcript-sentence[aria-current="true"]')
    await seek(page, 1500)
    await expect(current).toContainText('第十九章，故事从这里继续。')
    await reader.locator('[data-segment-id="s2"]').click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(5.335, 2)
    await expect(current).toContainText(fixtureDocument.segments[1]!.text)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    const samples: unknown[] = []
    for (const rate of [0.75, 1, 1.5, 2]) {
      await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption(String(rate))
      await seek(page, 6300)
      await page.getByRole('button', { name: '播放', exact: true }).click()
      await expect
        .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
        .toBeGreaterThan(6.65)
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      await expect(current).toHaveAttribute('data-segment-id', 's2')
      samples.push(
        await page.evaluate(() => ({
          timeMs: document.querySelector('audio')!.currentTime * 1000,
          rate: document.querySelector('audio')!.playbackRate,
          segment: document
            .querySelector('.transcript-sentence[aria-current="true"]')
            ?.getAttribute('data-segment-id'),
        })),
      )
      await seek(page, 1500)
      await expect(current).toHaveAttribute('data-segment-id', 's1')
    }
    await seek(page, 4800)
    await expect(reader.locator('.timeline-status')).toContainText('句间停顿')
    await expect(current).toHaveCount(0)
    await seek(page, 5000)
    await expect(reader.locator('.timeline-status')).toContainText('未覆盖区间')
    await expect(current).toHaveCount(0)
    await seek(page, 16360)
    await expect(reader.locator('.timeline-status')).toHaveText('播放已结束')
    await expect(current).toHaveCount(0)
    await reader.locator('[data-segment-id="s3"]').click()
    await expect(current).toHaveAttribute('data-segment-id', 's3')
    await page.screenshot({ path: testInfo.outputPath('m2-reading.png'), fullPage: true })
    await testInfo.attach('media-clock-samples', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('6,000 sentences are paginated; manual scroll stays put until follow is restored; reading settings and document survive restart', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读 M2 长文稿 '))
  const path = join(root, '第32集 长文稿.wav')
  const size = 600 * 16000
  const header = Buffer.alloc(44)
  header.write('RIFF')
  header.writeUInt32LE(size + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(size, 40)
  const file = openSync(path, 'w')
  writeSync(file, header)
  ftruncateSync(file, size + 44)
  closeSync(file)
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    await startAudio(app, page, path)
    const episode = (await getState(page)).books[0]!.episodes[0]!
    const longDocument: TranscriptDocument = {
      version: 1,
      audioHash: episode.contentHash,
      kind: 'original',
      coverage: [{ startMs: 0, endMs: 600000 }],
      segments: Array.from({ length: 6000 }, (_, index) => ({
        id: `r${index}`,
        startMs: index * 100,
        endMs: index * 100 + 80,
        text: `第 ${index + 1} 句：第十九章的故事仍在继续，文字应随音频位置显示。`,
      })),
    }
    const json = join(root, '长文稿.json')
    writeFileSync(json, JSON.stringify(longDocument))
    await importDocument(app, page, json)
    let reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await expect(reader.locator('.transcript-sentence')).toHaveCount(60)
    await openCompanionSettings(reader)
    await reader.getByRole('tab', { name: '翻页', exact: true }).click()
    await reader
      .getByRole('combobox', { name: '电子书翻页方式', exact: true })
      .selectOption('scroll')
    await reader.getByRole('checkbox', { name: '平滑滚动', exact: true }).uncheck()
    await closeCompanionPanel(reader)
    await seek(page, 500000)
    await expect(reader.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      'r4980',
    )
    await expect(reader.locator('[aria-current="true"]')).toHaveAttribute(
      'data-segment-id',
      'r5000',
    )
    const viewport = reader.getByLabel('文稿阅读区', { exact: true })
    const before = await viewport.evaluate((element) => element.scrollTop)
    await viewport.hover()
    await page.mouse.wheel(0, -300)
    await expect(reader.getByText('自由阅读', { exact: true })).toBeVisible()
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(before)
    const position = await viewport.evaluate((element) => element.scrollTop)
    await seek(page, 550000)
    await expect(reader.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      'r4980',
    )
    expect(await viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(position, 0)
    await reader.getByRole('button', { name: '回到当前播放位置', exact: true }).click()
    await expect(reader.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      'r5460',
    )
    await expect(reader.locator('[aria-current="true"]')).toHaveAttribute(
      'data-segment-id',
      'r5500',
    )
    await viewport.focus()
    await viewport.press('PageUp')
    await expect(reader.getByRole('button', { name: '回到当前播放位置' })).toBeVisible()
    await reader.getByRole('button', { name: '回到当前播放位置' }).click()
    await openCompanionSettings(reader)
    await reader.getByRole('tab', { name: '排版', exact: true }).click()
    await reader.getByRole('slider', { name: '电子书字号', exact: true }).fill('24')
    await closeCompanionPanel(reader)
    await openCompanionSettings(reader)
    await reader.getByRole('tab', { name: '排版', exact: true }).click()
    await reader.getByRole('slider', { name: '电子书行距', exact: true }).fill('2.2')
    await closeCompanionPanel(reader)
    await openCompanionSettings(reader)
    await reader.getByRole('tab', { name: '外观', exact: true }).click()
    await reader.getByRole('button', { name: '主题：夜间', exact: true }).click()
    await closeCompanionPanel(reader)
    expect(
      await reader
        .locator('.transcript-sentence')
        .first()
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe('24px')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    try {
      await expect(reader.locator('[aria-current="true"]')).toBeInViewport({ ratio: 1 })
    } catch (error) {
      await page.screenshot({ path: testInfo.outputPath('reading-layout-failure.png') })
      await testInfo.attach('reading-layout', {
        body: JSON.stringify(
          await page.evaluate(() => {
            const bounds = (selector: string) => {
              const element = document.querySelector<HTMLElement>(selector)!
              return {
                rect: element.getBoundingClientRect().toJSON(),
                scroll: element.scrollTop,
                client: element.clientHeight,
              }
            }
            return {
              window: [window.innerWidth, window.innerHeight, window.scrollY],
              viewport: bounds('.transcript-viewport'),
              current: bounds('.transcript-sentence[aria-current="true"]'),
              panel: bounds('.reader-panel'),
              player: bounds('.player-panel'),
            }
          }),
          null,
          2,
        ),
        contentType: 'application/json',
      })
      throw error
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath('m2-long-dark-minimum.png'),
      fullPage: false,
    })
    await app.close()
    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await openCompanionSettings(reader)
    await reader.getByRole('tab', { name: '排版', exact: true }).click()
    await expect(reader.getByRole('slider', { name: '电子书字号', exact: true })).toHaveValue('24')
    await expect(reader.getByRole('slider', { name: '电子书行距', exact: true })).toHaveValue('2.2')
    await reader.getByRole('tab', { name: '外观', exact: true }).click()
    await expect(reader.getByRole('button', { name: '主题：夜间', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(reader).toHaveAttribute('data-theme', 'dark')
    await closeCompanionPanel(reader)
    await expect(reader.locator('.transcript-sentence')).toHaveCount(60)
    await expect(reader.locator('[aria-current="true"]')).toHaveAttribute(
      'data-segment-id',
      'r5500',
    )
  } finally {
    await app.close()
  }
})

test('bad or canceled imports preserve the valid document; changed audio makes the old transcript stale', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M2 文稿版本 '))
  const path = join(root, '版本测试.wav')
  copyFileSync(fixtureAudio, path)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await startAudio(app, page, path)
    let reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await importDocument(app, page, resolve('tests/fixtures/reading-manual.json'))
    await expect(reader.locator('.transcript-sentence')).toHaveCount(3)
    const bad = join(root, '无效.json')
    writeFileSync(bad, JSON.stringify({ ...fixtureDocument, audioHash: '0'.repeat(64) }))
    await importDocument(app, page, bad)
    await expect(reader.getByRole('alert')).toContainText('不属于当前音频版本')
    await expect(reader.locator('.transcript-sentence')).toHaveCount(3)
    writeFileSync(bad, '{ bad')
    await importDocument(app, page, bad)
    await expect(reader.getByRole('alert')).toContainText('不是有效的 JSON')
    await importDocument(app, page, null)
    await expect(reader.getByRole('alert')).toHaveCount(0)
    await expect(reader.locator('.transcript-sentence')).toHaveCount(3)
    const bytes = readFileSync(path)
    bytes[bytes.length - 1] = 1
    writeFileSync(path, bytes)
    await leaveCompanionPage(page)
    await page.getByRole('button', { name: /我的书架/ }).click()
    await choose(app, path)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await expect
      .poll(async () => (await getState(page)).books[0]!.episodes[0]!.contentHash)
      .not.toBe(fixtureDocument.audioHash)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    reader = page.getByRole('region', { name: '同步伴读', exact: true })
    const changedEpisode = (await getState(page)).books[0]!.episodes[0]!
    const stale = await page.evaluate((target) => window.desktop.getTranscript(target), {
      episodeId: changedEpisode.id,
      audioHash: changedEpisode.contentHash,
    })
    expect(stale.ok && stale.value.status).toBe('stale')
    await expect(reader.getByText('音频版本已变化', { exact: true })).toBeVisible()
    await expect(reader.locator('.transcript-sentence')).toHaveCount(0)
    const episode = (await getState(page)).books[0]!.episodes[0]!
    writeFileSync(bad, JSON.stringify({ ...fixtureDocument, audioHash: episode.contentHash }))
    await importDocument(app, page, bad)
    await expect(reader.locator('.transcript-sentence')).toHaveCount(3)
    await seek(page, 1500)
    await expect(reader.locator('[aria-current="true"]')).toHaveAttribute('data-segment-id', 's1')
  } finally {
    await app.close()
  }
})
