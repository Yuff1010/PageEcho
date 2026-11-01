// Create an isolated directory package and inspect its bytes. Never launch the packaged EXE.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { cp, copyFile, mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import { beginManagedGenerated } from './managed-generated'

const args = process.argv.slice(2)
assert.deepEqual([args.length, args[0]], [2, '--app-root'])
const appRoot = resolve(args[1]!),
  workspace = process.cwd()
const build = JSON.parse(await readFile(resolve(appRoot, '../manifest.json'), 'utf8'))
const rootPackage = JSON.parse(await readFile('package.json', 'utf8'))
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
for (const [file, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', file)), digest)
for (const [file, digest] of Object.entries(build.originalOutputHashes))
  assert.equal(await hash(resolve('out', file)), digest)
const disk = await statfs(workspace)
assert.ok(disk.bavail * disk.bsize > 2 * 1024 ** 3, 'Directory packaging needs at least 2 GiB free')
const managed = await beginManagedGenerated('package', `directory-${build.previewVersion}`)
try {
  const directory = managed.directory
  const project = join(directory, 'project'),
    output = join(directory, 'output')
  await mkdir(project, { recursive: true })
  await copyFile(resolve('scripts/build/package-preview.ts'), join(directory, 'runner-started.ts'))
  await cp(join(appRoot, 'out'), join(project, 'out'), { recursive: true })
  await cp(join(appRoot, 'python'), join(project, 'python'), { recursive: true })
  await copyFile(resolve('THIRD_PARTY_NOTICES.md'), join(project, 'THIRD_PARTY_NOTICES.md'))
  const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify(
      {
        ...packageJson,
        description: rootPackage.description,
        author: rootPackage.author,
        license: rootPackage.license,
        private: true,
      },
      null,
      2,
    ) + '\n',
  )
  const execute = promisify(execFile)
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli && isAbsolute(npmCli), 'Run this helper through npm run pack:preview')
  // Use npm's recorded full production tree; nested and hoisted dependencies are both copied.
  const result = await execute(
    process.execPath,
    [npmCli, 'ls', '--omit=dev', '--all', '--parseable'],
    { cwd: workspace, windowsHide: true },
  )
  const modules = resolve('node_modules')
  const copied = []
  for (const source of result.stdout
    .trim()
    .split(/\r?\n/)
    .filter((path) => resolve(path) !== workspace)) {
    const local = relative(modules, resolve(source))
    assert.ok(
      local &&
        !isAbsolute(local) &&
        local !== '..' &&
        !local.startsWith('..\\') &&
        !local.startsWith('../'),
    )
    await cp(source, join(project, 'node_modules', local), { recursive: true })
    copied.push(local.replaceAll('\\', '/'))
  }
  const require = createRequire(import.meta.url)
  const yaml = require('js-yaml') as { load: (text: string) => Record<string, unknown> }
  const config = yaml.load(await readFile('electron-builder.yml', 'utf8'))
  config.directories = { output }
  config.electronVersion = rootPackage.devDependencies.electron
  const configPath = join(directory, 'builder.json')
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
  const report: Record<string, unknown> = {
    status: 'running',
    startedAt: new Date().toISOString(),
    directory,
    appRoot,
    project,
    output,
    version: packageJson.version,
    electronVersion: config.electronVersion,
    productionModules: copied,
    buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
    runnerHash: await hash(join(directory, 'runner-started.ts')),
    packagedApplicationExecuted: false,
    installerBuilt: false,
    scope:
      'Isolated electron-builder directory target; static ASAR/resources/dependency/license verification. No packaged EXE, NSIS, install, upgrade or clean-device execution.',
  }
  const save = () =>
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await save()
  console.log(
    JSON.stringify({ stage: 'packaging-directory-only', report: join(directory, 'report.json') }),
  )
  let log = ''
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve('node_modules/electron-builder/cli.js'),
          '--projectDir',
          project,
          '--config',
          configPath,
          '--win',
          'dir',
          '--x64',
          '--publish',
          'never',
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data) => {
          log += String(data)
          process.stdout.write(data)
        })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? done() : reject(new Error(`Directory builder exited ${code}`)),
      )
    })
    const unpacked = join(output, 'win-unpacked'),
      archive = join(unpacked, 'resources/app.asar')
    const names = listPackage(archive, { isPack: false }).map((name) =>
      name.replaceAll('\\', '/').replace(/^\//, ''),
    )
    const roots = [...new Set(names.map((name) => name.split('/')[0]!))].sort()
    assert.ok(
      roots.every((name) =>
        ['out', 'node_modules', 'package.json', 'THIRD_PARTY_NOTICES.md'].includes(name),
      ),
      `Unexpected packaged root: ${roots}`,
    )
    const packedPackage = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
    assert.equal(packedPackage.version, packageJson.version)
    for (const [file, digest] of Object.entries(build.outputHashes))
      assert.equal(
        createHash('sha256')
          .update(extractFile(archive, join('out', file)))
          .digest('hex'),
        digest,
      )
    const dependencyChecks = []
    for (const path of [
      'node_modules/opencc-js/package.json',
      'node_modules/opencc-js/dist/esm/t2cn.js',
      'node_modules/opencc-js/LICENSE',
      'node_modules/opencc-js/THIRD_PARTY_LICENSES.md',
      'node_modules/opencc-js/LICENSES/Apache-2.0.txt',
      'node_modules/@xmldom/xmldom/package.json',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      const packed = extractFile(archive, path.replaceAll('/', sep)),
        source = await readFile(resolve(path))
      if (path.endsWith('/package.json')) {
        const actual = JSON.parse(packed.toString('utf8')),
          expected = JSON.parse(source.toString('utf8'))
        for (const key of [
          'name',
          'version',
          'type',
          'main',
          'module',
          'exports',
          'dependencies',
          'optionalDependencies',
          'peerDependencies',
          'license',
        ])
          assert.deepEqual(
            actual[key],
            expected[key],
            `Runtime package metadata changed: ${path} ${key}`,
          )
      } else assert.ok(packed.equals(source), `Packaged file bytes changed: ${path}`)
      dependencyChecks.push({
        path,
        bytes: packed.length,
        sha256: createHash('sha256').update(packed).digest('hex'),
      })
    }
    const resources = await readdir(join(unpacked, 'resources/asr'))
    const expected = await readdir(join(appRoot, 'python'))
    assert.deepEqual(resources.sort(), expected.sort())
    for (const name of resources)
      assert.equal(
        await hash(join(unpacked, 'resources/asr', name)),
        await hash(join(appRoot, 'python', name)),
      )
    for (const [file, digest] of Object.entries(build.originalOutputHashes))
      assert.equal(await hash(resolve('out', file)), digest)
    report.archive = {
      path: archive,
      sha256: await hash(archive),
      entries: names.length,
      roots,
      outputFilesVerified: Object.keys(build.outputHashes).length,
    }
    report.dependenciesAndNotices = dependencyChecks
    report.asrResources = resources
    report.originalOutUnchanged = true
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    await writeFile(join(directory, 'builder.log'), log)
    report.finishedAt = new Date().toISOString()
    await save()
    console.log(
      JSON.stringify({
        status: report.status,
        report: join(directory, 'report.json'),
        error: report.error,
      }),
    )
  }
} finally {
  await managed.complete()
}
