import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectBackupPreferences,
  restoreBackupPreferences,
} from '../../src/renderer/src/backup-preferences'

function storage() {
  const values = new Map<string, string>()
  let fail = ''
  return {
    values,
    rejectOnce: (key: string) => {
      fail = key
    },
    api: {
      get length() {
        return values.size
      },
      clear: () => values.clear(),
      key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key)
      },
      setItem: (key: string, value: string) => {
        if (fail === key) {
          fail = ''
          throw new Error('quota')
        }
        values.set(key, value)
      },
    } satisfies Storage,
  }
}
test('preference export excludes unrelated storage, restore replaces supported keys and rolls back failed writes', () => {
  const store = storage()
  store.api.setItem('ralb:app:theme:v1', 'dark')
  store.api.setItem('ralb:reading:bookmarks:synthetic:v1', '[]')
  store.api.setItem('unrelated-session', 'synthetic-private-value')
  const original = collectBackupPreferences(store.api)
  assert.deepEqual(Object.keys(original).sort(), [
    'ralb:app:theme:v1',
    'ralb:reading:bookmarks:synthetic:v1',
  ])
  store.rejectOnce('ralb:app:style:v1')
  assert.throws(
    () =>
      restoreBackupPreferences(store.api, {
        'ralb:app:theme:v1': 'light',
        'ralb:app:style:v1': 'minimal',
      }),
    /quota/,
  )
  assert.deepEqual(collectBackupPreferences(store.api), original)
  restoreBackupPreferences(store.api, { 'ralb:app:style:v1': 'minimal' })
  assert.deepEqual(collectBackupPreferences(store.api), { 'ralb:app:style:v1': 'minimal' })
  assert.equal(store.api.getItem('unrelated-session'), 'synthetic-private-value')
  assert.throws(() => restoreBackupPreferences(store.api, { 'unrelated-session': 'replacement' }))
})
