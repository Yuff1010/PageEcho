export type SourceId = 'ting13' | 'librivox'
export const SOURCE_QUERY_LIMITS: Readonly<Record<SourceId, number>> = {
  ting13: 20,
  librivox: 200,
}
export const SOURCE_METADATA: readonly {
  id: SourceId
  name: string
  kind: 'audio'
  description: string
  homepage: string
  language: string
}[] = [
  {
    id: 'ting13',
    name: '听十三',
    kind: 'audio',
    description: '中文有声书，沿用现有来源。',
    homepage: 'https://www.ting13.cc',
    language: '中文',
  },
  {
    id: 'librivox',
    name: 'LibriVox',
    kind: 'audio',
    description: '志愿者朗读的公版有声书；以外文作品为主。',
    homepage: 'https://librivox.org',
    language: '多语言',
  },
]
export function isSourceId(value: unknown): value is SourceId {
  return value === 'ting13' || value === 'librivox'
}
export interface SourcePreparation {
  cacheNext: boolean
  transcribeNext: boolean
  engine: 'whisperx' | 'paraformer'
  device: 'cpu' | 'cuda'
}
export const DEFAULT_SOURCE_PREPARATION: SourcePreparation = {
  cacheNext: false,
  transcribeNext: false,
  engine: 'whisperx',
  device: 'cpu',
}
export interface SourceCacheUsage {
  bytes: number
  files: number
  retained: number
  protectedFiles: number
  limitBytes: number
  offlineBytes?: number
  offlineFiles?: number
}
export interface SourceCachePreview extends SourceCacheUsage {
  token: string
  clearBytes: number
  clearFiles: number
}
export interface SourcePreparationStatus {
  episodeId: string | null
  nextEpisodeId: string | null
  stage: 'idle' | 'caching' | 'transcribing' | 'ready' | 'failed'
  message: string
}
export interface SourceBook {
  sourceId: SourceId
  id: string
  title: string
  authors: string[]
  narrators: string[]
  description: string
  pageUrl: string
}
export interface SourceEpisode {
  sourceId: SourceId
  bookId: string
  id: string
  title: string
  order: number
  pageUrl: string
}
export interface SourcePage<T> {
  items: T[]
  nextCursor: string | null
}
export interface SourceSearchRequest {
  id: string
  sourceId: SourceId
  query: string
  cursor: string | null
}
export interface SourceBookRequest {
  id: string
  sourceId: SourceId
  bookId: string
}
export interface SourceEpisodesRequest extends SourceBookRequest {
  cursor: string | null
}
export interface SourceBookDetail {
  book: SourceBook
  episodes: SourcePage<SourceEpisode>
}
export interface ResolvedSourceAudio {
  sourceId: SourceId
  episodeId: string
  url: string
  pageUrl: string
  headers: { Referer: string }
  expiresAt: number | null
}
export interface SourceAdapter {
  readonly id: SourceId
  search(query: string, cursor?: string, signal?: AbortSignal): Promise<SourcePage<SourceBook>>
  getBook(id: string, signal?: AbortSignal): Promise<SourceBook>
  getEpisodes(id: string, cursor?: string, signal?: AbortSignal): Promise<SourcePage<SourceEpisode>>
  resolveAudio(
    bookId: string,
    episodeId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedSourceAudio>
}
export type SourceErrorCode =
  | 'INVALID_SOURCE_REQUEST'
  | 'SOURCE_BUSY'
  | 'SOURCE_CANCELED'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'SOURCE_VERIFICATION_REQUIRED'
  | 'SOURCE_MEDIA_UNAVAILABLE'
export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}
