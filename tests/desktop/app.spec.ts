import { menuAction } from '../helpers/ui'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function launch(root: string) {
  const env: Record<string, string> = { RALB_USER_DATA: root }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'RALB_USER_DATA')
      env[key] = value
  }
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}

async function choose(app: ElectronApplication, filePaths: string[], canceled = false) {
  await app.evaluate(
    ({ dialog }, selection) => {
      // Mock only the OS picker; the real preload, IPC, filesystem and database still run.
      dialog.showOpenDialog = async () => selection
    },
    { canceled, filePaths },
  )
}

test('sandbox, file selection, cancellation, errors and restart persistence', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读 desktop '))
  const audio = join(root, '第一章 测试.wav')
  // A valid 100 ms silent PCM WAV, generated locally; no copyrighted media.
  const wav = Buffer.alloc(44 + 1600)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(1600, 40)
  writeFileSync(audio, wav)
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    expect(
      await app.evaluate(({ app, BrowserWindow }) => {
        const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId()
        return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed
      }),
    ).toBe(true)
    expect(
      await page.evaluate(() => ({
        node: typeof Reflect.get(window, 'require'),
        keys: Object.keys(window.desktop).sort(),
      })),
    ).toEqual({
      node: 'undefined',
      keys: [
        'activateComponentInstallation',
        'addSourceBook',
        'applyOriginalAcousticAlignment',
        'applySubtitleImport',
        'applyTranscriptAlignment',
        'applyTranscriptReplacement',
        'applyTranscription',
        'cancelAutomaticSubtitles',
        'cancelComponentInstallation',
        'cancelEpisodeOpen',
        'cancelImport',
        'cancelOfflinePreview',
        'cancelOriginal',
        'cancelOriginalAcousticAlignment',
        'cancelSourceRequest',
        'cancelSubtitleImport',
        'cancelTranscriptAlignment',
        'cancelTranscriptReplacement',
        'cancelTranscription',
        'changeTranscript',
        'checkTranscriptionComponent',
        'chooseComponentPackage',
        'chooseTranscriptionComponentFolder',
        'clearSourceCache',
        'clearTranscriptionCache',
        'configureTranscription',
        'confirmImport',
        'continueSourceBook',
        'correctOriginal',
        'createOfflinePreparation',
        'detectTranscriptionComponents',
        'editBookmark',
        'editTranscript',
        'exportSubtitles',
        'findOriginal',
        'findReadingBook',
        'flushed',
        'forgetFile',
        'getBookLinks',
        'getBookmarks',
        'getComponentInstallations',
        'getEbookSpeechVoices',
        'getListeningReview',
        'getMaintenanceState',
        'getOfflinePreparation',
        'getOriginalAcousticState',
        'getOriginalPage',
        'getOriginalState',
        'getProcessingResources',
        'getReadingBooks',
        'getReadingPage',
        'getSourceBook',
        'getSourceCacheState',
        'getSourceEpisodes',
        'getSourcePreparationState',
        'getState',
        'getSubtitleImportPreview',
        'getSubtitleStatuses',
        'getTranscript',
        'getTranscriptAlignment',
        'getTranscriptEditingState',
        'getTranscriptRegions',
        'getTranscriptReplacementPreview',
        'getTranscriptionJobs',
        'getTranscriptionState',
        'getTranscriptionSummary',
        'importOriginal',
        'importReadingBook',
        'importRemembered',
        'importTranscript',
        'linkReadingBook',
        'listOfflinePreparations',
        'markTranscriptRegion',
        'matchOriginal',
        'onComponentChanged',
        'onComponentInstallationsChanged',
        'onFlush',
        'onOfflinePreparationChanged',
        'onOriginalAcousticChanged',
        'onProcessingResourcesChanged',
        'onSourceChanged',
        'onTranscriptEditingChanged',
        'onTranscriptionChanged',
        'openEpisode',
        'openLinkedReading',
        'pluginCancel',
        'pluginChoose',
        'pluginInstall',
        'pluginList',
        'pluginPreviewUrl',
        'pluginRemove',
        'pluginRollback',
        'pluginSourceCatalog',
        'pluginTest',
        'pluginToggle',
        'prepareAndStartTranscription',
        'prepareCacheClear',
        'prepareListeningReview',
        'previewOfflinePreparation',
        'previewSourceCacheClear',
        'previewSubtitleImport',
        'previewTranscriptReplacement',
        'previewTranscription',
        'prioritizeTranscription',
        'quitApp',
        'readAppLog',
        'redoTranscriptEdit',
        'releaseEbookSpeech',
        'releaseOfflineMedia',
        'remoteLibraryCheck',
        'remoteLibraryRemove',
        'remoteLibrarySave',
        'remoteManifestApply',
        'remoteManifestExport',
        'remoteManifestPreview',
        'removeBook',
        'removeBookmark',
        'removeReadingBook',
        'resolveLinkedListening',
        'restoreOriginalAcousticAlignment',
        'retryTranscription',
        'saveBookmark',
        'saveListeningReview',
        'saveProgress',
        'saveReadingPosition',
        'searchOriginal',
        'searchSource',
        'selectAudio',
        'selectFolder',
        'setBookSkips',
        'setProcessingPaused',
        'setProcessingResources',
        'setSourcePreparation',
        'setSubtitlePreparation',
        'showMaintenanceLocation',
        'startAutomaticSubtitles',
        'startComponentInstallation',
        'startOriginalAcousticAlignment',
        'startTranscriptAlignment',
        'startTranscription',
        'syncTranscription',
        'synthesizeEbookSpeech',
        'textBrowse',
        'textCancel',
        'textDetail',
        'textImport',
        'textSources',
        'undoTranscriptEdit',
        'unlinkReadingBook',
        'updateOfflinePreparation',
        'updateSubtitleImportPreview',
        'useDetectedTranscriptionComponent',
      ],
    })
    const invalid = await page.evaluate(() => window.desktop.selectAudio({ kind: 'any' } as never))
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_REQUEST')
    await choose(app, [], true)
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByText('你的故事，从这里开始')).toBeVisible()
    await choose(app, [audio])
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('heading', { name: '第一章 测试.wav', exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok).toBe(true)
    if (state.ok)
      expect(Object.keys(state.value.files[0]!).sort()).toEqual([
        'id',
        'modifiedAt',
        'name',
        'selectedAt',
        'sizeBytes',
      ])
    await choose(app, [join(root, 'missing.mp3')])
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('alert')).toContainText('无法读取这个音频文件')
    expect(errors).toEqual([])
    await app.close()

    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '第一章 测试.wav', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('app.png'), fullPage: true })
    await menuAction(page, '更多 第一章 测试.wav 的操作', '移除 第一章 测试.wav 的记录')
    await page
      .getByRole('dialog', { name: '确认移除书籍', exact: true })
      .getByRole('button', { name: '确认移除记录', exact: true })
      .click()
    await expect(page.getByText('你的故事，从这里开始')).toBeVisible()
    expect(existsSync(audio)).toBe(true)
    await app.close()
    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.getByText('你的故事，从这里开始')).toBeVisible()
    for (const directory of ['data', 'cache', 'models', 'logs', 'chromium'])
      expect(existsSync(join(root, directory))).toBe(true)
    expect(existsSync(join(root, 'data', 'library.sqlite3'))).toBe(true)
  } finally {
    await app.close()
  }
})
