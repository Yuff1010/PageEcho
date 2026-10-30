import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test, { type TestContext } from 'node:test'
import { PluginRuntime } from '../../src/main/plugins/runtime'
import { SourceError } from '../../src/shared/sources'
import { syntheticCredentials, syntheticToken } from '../helpers/synthetic-auth'

async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const instance = createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  assert.ok(address && typeof address === 'object')
  t.after(async () => {
    instance.closeAllConnections()
    await new Promise<void>((resolve) => instance.close(() => resolve()))
  })
  return `http://127.0.0.1:${address.port}`
}

function runtime(t: TestContext) {
  const value = new PluginRuntime()
  t.after(() => value.close())
  return value
}
const signal = () => new AbortController().signal
const code = (expected: string) => (error: unknown) =>
  error instanceof SourceError && error.code === expected

test('QuickJS plugins register declared methods and cannot access Node, Electron, filesystem or ambient browser APIs', async (t) => {
  const value = runtime(t)
  const scripts = [
    `registerSource({ id: 'fixture', search() { return {
    process: typeof process, require: typeof require, fetch: typeof fetch,
    window: typeof window, document: typeof document,
    constructorEscape: this.host.getText.constructor('return typeof process')(),
    hostFrozen: Object.isFrozen(this.host)
  }; } }); registerSource({id:'second', getBook() { return {id:'2'}; }});`,
  ]
  assert.deepEqual(await value.inspect({ scripts, signal: signal() }), [
    { id: 'fixture', methods: ['search'] },
    { id: 'second', methods: ['getBook'] },
  ])
  assert.deepEqual(
    await value.execute({
      scripts,
      sourceId: 'fixture',
      method: 'search',
      args: [],
      allowedOrigins: [],
      signal: signal(),
    }),
    {
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      window: 'undefined',
      document: 'undefined',
      constructorEscape: 'undefined',
      hostFrozen: true,
    },
  )
  await assert.rejects(
    value.inspect({
      scripts: [`registerSource({id:'same'}); registerSource({id:'same'});`],
      signal: signal(),
    }),
    /重复注册/,
  )
  await assert.rejects(
    value.execute({
      scripts: [`registerSource({id:'async', search(){return Promise.resolve([])}})`],
      sourceId: 'async',
      method: 'search',
      args: [],
      allowedOrigins: [],
      signal: signal(),
    }),
    /同步返回/,
  )
  await assert.rejects(
    value.inspect({ scripts: ['require("node:fs").readFileSync("secret")'], signal: signal() }),
    code('SOURCE_CHANGED'),
  )
})

test('synchronous guest APIs bridge real bounded JSON, HTML selectors, relative URLs and POST requests through the host', async (t) => {
  const requests: string[] = []
  const origin = await server(t, (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers.cookie, undefined)
    if (req.url === '/search?q=fixture') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ title: '合成书籍', link: '/book/one' }))
    } else if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<html><a class="chapter" href="/chapter/1"><b>第一章</b></a><script>globalThis.executed = true</script></html>',
      )
    } else {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ body: Buffer.concat(chunks).toString('utf8') }))
      })
    }
  })
  const value = runtime(t)
  const scripts = [
    `registerSource({id:'fixture', search(query) {
    const data = this.host.getJson(${JSON.stringify(origin)} + '/search?q=' + encodeURIComponent(query));
    const html = this.host.getText(${JSON.stringify(origin)} + '/page');
    const chapter = this.host.select(html, 'a.chapter')[0];
    const posted = this.host.getJson(${JSON.stringify(origin)} + '/post', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query})});
    return {title:data.title, chapter, url:this.host.resolveUrl(chapter.attributes.href, ${JSON.stringify(origin)}), posted, scriptExecuted: typeof executed};
  }});`,
  ]
  const result = await value.execute({
    scripts,
    sourceId: 'fixture',
    method: 'search',
    args: ['fixture'],
    allowedOrigins: [origin],
    signal: signal(),
  })
  assert.deepEqual(result, {
    title: '合成书籍',
    chapter: {
      text: '第一章',
      html: '<b>第一章</b>',
      attributes: { class: 'chapter', href: '/chapter/1' },
    },
    url: `${origin}/chapter/1`,
    posted: { body: '{"query":"fixture"}' },
    scriptExecuted: 'undefined',
  })
  assert.deepEqual(requests, ['GET /search?q=fixture', 'GET /page', 'POST /post'])
})

test('plugin requests reject unauthorized origins, URL credentials, ambient authentication and cross-origin redirects before transport', async (t) => {
  const foreign: string[] = []
  const other = await server(t, (req, res) => {
    foreign.push(req.url!)
    res.end('unreachable')
  })
  const requests: string[] = []
  const origin = await server(t, (req, res) => {
    requests.push(req.url!)
    res.writeHead(302, { location: `${other}/target` })
    res.end()
  })
  const value = runtime(t)
  const execute = (url: string, options?: unknown) =>
    value.execute({
      scripts: [
        `registerSource({id:'fixture', search(){return this.host.getText(${JSON.stringify(url)}, ${JSON.stringify(options ?? {})});}})`,
      ],
      sourceId: 'fixture',
      method: 'search',
      args: [],
      allowedOrigins: [origin],
      signal: signal(),
    })
  await assert.rejects(execute(`${other}/direct`), code('INVALID_SOURCE_REQUEST'))
  const credentials = syntheticCredentials()
  const authenticated = new URL(origin)
  authenticated.username = credentials.username
  authenticated.password = credentials.password
  await assert.rejects(execute(authenticated.href), code('INVALID_SOURCE_REQUEST'))
  await assert.rejects(
    execute(origin, { headers: { Authorization: `Bearer ${syntheticToken()}` } }),
    code('INVALID_SOURCE_REQUEST'),
  )
  await assert.rejects(
    execute(origin, { headers: { Cookie: `fixture=${syntheticToken()}` } }),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.deepEqual(requests, [])
  await assert.rejects(execute(`${origin}/redirect`), code('INVALID_SOURCE_REQUEST'))
  assert.deepEqual(requests, ['/redirect'])
  assert.deepEqual(foreign, [])
  await assert.rejects(
    value.inspect({
      scripts: [
        `const source={id:'startup'};registerSource(source);source.host.getText(${JSON.stringify(origin)});`,
      ],
      signal: signal(),
    }),
    /校验阶段不可访问/,
  )
  assert.deepEqual(requests, ['/redirect'])
})

test('partial bodies, streamed oversize content and excessive request counts cannot become plugin results', async (t) => {
  let count = 0
  const origin = await server(t, (req, res) => {
    count++
    if (req.url === '/partial') {
      res.writeHead(206, { 'content-range': 'bytes 0-4/100' })
      res.end('part')
      return
    }
    if (req.url === '/large') {
      res.writeHead(200)
      for (let i = 0; i < 40; i++) res.write('x'.repeat(65536))
      res.end()
      return
    }
    res.end('small')
  })
  const value = runtime(t)
  const run = (body: string) =>
    value.execute({
      scripts: [`registerSource({id:'fixture',search(){${body}}})`],
      sourceId: 'fixture',
      method: 'search',
      args: [],
      allowedOrigins: [origin],
      signal: signal(),
    })
  await assert.rejects(
    run(`return this.host.getText(${JSON.stringify(origin + '/partial')});`),
    /HTTP 206/,
  )
  await assert.rejects(
    run(`return this.host.getText(${JSON.stringify(origin + '/large')});`),
    /大小限制/,
  )
  const before = count
  await assert.rejects(
    run(`for(let i=0;i<33;i++) this.host.getText(${JSON.stringify(origin)});return 'never';`),
    /32 次网络请求/,
  )
  assert.equal(count - before, 32)
})

test('canceling a blocked network request terminates its worker and cannot publish a late success', async (t) => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let held: ServerResponse | undefined
  const origin = await server(t, (_req, res) => {
    held = res
    started()
  })
  const value = runtime(t)
  const controller = new AbortController()
  const pending = value.execute({
    scripts: [
      `registerSource({id:'fixture',search(){return this.host.getText(${JSON.stringify(origin)});}})`,
    ],
    sourceId: 'fixture',
    method: 'search',
    args: [],
    allowedOrigins: [origin],
    signal: controller.signal,
  })
  await ready
  controller.abort()
  await assert.rejects(pending, code('SOURCE_CANCELED'))
  held?.end('obsolete result')
  assert.deepEqual(
    await value.inspect({
      scripts: [`registerSource({id:'after-cancel', getBook(){return {};}})`],
      signal: signal(),
    }),
    [{ id: 'after-cancel', methods: ['getBook'] }],
  )
})

test('CPU loops, memory exhaustion and oversized output stay within a disposable runtime and shutdown rejects new work', async (t) => {
  const value = runtime(t)
  const execute = (body: string, timeoutMs = 5000) =>
    value.execute({
      scripts: [`registerSource({id:'fixture',search(){${body}}})`],
      sourceId: 'fixture',
      method: 'search',
      args: [],
      allowedOrigins: [],
      signal: signal(),
      timeoutMs,
    })
  const started = Date.now()
  await assert.rejects(execute('while(true){}', 600), code('SOURCE_TIMEOUT'))
  assert.ok(Date.now() - started < 5000)
  await assert.rejects(
    execute('return new ArrayBuffer(128*1024*1024);'),
    (error: unknown) => error instanceof SourceError && /memory|内存|资源/i.test(error.message),
  )
  await assert.rejects(execute('return "x".repeat(4*1024*1024+1);'), /4 MiB/)
  await assert.rejects(execute('return "汉".repeat(1500000);'), /结果过大/)
  assert.equal(await execute('return 42;'), 42)
  await value.close()
  await assert.rejects(execute('return 43;'), code('SOURCE_CANCELED'))
})

test('closing the service drains simultaneous blocked workers and aborts their host network requests', async (t) => {
  let opened = 0,
    ready!: () => void
  const requested = new Promise<void>((resolve) => {
    ready = resolve
  })
  const origin = await server(t, (_req, res) => {
    opened++
    if (opened === 2) ready()
    res.on('close', () => {
      opened--
    })
  })
  const value = runtime(t)
  const execute = () =>
    value.execute({
      scripts: [
        `registerSource({id:'fixture',search(){return this.host.getText(${JSON.stringify(origin)});}})`,
      ],
      sourceId: 'fixture',
      method: 'search',
      args: [],
      allowedOrigins: [origin],
      signal: signal(),
    })
  const tasks = [execute(), execute()]
  const settled = tasks.map((task) =>
    task.catch((error: unknown) => (error instanceof SourceError ? error.code : 'unexpected')),
  )
  await requested
  await value.close()
  assert.deepEqual(await Promise.all(settled), ['SOURCE_CANCELED', 'SOURCE_CANCELED'])
  await assert.rejects(execute(), code('SOURCE_CANCELED'))
})
