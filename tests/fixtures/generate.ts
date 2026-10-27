// Development only. The app never launches or distributes FFmpeg.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'

const executable = process.env.RALB_FFMPEG
if (!executable) throw new Error('Set RALB_FFMPEG to an absolute FFmpeg executable path.')
const metadata = resolve('tests/fixtures/chapters.ffmetadata')
writeFileSync(
  metadata,
  ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=10000\ntitle=Part 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=10000\nEND=20000\ntitle=Part 2\n',
)
try {
  for (const format of ['mp3', 'm4a', 'm4b']) {
    const result = spawnSync(
      executable,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=22050:cl=mono',
        ...(format === 'm4b' ? ['-i', metadata, '-map_metadata', '1', '-map_chapters', '1'] : []),
        '-t',
        '20',
        '-c:a',
        format === 'mp3' ? 'libmp3lame' : 'aac',
        '-b:a',
        '32k',
        ...(format === 'mp3' ? [] : ['-movflags', '+faststart']),
        resolve(`tests/fixtures/tone.${format}`),
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message)
  }
} finally {
  unlinkSync(metadata)
}
