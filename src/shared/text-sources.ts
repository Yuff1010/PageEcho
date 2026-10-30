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
}

export interface TextChapter {
  id: string
  title: string
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
}

export interface TextImportRequest extends TextDetailRequest {
  /** Wikisource requires an explicit nonempty selection from the displayed catalog. */
  chapterIds?: string[]
  /** OPDS acquisition id from details; purchase/borrow links are never acquisitions. */
  acquisitionId?: string
}

export interface TextImportResult {
  book: ReadingBook
  reused: boolean
  sourceId: string
  workId: string
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
