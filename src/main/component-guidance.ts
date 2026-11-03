import type { ComponentCheck, ComponentGuidance } from '../shared/component'
import { KNOWN_BUNDLES } from './component-installation/catalog'

/** Does not probe a GPU, execute a component, fetch assets or change settings. */
export function componentGuidance(
  check: ComponentCheck | null,
  environment: { platform: string; arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): ComponentGuidance {
  const platformSupported = environment.platform === 'win32' && environment.arch === 'x64'
  const checkedDevices = (['cpu', 'cuda'] as const).filter(
    (device) =>
      platformSupported &&
      !!check?.ready &&
      check.capabilities.some((capability) => capability.device === device && capability.available),
  )
  return {
    platform: environment.platform,
    arch: environment.arch,
    platformSupported,
    packages: KNOWN_BUNDLES.filter((bundle) => !bundle.revokedReason).map((bundle) => ({
      id: bundle.id,
      version: bundle.version,
      archiveName: `PageEcho-ASR-${bundle.version}-win-x64.zip`,
      archiveBytes: bundle.archiveBytes,
      devices: [...(bundle.devices ?? ['cpu', 'cuda'])],
    })),
    checkedDevices,
    // A suggestion only: the selected engine must separately pass its capability check.
    suggestedDevice: checkedDevices.includes('cuda')
      ? 'cuda'
      : checkedDevices.includes('cpu')
        ? 'cpu'
        : null,
  }
}
