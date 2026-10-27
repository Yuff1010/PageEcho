import type { LibraryStore } from './database'
import type { ComponentSetup } from './component-setup'
import { EPISODE_SWITCHED, type TranscriptionQueue } from './transcription-queue'
import type { OnlinePreparation } from './sources/online-preparation'
import type { ComponentCheck } from '../shared/component'
import type {
  AutomaticSubtitlesResult,
  CancelAutomaticSubtitles,
  StartAutomaticSubtitles,
  SubtitlePreparation,
  TranscriptionState,
} from '../shared/transcription'
import type { OriginalTarget } from '../shared/original'
import { AppError } from '../shared/validation'

/** This ordering selects a checked capability, not a claim about model quality. */
export function automaticSubtitleProfile(
  check: ComponentCheck,
  preferred?: SubtitlePreparation,
): SubtitlePreparation | null {
  if (!check.ready) return null
  const available = (
    engine: SubtitlePreparation['engine'],
    device: SubtitlePreparation['device'],
  ) =>
    check.capabilities.some(
      (item) => item.engine === engine && item.device === device && item.available,
    )
  if (preferred && available(preferred.engine, preferred.device)) return { ...preferred }
  for (const device of ['cuda', 'cpu'] as const)
    for (const engine of ['paraformer', 'whisperx'] as const)
      if (available(engine, device))
        return {
          mode: preferred?.mode ?? 'auto',
          engine,
          device,
          prepareNext: preferred?.prepareNext ?? false,
        }
  return null
}

type AutomaticStore = Pick<
  LibraryStore,
  'getEpisode' | 'listBooks' | 'getSubtitlePreparation' | 'setSubtitlePreparation' | 'latestJob'
>
type AutomaticQueue = Pick<
  TranscriptionQueue,
  | 'state'
  | 'prepare'
  | 'prioritize'
  | 'preparationStopped'
  | 'resumePreparation'
  | 'stopPreparation'
>

/** Only actual playback or an explicit preparation action may enter this service. */
export class AutomaticSubtitles {
  private closed = false
  private notifiedCheck: ComponentCheck | undefined
  private operation:
    | {
        key: string
        explicit: boolean
        controller: AbortController
        promise: Promise<AutomaticSubtitlesResult>
      }
    | undefined
  constructor(
    private readonly store: AutomaticStore,
    private readonly queue: AutomaticQueue,
    private readonly setup: Pick<ComponentSetup, 'checkAutomatic'>,
    private readonly preparation: Pick<OnlinePreparation, 'opened' | 'pause'>,
    private readonly current: (request: StartAutomaticSubtitles) => boolean,
    private readonly matched: (target: OriginalTarget) => void,
    private readonly componentChanged: () => void,
    private readonly busy: () => boolean = () => false,
  ) {}
  cancel(): void {
    this.operation?.controller.abort()
    this.operation = undefined
  }
  close(): void {
    this.closed = true
    this.cancel()
  }
  stop(request: CancelAutomaticSubtitles): TranscriptionState {
    if (
      this.closed ||
      !this.current(request) ||
      this.store.getEpisode(request.episodeId)?.contentHash !== request.audioHash
    )
      throw new AppError('CONFLICT', '播放章节已变化，已忽略旧会话的停止请求。')
    this.cancel()
    this.preparation.pause()
    return this.queue.stopPreparation(request)
  }
  start(request: StartAutomaticSubtitles): Promise<AutomaticSubtitlesResult> {
    // A delayed request from the previous player must not abort the live check.
    if (
      this.closed ||
      !this.current(request) ||
      this.store.getEpisode(request.episodeId)?.contentHash !== request.audioHash
    )
      return Promise.resolve({
        status: 'stale',
        settings: null,
        message: '播放会话已变化，已忽略旧的字幕准备。',
        transcription: null,
      })
    const key = `${request.sessionId}:${request.episodeId}:${request.audioHash}`
    if (this.operation?.key === key && this.operation.explicit === !!request.explicit) {
      if (request.positionMs !== undefined && this.current(request))
        this.queue.prioritize(request.episodeId, request.audioHash, request.positionMs)
      return this.operation.promise
    }
    this.cancel()
    const controller = new AbortController()
    const operation = {
      key,
      explicit: !!request.explicit,
      controller,
      promise: this.run(request, controller.signal),
    }
    this.operation = operation
    void operation.promise.finally(() => {
      if (this.operation === operation) this.operation = undefined
    })
    return operation.promise
  }
  private async run(
    request: StartAutomaticSubtitles,
    signal: AbortSignal,
  ): Promise<AutomaticSubtitlesResult> {
    let settings: SubtitlePreparation | null = null
    const valid = () =>
      !this.closed &&
      !signal.aborted &&
      this.current(request) &&
      this.store.getEpisode(request.episodeId)?.contentHash === request.audioHash
    const reply = (
      status: AutomaticSubtitlesResult['status'],
      message: string,
      transcription: TranscriptionState | null = null,
    ): AutomaticSubtitlesResult => ({ status, settings, message, transcription })
    const stale = () => reply('stale', '播放会话已变化，已忽略旧的字幕准备。')
    const stopped = (state: TranscriptionState) =>
      state.job &&
      (state.job.status === 'failed' ||
        ((state.job.status === 'canceled' || state.job.status === 'canceling') &&
          state.job.error !== EPISODE_SWITCHED))
    const reusable = (state: TranscriptionState) =>
      state.transcript.status === 'ready' &&
      (!state.job || !state.job.autoApply || state.job.status === 'completed')
    try {
      if (!valid()) return stale()
      const episode = this.store.getEpisode(request.episodeId)!
      const currentSettings = (): SubtitlePreparation | null => {
        const saved = this.store.getSubtitlePreparation(episode.bookId)
        if (saved) return saved
        const legacy = this.store.listBooks().find((book) => book.id === episode.bookId)
          ?.online?.preparation
        // False is also the database's default for every newly added online book.
        // Only a previously enabled legacy strategy represents an explicit profile.
        return legacy?.transcribeNext
          ? {
              mode: 'ahead',
              engine: legacy.engine,
              device: legacy.device,
              prepareNext: true,
            }
          : null
      }
      const hadSavedSettings = !!this.store.getSubtitlePreparation(episode.bookId)
      settings = currentSettings()
      const initialSettings = JSON.stringify(settings)
      let state = this.queue.state(request.episodeId, request.audioHash)
      if (request.explicit) this.queue.resumePreparation(request)
      if (this.queue.preparationStopped(request))
        return reply('stopped', '本集字幕准备已停止，普通播放继续；可主动重新生成或重试。', state)
      // Imported documents and manual revisions remain authoritative. In particular,
      // the playback shortcut never creates a replacement transcription over them.
      if (reusable(state)) {
        this.matched(request)
        return reply('reused', '已有字幕可用，将继续准备原文对应位置。', state)
      }
      if (settings?.mode === 'manual' && !request.explicit)
        return reply('disabled', '本书已关闭自动字幕，可在字幕工具主动准备。', state)
      if (stopped(state)) return reply('stopped', '字幕任务已停止，请在字幕工具中重试。', state)
      if (state.job?.status === 'completed')
        return reply('stopped', '字幕任务已结束但没有可用文稿，请在字幕工具重新生成。', state)
      if (this.busy()) return reply('unavailable', '正在处理其他操作，普通播放继续。', state)
      if (request.positionMs !== undefined)
        this.queue.prioritize(request.episodeId, request.audioHash, request.positionMs)
      if (state.job && ['queued', 'running'].includes(state.job.status)) {
        if (!state.configured)
          return reply(
            'missing-component',
            '字幕任务所用组件尚未就绪，普通播放继续；请在字幕工具选择或安装组件。',
            state,
          )
        this.preparation.opened(request.episodeId, true)
        this.matched(request)
        return reply('started', '字幕正在后台准备，完成的片段会自动显示。', state)
      }
      const check = await this.setup.checkAutomatic(signal)
      if (!valid()) return stale()
      // Neither a delayed component probe nor a second Play may undo a settings
      // change, a manual cancellation, a completed import, or a correction.
      const latestSettings = currentSettings()
      if (JSON.stringify(latestSettings) !== initialSettings) return stale()
      state = this.queue.state(request.episodeId, request.audioHash)
      if (reusable(state)) {
        this.matched(request)
        return reply('reused', '已有字幕可用，将继续准备原文对应位置。', state)
      }
      if (stopped(state)) return reply('stopped', '字幕任务已停止，请在字幕工具中重试。', state)
      if (!check)
        return reply(
          'missing-component',
          '尚未找到字幕组件，普通播放继续；可在字幕工具安装或选择组件。',
          state,
        )
      if (this.notifiedCheck !== check) {
        this.notifiedCheck = check
        this.componentChanged()
      }
      const selected = automaticSubtitleProfile(
        check,
        state.job
          ? {
              mode: settings?.mode ?? 'auto',
              prepareNext: settings?.prepareNext ?? false,
              engine: state.job.engine,
              device: state.job.device,
            }
          : (settings ?? undefined),
      )
      if (!selected)
        return reply('unavailable', check.issues[0] ?? '字幕组件当前不可用，普通播放继续。', state)
      if (
        state.job &&
        (selected.engine !== state.job.engine || selected.device !== state.job.device)
      )
        return reply(
          'unavailable',
          '未完成任务所用的字幕配置暂不可用，请在字幕工具检查组件。',
          state,
        )
      if (this.busy()) return reply('unavailable', '正在处理其他操作，普通播放继续。', state)
      // All state changes and queue admission are synchronous after the final
      // session check, so switching chapters cannot commit an old book profile.
      if (!valid()) return stale()
      if (!hadSavedSettings || JSON.stringify(selected) !== initialSettings)
        this.store.setSubtitlePreparation(episode.bookId, selected)
      settings = selected
      const result = this.queue.prepare({
        episodeId: request.episodeId,
        audioHash: request.audioHash,
        engine: selected.engine,
        device: selected.device,
      })
      if (stopped(result)) return reply('stopped', '字幕任务已停止，请在字幕工具中重试。', result)
      this.preparation.opened(request.episodeId, true)
      this.matched(request)
      if (reusable(result)) return reply('reused', '已有字幕可用，将继续准备原文对应位置。', result)
      return reply('started', '字幕正在后台准备，完成的片段会自动显示。', result)
    } catch (error) {
      if (!valid()) return stale()
      return reply(
        'unavailable',
        error instanceof Error ? error.message : '字幕准备暂不可用，普通播放继续。',
      )
    }
  }
}
