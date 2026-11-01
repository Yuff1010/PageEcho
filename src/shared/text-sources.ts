import type { ReadingBook } from './reading'

export type RemoteLibraryKind = 'opds' | 'webdav' | 'audiobookshelf'

/** Secrets are write-only. Omitted secret fields preserve an existing connection's secret. */
export interface RemoteLibraryConfig {
  id?: string
  kind: RemoteLibraryKind
  label: string
  baseUrl: string
  enabled: boolean
  username?: string
  password?: string
  token?: string
}

export interface RemoteLibraryInfo {
  id: string
  kind: RemoteLibraryKind
  label: string
  baseUrl: string
  enabled: boolean
  hasCredentials: boolean
  lastCheckedAt: string | null
  lastCheckError: string | null
}

export interface TextSourceInfo {
  id: string
  name: string
  kind: 'wikisource' | 'plugin' | RemoteLibraryKind
  baseUrl: string
  description: string
}

export interface TextSourceState {
  sources: TextSourceInfo[]
  libraries: RemoteLibraryInfo[]
}

export interface TextBookSummary {
  sourceId: string
  workId: string
  title: string
  author: string | null
  description: string | null
  pageUrl: string | null
  coverUrl?: string | null
}

export interface TextNavigationLink {
  title: string
  cursor: string
}

export interface TextBrowseRequest {
  requestId: string
  sourceId: string
  query?: string
  cursor?: string
}

export interface TextBrowsePage {
  sourceId: string
  books: TextBookSummary[]
  navigation: TextNavigationLink[]
  nextCursor: string | null
  searchable: boolean
}

export interface TextDetailRequest {
  requestId: string
  sourceId: string
  workId: string
  /** Opaque, source/work-bound directory page token returned by a previous detail. */
  cursor?: string
}

export interface TextChapter {
  id: string
  title: string
  /** Host-derived position in the source directory, not a reading viewport page. */
  order?: number
}

export interface SourceReadingChapter extends TextChapter {
  text: string
}

export interface SourceReadingImport {
  sourceKey: string
  sourceId: string
  workId: string
  title: string
  pageUrl: string | null
  chapters: SourceReadingChapter[]
}

export interface SourceReadingState {
  readingBookId: string
  downloadedChapterIds: string[]
  chapterOrders: Record<string, number>
}
export interface SourceReadingContext extends SourceReadingState {
  sourceId: string
  workId: string
}
export interface TextContinueRequest {
  requestId: string
  readingBookId: string
}
export interface TextContinueResult {
  book: ReadingBook
  noMore: boolean
  appended: boolean
  addedChapterIds: string[]
  lastDownloadedOrder: number
  message: string
}

export interface TextAcquisition {
  id: string
  format: 'txt' | 'epub'
  label: string
}

export interface TextBookDetail extends TextBookSummary {
  chapters: TextChapter[]
  acquisitions: TextAcquisition[]
  notice: string | null
  nextCursor?: string | null
  chapterCursor?: string
  downloadedChapterIds?: string[]
  readingBookId?: string | null
  lastDownloadedOrder?: number
  catalogComplete?: boolean
}

export interface TextImportRequest extends Omit<TextDetailRequest, 'cursor'> {
  /** Wikisource requires an explicit nonempty selection from the displayed catalog. */
  chapterIds?: string[]
  /** OPDS acquisition id from details; purchase/borrow links are never acquisitions. */
  acquisitionId?: string
  /** Directory page on which the user explicitly selected the chapters. */
  chapterCursor?: string
}

export interface TextImportResult {
  book: ReadingBook
  reused: boolean
  sourceId: string
  workId: string
  appended?: boolean
  addedChapterIds?: string[]
}

/** Declarative connection list; never contains executable rules or credentials. */
export interface RemoteLibraryManifest {
  schemaVersion: 1
  id: string
  version: number
  libraries: Array<
    Required<Pick<RemoteLibraryConfig, 'id' | 'kind' | 'label' | 'baseUrl' | 'enabled'>>
  >
}

export interface RemoteManifestPreview {
  manifest: RemoteLibraryManifest
  additions: string[]
  updates: string[]
  currentVersion: number | null
  applicable: boolean
}
