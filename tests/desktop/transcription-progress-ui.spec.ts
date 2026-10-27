import { test, expect, type Page, type Locator } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNELS } from '../../src/shared/contracts'
import type { TranscriptRequest } from '../../src/shared/transcript'
import {
  transcriptionProgressFixture as fixture,
  transcriptionProgressFixtureAvailable,
  transcriptionProgressFixtureRequirement,
} from '../helpers/transcription-progress-fixture'

test.skip(!transcriptionProgressFixtureAvailable, transcriptionProgressFixtureRequirement)

const region = (target: Page | Locator) =>
  target.getByRole('region', { name: '字幕生成进度', exact: true })
const progress = (target: Page | Locator) =>
  target.getByRole('progressbar', { name: '字幕生成进度条', exact: true })
const recorded = (page: Page) => page.locator('audio[data-player="persistent"]')
async function state(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate(
    (target) => window.desktop.getTranscriptionState(target),
    target,
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function playAndRead(page: Page) {
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect
    .poll(() => recorded(page).evaluate((audio: HTMLAudioElement) => audio.paused))
    .toBe(false)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  return region(page.getByRole('region', { name: '播放器', exact: true }))
}
async function detail(card: Locator, text: string) {
  const trigger = card.getByRole('button', { name: '字幕生成详情', exact: true })
  await trigger.click()
  const panel = card.getByRole('group', { name: '字幕生成详情', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(text)
  await trigger.press('Escape')
  await expect(panel).toBeHidden()
}
async function count(card: Locator, completed: number) {
  await expect(card.locator('.transcription-inline-count')).toHaveAttribute(
    'aria-label',
    `已完成 ${completed} / 3 段`,
  )
}
async function assertStillPlaying(page: Page) {
  const before = await recorded(page).evaluate((audio: HTMLAudioElement) => audio.currentTime)
  await expect
    .poll(() => recorded(page).evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(before + 1)
  expect(await recorded(page).evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false)
}
async function pauseAndPlayAgain(page: Page) {
  const player = page.getByRole('region', { name: '播放器', exact: true })
  await player.getByRole('button', { name: '暂停', exact: true }).click()
  await player.getByRole('button', { name: '播放', exact: true }).click()
  await assertStillPlaying(page)
}
async function ratio(bar: Locator) {
  return bar.evaluate((element) =>
    element instanceof HTMLProgressElement
      ? element.value / element.max
      : Number(element.getAttribute('aria-valuenow')) /
        Number(element.getAttribute('aria-valuemax') ?? 100),
  )
}

test('first playback shows cancellable indeterminate preparation before a job exists and suppresses late probe results', async ({}, info) => {
  const data = await fixture()
  try {
    const card = await playAndRead(data.page)
    await expect.poll(() => existsSync(join(data.gates, 'probe-started'))).toBe(true)
    await detail(card, '正在自动准备字幕')
    await expect(card).toContainText('检查字幕组件')
    await expect(progress(card)).toBeVisible()
    expect(await progress(card).getAttribute('aria-valuenow')).toBeNull()
    expect(await progress(card).getAttribute('value')).toBeNull()
    await data.page.screenshot({
      path: info.outputPath('checking-components-progress.png'),
      animations: 'disabled',
    })
    await expect(data.page.getByRole('button', { name: '生成本集字幕', exact: true })).toBeHidden()
    expect((await state(data.page, data.target)).job).toBeNull()
    await card.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect(card).toContainText('字幕生成已取消')
    await expect(progress(card)).toBeHidden()
    data.gate('probe-release')
    await pauseAndPlayAgain(data.page)
    expect((await state(data.page, data.target)).job).toBeNull()
    expect(data.submissions()).toBe(0)
    await expect(card).toContainText('字幕生成已取消')
    await data.page.screenshot({
      path: info.outputPath('canceled-before-job.png'),
      animations: 'disabled',
    })
  } finally {
    await data.close()
  }
})

test('a queued subtitle job exposes cancellation while ordinary audio continues and another Play does not recreate it', async () => {
  const data = await fixture({ releaseProbe: true })
  try {
    const paused = await data.page.evaluate(async () => {
      const current = await window.desktop.getProcessingResources()
      if (!current.ok) throw new Error(current.error.message)
      return window.desktop.setProcessingPaused({ revision: current.value.revision, paused: true })
    })
    expect(paused.ok).toBe(true)
    const card = await playAndRead(data.page)
    await expect.poll(async () => (await state(data.page, data.target)).job?.status).toBe('queued')
    await expect(card).toContainText('排队等待')
    await card.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect
      .poll(async () => (await state(data.page, data.target)).job?.status)
      .toBe('canceled')
    await expect(card).toContainText('字幕生成已取消')
    const canceled = (await state(data.page, data.target)).job!
    await pauseAndPlayAgain(data.page)
    expect((await state(data.page, data.target)).job).toMatchObject({
      id: canceled.id,
      attempt: canceled.attempt,
      status: 'canceled',
    })
    expect(data.submissions()).toBe(0)
  } finally {
    await data.close()
  }
})

test('canceling a probe also invalidates a pending linked-book preparation intent while a later explicit retry can start once', async () => {
  const data = await fixture({ linkedOriginal: true })
  try {
    await data.app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      Reflect.set(globalThis, 'progressAutomaticRequests', [])
      handlers.set(channel, (...args) => {
        const request = args[1] as { explicit?: boolean }
        const requests = Reflect.get(globalThis, 'progressAutomaticRequests') as boolean[]
        requests.push(!!request.explicit)
        return original(...args)
      })
    }, CHANNELS.startAutomaticSubtitles)
    const card = await playAndRead(data.page)
    await expect.poll(() => existsSync(join(data.gates, 'probe-started'))).toBe(true)
    await detail(card, '正在自动准备字幕')
    await data.page.getByRole('button', { name: '从当前进度阅读', exact: true }).click()
    await expect(data.page.getByRole('main', { name: '独立阅读页' })).toBeVisible()
    await data.page.mouse.move(300, 20)
    await data.page.getByRole('button', { name: '从此处听书', exact: true }).click()
    const choice = data.page.getByRole('dialog', { name: '选择对应的声音位置', exact: true })
    await expect(choice).toContainText('这段文字还没有声音同步点')
    await choice.getByRole('button', { name: '准备字幕并匹配', exact: true }).click()
    await expect(choice).toBeHidden()
    await detail(card, '正在自动准备字幕')
    expect(
      await data.app.evaluate(() => Reflect.get(globalThis, 'progressAutomaticRequests')),
    ).toEqual([false])
    await card.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect(card).toContainText('字幕生成已取消')
    data.gate('probe-release')
    await assertStillPlaying(data.page)
    expect((await state(data.page, data.target)).job).toBeNull()
    expect(data.submissions()).toBe(0)
    expect(
      await data.app.evaluate(() => Reflect.get(globalThis, 'progressAutomaticRequests')),
    ).toEqual([false])
    await expect(card).toContainText('字幕生成已取消')
    await card.getByRole('button', { name: '重新生成字幕', exact: true }).click()
    await expect.poll(async () => (await state(data.page, data.target)).job?.stage).toBe('loading')
    await expect(card).toContainText('加载转写模型')
    await expect.poll(data.submissions).toBe(1)
    const requests = await data.app.evaluate(
      () => Reflect.get(globalThis, 'progressAutomaticRequests') as boolean[],
    )
    // Adopting a checked component can trigger an idempotent automatic refresh.
    // The deliberate retry must be issued once and admit only one worker task.
    expect(requests.slice(0, 2)).toEqual([false, true])
    expect(requests.filter(Boolean)).toHaveLength(1)
    await assertStillPlaying(data.page)
  } finally {
    await data.close()
  }
})

test('model loading has a live indeterminate state and a disabled canceling transition before its worker acknowledges cancellation', async ({}, info) => {
  const data = await fixture({ releaseProbe: true, holdCancelAck: true })
  try {
    const card = await playAndRead(data.page)
    await expect.poll(async () => (await state(data.page, data.target)).job?.stage).toBe('loading')
    await expect(card).toContainText('加载转写模型')
    await expect(progress(card)).toBeVisible()
    expect(await progress(card).getAttribute('value')).toBeNull()
    expect(await progress(card).getAttribute('aria-valuenow')).toBeNull()
    await data.page.screenshot({
      path: info.outputPath('loading-model-progress.png'),
      animations: 'disabled',
    })
    await card.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect(card.getByRole('button', { name: '正在取消…', exact: true })).toBeDisabled()
    data.gate('cancel-ack')
    await expect
      .poll(async () => (await state(data.page, data.target)).job?.status)
      .toBe('canceled')
    await expect(card).toContainText('字幕生成已取消')
    await assertStillPlaying(data.page)
  } finally {
    await data.close()
  }
})

test('partial subtitles remain readable with advancing real chunk progress and cancellation preserves the saved prefix', async ({}, info) => {
  const data = await fixture({ releaseProbe: true })
  try {
    const card = await playAndRead(data.page)
    data.gate('recognize')
    await expect(card).toContainText('识别语音')
    data.gate('first')
    await expect
      .poll(async () => (await state(data.page, data.target)).job?.completedChunks)
      .toBe(1)
    await expect(data.page.locator('.transcript-sentence-text')).toHaveText([
      '第一段已经生成的字幕。',
    ])
    await count(card, 1)
    await expect.poll(() => ratio(progress(card))).toBeCloseTo(1 / 3, 3)
    await expect(card.getByRole('button', { name: '取消字幕生成', exact: true })).toBeVisible()
    data.gate('second')
    await expect
      .poll(async () => (await state(data.page, data.target)).job?.completedChunks)
      .toBe(2)
    await count(card, 2)
    await expect.poll(() => ratio(progress(card))).toBeCloseTo(2 / 3, 3)
    await data.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(720, 600),
    )
    await expect(card.getByRole('button', { name: '取消字幕生成', exact: true })).toBeInViewport()
    await data.page.screenshot({
      path: info.outputPath('partial-live-progress-small.png'),
      animations: 'disabled',
    })
    const before = await state(data.page, data.target)
    expect(before.transcript.status).toBe('ready')
    await card.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect
      .poll(async () => (await state(data.page, data.target)).job?.status)
      .toBe('canceled')
    await detail(card, '已生成的字幕会保留，听书可以继续。')
    const after = await state(data.page, data.target)
    expect(after.transcript).toEqual(before.transcript)
    await expect(data.page.locator('.transcript-sentence-text')).toHaveText([
      '第一段已经生成的字幕。',
      '第二段字幕也可以继续阅读。',
    ])
    data.gate('finish')
    await pauseAndPlayAgain(data.page)
    expect(data.submissions()).toBe(1)
    expect((await state(data.page, data.target)).job).toMatchObject({
      id: before.job!.id,
      attempt: before.job!.attempt,
      status: 'canceled',
    })
    await data.page.screenshot({
      path: info.outputPath('partial-subtitles-canceled.png'),
      animations: 'disabled',
    })
  } finally {
    await data.close()
  }
})

test('listening tools show the same task progress and cancel action as the main reader', async () => {
  const data = await fixture({ releaseProbe: true })
  try {
    const readerCard = await playAndRead(data.page)
    data.gate('recognize')
    data.gate('first')
    await count(readerCard, 1)
    const before = await state(data.page, data.target)
    await data.page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('button', { name: '字幕与伴读', exact: true })
      .click()
    const settings = data.page.getByRole('dialog', { name: '收听工具', exact: true })
    const settingsCard = region(settings)
    await expect(settingsCard).toContainText(/1\s*\/\s*3\s*段/)
    await expect.poll(() => ratio(progress(settingsCard))).toBeCloseTo(1 / 3, 3)
    data.gate('second')
    await expect(settingsCard).toContainText(/2\s*\/\s*3\s*段/)
    expect((await state(data.page, data.target)).job?.id).toBe(before.job!.id)
    await settingsCard.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect(settingsCard).toContainText('字幕生成已取消')
    await settings.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    await expect(readerCard).toContainText('字幕生成已取消')
    await detail(readerCard, '已生成的字幕会保留，听书可以继续。')
    await expect(progress(readerCard)).toBeHidden()
    expect((await state(data.page, data.target)).job?.id).toBe(before.job!.id)
    await assertStillPlaying(data.page)
  } finally {
    await data.close()
  }
})
