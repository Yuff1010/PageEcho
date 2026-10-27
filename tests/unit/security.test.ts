import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import { isTrustedRenderer, validateRequest } from '../../src/shared/validation'
import { APP_URL, resolveRendererResource } from '../../src/main/resources'

test('IPC rejects arbitrary paths, extra arguments, unknown channels and invalid IDs', () => {
  validateRequest('app:get-state', [])
  validateRequest('files:select-audio', [{ kind: 'audio' }])
  validateRequest('files:forget', [{ id: 'a02a836c-1f16-44bf-a0aa-55cd14976534' }])
  for (const [channel, args] of [
    ['app:get-state', [{}]],
    ['files:select-audio', []],
    ['files:select-audio', [null]],
    ['files:select-audio', [{ kind: 'audio', path: 'C:/secret' }]],
    ['files:select-audio', [{ kind: 'audio' }, 'extra']],
    ['files:select-audio', [{ kind: 'any' }]],
    ['files:forget', [{ id: "'; DROP TABLE selected_files" }]],
    ['files:forget', [{ id: 'x', path: 'x' }]],
    ['shell:execute', ['anything']],
  ] as [string, unknown[]][])
    assert.throws(() => validateRequest(channel, args), { code: 'INVALID_REQUEST' })
})

test('only the registered window main frame at the exact app URL may invoke IPC', () => {
  assert.ok(isTrustedRenderer(1, 1, true, APP_URL, APP_URL))
  assert.ok(isTrustedRenderer(1, 1, true, `${APP_URL}#section`, APP_URL))
  assert.equal(isTrustedRenderer(2, 1, true, APP_URL, APP_URL), false)
  assert.equal(isTrustedRenderer(1, 1, false, APP_URL, APP_URL), false)
  for (const url of [
    'https://attacker.invalid',
    'readlisten://app.evil/index.html',
    'readlisten://app/other.html',
    `${APP_URL}?bad=1`,
    'invalid',
  ]) {
    assert.equal(isTrustedRenderer(1, 1, true, url, APP_URL), false)
  }
})

test('resource protocol cannot read files outside the renderer bundle', () => {
  const root = resolve('out/renderer')
  assert.equal(resolveRendererResource(root, APP_URL), join(root, 'index.html'))
  assert.equal(
    resolveRendererResource(root, 'readlisten://app/assets/main.js'),
    join(root, 'assets/main.js'),
  )
  for (const url of [
    'file:///C:/secret',
    'readlisten://evil/index.html',
    'readlisten://user@app/index.html',
    'readlisten://app/%2e%2e%2fsecret',
    'readlisten://app/%5c..%5csecret',
    'readlisten://app/%00',
    'readlisten://app/%ff',
  ]) {
    assert.equal(resolveRendererResource(root, url), null)
  }
})
