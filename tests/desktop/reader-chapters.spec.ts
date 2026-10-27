import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { zip, epub } from '../fixtures/original-epub'
import { closeOwnedElectron } from '../model/electron-lifecycle'

async function settings(page: Page) {
  await page.mouse.move(80, 15)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
}
async function titleGeometry(page: Page) {
  return page.locator('.book-viewport').evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      titles: Array.from(node.querySelectorAll('.ebook-chapter-title')).map((title) => {
        const r = title.getBoundingClientRect()
        return {
          left: r.left,
          top: r.top,
          bottom: r.bottom,
          breakBefore: getComputedStyle(title).breakBefore,
        }
      }),
    }
  })
}

for (const format of ['txt', 'epub'] as const) {
  test(`${format} chapters start at a fresh page in single and double columns, retain anchors, and flow normally in scroll mode`, async ({}, info) => {
    const root = mkdtempSync(join(tmpdir(), 'reader-chapters-'))
    const file = join(root, `分章阅读.${format}`)
    if (format === 'epub') writeFileSync(file, zip(epub))
    else
      writeFileSync(
        file,
        `第一章 雨后的车站\n雨停的时候，车站里只剩下最后一盏灯。\n林远将来信收入怀中，转身走向山间的小路。\n第二章 远行的清晨\n清晨的第一缕阳光越过群山，照亮了河岸边的旧书店。\n店主推开木门，开始等待今天的第一位客人。\n第三章 山海来信\n${Array.from({ length: 210 }, (_, i) => `第${i}阵风吹过树梢，旅人沿着河岸，继续寻找通往大海的路。`).join('\n')}`,
      )
    const env = { ...process.env, RALB_USER_DATA: root }
    Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
    const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, file)
      await page.getByRole('button', { name: '电子书', exact: true }).click()
      await page.getByRole('button', { name: '导入电子书', exact: true }).click()
      const viewport = page.locator('.book-viewport')
      await expect(viewport).toHaveAttribute('aria-busy', 'false')
      const initial = await titleGeometry(page)
      expect(initial.titles.length).toBeGreaterThanOrEqual(2)
      expect(initial.titles[0]!.left).toBeCloseTo(initial.left, 0)
      expect(initial.titles[0]!.top).toBeCloseTo(initial.top, 0)
      expect(initial.titles[1]!.left).toBeGreaterThan(initial.left + initial.width)
      for (const title of initial.titles) expect(title.top).toBeCloseTo(initial.top, 0)
      await viewport.press('ArrowRight')
      const next = await titleGeometry(page)
      expect(next.titles[1]!.left).toBeCloseTo(next.left, 0)
      expect(next.titles[1]!.top).toBeCloseTo(next.top, 0)
      const ordinal = format === 'txt' ? '2' : '1'
      await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', ordinal)
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.getAnimations().some((animation) => animation.playState === 'running'),
          ),
        )
        .toBe(false)
      await page.screenshot({ path: info.outputPath('chapter-new-page.png') })
      await viewport.press('ArrowLeft')
      await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '0')
      await settings(page)
      await page.getByRole('tab', { name: '翻页', exact: true }).click()
      await page.getByLabel('电子书页面布局', { exact: true }).selectOption('book')
      await page.keyboard.press('Escape')
      const spread = await titleGeometry(page)
      expect(spread.titles[0]!.left).toBeCloseTo(spread.left, 0)
      expect(spread.titles[1]!.left).toBeGreaterThan(spread.left + spread.width / 2)
      expect(spread.titles[1]!.left).toBeLessThan(spread.left + spread.width)
      for (const title of spread.titles) expect(title.top).toBeCloseTo(spread.top, 0)
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.getAnimations().some((animation) => animation.playState === 'running'),
          ),
        )
        .toBe(false)
      await page.screenshot({ path: info.outputPath('chapters-double-columns.png') })
      await viewport.press('Control+f')
      await page
        .getByLabel('全文搜索文字', { exact: true })
        .fill(format === 'txt' ? '清晨的第一缕阳光' : '第二段正文')
      await page.getByRole('button', { name: '搜索原文', exact: true }).click()
      await page.getByRole('list', { name: '全文搜索结果' }).getByRole('button').click()
      await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', ordinal)
      await expect(viewport.locator(`[data-sentence="${ordinal}"]`)).toBeInViewport()
      await page.reload()
      await expect(viewport).toHaveAttribute('aria-busy', 'false')
      await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', ordinal)
      await settings(page)
      await page.getByLabel('电子书字号', { exact: true }).fill('36')
      await page.keyboard.press('Escape')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
      await expect(viewport.locator(`[data-sentence="${ordinal}"]`)).toBeInViewport()
      const small = await titleGeometry(page)
      for (const title of small.titles) expect(title.top).toBeCloseTo(small.top, 0)
      await page.mouse.move(80, 15)
      await page.getByRole('button', { name: '打开目录', exact: true }).click()
      await page
        .getByRole('button', {
          name: format === 'txt' ? '第二章 远行的清晨' : '第2章 远方',
          exact: true,
        })
        .click()
      await expect(viewport.locator(`[data-sentence="${ordinal}"]`)).toBeInViewport()
      await settings(page)
      await page.getByLabel('电子书字号', { exact: true }).fill('20')
      await page.getByRole('tab', { name: '翻页', exact: true }).click()
      await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('scroll')
      await page.keyboard.press('Escape')
      await viewport.press('Control+Home')
      await expect(viewport).toHaveAttribute('aria-busy', 'false')
      const flowing = await titleGeometry(page)
      expect(flowing.titles[1]!.breakBefore).toBe('auto')
      expect(flowing.titles[1]!.left).toBeCloseTo(flowing.titles[0]!.left, 0)
      expect(flowing.titles[1]!.top).toBeGreaterThan(flowing.titles[0]!.bottom)
      expect(flowing.titles[1]!.top - flowing.top).toBeLessThan(
        await viewport.evaluate((node) => node.clientHeight),
      )
    } finally {
      await closeOwnedElectron(app)
    }
  })
}
