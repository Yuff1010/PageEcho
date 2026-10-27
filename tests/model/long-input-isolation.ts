import type { Page } from '@playwright/test'

// Test-page input isolation only; never wraps pause(), changes a clock, or generates EOF.
export async function installLongInputIsolation(page: Page, label: string) {
  // tsx may retain function names through this helper in serialized evaluate callbacks.
  await page.evaluate('globalThis.__name ??= (fn => fn)')
  return page.evaluate((label) => {
    Reflect.set(window, 'RALB_LONG_INPUT_LOCKED', false)
    const panel = document.querySelector('.player-panel')!
    const record = (type: string, control: string) => {
      const audio = document.querySelector('audio')!
      const events = Reflect.get(window, 'RALB_LONG_EVENTS') as unknown[]
      events.push({
        type,
        control,
        wallMs: Date.now(),
        positionMs: audio.currentTime * 1000,
        source: audio.currentSrc,
      })
    }
    for (const type of ['click', 'keydown', 'input', 'change'])
      document.addEventListener(
        type,
        (event) => {
          if (
            Reflect.get(window, 'RALB_LONG_INPUT_LOCKED') !== true ||
            !panel.contains(event.target as Node)
          )
            return
          const target = (event.target as Element).closest('button,input,select')
          if (!target) return
          record(
            'external-input-ignored',
            target.getAttribute('aria-label') ?? target.textContent?.trim().slice(0, 50) ?? type,
          )
          event.preventDefault()
          event.stopImmediatePropagation()
        },
        true,
      )
    const actions: MediaSessionAction[] = [
      'play',
      'pause',
      'stop',
      'seekbackward',
      'seekforward',
      'seekto',
      'previoustrack',
      'nexttrack',
    ]
    const supported: MediaSessionAction[] = []
    for (const action of actions)
      try {
        navigator.mediaSession.setActionHandler(action, () =>
          record('external-media-action-ignored', action),
        )
        supported.push(action)
      } catch {
        /* Unsupported actions are recorded, not assumed. */
      }
    Reflect.set(window, 'RALB_LONG_LOCK_ACTIONS', supported)
    const notice = document.createElement('aside')
    notice.id = 'ralb-long-test-notice'
    notice.textContent = `自动长测 ${label} · 静音 · 播放控件暂锁定`
    notice.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;background:#fff2c7;color:#3e3520;text-align:center;font:12px sans-serif;padding:3px;pointer-events:none'
    document.body.append(notice)
    return {
      supported,
      scope:
        'Only playback controls and media action callbacks in this owned test page. Application pause/seek/EOF behavior and normal app windows are unchanged.',
    }
  }, label)
}

export async function setLongInputLocked(page: Page, locked: boolean) {
  await page.evaluate((locked) => {
    Reflect.set(window, 'RALB_LONG_INPUT_LOCKED', locked)
    if (!locked) {
      for (const action of Reflect.get(window, 'RALB_LONG_LOCK_ACTIONS') as MediaSessionAction[])
        navigator.mediaSession.setActionHandler(action, null)
      document.getElementById('ralb-long-test-notice')?.remove()
    }
  }, locked)
}
