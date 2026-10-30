import type { SourceErrorCode } from '../../shared/sources'

export type PluginMethod =
  'search' | 'getBook' | 'getEpisodes' | 'resolveAudio' | 'getChapters' | 'getChapterText'

export interface PluginRuntimeSource {
  id: string
  methods: PluginMethod[]
}

export interface PluginInspectRequest {
  scripts: string[]
  signal: AbortSignal
  timeoutMs?: number
}

export interface PluginRuntimeRequest extends PluginInspectRequest {
  sourceId: string
  method: PluginMethod
  args: unknown[]
  /** Exact HTTP(S) origins explicitly accepted at installation. Never a hostname wildcard. */
  allowedOrigins: string[]
}

export interface PluginHttpOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export interface PluginWorkerInput {
  scripts: string[]
  sourceId?: string
  method?: PluginMethod
  args?: unknown[]
  deadline: number
}

export type PluginWorkerMessage =
  | { kind: 'request'; id: number; url: string; options?: PluginHttpOptions }
  | { kind: 'done'; value: unknown }
  | { kind: 'error'; code: SourceErrorCode; message: string }

export type PluginHostMessage =
  | { kind: 'response'; id: number; text: string }
  | { kind: 'response'; id: number; error: string; code: SourceErrorCode }
