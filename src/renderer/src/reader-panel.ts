import { colorContrast } from './reader-settings'

function mix(underlay: string, overlay: string, opacity: number) {
  return (
    '#' +
    [1, 3, 5]
      .map((start) =>
        Math.round(
          parseInt(underlay.slice(start, start + 2), 16) * (1 - opacity) +
            parseInt(overlay.slice(start, start + 2), 16) * opacity,
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

/** Evaluate the painted glass surface, not just the app theme, before choosing its ink. */
export function readerPanelAppearance(
  background: string,
  appTheme: 'light' | 'dark',
  transparency: number,
) {
  // Matches --ui-panel in appearance.css; the panel itself retains the user's exact alpha.
  const surface = appTheme === 'light' ? '#FFFFFF' : '#1C2822'
  const painted = mix(background, surface, 1 - Math.max(0, Math.min(100, transparency)) / 100)
  const darkInk = colorContrast(painted, '#000000') >= colorContrast(painted, '#FFFFFF')
  const tone = darkInk ? 'light' : 'dark'
  const preferred = darkInk ? '#263025' : '#EDF2E9'
  const ink = colorContrast(painted, preferred) >= 4.5 ? preferred : darkInk ? '#000000' : '#FFFFFF'
  const field = darkInk ? '#F0F2EB' : '#191C1A'
  const hover = darkInk ? '#E2E9DC' : '#30382F'
  const readable = (candidate: string) =>
    [painted, field, hover].every((bg) => colorContrast(bg, candidate) >= 4.5) ? candidate : ink
  return {
    tone,
    variables: {
      '--reader-panel-surface': surface,
      '--reader-panel-solid': painted,
      '--ui-text': ink,
      '--ui-muted': readable(darkInk ? '#56624F' : '#BCC6B5'),
      '--ui-accent': readable(darkInk ? '#3D6335' : '#B3D7A8'),
      '--ui-field': field,
      '--ui-hover': hover,
      '--ui-line': darkInk ? '#AFB9A7' : '#596450',
    },
  }
}
