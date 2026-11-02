import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { BACKUP_STORAGE_CHANNELS as channels } from '../../shared/backup-storage'
import type { Result } from '../../shared/contracts'
import { APP_NAME } from '../../shared/brand'
import { AppError, isTrustedRenderer } from '../../shared/validation'
import type { BackupService } from './backup'
import { validateBackupSettings } from './backup'
import type { GeneratedStorageService } from './storage-policy'
import { validateGeneratedStoragePolicy } from './storage-policy'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export function validateBackupStorageArgs(channel: string, args: unknown[]) {
  if (
    [
      channels.choose,
      channels.restored,
      channels.acknowledge,
      channels.storageState,
      channels.storagePreview,
    ].includes(channel as typeof channels.choose)
  ) {
    if (args.length) throw new AppError('INVALID_REQUEST', '备份或存储请求不接受参数。')
    return
  }
  if (args.length !== 1 || !object(args[0]) || Object.keys(args[0]).length !== 1)
    throw new AppError('INVALID_REQUEST', '备份或存储请求格式无效。')
  const request = args[0]
  if (channel === channels.export && Object.hasOwn(request, 'settings')) {
    validateBackupSettings(request.settings)
    return
  }
  if (channel === channels.storagePolicy && Object.hasOwn(request, 'policy')) {
    validateGeneratedStoragePolicy(request.policy)
    return
  }
  const key =
    channel === channels.restore ? 'previewId' : channel === channels.storageClear ? 'token' : null
  if (
    key &&
    typeof request[key] === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request[key])
  )
    return
  throw new AppError('INVALID_REQUEST', '备份或存储请求参数无效。')
}
export function registerBackupStorageIpc(
  window: BrowserWindow,
  rendererUrl: string,
  backup: BackupService,
  storage: GeneratedStorageService,
  options: { onRestorePrepared?: () => void; onError?: (error: unknown) => void } = {},
): () => void {
  const actions: Record<string, (request: Record<string, unknown>) => unknown> = {
    [channels.export]: async (request) => {
      const picked = await dialog.showSaveDialog(window, {
        title: '导出书架与阅读资料备份',
        defaultPath: `${APP_NAME}备份-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: `${APP_NAME}备份 ZIP`, extensions: ['zip'] }],
      })
      if (picked.canceled || !picked.filePath) return { canceled: true }
      return { canceled: false, backup: await backup.exportTo(picked.filePath, request.settings) }
    },
    [channels.choose]: async () => {
      const picked = await dialog.showOpenDialog(window, {
        title: `选择${APP_NAME}备份`,
        properties: ['openFile'],
        filters: [{ name: `${APP_NAME}备份 ZIP`, extensions: ['zip'] }],
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      return { canceled: false, preview: await backup.previewFile(picked.filePaths[0]) }
    },
    [channels.restore]: async (request) => {
      const result = await backup.stageRestore(String(request.previewId))
      if (options.onRestorePrepared) setTimeout(options.onRestorePrepared, 250)
      return result
    },
    [channels.restored]: () => backup.restoredSettings(),
    [channels.acknowledge]: () => backup.acknowledgeSettings(),
    [channels.storageState]: () => storage.state(),
    [channels.storagePolicy]: (request) => storage.savePolicy(request.policy),
    [channels.storagePreview]: () => storage.preview(),
    [channels.storageClear]: (request) => storage.clear(String(request.token)),
  }
  for (const [channel, action] of Object.entries(actions))
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<unknown>> => {
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
          throw new AppError('FORBIDDEN', '此页面无权备份或管理生成物。')
        validateBackupStorageArgs(channel, args)
        return { ok: true, value: await action((args[0] ?? {}) as Record<string, unknown>) }
      } catch (error) {
        if (error instanceof AppError)
          return { ok: false, error: { code: error.code, message: error.message } }
        options.onError?.(error)
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: '备份或存储操作未完成，原书库与未处理文件已保留，请检查磁盘空间后重试。',
          },
        }
      }
    })
  return () => {
    for (const channel of Object.keys(actions)) ipcMain.removeHandler(channel)
  }
}
