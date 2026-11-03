import type {
  Episode,
  PlaybackSource,
  PlaybackSourceChange,
  ProgressUpdate,
  Result,
} from '../../shared/contracts'
import type { LibraryOverview, LibraryMutation, PlaybackContext } from '../../shared/library'
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
  coverUrl?: string
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
  audioPending: { receivedBytes: number; totalBytes: number } | null
}
/** A successful progress save can update a shelf summary without another Main read. */
export interface PlayerLibraryMutation extends LibraryMutation {
  progress?: {
    bookId: string
    episodeId: string
    positionMs: number
    durationMs: number | null
    rate: number
    volume: number
    updatedAt: string
  }
}
type PreparedSubtitlesResult = AutomaticSubtitlesResult & {
  context: PlaybackContext | null
  mutation: LibraryMutation
}

export function pendingAudioNotice(pending: PlayerState['audioPending']): string | undefined {
  return pending
    ? `音频缓存 ${Math.floor((pending.receivedBytes / pending.totalBytes) * 100)}%；可以继续收听。`
    : undefined
}

export class PlayerController {
  readonly audio = document.createElement('audio')
  private source: PlaybackSource | null = null
  private context: PlaybackContext | null = null
  private contextQuery = 0
  private generation = 0
  private navigation = 0
  private openingId: string | null = null
  private openingRequestId: string | null = null
  private transferFailed = false
  private confirmedPendingPositionMs = 0
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
  private libraryListeners = new Set<(mutation: PlayerLibraryMutation) => void>()
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
    audioPending: null,
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
      this.confirmPendingPosition()
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
    window.desktop.onPlaybackSourceChanged((change) => this.acceptPlaybackSource(change))
  }

  private cancelOpening() {
    if (this.openingId)
      void window.desktop.cancelEpisodeOpen({
        id: this.openingId,
        ...(this.openingRequestId ? { requestId: this.openingRequestId } : {}),
      })
    this.openingId = null
    this.openingRequestId = null
  }
  private confirmPendingPosition() {
    if (
      !this.source?.pending ||
      this.transferFailed ||
      this.audio.seeking ||
      this.audio.readyState < 2
    )
      return
    const time = this.audio.currentTime
    for (let index = 0; index < this.audio.buffered.length; index++) {
      if (this.audio.buffered.start(index) <= time && time <= this.audio.buffered.end(index)) {
        this.confirmedPendingPositionMs = Math.max(0, time * 1000)
        return
      }
    }
  }
  private acceptPlaybackSource(change: PlaybackSourceChange) {
    const source = this.source
    if (
      !source ||
      source.sessionId !== change.sessionId ||
      source.episode.id !== change.episodeId ||
      this.switching ||
      !source.pending
    )
      return
    if (change.status === 'pending') {
      this.patch({
        audioPending: { receivedBytes: change.receivedBytes, totalBytes: change.totalBytes },
      })
      return
    }
    if (change.status === 'failed') {
      this.transferFailed = true
      this.audio.pause()
      this.patch({ error: change.message, playing: false, loading: false, audioPending: null })
      return
    }
    if (!/^[0-9a-f]{64}$/.test(change.episode.contentHash)) return
    const waiting = this.state.subtitleWaiting
    // The same audio element/URL keeps playing. Only its authenticated identity changes.
    this.source = {
      ...source,
      episode: change.episode,
      context: change.context,
      pending: undefined,
    }
    this.contextQuery++
    this.context = change.context
    this.patch({ episode: change.episode, audioPending: null, subtitleWaiting: false })
    this.updateContextPresentation()
    this.publishMutation(this.progressMutation(change.episode))
    void this.save()
    void this.readSubtitleProgress()
    if (waiting) void this.play()
    else if (this.state.playing || this.requestedSubtitles)
      void this.prepareSubtitles(this.requestedSubtitles)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.state
  getSessionId = () => this.source?.sessionId ?? null
  subscribeLibraryMutation = (listener: (mutation: PlayerLibraryMutation) => void) => {
    this.libraryListeners.add(listener)
    return () => {
      this.libraryListeners.delete(listener)
    }
  }
  getContext = () => this.context
  private progressMutation(episode: Episode): LibraryMutation {
    return {
      changedBookIds: [episode.bookId],
      removedBookIds: [],
      filesChanged: false,
      bookId: episode.bookId,
      episodeId: episode.id,
    }
  }
  private publishMutation(mutation: PlayerLibraryMutation) {
    this.libraryListeners.forEach((listener) => listener(mutation))
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
    return listeningRange(durationMs, this.context?.book ?? { introMs: 0, outroMs: 0 })
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
    this.cancelOpening()
    this.completion = null
    this.clearTimer('已定时停止')
    this.autoplay = false
    this.audio.pause()
    this.patch({ playing: false, loading: false })
    void this.save()
    return true
  }

  initializeOverview(overview: LibraryOverview) {
    if (this.initialized) return
    this.initialized = true
    // A delayed initial shelf request must not replace a user's newer explicit choice.
    if (this.generation || this.openingId || this.source) return
    this.patch(overview.preferences)
    if (overview.currentEpisodeId) void this.load(overview.currentEpisodeId, false)
  }

  private updateContextPresentation() {
    this.patch({
      bookTitle: this.context?.book.title ?? '',
      coverUrl: this.context?.book.coverUrl,
      skipNotice: this.range().skipsDisabled ? '本集短于跳过时长，本集完整播放。' : '',
    })
    if (this.state.subtitleWaiting && this.context?.book.subtitlePreparation?.mode !== 'ahead')
      void this.play(true)
  }

  private async acceptContext(context: PlaybackContext | null, source: PlaybackSource) {
    if (source !== this.source) return
    if (
      !context ||
      context.episode.id !== source.episode.id ||
      context.book.id !== source.episode.bookId ||
      (!source.pending && context.episode.contentHash !== source.episode.contentHash)
    ) {
      await this.stop()
      return
    }
    // Only the authenticated ready event transfers a progressive source's identity.
    this.context = {
      ...context,
      episode: {
        ...(source.pending ? source.episode : context.episode),
        positionMs: this.state.positionMs,
      },
    }
    source.context = this.context
    if (!source.pending) {
      source.episode = this.context.episode
      this.patch({ episode: this.context.episode })
    }
    this.updateContextPresentation()
  }

  async refreshContext(bookIds?: readonly string[]) {
    const source = this.source
    if (this.switching || !source || (bookIds && !bookIds.includes(source.episode.bookId))) return
    const generation = this.generation,
      query = ++this.contextQuery
    try {
      const result = await window.desktop.getPlaybackContext({ episodeId: source.episode.id })
      if (
        this.switching ||
        source !== this.source ||
        generation !== this.generation ||
        query !== this.contextQuery
      )
        return
      if (result.ok) await this.acceptContext(result.value, source)
    } catch {
      // A failed metadata refresh does not invalidate a working authenticated audio session.
    }
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
    this.contextQuery++
    this.subtitleCommand++
    this.requestedSubtitles = false
    this.cancelOpening()
    this.openingId = id
    const requestId = (this.openingRequestId = crypto.randomUUID())
    this.completion = null
    this.autoplay = autoplay
    this.fromStart = fromStart
    this.bookmarkPosition = bookmark?.positionMs ?? null
    this.switching = true
    this.audio.pause()
    await this.save()
    if (generation !== this.generation || this.openingRequestId !== requestId) return
    const previous = this.source
    this.source = null
    this.context = null
    this.transferFailed = false
    this.confirmedPendingPositionMs = 0
    this.audio.removeAttribute('src')
    this.audio.load()
    this.patch({
      episode: null,
      bookTitle: '',
      coverUrl: undefined,
      ready: false,
      positionMs: 0,
      durationMs: 0,
      loading: true,
      playing: false,
      error: '',
      skipNotice: '',
      subtitleNotice: '',
      subtitleStatus: null,
      subtitleSetupNeeded: false,
      subtitlePreparationPhase: 'idle',
      audioPending: null,
    })
    try {
      if (previous) await window.desktop.releasePlayback({ sessionId: previous.sessionId })
      if (generation !== this.generation || this.openingRequestId !== requestId) return
      const metadata = await window.desktop.getPlaybackContext({ episodeId: id })
      if (generation !== this.generation || this.openingRequestId !== requestId) return
      if (!metadata.ok || !metadata.value) {
        this.patch({
          loading: false,
          error: metadata.ok ? '章节记录已移除，请重新选择。' : metadata.error.message,
        })
        return
      }
      this.context = metadata.value
      this.patch({
        episode: metadata.value.episode,
        bookTitle: metadata.value.book.title,
        coverUrl: metadata.value.book.coverUrl,
        positionMs: fromStart ? 0 : metadata.value.episode.positionMs,
        durationMs: metadata.value.episode.durationMs ?? 0,
      })
      const result = await window.desktop.openEpisode({ id, requestId })
      if (generation !== this.generation || this.openingRequestId !== requestId) {
        if (result.ok) await window.desktop.releasePlayback({ sessionId: result.value.sessionId })
        return
      }
      if (!result.ok) {
        this.patch({ loading: false, error: result.error.message })
        return
      }
      if (bookmark && bookmark.audioHash !== result.value.episode.contentHash) {
        this.patch({ loading: false, error: '书签来自旧音频版本，不能跳转到当前音频。' })
        await window.desktop.releasePlayback({ sessionId: result.value.sessionId })
        return
      }
      this.source = result.value
      this.context = result.value.context
      this.patch({
        episode: result.value.episode,
        bookTitle: result.value.context.book.title,
        coverUrl: result.value.context.book.coverUrl,
        positionMs: fromStart ? 0 : result.value.episode.positionMs,
        durationMs: result.value.episode.durationMs ?? 0,
        ready: false,
        audioPending: result.value.pending ?? null,
      })
      this.switching = false
      this.audio.src = result.value.url
      this.audio.load()
      this.publishMutation(this.progressMutation(result.value.episode))
      if (result.value.pending) {
        const latest = await window.desktop
          .getPlaybackSourceState({
            sessionId: result.value.sessionId,
          })
          .catch(() => null)
        if (latest?.ok && latest.value) this.acceptPlaybackSource(latest.value)
      }
      void this.readSubtitleProgress()
    } catch {
      if (generation === this.generation)
        this.patch({ loading: false, error: '无法连接播放服务，请重试。' })
    } finally {
      if (generation === this.generation) {
        this.switching = false
        this.openingId = null
        this.openingRequestId = null
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
    if (!source || source.pending) return
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
      this.context?.book.subtitlePreparation?.mode === 'manual'
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
        if (!source || source.pending) return
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
    if (!source || source.pending || wait !== this.subtitleWait || !this.state.subtitleWaiting)
      return
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
    if (this.source && this.transferFailed) {
      await this.load(this.source.episode.id, true)
      return
    }
    if (!this.source || !this.state.ready) return
    if (this.expireTimer()) return
    if (this.audio.ended || this.completion) this.audio.currentTime = this.range().startMs / 1000
    this.completion = null
    if (!immediate && this.context?.book.subtitlePreparation?.mode === 'ahead') {
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
    if (source.pending) return null
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
        // A manual task or cancellation can invalidate the automatic request
        // while the same recording keeps playing. Its omitted context is not
        // evidence that the current media or book has been removed.
        if (value.status === 'stale') {
          this.patch({ subtitleNotice: '', subtitlePreparationPhase: 'idle' })
          void this.readSubtitleProgress()
          return null
        }
        if (!['missing-component', 'unavailable'].includes(value.status))
          this.requestedSubtitles = false
        await this.acceptContext(value.context, source)
        if (
          source !== this.source ||
          generation !== this.generation ||
          command !== this.subtitleCommand
        )
          return null
        this.publishMutation(value.mutation)
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
    this.cancelOpening()
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
    if (
      bookmark.stale ||
      (this.source?.episode.id === bookmark.episodeId &&
        this.source.episode.contentHash !== bookmark.audioHash)
    ) {
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
    const source = this.source,
      generation = this.generation,
      switching = this.switching
    const isCurrent = () =>
      !switching &&
      !this.switching &&
      generation === this.generation &&
      this.source?.sessionId === update.sessionId
    this.confirmPendingPosition()
    const update: ProgressUpdate = {
      sessionId: this.source.sessionId,
      episodeId: this.source.episode.id,
      positionMs: this.source.pending
        ? this.confirmedPendingPositionMs
        : this.state.ready
          ? this.audio.currentTime * 1000
          : this.state.positionMs,
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
          if (isCurrent()) this.patch({ saveError: `进度保存失败：${result.error.message}` })
        } else {
          const updatedAt = new Date().toISOString()
          if (isCurrent() && this.source && this.context?.episode.id === update.episodeId) {
            const episode = {
              ...this.context.episode,
              positionMs: update.positionMs,
              durationMs: update.durationMs,
            }
            this.context = {
              ...this.context,
              episode,
              book: {
                ...this.context.book,
                currentEpisodeId: episode.id,
                lastPlayedAt: updatedAt,
              },
            }
            this.source.context = this.context
          }
          this.publishMutation({
            ...this.progressMutation(source.episode),
            ...(isCurrent()
              ? {
                  progress: {
                    bookId: source.episode.bookId,
                    episodeId: update.episodeId,
                    positionMs: update.positionMs,
                    durationMs: update.durationMs,
                    rate: update.rate,
                    volume: update.volume,
                    updatedAt,
                  },
                }
              : {}),
          })
          if (isCurrent()) this.patch({ saveError: '' })
        }
      } catch {
        if (isCurrent()) this.patch({ saveError: '进度保存失败，请检查数据目录或重试。' })
      }
    })
    return this.pendingSave
  }

  async next(offset = 1, autoplay = this.state.playing) {
    this.cancelSubtitleWait()
    this.autoplay = false
    const source = this.source,
      episode = this.context?.episode ?? this.state.episode
    // A failed open still has authenticated catalogue metadata. Navigation must
    // remain available so the user can skip a missing or unreadable recording.
    if (!episode || !this.context || (offset !== 1 && offset !== -1)) return
    let nextId = offset > 0 ? this.context.nextEpisodeId : this.context.previousEpisodeId
    if (
      !nextId &&
      offset > 0 &&
      this.context.book.online &&
      !this.context.book.online.catalogComplete
    ) {
      const navigation = ++this.navigation,
        generation = this.generation
      this.openingId = episode.id
      this.patch({ loading: true, error: '' })
      try {
        const result = await window.desktop.continueSourceBook({ id: episode.id })
        if (
          source !== this.source ||
          navigation !== this.navigation ||
          generation !== this.generation
        )
          return
        if (!result.ok) {
          this.patch({ loading: false, error: result.error.message })
          return
        }
        this.publishMutation(result.value)
        if (source) await this.refreshContext([episode.bookId])
        else {
          const metadata = await window.desktop.getPlaybackContext({ episodeId: episode.id })
          if (navigation !== this.navigation || generation !== this.generation) return
          if (metadata.ok) this.context = metadata.value
        }
        if (
          source !== this.source ||
          navigation !== this.navigation ||
          generation !== this.generation
        )
          return
        nextId = this.context?.nextEpisodeId ?? null
        this.patch({ loading: false })
      } catch {
        if (
          source === this.source &&
          navigation === this.navigation &&
          generation === this.generation
        )
          this.patch({ loading: false, error: '后续目录读取未完成，请重试下一集。' })
      } finally {
        if (this.openingId === episode.id) this.openingId = null
      }
      if (
        source !== this.source ||
        navigation !== this.navigation ||
        generation !== this.generation
      )
        return
    }
    if (nextId) await this.load(nextId, autoplay, true)
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
    const generation = ++this.generation
    this.contextQuery++
    this.cancelOpening()
    this.completion = null
    this.switching = true
    this.audio.pause()
    const previous = this.source
    const saved = this.save()
    this.source = null
    this.context = null
    this.patch({ ready: false, playing: false, loading: false })
    await saved
    if (previous) await window.desktop.releasePlayback({ sessionId: previous.sessionId })
    if (generation !== this.generation) return
    this.source = null
    this.audio.removeAttribute('src')
    this.audio.load()
    this.patch({
      episode: null,
      bookTitle: '',
      coverUrl: undefined,
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
      audioPending: null,
    })
    this.switching = false
  }
}

export const player = new PlayerController()
