import type { TrustedBundle } from './core-types'

/** Publisher-pinned artifacts. A manifest supplied inside a ZIP is not a trust anchor. */
export const KNOWN_BUNDLES: readonly TrustedBundle[] = Object.freeze([
  Object.freeze({
    id: 'asr-0.7.0-win-x64',
    version: '0.7.0',
    archiveBytes: 8_654_001_336,
    archiveSha256: 'e4f569493844546e8cc5ee4c420e54e6987dbc9b36194170cab5e33188ebc0fd',
    manifestSha256: '870f19478ef78a0070882e5498c73f438c0291f567948cd1911ac41556d22454',
    revokedReason:
      '此旧版组件包含已知受影响依赖，请导入 0.8.0-sec.1 或更新的兼容组件。已有文件不会被删除。',
  }),
  Object.freeze({
    id: 'asr-0.7.1-cpu.1-win-x64',
    version: '0.7.1-cpu.1',
    archiveBytes: 5_719_989_091,
    archiveSha256: '6b17c282ab0db7deb9aeee6705a60ae93b7e9f4099702ead98faaba0ff19d0f5',
    manifestSha256: 'f88c9095ddacc33ad2d1c21a19a6c073c064833481a4bfef85e54d5662ef2cbe',
    devices: Object.freeze(['cpu'] as const),
    revokedReason:
      '此旧版 CPU 组件包含已知受影响依赖，请导入 0.8.0-cpu-sec.2 或更新的兼容组件。已有文件不会被删除。',
  }),
  Object.freeze({
    id: 'asr-0.8.0-sec.1-win-x64',
    version: '0.8.0-sec.1',
    archiveBytes: 8_653_506_493,
    archiveSha256: '5a9f0e95959ead6f1eb72b2d07c8125190bfbe08a3e75cef99cf152bc99c1acb',
    manifestSha256: '1672902d73ed14c47e07d022e2794b12d40474a3b7aa5abb7a93274a0ff50b47',
  }),
  Object.freeze({
    id: 'asr-0.8.0-cpu-sec.2-win-x64',
    version: '0.8.0-cpu-sec.2',
    archiveBytes: 5_719_494_324,
    archiveSha256: '98f32dbca33e033f433895aa9fe8264dd98416c1a7c298412671ca593abf9762',
    manifestSha256: '850a00154d32ab8ad722eccdd375a973f07667dc7970ed2a572d65ececdac803',
    devices: Object.freeze(['cpu'] as const),
  }),
])
