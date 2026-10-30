import type { Result } from './contracts'
import type { SourceId } from './sources'

export type PluginSourceKind = 'audio' | 'text'

export interface PluginSourceManifest {
  id: string
  name: string
  kind: PluginSourceKind
  baseUrl: string
  description?: string
  allowedOrigins: string[]
  mediaOrigins?: string[]
}

export interface PluginManifest {
  schemaVersion: 1
  apiVersion: 1
  id: string
  name: string
  version: string
  scripts: string[]
  sources: PluginSourceManifest[]
}

export interface PluginSourceInfo {
  id: `plugin:${string}:${string}`
  localId: string
  pluginId: string
  name: string
  kind: PluginSourceKind
  baseUrl: string
  description: string
  allowedOrigins: string[]
  mediaOrigins: string[]
}

export interface AudioSourceInfo {
  id: SourceId
  name: string
  kind: 'audio'
  description: string
  homepage: string
  language: string
  maxQueryLength: number
  pluginId?: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  installedAt: string
  sha256: string
  previousVersion: string | null
  sources: PluginSourceInfo[]
}

export interface PluginState {
  plugins: PluginInfo[]
  /** Enabled installed sources only. Removed/disabled sources do not delete saved books. */
  sources: PluginSourceInfo[]
}

export interface PluginPreview {
  previewId: string
  id: string
  name: string
  version: string
  sha256: string
  action: 'install' | 'update'
  previousVersion: string | null
  sources: PluginSourceInfo[]
  bytes: number
  expiresAt: string
}

export interface PluginTestStep {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  message: string
}

export interface PluginTestReport {
  id: string
  sourceId: string
  version: string
  passed: boolean
  steps: PluginTestStep[]
}

export const PLUGIN_CHANNELS = {
  list: 'plugins:list',
  choose: 'plugins:choose',
  previewUrl: 'plugins:preview-url',
  install: 'plugins:install',
  cancel: 'plugins:cancel',
  toggle: 'plugins:toggle',
  remove: 'plugins:remove',
  rollback: 'plugins:rollback',
  test: 'plugins:test',
  sourceCatalog: 'plugins:source-catalog',
} as const

export interface PluginApi {
  pluginList(): Promise<Result<PluginState>>
  pluginChoose(): Promise<Result<{ canceled: true } | { canceled: false; preview: PluginPreview }>>
  pluginPreviewUrl(request: { requestId: string; url: string }): Promise<Result<PluginPreview>>
  pluginInstall(request: { previewId: string }): Promise<Result<PluginState>>
  pluginCancel(request: { requestId: string }): Promise<Result<void>>
  pluginToggle(request: { id: string; enabled: boolean }): Promise<Result<PluginState>>
  pluginRemove(request: { id: string }): Promise<Result<PluginState>>
  pluginRollback(request: { id: string }): Promise<Result<PluginState>>
  pluginTest(request: {
    requestId: string
    id: string
    sourceId: string
    query?: string
  }): Promise<Result<PluginTestReport>>
  pluginSourceCatalog(): Promise<Result<AudioSourceInfo[]>>
}
