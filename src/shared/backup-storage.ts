import type { Result } from './contracts'

export interface BackupPreview {
  previewId: string
  createdAt: string
  version: string
  schemaVersion: number
  files: number
  bytes: number
  books: number
  readingBooks: number
  bookmarks: number
  transcripts: number
  plugins: Array<{ id: string; name: string; version: string }>
  excluded: string[]
  expiresAt: string
}
export interface BackupExportResult {
  path: string
  bytes: number
  sha256: string
  files: number
  createdAt: string
}
export interface RestoredPreferences {
  settings: Record<string, string>
  plugins: Array<{ id: string; name: string; version: string }>
  restoredAt: string
  acknowledged: boolean
}
export interface GeneratedStoragePolicy {
  automatic: boolean
  keepLatest: number
  maxBytes: number
  maxAgeDays: number
}
export interface GeneratedStorageState {
  directory: string
  policy: GeneratedStoragePolicy
  bytes: number
  items: number
  protectedItems: number
  warnings: string[]
}
export interface GeneratedStoragePreview {
  token: string
  bytes: number
  items: number
  retained: number
  expiresAt: string
}
export interface GeneratedStorageResult {
  bytes: number
  items: number
  skipped: number
}
export const BACKUP_STORAGE_CHANNELS = {
  export: 'backup-storage:export',
  choose: 'backup-storage:choose',
  restore: 'backup-storage:restore',
  restored: 'backup-storage:restored-preferences',
  acknowledge: 'backup-storage:acknowledge',
  storageState: 'backup-storage:storage-state',
  storagePolicy: 'backup-storage:storage-policy',
  storagePreview: 'backup-storage:storage-preview',
  storageClear: 'backup-storage:storage-clear',
} as const
export interface BackupStorageApi {
  exportLibraryBackup(request: {
    settings: Record<string, string>
  }): Promise<Result<{ canceled: true } | { canceled: false; backup: BackupExportResult }>>
  chooseLibraryBackup(): Promise<
    Result<{ canceled: true } | { canceled: false; preview: BackupPreview }>
  >
  restoreLibraryBackup(request: { previewId: string }): Promise<Result<{ needsRestart: true }>>
  getRestoredPreferences(): Promise<Result<RestoredPreferences | null>>
  acknowledgeRestoredPreferences(): Promise<Result<void>>
  getGeneratedStorage(): Promise<Result<GeneratedStorageState>>
  saveGeneratedStoragePolicy(request: {
    policy: GeneratedStoragePolicy
  }): Promise<Result<GeneratedStorageState>>
  previewGeneratedStorageClear(): Promise<Result<GeneratedStoragePreview>>
  clearGeneratedStorage(request: { token: string }): Promise<Result<GeneratedStorageResult>>
}
