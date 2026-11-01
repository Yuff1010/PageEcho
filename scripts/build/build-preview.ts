// Build into a fresh cache directory while long tests keep their original out/ files.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { beginManagedGenerated } from './managed-generated'

const args = process.argv.slice(2)
if (
  args.length &&
  (args.length !== 2 || args[0] !== '--version' || !/^\d+\.\d+\.\d+-dev\.\d+$/.test(args[1]!))
)
  throw new Error('Usage: npm run build:preview -- [--version 0.10.0-dev.6]')
const previewVersion = args[1] ?? '0.10.0-dev.6'

async function inventory(root: string) {
  const files: Record<string, string> = {}
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile())
        files[relative(root, path).replaceAll(sep, '/')] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
    }
  }
  await walk(root)
  return files
}
const original = await inventory(resolve('out'))
const managed = await beginManagedGenerated('build', `preview-${previewVersion}`)
try {
  const directory = managed.directory
  const appRoot = join(directory, 'app'),
    output = join(appRoot, 'out')
  await mkdir(appRoot, { recursive: true })
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve('node_modules/electron-vite/bin/electron-vite.js'), 'build', '--outDir', output],
      { stdio: 'inherit', windowsHide: true },
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`Preview build exited ${code}`)),
    )
  })
  const after = await inventory(resolve('out'))
  if (JSON.stringify(original) !== JSON.stringify(after))
    throw new Error('The original out/ changed during an isolated preview build')
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  await writeFile(
    join(appRoot, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: previewVersion,
        type: 'module',
        main: './out/main/index.js',
        dependencies: pkg.dependencies,
      },
      null,
      2,
    ) + '\n',
  )
  await mkdir(join(appRoot, 'python'))
  for (const name of await readdir('python'))
    if (/^asr_.*\.py$/.test(name) || name === 'evaluation-models.json')
      await copyFile(join('python', name), join(appRoot, 'python', name))
  const report = {
    previewVersion,
    status: 'built',
    createdAt: new Date().toISOString(),
    appRoot,
    sourceHashes: await inventory(resolve('src')),
    outputHashes: await inventory(output),
    pythonHashes: await inventory(join(appRoot, 'python')),
    originalOutputUnchanged: true,
    originalOutputHashes: original,
    scope: 'Isolated development preview, no packaged EXE or installer execution.',
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    JSON.stringify({ status: report.status, appRoot, manifest: join(directory, 'manifest.json') }),
  )
} finally {
  await managed.complete()
}
