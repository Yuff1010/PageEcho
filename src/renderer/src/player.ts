import type {
  AppState,
  Book,
  Episode,
  PlaybackSource,
  ProgressUpdate,
  Result,
} from '../../shared/contracts'
import { listeningRange, type Bookmark, type SleepTimer } from '../../shared/listening'
import {
  subtitleBufferState,
  subtitleCoveredUntil,
  SubtitleThroughput,
  type SubtitleBufferOptions,
} from '../../shared/subtitle-preparation'
import type {
  AutomaticSubtitlesResult,
  TranscriptionState,
  TranscriptionSummaryState,
} from '../../shared/transcription'
import {
  subtitleStatusFromTranscription,
  type SubtitleStatusSnapshot,
} from '../../shared/subtitle-status'

export interface PlayerState {
  episode: Episode | null
  bookTitle: string
  positionMs: number
  durationMs: number
  rate: number
  volume: number
  playing: boolean
  loading: boolean
  ready: boolean
  error: string
  saveError: string
  sleepTimer: SleepTimer
  sleepRemainingMs: number
  timerNotice: string
  skipNotice: string
  subtitleWaiting: boolean
  subtitleNotice: string
  subtitleStatus: SubtitleStatusSnapshot | null
  subtitleSetupNeeded: boolean
  subtitlePreparationPhase: AutomaticSubtitlesResult['status'] | 'idle' | 'checking' | 'canceling'
}
type PreparedSubtitlesResult = AutomaticSubtitlesResult & { library: AppState }

class PlayerController {
  readonly audio = document.createElement('audio')
  private source: PlaybackSource | null = null
  private books: Book[] = []
  private generation = 0
  private navigation = 0
  private openingId: string | null = null
  private switching = false
  private initialized = false
  private autoplay = false
  private fromStart = false
  private bookmarkPosition: number | null = null
  private completion: { generation: number } | null = null
  private timerInterval: number | null = null
  private lastSaved = 0
  private pendingSave = Promise.resolve()
  private listeners = new Set<() => void>()
  private clockListeners = new Set<() => void>()
  private libraryListeners = new Set<(state: AppState) => void>()
  private clockFrame: number | null = null
  private subtitleWait = 0
  private subtitleQuery = 0
  private subtitleMetrics = new SubtitleThroughput()
  private subtitleEstimate: SubtitleBufferOptions = {}
  private subtitleTranscript: TranscriptionSummaryState | null = null
  private subtitleReading = false
  private subtitleDirty = false
  private automaticRequest: {
    token: symbol
    sessionId: string
    explicit: boolean
    promise: Promise<PreparedSubtitlesResult | null>
  } | null = null
  private requestedSubtitles = false
  private subtitleCommand = 0
  private state: PlayerState = {
    episode: null,
    bookTitle: '',
    positionMs: 0,
    durationMs: 0,
    rate: 1,
    volume: 1,
    playing: false,
    loading: false,
    ready: false,
    error: '',
    saveError: '',
    sleepTimer: null,
    sleepRemainingMs: 0,
    timerNotice: '',
    skipNotice: '',
    subtitleWaiting: false,
    subtitleNotice: '',
    subtitleStatus: null,
    subtitleSetupNeeded: false,
    subtitlePreparationPhase: 'idle',
  }

  constructor() {
    this.audio.preload = 'metadata'
    this.audio.hidden = true
    this.audio.setAttribute('data-player', 'persistent')
    document.body.append(this.audio)
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.switching || !this.source || this.audio.currentSrc !== this.source.url) return
      const durationMs = this.duration()
      const range = this.range(durationMs)
      const positionMs =
        this.bookmarkPosition !== null
          ? Math.max(0, Math.min(this.bookmarkPosition, durationMs))
          : this.fromStart
            ? range.startMs
            : Math.max(range.startMs, Math.min(this.source.episode.positionMs, durationMs))
      this.audio.currentTime = positionMs / 1000
      void this.prioritizeSubtitles(positionMs)
      this.audio.playbackRate = this.state.rate
      this.audio.volume = this.state.volume
      this.patch({
        ready: true,
        loading: false,
        durationMs,
        positionMs,
        skipNotice: range.skipsDisabled ? '本集短于跳过时长，本集完整播放。' : '',
      })
      void this.save()
      if (this.autoplay) void this.play()
    })
    this.audio.addEventListener('timeupdate', () => {
      if (!this.state.ready || this.switching) return
      if (this.expireTimer()) return
      this.patch({ positionMs: this.audio.currentTime * 1000, durationMs: this.duration() })
      this.updateSubtitleNotice()
      const range = this.range()
      if (
        !this.audio.paused &&
        range.endMs < this.duration() &&
        this.getPosition() >= range.endMs
      ) {
        void this.finishChapter()
        return
      }
      if (performance.now() - this.lastSaved >= 5000) void this.save()
    })
    this.audio.addEventListener('playing', () => {
      if (this.expireTimer()) return
      this.patch({ playing: true, loading: false })
      this.startClock()
    })
    this.audio.addEventListener('waiting', () => {
      if (this.state.ready) this.patch({ loading: true })
    })
    this.audio.addEventListener('pause', () => {
      if (this.switching || this.completion) return
      this.patch({ playing: false, loading: false })
      void this.save()
    })
    this.audio.addEventListener('seeked', () => {
      if (this.state.ready && !this.switching) {
        this.patch({ positionMs: this.audio.currentTime * 1000, loading: false })
        void this.save()
      }
    })
    this.audio.addEventListener('ended', () => {
      if (this.audio.ended && this.state.ready && !this.switching) void this.finishChapter()
    })
    this.audio.addEventListener('error', () => {
      if (!this.source || this.switching) return
      this.cancelSubtitleWait()
      this.autoplay = false
      this.patch({
        playing: false,
        loading: false,
        ready: false,
        error:
          '无法播放此音频。文件可能已移动、损坏或编码不受支持；可重试、重新导入或选择其他章节。',
      })
    })
    window.desktop.onFlush((id) => {
      this.cancelSubtitleWait()
      this.audio.pause()
      void this.save().finally(() => window.desktop.flushed({ id }))
    })
    window.desktop.onTranscriptionChanged((change) => {
      if (
        change.episodeId === this.source?.episode.id &&
        change.audioHash === this.source.episode.contentHash
      )
        void this.readSubtitleProgress()
    })
    window.desktop.onComponentChanged(() => {
      if (this.source && (this.state.playing || this.requestedSubtitles))
        void this.prepareSubtitles(this.requestedSubtitles)
    })
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.state
  getSessionId = () => this.source?.sessionId ?? null
  subscribeLibrary = (listener: (state: AppState) => void) => {
    this.libraryListeners.add(listener)
    return () => {
      this.libraryListeners.delete(listener)
    }
  }
  getPosition = () => (this.state.ready ? this.audio.currentTime * 1000 : this.state.positionMs)
  subscribeClock = (listener: () => void) => {
    this.clockListeners.add(listener)
    if (this.state.playing) this.startClock()
    return () => {
      this.clockListeners.delete(listener)
    }
  }
  private startClock() {
    if (this.clockFrame !== null) return
    const tick = () => {
      this.clockFrame = null
      this.clockListeners.forEach((listener) => listener())
      if (this.state.playing && this.clockListeners.size)
        this.clockFrame = requestAnimationFrame(tick)
    }
    this.clockFrame = requestAnimationFrame(tick)
  }
  private patch(change: Partial<PlayerState>) {
    this.state = { ...this.state, ...change }
    if (
      this.subtitleTranscript &&
      this.source &&
      (Object.hasOwn(change, 'positionMs') || Object.hasOwn(change, 'durationMs'))
    )
      this.state.subtitleStatus = this.currentSubtitleStatus()
    this.listeners.forEach((listener) => listener())
    this.clockListeners.forEach((listener) => listener())
  }
  private currentSubtitleStatus(): SubtitleStatusSnapshot | null {
    return this.subtitleTranscript && this.source
      ? subtitleStatusFromTranscription(this.subtitleTranscript, {
          episodeId: this.source.episode.id,
          audioHash: this.source.episode.contentHash,
          positionMs: this.state.positionMs,
          durationMs: this.state.durationMs || this.source.episode.durationMs,
        })
      : null
  }
  private duration() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : this.state.durationMs
  }
  private range(durationMs = this.duration()) {
    const book = this.books.find((book) => book.id === this.state.episode?.bookId)
    return listeningRange(durationMs, book ?? { introMs: 0, outroMs: 0 })
  }

  setSleepTimer(value: number | 'chapter' | null) {
    if (
      value !== null &&
      value !== 'chapter' &&
      (!Number.isInteger(value) || value < 1 || value > 180)
    )
      return
    if (this.timerInterval !== null) window.clearInterval(this.timerInterval)
    this.timerInterval = null
    const sleepTimer: SleepTimer =
      value === null
        ? null
        : value === 'chapter'
          ? { mode: 'chapter' }
          : { mode: 'minutes', deadline: Date.now() + value * 60000 }
    this.patch({
      sleepTimer,
      sleepRemainingMs: typeof value === 'number' ? value * 60000 : 0,
      timerNotice: '',
    })
    if (sleepTimer?.mode === 'minutes')
      this.timerInterval = window.setInterval(() => {
        if (!this.expireTimer() && this.state.sleepTimer?.mode === 'minutes')
          this.patch({ sleepRemainingMs: Math.max(0, this.state.sleepTimer.deadline - Date.now()) })
      }, 500)
  }
  private clearTimer(notice: string) {
    if (this.timerInterval !== null) window.clearInterval(this.timerInterval)
    this.timerInterval = null
    this.patch({ sleepTimer: null, sleepRemainingMs: 0, timerNotice: notice })
  }
  private expireTimer(): boolean {
    const timer = this.state.sleepTimer
    if (timer?.mode !== 'minutes' || Date.now() < timer.deadline) return false
    this.cancelSubtitleWait()
    this.subtitleMetrics.reset()
    this.subtitleEstimate = {}
    this.navigation++
    if (this.openingId) void window.desktop.cancelEpisodeOpen({ id: this.openingId })
    this.completion = null
    this.clearTimer('已定时停止')
    this.autoplay = false
    this.audio.pause()
    this.patch({ playing: false, loading: false })
    void this.save()
    return true
  }

  updateLibrary(state: AppState) {
    this.books = state.books
    if (
      this.state.subtitleWaiting &&
      this.books.find((book) => book.id === this.source?.episode.bookId)?.subtitlePreparation
        ?.mode !== 'ahead'
    )
      void this.play(true)
    if (this.source) {
      const current = this.books
        .flatMap((book) => book.episodes)
        .find((episode) => episode.id === this.source!.episode.id)
      if (!current || current.contentHash !== this.source.episode.contentHash) void this.stop()
      else
        this.patch({
          skipNotice: this.range().skipsDisabled ? '本集短于跳过时长，本集完整播放。' : '',
        })
    }
    if (this.initialized) return
    this.initialized = true
    this.patch(state.preferences)
    if (state.currentEpisodeId) void this.load(state.currentEpisodeId, false)
  }

  async load(
    id: string,
    autoplay = true,
    fromStart = false,
    bookmark?: Pick<Bookmark, 'audioHash' | 'positionMs'>,
  ) {
    this.navigation++
    this.cancelSubtitleWait()
    this.subtitleMetrics.reset()
    this.subtitleEstimate = {}
    this.subtitleTranscript = null
    const generation = ++this.generation
    this.subtitleCommand++
    this.requestedSubtitles = false
    if (this.openingId) void window.desktop.cancelEpisodeOpen({ id: this.openingId })
    this.openingId = id
    this.completion = null
    this.autoplay = autoplay
    this.fromStart = fromStart
    this.bookmarkPosition = bookmark?.positionMs ?? null
    this.switching = true
    this.audio.pause()
    await this.save()
    if (generation !== this.generation) return
    this.source = null
    this.audio.removeAttribute('src')
    this.audio.load()
    const book = this.books.find((item) => item.episodes.some((episode) => episode.id === id))
    const episode = book?.episodes.find((item) => item.id === id) ?? null
    this.patch({
      episode,
      bookTitle: book?.title ?? '',
      ready: false,
      positionMs: fromStart ? 0 : (episode?.positionMs ?? 0),
      durationMs: episode?.durationMs ?? 0,
      loading: true,
      playing: false,
      error: '',
      skipNotice: '',
      subtitleNotice: '',
      subtitleStatus: null,
      subtitleSetupNeeded: false,
      subtitlePreparationPhase: 'idle',
    })
    try {
      const result = await window.desktop.openEpisode({ id })
      if (generation !== this.generation) return
      if (!result.ok) {
        this.patch({ loading: false, error: result.error.message })
        return
      }
      if (result.value.library) {
        this.updateLibrary(result.value.library)
        this.libraryListeners.forEach((listener) => listener(result.value.library!))
      }
      if (bookmark && bookmark.audioHash !== result.value.episode.contentHash) {
        this.patch({ loading: false, error: '书签来自旧音频版本，不能跳转到当前音频。' })
        return
      }
      this.source = result.value
      this.patch({
        episode: result.value.episode,
        bookTitle: book?.title ?? '',
        positionMs: fromStart ? 0 : result.value.episode.positionMs,
        durationMs: result.value.episode.durationMs ?? 0,
        ready: false,
      })
      this.audio.src = result.value.url
      this.audio.load()
      void this.readSubtitleProgress()
    } catch {
      if (generation === this.generation)
        this.patch({ loading: false, error: '无法连接播放服务，请重试。' })
    } finally {
      if (generation === this.generation) {
        this.switching = false
        this.openingId = null
      }
    }
  }

  private cancelSubtitleWait() {
    this.subtitleWait++
    this.subtitleQuery++
    if (this.state.subtitleWaiting) this.patch({ subtitleWaiting: false, subtitleNotice: '' })
  }
  private async prioritizeSubtitles(positionMs: number) {
    const source = this.source
    if (!source) return
    try {
      await window.desktop.prioritizeTranscription({
        episodeId: source.episode.id,
        audioHash: source.episode.contentHash,
        positionMs: Math.max(0, Math.round(positionMs)),
      })
    } catch {
      // Generation priority never interrupts ordinary audio playback.
    }
  }
  private observeSubtitles(state: TranscriptionSummaryState) {
    this.subtitleTranscript = state
    this.subtitleEstimate = this.subtitleMetrics.observe(state, performance.now())
    this.patch({ subtitleStatus: this.currentSubtitleStatus() })
  }
  private updateSubtitleNotice() {
    const state = this.subtitleTranscript
    if (
      !state ||
      this.state.subtitleWaiting ||
      !this.source ||
      this.books.find((book) => book.id === this.source!.episode.bookId)?.subtitlePreparation
        ?.mode === 'manual'
    )
      return
    if (state.job?.autoApply && state.job.status === 'completed') {
      this.patch({ subtitleNotice: '本集字幕已准备完成。' })
      return
    }
    if (state.job && ['failed', 'canceled'].includes(state.job.status)) {
      this.patch({ subtitleNotice: '字幕生成已停止，已完成的字幕仍可使用；可在伴读中重试。' })
      return
    }
    if (!state.job?.autoApply || !['queued', 'running'].includes(state.job.status)) return
    const covered = Math.max(
      0,
      subtitleCoveredUntil(state, this.getPosition()) - this.getPosition(),
    )
    const slow =
      this.subtitleEstimate.audioMsPerWallMs !== undefined &&
      this.subtitleEstimate.audioMsPerWallMs < this.state.rate
    this.patch({
      subtitleNotice:
        covered < this.state.rate * 5000
          ? '当前位置字幕尚未备足，后台正在继续准备；可暂停等待字幕或降低倍速。'
          : `字幕已领先约 ${Math.floor(covered / 1000)} 秒音频。${slow ? '按目前处理速度，字幕可能落后，可降低倍速或暂停等待。' : '其余内容继续在后台准备。'}`,
    })
  }
  private async readSubtitleProgress() {
    this.subtitleDirty = true
    if (this.subtitleReading) return
    this.subtitleReading = true
    try {
      do {
        this.subtitleDirty = false
        const source = this.source
        if (!source) return
        const result = await window.desktop.getTranscriptionSummary({
          episodeId: source.episode.id,
          audioHash: source.episode.contentHash,
        })
        if (source !== this.source || !result.ok) continue
        this.observeSubtitles(result.value)
        if (this.state.subtitleWaiting)
          await this.refreshSubtitleWait(this.subtitleWait, result.value)
        else this.updateSubtitleNotice()
      } while (this.subtitleDirty)
    } catch {
      // The next progress event can refresh status; playback remains independent.
    } finally {
      this.subtitleReading = false
    }
  }
  private async refreshSubtitleWait(wait: number, supplied?: TranscriptionSummaryState) {
    const source = this.source
    if (!source || wait !== this.subtitleWait || !this.state.subtitleWaiting) return
    const query = ++this.subtitleQuery
    try {
      const result = supplied
        ? { ok: true as const, value: supplied }
        : await window.desktop.getTranscriptionSummary({
            episodeId: source.episode.id,
            audioHash: source.episode.contentHash,
          })
      if (wait !== this.subtitleWait || query !== this.subtitleQuery || source !== this.source)
        return
      if (!result.ok) {
        this.patch({
          subtitleNotice: `无法读取字幕准备状态：${result.error.message} 普通播放继续。`,
        })
        this.patch({ subtitleWaiting: false })
        await this.play(true)
        return
      }
      this.observeSubtitles(result.value)
      const buffer = subtitleBufferState(result.value, this.getPosition(), this.duration(), {
        ...this.subtitleEstimate,
        rate: this.state.rate,
      })
      this.patch({ subtitleNotice: buffer.message })
      if (buffer.waiting) return
      this.patch({ subtitleWaiting: false })
      await this.play(true)
    } catch {
      if (wait !== this.subtitleWait || query !== this.subtitleQuery || source !== this.source)
        return
      this.patch({ subtitleWaiting: false, subtitleNotice: '无法读取字幕状态，已继续普通播放。' })
      await this.play(true)
    }
  }
  async play(immediate = false) {
    if (!this.source || !this.state.ready) return
    if (this.expireTimer()) return
    if (this.audio.ended || this.completion) this.audio.currentTime = this.range().startMs / 1000
    this.completion = null
    if (
      !immediate &&
      this.books.find((book) => book.id === this.source!.episode.bookId)?.subtitlePreparation
        ?.mode === 'ahead'
    ) {
      if (this.state.subtitleWaiting) return
      this.navigation++
      const wait = ++this.subtitleWait
      this.patch({ subtitleWaiting: true, subtitleNotice: '正在检查已缓存字幕…' })
      void this.prioritizeSubtitles(this.getPosition())
      await this.prepareSubtitles()
      if (wait === this.subtitleWait && this.state.subtitleWaiting)
        await this.refreshSubtitleWait(wait)
      return
    }
    this.cancelSubtitleWait()
    this.navigation++
    const generation = this.generation
    this.patch({ timerNotice: '' })
    try {
      await this.audio.play()
      if (generation === this.generation) void this.prepareSubtitles()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (generation === this.generation)
        this.patch({
          error: '播放未能开始，请再次点击播放，或重新导入此音频。',
          playing: false,
          loading: false,
        })
    }
  }
  async prepareSubtitles(explicit = false): Promise<PreparedSubtitlesResult | null> {
    const source = this.source
    if (!source) return null
    if (explicit) this.requestedSubtitles = true
    if (this.automaticRequest?.sessionId === source.sessionId) {
      const command = this.subtitleCommand
      return explicit && !this.automaticRequest.explicit
        ? this.automaticRequest.promise.then(() =>
            source === this.source && command === this.subtitleCommand
              ? this.prepareSubtitles(true)
              : null,
          )
        : this.automaticRequest.promise
    }
    const generation = this.generation
    const command = ++this.subtitleCommand
    const token = Symbol()
    this.patch({
      subtitleNotice: '正在后台检查字幕…',
      subtitleSetupNeeded: false,
      subtitlePreparationPhase: 'checking',
    })
    const promise = (async () => {
      try {
        const result = await window.desktop.startAutomaticSubtitles({
          episodeId: source.episode.id,
          audioHash: source.episode.contentHash,
          sessionId: source.sessionId,
          positionMs: Math.max(0, Math.floor(this.getPosition())),
          ...(explicit ? { explicit: true } : {}),
        })
        if (
          source !== this.source ||
          generation !== this.generation ||
          command !== this.subtitleCommand
        )
          return null
        if (!result.ok) {
          this.patch({
            subtitleNotice: result.error.message,
            subtitlePreparationPhase: 'unavailable',
          })
          return null
        }
        const value = result.value
        if (!['missing-component', 'unavailable'].includes(value.status))
          this.requestedSubtitles = false
        this.updateLibrary(value.library)
        this.libraryListeners.forEach((listener) => listener(value.library))
        this.patch({
          subtitleNotice: value.status === 'disabled' ? '' : value.message,
          subtitleSetupNeeded: ['missing-component', 'unavailable'].includes(value.status),
          subtitlePreparationPhase: value.status,
        })
        void this.readSubtitleProgress()
        return value
      } catch {
        if (
          source === this.source &&
          generation === this.generation &&
          command === this.subtitleCommand
        )
          this.patch({
            subtitleNotice: '字幕暂未准备好，声音可继续播放。可在字幕设置中重试。',
            subtitlePreparationPhase: 'unavailable',
          })
        return null
      } finally {
        if (this.automaticRequest?.token === token) this.automaticRequest = null
      }
    })()
    this.automaticRequest = { token, sessionId: source.sessionId, explicit, promise }
    return promise
  }
  async cancelSubtitleGeneration(): Promise<Result<TranscriptionState>> {
    const source = this.source
    if (!source)
      return { ok: false, error: { code: 'CONFLICT', message: '当前没有正在准备字幕的音频。' } }
    const command = ++this.subtitleCommand
    this.requestedSubtitles = false
    this.cancelSubtitleWait()
    this.patch({ subtitlePreparationPhase: 'canceling', subtitleNotice: '正在取消字幕生成…' })
    try {
      const result = await window.desktop.cancelAutomaticSubtitles({
        episodeId: source.episode.id,
        audioHash: source.episode.contentHash,
        sessionId: source.sessionId,
      })
      if (source === this.source && command === this.subtitleCommand) {
        this.patch({
          subtitlePreparationPhase: result.ok ? 'stopped' : 'unavailable',
          subtitleNotice: result.ok ? '已取消字幕生成，已生成的字幕会保留。' : result.error.message,
          subtitleSetupNeeded: false,
        })
        void this.readSubtitleProgress()
      }
      return result
    } catch {
      const result: Result<TranscriptionState> = {
        ok: false,
        error: { code: 'INTERNAL', message: '取消未完成，请重试。' },
      }
      if (source === this.source && command === this.subtitleCommand)
        this.patch({
          subtitlePreparationPhase: 'unavailable',
          subtitleNotice: '取消未完成，请重试。',
        })
      return result
    }
  }
  pause() {
    this.navigation++
    // Publish the explicit pause intent before notifying subtitle/UI listeners;
    // the native media pause event is delivered asynchronously.
    this.patch({ playing: false, loading: false })
    this.cancelSubtitleWait()
    if (this.openingId) void window.desktop.cancelEpisodeOpen({ id: this.openingId })
    this.completion = null
    this.autoplay = false
    this.audio.pause()
    void this.save()
  }
  seek(positionMs: number) {
    this.navigation++
    this.cancelSubtitleWait()
    this.autoplay = false
    if (!this.state.ready) return
    this.completion = null
    const position = Math.max(0, Math.min(positionMs, this.duration()))
    this.audio.currentTime = position / 1000
    this.patch({ positionMs: position })
    void this.prioritizeSubtitles(position)
    this.updateSubtitleNotice()
  }
  async openBookmark(bookmark: Bookmark) {
    const episode = this.books
      .flatMap((book) => book.episodes)
      .find((item) => item.id === bookmark.episodeId)
    if (bookmark.stale || episode?.contentHash !== bookmark.audioHash) {
      this.patch({ error: '书签来自旧音频版本，不能跳转到当前音频。' })
      return
    }
    if (this.source?.episode.id === bookmark.episodeId && this.state.ready)
      this.seek(bookmark.positionMs)
    else await this.load(bookmark.episodeId, this.state.playing, false, bookmark)
  }
  setRate(rate: number) {
    this.audio.playbackRate = rate
    this.patch({ rate })
    if (this.state.subtitleWaiting) void this.refreshSubtitleWait(this.subtitleWait)
    else this.updateSubtitleNotice()
    void this.save()
  }
  setVolume(volume: number) {
    this.audio.volume = volume
    this.patch({ volume })
    void this.save()
  }
  async save() {
    if (!this.source) return this.pendingSave
    const update: ProgressUpdate = {
      sessionId: this.source.sessionId,
      episodeId: this.source.episode.id,
      positionMs: this.state.ready ? this.audio.currentTime * 1000 : this.state.positionMs,
      durationMs:
        this.state.ready && this.duration() > 0 ? this.duration() : this.source.episode.durationMs,
      rate: this.state.rate,
      volume: this.state.volume,
    }
    this.lastSaved = performance.now()
    this.pendingSave = this.pendingSave.then(async () => {
      try {
        const result = await window.desktop.saveProgress(update)
        if (!result.ok) {
          if (this.source?.sessionId === update.sessionId)
            this.patch({ saveError: `进度保存失败：${result.error.message}` })
        } else {
          for (const book of this.books) {
            const episode = book.episodes.find((item) => item.id === update.episodeId)
            if (episode) {
              episode.positionMs = update.positionMs
              episode.durationMs = update.durationMs
              book.currentEpisodeId = episode.id
              book.lastPlayedAt = new Date().toISOString()
            }
          }
          if (this.source?.sessionId === update.sessionId) this.patch({ saveError: '' })
        }
      } catch {
        if (this.source?.sessionId === update.sessionId)
          this.patch({ saveError: '进度保存失败，请检查数据目录或重试。' })
      }
    })
    return this.pendingSave
  }

  async next(offset = 1, autoplay = this.state.playing) {
    this.cancelSubtitleWait()
    this.autoplay = false
    const episode = this.state.episode
    if (!episode) return
    let book = this.books.find((book) => book.id === episode.bookId)
    let episodes = book?.episodes ?? []
    let next = episodes[episodes.findIndex((item) => item.id === episode.id) + offset]
    if (!next && offset > 0 && book?.online && !book.online.catalogComplete) {
      const navigation = ++this.navigation,
        generation = this.generation
      this.openingId = episode.id
      this.patch({ loading: true, error: '' })
      try {
        const result = await window.desktop.continueSourceBook({ id: episode.id })
        if (navigation !== this.navigation || generation !== this.generation) return
        if (!result.ok) {
          this.patch({ loading: false, error: result.error.message })
          return
        }
        this.updateLibrary(result.value)
        this.libraryListeners.forEach((listener) => listener(result.value))
        book = result.value.books.find((book) => book.id === episode.bookId)
        episodes = book?.episodes ?? []
        next = episodes[episodes.findIndex((item) => item.id === episode.id) + offset]
        this.patch({ loading: false })
      } catch {
        if (navigation === this.navigation && generation === this.generation)
          this.patch({ loading: false, error: '后续目录读取未完成，请重试下一集。' })
      } finally {
        if (this.openingId === episode.id) this.openingId = null
      }
      if (navigation !== this.navigation || generation !== this.generation) return
    }
    if (next) await this.load(next.id, autoplay, true)
  }
  private async finishChapter() {
    if (this.completion || this.switching || !this.state.ready) return
    const generation = this.generation
    const stop = this.state.sleepTimer?.mode === 'chapter' || this.expireTimer()
    if (this.state.sleepTimer?.mode === 'chapter') this.clearTimer('本集已定时停止')
    const completion = { generation }
    this.completion = completion
    this.audio.pause()
    this.patch({ playing: false, positionMs: this.audio.currentTime * 1000, loading: false })
    await this.save()
    if (
      !stop &&
      !this.state.saveError &&
      generation === this.generation &&
      this.completion === completion &&
      !this.expireTimer()
    ) {
      if (this.state.sleepTimer?.mode === 'chapter') this.clearTimer('本集已定时停止')
      else await this.next(1, true)
    }
  }
  async stop() {
    this.navigation++
    this.cancelSubtitleWait()
    ++this.generation
    if (this.openingId) void window.desktop.cancelEpisodeOpen({ id: this.openingId })
    this.openingId = null
    this.completion = null
    this.switching = true
    this.audio.pause()
    this.source = null
    this.audio.removeAttribute('src')
    this.audio.load()
    this.patch({
      episode: null,
      bookTitle: '',
      ready: false,
      playing: false,
      loading: false,
      positionMs: 0,
      durationMs: 0,
      error: '',
      saveError: '',
      subtitleNotice: '',
      subtitleStatus: null,
      subtitleSetupNeeded: false,
      subtitlePreparationPhase: 'idle',
    })
    this.switching = false
  }
}

export const player = new PlayerController()
