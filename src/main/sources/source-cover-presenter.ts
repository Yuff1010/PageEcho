import type { SourceBook } from '../../shared/sources'
import type { TextBookSummary } from '../../shared/text-sources'
import type { PluginService } from '../plugins/service'
import type { TextSourceService } from './text-service'
import { SourceCoverService, builtinSourceCoverPolicy } from './source-covers'

/** Only main-process source results register fetchable images. Renderer URLs grant no network authority. */
export class SourceCoverPresenter {
  constructor(
    private covers: SourceCoverService,
    private plugins: PluginService,
    private text: TextSourceService,
  ) {}

  private present<T extends { sourceId: string; coverUrl?: string | null; pageUrl: string | null }>(
    book: T,
  ): T {
    if (!book.coverUrl) return book
    try {
      return this.register(book)
    } catch {
      return { ...book, coverUrl: null }
    }
  }

  private register<
    T extends { sourceId: string; coverUrl?: string | null; pageUrl: string | null },
  >(book: T): T {
    let origins: string[] = []
    let referer = book.pageUrl ?? undefined
    if (book.sourceId.startsWith('plugin:')) {
      const source = this.plugins.list().sources.find((source) => source.id === book.sourceId)
      if (source) {
        origins = source.coverOrigins ?? source.allowedOrigins
        referer = source.baseUrl
      }
    } else if (book.sourceId === 'ting13' || book.sourceId === 'librivox') {
      return {
        ...book,
        coverUrl: this.covers.register(
          book.sourceId,
          book.coverUrl,
          builtinSourceCoverPolicy(book.sourceId, book.pageUrl ?? '', book.coverUrl ?? ''),
        ),
      }
    } else {
      const source = this.text.state().sources.find((source) => source.id === book.sourceId)
      if (source) {
        origins = [new URL(source.baseUrl).origin]
        referer = source.baseUrl
      }
    }
    return {
      ...book,
      coverUrl: this.covers.register(book.sourceId, book.coverUrl, {
        allowedOrigins: origins,
        referer,
      }),
    }
  }

  audio(book: SourceBook): SourceBook {
    return this.present(book)
  }
  ebook(book: TextBookSummary): TextBookSummary {
    return this.present(book)
  }
}
