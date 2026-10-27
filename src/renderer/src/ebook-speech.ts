import type { EbookSpeechApi, EbookSpeechAudio, EbookSpeechVoice } from '../../shared/ebook-speech'
import type { ReaderAnchor } from './reader-layout'

export interface EbookSpeechState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  anchor: ReaderAnchor | null
  voices: EbookSpeechVoice[]
  voice: string
  rate: number
  message: string
}
type SpeechPreferences = { voice: string; rate: number }
const PREFERENCES_KEY = 'ralb:ebook-speech:v1'
function preferences(): SpeechPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as SpeechPreferences
    return {
      voice: typeof value.voice === 'string' ? value.voice : '',
      rate: [0.75, 1, 1.25, 1.5, 2].includes(value.rate) ? value.rate : 1,
    }
  } catch {
    return { voice: '', rate: 1 }
  }
}

export function stopNarrationOnRecordedPlayback(
  speech: Pick<EbookSpeechPlayer, 'getSnapshot' | 'stop'>,
  recording: {
    getSnapshot: () => { playing: boolean }
    subscribe: (listener: () => void) => () => void
  },
): () => void {
  let previouslyPlaying = recording.getSnapshot().playing
  return recording.subscribe(() => {
    const playing = recording.getSnapshot().playing
    const started = playing && !previouslyPlaying
    previouslyPlaying = playing
    if (started && ['loading', 'playing', 'paused'].includes(speech.getSnapshot().status))
      speech.stop()
  })
}

/** A sentence-sized native WAV player, independent of ASR and recorded audio. */
export class EbookSpeechPlayer {
  private state: EbookSpeechState = {
    status: 'idle',
    anchor: null,
    voices: [],
    ...preferences(),
    message: '',
  }
  private listeners = new Set<() => void>()
  private generation = 0
  private wantingPlayback = false
  private bookId = ''
  private current: EbookSpeechAudio | null = null
  private prefetched: { anchor: ReaderAnchor; value: Promise<EbookSpeechAudio> } | null = null
  private follow: (anchor: ReaderAnchor) => void = () => {}
  private audio: HTMLAudioElement
  constructor(
    private api: EbookSpeechApi,
    createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {
    this.audio = createAudio()
    this.audio.preload = 'auto'
    this.audio.playbackRate = this.state.rate
    this.audio.onplaying = () => {
      if (this.wantingPlayback) this.patch({ status: 'playing', message: '正在朗读原文' })
    }
    this.audio.onended = () => {
      if (!this.wantingPlayback) return
      if (this.current?.next) void this.load(this.current.next, this.generation)
      else {
        this.wantingPlayback = false
        this.patch({ status: 'ended', message: '本书已朗读完。' })
      }
    }
    this.audio.onerror = () => {
      if (this.wantingPlayback) this.fail('朗读音频无法播放，点击播放可重试。')
    }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private patch(change: Partial<EbookSpeechState>) {
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener())
  }
  attach(bookId: string, follow: (anchor: ReaderAnchor) => void) {
    this.bookId = bookId
    this.follow = follow
  }
  private fail(message: string) {
    this.wantingPlayback = false
    this.audio.pause()
    this.patch({ status: 'error', message })
  }
  async start(anchor: ReaderAnchor) {
    const same =
      this.state.status === 'paused' &&
      this.state.anchor?.ordinal === anchor.ordinal &&
      this.state.anchor.offset === anchor.offset &&
      this.current &&
      !!this.audio.src
    this.wantingPlayback = true
    const generation = ++this.generation
    if (same) {
      try {
        this.patch({ status: 'loading', message: '正在继续朗读…' })
        await this.audio.play()
      } catch {
        if (generation === this.generation && this.wantingPlayback)
          this.fail('朗读未能开始，请再次点击播放。')
      }
      return
    }
    this.audio.pause()
    this.prefetched = null
    this.current = null
    this.patch({ status: 'loading', anchor, message: '正在准备系统声音…' })
    try {
      const voices = await this.api.getEbookSpeechVoices()
      if (generation !== this.generation) return
      if (!voices.ok) throw new Error(voices.error.message)
      if (!voices.value.available) throw new Error(voices.value.message)
      const selected =
        voices.value.voices.find((voice) => voice.id === this.state.voice) ??
        voices.value.voices.find((voice) => voice.language.toLowerCase().startsWith('zh')) ??
        voices.value.voices[0]
      if (!selected) throw new Error('Windows 尚未安装可用的朗读声音。')
      this.patch({ voices: voices.value.voices, voice: selected.id })
      await this.load(anchor, generation)
    } catch (error) {
      if (generation === this.generation && this.wantingPlayback)
        this.fail(error instanceof Error ? error.message : '系统朗读不可用，请重试。')
    }
  }
  private async request(anchor: ReaderAnchor) {
    const result = await this.api.synthesizeEbookSpeech({
      id: this.bookId,
      ordinal: anchor.ordinal,
      offset: anchor.offset,
      voice: this.state.voice || undefined,
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  private async load(anchor: ReaderAnchor, generation: number) {
    if (generation !== this.generation || !this.wantingPlayback) return
    this.current = null
    this.patch({ status: 'loading', message: '正在准备下一句…' })
    try {
      const cached = this.prefetched
      this.prefetched = null
      const chunk = await (cached?.anchor.ordinal === anchor.ordinal &&
      cached.anchor.offset === anchor.offset
        ? cached.value
        : this.request(anchor))
      if (generation !== this.generation || !this.wantingPlayback) return
      this.current = chunk
      this.audio.src = chunk.url
      this.audio.playbackRate = this.state.rate
      this.patch({ anchor })
      this.follow(anchor)
      await this.audio.play()
      if (generation !== this.generation || !this.wantingPlayback) return
      if (chunk.next) {
        const next = chunk.next
        // At most one next sentence is prepared, never the entire book.
        const value = this.request(next)
        void value.catch(() => {})
        this.prefetched = { anchor: next, value }
      }
    } catch (error) {
      if (generation === this.generation && this.wantingPlayback)
        this.fail(error instanceof Error ? error.message : '这一句朗读未完成，请重试。')
    }
  }
  pause(message = '朗读已暂停') {
    if (!['playing', 'loading'].includes(this.state.status)) return
    this.wantingPlayback = false
    this.audio.pause()
    if (this.current && this.audio.src) this.patch({ status: 'paused', message })
    else {
      this.generation++
      this.prefetched = null
      this.patch({ status: 'paused', message })
    }
  }
  stop() {
    this.generation++
    this.wantingPlayback = false
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.prefetched = null
    this.current = null
    this.patch({ status: 'idle', anchor: null, message: '' })
    void this.api.releaseEbookSpeech().catch(() => {})
  }
  setRate(rate: number) {
    if (![0.75, 1, 1.25, 1.5, 2].includes(rate)) return
    this.audio.playbackRate = rate
    this.patch({ rate })
    this.persist()
  }
  setVoice(voice: string) {
    if (!this.state.voices.some((item) => item.id === voice)) return
    const anchor = this.state.anchor
    const playing = this.wantingPlayback
    this.generation++
    this.wantingPlayback = false
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.current = null
    this.prefetched = null
    this.patch({ voice, status: anchor ? 'paused' : 'idle' })
    this.persist()
    if (playing && anchor) void this.start(anchor)
  }
  private persist() {
    try {
      localStorage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ voice: this.state.voice, rate: this.state.rate }),
      )
    } catch {
      /* Playback remains usable without preferences. */
    }
  }
}
