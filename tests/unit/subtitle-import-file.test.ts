import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeSubtitleImport,
  readSubtitleImportFile,
  type SubtitleImportFile,
} from '../../src/main/subtitle-import-file'
import { MAX_TRANSCRIPT_BYTES } from '../../src/shared/transcript'
import { validateRequest } from '../../src/shared/validation'

function file(bytes: Buffer, format: 'srt' | 'vtt' = 'srt'): SubtitleImportFile {
  return {
    bytes,
    format,
    fileName: `字幕.${format}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
test('UTF-8 and both UTF-16 BOMs decode strictly; conflicting BOM and malformed Unicode are rejected', () => {
  const text = '1\r\n00:00:01,000 --> 00:00:02,000\r\n中文😀'
  for (const bytes of [
    Buffer.from(text),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
  ])
    assert.deepEqual(decodeSubtitleImport(file(bytes), 'auto'), { text, encoding: 'utf-8' })
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    be = Buffer.from(le).swap16()
  assert.deepEqual(decodeSubtitleImport(file(le), 'auto'), { text, encoding: 'utf-16le' })
  assert.deepEqual(decodeSubtitleImport(file(be), 'auto'), { text, encoding: 'utf-16be' })
  assert.throws(() => decodeSubtitleImport(file(le), 'utf-8'), { code: 'INVALID_TRANSCRIPT' })
  for (const bytes of [
    Buffer.from([0xc0, 0x80]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('a\0b'),
  ])
    assert.throws(() => decodeSubtitleImport(file(bytes), 'auto'), { code: 'INVALID_TRANSCRIPT' })
  assert.throws(() => decodeSubtitleImport(file(Buffer.from([0xff, 0xfe, 0x00])), 'auto'), {
    code: 'INVALID_TRANSCRIPT',
  })
})
test('SRT Chinese encodings require an explicit choice; WebVTT accepts UTF-8 only', () => {
  const gb = file(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])),
    big5 = file(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]))
  assert.throws(() => decodeSubtitleImport(gb, 'auto'), { code: 'INVALID_TRANSCRIPT' })
  assert.deepEqual(decodeSubtitleImport(gb, 'gb18030'), { text: '中文', encoding: 'gb18030' })
  assert.deepEqual(decodeSubtitleImport(big5, 'big5'), { text: '中文', encoding: 'big5' })
  for (const encoding of ['utf-16le', 'utf-16be', 'gb18030', 'big5'] as const)
    assert.throws(() => decodeSubtitleImport(file(Buffer.from('WEBVTT\n'), 'vtt'), encoding), {
      code: 'INVALID_TRANSCRIPT',
    })
  assert.throws(
    () => decodeSubtitleImport(file(Buffer.from([0xff, 0xfe, 0x61, 0x00]), 'vtt'), 'auto'),
    { code: 'INVALID_TRANSCRIPT' },
  )
})
test('file reading independently enforces sixteen MiB, supported native-picker extensions, snapshot SHA and cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ralb-subtitle-file-'))
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'ralb-subtitle-file-')))
    await rm(root, { recursive: true, force: true })
  })
  const name = join(root, '字幕.SRT'),
    signal = new AbortController().signal,
    bytes = Buffer.alloc(MAX_TRANSCRIPT_BYTES, 0x61)
  await writeFile(name, bytes)
  const read = await readSubtitleImportFile(name, signal)
  assert.equal(read.bytes.length, MAX_TRANSCRIPT_BYTES)
  assert.deepEqual(read.bytes, bytes)
  assert.equal(read.sha256, createHash('sha256').update(bytes).digest('hex'))
  await writeFile(name, Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1, 0x61))
  await assert.rejects(readSubtitleImportFile(name, signal), { code: 'INVALID_TRANSCRIPT' })
  await writeFile(name, '')
  await assert.rejects(readSubtitleImportFile(name, signal), { code: 'INVALID_TRANSCRIPT' })
  await assert.rejects(readSubtitleImportFile(join(root, '字幕.json'), signal), {
    code: 'INVALID_TRANSCRIPT',
  })
  const canceled = new AbortController()
  canceled.abort()
  await assert.rejects(readSubtitleImportFile(name, canceled.signal), { name: 'AbortError' })
})
test('subtitle import IPC only admits exact bounded IDs and options, never source paths, documents, bytes or coercion', () => {
  const request = {
      episodeId: 'c445b21c-782d-42e9-b1e2-e9fd77a1fd28',
      audioHash: 'a'.repeat(64),
      requestId: 'b4038653-137f-488d-a3b6-1fe5edb704ec',
      encoding: 'auto',
      offsetMs: 0,
    },
    token = 'cfd24278-70c0-41ed-803e-3562fa52cb8d',
    revision = 1,
    commandId = '71e76046-ecc3-4cd4-b2ae-56d31bafc012'
  for (const [channel, value] of [
    ['preview', request],
    ['update', { token, revision, encoding: 'gb18030', offsetMs: -1500 }],
    ['page', { token, revision, page: 1999 }],
    ['apply', { token, revision, commandId }],
    ['cancel', { requestId: request.requestId }],
  ] as const)
    assert.doesNotThrow(() => validateRequest(`subtitle-import:${channel}`, [value]))
  for (const value of [
    { ...request, path: 'C:/private/file.srt' },
    { ...request, bytes: [1] },
    { ...request, document: {} },
    { ...request, encoding: 'utf7' },
    { ...request, offsetMs: '0' },
    { ...request, offsetMs: NaN },
    { ...request, offsetMs: 1.5 },
    { ...request, offsetMs: 3.6e10 + 1 },
    { ...request, audioHash: 'A'.repeat(64) },
  ])
    assert.throws(() => validateRequest('subtitle-import:preview', [value]), {
      code: 'INVALID_REQUEST',
    })
  for (const value of [
    { token, revision, page: -1 },
    { token, revision, page: 2000 },
    { token, revision: 0, page: 0 },
  ])
    assert.throws(() => validateRequest('subtitle-import:page', [value]), {
      code: 'INVALID_REQUEST',
    })
  assert.throws(() => validateRequest('subtitle-import:preview', [request, {}]), {
    code: 'INVALID_REQUEST',
  })
  assert.throws(() => validateRequest('subtitle-import:unknown', [{}]), { code: 'INVALID_REQUEST' })
})
