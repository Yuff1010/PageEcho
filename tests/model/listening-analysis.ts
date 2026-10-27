export interface MeasuredJob {
  episodeId: string
  processedUntilMs: number
  completedChunks: number
  autoApply: boolean
  status?: string
}
export interface ListeningSample {
  wallMs: number
  source: string
  positionMs: number
  paused: boolean
  ipcMs: number
  visibility: string
  jobs: (MeasuredJob | null)[]
}

/** Classify only consecutive, observed intervals. Never treat missing samples as smooth playback. */
export function analyzeListening(samples: ListeningSample[]) {
  const tracks = new Map<
    string,
    {
      source: string
      observations: number
      observedPlayingMs: number
      unobservedGapMs: number
      processedCoverageBehindMs: number
      processedCoverageAheadMs: number
      coverageTransitionMs: number
      firstCoveredMediaPositionMs: number | null
      maximumUnprocessedLeadMs: number
    }
  >()
  const latencies = new Map<string, number[]>()
  let longestObservedClockStopMs = 0,
    stopStartedAt: number | undefined,
    discontinuities = 0
  function currentJob(sample: ListeningSample) {
    return sample.jobs.find((job) => job && sample.source.includes(`/media/${job.episodeId}/`))
  }
  function covered(sample: ListeningSample) {
    const job = currentJob(sample)
    return (
      !!job && job.autoApply && job.completedChunks > 0 && job.processedUntilMs >= sample.positionMs
    )
  }
  for (const [index, sample] of samples.entries()) {
    if (
      !Number.isFinite(sample.wallMs) ||
      !Number.isFinite(sample.positionMs) ||
      !Number.isFinite(sample.ipcMs)
    )
      throw new Error('Invalid listening measurement')
    const track = tracks.get(sample.source) ?? {
      source: sample.source,
      observations: 0,
      observedPlayingMs: 0,
      unobservedGapMs: 0,
      processedCoverageBehindMs: 0,
      processedCoverageAheadMs: 0,
      coverageTransitionMs: 0,
      firstCoveredMediaPositionMs: null,
      maximumUnprocessedLeadMs: 0,
    }
    tracks.set(sample.source, track)
    track.observations++
    const activity = sample.jobs.some(
      (job) => job && ['queued', 'running', 'canceling'].includes(job.status ?? ''),
    )
      ? 'inference-active'
      : 'no-active-inference'
    const group = `${sample.visibility}|${activity}`
    const latency = latencies.get(group) ?? []
    latency.push(sample.ipcMs)
    latencies.set(group, latency)
    const job = currentJob(sample)
    if (job?.autoApply && !sample.paused) {
      track.maximumUnprocessedLeadMs = Math.max(
        track.maximumUnprocessedLeadMs,
        sample.positionMs - job.processedUntilMs,
      )
      if (covered(sample) && track.firstCoveredMediaPositionMs === null)
        track.firstCoveredMediaPositionMs = sample.positionMs
    }
    const previous = samples[index - 1]
    if (!previous || sample.source !== previous.source || sample.paused || previous.paused) {
      stopStartedAt = undefined
      continue
    }
    const wall = sample.wallMs - previous.wallMs,
      advanced = sample.positionMs - previous.positionMs
    if (wall <= 0 || advanced < -1) {
      discontinuities++
      stopStartedAt = undefined
      continue
    }
    if (wall > 1500) {
      track.unobservedGapMs += wall
      stopStartedAt = undefined
      continue
    }
    track.observedPlayingMs += wall
    if (advanced <= 1) {
      stopStartedAt ??= previous.wallMs
      longestObservedClockStopMs = Math.max(
        longestObservedClockStopMs,
        sample.wallMs - stopStartedAt,
      )
    } else stopStartedAt = undefined
    const oldJob = currentJob(previous)
    if (job?.autoApply && oldJob?.autoApply) {
      if (covered(sample) && covered(previous)) track.processedCoverageAheadMs += wall
      else if (!covered(sample) && !covered(previous)) track.processedCoverageBehindMs += wall
      else track.coverageTransitionMs += wall
    }
  }
  const ipc = [...latencies.entries()].map(([group, values]) => {
    const [visibility, activity] = group.split('|')
    const ordered = values.toSorted((a, b) => a - b)
    return {
      visibility,
      activity,
      samples: values.length,
      p50Ms: ordered[Math.floor(values.length * 0.5)],
      p95Ms: ordered[Math.min(values.length - 1, Math.floor(values.length * 0.95))],
      maxMs: ordered.at(-1),
    }
  })
  return {
    intervalScope:
      'adjacent same-source, unpaused observations at most 1.5 seconds apart; longer gaps are unobserved, not evidence of smoothness',
    coverageScope:
      'saved, auto-applied processed prefix versus media position; no claim about text accuracy or alignment',
    percentileMethod: 'zero-based floor(n*p), capped to the final sorted sample',
    longestObservedClockStopMs,
    discontinuities,
    tracks: [...tracks.values()],
    ipc,
  }
}
