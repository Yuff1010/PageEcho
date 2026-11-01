const ALLOWED =
  /^ralb:(?:(?:app|reader|reading|companion):[a-zA-Z0-9:_-]{1,160}|ebook-speech:v1|library:layout|reader-preferences:v1)$/

export function collectBackupPreferences(storage: Storage): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && ALLOWED.test(key)) result[key] = storage.getItem(key) ?? ''
  }
  return result
}

/** Replace only the supported preferences; roll back all local changes on failure. */
export function restoreBackupPreferences(storage: Storage, settings: Record<string, string>) {
  if (Object.keys(settings).some((key) => !ALLOWED.test(key)))
    throw new Error('备份设置含不支持的项目。')
  const previous = collectBackupPreferences(storage)
  try {
    for (const key of Object.keys(previous)) storage.removeItem(key)
    for (const [key, value] of Object.entries(settings)) storage.setItem(key, value)
  } catch (error) {
    for (const key of Object.keys(settings)) storage.removeItem(key)
    for (const [key, value] of Object.entries(previous)) storage.setItem(key, value)
    throw error
  }
}
