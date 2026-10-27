import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComponentSetupState } from '../../src/shared/component'
import { availableSubtitleProfile } from '../../src/renderer/src/subtitle-onboarding'

test('quick setup only proposes a checked available configuration and falls back to CPU', () => {
  assert.equal(availableSubtitleProfile(null), null)
  const state: ComponentSetupState = {
    configured: true,
    currentDirectory: 'C:/components',
    candidates: [],
    check: {
      checkedAt: new Date().toISOString(),
      ready: true,
      pythonVersion: '3.12',
      cudaName: null,
      freeBytes: null,
      issues: [],
      level: 'imports-and-files',
      capabilities: [
        { engine: 'paraformer', device: 'cuda', available: false, message: 'unavailable' },
        { engine: 'paraformer', device: 'cpu', available: true, message: 'ready' },
      ],
    },
  }
  assert.deepEqual(availableSubtitleProfile(state), {
    engine: 'paraformer',
    device: 'cpu',
    mode: 'auto',
    prepareNext: false,
  })
  state.check!.ready = false
  assert.equal(availableSubtitleProfile(state), null)
})
