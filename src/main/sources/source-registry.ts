import { SourceError, type SourceAdapter, type SourceId } from '../../shared/sources'
import { SourceBrowser } from './source-browser'

// Browsing one provider never replaces or cancels a request owned by another provider.
export class AudioSourceRegistry {
  private readonly browsers = new Map<SourceId, SourceBrowser>()
  private readonly retired = new Set<SourceBrowser>()
  constructor(
    entries: { adapter: SourceAdapter; close: () => void }[],
    private readonly dynamic?: (id: SourceId) => SourceAdapter | undefined,
  ) {
    for (const { adapter, close } of entries) {
      if (this.browsers.has(adapter.id)) throw new Error(`Duplicate audio source: ${adapter.id}`)
      this.browsers.set(adapter.id, new SourceBrowser(adapter, close))
    }
  }
  get(sourceId: SourceId): SourceBrowser {
    let browser = this.browsers.get(sourceId)
    if (this.dynamic && sourceId.startsWith('plugin:')) {
      const adapter = this.dynamic(sourceId)
      if (!adapter)
        throw new SourceError(
          'SOURCE_UNAVAILABLE',
          '此来源插件已停用或移除，已保存的书架和进度仍保留。',
        )
      if (browser?.adapter !== adapter) {
        if (browser) {
          const previous = browser
          this.retired.add(previous)
          void previous
            .whenIdle()
            .then(() => previous.close())
            .finally(() => this.retired.delete(previous))
        }
        browser = new SourceBrowser(adapter, () => {})
        this.browsers.set(sourceId, browser)
      }
    }
    if (!browser) throw new SourceError('INVALID_SOURCE_REQUEST', '未配置此有声书来源。')
    return browser
  }
  cancel(id: string) {
    for (const browser of [...this.browsers.values(), ...this.retired]) browser.cancel(id)
  }
  async close() {
    await Promise.all(
      [...this.browsers.values(), ...this.retired].map((browser) => browser.close()),
    )
  }
}
