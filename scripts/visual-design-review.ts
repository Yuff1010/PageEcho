import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type Page } from '@playwright/test'
import { LibraryStore } from '../src/main/database'
import { scanBook } from '../src/main/files'
import { createDataPaths } from '../src/main/paths'
import {
  closeCompanionPanel,
  leaveCompanionPage,
  menuAction,
  openCompanionProofreading,
  openCompanionSettings,
  openCompanionTools,
  openTranscriptImport,
} from '../tests/helpers/ui'

// Run after `npm run build`. Every file and database mutation belongs to this
// temporary fixture; no existing user library, component, or media is touched.
const directory = resolve(
  'cache/visual-design-review',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), '听读 视觉验收 '))
const store = new LibraryStore(createDataPaths(userData).database)
store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
const episode = store.listBooks()[0]!.episodes[0]!
store.saveProgress({
  sessionId: '',
  episodeId: episode.id,
  positionMs: 2000,
  durationMs: 16360,
  rate: 1,
  volume: 1,
})
store.close()
const longTranscript = join(userData, '伴读长文稿.json')
const passages = [
  '清晨的风穿过树梢，窗前的书页轻轻翻动。',
  '她把茶杯放在桌角，望着山路尽头渐渐亮起的天空。',
  '昨夜的一场雨洗净了石阶，远处有人沿着小路慢慢走来。',
  '那封未写完的信还夹在书中，字迹里藏着许多平常而温柔的日子。',
  '他停下脚步，听见溪水绕过石头，也听见村庄里传来的第一声问候。',
  '故事就从这样一个早晨继续，带着新鲜的空气和一盏尚未熄灭的灯。',
]
await writeFile(
  longTranscript,
  JSON.stringify({
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 16000 }],
    segments: Array.from({ length: 60 }, (_, index) => ({
      id: `visual-s${index}`,
      startMs: index * 250,
      endMs: index * 250 + 240,
      text: passages[index % passages.length],
    })),
  }),
)
const readingFile = join(userData, '山间来信.txt')
await writeFile(
  readingFile,
  [
    '第一章 山间的清晨',
    ...Array.from(
      { length: 70 },
      (_, index) =>
        `第${index + 1}封信写于山间。清晨的风穿过树梢，书页在桌上缓缓翻动。我们在这里阅读，也在这里记下每一个平常的日子。`,
    ),
  ].join('\n\n'),
)
const env = { ...process.env, RALB_USER_DATA: userData }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
const appRoot = resolve(process.env.RALB_APP_ROOT ?? '.')
const manifestPath = resolve(appRoot, '../manifest.json')
let buildIdentity: { previewVersion: string; manifestPath: string; manifestSha256: string } | null =
  null
try {
  const bytes = await readFile(manifestPath)
  const manifest = JSON.parse(bytes.toString('utf8')) as {
    previewVersion: string
    outputHashes: Record<string, string>
  }
  for (const [path, expected] of Object.entries(manifest.outputHashes))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(appRoot, 'out', path)))
        .digest('hex'),
      expected,
    )
  buildIdentity = {
    previewVersion: manifest.previewVersion,
    manifestPath,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const app = await electron.launch({ args: [appRoot], env })
const errors: string[] = []
const captures: Record<string, unknown>[] = []

async function audit(page: Page, name: string) {
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
  const metrics = await page.evaluate(() => {
    const shown = (node: Element) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        !node.closest('[hidden], details:not([open]) > :not(summary)')
      )
    }
    const smallText = Array.from(document.querySelectorAll('body *'))
      .filter(
        (node) =>
          shown(node) &&
          Array.from(node.childNodes).some(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
          ) &&
          parseFloat(getComputedStyle(node).fontSize) < 13,
      )
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute('class'),
        text: node.textContent?.trim().slice(0, 75),
        size: getComputedStyle(node).fontSize,
        decorative: Boolean(node.closest('.book-cover, svg')),
      }))
    const controlMetrics = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), summary, input:not([type="range"]):not([type="checkbox"]):not(:disabled)',
      ),
    )
      .filter(shown)
      .map((node) => ({
        name: node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 40),
        size: parseFloat(getComputedStyle(node).fontSize),
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      }))
    const color = (variable: string) => {
      const sample = document.createElement('span')
      sample.style.color = `var(${variable})`
      document.body.append(sample)
      const resolved = getComputedStyle(sample).color
      sample.remove()
      return resolved
    }
    const luminance = (value: string) => {
      const channels = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
      const linear = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
    }
    const contrast = (foreground: string, background: string) => {
      const a = luminance(color(foreground))
      const b = luminance(color(background))
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
    }
    const ratios = ['--ui-text', '--ui-muted'].flatMap((foreground) =>
      ['--ui-bg', '--ui-panel', '--ui-field'].map((background) => ({
        foreground,
        background,
        ratio: contrast(foreground, background),
      })),
    )
    return {
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      smallText,
      controlMetrics,
      ratios,
    }
  })
  captures.push({ name, ...metrics })
  assert.equal(metrics.horizontalOverflow, false, `${name}: document overflows horizontally`)
  assert.ok(
    metrics.ratios.every((entry) => entry.ratio >= 4.5),
    `${name}: shared foreground tokens must achieve 4.5:1 contrast`,
  )
  assert.ok(
    metrics.smallText.every((entry) => entry.decorative),
    `${name}: ordinary auxiliary text must be at least 13px`,
  )
  assert.ok(
    metrics.controlMetrics.every((entry) => entry.size >= 14),
    `${name}: interactive controls must be at least 14px`,
  )
}

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  // tsx preserves nested function names with this helper when serializing an
  // evaluate callback; the isolated browser world does not otherwise define it.
  await page.evaluate('globalThis.__name = (value) => value')
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '伴读阅读', exact: true })).toBeVisible()
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      localStorage.setItem('ralb:app:theme:v1', theme)
      window.dispatchEvent(new Event('ralb:app-theme'))
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
    for (const [width, height] of [
      [1366, 900],
      [1024, 768],
    ] as const) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height)
        },
        { width, height },
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      await expect.poll(() => page.evaluate(() => innerHeight)).toBe(height)
      const prefix = `${theme}-${width}x${height}`
      await page.getByRole('button', { name: /我的书架/ }).click()
      await audit(page, `${prefix}-library`)
      await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
      await expect(page.getByRole('region', { name: '同步伴读', exact: true })).toBeVisible()
      if (theme === 'dark' && width === 1366) {
        await audit(page, `${prefix}-companion-empty`)
        await app.evaluate(({ dialog }, file) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
        }, longTranscript)
        await openTranscriptImport(page)
        await page.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
        await expect(page.locator('.transcript-sentence')).toHaveCount(60)
        await page.locator('.transcript-import').evaluate((node: HTMLDetailsElement) => {
          node.open = false
        })
        await expect(page.locator('.transcript-import')).not.toHaveAttribute('open')
      }
      await closeCompanionPanel(page)
      await openCompanionSettings(page)
      await page
        .getByRole('combobox', { name: '文稿主题', exact: true })
        .selectOption(theme === 'dark' ? 'dark' : 'paper')
      await closeCompanionPanel(page)
      await expect(page.locator('.companion-drawer:visible')).toHaveCount(0)
      await expect(page.locator('.sentence-number:visible')).toHaveCount(0)
      await expect(page.locator('.sentence-actions:visible')).toHaveCount(0)
      await expect(page.locator('.transcription-controls:visible')).toHaveCount(0)
      const documentMetrics = await page.locator('.transcript-viewport').evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom }
      })
      assert.ok(
        documentMetrics.height >= height * 0.6,
        `${prefix}: the document must occupy most of the reading page`,
      )
      assert.ok(documentMetrics.top <= 130, `${prefix}: prose starts near the top of the page`)
      await audit(page, `${prefix}-companion`)
      const beforeDrawer = await page
        .locator('.transcript-segments')
        .evaluate((node) => node.getBoundingClientRect().width)
      await openCompanionSettings(page)
      const afterDrawer = await page
        .locator('.transcript-segments')
        .evaluate((node) => node.getBoundingClientRect().width)
      assert.ok(
        Math.abs(afterDrawer - beforeDrawer) <= 1,
        `${prefix}: settings overlay must not reflow prose`,
      )
      await audit(page, `${prefix}-companion-preferences`)
      await closeCompanionPanel(page)
      await openCompanionTools(page)
      await audit(page, `${prefix}-companion-tools`)
      await closeCompanionPanel(page)
      if (theme === 'light' && width === 1366) {
        await openCompanionProofreading(page)
        await expect(page.locator('.sentence-actions:visible').first()).toBeVisible()
        await audit(page, `${prefix}-companion-proofreading`)
        await openCompanionTools(page)
        await page.getByRole('checkbox', { name: '校对与标注模式', exact: true }).uncheck()
        await closeCompanionPanel(page)
      }
      await leaveCompanionPage(page)
      await menuAction(page, '应用设置', '缓存与任务')
      const dialog = page.getByRole('dialog', { name: '缓存与任务', exact: true })
      await expect(dialog).toBeVisible()
      await audit(page, `${prefix}-settings`)
      const close = dialog.getByRole('button', { name: '关闭缓存与任务', exact: true })
      await page.keyboard.press('Tab')
      await close.focus()
      const focus = await close.evaluate((node) => {
        const style = getComputedStyle(node)
        return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
      })
      assert.notEqual(focus.outlineStyle, 'none', `${prefix}: keyboard focus must be visible`)
      assert.notEqual(focus.outlineWidth, '0px', `${prefix}: keyboard focus must be visible`)
      await close.click()
      await page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('button', { name: '字幕与伴读', exact: true })
        .click()
      const listening = page.getByRole('dialog', { name: '收听工具', exact: true })
      await expect(listening).toBeVisible()
      await audit(page, `${prefix}-listening-tools`)
      await listening.getByRole('button', { name: '字幕与缓存', exact: true }).click()
      await audit(page, `${prefix}-subtitle-settings`)
      await listening.getByRole('button', { name: '关闭收听工具', exact: true }).click()
      await page.getByRole('button', { name: '在线书源', exact: true }).click()
      await expect(page.getByRole('searchbox', { name: '搜索书籍', exact: true })).toBeVisible()
      await audit(page, `${prefix}-online-source`)
    }
  }
  await page.getByRole('button', { name: '我的书架', exact: true }).click()
  const library = await page.evaluate(() => window.desktop.getState())
  assert.ok(library.ok)
  const title = library.value.books[0]!.title
  await menuAction(page, `更多 ${title} 的操作`, `移除 ${title} 的记录`)
  const confirmation = page.getByRole('dialog', { name: '确认移除书籍', exact: true })
  const keep = confirmation.getByRole('button', { name: '保留这本书', exact: true })
  const remove = confirmation.getByRole('button', { name: '确认移除记录', exact: true })
  await expect(keep).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(remove).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(keep).toBeFocused()
  await audit(page, 'light-1024x768-removal-confirmation')
  await app
    .browserWindow(page)
    .then((window) => window.evaluate((window) => window.setSize(720, 600)))
  await audit(page, 'light-720x600-removal-confirmation')
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: `更多 ${title} 的操作`, exact: true }),
  ).toBeFocused()
  await app
    .browserWindow(page)
    .then((window) => window.evaluate((window) => window.setSize(1024, 768)))
  // Import an ordinary local text through the actual native-dialog/IPC route.
  await page.getByRole('button', { name: '电子书', exact: true }).click()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, readingFile)
  await page.getByRole('button', { name: '导入电子书', exact: true }).click()
  await expect(page.getByRole('main', { name: '独立阅读页', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await audit(page, 'light-1024x768-ebook-preferences')
  assert.deepEqual(errors, [], 'No renderer errors')
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(
      { status: 'passed', appRoot, buildIdentity, userData, captures, errors },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify({ status: 'passed', directory, captures: captures.length }))
} catch (error) {
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(
      {
        status: 'failed',
        appRoot,
        buildIdentity,
        userData,
        captures,
        errors,
        error: String(error),
      },
      null,
      2,
    ) + '\n',
  )
  throw error
} finally {
  await app.close()
}
