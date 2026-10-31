import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve('cache/asr-evaluation')
const samples = JSON.parse(await readFile(join(root, 'samples.json'), 'utf8')) as {
  tools: { ffmpeg: string; ffprobe: string }
}
await realpath(join(root, 'venv/Scripts/python.exe'))
await realpath(join(root, 'models.json'))
const output = join(root, 'component.json')
await writeFile(
  output,
  JSON.stringify(
    {
      version: 1,
      python: 'venv/Scripts/python.exe',
      models: 'models.json',
      cache: '.',
      ffmpeg: samples.tools.ffmpeg,
      ffprobe: samples.tools.ffprobe,
    },
    null,
    2,
  ),
  'utf8',
)
console.log(`在应用的“伴读阅读 → 生成转写稿 → 选择组件配置”中选择：${output}`)
