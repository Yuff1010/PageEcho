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
export interface ComponentSetupState {
  configured: boolean
  currentDirectory: string | null
  candidates: ComponentCandidate[]
  check: ComponentCheck | null
}
