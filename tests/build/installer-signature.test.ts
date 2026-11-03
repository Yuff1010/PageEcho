// Real Windows trust APIs run separately from the parallel SQLite unit suite.
// This test reads metadata only; no builder, NSIS executable or fixture executes.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectInstallerSignature } from '../../scripts/build/package-installer-preview'

test(
  'Authenticode inspection reads signed and unsigned metadata and rejects a missing file',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pageecho-signature-read-only-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const unsigned = join(root, 'never executed.ps1')
    await writeFile(unsigned, '# Synthetic signature metadata fixture. Never execute.\n')
    assert.deepEqual(await inspectInstallerSignature(unsigned), {
      status: 'NotSigned',
      subject: null,
    })
    const signed = await inspectInstallerSignature(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'),
    )
    assert.equal(signed.status, 'Valid')
    assert(signed.subject?.includes('Microsoft'))
    await assert.rejects(inspectInstallerSignature(join(root, 'missing.exe')))
  },
)
