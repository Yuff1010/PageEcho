import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { closeOriginalPanel, menuAction, openOriginalTools, useOriginalText } from '../helpers/ui'
import type { TranscriptDocument, TranscriptRequest } from '../../src/shared/transcript'

const texts = [
  '少年将整齐的衣服收进旅行用的布袋。',
  '他把旧地图折好，小心放进身后的背包。',
  '山谷中的钟声渐渐远去，路上只剩下清风和明月。',
  '第二天清晨，他们沿着河岸走向远方的村庄。',
  '村口的大树下坐着一位沉默不语的老人。',
]
let appRoot: string
test.skip(
  !!process.env.RALB_EXECUTABLE,
  'Uses a disposable preview copy; never rewrites a packaged runtime.',
)
test.beforeAll(() => {
  if (process.env.RALB_EXECUTABLE) return
  appRoot = mkdtempSync(join(tmpdir(), '听读 自动原文 应用 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'original-incremental-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  // The original matching worker is the built production implementation. Delay
  // only explicit manual matches to make a late response after switching reproducible.
  const directory = join(appRoot, 'out', 'main')
  renameSync(join(directory, 'original-worker.js'), join(directory, 'original-implementation.js'))
  writeFileSync(
    join(directory, 'original-worker.js'),
    `import { workerData } from 'node:worker_threads';
if (workerData?.kind === 'match') await new Promise((resolve) => setTimeout(resolve, 700));
await import('./original-implementation.js');\n`,
  )
})

test('automatic delta matching refreshes original view without changing transcript revision, keeps drafts/manual timing, and ignores a late old-episode response', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), '听读 自动原文 数据 ')),
    audio = join(root, 'audio')
  mkdirSync(audio)
  for (const name of ['第1集.wav', '第2集.wav'])
    copyFileSync(resolve('tests/fixtures/第32集-伴读样本.wav'), join(audio, name))
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(audio, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
  const target = (index = 0): TranscriptRequest => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
  })
  const document = (count: number, second = false): TranscriptDocument => ({
    version: 1,
    kind: 'transcript',
    audioHash: target(second ? 1 : 0).audioHash,
    coverage: [{ startMs: 0, endMs: 16000 }],
    segments: Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      startMs: i * 4000 + 1000,
      endMs: i * 4000 + 1900,
      text: texts[second ? 4 : i]!,
    })),
  })
  store.saveTranscript(target().episodeId, document(1))
  store.saveTranscript(target(1).episodeId, document(1, true))
  store.close()
  const original = join(root, '原文.txt'),
    json = join(root, '新增片段.json')
  writeFileSync(original, '第一章 山路\n' + texts.join('\n'))
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  let app: ElectronApplication = await electron.launch({ args: [appRoot], env })
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const choose = (path: string) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      }, path)
    const transcript = async () => {
      const result = await page.evaluate((input) => window.desktop.getTranscript(input), target())
      if (!result.ok || result.value.status !== 'ready') throw new Error('missing transcript')
      return result.value.transcript
    }
    const getOriginal = async (index = 0) => {
      const result = await page.evaluate(
        (input) => window.desktop.getOriginalState(input),
        target(index),
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    const append = async (count: number, regroupFirst = false) => {
      const next = document(count)
      if (regroupFirst)
        next.segments[0] = {
          ...next.segments[0]!,
          id: 'regrouped-first',
          text: texts[0]!.replace('整齐', '整理'),
        }
      writeFileSync(json, JSON.stringify(next))
      await choose(json)
      const result = await page.evaluate(
        (input) => window.desktop.importTranscript(input),
        target(),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)
    }
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await useOriginalText(page)
    const revision = (await transcript()).revision
    await choose(original)
    await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
    await expect(page.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.original-sentence').first()).toBeVisible()
    await openOriginalTools(page)
    // No explicit original-state polling: the automatic worker completion event
    // must refresh this view after the import's original snapshot has returned.
    await expect(page.locator('.original-review > summary')).toContainText(/1\s*\/\s*1/)
    expect((await transcript()).revision).toBe(revision)
    await page.locator('.original-review > summary').click()
    await page.getByRole('button', { name: '校正原文与同步点', exact: true }).first().click()
    await page.getByLabel('起始秒', { exact: true }).fill('1.125')
    await page.getByLabel('结束秒', { exact: true }).fill('1.8')
    const draft = '绝对没有的原文草稿'
    await page.getByLabel('查找原文', { exact: true }).fill(draft)
    await page.getByRole('button', { name: '查找', exact: true }).click()
    await expect(page.locator('.original-editor [role="alert"]')).toContainText('没有找到该文字')
    await append(2)
    await expect(page.locator('.original-review > summary')).toContainText(/2\s*\/\s*2/)
    await expect(page.getByLabel('起始秒', { exact: true })).toHaveValue('1.125')
    await expect(page.getByLabel('查找原文', { exact: true })).toHaveValue(draft)
    await expect(page.locator('.original-editor [role="alert"]')).toContainText('没有找到该文字')
    await page.getByRole('button', { name: '保存原文校正', exact: true }).click()
    await expect(page.locator('.original-editor')).toHaveCount(0)
    const corrected = await getOriginal()
    expect(corrected.alignment?.matches[0]?.startMs).toBe(1125)
    expect(corrected.alignment?.matches[0]?.reviewed).toBe(true)
    await append(3)
    const latestTranscriptRevision = (await transcript()).revision
    await expect(page.locator('.original-review > summary')).toContainText(/3\s*\/\s*3/)
    expect((await transcript()).revision).toBe(latestTranscriptRevision)
    await append(3, true)
    await expect(page.locator('.original-review')).toContainText(
      '识别片段已变化，现保留此前人工校正',
    )
    const retained = page.locator('.original-review article').first()
    await expect(retained).toContainText('人工映射到原文')
    await expect(
      retained.getByRole('button', { name: '校正原文与同步点', exact: true }),
    ).toBeEnabled()
    await retained.getByRole('button', { name: '1.13 秒', exact: true }).click()
    await closeOriginalPanel(page)
    await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
    await expect(page.locator('.original-reading-status')).toContainText('跟随播放')
    const beforeSwitch = await getOriginal()
    expect(beforeSwitch.alignment?.matches[0]?.startMs).toBe(1125)
    expect(beforeSwitch.alignment?.matches[0]?.sourceState).toBe('retained')
    expect(
      await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(true)
    await page.screenshot({
      path: info.outputPath('automatic-original-preserved-correction.png'),
      animations: 'disabled',
    })
    await openOriginalTools(page)
    await page.getByRole('button', { name: '重新匹配这一集', exact: true }).click()
    await closeOriginalPanel(page)
    await menuAction(page, '播放选项', '下一集')
    await expect(page.locator('.player-heading h2')).toHaveText(episodes[1]!.title)
    expect(
      await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(true)
    await useOriginalText(page)
    await openOriginalTools(page)
    await expect(page.locator('.original-review > summary')).toContainText(/1\s*\/\s*1/)
    await page.locator('.original-review > summary').click()
    await page.getByRole('button', { name: '校正原文与同步点', exact: true }).click()
    await page.getByLabel('查找原文', { exact: true }).fill('第二集未提交的草稿')
    await expect
      .poll(async () => (await getOriginal()).alignment?.revision ?? 0)
      .toBeGreaterThan(beforeSwitch.alignment!.revision)
    await expect(page.getByLabel('查找原文', { exact: true })).toHaveValue('第二集未提交的草稿')
    expect((await getOriginal(1)).alignment?.matches[0]?.selected?.first).toBe(4)
    await expect(page.locator('.original-review > summary')).toContainText(/1\s*\/\s*1/)
    const savedSecond = await getOriginal(1)
    await app.close()
    app = await electron.launch({ args: [appRoot], env })
    page = await app.firstWindow()
    expect((await getOriginal(1)).alignment).toEqual(savedSecond.alignment)
    expect(errors).toEqual([])
    expect(readFileSync(original, 'utf8')).toContain(texts[0]!)
  } finally {
    await app.close()
  }
})
