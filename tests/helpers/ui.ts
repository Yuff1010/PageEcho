import { expect, type Locator, type Page } from '@playwright/test'

export async function menuAction(page: Page, menu: string, action: string) {
  await page.getByRole('button', { name: menu, exact: true }).click()
  await page
    .getByRole('menu', { name: menu, exact: true })
    .getByRole('menuitem', { name: action, exact: true })
    .click()
}

export async function setVolume(page: Page, value: string) {
  await page.getByRole('button', { name: '调整音量', exact: true }).click()
  await page.getByRole('slider', { name: '音量', exact: true }).fill(value)
  await page.keyboard.press('Escape')
}

export async function openTranscriptImport(target: Page | Locator) {
  await openCompanionTools(target)
  const section = target.locator('.transcript-import')
  if ((await section.getAttribute('open')) === null)
    await section.locator(':scope > summary').click()
}

/** Open the companion's overlay tools without changing the document layout. */
export async function openCompanionTools(target: Page | Locator) {
  const trigger = target.getByRole('button', { name: '伴读工具', exact: true })
  if ((await trigger.count()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click()
}

export async function toggleCompanionGeneration(target: Page | Locator) {
  await openCompanionTools(target)
  const details = target.locator('.transcription-controls > details')
  const opened = (await details.getAttribute('open')) !== null
  await details.locator(':scope > summary').click()
  if (opened) await closeCompanionPanel(target)
}

export async function openCompanionSettings(target: Page | Locator) {
  const trigger = target.getByRole('button', { name: '伴读阅读设置', exact: true })
  if ((await trigger.count()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click()
}

export async function closeCompanionPanel(target: Page | Locator) {
  const close = target.getByRole('button', { name: '关闭伴读面板', exact: true })
  if (await close.isVisible()) await close.click()
}

export async function openCompanionProofreading(target: Page | Locator) {
  await openCompanionTools(target)
  const button = target.getByRole('button', { name: '校对与标注模式', exact: true })
  if ((await button.count()) && (await button.getAttribute('aria-pressed')) !== 'true')
    await button.click()
  const checkbox = target.getByRole('checkbox', { name: '校对与标注模式', exact: true })
  if (await checkbox.count()) await checkbox.check()
  await closeCompanionPanel(target)
}

export async function openCompanionSearch(target: Page | Locator) {
  const trigger = target.getByRole('button', { name: '搜索伴读文稿', exact: true })
  if ((await trigger.count()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click()
}

export async function closeOriginalPanel(target: Page | Locator) {
  const close = target.getByRole('button', { name: '关闭原文面板', exact: true })
  if (await close.isVisible()) await close.click()
}

export async function waitForOriginalReady(target: Page | Locator) {
  await expect(target.getByRole('dialog', { name: '原文工具', exact: true })).toBeHidden()
  await expect(target.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false')
  await expect(target.locator('.original-sentence').first()).toBeVisible()
}

export async function useOriginalText(target: Page | Locator) {
  await closeCompanionPanel(target)
  await closeOriginalPanel(target)
  const source = target
    .getByRole('group', { name: '伴读文字来源', exact: true })
    .getByRole('button', { name: '小说原文', exact: true })
  if ((await source.getAttribute('aria-pressed')) !== 'true') await source.click()
}

export async function openOriginalTools(
  target: Page | Locator,
  tab: '原文来源' | '匹配与校正' | '字幕导出' = '匹配与校正',
) {
  const dialog = target.getByRole('dialog', { name: '原文工具', exact: true })
  if (!(await dialog.isVisible())) {
    await closeOriginalPanel(target)
    await target.getByRole('button', { name: '原文工具', exact: true }).click()
  }
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: tab, exact: true }).click()
}

export async function openOriginalContents(target: Page | Locator) {
  const dialog = target.getByRole('dialog', { name: '原文目录', exact: true })
  if (!(await dialog.isVisible())) {
    await closeOriginalPanel(target)
    await target.getByRole('button', { name: '原文目录', exact: true }).click()
  }
  await expect(dialog).toBeVisible()
}

export async function openOriginalSearch(target: Page | Locator) {
  const dialog = target.getByRole('dialog', { name: '搜索小说原文', exact: true })
  if (!(await dialog.isVisible())) {
    await closeOriginalPanel(target)
    await target.getByRole('button', { name: '搜索小说原文', exact: true }).click()
  }
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.original-search')).toHaveAttribute('open', '')
}

export async function leaveCompanionPage(page: Page) {
  const back = page.getByRole('button', { name: '返回书架', exact: true })
  if (await back.isVisible()) await back.click()
}

export async function setSubtitleProfile(
  page: Page,
  profile: { engine?: 'whisperx' | 'paraformer'; device?: 'cpu' | 'cuda' },
) {
  await page
    .getByRole('region', { name: '播放器', exact: true })
    .getByRole('button', { name: '字幕与伴读', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
  await openSubtitleAdvanced(dialog)
  await dialog.getByRole('combobox', { name: '字幕准备方案', exact: true }).selectOption('manual')
  if (profile.engine)
    await dialog
      .getByRole('combobox', { name: '字幕引擎', exact: true })
      .selectOption(profile.engine)
  if (profile.device)
    await dialog
      .getByRole('combobox', { name: '字幕设备', exact: true })
      .selectOption(profile.device)
  await dialog.getByRole('button', { name: '保存字幕准备设置', exact: true }).click()
  await expect(dialog.getByText('本书字幕准备设置已保存。', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
}

export async function openSubtitleAdvanced(target: Page | Locator) {
  const category = target.getByRole('tab', { name: '字幕与缓存', exact: true })
  if ((await category.count()) && (await category.getAttribute('aria-selected')) !== 'true')
    await category.click()
  const advanced = target.locator('.subtitle-advanced-settings').first()
  if ((await advanced.getAttribute('open')) === null)
    await advanced.locator(':scope > summary').click()
}
