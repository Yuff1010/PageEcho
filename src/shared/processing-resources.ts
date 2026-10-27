export type CpuThreads = 1 | 2 | 4
export interface ProcessingPolicy {
  cpuThreads: CpuThreads
  lowPriority: boolean
  backgroundIdleOnly: boolean
}
export const DEFAULT_PROCESSING_POLICY: ProcessingPolicy = {
  cpuThreads: 4,
  lowPriority: false,
  backgroundIdleOnly: false,
}
export interface SavedProcessingResources {
  revision: number
  policy: ProcessingPolicy
  paused: boolean
}
export interface ProcessingResources extends SavedProcessingResources {
  status: 'running' | 'paused' | 'waiting-idle' | 'ready' | 'releasing' | 'model-lease'
  active: { jobId: string; episodeId: string; cpuThreads: CpuThreads } | null
  worker: { pid: number; cpuThreads: number | null; priority: 'low' | 'normal' | 'unknown' } | null
}
export interface UpdateProcessingPolicy {
  revision: number
  policy: ProcessingPolicy
}
export interface PauseProcessing {
  revision: number
  paused: boolean
}
