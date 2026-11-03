// Preserve native realpath/junction guards when hosted TEMP uses an 8.3 alias.
import assert from 'node:assert/strict'
import { appendFileSync, lstatSync, mkdtempSync, realpathSync, rmdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

assert.equal(process.platform, 'win32')
assert(process.env.GITHUB_ENV, 'This entry configures the current Actions job only')
const original = tmpdir()
const parent = await realpath(original)
const directory = await realpath(mkdtempSync(join(parent, 'ralb-ci-')))
async function verify(path: string) {
  assert.equal(await realpath(path), resolve(path))
  assert.equal(realpathSync.native(path), resolve(path))
  const info = lstatSync(path)
  assert.ok(info.isDirectory() && !info.isSymbolicLink())
}
assert.match(directory, /^C:\\/i, 'Large-file fixtures require temporary storage on C:')
await verify(parent)
await verify(directory)
process.env.TEMP = directory
process.env.TMP = directory
assert.equal(resolve(tmpdir()), directory)
const probe = mkdtempSync(join(tmpdir(), 'canonical-probe-'))
try {
  await verify(probe)
} finally {
  rmdirSync(probe)
}
appendFileSync(process.env.GITHUB_ENV, `TEMP=${directory}\nTMP=${directory}\n`)
console.log(
  JSON.stringify({ originalTemporaryDirectory: original, canonicalTemporaryDirectory: directory }),
)
