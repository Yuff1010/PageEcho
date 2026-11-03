// Pure policy tests only: importing this harness must not launch Electron or an installer.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  assertLifecycleRunner,
  assertUpgradeVersions,
  parseLifecycleArguments,
  parseQuietUninstall,
  validateBuildList,
} from '../model/installer-lifecycle'

function runner() {
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: resolve(tmpdir(), 'synthetic-lifecycle-runner'),
    PAGEECHO_INSTALLER_LIFECYCLE: '1',
  }
}
function builds() {
  return [
    {
      sourceCommit: 'a'.repeat(40),
      version: '0.39.0-dev.1',
      report: resolve(tmpdir(), 'synthetic-baseline', 'report.json'),
    },
    {
      sourceCommit: 'b'.repeat(40),
      version: '0.41.0-dev.1',
      report: resolve(tmpdir(), 'synthetic-candidate', 'report.json'),
    },
  ]
}

test('real lifecycle requires every explicit disposable Windows runner opt-in', () => {
  const environment = runner()
  assert.doesNotThrow(() => assertLifecycleRunner(environment, 'win32'))
  assert.throws(() => assertLifecycleRunner({}, 'win32'), /disposable Windows Actions runner/)
  assert.throws(() => assertLifecycleRunner(environment, 'linux'), /disposable/)
  for (const key of Object.keys(environment)) {
    const incomplete: NodeJS.ProcessEnv = { ...environment }
    Reflect.deleteProperty(incomplete, key)
    assert.throws(() => assertLifecycleRunner(incomplete, 'win32'), /disposable/, key)
  }
  for (const changes of [
    { CI: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_OS: 'Linux' },
    { RUNNER_TEMP: 'relative-temp' },
    { PAGEECHO_INSTALLER_LIFECYCLE: 'true' },
  ])
    assert.throws(
      () => assertLifecycleRunner({ ...environment, ...changes }, 'win32'),
      /disposable/,
    )
})

test('lifecycle refuses application data redirection and preloaded application settings', () => {
  for (const key of ['RALB_USER_DATA', 'ralb_user_data', 'RALB_SETUP', 'RALB_COMPONENT_CONFIG'])
    assert.throws(
      () => assertLifecycleRunner({ ...runner(), [key]: 'synthetic-only' }, 'win32'),
      /Do not redirect application data or preload/,
      key,
    )
})

test('lifecycle CLI confines evidence to a cache subdirectory and has exactly two named inputs', () => {
  const list = resolve(tmpdir(), 'synthetic-build-list.json')
  const output = resolve('cache', 'installer-lifecycle', 'synthetic-new-run')
  assert.deepEqual(parseLifecycleArguments(['--build-list', list, '--output', output]), {
    buildList: list,
    output,
  })
  for (const args of [
    [],
    ['--build-list', list],
    ['--output', output, '--build-list', list],
    ['--build-list', '', '--output', output],
    ['--build-list', 'bad\0list', '--output', output],
    ['--build-list', '--force', '--output', output],
    ['--build-list', list, '--output', ''],
    ['--build-list', list, '--output', 'bad\0output'],
    ['--build-list', list, '--output', output, '--force'],
  ])
    assert.throws(() => parseLifecycleArguments(args), JSON.stringify(args))
  for (const rejected of [
    resolve('cache'),
    resolve('.'),
    resolve('cache', '..', 'outside'),
    resolve(tmpdir(), 'outside-cache'),
    resolve('cache') + '-adjacent/looks-similar',
  ])
    assert.throws(
      () => parseLifecycleArguments(['--build-list', list, '--output', rejected]),
      /cache subdirectory/,
      rejected,
    )
})

test('build provenance accepts exactly two explicit commit/version/absolute-report entries', () => {
  const values = builds()
  const before = structuredClone(values)
  assert.deepEqual(validateBuildList(values), before)
  assert.deepEqual(values, before)
  for (const invalid of [null, {}, [], values.slice(0, 1), [...values, values[0]]])
    assert.throws(() => validateBuildList(invalid), /Exactly two/)
  for (const changes of [
    { sourceCommit: 'a'.repeat(39) },
    { sourceCommit: 'a'.repeat(41) },
    { sourceCommit: 'A'.repeat(40) },
    { sourceCommit: 'a'.repeat(40) + '\n' },
    { sourceCommit: 'not-a-commit' },
    { version: '0.41.0' },
    { version: '0.41.0-dev.1\n' },
    { version: '00.41.0-dev.1' },
    { version: '0.41.0-dev.01' },
    { report: 'relative/report.json' },
    { report: '' },
    { report: resolve(tmpdir(), 'report.json') + '\0' },
    { scripts: { preinstall: 'synthetic forbidden hook' } },
  ])
    assert.throws(
      () => validateBuildList([{ ...values[0], ...changes }, values[1]]),
      /Invalid installer build provenance/,
      JSON.stringify(changes),
    )
  assert.throws(() => validateBuildList([values[0], null]), /Invalid installer/)
  const missing = { sourceCommit: values[0]!.sourceCommit, version: values[0]!.version }
  assert.throws(() => validateBuildList([missing, values[1]]), /Invalid installer/)
})

test('upgrade versions require a real forward preview version without numeric overflow', () => {
  for (const [before, after] of [
    ['0.39.0-dev.1', '0.41.0-dev.1'],
    ['0.41.0-dev.1', '0.41.0-dev.2'],
    ['0.41.0-dev.9', '0.41.1-dev.1'],
    ['0.99.99-dev.99', '1.0.0-dev.1'],
  ])
    assert.doesNotThrow(() => assertUpgradeVersions(before!, after!))
  for (const [before, after] of [
    ['0.41.0-dev.1', '0.41.0-dev.1'],
    ['0.41.0-dev.2', '0.41.0-dev.1'],
    ['0.41.0-dev.1', '0.40.9-dev.99'],
    ['1.0.0-dev.1', '0.99.99-dev.99'],
    ['0.41.0-dev.1', '0.41.0'],
    ['0.41.0', '0.41.0-dev.1'],
    ['0.41.0-dev.1', '0.42.0-dev.1\n'],
    ['0.41.0-dev.1\n', '0.42.0-dev.1'],
    ['0.41.0-dev.1', '00.42.0-dev.1'],
    ['0.41.0-dev.1', '0.42.0-dev.01'],
    ['0.41.0-dev.1', '9007199254740992.0.0-dev.1'],
    ['0.41.0-dev.1', '0.9007199254740992.0-dev.1'],
    ['0.41.0-dev.1', '0.42.9007199254740992-dev.1'],
    ['0.41.0-dev.1', '0.42.0-dev.9007199254740992'],
    ['9007199254740992.0.0-dev.1', '9007199254740993.0.0-dev.1'],
  ])
    assert.throws(() => assertUpgradeVersions(before!, after!), `${before} -> ${after}`)
})

test('quiet uninstall parses only the registered per-user silent command in the known directory', () => {
  const installation = resolve(tmpdir(), 'synthetic install with spaces')
  const executable = join(installation, 'Uninstall PageEcho.exe')
  assert.deepEqual(parseQuietUninstall(`"${executable}" /currentuser /S`, installation), {
    executable,
    args: ['/currentuser', '/S'],
  })
  assert.deepEqual(parseQuietUninstall(`"${executable}" /CURRENTUSER /s`, installation), {
    executable,
    args: ['/currentuser', '/S'],
  })
  for (const command of [
    `${executable} /currentuser /S`,
    `"${executable}" /S /currentuser`,
    `"${executable}" /allusers /S`,
    `"${executable}" /currentuser`,
    `"${executable}" /currentuser /S /DELETE_APP_DATA`,
    `"${executable}" /currentuser /S /KEEP_APP_DATA`,
    `"${executable}" /currentuser /S /D=${resolve(tmpdir(), 'other-target')}`,
    `"${executable}" /currentuser /S & echo synthetic`,
    `"${executable}" /currentuser /S; echo synthetic`,
    `cmd /c "${executable}" /currentuser /S`,
    `powershell -Command "${executable}" /currentuser /S`,
    `"${executable}" /currentuser /S\n`,
    `"${executable}" /currentuser /S\r\n`,
    `"${join(installation, 'different.exe')}" /currentuser /S`,
    `"${join(installation, '..', 'outside', 'Uninstall PageEcho.exe')}" /currentuser /S`,
    '"relative/Uninstall PageEcho.exe" /currentuser /S',
  ])
    assert.throws(() => parseQuietUninstall(command, installation), command)
})
