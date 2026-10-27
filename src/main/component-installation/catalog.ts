import type { TrustedBundle } from './core-types'

/** Publisher-pinned artifacts. A manifest supplied inside a ZIP is not a trust anchor. */
export const KNOWN_BUNDLES: readonly TrustedBundle[] = Object.freeze([
  Object.freeze({
    id: 'asr-0.7.0-win-x64',
    version: '0.7.0',
    archiveBytes: 8_654_001_336,
    archiveSha256: 'e4f569493844546e8cc5ee4c420e54e6987dbc9b36194170cab5e33188ebc0fd',
    manifestSha256: '870f19478ef78a0070882e5498c73f438c0291f567948cd1911ac41556d22454',
  }),
  Object.freeze({
    id: 'asr-0.7.1-cpu.1-win-x64',
    version: '0.7.1-cpu.1',
    archiveBytes: 5_719_989_091,
    archiveSha256: '6b17c282ab0db7deb9aeee6705a60ae93b7e9f4099702ead98faaba0ff19d0f5',
    manifestSha256: 'f88c9095ddacc33ad2d1c21a19a6c073c064833481a4bfef85e54d5662ef2cbe',
    devices: Object.freeze(['cpu'] as const),
  }),
])
