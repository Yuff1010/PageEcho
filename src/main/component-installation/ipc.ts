import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Result } from '../../shared/contracts'
import type { ComponentProfile } from '../../shared/component-installation'
import { AppError, isTrustedRenderer, validateRequest } from '../../shared/validation'
import type { ComponentInstallationService } from './service'

export function registerComponentInstallationIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: ComponentInstallationService,
  log: (error: unknown) => void,
): void {
  let choosing = false
  const actions: Record<string, (request: unknown) => unknown> = {
    [CHANNELS.componentInstallations]: () => service.state(),
    [CHANNELS.componentPackageChoose]: async (value) => {
      if (choosing) throw new AppError('BUSY', '组件包选择窗口已打开，请先完成选择。')
      choosing = true
      try {
        const selection = await dialog.showOpenDialog(window, {
          title: '选择离线字幕组件 ZIP 包',
          properties: ['openFile'],
          filters: [{ name: '离线组件包', extensions: ['zip'] }],
        })
        if (selection.canceled || selection.filePaths.length !== 1)
          return { canceled: true, state: service.state() }
        return {
          canceled: false,
          state: service.select(selection.filePaths[0]!, value as ComponentProfile),
        }
      } finally {
        choosing = false
      }
    },
    [CHANNELS.componentInstallationStart]: (value) => service.start((value as { id: string }).id),
    [CHANNELS.componentInstallationCancel]: (value) => service.cancel((value as { id: string }).id),
    [CHANNELS.componentInstallationActivate]: (value) =>
      service.activate((value as { id: string }).id),
  }
  for (const [channel, action] of Object.entries(actions))
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
          if (error instanceof AppError)
            return { ok: false, error: { code: error.code, message: error.message } }
          log(error)
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '组件操作未完成，请重试或查看应用日志。' },
          }
        }
      },
    )
}
