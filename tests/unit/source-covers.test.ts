import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SourceCoverService,
  builtinSourceCoverPolicy,
  sourceCoverMime,
} from '../../src/main/sources/source-covers'
import { SOURCE_COVER_PREFIX, isSourceCoverUrl } from '../../src/shared/source-covers'
import { pluginBook } from '../../src/main/plugins/adapters'
import { parsePluginManifest, pluginSourceInfo } from '../../src/main/plugins/manifest'
import { syntheticCredentials } from '../helpers/synthetic-auth'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSMcAAAAASUVORK5CYII=',
  'base64',
)
const origin = 'https://images.example'
const policy = {
  allowedOrigins: [origin],
  referer: 'https://books.example/work?not-forwarded=value',
}
const raster = () =>
  new Response(png, {
    headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
  })

test('registered source covers use opaque same-origin URLs, deduplicate and cache raster bytes without ambient credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const service = new SourceCoverService({
    request: async (input, init) => {
      calls.push({ url: String(input), init })
      await held
      return raster()
    },
  })
  try {
    const url = service.register('plugin:fixture:audio', `${origin}/cover.png`, policy)!
    assert.ok(isSourceCoverUrl(url))
    assert.ok(url.startsWith(SOURCE_COVER_PREFIX))
    assert.equal(service.register('plugin:fixture:audio', `${origin}/cover.png`, policy), url)
    const first = service.serve(new Request(url)),
      second = service.serve(new Request(url))
    release()
    const responses = await Promise.all([first, second])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, `${origin}/cover.png`)
    assert.equal(calls[0]!.init!.credentials, 'omit')
    assert.equal(calls[0]!.init!.redirect, 'manual')
    const headers = new Headers(calls[0]!.init!.headers)
    assert.equal(headers.get('cookie'), null)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('referer'), 'https://books.example/work')
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
    }
    const head = await service.serve(new Request(url, { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal(calls.length, 1)
  } finally {
    service.close()
  }
  const devOrigin = 'http://localhost:5173'
  const dev = new SourceCoverService({
    request: async () => raster(),
    trustedRendererOrigin: devOrigin,
  })
  try {
    const url = dev.register('test', `${origin}/cover.png`, policy)!
    const response = await dev.serve(new Request(url, { headers: { Origin: devOrigin } }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin')
    assert.equal(
      (await dev.serve(new Request(url, { headers: { Origin: 'http://localhost:5174' } }))).status,
      404,
    )
  } finally {
    dev.close()
  }
  assert.throws(
    () => new SourceCoverService({ trustedRendererOrigin: 'https://example.com/path' }),
    /Invalid renderer origin/,
  )
})

test('unregistered, foreign, credentialed and redirected cover URLs cannot make arbitrary network requests', async () => {
  const credentials = syntheticCredentials()
  const credentialed = new URL(`${origin}/cover`)
  credentialed.username = credentials.username
  credentialed.password = credentials.password
  const calls: string[] = []
  const service = new SourceCoverService({
    request: async (input) => {
      calls.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://foreign.example/secret' },
      })
    },
  })
  try {
    for (const value of [
      'file:///C:/secret',
      'javascript:alert(1)',
      'data:image/png;base64,AA',
      credentialed.href,
      'https://foreign.example/cover',
    ])
      assert.equal(service.register('test', value, policy), null)
    assert.equal(
      (
        await service.serve(
          new Request(`${SOURCE_COVER_PREFIX}00000000-0000-0000-0000-000000000000`),
        )
      ).status,
      404,
    )
    const url = service.register('test', `${origin}/cover`, policy)!
    assert.equal((await service.serve(new Request(url, { method: 'POST' }))).status, 405)
    assert.equal(
      (await service.serve(new Request(url, { headers: { Origin: 'https://foreign.example' } })))
        .status,
      404,
    )
    assert.equal((await service.serve(new Request(url))).status, 404)
    assert.deepEqual(calls, [`${origin}/cover`])
  } finally {
    service.close()
  }
})

test('HTML, SVG, partial and oversized cover responses fall back without leaking content; raster magic determines safe MIME', async () => {
  const payloads = [
    new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      headers: { 'content-type': 'image/svg+xml' },
    }),
    new Response('<html>login</html>', { headers: { 'content-type': 'image/png' } }),
    new Response(png, { headers: { 'content-type': 'text/html' } }),
    new Response(png, {
      status: 206,
      headers: { 'content-type': 'image/png', 'content-range': `bytes 0-${png.length - 1}/9999` },
    }),
    new Response(png, {
      headers: { 'content-type': 'image/png', 'content-range': `bytes 0-${png.length - 1}/9999` },
    }),
    new Response(png, {
      headers: { 'content-type': 'image/png', 'content-length': String(3 * 1024 * 1024) },
    }),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ]
  const service = new SourceCoverService({ request: async () => payloads.shift()! })
  try {
    for (let index = 0; index < 7; index++) {
      const url = service.register('test', `${origin}/${index}`, policy)!
      const response = await service.serve(new Request(url))
      assert.equal(response.status, 404)
      assert.equal((await response.arrayBuffer()).byteLength, 0)
    }
    payloads.push(new Response(png, { headers: { 'content-type': 'image/gif' } }))
    const mislabeled = await service.serve(
      new Request(service.register('test', `${origin}/mislabeled`, policy)!),
    )
    assert.equal(mislabeled.status, 200)
    assert.equal(mislabeled.headers.get('content-type'), 'image/png')
    const oversized = Buffer.from(png)
    oversized.writeUInt32BE(9000, 16)
    assert.throws(() => sourceCoverMime(oversized), /dimensions/)
    const unknownWebp = Buffer.alloc(24)
    unknownWebp.write('RIFF', 0)
    unknownWebp.writeUInt32LE(unknownWebp.length - 8, 4)
    unknownWebp.write('WEBPJUNK', 8)
    assert.equal(sourceCoverMime(unknownWebp), null)
    const shortWebp = Buffer.alloc(20)
    shortWebp.write('RIFF', 0)
    shortWebp.writeUInt32LE(shortWebp.length - 8, 4)
    shortWebp.write('WEBPVP8L', 8)
    assert.equal(sourceCoverMime(shortWebp), null)
  } finally {
    service.close()
  }
})

test('bounded cover candidates and byte cache evict old entries while timeout and shutdown abort work', async () => {
  let calls = 0
  const cache = new SourceCoverService({
    maxEntries: 2,
    maxCacheBytes: png.length,
    request: async () => {
      calls++
      return raster()
    },
  })
  const one = cache.register('test', `${origin}/one`, policy)!,
    two = cache.register('test', `${origin}/two`, policy)!
  await cache.serve(new Request(one))
  await cache.serve(new Request(two))
  await cache.serve(new Request(one))
  assert.equal(calls, 3)
  cache.register('test', `${origin}/three`, policy)
  assert.equal((await cache.serve(new Request(two))).status, 404)
  cache.close()
  let aborted = false
  const timeout = new SourceCoverService({
    timeoutMs: 10,
    request: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('canceled'))
          },
          { once: true },
        )
      }),
  })
  const url = timeout.register('test', `${origin}/held`, policy)!
  assert.equal((await timeout.serve(new Request(url))).status, 404)
  assert.equal(aborted, true)
  timeout.close()
  assert.equal(timeout.register('test', `${origin}/new`, policy), null)
})

test('LibriVox cover storage redirects preserve the exact archive item and image identity', async () => {
  const image = 'https://www.archive.org/download/cover_item/example_thumb.jpg'
  const trusted = builtinSourceCoverPolicy('librivox', 'https://librivox.org/example/', image)
  assert.equal(
    trusted.validateUrl!(
      new URL('https://dn710708.ca.archive.org/0/items/cover_item/example_thumb.jpg'),
    ),
    true,
  )
  assert.equal(
    trusted.validateUrl!(
      new URL('https://dn710708.ca.archive.org/0/items/other_item/example_thumb.jpg'),
    ),
    false,
  )
  assert.equal(
    trusted.validateUrl!(
      new URL('https://archive.org.evil.example/download/cover_item/example_thumb.jpg'),
    ),
    false,
  )
  assert.equal(
    trusted.validateUrl!(new URL('http://archive.org/download/cover_item/example_thumb.jpg')),
    false,
  )
  const calls: string[] = []
  const service = new SourceCoverService({
    request: async (input) => {
      calls.push(String(input))
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://dn710708.ca.archive.org/0/items/other_item/example_thumb.jpg',
        },
      })
    },
  })
  try {
    const url = service.register('librivox', image, trusted)!
    assert.equal((await service.serve(new Request(url))).status, 404)
    assert.deepEqual(calls, [image])
  } finally {
    service.close()
  }
})

test('plugin cover permissions are independent from media permissions and invalid images do not discard valid books', () => {
  const manifest = parsePluginManifest({
    schemaVersion: 1,
    apiVersion: 1,
    id: 'fixture',
    name: '合成插件',
    version: '1.0.0',
    main: 'main.js',
    sources: [
      {
        id: 'audio',
        name: '来源',
        kind: 'audio',
        baseUrl: 'https://books.example',
        allowedOrigins: ['https://books.example'],
        mediaOrigins: ['https://media.example'],
        coverOrigins: [origin],
      },
    ],
  })
  const source = pluginSourceInfo(manifest)[0]!
  const book = {
    id: 'one',
    title: '合成书籍',
    pageUrl: 'https://books.example/one',
    coverUrl: `${origin}/one.png`,
  }
  assert.equal(pluginBook(source, book).coverUrl, book.coverUrl)
  assert.equal(
    pluginBook(source, { ...book, coverUrl: 'https://media.example/cover.png' }).coverUrl,
    null,
  )
  assert.equal(pluginBook(source, { ...book, coverUrl: 'javascript:alert(1)' }).coverUrl, null)
  const legacy = pluginSourceInfo(
    parsePluginManifest({
      ...manifest,
      sources: [{ ...manifest.sources[0], coverOrigins: undefined }],
    }),
  )[0]!
  assert.deepEqual(legacy.coverOrigins, legacy.allowedOrigins)
})
