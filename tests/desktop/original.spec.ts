import {
  closeOriginalPanel,
  openOriginalTools,
  openTranscriptImport,
  useOriginalText,
  waitForOriginalReady,
} from '../helpers/ui'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { zip, epub } from '../fixtures/original-epub'

test('original import, uncertain gaps, correction, version checks and restart use restricted IPC', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读原文回归 '))
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const appRoot = resolve(process.env.RALB_APP_ROOT ?? '.')
  let app = await electron.launch({ args: [appRoot], env })
  const original = join(root, '原文.txt'),
    invalid = join(root, '无效.txt')
  writeFileSync(
    original,
    '第19章 山路\n少年将整齐的衣服收进旅行用的布袋。\n他把旧地图折好，小心放进身后的背包。\n山谷中的钟声渐渐远去，路上只剩下清风和明月。\n第20章 清晨\n第二天清晨，他们沿着河岸走向远方的村庄。',
  )
  writeFileSync(invalid, Buffer.from([0, 1]))
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const choose = async (path: string | null) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: selected === null,
          filePaths: selected ? [selected] : [],
        })
      }, path)
    await choose(resolve('tests/fixtures/第32集-伴读样本.wav'))
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const state = await page.evaluate(() => window.desktop.getState())
    if (!state.ok) throw new Error(state.error.message)
    const audio = state.value.books[0]!.episodes[0]!,
      target = { episodeId: audio.id, audioHash: audio.contentHash }
    const document = JSON.parse(readFileSync(resolve('tests/fixtures/reading-manual.json'), 'utf8'))
    document.segments[0].text = '他把旧地图折好，小心放进身后的背包。'
    document.segments[1].text = '这是一个没有小说对应内容的测试插话。'
    const transcript = join(root, '时间戳.json')
    writeFileSync(transcript, JSON.stringify(document))
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await choose(transcript)
    await openTranscriptImport(page)
    await page.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
    // Import finishes by closing its drawer. Wait for that transition before
    // opening the next tool; a click does not await an async React handler.
    await expect(page.getByRole('button', { name: '导入 JSON 文稿', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: '关闭伴读面板', exact: true })).toBeHidden()
    await useOriginalText(page)
    await choose(original)
    await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
    await waitForOriginalReady(page)
    await openOriginalTools(page, '原文来源')
    await expect(page.locator('.original-summary')).toContainText('2 个原文分区')
    await openOriginalTools(page)
    // Binding now schedules automatic matching. Observe its result rather than
    // racing the initial button label as it becomes the rematch action.
    const getOriginal = async () => {
      const result = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    await expect.poll(async () => (await getOriginal()).alignment?.revision).toBe(1)
    const before = await getOriginal()
    expect(before.alignment?.matches[0]?.selected?.first).toBe(1)
    expect(before.alignment?.matches[1]?.selected).toBeNull()
    await closeOriginalPanel(page)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('1500')
    await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
    await expect(page.locator('.original-sentence[aria-current="true"]')).toHaveCount(1)
    await expect
      .poll(() => page.locator('.original-viewport').evaluate((element) => element.clientHeight))
      .toBeGreaterThanOrEqual(180)
    await expect(page.locator('.original-sentence[aria-current="true"]')).toBeInViewport({
      ratio: 1,
    })
    await page.locator('.original-viewport').focus()
    await page.locator('.original-viewport').press('PageDown')
    await expect(page.locator('.original-reader')).toContainText('自由阅读')
    await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
    await expect(page.locator('.original-sentence[aria-current="true"]')).toBeInViewport({
      ratio: 1,
    })
    await openOriginalTools(page)
    await page.locator('.original-review > summary').click()
    await page.getByRole('button', { name: '校正原文与同步点', exact: true }).first().click()
    await page.getByRole('button', { name: '保留空缺', exact: true }).click()
    await expect.poll(async () => (await getOriginal()).alignment?.revision).toBe(2)
    await page.getByRole('button', { name: '重新匹配这一集', exact: true }).click()
    await expect.poll(async () => (await getOriginal()).alignment?.revision).toBe(3)
    expect((await getOriginal()).alignment?.matches[0]?.selected).toBeNull()
    const beforeEpub = await getOriginal(),
      epubFile = join(root, '原文.epub')
    writeFileSync(epubFile, zip(epub))
    await choose(epubFile)
    await openOriginalTools(page, '原文来源')
    await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
    await waitForOriginalReady(page)
    await openOriginalTools(page, '原文来源')
    await expect(page.locator('.original-summary')).toContainText('EPUB')
    const importedEpub = await getOriginal()
    expect(importedEpub.info?.id).not.toBe(beforeEpub.info?.id)
    expect(importedEpub.alignment?.matches.every((match) => !match.selected) ?? true).toBe(true)
    await closeOriginalPanel(page)
    await expect(page.getByText('这是阅读顺序中的第一段正文。', { exact: true })).toBeVisible()
    await expect(page.getByText('危险脚本不会成为正文。', { exact: true })).toHaveCount(0)
    await choose(original)
    await openOriginalTools(page, '原文来源')
    await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
    await waitForOriginalReady(page)
    await openOriginalTools(page, '原文来源')
    await expect(page.locator('.original-summary')).toContainText('TXT')
    expect((await getOriginal()).alignment).toEqual(beforeEpub.alignment)
    await choose(invalid)
    await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('控制字符')
    expect((await getOriginal()).info?.id).toBe(before.info?.id)
    await closeOriginalPanel(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('original-reading-small.png') })
    const reviewed = await getOriginal()
    await app.close()
    app = await electron.launch({ args: [appRoot], env })
    page = await app.firstWindow()
    expect((await getOriginal()).alignment).toEqual(reviewed.alignment)
    const persisted = await page.evaluate((input) => window.desktop.getTranscript(input), target)
    expect(
      persisted.ok && persisted.value.status === 'ready'
        ? persisted.value.transcript.document
        : null,
    ).toEqual(document)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
