import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import type { Ting13Document } from '../../src/main/sources/ting13-dom'

// Compile the production isolated-world reader without the tsx instrumentation
// helpers, exactly as its Electron build does. No website code is evaluated.
const readerCode =
  ts
    .transpileModule(readFileSync('src/main/sources/ting13-dom.ts', 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/^export /gm, '') + '\nreadTing13Document()'

test('Ting13 DOM extraction binds sibling search covers to the matching book without loading details', async () => {
  const env = { ...process.env, RALB_USER_DATA: mkdtempSync(join(tmpdir(), '听读搜索封面结构 ')) }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
  try {
    await app.firstWindow()
    const card = (id: number, image: string, inline = '') =>
      `<li>${image}<dl class="list-works-dl"><dt class="list-book-dt"><a href="/youshengxiaoshuo/${id}/">合成书${id}</a></dt><dd class="list-book-des">合成简介</dd>${inline}</dl></li>`
    const html = `<title>“合成”相关搜索结果</title><ul>
      ${card(101, '<div class="list-imgbox"><a class="thumb" href="/youshengxiaoshuo/101/"><img data-original="https://image.itingshu.net/cover/one.gif" src="/placeholder.gif"></a></div>')}
      ${card(102, '<a href="/youshengxiaoshuo/999/"><img src="https://image.itingshu.net/unrelated.gif"></a><a class="thumb" href="https://www.ting13.cc/youshengxiaoshuo/102/"><img data-src="/covers/two.jpg" src="data:image/gif;base64,placeholder"></a>')}
      ${card(103, '', '<img data-lazy-src="https://image.itingshu.net/cover/three.jpg" src="/placeholder.gif">')}
      ${card(104, '<a href="/youshengxiaoshuo/999/"><img src="https://image.itingshu.net/unrelated.gif"></a>')}
      ${card(105, '<a href="/youshengxiaoshuo/105/"><img data-original="javascript:alert(1)" src="https://image.itingshu.net/cover/five.jpg"></a>')}
      ${card(106, '<a href="/youshengxiaoshuo/106/"><img src="data:image/gif;base64,placeholder"></a>')}
    </ul><div class="book-info"><h1 class="book-title">合成书详情</h1></div><div class="book-img"><img data-src="/covers/detail.jpg" src="data:image/gif;base64,placeholder"></div>`
    const result = await app.evaluate(
      async ({ BrowserWindow, session }, input) => {
        const isolated = session.fromPartition('ting13-cover-dom-fixture')
        await isolated.protocol.handle(
          'https',
          () =>
            new Response(input.html, {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': "default-src 'none'",
              },
            }),
        )
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            session: isolated,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        })
        try {
          await window.loadURL('https://www.ting13.cc/novelsearch/search/result.html')
          return (await window.webContents.executeJavaScriptInIsolatedWorld(1001, [
            { code: input.code },
          ])) as Ting13Document
        } finally {
          window.destroy()
          await isolated.protocol.unhandle('https')
        }
      },
      { html, code: readerCode },
    )
    expect(result.searchResults.map((book) => book.coverUrl)).toEqual([
      'https://image.itingshu.net/cover/one.gif',
      '/covers/two.jpg',
      'https://image.itingshu.net/cover/three.jpg',
      null,
      'https://image.itingshu.net/cover/five.jpg',
      null,
    ])
    expect(result.searchResults.map((book) => book.url)).toEqual(
      [101, 102, 103, 104, 105, 106].map((id) => `/youshengxiaoshuo/${id}/`),
    )
    expect(result.book.coverUrl).toBe('/covers/detail.jpg')
  } finally {
    await closeOwnedElectron(app)
  }
})
