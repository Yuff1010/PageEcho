export interface ComponentProfile {
  engine: 'whisperx' | 'paraformer'
  device: 'cpu' | 'cuda'
}
export interface InstalledComponent {
  id: string
  version: string
  profile: ComponentProfile | null
  bytes: number
  installedAt: string
  active: boolean
  managed: boolean
}
export interface ComponentInstallationActivity {
  id: string
  profile: ComponentProfile
  sourceName: string
  version: string | null
  status: 'inspecting' | 'ready' | 'installing' | 'checking' | 'installed' | 'canceled' | 'failed'
  processedBytes: number
  totalBytes: number
  requiredBytes: number | null
  freeBytes: number | null
  error: string | null
  installedId: string | null
}
export interface ComponentInstallationState {
  onlineSourceConfigured: false
  activity: ComponentInstallationActivity | null
  installations: InstalledComponent[]
  activating: string | null
}
