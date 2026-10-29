import { SourceError, type SourceAdapter, type SourceId } from '../../shared/sources'
import { SourceBrowser } from './source-browser'

// Browsing one provider never replaces or cancels a request owned by another provider.
export class AudioSourceRegistry {
  private readonly browsers = new Map<SourceId, SourceBrowser>()
  constructor(entries: { adapter: SourceAdapter; close: () => void }[]) {
    for (const { adapter, close } of entries) {
      if (this.browsers.has(adapter.id)) throw new Error(`Duplicate audio source: ${adapter.id}`)
      this.browsers.set(adapter.id, new SourceBrowser(adapter, close))
    }
  }
  get(sourceId: SourceId): SourceBrowser {
    const browser = this.browsers.get(sourceId)
    if (!browser) throw new SourceError('INVALID_SOURCE_REQUEST', '未配置此有声书来源。')
    return browser
  }
  cancel(id: string) {
    for (const browser of this.browsers.values()) browser.cancel(id)
  }
  async close() {
    await Promise.all([...this.browsers.values()].map((browser) => browser.close()))
  }
}
