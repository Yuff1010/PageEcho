import type { TranscriptionJob } from './transcription'

export interface DirectoryUsage {
  bytes: number
  files: number
  skipped: number
  complete: boolean
}
export interface ModelLocation {
  name: string
  repository: string
  revision: string
  path: string
  available: boolean
}
export interface MaintenanceState {
  dataPath: string
  logsPath: string
  configured: boolean
  component: {
    python: string
    models: string
    cache: string
    resources?: string
    ffmpeg: string
    ffprobe: string
  } | null
  models: ModelLocation[]
  usage: DirectoryUsage | null
  cache: { bytes: number; files: number; groups: number; retained: number }
  warnings: string[]
}
export interface CacheClearPreview {
  token: string
  bytes: number
  files: number
  groups: number
  retained: number
}
export interface CacheClearResult {
  bytes: number
  files: number
  groups: number
}
export interface TaskSummary extends TranscriptionJob {
  episodeTitle: string
  bookTitle: string
  stale: boolean
}
export interface TaskPage {
  jobs: TaskSummary[]
  total: number
  active: number
  running: number
}
export interface TaskQuery {
  page: number
  activeOnly: boolean
}
export type MaintenanceLocation = 'data' | 'logs' | 'cache' | 'models'
export interface AppLog {
  text: string
  truncated: boolean
}
