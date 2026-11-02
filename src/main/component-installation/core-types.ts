import type { ComponentProfile } from '../../shared/component-installation'

export interface TrustedBundle {
  id: string
  version: string
  archiveBytes: number
  archiveSha256: string
  manifestSha256: string
  devices?: readonly ('cpu' | 'cuda')[]
  /** Retain historical receipts, but refuse new imports of this authenticated artifact. */
  revokedReason?: string
}
export interface BundleFile {
  path: string
  bytes: number
  sha256: string
}
export interface ComponentInstallPlan {
  archivePath: string
  bundle: TrustedBundle
  profile: ComponentProfile
  files: BundleFile[]
  requiredBytes: number
  freeBytes: number
  sourceSize: number
  sourceModifiedMs: number
}
export interface ManagedComponentReceipt {
  id: string
  version: string
  profile: ComponentProfile
  bytes: number
  installedAt: string
  componentPath: string
  receiptPath: string
}
export type InstallProgress = (
  stage: 'inspecting' | 'installing' | 'checking',
  processedBytes: number,
  totalBytes: number,
) => void
export interface ComponentInstallerCore {
  inspect(
    path: string,
    profile: ComponentProfile,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<ComponentInstallPlan>
  install(
    plan: ComponentInstallPlan,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<ManagedComponentReceipt>
  verify(
    receipt: ManagedComponentReceipt,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<void>
  load(): Promise<ManagedComponentReceipt[]>
}
