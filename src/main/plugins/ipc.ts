import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { open } from 'node:fs/promises'
import { PLUGIN_CHANNELS, type AudioSourceInfo } from '../../shared/plugins'
import type { Result } from '../../shared/contracts'
import { AppError, isTrustedRenderer } from '../../shared/validation'
import { SourceError } from '../../shared/sources'
import { MAX_PLUGIN_ZIP_BYTES } from './manifest'
import type { PluginService } from './service'
import { validatePluginArgs } from './validation'
import type { PluginMaintenance } from './maintenance'

export function registerPluginIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: PluginService,
  sourceCatalog: () => AudioSourceInfo[] = () => service.audioSources(),
  maintenance?: PluginMaintenance,
): () => void {
  const channels = PLUGIN_CHANNELS
  const state = (value = service.list()) => maintenance?.state(value) ?? value
  const maintained = () => {
    if (!maintenance)
      throw new SourceError('SOURCE_UNAVAILABLE', '插件维护服务尚未准备好，请重启应用。')
    return maintenance
  }
  const actions: Record<string, (request: unknown) => unknown> = {
    [channels.list]: () => state(),
    [channels.choose]: async () => {
      const picked = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: '来源插件 ZIP', extensions: ['zip'] }],
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      const file = await open(picked.filePaths[0], 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile() || !stat.size || stat.size > MAX_PLUGIN_ZIP_BYTES)
          throw new SourceError('INVALID_SOURCE_REQUEST', '请选择非空且不超过 8 MiB 的插件 ZIP。')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of file.createReadStream({
          autoClose: false,
          end: MAX_PLUGIN_ZIP_BYTES,
        })) {
          size += chunk.length
          if (size > MAX_PLUGIN_ZIP_BYTES)
            throw new SourceError('INVALID_SOURCE_REQUEST', '插件 ZIP 在读取期间超过 8 MiB。')
          chunks.push(Buffer.from(chunk))
        }
        const preview = service.previewFile(Buffer.concat(chunks))
        return { canceled: false, preview: maintenance?.decoratePreview(preview) ?? preview }
      } finally {
        await file.close()
      }
    },
    [channels.previewUrl]: (request) =>
      (maintenance ?? service).previewUrl(request as { requestId: string; url: string }),
    [channels.install]: (request) => {
      const value = request as { previewId: string; updateUrl?: string | null }
      return maintenance ? maintenance.install(value) : service.install(value.previewId)
    },
    [channels.setUpdateUrl]: (request) =>
      maintained().setUpdateUrl(request as { id: string; url: string | null }),
    [channels.checkUpdate]: (request) =>
      maintained().checkUpdate(request as { requestId: string; id: string }),
    [channels.cancel]: (request) =>
      (maintenance ?? service).cancel((request as { requestId: string }).requestId),
    [channels.toggle]: (request) => {
      const value = request as { id: string; enabled: boolean }
      return state(service.toggle(value.id, value.enabled))
    },
    [channels.remove]: (request) => {
      const id = (request as { id: string }).id
      const value = service.remove(id)
      maintenance?.forget(id)
      return state(value)
    },
    [channels.rollback]: (request) => state(service.rollback((request as { id: string }).id)),
    [channels.test]: (request) =>
      (maintenance ?? service).test(
        request as { requestId: string; id: string; sourceId: string; query?: string },
      ),
    [channels.sourceCatalog]: () => sourceCatalog(),
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
          throw new AppError('FORBIDDEN', '此页面无权管理来源插件。')
        validatePluginArgs(channel, args)
        return { ok: true, value: await action(args[0]) }
      } catch (error) {
        if (error instanceof SourceError || error instanceof AppError)
          return { ok: false, error: { code: error.code, message: error.message } }
        return {
          ok: false,
          error: {
            code: 'SOURCE_UNAVAILABLE',
            message: '插件操作未完成，请检查包文件、权限或连接后重试。',
          },
        }
      }
    })
  return () => {
    for (const channel of Object.values(channels)) ipcMain.removeHandler(channel)
  }
}
