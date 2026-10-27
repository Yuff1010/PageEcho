import { useEffect, useRef, useState } from 'react'
import type { TranscriptRequest } from '../../shared/transcript'
import { player } from './player'

/** A bounded audition owns the existing player, never a second audio track. */
export function useTranscriptAudition(target: TranscriptRequest) {
  const [playing, setPlaying] = useState('')
  const owned = useRef<{
    startMs: number
    endMs: number
    lastMs: number
    pending: boolean
    session: string | null
  } | null>(null)
  const mounted = useRef(false),
    sequence = useRef(Symbol())
  useEffect(() => {
    mounted.current = true
    const check = () => {
      const range = owned.current
      if (!range) return
      const state = player.getSnapshot(),
        position = player.getPosition()
      if (
        state.episode?.id !== target.episodeId ||
        state.episode.contentHash !== target.audioHash ||
        player.getSessionId() !== range.session ||
        (!range.pending &&
          (!state.playing ||
            position < range.startMs - 50 ||
            Math.abs(position - range.lastMs) > 1000))
      ) {
        owned.current = null
        setPlaying('')
        return
      }
      range.lastMs = position
      if (!range.pending && position >= range.endMs) {
        owned.current = null
        setPlaying('')
        player.pause()
      }
    }
    const clock = player.subscribeClock(check),
      state = player.subscribe(check)
    return () => {
      mounted.current = false
      sequence.current = Symbol()
      const range = owned.current
      owned.current = null
      clock()
      state()
      if (range && player.getSessionId() === range.session) player.pause()
    }
  }, [target])
  function stop() {
    sequence.current = Symbol()
    const range = owned.current
    owned.current = null
    setPlaying('')
    if (range && player.getSessionId() === range.session) player.pause()
  }
  async function listen(startMs: number, endMs: number, label: string) {
    const state = player.getSnapshot()
    if (
      !state.ready ||
      state.episode?.id !== target.episodeId ||
      state.episode.contentHash !== target.audioHash ||
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      endMs <= startMs
    )
      return
    stop()
    const serial = Symbol()
    sequence.current = serial
    player.pause()
    player.seek(startMs)
    owned.current = {
      startMs,
      endMs,
      lastMs: startMs,
      pending: true,
      session: player.getSessionId(),
    }
    setPlaying(label)
    await player.play(true)
    if (mounted.current && sequence.current === serial && owned.current) {
      if (player.getSnapshot().playing) owned.current.pending = false
      else {
        owned.current = null
        setPlaying('')
      }
    }
  }
  return { playing, listen, stop }
}
