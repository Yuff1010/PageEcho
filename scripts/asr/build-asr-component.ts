import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2),
  options = new Map<string, string>()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]!,
    value = args[index + 1]
  if (
    !['--component', '--output', '--archive'].includes(key) ||
    !value ||
    value.startsWith('--') ||
    options.has(key)
  )
    throw new Error('支持 --component、--output、--archive，每项需要路径。')
  options.set(key, value)
}
const component = resolve(options.get('--component') ?? 'cache/asr-evaluation/component.json')
const config = JSON.parse(await readFile(component, 'utf8')) as { python: string }
const python = resolve(dirname(component), config.python)
const version = (JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string })
  .version
const output = resolve(options.get('--output') ?? `release/asr-component-${version}-win-x64`)
const archive = resolve(options.get('--archive') ?? `release/PageEcho-ASR-${version}-win-x64.zip`)
const source = JSON.parse(await readFile(resolve('python/embedded-python.json'), 'utf8')) as {
  version: string
  url: string
  sha256: string
}
const downloads = resolve('cache/asr-runtime-source')
await mkdir(downloads, { recursive: true })
const zip = join(downloads, `python-${source.version}-embed-amd64.zip`)
let exists = true
try {
  await access(zip)
} catch {
  exists = false
}
if (!exists) {
  const response = await fetch(source.url)
  if (!response.ok) throw new Error('无法下载固定版本的官方 Python 运行时。')
  if (!response.body) throw new Error('Python 运行时下载没有内容。')
  const reader = response.body.getReader(),
    chunks: Buffer[] = []
  let bytes = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.length
    if (bytes > 16777216) {
      await reader.cancel()
      throw new Error('Python 运行时下载大小无效。')
    }
    chunks.push(Buffer.from(result.value))
  }
  const data = Buffer.concat(chunks)
  if (createHash('sha256').update(data).digest('hex') !== source.sha256)
    throw new Error('Python 运行时校验失败。')
  await writeFile(zip, data, { flag: 'wx' })
}
const code = await new Promise<number | null>((done) => {
  const child = spawn(
    python,
    [
      '-B',
      '-X',
      'utf8',
      resolve('python/build_asr_component.py'),
      '--component',
      component,
      '--python-zip',
      zip,
      '--output',
      output,
      '--archive',
      archive,
    ],
    { shell: false, windowsHide: true, stdio: 'inherit' },
  )
  child.once('error', (error) => {
    console.error(error)
    done(1)
  })
  child.once('close', done)
})
process.exitCode = code ?? 1
