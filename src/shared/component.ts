export interface ComponentCandidate {
  id: string
  label: string
  directory: string
  configPath: string
  available: boolean
  problem: string | null
}
export interface ComponentCapability {
  engine: 'whisperx' | 'paraformer'
  device: 'cpu' | 'cuda'
  available: boolean
  message: string
}
export interface ComponentCheck {
  checkedAt: string
  ready: boolean
  pythonVersion: string | null
  cudaName: string | null
  freeBytes: number | null
  issues: string[]
  capabilities: ComponentCapability[]
  level: 'imports-and-files'
}
export interface ComponentPackageGuidance {
  id: string
  version: string
  archiveName: string
  archiveBytes: number
  devices: ('cpu' | 'cuda')[]
}
/** Local catalogue/checked capabilities only; no download URL or implicit activation. */
export interface ComponentGuidance {
  platform: string
  arch: string
  platformSupported: boolean
  packages: ComponentPackageGuidance[]
  checkedDevices: ('cpu' | 'cuda')[]
  suggestedDevice: 'cpu' | 'cuda' | null
}
export interface ComponentSetupState {
  configured: boolean
  currentDirectory: string | null
  candidates: ComponentCandidate[]
  check: ComponentCheck | null
  guidance?: ComponentGuidance
}
