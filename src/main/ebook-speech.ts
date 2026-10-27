import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseRange } from './media'
import type { ReadingStore } from './reading-store'
import type {
  EbookSpeechAudio,
  EbookSpeechRequest,
  EbookSpeechVoice,
  EbookSpeechVoices,
} from '../shared/ebook-speech'

export const SPEECH_MEDIA_PREFIX = 'readlisten://app/speech/'
const MAX_TEXT = 600
const MAX_AUDIO_BYTES = 12 * 1024 * 1024
// Constant program; book text is JSON on stdin and is never evaluated as code.
// Uses Windows' installed offline voices. No .ps1, policy changes or downloads.
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  while (($line = [Console]::ReadLine()) -ne $null) {
    $memory = $null
    try {
      $request = ConvertFrom-Json $line
      if ($request.type -eq 'voices') {
        $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
          @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
        })
        $result = @{ voices = $voices }
      } elseif ($request.type -eq 'speak') {
        $synth.SelectVoice([string]$request.voice)
        $synth.Rate = 0
        $memory = New-Object System.IO.MemoryStream
        $synth.SetOutputToWaveStream($memory)
        $synth.Speak([string]$request.text)
        $synth.SetOutputToNull()
        $result = @{ audio = [Convert]::ToBase64String($memory.ToArray()) }
      } else { throw 'Unsupported speech command' }
      [Console]::WriteLine((ConvertTo-Json -Compress -Depth 5 $result))
    } catch {
      [Console]::WriteLine((ConvertTo-Json -Compress @{ error = 'System voice could not prepare this sentence.' }))
    } finally {
      if ($memory) { $memory.Dispose() }
    }
  }
} finally { $synth.Dispose() }
`

type WorkerResponse = { voices?: EbookSpeechVoice[]; audio?: string; error?: string }
export class EbookSpeech {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending: {
    resolve: (value: WorkerResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private output = ''
  private voices: EbookSpeechVoice[] | null = null
  private audio = new Map<string, Buffer>()
  private serial: Promise<unknown> = Promise.resolve()
  private generation = 0
  private closed = false

  constructor(private reading: Pick<ReadingStore, 'get' | 'page'>) {}

  private process() {
    if (this.closed) throw new Error('朗读已关闭。')
    if (process.platform !== 'win32') throw new Error('本地朗读当前需要 Windows 系统声音。')
    if (this.child) return this.child
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROGRAM],
      { windowsHide: true, stdio: 'pipe' },
    )
    this.child = child
    this.output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      this.output += chunk
      if (this.output.length > MAX_AUDIO_BYTES * 1.4) {
        this.stopWorker(new Error('这一段朗读过长，请从下一句重试。'))
        return
      }
      let end: number
      while ((end = this.output.indexOf('\n')) >= 0) {
        const line = this.output.slice(0, end).trim()
        this.output = this.output.slice(end + 1)
        if (!line) continue
        const pending = this.pending
        if (!pending) continue
        this.pending = null
        clearTimeout(pending.timer)
        try {
          const value = JSON.parse(line) as WorkerResponse
          if (value.error) pending.reject(new Error('系统声音无法生成朗读，请重试或选择另一声音。'))
          else pending.resolve(value)
        } catch {
          pending.reject(new Error('系统朗读返回了无效结果。'))
        }
      }
    })
    child.stderr.resume()
    const failed = () => {
      if (this.child === child)
        this.stopWorker(new Error('系统朗读不可用，请检查 Windows 语音设置。'))
    }
    child.once('error', failed)
    child.once('exit', failed)
    return child
  }
  private command(value: object): Promise<WorkerResponse> {
    const child = this.process()
    if (this.pending) throw new Error('正在准备上一段朗读。')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.stopWorker(new Error('系统声音准备超时，点击播放可以重试。')),
        30_000,
      )
      this.pending = { resolve, reject, timer }
      child.stdin.write(JSON.stringify(value) + '\n', 'utf8', (error) => {
        if (error && this.child === child) this.stopWorker(new Error('无法连接系统朗读服务。'))
      })
    })
  }
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const result = this.serial
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.generation || this.closed) throw new Error('朗读已停止。')
        return action()
      })
    this.serial = result
    return result
  }
  private async readVoices(): Promise<EbookSpeechVoice[]> {
    if (this.voices) return this.voices
    const result = await this.command({ type: 'voices' })
    if (!Array.isArray(result.voices)) throw new Error('无法读取系统声音。')
    const voices = result.voices.filter(
      (voice) =>
        typeof voice.id === 'string' &&
        voice.id.length <= 300 &&
        typeof voice.name === 'string' &&
        typeof voice.language === 'string',
    )
    // A user can install a Windows voice while this app remains open.
    // An empty result must remain retryable rather than becoming a session cache.
    this.voices = voices.length ? voices : null
    if (!voices.length) this.stopWorker()
    return voices
  }
  available(): Promise<EbookSpeechVoices> {
    return this.queue(async () => {
      try {
        const voices = await this.readVoices()
        return {
          available: !!voices.length,
          voices,
          message: voices.length
            ? '使用 Windows 本地声音，原文直接跟读。'
            : 'Windows 尚未安装可用声音，请在系统语音设置中添加声音后重试。',
        }
      } catch (error) {
        return {
          available: false,
          voices: [],
          message: error instanceof Error ? error.message : '系统朗读暂不可用。',
        }
      }
    })
  }
  synthesize(request: EbookSpeechRequest): Promise<EbookSpeechAudio> {
    return this.queue(async () => {
      const generation = this.generation
      const book = this.reading.get(request.id)
      if (request.ordinal >= book.sentenceCount) throw new Error('朗读位置超出本书范围。')
      const sentence = this.reading.page(request.id, request.ordinal).sentences[0]
      if (!sentence || request.offset >= sentence.text.length)
        throw new Error('朗读字符位置已经变化，请重新选择正文位置。')
      const endOffset = Math.min(sentence.text.length, request.offset + MAX_TEXT)
      const text = sentence.text.slice(request.offset, endOffset)
      const voices = await this.readVoices()
      const voice = request.voice
        ? voices.find((item) => item.id === request.voice)
        : (voices.find((item) => item.language.toLowerCase().startsWith('zh')) ?? voices[0])
      if (!voice) throw new Error('选用的系统声音不可用，请重新选择。')
      const result = await this.command({ type: 'speak', text, voice: voice.id })
      if (generation !== this.generation) throw new Error('朗读已停止。')
      if (typeof result.audio !== 'string') throw new Error('系统声音未生成音频。')
      const buffer = Buffer.from(result.audio, 'base64')
      if (
        buffer.length < 44 ||
        buffer.length > MAX_AUDIO_BYTES ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WAVE'
      )
        throw new Error('系统声音生成的音频无效。')
      this.reading.get(request.id) // Do not expose results for a removed ebook.
      const token = randomUUID()
      this.audio.set(token, buffer)
      while (this.audio.size > 3) this.audio.delete(this.audio.keys().next().value!)
      return {
        url: SPEECH_MEDIA_PREFIX + token,
        ordinal: request.ordinal,
        offset: request.offset,
        endOffset,
        next:
          endOffset < sentence.text.length
            ? { ordinal: request.ordinal, offset: endOffset }
            : request.ordinal + 1 < book.sentenceCount
              ? { ordinal: request.ordinal + 1, offset: 0 }
              : null,
      }
    })
  }
  serve(request: Request, rendererOrigin: string): Response {
    const url = new URL(request.url)
    const token = url.pathname.slice('/speech/'.length)
    if (
      !request.url.startsWith(SPEECH_MEDIA_PREFIX) ||
      !/^[0-9a-f-]{36}$/.test(token) ||
      url.search ||
      url.username ||
      url.password
    )
      return new Response(null, { status: 403 })
    const audio = this.audio.get(token)
    if (!audio) return new Response(null, { status: 404 })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
    const rangeHeader = request.headers.get('range')
    const range = parseRange(rangeHeader, audio.length)
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${audio.length}` },
      })
    const headers: Record<string, string> = {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.end - range.start + 1),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': rendererOrigin,
    }
    if (rangeHeader) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${audio.length}`
    return new Response(
      request.method === 'HEAD' ? null : new Uint8Array(audio.subarray(range.start, range.end + 1)),
      { status: rangeHeader ? 206 : 200, headers },
    )
  }
  private stopWorker(error = new Error('朗读已停止。')) {
    const child = this.child
    this.child = null
    this.output = ''
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
    if (child) {
      child.stdin.destroy()
      child.kill()
    }
  }
  release(): void {
    this.generation++
    this.audio.clear()
    this.stopWorker()
  }
  close(): void {
    this.closed = true
    this.release()
  }
}
