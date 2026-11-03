import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentGuidance } from '../../src/main/component-guidance'
import { KNOWN_BUNDLES } from '../../src/main/component-installation/catalog'
import type { ComponentCheck } from '../../src/shared/component'

const windows = { platform: 'win32', arch: 'x64' }
function checked(devices: ('cpu' | 'cuda')[], cudaName: string | null = null): ComponentCheck {
  return {
    checkedAt: new Date().toISOString(),
    ready: devices.length > 0,
    pythonVersion: '3.12',
    cudaName,
    freeBytes: null,
    issues: [],
    level: 'imports-and-files',
    capabilities: (['whisperx', 'paraformer'] as const).flatMap((engine) =>
      (['cpu', 'cuda'] as const).map((device) => ({
        engine,
        device,
        available: devices.includes(device),
        message: 'Synthetic prerequisite evidence, not real inference.',
      })),
    ),
  }
}

test('offline guidance projects current catalogue artifacts and never recommends revoked packages', () => {
  const guidance = componentGuidance(null, windows)
  const allowed = KNOWN_BUNDLES.filter((bundle) => !bundle.revokedReason)
  assert.equal(guidance.packages.length, allowed.length)
  assert(allowed.length > 0)
  for (const bundle of allowed) {
    const item = guidance.packages.find((value) => value.id === bundle.id)
    assert.deepEqual(item, {
      id: bundle.id,
      version: bundle.version,
      archiveName: `PageEcho-ASR-${bundle.version}-win-x64.zip`,
      archiveBytes: bundle.archiveBytes,
      devices: bundle.devices ? [...bundle.devices] : ['cpu', 'cuda'],
    })
    assert.equal('url' in item!, false)
  }
  assert(
    KNOWN_BUNDLES.filter((bundle) => !!bundle.revokedReason).every(
      (bundle) => !guidance.packages.some((item) => item.id === bundle.id),
    ),
  )
})

test('catalogue projections are detached so a caller cannot mutate future guidance or trusted inputs', () => {
  const original = componentGuidance(null, windows)
  const changed = componentGuidance(null, windows)
  changed.packages[0]!.devices.length = 0
  changed.packages[0]!.version = 'modified-by-caller'
  changed.packages.length = 0
  assert.deepEqual(componentGuidance(null, windows), original)
})

test('unconfigured guidance never invents an available CPU or CUDA device', () => {
  const guidance = componentGuidance(null, windows)
  assert.equal(guidance.platformSupported, true)
  assert.deepEqual(guidance.checkedDevices, [])
  assert.equal(guidance.suggestedDevice, null)
})

test('device suggestions use checked capabilities rather than NVIDIA names or unavailable devices', () => {
  const unavailable = componentGuidance(checked([], 'NVIDIA fixture display adapter'), windows)
  assert.deepEqual(unavailable.checkedDevices, [])
  assert.equal(unavailable.suggestedDevice, null)
  const cpu = componentGuidance(checked(['cpu'], 'NVIDIA fixture display adapter'), windows)
  assert.deepEqual(cpu.checkedDevices, ['cpu'])
  assert.equal(cpu.suggestedDevice, 'cpu')
  const cuda = componentGuidance(checked(['cpu', 'cuda']), windows)
  assert.deepEqual(cuda.checkedDevices, ['cpu', 'cuda'])
  assert.equal(cuda.suggestedDevice, 'cuda')
  const inconsistent = checked(['cpu', 'cuda'])
  inconsistent.ready = false
  assert.equal(componentGuidance(inconsistent, windows).suggestedDevice, null)
})

test('Windows x64 artifacts do not imply support for ARM or other operating systems', () => {
  for (const environment of [
    { platform: 'win32', arch: 'arm64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'darwin', arch: 'x64' },
  ]) {
    const guidance = componentGuidance(checked(['cpu', 'cuda']), environment)
    assert.equal(guidance.platformSupported, false)
    assert.deepEqual(guidance.checkedDevices, [])
    assert.equal(guidance.suggestedDevice, null)
    assert(guidance.packages.length > 0)
  }
})
