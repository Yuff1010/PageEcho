// A self-contained distribution using the unchanged official Electron executable.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Readable } from 'node:stream'
import { crc32, deflateRawSync } from 'node:zlib'
import { createPackage, extractFile } from '@electron/asar'
import unzipper from 'unzipper'

assert.equal(process.argv[2], '--app-root')
assert.equal(process.argv.length, 4)
const appRoot = resolve(process.argv[3]!)
const manifest = JSON.parse(await readFile(resolve(appRoot, '../manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
const digest = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
for (const [path, expected] of Object.entries(manifest.outputHashes))
  assert.equal(await digest(join(appRoot, 'out', path)), expected)
const stamp = new Date().toISOString().replaceAll(':', '-')
const staging = resolve('cache/handoff-builds', stamp)
const bundle = join(staging, 'application')
const destination = resolve('release', `ReadAndListenBook-${pkg.version}-${stamp}-win-x64`)
await mkdir(bundle, { recursive: true })
await mkdir(destination, { recursive: true })
await cp(resolve('scripts/build/package-handoff.ts'), join(staging, 'runner-started.ts'))
await cp(join(appRoot, 'out'), join(bundle, 'out'), { recursive: true })
await writeFile(join(bundle, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
await cp(resolve('THIRD_PARTY_NOTICES.md'), join(bundle, 'THIRD_PARTY_NOTICES.md'))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run through npm run pack:handoff')
const dependencies = await promisify(execFile)(
  process.execPath,
  [npmCli, 'ls', '--omit=dev', '--all', '--parseable'],
  { windowsHide: true },
)
for (const source of dependencies.stdout
  .trim()
  .split(/\r?\n/)
  .filter((path) => resolve(path) !== process.cwd())) {
  const path = relative(resolve('node_modules'), resolve(source))
  assert.ok(path && !path.startsWith('..') && !resolve(source).includes('..'))
  await cp(source, join(bundle, 'node_modules', path), { recursive: true })
}
const runtime = join(destination, 'runtime')
await cp(resolve('node_modules/electron/dist'), runtime, {
  recursive: true,
  filter: (source) => !source.endsWith('default_app.asar'),
})
await mkdir(join(runtime, 'resources'), { recursive: true })
const archive = join(runtime, 'resources/app.asar')
async function checkRegularFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await checkRegularFiles(path)
    else assert.ok(entry.isFile(), `Application cannot contain links or special files: ${path}`)
  }
}
await checkRegularFiles(bundle)
await createPackage(bundle, archive)
await cp(join(appRoot, 'python'), join(runtime, 'resources/asr'), { recursive: true })
for (const [path, expected] of Object.entries(manifest.pythonHashes))
  assert.equal(await digest(join(runtime, 'resources/asr', path)), expected)
assert.equal(
  await digest(join(runtime, 'electron.exe')),
  await digest(resolve('node_modules/electron/dist/electron.exe')),
)
for (const [path, expected] of Object.entries(manifest.outputHashes))
  assert.equal(
    createHash('sha256')
      .update(extractFile(archive, join('out', path)))
      .digest('hex'),
    expected,
  )
const launcher = (data: string) =>
  [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "RALB_USER_DATA=%APPDATA%\\${data}"`,
    'set "ELECTRON_RUN_AS_NODE="',
    'set "ELECTRON_RENDERER_URL="',
    'set "NODE_OPTIONS="',
    'start "" "%~dp0runtime\\electron.exe"',
    'exit /b 0',
    '',
  ].join('\r\n')
await writeFile(join(destination, 'start.cmd'), launcher('ReadAndListenBook-standalone'))
await writeFile(
  join(destination, 'continue-preview.cmd'),
  launcher('ReadAndListenBook-preview-0.13'),
)
await cp(resolve('THIRD_PARTY_NOTICES.md'), join(destination, 'THIRD_PARTY_NOTICES.md'))
await writeFile(
  join(destination, 'README.txt'),
  `听读 ${pkg.version}\r\n\r\n首次使用：解压完整目录，双击 start.cmd。无需安装 Node.js、Python 或工作区依赖。\r\n继续当前预览书架：先退出旧预览，再双击 continue-preview.cmd，沿用原预览数据。请先备份 %APPDATA%\\ReadAndListenBook-preview-0.13。\r\n普通听书、电子书阅读、导入已有字幕不需要模型。AI 字幕仍需在应用中选择离线组件 ZIP 或已解压的组件目录。\r\n这是包含官方 Electron 运行时的完整目录版；保留 electron.exe 原文件名与字节，没有创建 NSIS 安装器或修改系统安全策略。\r\n可移动整个程序目录；移除目录不会删除位于 APPDATA 的书架数据。\r\n本机隔离运行验证与全新 Windows 设备验收分别记录；不将本机测试称为干净设备验收。\r\n`,
)
const files: Record<string, string> = {}
async function inventory(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await inventory(path)
    else if (entry.isFile())
      files[relative(destination, path).replaceAll('\\', '/')] = await digest(path)
    else throw new Error(`Distribution cannot contain links or special files: ${path}`)
  }
}
await inventory(destination)
await writeFile(join(destination, 'SHA256.json'), JSON.stringify(files, null, 2) + '\n')
const zipPath = destination + '.zip'
// The main application is well below classic ZIP limits. Write each file in
// sequence so packaging needs neither a shell script nor another executable.
const names = [...Object.keys(files), 'SHA256.json'].sort()
assert.ok(names.length < 65535, 'This distribution exceeds the classic ZIP entry limit')
const zipOutput = await open(zipPath, 'wx')
const centralRecords: Buffer[] = []
let offset = 0
try {
  for (const path of names) {
    const name = Buffer.from(path, 'utf8')
    const bytes = await readFile(join(destination, path))
    const compressed = deflateRawSync(bytes, { level: 6 })
    assert.ok(
      bytes.length < 0xffffffff && compressed.length < 0xffffffff && offset < 0xffffffff,
      'This distribution exceeds classic ZIP size limits',
    )
    const checksum = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(33, 12) // Stable 1980-01-01 timestamps make archives reproducible.
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    await zipOutput.writeFile(local)
    await zipOutput.writeFile(name)
    await zipOutput.writeFile(compressed)
    centralRecords.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const central = Buffer.concat(centralRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  await zipOutput.writeFile(central)
  await zipOutput.writeFile(end)
} finally {
  await zipOutput.close()
}
const opener = unzipper.Open as unknown as {
  file(path: string): Promise<{ files: { path: string; stream(): Readable }[] }>
}
const checkedZip = await opener.file(zipPath)
const zipNames = new Set<string>()
for (const entry of checkedZip.files) {
  const path = entry.path.replaceAll('\\', '/')
  if (path.endsWith('/')) continue
  assert.ok(!zipNames.has(path), `Duplicate ZIP entry: ${path}`)
  assert.ok(path === 'SHA256.json' || Object.hasOwn(files, path), `Unknown ZIP entry: ${path}`)
  zipNames.add(path)
  const hash = createHash('sha256')
  for await (const chunk of entry.stream()) hash.update(chunk)
  assert.equal(
    hash.digest('hex'),
    path === 'SHA256.json' ? await digest(join(destination, 'SHA256.json')) : files[path],
  )
}
assert.equal(
  zipNames.size,
  Object.keys(files).length + 1,
  'ZIP must contain the complete directory',
)
const report = {
  status: 'built-and-byte-verified',
  version: pkg.version,
  appRoot,
  destination,
  executablePath: join(runtime, 'electron.exe'),
  zipPath,
  zipSha256: await digest(zipPath),
  files: Object.keys(files).length,
  zipEntriesVerified: zipNames.size,
  archiveImplementation: 'Node.js classic ZIP, UTF-8, deflate, CRC32; every entry SHA-256 checked',
  officialExecutableUnchanged: true,
  developmentRuntimeRequired: false,
  packagedApplicationExecuted: false,
  cleanDeviceVerified: false,
  installerBuilt: false,
}
await writeFile(join(staging, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, report: join(staging, 'report.json') }))
