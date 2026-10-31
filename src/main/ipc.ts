import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { ComponentSetup, componentDiscoveryRoots } from './component-setup'
import { subtitleSnapshot, writeSubtitleFile } from './subtitle-export'
import type { SubtitleExportRequest } from '../shared/subtitles'
import type { ReadingFindRequest, ReadingLocation } from '../shared/reading'
import {
  AUDIO_EXTENSIONS,
  CHANNELS,
  type AppState,
  type Result,
  type ProgressUpdate,
} from '../shared/contracts'
import { AppError, isTrustedRenderer, validateRequest } from '../shared/validation'
import { scanBook, type ScannedBook } from './files'
import type { LibraryStore } from './database'
import { checkAudio, MEDIA_PREFIX } from './media'
import type { TranscriptRequest } from '../shared/transcript'
import type { SubtitleStatusTarget } from '../shared/subtitle-status'
import type { RegionUpdate } from '../shared/regions'
import type { SubtitleImportService } from './subtitle-import-service'
import type {
  ApplySubtitleImport,
  SubtitleImportPageRequest,
  SubtitleImportPreviewRequest,
  SubtitleImportRequest,
} from '../shared/subtitle-import'
import type { AsrComponent } from './asr-component'
import type { TranscriptionQueue } from './transcription-queue'
import { ACTIVE_JOB_STATUSES } from '../shared/transcription'
import type {
  StartTranscription,
  TranscriptEdit,
  SubtitlePreparation,
  StartPreparedTranscription,
  TranscriptionSyncRequest,
  StartAutomaticSubtitles,
  CancelAutomaticSubtitles,
} from '../shared/transcription'
import type { SaveBookmark, BookSkips } from '../shared/listening'
import type { CacheMaintenance } from './cache-maintenance'
import type { TaskQuery, MaintenanceLocation } from '../shared/maintenance'
import {
  SourceError,
  type SourceSearchRequest,
  type SourceBookRequest,
  type SourceEpisodesRequest,
  type SourceBookDetail,
  type SourcePreparation,
} from '../shared/sources'
import type { AudioSourceRegistry } from './sources/source-registry'
import type { OnlineMedia } from './sources/online-media'
import type { OnlinePreparation } from './sources/online-preparation'
import { AutomaticOriginals } from './original/automatic'
import { AutomaticSubtitles } from './automatic-subtitles'
import type { OriginalService } from './original/service'
import type { SourceCoverPresenter } from './sources/source-cover-presenter'
import type {
  OriginalCorrection,
  OriginalMatch,
  OriginalTarget,
  ParsedOriginal,
  OriginalFindRequest,
  OriginalSearchPage,
} from '../shared/original'

export function registerIpc(
  window: BrowserWindow,
  rendererUrl: string,
  store: LibraryStore,
  dataLocation: string,
  logError: (error: unknown) => void,
  lifecycle: { quit: () => void; flushed: (id: string) => void },
  transcription: TranscriptionQueue,
  component: AsrComponent,
  maintenance: CacheMaintenance,
  sources: AudioSourceRegistry,
  onlineMedia: OnlineMedia,
  preparation: OnlinePreparation,
  originals: OriginalService,
  subtitleImports: SubtitleImportService,
  sharedComponentSetup?: ComponentSetup,
  covers?: Pick<SourceCoverPresenter, 'audio'>,
): void {
  const state = (): AppState => ({
    version: app.getVersion(),
    dataLocation,
    files: store.listFiles(),
    books: store.listBooks(),
    ...store.getPlayerState(),
  })
  let choosing = false
  let draft: { book: ScannedBook; createdAt: number } | undefined
  let active: { id: string; episodeId: string; hash: string; generation: number } | undefined
  let opening = 0
  const componentSetup =
    sharedComponentSetup ??
    new ComponentSetup(
      component,
      componentDiscoveryRoots(app.getAppPath(), dirname(app.getPath('exe')), process.resourcesPath),
    )
  function componentChanged() {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.componentChanged)
    transcription.start()
    const current = active?.episodeId ?? store.getPlayerState().currentEpisodeId
    const audio = current ? store.getAudio(current) : undefined
    preparation.componentChanged()
    if (audio) transcription.changed({ episodeId: audio.id, audioHash: audio.contentHash })
  }
  function canChooseComponent() {
    if (
      choosing ||
      transcription.maintaining ||
      store.activeJobs().some((job) => job.status !== 'queued')
    )
      throw new AppError('BUSY', '请先取消转写或等待文件选择完成。')
  }
  const catalogs = new Map<string, SourceBookDetail>()
  const rememberCatalog = (detail: SourceBookDetail) => {
    const key = `${detail.book.sourceId}:${detail.book.id}`
    if (!catalogs.has(key) && catalogs.size >= 10) catalogs.delete(catalogs.keys().next().value!)
    catalogs.set(key, detail)
  }

  function handle(channel: string, action: (request: unknown) => unknown) {
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<unknown>> => {
        try {
          if (
            window.isDestroyed() ||
            !isTrustedRenderer(
              event.sender.id,
              window.webContents.id,
              event.senderFrame === window.webContents.mainFrame,
              event.senderFrame?.url ?? '',
              rendererUrl,
            )
          )
            throw new AppError('FORBIDDEN', '此页面无权访问应用数据。')
          validateRequest(channel, args)
          return { ok: true, value: await action(args[0]) }
        } catch (error) {
          if (error instanceof AppError || error instanceof SourceError)
            return { ok: false, error: { code: error.code, message: error.message } }
          logError(error)
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '操作未完成，请重试或查看应用日志。' },
          }
        }
      },
    )
  }

  handle(CHANNELS.getState, state)
  handle(CHANNELS.readingList, () => store.reading.list())
  handle(CHANNELS.bookLinksList, () => store.bookLinks.list())
  const bookLinkTargets = (bookId: string): OriginalTarget[] =>
    (store.listBooks().find((book) => book.id === bookId)?.episodes ?? [])
      .filter((episode) => /^[0-9a-f]{64}$/.test(episode.contentHash))
      .map((episode) => ({ episodeId: episode.id, audioHash: episode.contentHash }))
  const notifyBookLink = (targets: OriginalTarget[]) => {
    for (const target of targets)
      if (!window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.transcriptionChanged, {
          ...target,
        })
  }
  handle(CHANNELS.bookLinksLink, (request) => {
    const input = request as import('../shared/book-links').LinkReadingBookRequest
    const targets = bookLinkTargets(input.bookId)
    const ready = targets.filter(
      (target) => store.getTranscriptHeader(target.episodeId, target.audioHash).status === 'ready',
    )
    automaticOriginals.checkBookRequest(ready)
    const value = store.bookLinks.link(input)
    automaticOriginals.requestBook(ready)
    notifyBookLink(targets)
    return value
  })
  handle(CHANNELS.bookLinksUnlink, (request) => {
    const id = (request as { bookId: string }).bookId
    const targets = bookLinkTargets(id)
    store.bookLinks.unlink(id)
    automaticOriginals.forgetBook(targets)
    notifyBookLink(targets)
  })
  handle(CHANNELS.bookLinksReading, (request) =>
    store.bookLinks.openReading(request as import('../shared/book-links').OpenLinkedReadingRequest),
  )
  handle(CHANNELS.bookLinksListening, (request) =>
    store.bookLinks.resolveListening(
      request as import('../shared/book-links').ResolveLinkedListeningRequest,
    ),
  )
  handle(CHANNELS.readingPage, (request) => {
    const input = request as { id: string; start: number }
    return store.reading.page(input.id, input.start)
  })
  handle(CHANNELS.readingProgress, (request) => {
    const input = request as ReadingLocation
    store.reading.savePosition(input.id, input.position)
  })
  handle(CHANNELS.readingRemove, (request) => store.reading.remove((request as { id: string }).id))
  handle(CHANNELS.readingFind, async (request) => {
    const input = request as ReadingFindRequest
    const result = await originals.run<OriginalSearchPage>({
      kind: 'find',
      original: store.reading.document(input.id),
      originalId: input.id,
      query: input.query,
      offset: input.offset,
    })
    store.reading.get(input.id)
    return result
  })
  handle(CHANNELS.readingImport, async () => {
    if (choosing) throw new AppError('BUSY', '文件选择正在进行，请稍候。')
    choosing = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '导入电子书',
        buttonLabel: '开始阅读',
        properties: ['openFile'],
        filters: [{ name: '电子书 TXT / EPUB', extensions: ['txt', 'epub'] }],
      })
      if (result.canceled) return { canceled: true }
      if (result.filePaths.length !== 1) throw new AppError('INVALID_REQUEST', '请选择一本电子书。')
      const parsed = await originals.run<ParsedOriginal>({
        kind: 'parse',
        path: result.filePaths[0]!,
      })
      return { canceled: false, book: store.reading.import(parsed) }
    } finally {
      choosing = false
    }
  })
  const automaticOriginals = new AutomaticOriginals(
    store.originals,
    originals,
    (target) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.transcriptionChanged, target)
    },
    logError,
  )
  const automaticSubtitles = new AutomaticSubtitles(
    store,
    transcription,
    componentSetup,
    preparation,
    (request) =>
      !!active &&
      active.id === request.sessionId &&
      active.generation === opening &&
      active.episodeId === request.episodeId &&
      active.hash === request.audioHash,
    (target) => {
      try {
        automaticOriginals.request(target)
      } catch (error) {
        logError(error)
      }
    },
    () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.componentChanged)
    },
    () => choosing || transcription.maintaining,
  )
  window.on('close', () => automaticSubtitles.cancel())
  window.on('closed', () => automaticSubtitles.close())
  // Reconstruct explicit shelf links after restart; inspect only lightweight
  // transcript headers here. Text parsing remains in the yielded worker queue.
  const linkedBookIds = new Set(store.bookLinks.list().map((link) => link.audioBookId))
  if (linkedBookIds.size) {
    const resume: OriginalTarget[] = []
    let limited = false
    for (const book of store.listBooks()) {
      if (!linkedBookIds.has(book.id)) continue
      for (const episode of book.episodes) {
        if (
          !/^[0-9a-f]{64}$/.test(episode.contentHash) ||
          store.getTranscriptHeader(episode.id, episode.contentHash).status !== 'ready'
        )
          continue
        if (resume.length === 10000) {
          limited = true
          break
        }
        resume.push({ episodeId: episode.id, audioHash: episode.contentHash })
      }
      if (limited) break
    }
    automaticOriginals.requestBook(resume)
    if (limited)
      logError(
        new AppError('BUSY', '启动时已恢复 10,000 集原文准备，其余集可在打开或重新关联时继续。'),
      )
  }
  handle(CHANNELS.originalCancel, () => originals.cancel())
  handle(CHANNELS.originalState, (request) => {
    const target = request as OriginalTarget
    const result = store.originals.state(target)
    automaticOriginals.request(target)
    return result
  })
  handle(CHANNELS.originalPage, (request) => {
    const input = request as OriginalTarget & { originalId: string; start: number }
    return store.originals.page(input, input.originalId, input.start)
  })
  handle(CHANNELS.originalSearch, (request) => {
    const input = request as OriginalTarget & { originalId: string; query: string }
    return store.originals.search(input, input.originalId, input.query.trim())
  })
  handle(CHANNELS.originalFind, async (request) => {
    const input = request as OriginalFindRequest
    const result = await originals.run<OriginalSearchPage>({
      kind: 'find',
      original: store.originals.document(input, input.originalId),
      originalId: input.originalId,
      query: input.query,
      offset: input.offset,
    })
    store.originals.document(input, input.originalId)
    return result
  })
  handle(CHANNELS.exportSubtitles, async (request) => {
    if (choosing) throw new AppError('BUSY', '文件选择或导出正在进行，请稍候。')
    const input = request as SubtitleExportRequest
    const snapshot = subtitleSnapshot(store, input)
    choosing = true
    try {
      const result = await dialog.showSaveDialog(window, {
        title: input.source === 'original' ? '导出已映射原文字幕' : '导出当前集文稿字幕',
        defaultPath: snapshot.suggestedName,
        filters: [{ name: input.format.toUpperCase() + ' 字幕', extensions: [input.format] }],
        properties: ['showOverwriteConfirmation'],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      if (extname(result.filePath).toLowerCase() !== '.' + input.format)
        throw new AppError('INVALID_REQUEST', `请使用 .${input.format} 扩展名保存字幕。`)
      subtitleSnapshot(store, input)
      await writeSubtitleFile(result.filePath, snapshot.contents)
      return {
        canceled: false,
        fileName: basename(result.filePath),
        cueCount: snapshot.cueCount,
        skippedSegments: snapshot.skippedSegments,
      }
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.originalCorrect, (request) =>
    store.originals.correct(request as OriginalCorrection),
  )
  handle(CHANNELS.originalImport, async (request) => {
    if (choosing) throw new AppError('BUSY', '文件选择或导入正在进行，请稍候。')
    const target = request as OriginalTarget
    store.originals.state(target)
    choosing = true
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: '选择本书的 TXT / EPUB 原文',
        buttonLabel: '导入原文',
        properties: ['openFile'],
        filters: [{ name: '小说原文', extensions: ['txt', 'epub'] }],
      })
      if (selected.canceled || !selected.filePaths.length) return { canceled: true }
      if (selected.filePaths.length !== 1)
        throw new AppError('INVALID_REQUEST', '请一次选择一个原文文件。')
      const parsed = await originals.run<ParsedOriginal>({
        kind: 'parse',
        path: selected.filePaths[0]!,
      })
      return { canceled: false, state: store.originals.import(target, parsed) }
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.originalMatch, async (request) => {
    const target = request as OriginalTarget
    return automaticOriginals.manual(target, async () => {
      const before = store.originals.state(target)
      if (!before.info) throw new AppError('INVALID_ORIGINAL', '请先为本书导入原文。')
      const transcript = store.getTranscript(target.episodeId, target.audioHash)
      if (transcript.status !== 'ready')
        throw new AppError('INVALID_ORIGINAL', '请先生成或导入这一集的转写稿。')
      const matches = await originals.run<OriginalMatch[]>({
        kind: 'match',
        original: store.originals.document(target, before.info.id),
        transcript: transcript.transcript.document,
      })
      return store.originals.saveAlignment(
        target,
        before.info.id,
        transcript.transcript.id,
        transcript.transcript.revision,
        before.alignment?.revision ?? 0,
        matches,
      )
    })
  })
  handle(CHANNELS.sourceContinuation, async (request) => {
    await onlineMedia.continueAfter((request as { id: string }).id)
    return state()
  })
  handle(CHANNELS.sourcePreparation, (request) => {
    const input = request as { id: string; settings: SourcePreparation }
    automaticSubtitles.cancel()
    if (input.settings.transcribeNext && !store.getSubtitlePreparation(input.id))
      component.runtime(input.settings.engine, input.settings.device)
    store.setSourcePreparation(input.id, input.settings)
    preparation.settingsChanged(input.id)
    return state()
  })
  handle(CHANNELS.sourcePreparationState, () => preparation.state())
  handle(CHANNELS.sourceCacheState, () => onlineMedia.cacheState())
  handle(CHANNELS.sourceCachePreview, () => {
    preparation.pause()
    return onlineMedia.previewClear()
  })
  handle(CHANNELS.sourceCacheClear, async (request) => {
    preparation.pause()
    const result = await onlineMedia.clearCache((request as { token: string }).token)
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.sourceChanged)
    return result
  })
  handle(CHANNELS.sourceSearch, (request) => {
    const input = request as SourceSearchRequest
    const source = sources.get(input.sourceId)
    return source.run(input.id, async (signal) => {
      const page = await source.adapter.search(input.query, input.cursor ?? undefined, signal)
      return covers ? { ...page, items: page.items.map((book) => covers.audio(book)) } : page
    })
  })
  handle(CHANNELS.sourceBook, (request) => {
    const input = request as SourceBookRequest
    const source = sources.get(input.sourceId)
    return source.run(input.id, async (signal) => {
      const detail = {
        book: await source.adapter.getBook(input.bookId, signal),
        episodes: await source.adapter.getEpisodes(input.bookId, undefined, signal),
      }
      rememberCatalog(detail)
      return covers ? { ...detail, book: covers.audio(detail.book) } : detail
    })
  })
  handle(CHANNELS.sourceEpisodes, (request) => {
    const input = request as SourceEpisodesRequest
    const source = sources.get(input.sourceId)
    return source.run(input.id, async (signal) => {
      const page = await source.adapter.getEpisodes(input.bookId, input.cursor ?? undefined, signal)
      const current = catalogs.get(`${input.sourceId}:${input.bookId}`)
      if (current && current.episodes.nextCursor === input.cursor && input.cursor) {
        const items = [...current.episodes.items, ...page.items]
        if (items.length > 100000)
          throw new SourceError('SOURCE_CHANGED', '目录过大，请分批选择其他书籍。')
        rememberCatalog({ ...current, episodes: { ...page, items } })
      }
      return page
    })
  })
  handle(CHANNELS.sourceAdd, (request) => {
    const input = request as SourceBookRequest
    const source = sources.get(input.sourceId)
    return source.run(input.id, async (signal) => {
      let detail = catalogs.get(`${input.sourceId}:${input.bookId}`)
      if (!detail) {
        detail = {
          book: await source.adapter.getBook(input.bookId, signal),
          episodes: await source.adapter.getEpisodes(input.bookId, undefined, signal),
        }
        rememberCatalog(detail)
      }
      signal.throwIfAborted()
      store.rememberSourceBook(
        detail.book,
        detail.episodes.items,
        detail.episodes.nextCursor === null,
      )
      return state()
    })
  })
  handle(CHANNELS.sourceCancel, (request) => sources.cancel((request as { id: string }).id))
  handle(CHANNELS.maintenanceState, () => maintenance.state())
  handle(CHANNELS.maintenanceTasks, (request) => transcription.tasks(request as TaskQuery))
  handle(CHANNELS.appLog, () => maintenance.log())
  handle(CHANNELS.prepareCacheClear, () => {
    if (choosing || store.activeJobs().length || transcription.maintaining)
      throw new AppError('BUSY', '请先完成或取消所有转写任务及文件选择，再预览清理。')
    return maintenance.prepare()
  })
  handle(CHANNELS.clearCache, (request) => {
    if (choosing) throw new AppError('BUSY', '文件选择正在进行，请稍候。')
    return transcription.withMaintenance(() =>
      maintenance.clear((request as { token: string }).token),
    )
  })
  handle(CHANNELS.showLocation, async (request) => {
    const target = (request as { target: MaintenanceLocation }).target
    const paths = component.describe()
    if (target === 'models') {
      if (!paths || !(await stat(paths.models)).isFile())
        throw new AppError('FILE_UNAVAILABLE', '模型清单不存在。')
      shell.showItemInFolder(paths.models)
      return
    }
    const path =
      target === 'data'
        ? dataLocation
        : target === 'logs'
          ? maintenance.logsDirectory
          : paths?.cache
    if (!path || !(await stat(path)).isDirectory())
      throw new AppError('FILE_UNAVAILABLE', '该目录不存在，请检查组件配置。')
    const error = await shell.openPath(path)
    if (error) throw new AppError('FILE_UNAVAILABLE', '无法打开该目录。')
  })
  handle(CHANNELS.bookmarks, (request) => store.listBookmarks((request as { id: string }).id))
  handle(CHANNELS.saveBookmark, (request) => store.saveBookmark(request as SaveBookmark))
  handle(CHANNELS.editBookmark, (request) => {
    const target = request as { id: string; note: string }
    store.editBookmark(target.id, target.note)
  })
  handle(CHANNELS.removeBookmark, (request) => store.removeBookmark((request as { id: string }).id))
  handle(CHANNELS.bookSkips, (request) => {
    const target = request as { id: string } & BookSkips
    store.setBookSkips(target.id, target)
    return state()
  })
  handle(CHANNELS.transcriptionState, (request) => {
    const target = request as TranscriptRequest
    const result = transcription.state(target.episodeId, target.audioHash)
    return {
      ...result,
      subtitleStatus: transcription.subtitleStatuses([
        {
          ...target,
          positionMs: Math.round(store.getEpisode(target.episodeId)?.positionMs ?? 0),
        },
      ])[0],
    }
  })
  handle(CHANNELS.transcriptionSync, (request) => {
    const target = request as TranscriptionSyncRequest
    return {
      ...transcription.sync(target.episodeId, target.audioHash, target.knownTranscript),
      subtitleStatus: transcription.subtitleStatuses([
        {
          episodeId: target.episodeId,
          audioHash: target.audioHash,
          positionMs: Math.round(store.getEpisode(target.episodeId)?.positionMs ?? 0),
        },
      ])[0],
    }
  })
  handle(CHANNELS.transcriptionSummary, (request) => {
    const target = request as TranscriptRequest
    return {
      ...transcription.summary(target.episodeId, target.audioHash),
      subtitleStatus: transcription.subtitleStatuses([
        { ...target, positionMs: Math.round(store.getEpisode(target.episodeId)?.positionMs ?? 0) },
      ])[0],
    }
  })
  handle(CHANNELS.subtitleStatuses, (request) =>
    transcription.subtitleStatuses((request as { episodes: SubtitleStatusTarget[] }).episodes),
  )
  handle(CHANNELS.prioritizeTranscription, (request) => {
    const input = request as TranscriptRequest & { positionMs: number }
    if (!active || active.episodeId !== input.episodeId || active.hash !== input.audioHash)
      throw new AppError('CONFLICT', '播放章节已变化，忽略旧的字幕优先位置。')
    transcription.prioritize(input.episodeId, input.audioHash, input.positionMs)
  })
  handle(CHANNELS.detectTranscriptionComponents, () => componentSetup.detect())
  handle(CHANNELS.useDetectedTranscriptionComponent, async (request) => {
    canChooseComponent()
    automaticSubtitles.cancel()
    choosing = true
    try {
      const result = await componentSetup.useCandidate((request as { id: string }).id)
      componentChanged()
      return result
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.chooseTranscriptionComponentFolder, async () => {
    canChooseComponent()
    automaticSubtitles.cancel()
    choosing = true
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: '选择转写组件文件夹',
        properties: ['openDirectory'],
      })
      if (selected.canceled || !selected.filePaths.length) return { canceled: true }
      if (selected.filePaths.length !== 1)
        throw new AppError('INVALID_REQUEST', '请选择一个组件文件夹。')
      await component.configure(join(selected.filePaths[0]!, 'component.json'))
      componentChanged()
      return { canceled: false }
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.checkTranscriptionComponent, async () => {
    const result = await componentSetup.check()
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.componentChanged)
    return result
  })
  handle(CHANNELS.subtitlePreparation, (request) => {
    const input = request as { id: string; settings: SubtitlePreparation }
    automaticSubtitles.cancel()
    store.setSubtitlePreparation(input.id, input.settings)
    preparation.settingsChanged(input.id)
    return state()
  })
  handle(CHANNELS.transcriptRegions, (request) => {
    const target = request as TranscriptRequest
    return store.getTranscriptRegions(target.episodeId, target.audioHash)
  })
  handle(CHANNELS.markTranscriptRegion, (request) =>
    store.markTranscriptRegion(request as RegionUpdate),
  )
  handle(CHANNELS.startTranscription, (request) => {
    automaticSubtitles.cancel()
    if (choosing) throw new AppError('BUSY', '文件选择或导入正在进行，请稍候。')
    return transcription.generate(request as StartTranscription)
  })
  handle(CHANNELS.startAutomaticSubtitles, async (request) => ({
    ...(await automaticSubtitles.start(request as StartAutomaticSubtitles)),
    library: state(),
  }))
  handle(CHANNELS.cancelAutomaticSubtitles, (request) =>
    automaticSubtitles.stop(request as CancelAutomaticSubtitles),
  )
  handle(CHANNELS.prepareAndStartTranscription, (request) => {
    automaticSubtitles.cancel()
    const input = request as StartPreparedTranscription
    if (
      !active ||
      active.id !== input.sessionId ||
      active.generation !== opening ||
      active.episodeId !== input.episodeId ||
      active.hash !== input.audioHash
    )
      throw new AppError('CONFLICT', '播放章节已变化，请重新打开当前集的字幕配置。')
    if (choosing || transcription.maintaining)
      throw new AppError('BUSY', '正在处理其他操作，请稍候再生成字幕。')
    const episode = checkTranscriptAsset(input)
    const before = store.latestJob(input.episodeId, input.audioHash)
    if (
      before &&
      ACTIVE_JOB_STATUSES.includes(before.status) &&
      (before.engine !== input.settings.engine || before.device !== input.settings.device)
    )
      throw new AppError('BUSY', '本集已有另一配置的任务，请先取消或等待完成。')
    component.runtime(input.settings.engine, input.settings.device)
    // Both calls are synchronous. A failed save cannot yield to a task start,
    // and stale playback sessions never change a book's configuration.
    store.setSubtitlePreparation(episode.bookId, input.settings)
    const result = transcription.generate({
      episodeId: input.episodeId,
      audioHash: input.audioHash,
      engine: input.settings.engine,
      device: input.settings.device,
    })
    preparation.settingsChanged(episode.bookId)
    return { library: state(), transcription: result, createdJob: result.job?.id !== before?.id }
  })
  handle(CHANNELS.processingResources, () => transcription.resources())
  handle(CHANNELS.processingPolicy, (request) =>
    transcription.updateResources(
      request as import('../shared/processing-resources').UpdateProcessingPolicy,
    ),
  )
  handle(CHANNELS.processingPaused, (request) =>
    transcription.pauseProcessing(
      request as import('../shared/processing-resources').PauseProcessing,
    ),
  )
  handle(CHANNELS.cancelTranscription, (request) => {
    const id = (request as { id: string }).id
    const job = store.getJob(id)
    if (active && job?.episodeId === active.episodeId && job.audioHash === active.hash) {
      automaticSubtitles.cancel()
      preparation.pause()
    }
    transcription.cancel(id)
  })
  handle(CHANNELS.retryTranscription, (request) =>
    transcription.retry((request as { id: string }).id),
  )
  handle(CHANNELS.previewTranscription, (request) =>
    transcription.preview((request as { id: string }).id),
  )
  handle(CHANNELS.applyTranscription, (request) => {
    const target = request as { id: string; revision: number }
    const result = store.applyJob(target.id, target.revision)
    const job = store.getJob(target.id)!
    transcription.changed(job)
    return result
  })
  handle(CHANNELS.editTranscript, (request) => {
    const target = request as TranscriptEdit
    const result = store.editTranscript(target)
    transcription.changed(target)
    return result
  })
  handle(CHANNELS.configureTranscription, async () => {
    canChooseComponent()
    choosing = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '选择本地转写组件配置',
        properties: ['openFile'],
        filters: [{ name: '转写组件 JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths.length) return { canceled: true }
      if (result.filePaths.length !== 1)
        throw new AppError('INVALID_REQUEST', '请一次选择一个组件配置。')
      await component.configure(result.filePaths[0]!)
      componentChanged()
      return { canceled: false }
    } finally {
      choosing = false
    }
  })
  function checkTranscriptAsset(request: TranscriptRequest) {
    const audio = store.getAudio(request.episodeId)
    if (!audio || audio.contentHash !== request.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化或章节已移除，请重新选择后导入文稿。')
    return store.getEpisode(request.episodeId)!
  }
  handle(CHANNELS.getTranscript, (request) => {
    const target = request as TranscriptRequest
    checkTranscriptAsset(target)
    return store.getTranscript(target.episodeId, target.audioHash)
  })
  handle(CHANNELS.importTranscript, async (request) => {
    if (choosing) throw new AppError('BUSY', '文件选择或导入正在进行，请稍候。')
    const target = request as TranscriptRequest
    checkTranscriptAsset(target)
    choosing = true
    let pickerStarted = false
    try {
      return await subtitleImports.importJson(target, async () => {
        pickerStarted = true
        try {
          const result = await dialog.showOpenDialog(window, {
            title: '导入当前集的时间戳文稿',
            buttonLabel: '导入文稿',
            properties: ['openFile'],
            filters: [{ name: '句级 JSON 文稿', extensions: ['json'] }],
          })
          if (result.canceled || !result.filePaths.length) return null
          if (result.filePaths.length !== 1)
            throw new AppError('INVALID_REQUEST', '请一次选择一个 JSON 文稿。')
          return result.filePaths[0]!
        } finally {
          choosing = false
        }
      })
    } finally {
      if (!pickerStarted) choosing = false
    }
  })
  handle(CHANNELS.subtitleImportPreview, async (request) => {
    if (choosing) throw new AppError('BUSY', '文件选择或导入正在进行，请稍候。')
    choosing = true
    let pickerStarted = false
    try {
      return await subtitleImports.preview(request as SubtitleImportRequest, async () => {
        pickerStarted = true
        try {
          const result = await dialog.showOpenDialog(window, {
            title: '预览当前集的 SRT / WebVTT 字幕',
            buttonLabel: '预览字幕',
            properties: ['openFile'],
            filters: [{ name: 'SRT / WebVTT 字幕', extensions: ['srt', 'vtt', 'webvtt'] }],
          })
          if (result.canceled || !result.filePaths.length) return null
          if (result.filePaths.length !== 1)
            throw new AppError('INVALID_REQUEST', '请一次选择一个字幕文件。')
          return result.filePaths[0]!
        } finally {
          // Logical cancellation must not open a second native picker before this one closes.
          choosing = false
        }
      })
    } finally {
      if (!pickerStarted) choosing = false
    }
  })
  handle(CHANNELS.subtitleImportUpdate, (request) =>
    subtitleImports.update(request as SubtitleImportPreviewRequest),
  )
  handle(CHANNELS.subtitleImportPage, (request) =>
    subtitleImports.page(request as SubtitleImportPageRequest),
  )
  handle(CHANNELS.subtitleImportApply, (request) =>
    subtitleImports.apply(request as ApplySubtitleImport),
  )
  handle(CHANNELS.subtitleImportCancel, (request) =>
    subtitleImports.cancel((request as { requestId: string }).requestId),
  )
  handle(CHANNELS.selectAudio, async () => {
    if (choosing) throw new AppError('BUSY', '文件选择窗口已打开。')
    choosing = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '选择有声书音频',
        buttonLabel: '选择音频',
        properties: ['openFile'],
        filters: [{ name: '音频文件', extensions: [...AUDIO_EXTENSIONS] }],
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      if (result.filePaths.length !== 1)
        throw new AppError('INVALID_REQUEST', '请一次选择一个音频文件。')
      const book = await scanBook(result.filePaths[0]!, 'file')
      const file = book.episodes[0]!
      store.importBook(book)
      transcription.reconcile()
      store.rememberFile(file)
      return { canceled: false, state: state() }
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.forgetFile, (request) => {
    const path = store.getRememberedPath((request as { id: string }).id)
    for (const book of store.listBooks())
      if (book.episodes.some((episode) => store.getAudio(episode.id)?.path === path))
        transcription.cancelEpisodes(book.episodes.map((episode) => episode.id))
    store.forgetFile((request as { id: string }).id)
    return state()
  })
  handle(CHANNELS.selectFolder, async () => {
    if (choosing) throw new AppError('BUSY', '正在选择或导入音频，请稍候。')
    choosing = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '选择有声书文件夹',
        buttonLabel: '导入文件夹',
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return { canceled: true }
      if (result.filePaths.length !== 1)
        throw new AppError('INVALID_REQUEST', '请一次选择一个文件夹。')
      const book = await scanBook(result.filePaths[0]!, 'folder')
      draft = { book, createdAt: Date.now() }
      return {
        canceled: false,
        draft: {
          id: book.id,
          title: book.title,
          episodes: book.episodes.map((episode) => ({
            id: episode.id,
            title: episode.name,
            sizeBytes: episode.sizeBytes,
          })),
        },
      }
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.confirmImport, async (request) => {
    if (choosing) throw new AppError('BUSY', '正在导入音频，请稍候。')
    const { id, episodeIds } = request as { id: string; episodeIds: string[] }
    if (!draft || draft.book.id !== id || Date.now() - draft.createdAt > 15 * 60 * 1000)
      throw new AppError('INVALID_REQUEST', '导入预览已过期，请重新选择文件夹。')
    const pending = draft.book
    const byId = new Map(pending.episodes.map((episode) => [episode.id, episode]))
    if (
      episodeIds.length !== pending.episodes.length ||
      episodeIds.some((episodeId) => !byId.has(episodeId))
    )
      throw new AppError('INVALID_REQUEST', '章节列表不完整，请重新选择文件夹。')
    // Recheck metadata after the user has confirmed the preview.
    choosing = true
    try {
      for (const audio of pending.episodes) await checkAudio(audio)
      store.importBook({
        ...pending,
        episodes: episodeIds.map((episodeId) => byId.get(episodeId)!),
      })
      transcription.reconcile()
      draft = undefined
      return state()
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.cancelImport, (request) => {
    if (choosing) throw new AppError('BUSY', '正在导入音频，请稍候。')
    if (draft?.book.id === (request as { id: string }).id) draft = undefined
  })
  handle(CHANNELS.removeBook, (request) => {
    const book = store.listBooks().find((book) => book.id === (request as { id: string }).id)
    if (book) {
      for (const episode of book.episodes) onlineMedia.cancel(episode.id)
      transcription.cancelEpisodes(book.episodes.map((episode) => episode.id))
    }
    store.removeBook((request as { id: string }).id)
    return state()
  })
  handle(CHANNELS.importRemembered, async (request) => {
    if (choosing) throw new AppError('BUSY', '正在选择或导入音频，请稍候。')
    choosing = true
    try {
      const path = store.getRememberedPath((request as { id: string }).id)
      if (!path) throw new AppError('FILE_UNAVAILABLE', '选择记录不存在，请重新选择音频。')
      const book = await scanBook(path, 'file')
      store.importBook(book)
      transcription.reconcile()
      store.rememberFile(book.episodes[0]!)
      return state()
    } finally {
      choosing = false
    }
  })
  handle(CHANNELS.openEpisode, async (request) => {
    automaticSubtitles.cancel()
    const generation = ++opening
    const id = (request as { id: string }).id
    const audio = store.getEpisode(id)?.online ? await onlineMedia.prepare(id) : store.getAudio(id)
    if (!audio) throw new AppError('FILE_UNAVAILABLE', '章节记录已移除，请重新导入。')
    await checkAudio(audio)
    if (generation !== opening) throw new AppError('BUSY', '已切换到其他章节。')
    if (store.getAudio(id)?.contentHash !== audio.contentHash)
      throw new AppError('FILE_CHANGED', '章节已重新导入，请重新选择后播放。')
    transcription.reconcile()
    active = { id: randomUUID(), episodeId: id, hash: audio.contentHash, generation }
    preparation.opened(id)
    return {
      sessionId: active.id,
      url: `${MEDIA_PREFIX}${id}/${audio.contentHash}`,
      episode: store.getEpisode(id)!,
      ...(store.getEpisode(id)?.online ? { library: state() } : {}),
    }
  })
  handle(CHANNELS.cancelEpisodeOpen, (request) => {
    automaticSubtitles.cancel()
    onlineMedia.cancel((request as { id: string }).id)
  })
  handle(CHANNELS.saveProgress, (request) => {
    const update = request as ProgressUpdate
    const audio = store.getAudio(update.episodeId)
    if (
      !active ||
      active.id !== update.sessionId ||
      active.episodeId !== update.episodeId ||
      active.hash !== audio?.contentHash
    )
      throw new AppError('INVALID_REQUEST', '播放会话已变化，忽略旧的播放进度。')
    store.saveProgress(update)
  })
  handle(CHANNELS.quitApp, () => {
    setImmediate(lifecycle.quit)
  })
  handle(CHANNELS.flushed, (request) => {
    lifecycle.flushed((request as { id: string }).id)
  })
  window.on('closed', () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel)
  })
}
