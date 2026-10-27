import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CHANNELS } from '../../src/shared/contracts'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { openCompanionTools } from '../helpers/ui'

// This fixture covers the manual configuration fallback with controlled
// capability diagnostics and submission failure. Default playback automation
// is exercised through real main/queue subprocesses in playback-intent.spec.ts.
async function fixture(available: boolean) {
  const root = mkdtempSync(join(tmpdir(), '听读 首次字幕检查 '))
  const audio = join(root, '山间来信.wav')
  const wav = Buffer.alloc(44 + 30 * 16000)
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
  wav.writeUInt32LE(wav.length - 44, 40)
  writeFileSync(audio, wav)
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await app.evaluate(
    ({ ipcMain, dialog }, { channels, available, audio }) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const state = {
        configured: true,
        currentDirectory: 'C:/fixture-component',
        candidates: [],
        check: null as null | Record<string, unknown>,
      }
      handlers.set(channels.detectTranscriptionComponents, () => ({ ok: true, value: state }))
      handlers.set(channels.checkTranscriptionComponent, () => {
        state.check = {
          ready: available,
          checkedAt: new Date().toISOString(),
          pythonVersion: '3.12',
          cudaName: null,
          freeBytes: null,
          issues: available ? [] : ['受控缺少字幕依赖，请选择完整组件。'],
          level: 'imports-and-files',
          capabilities: [
            {
              engine: 'paraformer',
              device: 'cpu',
              available,
              message: available ? 'ready' : '依赖缺失',
            },
          ],
        }
        return { ok: true, value: state.check }
      })
      handlers.set(channels.prepareAndStartTranscription, (_event, request) => {
        Reflect.set(globalThis, 'onboardingStartRequest', request)
        return { ok: false, error: { code: 'INTERNAL', message: '受控字幕启动失败，可以重试。' } }
      })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [audio] })
    },
    { channels: CHANNELS, available, audio },
  )
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await openCompanionTools(page)
  await page.locator('.transcription-controls > details > summary').click()
  const quick = page.getByRole('region', { name: '快速准备字幕', exact: true })
  await expect(quick).toBeVisible()
  return { app, page, quick }
}

test('manual subtitle setup checks installed capabilities before showing a concrete CPU quick start', async ({}, info) => {
  const { app, page, quick } = await fixture(true)
  try {
    await expect(page.getByRole('combobox', { name: '字幕引擎', exact: true })).toBeHidden()
    await expect(
      quick.getByRole('button', { name: '使用可用配置开始生成', exact: true }),
    ).toHaveCount(0)
    await quick.getByRole('button', { name: '检查可用配置', exact: true }).click()
    await expect(quick).toContainText('Paraformer · CPU')
    await quick.getByRole('button', { name: '使用可用配置开始生成', exact: true }).click()
    await expect(quick.getByRole('alert')).toContainText('受控字幕启动失败')
    const request = await app.evaluate(() => Reflect.get(globalThis, 'onboardingStartRequest'))
    expect(request.settings).toEqual({
      mode: 'auto',
      engine: 'paraformer',
      device: 'cpu',
      prepareNext: false,
    })
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok && state.value.books[0]?.subtitlePreparation).toBeUndefined()
    await page.screenshot({
      path: info.outputPath('first-subtitle-checked-cpu.png'),
      animations: 'disabled',
    })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('an unavailable first check explains the issue and keeps manual setup explicit', async () => {
  const { app, page, quick } = await fixture(false)
  try {
    await quick.getByRole('button', { name: '检查可用配置', exact: true }).click()
    await expect(quick).toContainText('受控缺少字幕依赖')
    await expect(
      quick.getByRole('button', { name: '使用可用配置开始生成', exact: true }),
    ).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: '字幕引擎', exact: true })).toBeHidden()
    await quick.getByRole('button', { name: '手动选择引擎和设备', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '字幕引擎', exact: true })).toBeVisible()
    const request = await app.evaluate(() => Reflect.get(globalThis, 'onboardingStartRequest'))
    expect(request).toBeUndefined()
  } finally {
    await closeOwnedElectron(app)
  }
})
