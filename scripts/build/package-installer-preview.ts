// NSIS itself executes a temporary uninstaller while building. Real builds are
// restricted to an explicitly enabled disposable Windows Actions runner.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { extractFile, listPackage } from '@electron/asar'
import { beginManagedGenerated } from './managed-generated'

const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-dev\.(?:0|[1-9]\d*)(?![\s\S])/
const SHA = /^[a-f0-9]{64}(?![\s\S])/
const LEGAL = ['LICENSE', 'THIRD_PARTY_NOTICES.md']
const RESOURCE_FILTER = ['asr_*.py', 'evaluation-models.json', 'asr-model-integrity.json']
type Hashes = Record<string, string>
interface FrozenBuild {
  status: 'built'
  previewVersion: string
  appRoot: string
  originalOutputUnchanged: true
  outputHashes: Hashes
  pythonHashes: Hashes
  originalOutputHashes: Hashes
}
interface PackageMetadata {
  name: string
  version: string
  license: string
  type: string
  main: string
  dependencies: Record<string, string>
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function parseInstallerArguments(args: string[]) {
  assert(args.length === 2 || args.length === 3, 'Use --app-root <frozen-preview> [--plan-only]')
  assert.equal(args[0], '--app-root')
  assert(args[1] && !args[1].includes('\0') && !args[1].startsWith('--'), 'Missing app root')
  assert(args.length === 2 || args[2] === '--plan-only', 'Unknown installer argument')
  return { appRoot: resolve(args[1]), planOnly: args.length === 3 }
}

export function assertInstallerRunner(environment: NodeJS.ProcessEnv, platform = process.platform) {
  assert(
    platform === 'win32' &&
      environment.CI === 'true' &&
      environment.GITHUB_ACTIONS === 'true' &&
      environment.RUNNER_OS === 'Windows' &&
      environment.PAGEECHO_INSTALLER_BUILD === '1' &&
      environment.RUNNER_TEMP &&
      isAbsolute(environment.RUNNER_TEMP),
    'NSIS execution requires an explicitly enabled disposable Windows Actions runner. Use --plan-only locally; do not bypass Code Integrity.',
  )
}

/** Read PE/script trust metadata only; never execute the inspected file. */
export async function inspectInstallerSignature(file: string) {
  assert.equal(process.platform, 'win32')
  const { stdout } = await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference="Stop"; Import-Module (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath $env:PAGEECHO_SIGNATURE_TARGET -ErrorAction Stop; if($null -eq $s){throw "No signature result"}; [pscustomobject]@{status=[string]$s.Status;subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null}} | ConvertTo-Json -Compress',
    ],
    {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, PAGEECHO_SIGNATURE_TARGET: resolve(file) },
    },
  )
  return installerSignatureMetadata(JSON.parse(stdout.replace(/^\uFEFF/, '')))
}

export function installerSignatureMetadata(signature: unknown) {
  assert(
    object(signature) &&
      typeof signature.status === 'string' &&
      [
        'Valid',
        'UnknownError',
        'NotSigned',
        'HashMismatch',
        'NotTrusted',
        'NotSupportedFileFormat',
        'Incompatible',
      ].includes(signature.status) &&
      (signature.subject === null || typeof signature.subject === 'string') &&
      (signature.status !== 'Valid' || !!signature.subject),
    'Missing or malformed Authenticode status must not become verified signature evidence',
  )
  return { status: signature.status, subject: signature.subject }
}

async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
async function readJson(path: string, maximum = 4 * 1024 ** 2): Promise<unknown> {
  const info = await lstat(path)
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= maximum,
    'Invalid bounded metadata file',
  )
  return JSON.parse(await readFile(path, 'utf8'))
}
function hashes(raw: unknown, required: boolean): Hashes {
  assert(object(raw), 'Missing frozen file inventory')
  const entries = Object.entries(raw),
    seen = new Set<string>()
  assert(entries.length <= 20000 && (!required || entries.length > 0), 'Invalid inventory size')
  for (const [name, digest] of entries) {
    assert(
      name &&
        name.length <= 1000 &&
        !name.includes('\\') &&
        !/^[A-Za-z]:/.test(name) &&
        !name.startsWith('/') &&
        name.split('/').every((part) => part && part !== '.' && part !== '..') &&
        ![...name].some((character) => character.charCodeAt(0) < 32) &&
        !/[<>:"|?*]/.test(name) &&
        !seen.has(name.toLowerCase()) &&
        typeof digest === 'string' &&
        SHA.test(digest),
      'Invalid frozen inventory path or digest',
    )
    seen.add(name.toLowerCase())
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Hashes
}
/** Exact file sets and full digests reject unexpected private content, links and mutations. */
async function inventory(directory: string): Promise<Hashes> {
  const result: Hashes = {}
  let files = 0,
    bytes = 0
  async function walk(path: string) {
    const root = await lstat(path)
    assert(
      root.isDirectory() && !root.isSymbolicLink(),
      'Inventory root must be an ordinary directory',
    )
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      assert(!entry.isSymbolicLink(), 'Frozen inputs must not contain links')
      if (entry.isDirectory()) await walk(full)
      else {
        const info = await lstat(full)
        assert(info.isFile(), 'Frozen inputs contain a non-file')
        bytes += info.size
        assert(
          ++files <= 20000 && bytes <= 512 * 1024 ** 2,
          'Frozen inputs exceed the packaging budget',
        )
        result[relative(directory, full).replaceAll(sep, '/')] = await hash(full)
      }
    }
  }
  await walk(directory)
  return hashes(result, false)
}
function metadata(raw: unknown): PackageMetadata {
  assert(object(raw), 'Frozen package metadata must be an object')
  assert.deepEqual(
    Object.keys(raw).sort(),
    ['name', 'version', 'license', 'type', 'main', 'dependencies'].sort(),
    'Frozen package metadata must not contain scripts, build hooks or private fields',
  )
  assert(
    object(raw) &&
      typeof raw.name === 'string' &&
      typeof raw.version === 'string' &&
      raw.license === 'MIT' &&
      raw.type === 'module' &&
      raw.main === './out/main/index.js' &&
      object(raw.dependencies),
    'Frozen package metadata is not a supported MIT preview',
  )
  assert(
    Object.entries(raw.dependencies).every(
      ([name, version]) =>
        /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) &&
        typeof version === 'string' &&
        /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version),
    ),
    'Production dependencies must be exact registry versions',
  )
  return raw as unknown as PackageMetadata
}

export function validateInstallerDependencyLock(raw: unknown, current: Record<string, unknown>) {
  assert(
    object(raw) && raw.lockfileVersion === 3 && object(raw.packages),
    'A v3 reproducible dependency lock is required',
  )
  const packages = raw.packages
  assert(
    Object.keys(packages).length <= 20000 && Object.values(packages).every(object),
    'Invalid dependency lock package entries',
  )
  const root = packages[''],
    electron = packages['node_modules/electron']
  assert(
    object(root) && object(electron) && object(current.devDependencies),
    'Dependency lock is missing its root or Electron',
  )
  assert.equal(root.name, current.name, 'Dependency lock root name differs')
  assert.equal(root.version, current.version, 'Dependency lock root version differs')
  assert.deepEqual(
    root.dependencies,
    current.dependencies,
    'Direct production dependency locks differ',
  )
  assert.deepEqual(
    root.devDependencies,
    current.devDependencies,
    'Build-tool dependency locks differ',
  )
  assert.equal(
    electron.version,
    current.devDependencies.electron,
    'Locked Electron version differs',
  )
  for (const [name, version] of Object.entries(current.dependencies as Record<string, unknown>))
    assert.equal(
      (packages['node_modules/' + name] as Record<string, unknown> | undefined)?.version,
      version,
      'Locked direct production version differs',
    )
  return packages as Record<string, Record<string, unknown>>
}

/** Copy only ordinary, lock-matching production modules and authenticate every copied byte. */
export async function copyLockedProductionModule(
  source: string,
  destination: string,
  packages: Record<string, Record<string, unknown>>,
  workspace = process.cwd(),
) {
  const modules = resolve(workspace, 'node_modules'),
    local = relative(modules, resolve(source))
  assert(
    local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep),
    'Production dependency escaped node_modules',
  )
  assert.equal(
    await realpath(source),
    resolve(source),
    'Production dependency must not traverse links or aliases',
  )
  const key = 'node_modules/' + local.replaceAll(sep, '/'),
    locked = packages[key]
  assert(
    locked && locked.link !== true && typeof locked.version === 'string',
    'Production module has no ordinary locked package entry',
  )
  const pkg = await readJson(join(source, 'package.json'), 1024 ** 2)
  assert(
    object(pkg) && pkg.version === locked.version,
    'Installed production module version differs from the lock',
  )
  const expected = await inventory(source)
  await cp(source, destination, { recursive: true })
  assert.deepEqual(await inventory(destination), expected, 'Copied production module bytes differ')
  assert.deepEqual(await inventory(source), expected, 'Production module changed while copying')
  return {
    path: key,
    version: locked.version,
    files: Object.keys(expected).length,
    inventorySha256: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
  }
}

export async function verifyFrozenInstallerInput(appRoot: string, workspace = process.cwd()) {
  const root = resolve(appRoot),
    manifestPath = resolve(root, '../manifest.json')
  const info = await lstat(root)
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    'App root must be an ordinary frozen directory',
  )
  const raw = await readJson(manifestPath)
  assert(
    object(raw) &&
      raw.status === 'built' &&
      typeof raw.previewVersion === 'string' &&
      RELEASE.test(raw.previewVersion) &&
      raw.originalOutputUnchanged === true &&
      typeof raw.appRoot === 'string' &&
      (await realpath(raw.appRoot)) === (await realpath(root)),
    'A successful matching frozen preview is required',
  )
  const build: FrozenBuild = {
    status: 'built',
    previewVersion: raw.previewVersion,
    appRoot: root,
    originalOutputUnchanged: true,
    outputHashes: hashes(raw.outputHashes, true),
    pythonHashes: hashes(raw.pythonHashes, true),
    originalOutputHashes: hashes(raw.originalOutputHashes, false),
  }
  assert.deepEqual(
    await inventory(join(root, 'out')),
    build.outputHashes,
    'Frozen application outputs changed',
  )
  assert.deepEqual(
    await inventory(join(root, 'python')),
    build.pythonHashes,
    'Frozen Python resources changed',
  )
  assert.deepEqual(
    await inventory(resolve(workspace, 'out')),
    build.originalOutputHashes,
    'Protected root out/ changed',
  )
  const pkg = metadata(await readJson(join(root, 'package.json'), 128 * 1024))
  const current = await readJson(resolve(workspace, 'package.json'), 128 * 1024)
  assert(
    object(current) &&
      current.license === 'MIT' &&
      object(current.devDependencies) &&
      typeof current.devDependencies.electron === 'string' &&
      /^\d+\.\d+\.\d+$/.test(current.devDependencies.electron),
    'Expected a locked official Electron runtime',
  )
  assert.equal(
    pkg.version,
    build.previewVersion,
    'Use the delivered preview version, not the ASR kernel package baseline',
  )
  assert.equal(pkg.name, current.name, 'Internal application identity changed')
  assert.deepEqual(
    pkg.dependencies,
    current.dependencies,
    'Frozen preview and installed production dependency locks differ',
  )
  const dependencyPackages = validateInstallerDependencyLock(
    await readJson(resolve(workspace, 'package-lock.json')),
    current,
  )
  for (const name of LEGAL)
    assert.equal(
      await hash(join(root, name)),
      await hash(resolve(workspace, name)),
      `Frozen ${name} changed`,
    )
  return {
    build,
    pkg,
    manifestPath,
    manifestSha256: await hash(manifestPath),
    electronVersion: current.devDependencies.electron,
    lockSha256: await hash(resolve(workspace, 'package-lock.json')),
    packageSha256: await hash(resolve(workspace, 'package.json')),
    frozenPackageSha256: await hash(join(root, 'package.json')),
    dependencyPackages,
  }
}

export function installerConfiguration(raw: unknown, output: string, electronVersion: string) {
  assert(object(raw), 'Invalid builder configuration')
  assert.deepEqual(
    Object.keys(raw).sort(),
    [
      'appId',
      'asar',
      'directories',
      'extraResources',
      'files',
      'npmRebuild',
      'nsis',
      'productName',
      'win',
    ].sort(),
    'Installer entry does not accept hooks, publishers or undeclared builder options',
  )
  assert.equal(raw.appId, 'com.readandlistenbook.desktop', 'Keep the existing installer identity')
  assert.equal(raw.productName, 'PageEcho')
  assert.equal(raw.asar, true)
  assert.equal(raw.npmRebuild, false)
  assert.deepEqual(raw.files, ['out/**/*', 'package.json', ...LEGAL])
  assert.deepEqual(raw.extraResources, [{ from: 'python', to: 'asr', filter: RESOURCE_FILTER }])
  assert.deepEqual(raw.win, {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'PageEcho-${version}-win-${arch}-setup.${ext}',
  })
  assert.deepEqual(
    raw.nsis,
    {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      runAfterFinish: false,
      shortcutName: '听见书页',
    },
    'NSIS must preserve per-user installation, explicit launch and application data',
  )
  return { ...raw, directories: { output }, electronVersion }
}

async function buildInstallerPreview(args: string[]) {
  const options = parseInstallerArguments(args)
  if (!options.planOnly) assertInstallerRunner(process.env)
  const workspace = process.cwd(),
    frozen = await verifyFrozenInstallerInput(options.appRoot, workspace)
  const configSource = resolve(workspace, 'electron-builder.yml'),
    configSha256 = await hash(configSource)
  const require = createRequire(import.meta.url)
  const yaml = require('js-yaml') as { load: (text: string) => unknown }
  const raw = yaml.load(await readFile(configSource, 'utf8'))
  // Validate before allocating a receipt or copying anything.
  installerConfiguration(
    raw,
    resolve(workspace, 'cache/unused-plan-output'),
    frozen.electronVersion,
  )
  const disk = await statfs(workspace)
  assert(
    disk.bavail * disk.bsize > 3 * 1024 ** 3,
    'Isolated NSIS packaging requires at least 3 GiB free',
  )
  const managed = await beginManagedGenerated('package', `installer-${frozen.build.previewVersion}`)
  const directory = managed.directory,
    output = join(directory, 'output'),
    project = join(directory, 'project')
  const report: Record<string, unknown> = {
    status: 'preparing',
    startedAt: new Date().toISOString(),
    directory,
    project,
    output,
    appRoot: frozen.build.appRoot,
    version: frozen.pkg.version,
    electronVersion: frozen.electronVersion,
    appId: 'com.readandlistenbook.desktop',
    buildManifestSha256: frozen.manifestSha256,
    dependencyLockSha256: frozen.lockSha256,
    builderConfigurationSha256: configSha256,
    entryScriptSha256: await hash(fileURLToPath(import.meta.url)),
    sourceCommit: (
      await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
        cwd: workspace,
        windowsHide: true,
        timeout: 10000,
      })
    ).stdout.trim(),
    installerBuilt: false,
    installerExecuted: false,
    applicationExecuted: false,
    upgradeVerified: false,
    uninstallVerified: false,
    cleanDeviceVerified: false,
    scope: options.planOnly
      ? 'Read-only frozen input/configuration plan; no builder or installer executes.'
      : 'Disposable Windows development runner only. NSIS building executes a temporary uninstaller; installer/application lifecycle is a separate opt-in acceptance. No release assets are published.',
  }
  let log = ''
  const save = () =>
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  try {
    await copyFile(fileURLToPath(import.meta.url), join(directory, 'runner-started.ts'))
    const config = installerConfiguration(raw, output, frozen.electronVersion)
    const configPath = join(directory, 'builder.json')
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
    if (options.planOnly) {
      report.status = 'planned'
      return
    }
    const npmCli = process.env.npm_execpath
    assert(
      npmCli && isAbsolute(npmCli),
      'Run through npm exec -- tsx scripts/build/package-installer-preview.ts',
    )
    await mkdir(project)
    await cp(join(options.appRoot, 'out'), join(project, 'out'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
    await cp(join(options.appRoot, 'python'), join(project, 'python'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
    for (const name of LEGAL) await copyFile(join(options.appRoot, name), join(project, name))
    const current = JSON.parse(await readFile('package.json', 'utf8'))
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify(
        {
          ...frozen.pkg,
          description: current.description,
          author: current.author,
          homepage: current.homepage,
          license: 'MIT',
          private: true,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    )
    const result = await promisify(execFile)(
      process.execPath,
      [npmCli, 'ls', '--omit=dev', '--all', '--parseable'],
      { cwd: workspace, windowsHide: true, maxBuffer: 2 * 1024 ** 2, timeout: 60000 },
    )
    const modules = resolve(workspace, 'node_modules'),
      copied: Awaited<ReturnType<typeof copyLockedProductionModule>>[] = []
    for (const source of result.stdout
      .trim()
      .split(/\r?\n/)
      .filter((path) => resolve(path) !== workspace)) {
      const local = relative(modules, resolve(source))
      assert(
        local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep),
        'Production dependency escaped node_modules',
      )
      copied.push(
        await copyLockedProductionModule(
          source,
          join(project, 'node_modules', local),
          frozen.dependencyPackages,
          workspace,
        ),
      )
    }
    report.productionModules = copied
    report.status = 'building'
    await save()
    console.log(
      JSON.stringify({
        stage: 'building-nsis-on-disposable-runner',
        report: join(directory, 'report.json'),
      }),
    )
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
          'nsis',
          '--x64',
          '--publish',
          'never',
        ],
        { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data) => {
          log += String(data)
          process.stdout.write(data)
        })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0
          ? done()
          : reject(new Error(`NSIS builder exited ${code}; no policy bypass was attempted`)),
      )
    })
    const unpacked = join(output, 'win-unpacked'),
      archive = join(unpacked, 'resources/app.asar')
    const names = listPackage(archive, { isPack: false }).map((name) =>
      name.replaceAll('\\', '/').replace(/^\//, ''),
    )
    assert(
      names.every((name) =>
        ['out', 'node_modules', 'package.json', ...LEGAL].includes(name.split('/')[0]!),
      ),
      'Unexpected packaged root; do not include developer or user data',
    )
    const packed = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
    assert.equal(packed.version, frozen.pkg.version)
    assert.equal(packed.name, frozen.pkg.name)
    assert.equal(packed.license, 'MIT')
    for (const [file, digest] of Object.entries(frozen.build.outputHashes))
      assert.equal(
        createHash('sha256')
          .update(extractFile(archive, join('out', file)))
          .digest('hex'),
        digest,
        file,
      )
    for (const name of LEGAL)
      assert.equal(
        createHash('sha256').update(extractFile(archive, name)).digest('hex'),
        await hash(join(options.appRoot, name)),
      )
    assert.deepEqual(
      await inventory(join(unpacked, 'resources/asr')),
      frozen.build.pythonHashes,
      'Installed Python resources differ from the frozen preview',
    )
    const installer = join(output, `PageEcho-${frozen.pkg.version}-win-x64-setup.exe`),
      info = await lstat(installer)
    assert(
      info.isFile() && !info.isSymbolicLink() && info.size > 1024 * 1024,
      'NSIS output is missing or incomplete',
    )
    report.signature = await inspectInstallerSignature(installer)
    report.installer = { path: installer, bytes: info.size, sha256: await hash(installer) }
    report.unpacked = {
      path: unpacked,
      executable: join(unpacked, 'PageEcho.exe'),
      asarSha256: await hash(archive),
    }
    report.installerBuilt = true
    report.status = 'built-and-statically-verified'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    try {
      assert.deepEqual(
        await verifyFrozenInstallerInput(options.appRoot, workspace),
        frozen,
        'Frozen build inputs changed while packaging',
      )
      assert.equal(
        await hash(configSource),
        configSha256,
        'Builder configuration changed while packaging',
      )
      report.originalOutUnchanged = true
    } catch (error) {
      report.status = 'failed'
      report.error = error instanceof Error ? error.stack : String(error)
      process.exitCode = 1
    }
    report.finishedAt = new Date().toISOString()
    await writeFile(join(directory, 'builder.log'), log)
    await save()
    await managed.complete()
    console.log(
      JSON.stringify({
        status: report.status,
        version: report.version,
        report: join(directory, 'report.json'),
        error: report.error,
      }),
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildInstallerPreview(process.argv.slice(2))
