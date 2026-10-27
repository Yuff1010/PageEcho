import { analyzeListening, type ListeningSample } from './listening-analysis'

export interface LongSample extends ListeningSample {
  rate: number
  savedPositionMs?: number
  error?: string
  alert?: string
}
export interface LongEvent {
  type: string
  wallMs: number
  positionMs: number
  source: string
}

/** A live journal may have one incomplete final append; terminal evidence may not. */
export function parseJournal<T>(
  input: string,
  running: boolean,
): { values: T[]; incompleteTail: boolean } {
  const lines = input.trimEnd().split('\n')
  if (!input.trim()) return { values: [], incompleteTail: false }
  const values: T[] = []
  for (const [index, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line) as T)
    } catch (error) {
      if (running && index === lines.length - 1 && !input.endsWith('\n'))
        return { values, incompleteTail: true }
      throw error
    }
  }
  return { values, incompleteTail: false }
}

export function auditLongClock(
  samples: LongSample[],
  events: LongEvent[],
  durationMs: number,
  wholeHash: string,
  nextHash: string,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid media duration')
  const analysis = analyzeListening(samples)
  const sourceIndex = (source: string) =>
    source.endsWith('/' + wholeHash) ? 0 : source.endsWith('/' + nextHash) ? 1 : -1
  const whole = samples.filter((sample) => sourceIndex(sample.source) === 0)
  const following = samples.filter((sample) => sourceIndex(sample.source) === 1)
  const transitions: number[] = []
  let forwardJumps = 0,
    invalidIntervals = 0,
    maximumSampleGapMs = 0
  for (const [index, sample] of samples.entries()) {
    if (![sample.rate, sample.wallMs, sample.positionMs, sample.ipcMs].every(Number.isFinite))
      throw new Error('Non-finite media observation')
    const source = sourceIndex(sample.source)
    if (source !== transitions.at(-1)) transitions.push(source)
    const previous = samples[index - 1]
    if (!previous) continue
    const wall = sample.wallMs - previous.wallMs
    maximumSampleGapMs = Math.max(maximumSampleGapMs, wall)
    if (wall <= 0) invalidIntervals++
    if (sample.source === previous.source) {
      const advanced = sample.positionMs - previous.positionMs
      if (advanced < -1) invalidIntervals++
      if (advanced > wall + 250) forwardJumps++
    }
  }
  for (const event of events)
    if (![event.wallMs, event.positionMs].every(Number.isFinite))
      throw new Error('Invalid native media event')
  const ended = events.filter((event) => event.type === 'ended')
  const firstPlaying = events.find(
    (event) => event.type === 'playing' && sourceIndex(event.source) === 0,
  )
  const firstEnd = ended[0]
  const nextPlaying =
    firstEnd &&
    events.find(
      (event) =>
        event.type === 'playing' &&
        sourceIndex(event.source) === 1 &&
        event.wallMs >= firstEnd.wallMs,
    )
  const savedLags = whole
    .filter((sample) => Number.isFinite(sample.savedPositionMs))
    .map((sample) => sample.positionMs - sample.savedPositionMs!)
  const checks = {
    observedFromStart: !!whole.length && whole[0]!.positionMs >= 0 && whole[0]!.positionMs <= 1500,
    observedNearWholeEnd: !!whole.length && whole.at(-1)!.positionMs >= durationMs - 1500,
    naturalEndAtDuration:
      ended.length === 1 &&
      sourceIndex(firstEnd!.source) === 0 &&
      Math.abs(firstEnd!.positionMs - durationMs) < 100,
    naturalWallDuration:
      !!firstPlaying &&
      !!firstEnd &&
      firstPlaying.positionMs <= 1500 &&
      firstEnd.wallMs - firstPlaying.wallMs >= durationMs - 1500,
    automaticNextObserved:
      transitions.join(',') === '0,1' &&
      !!nextPlaying &&
      following.some((sample) => sample.positionMs >= 10000),
    nativeRateOne: samples.length > 0 && samples.every((sample) => sample.rate === 1),
    noReportedMediaError:
      samples.every((sample) => !sample.error && !sample.alert) &&
      !events.some((event) => event.type === 'error'),
    noInteriorPause:
      !whole.some(
        (sample) =>
          sample.paused && sample.positionMs > 100 && sample.positionMs < durationMs - 100,
      ) &&
      !events.some(
        (event) =>
          event.type === 'pause' &&
          sourceIndex(event.source) === 0 &&
          event.positionMs > 100 &&
          event.positionMs < durationMs - 100,
      ),
    noObservedTimeJump: forwardJumps === 0 && invalidIntervals === 0,
  }
  return {
    checks,
    samples: samples.length,
    transitions,
    maximumSampleGapMs,
    forwardJumps,
    invalidIntervals,
    firstWholePositionMs: whole[0]?.positionMs ?? null,
    lastWholePositionMs: whole.at(-1)?.positionMs ?? null,
    firstPlayingWallMs: firstPlaying?.wallMs ?? null,
    endedWallMs: firstEnd?.wallMs ?? null,
    endedToNextPlayingMs: firstEnd && nextPlaying ? nextPlaying.wallMs - firstEnd.wallMs : null,
    maximumSavedLagMs: savedLags.length ? Math.max(...savedLags) : null,
    maximumSavedLeadMs: savedLags.length ? Math.max(0, -Math.min(...savedLags)) : null,
    savedLagOver10Seconds: savedLags.filter((lag) => lag > 10000).length,
    analysis,
  }
}
