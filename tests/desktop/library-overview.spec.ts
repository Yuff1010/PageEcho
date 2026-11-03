import { test, expect, _electron as electron } from '@playwright/test'
import { linkSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { parseOriginal } from '../../src/main/original/parse'
import { CHANNELS } from '../../src/shared/contracts'
import { closeOwnedElectron } from '../model/electron-lifecycle'

test('bounded shelves and chapters preserve playing context outside the page, across chapter 100 and restart', async ({}, info) => {
  test.setTimeout(120000)
  const root = mkdtempSync(join(tmpdir(), 'pageecho bounded shelves '))
  const paths = createDataPaths(root)
  const store = new LibraryStore(paths.database)
  const wav = Buffer.alloc(44 + 120 * 16000)
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
  const media = join(root, 'synthetic.wav')
  writeFileSync(media, wav)
  const metadata = statSync(media),
    hash = createHash('sha256').update(wav).digest('hex')
  let longBook = '',
    longEpisodes: string[] = []
  for (let index = 0; index < 128; index++) {
    const id = randomUUID(),
      count = index === 127 ? 105 : 1
    const directory = join(root, `书${index}`)
    mkdirSync(directory)
    const episodes = Array.from({ length: count }, (_, ordinal) => {
      const path = join(directory, `第${ordinal + 1}集.wav`)
      linkSync(media, path)
      return {
        id: randomUUID(),
        name: `第${ordinal + 1}集`,
        path,
        sizeBytes: metadata.size,
        modifiedAt: statSync(path).mtimeMs,
        contentHash: hash,
      }
    })
    store.importBook({
      id,
      title: index === 127 ? '分页连播合成书' : `合成书${String(index).padStart(3, '0')}`,
      sourcePath: directory,
      kind: 'folder',
      episodes,
    })
    store.setSubtitlePreparation(id, {
      mode: 'manual',
      engine: 'whisperx',
      device: 'cpu',
      prepareNext: false,
    })
    if (index === 127) {
      longBook = id
      longEpisodes = episodes.map((value) => value.id)
    }
    store.reading.import(
      parseOriginal(
        Buffer.from(`第1章 清晨\n这是合成电子书第${index}本。`),
        `合成电子书${index}.txt`,
      ),
    )
  }
  store.close()
  const environment = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(environment, 'ELECTRON_RUN_AS_NODE')
  const launch = () =>
    electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env: environment })
  let app = await launch()
  const errors: string[] = []
  try {
    let page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.locator('.bookshelf .book-card')).toHaveCount(100)
    await app.evaluate(
      ({ ipcMain }, channels) => {
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => unknown
        >
        const blocked: string[] = [],
          requests: unknown[] = []
        Reflect.set(globalThis, 'boundedBlocked', blocked)
        Reflect.set(globalThis, 'boundedPages', requests)
        for (const channel of [channels.state, channels.detail, channels.reading])
          handlers.set(channel, () => {
            blocked.push(channel)
            return {
              ok: false,
              error: { code: 'INTERNAL', message: 'Unexpected full-library read' },
            }
          })
        const pages = handlers.get(channels.pages)!
        handlers.set(channels.pages, (...args) => {
          requests.push(args[1])
          return pages(...args)
        })
      },
      {
        state: CHANNELS.getState,
        detail: CHANNELS.bookDetail,
        reading: CHANNELS.readingList,
        pages: CHANNELS.bookEpisodes,
      },
    )
    await page.reload()
    await expect(page.locator('.bookshelf .book-card')).toHaveCount(100)
    const overview = await page.evaluate(() => window.desktop.getLibraryOverview())
    expect(overview.ok && overview.value.books).toHaveLength(128)
    expect(overview.ok && overview.value.books.every((book) => !('episodes' in book))).toBe(true)
    const card = page
      .locator('.book-card')
      .filter({ has: page.getByRole('heading', { name: '分页连播合成书', exact: true }) })
    await card.getByRole('button', { name: '继续播放', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect
      .poll(() => audio.evaluate((node: HTMLAudioElement) => !node.paused && node.currentTime > 0))
      .toBe(true)
    const original = await audio.evaluate((node: HTMLAudioElement) => {
      node.dataset.overviewIntegrity = 'same-native-node'
      return node.src
    })
    await page.getByRole('button', { name: '有声书书架分页下一页', exact: true }).click()
    await expect(page.locator('.bookshelf .book-card')).toHaveCount(28)
    expect(await page.getByRole('heading', { name: '分页连播合成书', exact: true }).count()).toBe(0)
    expect(await audio.getAttribute('data-overview-integrity')).toBe('same-native-node')
    expect(await audio.evaluate((node: HTMLAudioElement) => node.src)).toBe(original)
    expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(false)
    await page
      .getByRole('navigation', { name: '书籍类型', exact: true })
      .getByRole('button', { name: '电子书', exact: true })
      .click()
    await expect(page.locator('.ebook-shelf .book-card')).toHaveCount(100)
    await page.getByRole('button', { name: '电子书书架分页下一页', exact: true }).click()
    await expect(page.locator('.ebook-shelf .book-card')).toHaveCount(28)
    expect(await audio.evaluate((node: HTMLAudioElement) => node.src)).toBe(original)
    // Use the route format owned by app-navigation rather than depend on guessed URLs.
    const { appRouteHash } = await import('../../src/renderer/src/app-navigation')
    await page.evaluate(
      (hash) => {
        window.location.hash = hash
      },
      appRouteHash({ view: 'chapters', bookId: longBook }),
    )
    await expect(
      page.getByRole('region', { name: '章节目录', exact: true }).locator('.episode-list > li'),
    ).toHaveCount(100)
    await page.getByRole('button', { name: '下一页章节', exact: true }).click()
    await expect(page.locator('.episode-list > li')).toHaveCount(5)
    await page.getByRole('button', { name: '上一页章节', exact: true }).click()
    await expect(page.locator('.episode-list > li')).toHaveCount(100)
    await page.locator('.episode-list > li').nth(99).getByRole('button').click()
    await expect
      .poll(async () => {
        const context = await page.evaluate(
          (id) => window.desktop.getPlaybackContext({ episodeId: id }),
          longEpisodes[99]!,
        )
        return context.ok ? context.value?.nextEpisodeId : null
      })
      .toBe(longEpisodes[100])
    await expect(page.locator('.episode-list > li.current')).toContainText('第100集')
    await audio.evaluate(async (node: HTMLAudioElement) => {
      node.currentTime = node.duration - 0.03
      await node.play()
    })
    await expect(page.locator('.player-panel')).toContainText('第101集')
    await expect
      .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime > 0 && !node.paused))
      .toBe(true)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('5000')
    await expect
      .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
      .toBeGreaterThanOrEqual(4.5)
    await page.locator('.play-button').click()
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true)
    await page.screenshot({ path: info.outputPath('bounded-chapters-playing.png') })
    const checks = await app.evaluate(() => ({
      blocked: Reflect.get(globalThis, 'boundedBlocked') as string[],
      pages: Reflect.get(globalThis, 'boundedPages') as { limit: number }[],
    }))
    expect(checks.blocked).toEqual([])
    expect(checks.pages.length).toBeGreaterThan(1)
    expect(checks.pages.every((value) => value.limit <= 100)).toBe(true)
    await closeOwnedElectron(app)
    app = await launch()
    page = await app.firstWindow()
    await expect(page.locator('.player-panel')).toContainText('第101集')
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})
