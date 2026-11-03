import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CHANNELS } from '../../src/shared/contracts'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { menuAction } from '../helpers/ui'

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

async function choose(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, path)
}

for (const failure of ['result', 'rejection'] as const) {
  test(`ebook shelf recovers in place after its first ${failure} without remaining in loading`, async () => {
    const root = mkdtempSync(join(tmpdir(), '听读书架原位重试 ')),
      file = join(root, '重试后阅读.txt'),
      app = await launch(root)
    writeFileSync(file, '第1章 清晨\n清晨的阳光照进了窗户。\n今天继续阅读。')
    try {
      const page = await app.firstWindow(),
        errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      // Only this isolated app's first list response fails. Subsequent calls run
      // the original guarded IPC handler and real SQLite reading store.
      await app.evaluate(
        ({ ipcMain }, { channel, failure }) => {
          const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
              string,
              (...args: unknown[]) => unknown
            >,
            original = handlers.get(channel)
          if (!original) throw new Error('Reading list handler unavailable')
          let first = true
          handlers.set(channel, (...args) => {
            if (!first) return original(...args)
            first = false
            if (failure === 'rejection') throw new Error('Controlled reading-list rejection')
            return {
              ok: false,
              error: { code: 'INTERNAL', message: '测试书架暂时不可用，请重新加载。' },
            }
          })
        },
        { channel: CHANNELS.readingSummaries, failure },
      )
      await page.getByRole('button', { name: '电子书', exact: true }).click()
      const shelf = page.getByRole('region', { name: '正常阅读', exact: true })
      await expect(shelf.getByRole('alert')).toContainText(
        failure === 'result' ? '测试书架暂时不可用' : '无法读取电子书书架',
      )
      await expect(shelf.getByText('正在加载阅读书架…', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '导入电子书', exact: true })).toBeDisabled()
      const retry = shelf.getByRole('button', { name: '重新加载书架', exact: true })
      await retry.focus()
      await retry.press('Enter')
      await expect(shelf.getByText('开始读一本书', { exact: true })).toBeVisible()
      await expect(shelf.getByRole('alert')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '导入电子书', exact: true })).toBeEnabled()
      await choose(app, file)
      await page.getByRole('button', { name: '导入电子书', exact: true }).click()
      await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toHaveAttribute(
        'aria-busy',
        'false',
      )
      await expect(page.locator('.book-viewport')).toContainText('清晨的阳光照进了窗户。')
      expect(errors).toEqual([])
    } finally {
      await closeOwnedElectron(app)
    }
  })
}

test('a late reading shelf response cannot replace the newer shelf after navigation', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读书架迟到响应 ')),
    file = join(root, '新书架内容.txt'),
    app = await launch(root)
  writeFileSync(file, '第1章 山路\n少年沿着山路前进。')
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Delay delivery of the real, initially empty list. The later import and
    // second list request use the unmodified IPC/SQLite implementation.
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => unknown
        >,
        original = handlers.get(channel)
      if (!original) throw new Error('Reading list handler unavailable')
      let first = true
      handlers.set(channel, async (...args) => {
        const result = await original(...args)
        if (!first) return result
        first = false
        await new Promise<void>((resolve) => {
          Reflect.set(globalThis, 'releaseOldReadingList', resolve)
        })
        return result
      })
    }, CHANNELS.readingSummaries)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await expect(page.getByText('正在加载阅读书架…', { exact: true })).toBeVisible()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseOldReadingList')))
      .toBe('function')
    await page.getByRole('button', { name: '有声书', exact: true }).click()
    await choose(app, file)
    const imported = await page.evaluate(() => window.desktop.importReadingBook())
    expect(imported.ok && !imported.value.canceled).toBe(true)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    const shelf = page.getByRole('region', { name: '正常阅读', exact: true })
    await expect(shelf.getByRole('button', { name: '阅读 新书架内容', exact: true })).toBeVisible()
    await app.evaluate(() => {
      const release = Reflect.get(globalThis, 'releaseOldReadingList') as () => void
      release()
      Reflect.deleteProperty(globalThis, 'releaseOldReadingList')
    })
    // Cross an IPC and two paint opportunities after releasing the old reply.
    await page.evaluate(async () => {
      await window.desktop.getReadingBooks()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    await expect(shelf.getByRole('button', { name: '阅读 新书架内容', exact: true })).toBeVisible()
    await expect(shelf.getByText('开始读一本书', { exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await app
      .evaluate(() => {
        const release = Reflect.get(globalThis, 'releaseOldReadingList') as (() => void) | undefined
        release?.()
      })
      .catch(() => undefined)
    await closeOwnedElectron(app)
  }
})

test('player keyboard seeking moves five seconds, clamps endpoints and preserves millisecond progress', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读进度键盘 '))
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await choose(app, resolve('tests/fixtures/tone.mp3'))
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    let progress = page.getByRole('slider', { name: '播放进度', exact: true })
    await progress.fill('11234')
    await expect(progress).toHaveAttribute('step', '1')
    await progress.press('ArrowRight')
    await expect(progress).toHaveValue('16234')
    await expect(progress).toHaveAttribute('aria-valuetext', /已播放 00:16，总时长 00:20/)
    await progress.press('ArrowLeft')
    await expect(progress).toHaveValue('11234')
    await progress.press('ArrowUp')
    await expect(progress).toHaveValue('16234')
    await progress.press('ArrowDown')
    await expect(progress).toHaveValue('11234')
    await progress.press('Home')
    await expect(progress).toHaveValue('0')
    await progress.press('ArrowLeft')
    await expect(progress).toHaveValue('0')
    await progress.press('End')
    expect(Number(await progress.inputValue())).toBeCloseTo(
      Number(await progress.getAttribute('max')),
      0,
    )
    await progress.press('ArrowRight')
    expect(Number(await progress.inputValue())).toBeCloseTo(
      Number(await progress.getAttribute('max')),
      0,
    )
    await progress.fill('11234')
    await progress.press('ArrowRight')
    await expect(progress).toHaveValue('16234')
    const closed = app.waitForEvent('close')
    await menuAction(page, '应用设置', '退出听见书页')
    await closed
    app = await launch(root)
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    progress = page.getByRole('slider', { name: '播放进度', exact: true })
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await expect(progress).toHaveValue('16234')
    const stored = await page.evaluate(() => window.desktop.getState())
    expect(stored.ok && stored.value.books[0]?.episodes[0]?.positionMs).toBeCloseTo(16234, 2)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})
