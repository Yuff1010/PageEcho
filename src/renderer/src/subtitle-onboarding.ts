import type { ComponentSetupState } from '../../shared/component'
import type { SubtitlePreparation } from '../../shared/transcription'

/** Choose only a capability actually checked on this device; this is not a quality ranking. */
export function availableSubtitleProfile(
  state: ComponentSetupState | null,
): SubtitlePreparation | null {
  if (!state?.configured || !state.check?.ready) return null
  for (const device of ['cuda', 'cpu'] as const)
    for (const engine of ['paraformer', 'whisperx'] as const)
      if (
        state.check.capabilities.some(
          (item) => item.device === device && item.engine === engine && item.available,
        )
      )
        return { engine, device, mode: 'auto', prepareNext: false }
  return null
}
