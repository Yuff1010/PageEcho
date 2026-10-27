import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EbookSpeechApi, EbookSpeechAudio } from '../../src/shared/ebook-speech'
import {
  EbookSpeechPlayer,
  stopNarrationOnRecordedPlayback,
} from '../../src/renderer/src/ebook-speech'
import { SPEECH_CHANNELS } from '../../src/shared/ebook-speech'
import { validateSpeechRequest } from '../../src/shared/ebook-speech-validation'
import { EbookSpeech } from '../../src/main/ebook-speech'

class AudioFixture {
  src = ''
  preload = ''
  playbackRate = 1
  currentTime = 0
  paused = true
  playCalls = 0
  onplaying: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  async play() {
    this.playCalls++
    this.paused = false
    this.onplaying?.()
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {
    this.src = ''
  }
  load() {}
}
function fixture() {
  const audio = new AudioFixture()
  const requests: number[] = [],
    anchors: number[] = []
  let release = 0
  const api: EbookSpeechApi = {
    getEbookSpeechVoices: async () => ({
      ok: true,
      value: {
        available: true,
        message: '',
        voices: [{ id: 'voice', name: '系统声音', language: 'zh-CN' }],
      },
    }),
    synthesizeEbookSpeech: async ({ ordinal, offset }) => {
      requests.push(ordinal)
      return {
        ok: true,
        value: {
          url: `readlisten://app/speech/${ordinal}`,
          ordinal,
          offset,
          endOffset: 20,
          next: ordinal < 5 ? { ordinal: ordinal + 1, offset: 0 } : null,
        },
      }
    },
    releaseEbookSpeech: async () => {
      release++
      return { ok: true, value: undefined }
    },
  }
  const speech = new EbookSpeechPlayer(api, () => audio as unknown as HTMLAudioElement)
  speech.attach('book', (anchor) => anchors.push(anchor.ordinal))
  return { speech, audio, api, requests, anchors, release: () => release }
}

test('ebook narration reads from the chosen anchor, prepares only one next sentence and resumes paused audio', async () => {
  const { speech, audio, requests, anchors } = fixture()
  await speech.start({ ordinal: 2, offset: 4 })
  assert.equal(speech.getSnapshot().status, 'playing')
  assert.deepEqual(anchors, [2])
  assert.deepEqual(requests, [2, 3])
  audio.currentTime = 1.5
  speech.pause()
  assert.equal(audio.paused, true)
  await speech.start({ ordinal: 2, offset: 4 })
  assert.equal(audio.currentTime, 1.5)
  assert.equal(audio.playCalls, 2)
  assert.deepEqual(requests, [2, 3])
  speech.setRate(1.5)
  assert.equal(audio.playbackRate, 1.5)
  speech.stop()
})

test('a late synthesized sentence after stopping cannot start audio or advance the reader', async () => {
  const { speech, audio, api, anchors } = fixture()
  let release: ((value: { ok: true; value: EbookSpeechAudio }) => void) | undefined
  api.synthesizeEbookSpeech = () => new Promise((resolve) => (release = resolve))
  const starting = speech.start({ ordinal: 1, offset: 0 })
  await Promise.resolve()
  assert.ok(release)
  speech.stop()
  release({
    ok: true,
    value: { url: 'late', ordinal: 1, offset: 0, endOffset: 3, next: null },
  })
  await starting
  assert.equal(speech.getSnapshot().status, 'idle')
  assert.equal(audio.playCalls, 0)
  assert.deepEqual(anchors, [])
})

test('continuing after a manual reading jump starts the new anchor rather than resuming the old sentence', async () => {
  const { speech, audio, requests, anchors } = fixture()
  await speech.start({ ordinal: 1, offset: 0 })
  speech.pause('手动翻阅')
  await speech.start({ ordinal: 4, offset: 0 })
  assert.deepEqual(anchors, [1, 4])
  assert.deepEqual(requests, [1, 2, 4, 5])
  assert.equal(audio.src, 'readlisten://app/speech/4')
  speech.stop()
})

test('pausing an unresolved media play keeps the deliberate paused state when the browser rejects its play promise', async () => {
  const { speech, audio } = fixture()
  let rejectPlay: ((reason: Error) => void) | undefined
  audio.play = () => new Promise<void>((_resolve, reject) => (rejectPlay = reject))
  const starting = speech.start({ ordinal: 1, offset: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(rejectPlay)
  speech.pause()
  rejectPlay(new DOMException('Interrupted by pause()', 'AbortError'))
  await starting
  assert.equal(speech.getSnapshot().status, 'paused')
  assert.equal(speech.getSnapshot().message, '朗读已暂停')
  speech.stop()
})

test('the next sentence consumes its bounded prefetch and the final sentence ends without loading the whole book', async () => {
  const { speech, audio, requests, anchors } = fixture()
  await speech.start({ ordinal: 4, offset: 0 })
  assert.deepEqual(requests, [4, 5])
  audio.onended?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(anchors, [4, 5])
  assert.deepEqual(requests, [4, 5])
  audio.onended?.()
  assert.equal(speech.getSnapshot().status, 'ended')
  speech.stop()
})

test('recorded playback stops active narration only when it actually starts, never on idle progress or explicit pause notifications', () => {
  let playing = true,
    status: 'idle' | 'loading' | 'playing' | 'paused' = 'idle',
    releases = 0
  const listeners = new Set<() => void>()
  const speech = {
    getSnapshot: () => ({ status }) as ReturnType<EbookSpeechPlayer['getSnapshot']>,
    stop: () => {
      releases++
      status = 'idle'
    },
  }
  const detach = stopNarrationOnRecordedPlayback(speech, {
    getSnapshot: () => ({ playing }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  const notify = () => listeners.forEach((listener) => listener())
  notify() // An existing recording's ordinary progress update.
  notify()
  assert.equal(releases, 0)
  playing = false // Explicit pause is published before narration starts.
  notify()
  status = 'loading'
  notify() // Native pause and saved-progress notifications can arrive later.
  assert.equal(releases, 0)
  playing = true // A new deliberate recording play interrupts narration.
  notify()
  assert.equal(releases, 1)
  notify()
  assert.equal(releases, 1)
  playing = false
  notify()
  status = 'paused'
  playing = true
  notify()
  assert.equal(releases, 2)
  detach()
  assert.equal(listeners.size, 0)
})

test('missing system voices produce an explicit retryable state without claiming playback', async () => {
  const { speech, api, audio, requests } = fixture()
  api.getEbookSpeechVoices = async () => ({
    ok: true,
    value: { available: false, voices: [], message: '系统没有可用声音。' },
  })
  await speech.start({ ordinal: 0, offset: 0 })
  assert.equal(speech.getSnapshot().status, 'error')
  assert.equal(speech.getSnapshot().message, '系统没有可用声音。')
  assert.equal(audio.playCalls, 0)
  assert.deepEqual(requests, [])
})

test('an empty installed-voice result is probed again so adding a system voice does not require restarting the app', async () => {
  const speech = new EbookSpeech({
    get: () => {
      throw new Error('unused')
    },
    page: () => {
      throw new Error('unused')
    },
  })
  let checks = 0
  Reflect.set(speech, 'command', async () => ({
    voices: ++checks === 1 ? [] : [{ id: 'new-voice', name: '新增系统声音', language: 'zh-CN' }],
  }))
  assert.equal((await speech.available()).available, false)
  assert.equal((await speech.available()).available, true)
  assert.equal((await speech.available()).voices[0]?.id, 'new-voice')
  assert.equal(checks, 2)
  speech.close()
})

test('speech IPC accepts book anchors only and rejects paths, raw text, extra fields and unbounded values', () => {
  const request = { id: '13bc729a-0943-4443-af6f-3669af828025', ordinal: 3, offset: 2 }
  assert.doesNotThrow(() => validateSpeechRequest(SPEECH_CHANNELS.synthesize, [request]))
  assert.doesNotThrow(() => validateSpeechRequest(SPEECH_CHANNELS.voices, []))
  for (const invalid of [
    { ...request, text: 'Evaluate me' },
    { ...request, path: 'C:/outside.txt' },
    { ...request, ordinal: 250000 },
    { ...request, ordinal: -1 },
    { ...request, offset: Number.POSITIVE_INFINITY },
    { ...request, voice: 'x'.repeat(301) },
    { ...request, id: '../outside' },
  ])
    assert.throws(() => validateSpeechRequest(SPEECH_CHANNELS.synthesize, [invalid]))
  assert.throws(() => validateSpeechRequest(SPEECH_CHANNELS.voices, [{}]))
  assert.throws(() => validateSpeechRequest('ebook-speech:arbitrary', [request]))
})
