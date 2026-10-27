import type { LibraryStore } from '../database'
import type { TranscriptionQueue } from '../transcription-queue'
import type { SourcePreparationStatus } from '../../shared/sources'
import type { TranscriptionChange } from '../../shared/transcription'
import type { OnlineMedia } from './online-media'

export class OnlinePreparation {
  private generation = 0
  private running = new Set<Promise<void>>()
  private closed = false
  private current: string | null = null
  private activated = false
  private automatic = false
  private nextAutomatic = false
  private caching = false
  private nextCached = false
  private atEnd = false
  private failure = ''
  private status: SourcePreparationStatus = {
    episodeId: null,
    nextEpisodeId: null,
    stage: 'idle',
    message: '',
  }
  constructor(
    private readonly store: LibraryStore,
    private readonly media: OnlineMedia,
    private readonly queue: TranscriptionQueue,
    private readonly notify: () => void,
    private readonly measureDuration: (id: string) => Promise<void> = async () => {},
  ) {}
  state() {
    return { ...this.status }
  }
  private update(value: Partial<SourcePreparationStatus>) {
    const next = { ...this.status, ...value }
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next
      this.notify()
    }
  }
  pause() {
    this.generation++
    this.media.cancelNext()
    this.automatic = false
    this.activated = false
    this.nextAutomatic = false
    this.caching = false
    this.nextCached = false
    this.atEnd = false
    this.failure = ''
    this.update({ stage: 'idle', message: '', nextEpisodeId: null })
  }
  opened(id: string, activated = false) {
    if (this.closed) return
    this.pause()
    this.current = id
    this.activated = activated
    this.media.setCurrent(id)
    const book = this.store.listBooks().find((book) => book.episodes.some((e) => e.id === id))
    const current = this.store.getEpisode(id),
      legacy = book?.online?.preparation,
      settings = book?.subtitlePreparation
    this.automatic = activated && (settings ? settings.mode !== 'manual' : !!legacy?.transcribeNext)
    this.nextAutomatic = this.automatic && (settings?.prepareNext ?? true)
    const automatic = this.automatic,
      nextAutomatic = this.nextAutomatic,
      cacheNext = !!legacy?.cacheNext,
      profile = settings ?? legacy,
      next = book?.episodes.find((e) => e.order === (current?.order ?? -2) + 1)
    this.update({ episodeId: id, nextEpisodeId: null })
    const generation = this.generation
    const valid = () => generation === this.generation && !this.closed
    const failed = (error: unknown) => {
      if (!valid()) return
      this.failure = error instanceof Error ? error.message : '字幕预处理未完成，可在任务列表重试。'
      this.refreshStatus()
    }
    const run = async () => {
      if (!valid()) return
      try {
        this.queue.onEpisodeOpened(id, nextAutomatic ? next?.id : undefined)
        if (automatic && current?.contentHash && profile) {
          try {
            this.queue.prepare({
              episodeId: id,
              audioHash: current.contentHash,
              engine: profile.engine,
              device: profile.device,
            })
          } catch (error) {
            failed(error)
          }
        }
        if (!valid()) return
        this.refreshStatus()
        if (!cacheNext && !nextAutomatic) return
        let prepared = next
        if (current?.online) {
          this.caching = true
          this.refreshStatus()
          prepared = await this.media.prepareNext(id)
          if (!valid()) return
          this.caching = false
          this.notify() // Cached catalog/audio changed even if there is no next ASR job.
        }
        if (!prepared) {
          this.atEnd = true
          this.refreshStatus()
          return
        }
        this.nextCached = true
        this.update({ nextEpisodeId: prepared.id })
        if (nextAutomatic && profile) {
          if (prepared.online) {
            await this.measureDuration(prepared.id)
            if (!valid()) return
          }
          this.queue.prepare(
            {
              episodeId: prepared.id,
              audioHash: prepared.contentHash,
              engine: profile.engine,
              device: profile.device,
            },
            true,
          )
        }
        this.refreshStatus()
      } catch (error) {
        failed(error)
      }
    }
    const operation = new Promise<void>((resolve) => setImmediate(resolve)).then(run)
    this.running.add(operation)
    void operation.finally(() => this.running.delete(operation))
  }
  private transcriptStatus(id: string, label: string): Partial<SourcePreparationStatus> | null {
    const episode = this.store.getEpisode(id)
    if (!episode?.contentHash) return null
    const job = this.store.latestJob(id, episode.contentHash)
    if (job?.status === 'failed' || job?.status === 'canceled')
      return {
        stage: 'failed',
        message: `${label}字幕任务已停止。${job.error ?? '可在任务列表重试。'}`,
      }
    if (job && ['queued', 'running', 'canceling'].includes(job.status))
      return {
        stage: 'transcribing',
        message:
          job.completedChunks > 0
            ? `${label}已生成 ${job.completedChunks}/${job.totalChunks || '…'} 段字幕，正在后台完成整集。`
            : `${label}字幕正在排队或生成，完成的片段会自动显示。`,
      }
    return null
  }
  private refreshStatus() {
    if (this.closed) return
    if (this.failure) {
      this.update({ stage: 'failed', message: this.failure })
      return
    }
    const current = this.automatic && this.current && this.transcriptStatus(this.current, '本集')
    if (current) {
      this.update(current)
      return
    }
    if (this.caching) {
      this.update({ stage: 'caching', message: '正在准备下一集音频…' })
      return
    }
    const next =
      this.nextAutomatic &&
      this.status.nextEpisodeId &&
      this.transcriptStatus(this.status.nextEpisodeId, '下一集')
    if (next) {
      this.update(next)
      return
    }
    const availableDocument = (id: string | null) => {
      if (!id) return false
      const episode = this.store.getEpisode(id)
      return (
        !!episode?.contentHash &&
        !this.store.latestJob(id, episode.contentHash) &&
        this.store.getTranscript(id, episode.contentHash).status === 'ready'
      )
    }
    if (this.automatic && availableDocument(this.current))
      this.update({ stage: 'ready', message: '已有文稿可用，播放时将显示已覆盖的字幕。' })
    else if (this.automatic && this.nextAutomatic && availableDocument(this.status.nextEpisodeId))
      this.update({ stage: 'ready', message: '本集字幕已就绪，下一集已有文稿可用。' })
    else if (this.automatic)
      this.update({
        stage: 'ready',
        message:
          this.nextAutomatic && this.status.nextEpisodeId
            ? '本集及下一集字幕已就绪。'
            : this.atEnd
              ? '本集字幕已就绪，已到书籍末集。'
              : '本集字幕已就绪。',
      })
    else if (this.nextCached) this.update({ stage: 'ready', message: '下一集音频已缓存。' })
    else if (this.atEnd) this.update({ stage: 'ready', message: '已到书籍末集。' })
  }
  changed(change: TranscriptionChange) {
    if (
      !this.closed &&
      (change.episodeId === this.current || change.episodeId === this.status.nextEpisodeId)
    )
      this.refreshStatus()
  }
  settingsChanged(bookId: string) {
    if (this.current && this.store.getEpisode(this.current)?.bookId === bookId)
      this.opened(this.current, this.activated)
    this.notify()
  }
  componentChanged() {
    if (this.current) this.opened(this.current, this.activated)
  }
  async close() {
    this.closed = true
    this.pause()
    await Promise.allSettled(this.running)
  }
}
