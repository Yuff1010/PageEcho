import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, mkdir, writeFile, realpath, stat, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { cpus, totalmem, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareChapters, scanBook } from '../../src/main/files'
import { AUDIO_EXTENSIONS } from '../../src/shared/contracts'

const execute = promisify(execFile)
const [source, flag, probePath] = process.argv.slice(2)
if (!source || flag !== '--ffprobe' || !probePath || process.argv.length !== 5)
  throw new Error('用法：npm run asr:prepare -- <音频文件夹> --ffprobe <ffprobe.exe 路径>')
const folder = await realpath(resolve(source))
const probe = await realpath(resolve(probePath))
const ffmpeg = await realpath(
  join(dirname(probe), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
)
const root = fileURLToPath(new URL('../..', import.meta.url))
const output = join(root, 'cache', 'asr-evaluation')
await mkdir(output, { recursive: true })
const candidates = (await readdir(folder, { withFileTypes: true }))
  .filter(
    (item) =>
      item.isFile() &&
      AUDIO_EXTENSIONS.some((extension) => item.name.toLowerCase().endsWith(`.${extension}`)),
  )
  .map((item) => item.name)
  .sort(compareChapters)
if (!candidates.length)
  throw new Error('文件夹顶层没有可评估的普通音频文件；不扫描应用资源或加密缓存。')
const samples = []
for (const name of candidates.slice(0, 3)) {
  const book = await scanBook(join(folder, name), 'file')
  const audio = book.episodes[0]!
  const { stdout } = await execute(
    probe,
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'format=duration:stream=codec_name,sample_rate,channels',
      '-of',
      'json',
      audio.path,
    ],
    { windowsHide: true, maxBuffer: 256 * 1024 },
  )
  const metadata = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_name: string; sample_rate: string; channels: number }[]
  }
  const durationMs = Math.round(Number(metadata.format?.duration) * 1000)
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !metadata.streams?.[0])
    throw new Error(`无法读取音频时长或编码：${name}`)
  const startMs = Math.min(30000, Math.max(0, durationMs - 60000))
  const endMs = Math.min(durationMs, startMs + 60000)
  const clipPath = join(output, `${audio.contentHash.slice(0, 16)}-${startMs}-${endMs}.wav`)
  const temporaryClip = join(output, `${randomUUID()}.tmp.wav`)
  await execute(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(startMs / 1000),
      '-i',
      audio.path,
      '-t',
      String((endMs - startMs) / 1000),
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      temporaryClip,
    ],
    { windowsHide: true, maxBuffer: 256 * 1024 },
  )
  const after = await stat(audio.path)
  if (!after.isFile() || after.size !== audio.sizeBytes || after.mtimeMs !== audio.modifiedAt)
    throw new Error(`音频在样本准备期间发生变化，请重新准备：${name}`)
  await rename(temporaryClip, clipPath)
  samples.push({
    id: audio.contentHash,
    title: name,
    sourcePath: audio.path,
    sizeBytes: audio.sizeBytes,
    modifiedAt: audio.modifiedAt,
    durationMs,
    codec: metadata.streams[0],
    clip: { path: clipPath, startMs, endMs, timeBasis: 'original-media-ms' },
    category: 'user-provided-song',
    referenceTranscript: null,
  })
  console.log(
    `已准备第 ${samples.length} 个歌曲样本：${Math.round(durationMs / 1000)} 秒，评估片段 ${(endMs - startMs) / 1000} 秒。`,
  )
}
let gpu: string | null = null
if (process.platform === 'win32') {
  try {
    gpu = (
      await execute(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
        ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
        { windowsHide: true },
      )
    ).stdout.trim()
  } catch {
    /* CPU evaluation remains available; do not infer a GPU from its absence. */
  }
}
const ffmpegVersion = (await execute(ffmpeg, ['-version'], { windowsHide: true })).stdout.split(
  /\r?\n/,
)[0]
const manifest = {
  version: 1,
  preparedAt: new Date().toISOString(),
  sourceDirectory: folder,
  device: {
    cpu: cpus()[0]?.model.trim(),
    logicalCpus: cpus().length,
    physicalMemoryBytes: totalmem(),
    osRelease: release(),
    gpu,
  },
  tools: { ffmpeg, ffprobe: probe, ffmpegVersion },
  candidates: candidates.length,
  samples,
  limitations: [
    '歌曲用于音乐背景评估，不能替代干声、多人对话与长篇听书样本。',
    '歌曲尚无人工参考文字；实际识别/对齐评估状态以 runs/ 下的各次报告为准。',
  ],
}
const manifestPath = join(output, 'samples.json')
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`样本清单：${manifestPath}。本命令只准备样本，识别结果见 runs/ 下的评估报告。`)
