import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { open } from 'node:fs/promises'
import { PLUGIN_CHANNELS, type AudioSourceInfo } from '../../shared/plugins'
import type { Result } from '../../shared/contracts'
import { AppError, isTrustedRenderer } from '../../shared/validation'
import { SourceError } from '../../shared/sources'
import { MAX_PLUGIN_ZIP_BYTES } from './manifest'
import type { PluginService } from './service'
import { validatePluginArgs } from './validation'

export function registerPluginIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: PluginService,
  sourceCatalog: () => AudioSourceInfo[] = () => service.audioSources(),
): () => void {
  const channels = PLUGIN_CHANNELS
  const actions: Record<string, (request: unknown) => unknown> = {
    [channels.list]: () => service.list(),
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
        return { canceled: false, preview: service.previewFile(Buffer.concat(chunks)) }
      } finally {
        await file.close()
      }
    },
    [channels.previewUrl]: (request) =>
      service.previewUrl(request as { requestId: string; url: string }),
    [channels.install]: (request) => service.install((request as { previewId: string }).previewId),
    [channels.cancel]: (request) => service.cancel((request as { requestId: string }).requestId),
    [channels.toggle]: (request) => {
      const value = request as { id: string; enabled: boolean }
      return service.toggle(value.id, value.enabled)
    },
    [channels.remove]: (request) => service.remove((request as { id: string }).id),
    [channels.rollback]: (request) => service.rollback((request as { id: string }).id),
    [channels.test]: (request) =>
      service.test(request as { requestId: string; id: string; sourceId: string; query?: string }),
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
