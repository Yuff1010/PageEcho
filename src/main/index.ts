import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  protocol,
  session,
  Tray,
  nativeImage,
  powerMonitor,
  safeStorage,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { appendFileSync } from 'node:fs'
import { join, dirname as parentDirectory } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDataPaths } from './paths'
import { LibraryStore } from './database'
import { registerIpc } from './ipc'
import { APP_URL, PRODUCTION_CSP, resolveRendererResource } from './resources'
import { serveMedia } from './media'
import { LIBRARY_SCHEMA_VERSION } from './database-schema'
import { CHANNELS } from '../shared/contracts'
import { APP_NAME, APP_TITLE } from '../shared/brand'
import { AppError, isTrustedRenderer } from '../shared/validation'
import { AsrComponent } from './asr-component'
import { ComponentSetup, componentDiscoveryRoots } from './component-setup'
import { TranscriptionQueue } from './transcription-queue'
import { CacheMaintenance } from './cache-maintenance'
import { AudioSourceRegistry } from './sources/source-registry'
import { LibriVoxAdapter } from './sources/librivox'
import { Ting13Adapter } from './sources/ting13'
import { Ting13Session } from './sources/ting13-session'
import { OnlineMedia } from './sources/online-media'
import { SourceCache } from './sources/source-cache'
import { OnlinePreparation } from './sources/online-preparation'
import { OriginalService } from './original/service'
import { cachedMediaDuration } from './sources/media-duration'
import { ListeningReviewStore } from './listening-review-store'
import { registerListeningReviewIpc } from './listening-review-ipc'
import { OriginalAcousticService } from './original/acoustic-service'
import { registerOriginalAcousticIpc } from './original/acoustic-ipc'
import { ComponentInstallerCore } from './component-installation/core'
import { ComponentInstallationService } from './component-installation/service'
import { registerComponentInstallationIpc } from './component-installation/ipc'
import { OfflinePreparation } from './offline-preparation'
import { registerOfflinePreparationIpc } from './offline-ipc'
import { TranscriptEditingService } from './transcript-editing-service'
import { registerTranscriptEditingIpc } from './transcript-editing-ipc'
import { SubtitleImportService } from './subtitle-import-service'
import { EbookSpeech, SPEECH_MEDIA_PREFIX } from './ebook-speech'
import { registerEbookSpeechIpc } from './ebook-speech-ipc'
import { TextSourceService } from './sources/text-service'
import { TextBookImporter } from './sources/text-book-importer'
import { WebdavLibraryConnector } from './sources/webdav-library'
import { AudiobookshelfLibraryConnector } from './sources/audiobookshelf-library'
import { registerTextSourceIpc } from './sources/text-source-ipc'
import { PluginRuntime } from './plugins/runtime'
import { PluginService } from './plugins/service'
import { registerPluginIpc } from './plugins/ipc'
import { PluginMaintenance } from './plugins/maintenance'
import { BackupService, applyPendingRestoreAtStartup } from './maintenance/backup'
import { registerBackupStorageIpc } from './maintenance/backup-ipc'
import { GeneratedStorageService } from './maintenance/storage-policy'
import { SOURCE_METADATA, sourceQueryLimit } from '../shared/sources'
import { SourceCoverService } from './sources/source-covers'
import { SOURCE_COVER_PREFIX } from '../shared/source-covers'
import { SourceCoverPresenter } from './sources/source-cover-presenter'
import { PersistentBookCovers } from './sources/persistent-book-covers'
import { BOOK_COVER_PREFIX } from '../shared/source-covers'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'readlisten',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])
// The portable distribution keeps the signed official electron.exe unchanged;
// Electron reports isPackaged=false for that filename even with resources/app.asar.
const bundledArchive =
  app.getAppPath().toLowerCase() === join(process.resourcesPath, 'app.asar').toLowerCase()
const bundledResources = app.isPackaged || bundledArchive
// Preserve Electron's existing default user-data directory across display rebrands.
app.setName(bundledResources ? 'ReadAndListenBook' : 'ReadAndListenBook-dev')
const root = process.env.RALB_USER_DATA || app.getPath('userData')
let store: LibraryStore | undefined
let logPath: string | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let flushed = false
let flushId: string | undefined
let quitTimer: NodeJS.Timeout | undefined
let transcription: TranscriptionQueue | undefined
let componentSetup: ComponentSetup | undefined
let listeningReviews: ListeningReviewStore | undefined
let acoustic: OriginalAcousticService | undefined
let componentInstallation: ComponentInstallationService | undefined
let finishing = false
let sources: AudioSourceRegistry | undefined
let onlineMedia: OnlineMedia | undefined
let preparation: OnlinePreparation | undefined
let offlinePreparation: OfflinePreparation | undefined
let transcriptEditing: TranscriptEditingService | undefined
let subtitleImports: SubtitleImportService | undefined
let ebookSpeech: EbookSpeech | undefined
let textSources: TextSourceService | undefined
let textImporter: TextBookImporter | undefined
let plugins: PluginService | undefined
let pluginMaintenance: PluginMaintenance | undefined
let pluginRuntime: PluginRuntime | undefined
let sourceCovers: SourceCoverService | undefined
let bookCovers: PersistentBookCovers | undefined
const originals = new OriginalService()

// A small code-drawn book icon; no external assets or network dependency.
function trayIcon() {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of payload) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, payload, checksum])
  }
  const pixels = Buffer.alloc(32 * (32 * 4 + 1))
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const offset = y * 129 + 1 + x * 4
      const line =
        (y >= 8 && y <= 24 && (x === 7 || x === 15 || x === 24)) ||
        (x >= 7 && x <= 24 && (y === 8 || y === 24))
      pixels.set(line ? [245, 242, 235, 255] : [45, 81, 68, 255], offset)
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(32, 0)
  header.writeUInt32BE(32, 4)
  header[8] = 8
  header[9] = 6
  return nativeImage.createFromBuffer(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

function finishQuit() {
  if (finishing) return
  finishing = true
  clearTimeout(quitTimer)
  void (async () => {
    const stoppingAcoustic = acoustic?.close().catch(logError)
    const stoppingInstallation = componentInstallation?.close().catch(logError)
    const stoppingOffline = offlinePreparation?.close().catch(logError)
    const stoppingEditing = transcriptEditing?.close().catch(logError)
    const stoppingImports = subtitleImports?.close().catch(logError)
    ebookSpeech?.close()
    textSources?.close()
    pluginMaintenance?.close()
    plugins?.close()
    sourceCovers?.close()
    const stoppingBookCovers = bookCovers?.close().catch(logError)
    const stoppingPluginRuntime = pluginRuntime?.close().catch(logError)
    const stoppingTextImporter = textImporter?.close().catch(logError)
    const stoppingTranscription = transcription?.close().catch(logError)
    const stoppingComponents = componentSetup?.close()
    await originals.close().catch(logError)
    try {
      await preparation?.close()
      await sources?.close()
    } catch (error) {
      logError(error)
    }
    try {
      await onlineMedia?.close()
    } catch (error) {
      logError(error)
    }
    try {
      await stoppingTranscription
      await stoppingAcoustic
      await stoppingInstallation
      await stoppingOffline
      await stoppingEditing
      await stoppingImports
      await stoppingTextImporter
      await stoppingPluginRuntime
      await stoppingComponents
      await stoppingBookCovers
    } catch (error) {
      logError(error)
    }
    flushed = true
    app.quit()
  })()
}

function logError(error: unknown) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(message)
  if (logPath) {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
    } catch {
      /* Keep the original failure. */
    }
  }
}

async function start() {
  const paths = createDataPaths(root)
  logPath = join(paths.logs, 'app.log')
  app.setPath('userData', paths.root)
  app.setPath('sessionData', paths.session)
  app.setAppLogsPath(paths.logs)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  await app.whenReady()
  const restore = await applyPendingRestoreAtStartup(paths.root, {
    maxSchemaVersion: LIBRARY_SCHEMA_VERSION,
  })
  app.setAppUserModelId('com.readandlistenbook.desktop')
  store = new LibraryStore(paths.database)
  ebookSpeech = new EbookSpeech(store.reading)
  listeningReviews = new ListeningReviewStore(join(paths.data, 'listening-reviews.sqlite3'), store)
  appendFileSync(
    logPath,
    `${new Date().toISOString()} Started ${app.getVersion()} Electron ${process.versions.electron} Node ${process.versions.node}\n`,
  )
  Menu.setApplicationMenu(null)
  const dirname = fileURLToPath(new URL('.', import.meta.url))
  const component = new AsrComponent(
    join(paths.root, 'asr-component.json'),
    bundledResources
      ? join(process.resourcesPath, 'asr/asr_worker.py')
      : join(dirname, '../../python/asr_worker.py'),
  )
  const componentLoaded = component.load()
  componentSetup = new ComponentSetup(
    component,
    componentDiscoveryRoots(
      app.getAppPath(),
      parentDirectory(app.getPath('exe')),
      process.resourcesPath,
    ),
  )
  const rendererRoot = join(dirname, '../renderer')
  const developmentUrl = !bundledResources ? process.env.ELECTRON_RENDERER_URL : undefined
  const rendererUrl = developmentUrl ? new URL(developmentUrl).href : APP_URL
  const allowFullscreen = (
    contents: { id: number } | null,
    permission: string,
    details: { isMainFrame: boolean; requestingUrl?: string },
  ) =>
    permission === 'fullscreen' &&
    !!contents &&
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    isTrustedRenderer(
      contents.id,
      mainWindow.webContents.id,
      details.isMainFrame,
      details.requestingUrl ?? '',
      rendererUrl,
    )
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowFullscreen(contents, permission, details)),
  )
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowFullscreen(contents, permission, details),
  )
  protocol.handle('readlisten', async (request) => {
    if (request.url.startsWith(BOOK_COVER_PREFIX))
      return bookCovers ? bookCovers.serve(request) : new Response('Not found', { status: 404 })
    if (request.url.startsWith(SOURCE_COVER_PREFIX))
      return sourceCovers ? sourceCovers.serve(request) : new Response('Not found', { status: 404 })
    if (request.url.startsWith(SPEECH_MEDIA_PREFIX))
      return ebookSpeech!.serve(
        request,
        developmentUrl ? new URL(developmentUrl).origin : 'readlisten://app',
      )
    if (new URL(request.url).pathname.startsWith('/stream/'))
      return onlineMedia
        ? onlineMedia.servePlayback(
            request,
            developmentUrl ? new URL(developmentUrl).origin : 'readlisten://app',
          )
        : new Response(null, { status: 404 })
    if (new URL(request.url).pathname.startsWith('/media/'))
      return serveMedia(
        request,
        store!,
        developmentUrl ? new URL(developmentUrl).origin : 'readlisten://app',
      )
    const path = resolveRendererResource(rendererRoot, request.url)
    if (!path || request.method !== 'GET') return new Response('Forbidden', { status: 403 })
    try {
      const response = await net.fetch(pathToFileURL(path).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', PRODUCTION_CSP)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  if (developmentUrl) {
    const origin = new URL(developmentUrl).origin
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: readlisten://app; media-src 'self' readlisten:; connect-src 'self' ${origin.replace('http:', 'ws:')}; object-src 'none'; base-uri 'none'; frame-src 'none'`,
          ],
        },
      })
    })
  }
  const window = new BrowserWindow({
    width: 1160,
    height: 800,
    minWidth: 720,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: '#121212',
    show: false,
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })
  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', (_event, details) => {
    logError(new Error(`Renderer stopped: ${details.reason}`))
    finishQuit()
  })
  transcription = new TranscriptionQueue(
    store,
    component,
    (change) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(CHANNELS.transcriptionChanged, change)
        window.webContents.send(CHANNELS.transcriptEditingChanged, change)
      }
      preparation?.changed(change)
      offlinePreparation?.changed()
    },
    logError,
    undefined,
    async (runtime, signal) => {
      try {
        await componentSetup!.ensureRuntime(runtime, signal)
      } finally {
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send(CHANNELS.componentChanged)
      }
    },
    {
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      notify: () => {
        offlinePreparation?.changed()
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send(CHANNELS.processingResourcesChanged)
      },
    },
  )
  pluginRuntime = new PluginRuntime()
  plugins = new PluginService({
    directory: join(paths.data, 'source-plugins'),
    runtime: pluginRuntime,
    onChanged: () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.sourceChanged)
    },
  })
  pluginMaintenance = new PluginMaintenance({
    directory: join(paths.data, 'plugin-maintenance'),
    service: plugins,
  })
  registerPluginIpc(
    window,
    rendererUrl,
    plugins,
    () => [
      ...SOURCE_METADATA.map((source) => ({
        ...source,
        maxQueryLength: sourceQueryLimit(source.id),
      })),
      ...plugins!.audioSources(),
    ],
    pluginMaintenance,
  )
  const sourceSession = new Ting13Session()
  sources = new AudioSourceRegistry(
    [
      { adapter: new Ting13Adapter(sourceSession), close: () => sourceSession.close() },
      { adapter: new LibriVoxAdapter(), close: () => {} },
    ],
    (id) => plugins!.audioAdapter(id),
  )
  const mediaSession = new Ting13Session()
  const sourceCache = new SourceCache(
    store,
    join(paths.cache, 'source-media'),
    () =>
      new Set([
        ...transcription!.protectedEpisodeIds,
        ...(onlineMedia?.protectedEpisodeIds ?? []),
        ...(store!.getPlayerState().currentEpisodeId
          ? [store!.getPlayerState().currentEpisodeId!]
          : []),
      ]),
  )
  onlineMedia = new OnlineMedia(
    store,
    new AudioSourceRegistry(
      [
        { adapter: new Ting13Adapter(mediaSession), close: () => mediaSession.close() },
        { adapter: new LibriVoxAdapter(), close: () => {} },
      ],
      (id) => plugins!.audioAdapter(id),
    ),
    join(paths.cache, 'source-media'),
    () => {},
    undefined,
    undefined,
    sourceCache,
    (action) => transcription!.withMaintenance(action, true),
  )
  preparation = new OnlinePreparation(
    store,
    onlineMedia,
    transcription,
    () => {
      offlinePreparation?.changed()
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.sourceChanged)
    },
    async (id) => {
      const audio = store!.getAudio(id)
      if (!audio || store!.getEpisode(id)?.durationMs !== null) return
      const duration = await cachedMediaDuration(window, id, audio.contentHash)
      store!.recordSourceDuration(id, audio.contentHash, duration)
    },
  )
  offlinePreparation = new OfflinePreparation({
    store,
    queue: transcription,
    media: onlineMedia,
    directory: paths.cache,
    measureDuration: (id, hash, signal) => cachedMediaDuration(window, id, hash, signal),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    notify: () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.offlineChanged)
    },
    libraryChanged: () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.sourceChanged)
    },
    log: logError,
  })
  await offlinePreparation.initialize()
  registerOfflinePreparationIpc(window, rendererUrl, offlinePreparation, logError)
  subtitleImports = new SubtitleImportService({
    store,
    notify: (target) => transcription!.changed(target),
  })
  sourceCovers = new SourceCoverService({
    trustedRendererOrigin: developmentUrl ? new URL(developmentUrl).origin : undefined,
  })
  bookCovers = new PersistentBookCovers({
    directory: join(paths.data, 'book-covers'),
    sourceCovers,
    thumbnail: (bytes) => {
      const original = nativeImage.createFromBuffer(bytes)
      if (original.isEmpty()) throw new Error('Invalid cover image')
      return (
        original.getSize().width > 320 ? original.resize({ width: 320, quality: 'good' }) : original
      ).toJPEG(85)
    },
  })
  const coverPresenter = () => new SourceCoverPresenter(sourceCovers!, plugins!, textSources!)
  const presentSource = {
    audio: (book: Parameters<SourceCoverPresenter['audio']>[0]) =>
      sourceCovers && textSources ? coverPresenter().audio(book) : book,
  }
  registerIpc(
    window,
    rendererUrl,
    store,
    paths.root,
    logError,
    {
      quit: () => app.quit(),
      flushed: (id) => {
        if (id === flushId) finishQuit()
      },
    },
    transcription,
    component,
    new CacheMaintenance(component, paths.root, paths.logs),
    sources,
    onlineMedia,
    preparation,
    originals,
    subtitleImports,
    componentSetup,
    presentSource,
    bookCovers,
  )
  registerListeningReviewIpc(window, rendererUrl, listeningReviews, logError)
  registerEbookSpeechIpc(window, rendererUrl, ebookSpeech)
  textImporter = new TextBookImporter(store, paths.cache)
  textSources = new TextSourceService({
    directory: paths.data,
    plugins: {
      sources: () => plugins!.textSources(),
      browse: (request, signal) => plugins!.textBrowse(request, signal),
      detail: (request, signal) => plugins!.textDetail(request, signal),
      download: (request, signal) => plugins!.textDownload(request, signal),
    },
    importBook: (bytes, filename, signal) => textImporter!.import(bytes, filename, signal),
    importChapters: (input, signal) => textImporter!.importChapters(input, signal),
    getSourceReading: (sourceKey) => store!.reading.sourceState(sourceKey),
    getSourceReadingByBook: (id) => store!.reading.sourceByBook(id),
    getReadingBook: (id) => {
      try {
        return store!.reading.get(id)
      } catch {
        return null
      }
    },
    connectors: {
      webdav: new WebdavLibraryConnector(),
      audiobookshelf: new AudiobookshelfLibraryConnector(),
    },
    secretCodec: {
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable())
          throw new AppError('INVALID_REQUEST', '系统凭据加密不可用，请先使用无凭据书库。')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    },
  })
  registerTextSourceIpc(window, rendererUrl, textSources, coverPresenter(), bookCovers)
  const generatedStorage = new GeneratedStorageService({
    directory: join(paths.cache, 'generated-artifacts'),
  })
  const backup = new BackupService({
    root: paths.root,
    version: app.getVersion(),
    maxSchemaVersion: LIBRARY_SCHEMA_VERSION,
    generated: generatedStorage,
    isBusy: () =>
      !!store?.activeJobs().length ||
      !!transcription?.maintaining ||
      !!textSources?.busy ||
      !!offlinePreparation?.busy,
    publicPlugins: () =>
      plugins!.list().plugins.map(({ id, name, version }) => ({ id, name, version })),
    withSnapshot: (copy) => bookCovers!.withSnapshot(copy),
  })
  registerBackupStorageIpc(window, rendererUrl, backup, generatedStorage, {
    onRestorePrepared: () => {
      app.relaunch({ args: process.argv.slice(1) })
      app.quit()
    },
    onError: logError,
  })
  acoustic = new OriginalAcousticService(
    store,
    component,
    transcription,
    (target, saved) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(CHANNELS.originalAcousticChanged, target)
        if (saved) window.webContents.send(CHANNELS.transcriptionChanged, target)
      }
    },
    logError,
  )
  registerOriginalAcousticIpc(window, rendererUrl, acoustic, logError)
  transcriptEditing = new TranscriptEditingService({
    store,
    component,
    queue: transcription,
    notify: (target, saved) => {
      if (saved) transcription!.changed(target)
      else if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.transcriptEditingChanged, target)
    },
    log: logError,
  })
  registerTranscriptEditingIpc(window, rendererUrl, transcriptEditing, logError)
  const installationRoot = join(paths.root, 'c')
  componentInstallation = new ComponentInstallationService({
    root: installationRoot,
    settingsFile: join(paths.root, 'asr-component.json'),
    workerScript: join(parentDirectory(component.probeScript), 'asr_worker.py'),
    component,
    queue: transcription,
    core: new ComponentInstallerCore(installationRoot),
    notify: () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.componentInstallationsChanged)
    },
    componentChanged: () => {
      transcription?.start()
      preparation?.componentChanged()
      offlinePreparation?.changed()
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.componentChanged)
    },
    log: logError,
  })
  await componentInstallation.load().catch(logError)
  registerComponentInstallationIpc(window, rendererUrl, componentInstallation, logError)
  transcription.start()
  void componentLoaded
    .then(() => {
      if (quitting) return
      transcription?.start()
      preparation?.componentChanged()
      offlinePreparation?.changed()
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(CHANNELS.componentChanged)
    })
    .catch(logError)
  const showWindow = () => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip(`${APP_NAME} · 关闭窗口后继续播放`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: showWindow },
        { type: 'separator' },
        { label: `退出${APP_NAME}`, click: () => app.quit() },
      ]),
    )
    tray.on('double-click', showWindow)
  } catch (error) {
    logError(error)
  }
  window.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault()
      window.hide()
    } else if (!quitting) {
      event.preventDefault()
      app.quit()
    }
  })
  app.on('second-instance', () => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  window.once('ready-to-show', () => window.show())
  await window.loadURL(rendererUrl)
  if (restore.notice)
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: '备份恢复',
      message: restore.notice,
    })
  offlinePreparation.start()
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  quitting = true
  if (flushed) return
  event.preventDefault()
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    finishQuit()
    return
  }
  if (flushId) return
  flushId = randomUUID()
  mainWindow.webContents.send(CHANNELS.flush, flushId)
  quitTimer = setTimeout(() => {
    logError(new Error('退出时未收到播放器确认，保留最近一次保存的进度。'))
    finishQuit()
  }, 3000)
})
app.on('will-quit', () => {
  tray?.destroy()
  tray = undefined
  listeningReviews?.close()
  listeningReviews = undefined
  store?.close()
  store = undefined
})
void start().catch((error: unknown) => {
  logError(error)
  dialog.showErrorBox(
    `${APP_NAME}无法启动`,
    `请确认数据目录可写，并查看 logs/app.log。\n${error instanceof Error ? error.message : '未知错误'}`,
  )
  app.exit(1)
})
