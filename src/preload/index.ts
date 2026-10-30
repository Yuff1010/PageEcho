import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type DesktopApi } from '../shared/contracts'
import { SPEECH_CHANNELS } from '../shared/ebook-speech'
import { TEXT_SOURCE_CHANNELS } from '../shared/text-source-api'
import { PLUGIN_CHANNELS } from '../shared/plugins'
import type { TranscriptionChange } from '../shared/transcription'
import type { OriginalTarget } from '../shared/original'

const api: DesktopApi = {
  pluginList: () => ipcRenderer.invoke(PLUGIN_CHANNELS.list),
  pluginChoose: () => ipcRenderer.invoke(PLUGIN_CHANNELS.choose),
  pluginPreviewUrl: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.previewUrl, request),
  pluginInstall: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.install, request),
  pluginCancel: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.cancel, request),
  pluginToggle: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.toggle, request),
  pluginRemove: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.remove, request),
  pluginRollback: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.rollback, request),
  pluginTest: (request) => ipcRenderer.invoke(PLUGIN_CHANNELS.test, request),
  pluginSourceCatalog: () => ipcRenderer.invoke(PLUGIN_CHANNELS.sourceCatalog),
  textSources: () => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.state),
  textBrowse: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.browse, request),
  textDetail: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.detail, request),
  textImport: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.import, request),
  textCancel: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.cancel, request),
  remoteLibrarySave: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.save, request),
  remoteLibraryRemove: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.remove, request),
  remoteLibraryCheck: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.check, request),
  remoteManifestPreview: (request) =>
    ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.manifestPreview, request),
  remoteManifestApply: (request) => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.manifestApply, request),
  remoteManifestExport: () => ipcRenderer.invoke(TEXT_SOURCE_CHANNELS.manifestExport),
  getEbookSpeechVoices: () => ipcRenderer.invoke(SPEECH_CHANNELS.voices),
  synthesizeEbookSpeech: (request) => ipcRenderer.invoke(SPEECH_CHANNELS.synthesize, request),
  releaseEbookSpeech: () => ipcRenderer.invoke(SPEECH_CHANNELS.release),
  previewSubtitleImport: (request) => ipcRenderer.invoke(CHANNELS.subtitleImportPreview, request),
  updateSubtitleImportPreview: (request) =>
    ipcRenderer.invoke(CHANNELS.subtitleImportUpdate, request),
  getSubtitleImportPreview: (request) => ipcRenderer.invoke(CHANNELS.subtitleImportPage, request),
  applySubtitleImport: (request) => ipcRenderer.invoke(CHANNELS.subtitleImportApply, request),
  cancelSubtitleImport: (request) => ipcRenderer.invoke(CHANNELS.subtitleImportCancel, request),
  getTranscriptEditingState: (request) =>
    ipcRenderer.invoke(CHANNELS.transcriptEditingState, request),
  changeTranscript: (request) => ipcRenderer.invoke(CHANNELS.transcriptChange, request),
  undoTranscriptEdit: (request) => ipcRenderer.invoke(CHANNELS.transcriptUndo, request),
  redoTranscriptEdit: (request) => ipcRenderer.invoke(CHANNELS.transcriptRedo, request),
  previewTranscriptReplacement: (request) =>
    ipcRenderer.invoke(CHANNELS.replacementPreview, request),
  getTranscriptReplacementPreview: (request) =>
    ipcRenderer.invoke(CHANNELS.replacementPage, request),
  applyTranscriptReplacement: (request) => ipcRenderer.invoke(CHANNELS.replacementApply, request),
  cancelTranscriptReplacement: (request) => ipcRenderer.invoke(CHANNELS.replacementCancel, request),
  getTranscriptAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.transcriptAlignmentState, request),
  startTranscriptAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.transcriptAlignmentStart, request),
  cancelTranscriptAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.transcriptAlignmentCancel, request),
  applyTranscriptAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.transcriptAlignmentApply, request),
  onTranscriptEditingChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, target: OriginalTarget) => callback(target)
    ipcRenderer.on(CHANNELS.transcriptEditingChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.transcriptEditingChanged, listener)
  },
  previewOfflinePreparation: (request) => ipcRenderer.invoke(CHANNELS.offlinePreview, request),
  cancelOfflinePreview: (request) => ipcRenderer.invoke(CHANNELS.offlinePreviewCancel, request),
  createOfflinePreparation: (request) => ipcRenderer.invoke(CHANNELS.offlineCreate, request),
  listOfflinePreparations: (request) => ipcRenderer.invoke(CHANNELS.offlineList, request),
  getOfflinePreparation: (request) => ipcRenderer.invoke(CHANNELS.offlineGet, request),
  updateOfflinePreparation: (request) => ipcRenderer.invoke(CHANNELS.offlineUpdate, request),
  releaseOfflineMedia: (request) => ipcRenderer.invoke(CHANNELS.offlineRelease, request),
  onOfflinePreparationChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.offlineChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.offlineChanged, listener)
  },
  getComponentInstallations: () => ipcRenderer.invoke(CHANNELS.componentInstallations),
  chooseComponentPackage: (request) => ipcRenderer.invoke(CHANNELS.componentPackageChoose, request),
  startComponentInstallation: (request) =>
    ipcRenderer.invoke(CHANNELS.componentInstallationStart, request),
  cancelComponentInstallation: (request) =>
    ipcRenderer.invoke(CHANNELS.componentInstallationCancel, request),
  activateComponentInstallation: (request) =>
    ipcRenderer.invoke(CHANNELS.componentInstallationActivate, request),
  onComponentInstallationsChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.componentInstallationsChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.componentInstallationsChanged, listener)
  },
  getProcessingResources: () => ipcRenderer.invoke(CHANNELS.processingResources),
  setProcessingResources: (request) => ipcRenderer.invoke(CHANNELS.processingPolicy, request),
  setProcessingPaused: (request) => ipcRenderer.invoke(CHANNELS.processingPaused, request),
  onProcessingResourcesChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.processingResourcesChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.processingResourcesChanged, listener)
  },
  getOriginalAcousticState: (request) =>
    ipcRenderer.invoke(CHANNELS.originalAcousticState, request),
  startOriginalAcousticAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.originalAcousticStart, request),
  cancelOriginalAcousticAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.originalAcousticCancel, request),
  applyOriginalAcousticAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.originalAcousticApply, request),
  restoreOriginalAcousticAlignment: (request) =>
    ipcRenderer.invoke(CHANNELS.originalAcousticRestore, request),
  onOriginalAcousticChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, target: OriginalTarget) => callback(target)
    ipcRenderer.on(CHANNELS.originalAcousticChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.originalAcousticChanged, listener)
  },
  getListeningReview: (request) => ipcRenderer.invoke(CHANNELS.listeningReviewGet, request),
  prepareListeningReview: (request) => ipcRenderer.invoke(CHANNELS.listeningReviewPrepare, request),
  saveListeningReview: (request) => ipcRenderer.invoke(CHANNELS.listeningReviewSave, request),
  getReadingBooks: () => ipcRenderer.invoke(CHANNELS.readingList),
  getBookLinks: () => ipcRenderer.invoke(CHANNELS.bookLinksList),
  linkReadingBook: (request) => ipcRenderer.invoke(CHANNELS.bookLinksLink, request),
  unlinkReadingBook: (request) => ipcRenderer.invoke(CHANNELS.bookLinksUnlink, request),
  openLinkedReading: (request) => ipcRenderer.invoke(CHANNELS.bookLinksReading, request),
  resolveLinkedListening: (request) => ipcRenderer.invoke(CHANNELS.bookLinksListening, request),
  importReadingBook: () => ipcRenderer.invoke(CHANNELS.readingImport),
  getReadingPage: (request) => ipcRenderer.invoke(CHANNELS.readingPage, request),
  saveReadingPosition: (request) => ipcRenderer.invoke(CHANNELS.readingProgress, request),
  removeReadingBook: (request) => ipcRenderer.invoke(CHANNELS.readingRemove, request),
  findReadingBook: (request) => ipcRenderer.invoke(CHANNELS.readingFind, request),
  getOriginalState: (request) => ipcRenderer.invoke(CHANNELS.originalState, request),
  importOriginal: (request) => ipcRenderer.invoke(CHANNELS.originalImport, request),
  getOriginalPage: (request) => ipcRenderer.invoke(CHANNELS.originalPage, request),
  searchOriginal: (request) => ipcRenderer.invoke(CHANNELS.originalSearch, request),
  findOriginal: (request) => ipcRenderer.invoke(CHANNELS.originalFind, request),
  exportSubtitles: (request) => ipcRenderer.invoke(CHANNELS.exportSubtitles, request),
  matchOriginal: (request) => ipcRenderer.invoke(CHANNELS.originalMatch, request),
  correctOriginal: (request) => ipcRenderer.invoke(CHANNELS.originalCorrect, request),
  cancelOriginal: () => ipcRenderer.invoke(CHANNELS.originalCancel),
  searchSource: (request) => ipcRenderer.invoke(CHANNELS.sourceSearch, request),
  getSourceBook: (request) => ipcRenderer.invoke(CHANNELS.sourceBook, request),
  getSourceEpisodes: (request) => ipcRenderer.invoke(CHANNELS.sourceEpisodes, request),
  cancelSourceRequest: (request) => ipcRenderer.invoke(CHANNELS.sourceCancel, request),
  addSourceBook: (request) => ipcRenderer.invoke(CHANNELS.sourceAdd, request),
  continueSourceBook: (request) => ipcRenderer.invoke(CHANNELS.sourceContinuation, request),
  setSourcePreparation: (request) => ipcRenderer.invoke(CHANNELS.sourcePreparation, request),
  getSourcePreparationState: () => ipcRenderer.invoke(CHANNELS.sourcePreparationState),
  getSourceCacheState: () => ipcRenderer.invoke(CHANNELS.sourceCacheState),
  previewSourceCacheClear: () => ipcRenderer.invoke(CHANNELS.sourceCachePreview),
  clearSourceCache: (request) => ipcRenderer.invoke(CHANNELS.sourceCacheClear, request),
  onSourceChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.sourceChanged, listener)
    return () => {
      ipcRenderer.removeListener(CHANNELS.sourceChanged, listener)
    }
  },
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  getMaintenanceState: () => ipcRenderer.invoke(CHANNELS.maintenanceState),
  getTranscriptionJobs: (request) => ipcRenderer.invoke(CHANNELS.maintenanceTasks, request),
  prepareCacheClear: () => ipcRenderer.invoke(CHANNELS.prepareCacheClear),
  clearTranscriptionCache: (request) => ipcRenderer.invoke(CHANNELS.clearCache, request),
  readAppLog: () => ipcRenderer.invoke(CHANNELS.appLog),
  showMaintenanceLocation: (request) => ipcRenderer.invoke(CHANNELS.showLocation, request),
  getBookmarks: (request) => ipcRenderer.invoke(CHANNELS.bookmarks, request),
  saveBookmark: (request) => ipcRenderer.invoke(CHANNELS.saveBookmark, request),
  editBookmark: (request) => ipcRenderer.invoke(CHANNELS.editBookmark, request),
  removeBookmark: (request) => ipcRenderer.invoke(CHANNELS.removeBookmark, request),
  setBookSkips: (request) => ipcRenderer.invoke(CHANNELS.bookSkips, request),
  getTranscript: (request) => ipcRenderer.invoke(CHANNELS.getTranscript, request),
  importTranscript: (request) => ipcRenderer.invoke(CHANNELS.importTranscript, request),
  getTranscriptionState: (request) => ipcRenderer.invoke(CHANNELS.transcriptionState, request),
  syncTranscription: (request) => ipcRenderer.invoke(CHANNELS.transcriptionSync, request),
  getTranscriptionSummary: (request) => ipcRenderer.invoke(CHANNELS.transcriptionSummary, request),
  getSubtitleStatuses: (request) => ipcRenderer.invoke(CHANNELS.subtitleStatuses, request),
  setSubtitlePreparation: (request) => ipcRenderer.invoke(CHANNELS.subtitlePreparation, request),
  startTranscription: (request) => ipcRenderer.invoke(CHANNELS.startTranscription, request),
  startAutomaticSubtitles: (request) =>
    ipcRenderer.invoke(CHANNELS.startAutomaticSubtitles, request),
  cancelAutomaticSubtitles: (request) =>
    ipcRenderer.invoke(CHANNELS.cancelAutomaticSubtitles, request),
  prepareAndStartTranscription: (request) =>
    ipcRenderer.invoke(CHANNELS.prepareAndStartTranscription, request),
  cancelTranscription: (request) => ipcRenderer.invoke(CHANNELS.cancelTranscription, request),
  retryTranscription: (request) => ipcRenderer.invoke(CHANNELS.retryTranscription, request),
  previewTranscription: (request) => ipcRenderer.invoke(CHANNELS.previewTranscription, request),
  applyTranscription: (request) => ipcRenderer.invoke(CHANNELS.applyTranscription, request),
  configureTranscription: () => ipcRenderer.invoke(CHANNELS.configureTranscription),
  detectTranscriptionComponents: () => ipcRenderer.invoke(CHANNELS.detectTranscriptionComponents),
  useDetectedTranscriptionComponent: (request) =>
    ipcRenderer.invoke(CHANNELS.useDetectedTranscriptionComponent, request),
  chooseTranscriptionComponentFolder: () =>
    ipcRenderer.invoke(CHANNELS.chooseTranscriptionComponentFolder),
  checkTranscriptionComponent: () => ipcRenderer.invoke(CHANNELS.checkTranscriptionComponent),
  prioritizeTranscription: (request) =>
    ipcRenderer.invoke(CHANNELS.prioritizeTranscription, request),
  onComponentChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.componentChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.componentChanged, listener)
  },
  editTranscript: (request) => ipcRenderer.invoke(CHANNELS.editTranscript, request),
  getTranscriptRegions: (request) => ipcRenderer.invoke(CHANNELS.transcriptRegions, request),
  markTranscriptRegion: (request) => ipcRenderer.invoke(CHANNELS.markTranscriptRegion, request),
  onTranscriptionChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, change: TranscriptionChange) =>
      callback(change)
    ipcRenderer.on(CHANNELS.transcriptionChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.transcriptionChanged, listener)
  },
  selectAudio: (request) => ipcRenderer.invoke(CHANNELS.selectAudio, request),
  forgetFile: (request) => ipcRenderer.invoke(CHANNELS.forgetFile, request),
  selectFolder: () => ipcRenderer.invoke(CHANNELS.selectFolder),
  confirmImport: (request) => ipcRenderer.invoke(CHANNELS.confirmImport, request),
  cancelImport: (request) => ipcRenderer.invoke(CHANNELS.cancelImport, request),
  removeBook: (request) => ipcRenderer.invoke(CHANNELS.removeBook, request),
  importRemembered: (request) => ipcRenderer.invoke(CHANNELS.importRemembered, request),
  openEpisode: (request) => ipcRenderer.invoke(CHANNELS.openEpisode, request),
  cancelEpisodeOpen: (request) => ipcRenderer.invoke(CHANNELS.cancelEpisodeOpen, request),
  saveProgress: (request) => ipcRenderer.invoke(CHANNELS.saveProgress, request),
  quitApp: () => ipcRenderer.invoke(CHANNELS.quitApp),
  onFlush: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on(CHANNELS.flush, listener)
    return () => ipcRenderer.removeListener(CHANNELS.flush, listener)
  },
  flushed: (request) => ipcRenderer.invoke(CHANNELS.flushed, request),
}

contextBridge.exposeInMainWorld('desktop', api)
