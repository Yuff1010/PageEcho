import { ReaderAction } from './ReaderToolbar'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { EbookSpeechApi } from '../../shared/ebook-speech'
import type { ReaderAnchor } from './reader-layout'
import { EbookSpeechPlayer, stopNarrationOnRecordedPlayback } from './ebook-speech'
import { player } from './player'
import { Icon } from './Icons'
import { Tooltip } from './Tooltip'
import './ebook-speech.css'

export function useEbookSpeech(bookId: string, onAnchor: (anchor: ReaderAnchor) => void) {
  const [speech] = useState(
    () => new EbookSpeechPlayer(window.desktop as typeof window.desktop & EbookSpeechApi),
  )
  const callback = useRef(onAnchor)
  useLayoutEffect(() => {
    callback.current = onAnchor
  }, [onAnchor])
  useEffect(() => {
    speech.attach(bookId, (anchor) => callback.current(anchor))
    const stop = stopNarrationOnRecordedPlayback(speech, player)
    return () => {
      stop()
      speech.stop()
    }
  }, [bookId, speech])
  const state = useSyncExternalStore(speech.subscribe, speech.getSnapshot)
  const start = (anchor: ReaderAnchor) => {
    player.pause()
    void speech.start(anchor)
  }
  return { speech, state, start }
}

export function EbookSpeechControls({
  value,
  anchor,
}: {
  value: ReturnType<typeof useEbookSpeech>
  anchor: ReaderAnchor
}) {
  const { speech, state, start } = value
  if (state.status === 'idle') return null
  const playing = state.status === 'playing' || state.status === 'loading'
  return (
    <aside className="ebook-speech-controls" aria-label="电子书朗读">
      <div className="ebook-speech-status" role="status">
        {state.message}
      </div>
      <div className="ebook-speech-actions">
        <ReaderAction
          className="reader-button"
          onClick={() => (playing ? speech.pause() : start(anchor))}
          label={playing ? '暂停电子书朗读' : '继续电子书朗读'}
          icon={playing ? 'pause' : 'play'}
        />
        <label>
          <Icon name="clock" />
          <Tooltip content="电子书朗读语速">
            <select
              aria-label="电子书朗读语速"
              value={state.rate}
              onChange={(event) => speech.setRate(Number(event.target.value))}
            >
              {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </Tooltip>
        </label>
        {!!state.voices.length && (
          <label className="ebook-speech-voice">
            <Icon name="volume" />
            <Tooltip content="电子书朗读声音">
              <select
                aria-label="电子书朗读声音"
                value={state.voice}
                onChange={(event) => speech.setVoice(event.target.value)}
              >
                {state.voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} · {voice.language}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>
        )}
        <ReaderAction
          className="reader-button"
          onClick={() => speech.stop()}
          label="停止电子书朗读"
          icon="stop"
        />
      </div>
    </aside>
  )
}
