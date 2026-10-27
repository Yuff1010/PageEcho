import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { AUDIO_EXTENSIONS } from '../../src/shared/contracts'
import { compareChapters } from '../../src/main/files'

const execute = promisify(execFile)
function placeholder(value: string) {
  const text = value.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '')
  return (
    !text || /^(暂无歌词|纯音乐|纯音乐，请欣赏|此歌曲为没有填词的纯音乐|no lyrics)$/i.test(text)
  )
}
export async function inspectListeningSources(directory: string, ffprobe: string) {
  const root = await realpath(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        AUDIO_EXTENSIONS.some((extension) => extname(entry.name).toLowerCase() === `.${extension}`),
    )
    .sort((a, b) => compareChapters(a.name, b.name))
  if (!files.length || files.length > 10000)
    throw new Error('连续验收需要文件夹顶层的普通音频文件，最多 10,000 个。')
  const tracks = []
  for (const file of files) {
    const path = join(root, file.name),
      info = await stat(path)
    const { stdout } = await execute(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'format=format_name,duration:format_tags:stream=codec_name,sample_rate,channels',
        '-of',
        'json',
        path,
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 },
    )
    const metadata = JSON.parse(stdout) as {
      format?: { format_name: string; duration: string; tags?: Record<string, string> }
      streams?: { codec_name: string; sample_rate: string; channels: number }[]
    }
    const durationMs = Math.round(Number(metadata.format?.duration) * 1000),
      stream = metadata.streams?.[0]
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !stream)
      throw new Error('音频编码或时长无法读取。')
    const tags = metadata.format?.tags ?? {}
    const referenceFields = Object.fromEntries(
      Object.entries(tags)
        .filter(([key, value]) => /lyric|transcript|subtitle/i.test(key) && !placeholder(value))
        .map(([key, value]) => [key, value.length]),
    )
    tracks.push({
      name: file.name,
      sourcePath: path,
      sizeBytes: info.size,
      modifiedAt: info.mtimeMs,
      durationMs,
      format: metadata.format!.format_name,
      stream,
      tagKeys: Object.keys(tags),
      referenceFields,
    })
  }
  const sidecars = []
  for (const file of entries.filter(
    (entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.lrc',
  )) {
    const path = join(root, file.name),
      info = await stat(path)
    if (info.size > 1024 * 1024) {
      sidecars.push({ name: file.name, bytes: info.size, status: 'too-large-not-read' })
      continue
    }
    const text = await readFile(path, 'utf8')
    sidecars.push({
      name: file.name,
      bytes: info.size,
      status: placeholder(text) ? 'placeholder-no-reference' : 'candidate-needs-human-verification',
    })
  }
  return {
    sourceDirectory: root,
    tracks,
    sidecars,
    referenceCandidates:
      tracks.filter((track) => Object.keys(track.referenceFields).length).length +
      sidecars.filter((sidecar) => sidecar.status === 'candidate-needs-human-verification').length,
    referencePolicy:
      'embedded text and sidecars are candidates only; never automatically accepted as accuracy ground truth',
  }
}
