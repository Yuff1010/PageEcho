import type { TranscriptRequest, TranscriptState } from './transcript'
import type { EbookSpeechApi } from './ebook-speech'
import type {
  BookEpisodePage,
  LibraryOverview,
  LibraryMutation,
  PlaybackContext,
  ReadingBookSummary,
} from './library'
import type { TextSourceApi } from './text-source-api'
import type { PluginApi } from './plugins'
import type { BackupStorageApi } from './backup-storage'
import type {
  ApplySubtitleImport,
  SubtitleImportPageRequest,
  SubtitleImportPreview,
  SubtitleImportPreviewRequest,
  SubtitleImportRequest,
  SubtitleImportResult,
  SubtitleImportSelection,
} from './subtitle-import'
import type {
  TranscriptEditRequest,
  TranscriptEditResult,
  TranscriptHistoryRequest,
  TranscriptEditingState,
  TranscriptReplacementRequest,
  TranscriptReplacementPreview,
  ApplyTranscriptReplacement,
  TranscriptAlignmentRequest,
  TranscriptAlignmentState,
  ApplyTranscriptAlignment,
} from './transcript-editing'
import type { ComponentProfile, ComponentInstallationState } from './component-installation'
import type {
  PreviewOfflinePlanRequest,
  OfflinePlanPreview,
  OfflinePlan,
  OfflinePlanPage,
  OfflinePlanDetail,
  UpdateOfflinePlanRequest,
} from './offline'
import type { ComponentCheck, ComponentSetupState } from './component'
import type { SubtitleStatusSnapshot, SubtitleStatusTarget } from './subtitle-status'
import type {
  OriginalAcousticRequest,
  OriginalAcousticState,
  ApplyOriginalAcousticRequest,
  RestoreOriginalAcousticRequest,
} from './original-acoustic'
import type {
  ListeningReviewGet,
  ListeningReviewPrepare,
  ListeningReviewSave,
  ListeningReviewState,
} from './listening-review'
import type { ReadingBook, ReadingLocation, ReadingFindRequest } from './reading'
import type {
  BookLink,
  LinkReadingBookRequest,
  OpenLinkedReadingRequest,
  OpenLinkedReadingResult,
  ResolveLinkedListeningRequest,
  ResolveLinkedListeningResult,
} from './book-links'
import type {
  OriginalState,
  OriginalPage,
  OriginalCandidate,
  OriginalTarget,
  OriginalCorrection,
  OriginalFindRequest,
  OriginalSearchPage,
} from './original'
import type { SubtitleExportRequest, SubtitleExportResult } from './subtitles'
import type { TranscriptRegions, RegionUpdate } from './regions'
import type { Bookmark, SaveBookmark, BookSkips } from './listening'
import type {
  SourceId,
  SourceSearchRequest,
  SourceBookRequest,
  SourceEpisodesRequest,
  SourcePage,
  SourceBook,
  SourceEpisode,
  SourceBookDetail,
  SourceErrorCode,
  SourcePreparation,
  SourcePreparationStatus,
  SourceCacheUsage,
  SourceCachePreview,
} from './sources'
import type {
  MaintenanceState,
  CacheClearPreview,
  CacheClearResult,
  TaskQuery,
  TaskPage,
  MaintenanceLocation,
  AppLog,
} from './maintenance'
import type {
  StartTranscription,
  TranscriptionState,
  TranscriptionSyncRequest,
  TranscriptionSyncState,
  TranscriptionSummaryState,
  TranscriptionPreview,
  TranscriptionChange,
  TranscriptEdit,
  SubtitlePreparation,
  StartPreparedTranscription,
  StartAutomaticSubtitles,
  CancelAutomaticSubtitles,
  AutomaticSubtitlesResult,
} from './transcription'
import type {
  ProcessingResources,
  UpdateProcessingPolicy,
  PauseProcessing,
} from './processing-resources'

export const CHANNELS = {
  transcriptEditingState: 'transcript-edit:state',
  transcriptChange: 'transcript-edit:change',
  transcriptUndo: 'transcript-edit:undo',
  transcriptRedo: 'transcript-edit:redo',
  replacementPreview: 'transcript-edit:replacement-preview',
  replacementPage: 'transcript-edit:replacement-page',
  replacementApply: 'transcript-edit:replacement-apply',
  replacementCancel: 'transcript-edit:replacement-cancel',
  transcriptAlignmentState: 'transcript-edit:alignment-state',
  transcriptAlignmentStart: 'transcript-edit:alignment-start',
  transcriptAlignmentCancel: 'transcript-edit:alignment-cancel',
  transcriptAlignmentApply: 'transcript-edit:alignment-apply',
  transcriptEditingChanged: 'transcript-edit:changed',
  offlinePreview: 'offline:preview',
  offlinePreviewCancel: 'offline:preview-cancel',
  offlineCreate: 'offline:create',
  offlineList: 'offline:list',
  offlineGet: 'offline:get',
  offlineUpdate: 'offline:update',
  offlineRelease: 'offline:release',
  offlineChanged: 'offline:changed',
  componentInstallations: 'component-install:state',
  componentPackageChoose: 'component-install:choose',
  componentInstallationStart: 'component-install:start',
  componentInstallationCancel: 'component-install:cancel',
  componentInstallationActivate: 'component-install:activate',
  componentInstallationsChanged: 'component-install:changed',
  processingResources: 'resources:state',
  processingPolicy: 'resources:policy',
  processingPaused: 'resources:paused',
  processingResourcesChanged: 'resources:changed',
  originalAcousticState: 'acoustic:state',
  originalAcousticStart: 'acoustic:start',
  originalAcousticCancel: 'acoustic:cancel',
  originalAcousticApply: 'acoustic:apply',
  originalAcousticRestore: 'acoustic:restore',
  originalAcousticChanged: 'acoustic:changed',
  listeningReviewGet: 'listening:review-get',
  listeningReviewPrepare: 'listening:review-prepare',
  listeningReviewSave: 'listening:review-save',
  readingList: 'reading:list',
  readingBook: 'reading:book',
  readingSummaries: 'reading:summaries',
  bookLinksList: 'book-links:list',
  bookLinksLink: 'book-links:link',
  bookLinksUnlink: 'book-links:unlink',
  bookLinksReading: 'book-links:reading',
  bookLinksListening: 'book-links:listening',
  readingImport: 'reading:import',
  readingPage: 'reading:page',
  readingProgress: 'reading:progress',
  readingRemove: 'reading:remove',
  readingFind: 'reading:find',
  originalState: 'original:state',
  originalImport: 'original:import',
  originalPage: 'original:page',
  originalSearch: 'original:search',
  originalFind: 'original:find',
  exportSubtitles: 'transcript:export-subtitles',
  originalMatch: 'original:match',
  originalCorrect: 'original:correct',
  originalCancel: 'original:cancel',
  sourceSearch: 'source:search',
  sourceBook: 'source:book',
  sourceEpisodes: 'source:episodes',
  sourceCancel: 'source:cancel',
  sourceAdd: 'source:add',
  sourceContinuation: 'source:continuation',
  sourcePreparation: 'source:preparation',
  sourcePreparationState: 'source:preparation-state',
  sourceChanged: 'source:changed',
  sourceCacheState: 'source:cache-state',
  sourceCachePreview: 'source:cache-preview',
  sourceCacheClear: 'source:cache-clear',
  getState: 'app:get-state',
  libraryOverview: 'library:overview',
  bookDetail: 'library:book-detail',
  bookEpisodes: 'library:book-episodes',
  playbackContext: 'player:context',
  selectAudio: 'files:select-audio',
  forgetFile: 'files:forget',
  selectFolder: 'library:select-folder',
  confirmImport: 'library:confirm-import',
  cancelImport: 'library:cancel-import',
  removeBook: 'library:remove-book',
  importRemembered: 'library:import-remembered',
  openEpisode: 'player:open-episode',
  playbackSourceState: 'player:source-state',
  playbackSourceChanged: 'player:source-changed',
  releasePlayback: 'player:release-source',
  cancelEpisodeOpen: 'player:cancel-open',
  saveProgress: 'player:save-progress',
  quitApp: 'app:quit',
  flush: 'player:flush',
  flushed: 'player:flushed',
  getTranscript: 'transcript:get',
  importTranscript: 'transcript:import',
  subtitleImportPreview: 'subtitle-import:preview',
  subtitleImportUpdate: 'subtitle-import:update',
  subtitleImportPage: 'subtitle-import:page',
  subtitleImportApply: 'subtitle-import:apply',
  subtitleImportCancel: 'subtitle-import:cancel',
  transcriptionState: 'transcription:state',
  transcriptionSync: 'transcription:sync',
  transcriptionSummary: 'transcription:summary',
  subtitleStatuses: 'transcription:statuses',
  subtitlePreparation: 'transcription:preparation',
  startTranscription: 'transcription:start',
  prepareAndStartTranscription: 'transcription:prepare-and-start',
  startAutomaticSubtitles: 'transcription:start-automatic-subtitles',
  cancelAutomaticSubtitles: 'transcription:cancel-automatic-subtitles',
  cancelTranscription: 'transcription:cancel',
  retryTranscription: 'transcription:retry',
  previewTranscription: 'transcription:preview',
  applyTranscription: 'transcription:apply',
  configureTranscription: 'transcription:configure',
  detectTranscriptionComponents: 'transcription:components-detect',
  useDetectedTranscriptionComponent: 'transcription:component-use',
  chooseTranscriptionComponentFolder: 'transcription:component-folder',
  checkTranscriptionComponent: 'transcription:component-check',
  prioritizeTranscription: 'transcription:prioritize',
  componentChanged: 'transcription:component-changed',
  transcriptionChanged: 'transcription:changed',
  editTranscript: 'transcript:edit',
  transcriptRegions: 'transcript:regions',
  markTranscriptRegion: 'transcript:region-mark',
  bookmarks: 'listening:bookmarks',
  saveBookmark: 'listening:bookmark-save',
  editBookmark: 'listening:bookmark-edit',
  removeBookmark: 'listening:bookmark-remove',
  bookSkips: 'listening:book-skips',
  maintenanceState: 'maintenance:state',
  maintenanceTasks: 'maintenance:tasks',
  prepareCacheClear: 'maintenance:prepare-clear',
  clearCache: 'maintenance:clear',
  appLog: 'maintenance:log',
  showLocation: 'maintenance:show-location',
} as const

export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'm4b', 'wav', 'ogg', 'flac'] as const

export interface SelectedFile {
  id: string
  name: string
  sizeBytes: number
  modifiedAt: number
  selectedAt: string
}

export interface AppState {
  version: string
  dataLocation: string
  files: SelectedFile[]
  books: Book[]
  currentEpisodeId: string | null
  preferences: { rate: number; volume: number }
}

export interface Episode {
  id: string
  bookId: string
  title: string
  order: number
  sizeBytes: number
  modifiedAt: number
  contentHash: string
  durationMs: number | null
  positionMs: number
  // Uncached online entries have no measured size/hash yet; no local file row exists.
  online?: { sourceId: SourceId; bookId: string; episodeId: string; cached: boolean }
}

export interface Book extends BookSkips {
  id: string
  title: string
  /** Main-process-generated persistent local artwork URL; never a remote request. */
  coverUrl?: string
  importedAt: string
  lastPlayedAt: string | null
  currentEpisodeId: string | null
  episodes: Episode[]
  subtitlePreparation?: SubtitlePreparation
  online?: {
    sourceId: SourceId
    bookId: string
    catalogComplete: boolean
    preparation: SourcePreparation
  }
}

export interface ImportDraft {
  id: string
  title: string
  episodes: { id: string; title: string; sizeBytes: number }[]
}

export interface PlaybackSource {
  sessionId: string
  url: string
  episode: Episode
  context: PlaybackContext
  /** Empty episode hash stays empty until the complete audio is authenticated. */
  pending?: { receivedBytes: number; totalBytes: number }
}

export type PlaybackSourceChange =
  | {
      sessionId: string
      episodeId: string
      status: 'pending'
      receivedBytes: number
      totalBytes: number
    }
  | {
      sessionId: string
      episodeId: string
      status: 'ready'
      episode: Episode
      context: PlaybackContext
    }
  | { sessionId: string; episodeId: string; status: 'failed'; message: string }

export interface OpenEpisodeRequest {
  id: string
  requestId?: string
}

export interface ProgressUpdate {
  sessionId: string
  episodeId: string
  positionMs: number
  durationMs: number | null
  rate: number
  volume: number
}

export type ErrorCode =
  | SourceErrorCode
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'FILE_UNAVAILABLE'
  | 'FILE_CHANGED'
  | 'BUSY'
  | 'INTERNAL'
  | 'INVALID_TRANSCRIPT'
  | 'INVALID_ORIGINAL'
  | 'AUDIO_VERSION_MISMATCH'
  | 'CONFLICT'
  | 'RUNTIME_UNAVAILABLE'
export type Result<T> =
  { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }
export type AudioSelection = { canceled: true } | { canceled: false; mutation: LibraryMutation }

export interface DesktopApi extends EbookSpeechApi, TextSourceApi, PluginApi, BackupStorageApi {
  getTranscriptEditingState(request: TranscriptRequest): Promise<Result<TranscriptEditingState>>
  changeTranscript(request: TranscriptEditRequest): Promise<Result<TranscriptEditResult>>
  undoTranscriptEdit(request: TranscriptHistoryRequest): Promise<Result<TranscriptEditResult>>
  redoTranscriptEdit(request: TranscriptHistoryRequest): Promise<Result<TranscriptEditResult>>
  previewTranscriptReplacement(
    request: TranscriptReplacementRequest,
  ): Promise<Result<TranscriptReplacementPreview>>
  getTranscriptReplacementPreview(request: {
    token: string
    page: number
  }): Promise<Result<TranscriptReplacementPreview>>
  applyTranscriptReplacement(
    request: ApplyTranscriptReplacement,
  ): Promise<Result<TranscriptEditResult>>
  cancelTranscriptReplacement(request: { requestId: string }): Promise<Result<void>>
  getTranscriptAlignment(request: TranscriptRequest): Promise<Result<TranscriptAlignmentState>>
  startTranscriptAlignment(
    request: TranscriptAlignmentRequest,
  ): Promise<Result<TranscriptAlignmentState>>
  cancelTranscriptAlignment(request: { id: string }): Promise<Result<void>>
  applyTranscriptAlignment(request: ApplyTranscriptAlignment): Promise<Result<TranscriptEditResult>>
  onTranscriptEditingChanged(callback: (target: TranscriptRequest) => void): () => void
  previewOfflinePreparation(request: PreviewOfflinePlanRequest): Promise<Result<OfflinePlanPreview>>
  cancelOfflinePreview(request: { requestId: string }): Promise<Result<void>>
  createOfflinePreparation(request: { token: string }): Promise<Result<OfflinePlan>>
  listOfflinePreparations(request: {
    page: number
    activeOnly: boolean
  }): Promise<Result<OfflinePlanPage>>
  getOfflinePreparation(request: {
    id: string
    itemPage: number
  }): Promise<Result<OfflinePlanDetail>>
  updateOfflinePreparation(request: UpdateOfflinePlanRequest): Promise<Result<OfflinePlan>>
  releaseOfflineMedia(request: { id: string; revision: number }): Promise<Result<OfflinePlan>>
  onOfflinePreparationChanged(callback: () => void): () => void
  getComponentInstallations(): Promise<Result<ComponentInstallationState>>
  chooseComponentPackage(
    request: ComponentProfile,
  ): Promise<Result<{ canceled: boolean; state: ComponentInstallationState }>>
  startComponentInstallation(request: { id: string }): Promise<Result<ComponentInstallationState>>
  cancelComponentInstallation(request: { id: string }): Promise<Result<void>>
  activateComponentInstallation(request: {
    id: string
  }): Promise<Result<ComponentInstallationState>>
  onComponentInstallationsChanged(callback: () => void): () => void
  getProcessingResources(): Promise<Result<ProcessingResources>>
  setProcessingResources(request: UpdateProcessingPolicy): Promise<Result<ProcessingResources>>
  setProcessingPaused(request: PauseProcessing): Promise<Result<ProcessingResources>>
  onProcessingResourcesChanged(callback: () => void): () => void
  getOriginalAcousticState(request: OriginalTarget): Promise<Result<OriginalAcousticState>>
  startOriginalAcousticAlignment(
    request: OriginalAcousticRequest,
  ): Promise<Result<OriginalAcousticState>>
  cancelOriginalAcousticAlignment(request: { id: string }): Promise<Result<void>>
  applyOriginalAcousticAlignment(
    request: ApplyOriginalAcousticRequest,
  ): Promise<Result<OriginalState>>
  restoreOriginalAcousticAlignment(
    request: RestoreOriginalAcousticRequest,
  ): Promise<Result<OriginalState>>
  onOriginalAcousticChanged(callback: (target: OriginalTarget) => void): () => void
  getListeningReview(request: ListeningReviewGet): Promise<Result<ListeningReviewState>>
  prepareListeningReview(request: ListeningReviewPrepare): Promise<Result<ListeningReviewState>>
  saveListeningReview(request: ListeningReviewSave): Promise<Result<ListeningReviewState>>
  getReadingBooks(): Promise<Result<ReadingBook[]>>
  getReadingSummaries(): Promise<Result<ReadingBookSummary[]>>
  getReadingBook(request: { id: string }): Promise<Result<ReadingBook | null>>
  getBookLinks(): Promise<Result<BookLink[]>>
  linkReadingBook(request: LinkReadingBookRequest): Promise<Result<BookLink>>
  unlinkReadingBook(request: { bookId: string }): Promise<Result<void>>
  openLinkedReading(request: OpenLinkedReadingRequest): Promise<Result<OpenLinkedReadingResult>>
  resolveLinkedListening(
    request: ResolveLinkedListeningRequest,
  ): Promise<Result<ResolveLinkedListeningResult>>
  importReadingBook(): Promise<Result<{ canceled: true } | { canceled: false; book: ReadingBook }>>
  getReadingPage(request: { id: string; start: number }): Promise<Result<OriginalPage>>
  saveReadingPosition(request: ReadingLocation): Promise<Result<void>>
  removeReadingBook(request: { id: string }): Promise<Result<void>>
  findReadingBook(request: ReadingFindRequest): Promise<Result<OriginalSearchPage>>
  findOriginal(request: OriginalFindRequest): Promise<Result<OriginalSearchPage>>
  exportSubtitles(request: SubtitleExportRequest): Promise<Result<SubtitleExportResult>>
  getOriginalState(request: OriginalTarget): Promise<Result<OriginalState>>
  importOriginal(
    request: OriginalTarget,
  ): Promise<Result<{ canceled: true } | { canceled: false; state: OriginalState }>>
  getOriginalPage(
    request: OriginalTarget & { originalId: string; start: number },
  ): Promise<Result<OriginalPage>>
  searchOriginal(
    request: OriginalTarget & { originalId: string; query: string },
  ): Promise<Result<OriginalCandidate[]>>
  matchOriginal(request: OriginalTarget): Promise<Result<OriginalState>>
  correctOriginal(request: OriginalCorrection): Promise<Result<OriginalState>>
  cancelOriginal(): Promise<Result<void>>
  searchSource(request: SourceSearchRequest): Promise<Result<SourcePage<SourceBook>>>
  getSourceBook(request: SourceBookRequest): Promise<Result<SourceBookDetail>>
  getSourceEpisodes(request: SourceEpisodesRequest): Promise<Result<SourcePage<SourceEpisode>>>
  cancelSourceRequest(request: { id: string }): Promise<Result<void>>
  addSourceBook(
    request: SourceBookRequest & { episodeId?: string },
  ): Promise<Result<LibraryMutation>>
  continueSourceBook(request: { id: string }): Promise<Result<LibraryMutation>>
  setSourcePreparation(request: {
    id: string
    settings: SourcePreparation
  }): Promise<Result<LibraryMutation>>
  getSourcePreparationState(): Promise<Result<SourcePreparationStatus>>
  onSourceChanged(callback: () => void): () => void
  getSourceCacheState(): Promise<Result<SourceCacheUsage>>
  previewSourceCacheClear(): Promise<Result<SourceCachePreview>>
  clearSourceCache(request: { token: string }): Promise<Result<SourceCacheUsage>>
  getState(): Promise<Result<AppState>>
  getLibraryOverview(): Promise<Result<LibraryOverview>>
  getBookDetail(request: { id: string }): Promise<Result<Book | null>>
  getBookEpisodes(request: {
    id: string
    offset: number
    limit: number
  }): Promise<Result<BookEpisodePage>>
  getPlaybackContext(request: { episodeId: string }): Promise<Result<PlaybackContext | null>>
  selectAudio(request: { kind: 'audio' }): Promise<Result<AudioSelection>>
  forgetFile(request: { id: string }): Promise<Result<LibraryMutation>>
  selectFolder(): Promise<Result<{ canceled: true } | { canceled: false; draft: ImportDraft }>>
  confirmImport(request: { id: string; episodeIds: string[] }): Promise<Result<LibraryMutation>>
  cancelImport(request: { id: string }): Promise<Result<void>>
  removeBook(request: { id: string }): Promise<Result<LibraryMutation>>
  importRemembered(request: { id: string }): Promise<Result<LibraryMutation>>
  openEpisode(request: OpenEpisodeRequest): Promise<Result<PlaybackSource>>
  cancelEpisodeOpen(request: OpenEpisodeRequest): Promise<Result<void>>
  getPlaybackSourceState(request: {
    sessionId: string
  }): Promise<Result<PlaybackSourceChange | null>>
  onPlaybackSourceChanged(callback: (change: PlaybackSourceChange) => void): () => void
  releasePlayback(request: { sessionId: string }): Promise<Result<void>>
  saveProgress(request: ProgressUpdate): Promise<Result<void>>
  quitApp(): Promise<Result<void>>
  onFlush(callback: (requestId: string) => void): () => void
  flushed(request: { id: string }): Promise<Result<void>>
  getTranscript(request: TranscriptRequest): Promise<Result<TranscriptState>>
  importTranscript(
    request: TranscriptRequest,
  ): Promise<Result<{ canceled: true } | { canceled: false; state: TranscriptState }>>
  previewSubtitleImport(request: SubtitleImportRequest): Promise<Result<SubtitleImportSelection>>
  updateSubtitleImportPreview(
    request: SubtitleImportPreviewRequest,
  ): Promise<Result<SubtitleImportPreview>>
  getSubtitleImportPreview(
    request: SubtitleImportPageRequest,
  ): Promise<Result<SubtitleImportPreview>>
  applySubtitleImport(request: ApplySubtitleImport): Promise<Result<SubtitleImportResult>>
  cancelSubtitleImport(request: { requestId: string }): Promise<Result<void>>
  getTranscriptionState(request: TranscriptRequest): Promise<Result<TranscriptionState>>
  syncTranscription(request: TranscriptionSyncRequest): Promise<Result<TranscriptionSyncState>>
  getTranscriptionSummary(request: TranscriptRequest): Promise<Result<TranscriptionSummaryState>>
  getSubtitleStatuses(request: {
    episodes: SubtitleStatusTarget[]
  }): Promise<Result<SubtitleStatusSnapshot[]>>
  setSubtitlePreparation(request: {
    id: string
    settings: SubtitlePreparation
  }): Promise<Result<LibraryMutation>>
  startTranscription(request: StartTranscription): Promise<Result<TranscriptionState>>
  startAutomaticSubtitles(
    request: StartAutomaticSubtitles,
  ): Promise<
    Result<
      AutomaticSubtitlesResult & { context: PlaybackContext | null; mutation: LibraryMutation }
    >
  >
  cancelAutomaticSubtitles(request: CancelAutomaticSubtitles): Promise<Result<TranscriptionState>>
  prepareAndStartTranscription(request: StartPreparedTranscription): Promise<
    Result<{
      context: PlaybackContext | null
      mutation: LibraryMutation
      transcription: TranscriptionState
      createdJob: boolean
    }>
  >
  cancelTranscription(request: { id: string }): Promise<Result<void>>
  retryTranscription(request: { id: string }): Promise<Result<void>>
  previewTranscription(request: { id: string }): Promise<Result<TranscriptionPreview>>
  applyTranscription(request: { id: string; revision: number }): Promise<Result<TranscriptState>>
  configureTranscription(): Promise<Result<{ canceled: boolean }>>
  detectTranscriptionComponents(): Promise<Result<ComponentSetupState>>
  useDetectedTranscriptionComponent(request: { id: string }): Promise<Result<ComponentSetupState>>
  chooseTranscriptionComponentFolder(): Promise<Result<{ canceled: boolean }>>
  checkTranscriptionComponent(): Promise<Result<ComponentCheck>>
  prioritizeTranscription(
    request: TranscriptRequest & { positionMs: number },
  ): Promise<Result<void>>
  onComponentChanged(callback: () => void): () => void
  onTranscriptionChanged(callback: (change: TranscriptionChange) => void): () => void
  editTranscript(request: TranscriptEdit): Promise<Result<TranscriptState>>
  getTranscriptRegions(request: TranscriptRequest): Promise<Result<TranscriptRegions>>
  markTranscriptRegion(request: RegionUpdate): Promise<Result<TranscriptRegions>>
  getBookmarks(request: { id: string }): Promise<Result<Bookmark[]>>
  saveBookmark(request: SaveBookmark): Promise<Result<Bookmark>>
  editBookmark(request: { id: string; note: string }): Promise<Result<void>>
  removeBookmark(request: { id: string }): Promise<Result<void>>
  setBookSkips(request: { id: string } & BookSkips): Promise<Result<LibraryMutation>>
  getMaintenanceState(): Promise<Result<MaintenanceState>>
  getTranscriptionJobs(request: TaskQuery): Promise<Result<TaskPage>>
  prepareCacheClear(): Promise<Result<CacheClearPreview>>
  clearTranscriptionCache(request: { token: string }): Promise<Result<CacheClearResult>>
  readAppLog(): Promise<Result<AppLog>>
  showMaintenanceLocation(request: { target: MaintenanceLocation }): Promise<Result<void>>
}
