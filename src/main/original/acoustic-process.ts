import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { constants, setPriority } from 'node:os'
import type { AsrRuntime } from '../asr-process'
import { AppError } from '../../shared/validation'
import {
  ORIGINAL_ACOUSTIC_CONTRACT,
  ORIGINAL_ACOUSTIC_PROTOCOL,
  type AcousticCharacter,
  type AcousticEvidence,
  type OriginalAcousticResult,
} from '../../shared/original-acoustic'
import type { AcousticTextSnapshot, OriginalAcousticSnapshot } from './acoustic-snapshot'

function invalid(): never {
  throw new AppError('INTERNAL', '声学对齐结果校验未通过，原人工同步点保留。')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function bounded(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum)
    invalid()
  return value
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = bounded(value, maximum)
  if (!Number.isSafeInteger(result)) invalid()
  return result
}
function nullable(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value === null || value === undefined ? null : bounded(value, maximum)
}
export function lexicalCharacters(text: string) {
  const result: { text: string; textStart: number; textEnd: number }[] = []
  let offset = 0
  for (const char of text) {
    if (/[\p{L}\p{N}]/u.test(char))
      result.push({ text: char, textStart: offset, textEnd: offset + char.length })
    offset += char.length
  }
  return result
}

// Treat worker output as data. Never infer a missing timestamp or accept a
// different source, even when the child process reports success.
export function parseAcousticResult(
  input: unknown,
  snapshot: AcousticTextSnapshot,
  requestId: string,
): OriginalAcousticResult {
  const value = record(input)
  if (value.protocolVersion !== ORIGINAL_ACOUSTIC_PROTOCOL || value.requestId !== requestId)
    invalid()
  if (value.type === 'error') {
    const code = value.code === 'FILE_CHANGED' ? 'FILE_CHANGED' : 'RUNTIME_UNAVAILABLE'
    throw new AppError(
      code,
      typeof value.message === 'string' && value.message.length <= 1000
        ? value.message
        : '原文声学对齐未完成，原人工同步点保留。',
    )
  }
  const range = record(value.range)
  if (
    value.type !== 'result' ||
    !['accepted', 'rejected'].includes(String(value.status)) ||
    value.contract !== ORIGINAL_ACOUSTIC_CONTRACT ||
    value.audioHash !== snapshot.audioHash ||
    value.textSha256 !== snapshot.textHash ||
    value.device !== snapshot.device ||
    range.startMs !== snapshot.range.startMs ||
    range.endMs !== snapshot.range.endMs ||
    !Array.isArray(value.characters) ||
    !Array.isArray(value.reasons) ||
    value.reasons.length > 30
  )
    invalid()
  const expected = lexicalCharacters(snapshot.originalText)
  const rawEvidence = record(value.evidence)
  const evidence: AcousticEvidence = {
    lexicalCharacters: integer(rawEvidence.lexicalCharacters, 1000),
    timedCharacters: integer(rawEvidence.timedCharacters, 1000),
    characterCoverage: bounded(rawEvidence.characterCoverage, 1),
    audioRms: nullable(rawEvidence.audioRms),
    freePathCharacters: nullable(rawEvidence.freePathCharacters, 100_000),
    freePathEditDistance: nullable(rawEvidence.freePathEditDistance, 100_000),
    minTokenPosterior: nullable(rawEvidence.minTokenPosterior, 1),
    meanTokenPosterior: nullable(rawEvidence.meanTokenPosterior, 1),
    confidence: nullable(rawEvidence.confidence, 1),
  }
  if (
    evidence.lexicalCharacters !== expected.length ||
    evidence.timedCharacters > expected.length ||
    Math.abs(evidence.characterCoverage - evidence.timedCharacters / expected.length) > 0.00001
  )
    invalid()
  const reasons = value.reasons.map((item) => {
    const reason = record(item)
    if (
      typeof reason.code !== 'string' ||
      !/^[A-Z0-9_]{1,80}$/.test(reason.code) ||
      typeof reason.message !== 'string' ||
      reason.message.length > 1000
    )
      invalid()
    return { code: reason.code, message: reason.message }
  })
  const characters: AcousticCharacter[] = []
  if (value.status === 'accepted') {
    if (!expected.length || reasons.length || value.characters.length !== expected.length) invalid()
    let lastEnd = snapshot.range.startMs
    value.characters.forEach((item, index) => {
      const char = record(item),
        wanted = expected[index]!
      if (
        char.text !== wanted.text ||
        char.textStart !== wanted.textStart ||
        char.textEnd !== wanted.textEnd
      )
        invalid()
      const startMs = integer(char.startMs),
        endMs = integer(char.endMs)
      if (startMs < lastEnd || endMs <= startMs || endMs > snapshot.range.endMs + 1) invalid()
      characters.push({ ...wanted, startMs, endMs, score: bounded(char.score, 1) })
      lastEnd = endMs
    })
    if (
      value.startMs !== characters[0]!.startMs ||
      value.endMs !== characters.at(-1)!.endMs ||
      evidence.characterCoverage !== 1 ||
      evidence.timedCharacters !== expected.length ||
      evidence.audioRms === null ||
      evidence.minTokenPosterior === null ||
      evidence.meanTokenPosterior === null ||
      evidence.freePathCharacters === null ||
      evidence.freePathEditDistance === null
    )
      invalid()
  } else if (
    value.characters.length ||
    !reasons.length ||
    value.startMs != null ||
    value.endMs != null
  )
    invalid()
  const sentenceTimes = snapshot.sentences.flatMap((sentence) => {
    const timed = characters.filter(
      (char) => char.textStart >= sentence.textStart && char.textEnd <= sentence.textEnd,
    )
    return timed.length
      ? [{ ordinal: sentence.ordinal, startMs: timed[0]!.startMs, endMs: timed.at(-1)!.endMs }]
      : []
  })
  const thresholds = record(value.thresholds)
  if (
    value.ctcContract !== 'ctc-complete-waveform-logodds-v1' ||
    value.qualityPolicy !== 'confirmed-original-acoustic-gate-v1' ||
    Object.keys(thresholds).length > 20 ||
    Object.keys(thresholds).some((key) => !/^[a-zA-Z]{1,80}$/.test(key))
  )
    invalid()
  return {
    status: value.status as OriginalAcousticResult['status'],
    contract: ORIGINAL_ACOUSTIC_CONTRACT,
    range: { ...snapshot.range },
    startMs: characters[0]?.startMs ?? null,
    endMs: characters.at(-1)?.endMs ?? null,
    characters,
    sentenceTimes,
    evidence,
    reasons,
    diagnostics: {
      ctcContract: value.ctcContract,
      qualityPolicy: value.qualityPolicy,
      thresholds: Object.fromEntries(
        Object.entries(thresholds).map(([key, number]) => [key, bounded(number)]),
      ),
      elapsedMs: integer(value.elapsedMs),
      freePathErrorRate: nullable(rawEvidence.freePathErrorRate),
      maxUnexplainedPosterior: nullable(rawEvidence.maxUnexplainedPosterior, 1),
    },
  }
}

export async function runTextAcoustic(
  runtime: AsrRuntime,
  snapshot: AcousticTextSnapshot,
  audioPath: string,
  requestId: string,
  signal: AbortSignal,
): Promise<OriginalAcousticResult> {
  signal.throwIfAborted()
  const args = ['-B', '-X', 'utf8', resolve(dirname(runtime.script), 'asr_original_alignment.py')]
  for (const [key, value] of Object.entries({
    models: runtime.models,
    resources: runtime.resources ?? runtime.cache,
    ffmpeg: runtime.ffmpeg,
    ffprobe: runtime.ffprobe,
    cache: runtime.cache,
  }))
    args.push(`--${key}`, value)
  if (runtime.cpuThreads) args.push('--cpu-threads', String(runtime.cpuThreads))
  const output = await new Promise<string>((accept, reject) => {
    const child = execFile(
      runtime.python,
      args,
      {
        windowsHide: true,
        shell: false,
        signal,
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      },
      (error, stdout, stderr) => {
        if (!error) accept(stdout)
        else if (signal.aborted) reject(signal.reason)
        else {
          const failure = new AppError(
            'RUNTIME_UNAVAILABLE',
            '声学对齐组件运行未完成，请检查组件或设备后重试。',
          )
          failure.stack += `\n${error.message}\n${stderr.slice(-8192)}`
          reject(failure)
        }
      },
    )
    child.stdin?.on('error', () => {
      // The exit/abort callback owns completion; an early close must not crash main.
    })
    child.once('spawn', () => {
      if (!runtime.lowPriority || !child.pid) return
      try {
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        child.kill()
      }
    })
    child.stdin?.end(
      JSON.stringify({
        protocolVersion: ORIGINAL_ACOUSTIC_PROTOCOL,
        requestId,
        audioPath,
        audioHash: snapshot.audioHash,
        device: snapshot.device,
        range: snapshot.range,
        text: snapshot.originalText,
      }) + '\n',
    )
  })
  signal.throwIfAborted()
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    invalid()
  }
  return parseAcousticResult(value, snapshot, requestId)
}

// Keep the original-book API typed to its complete mapping snapshot. The text
// runner also serves transcript edits without inventing an original-book ID.
export function runOriginalAcoustic(
  runtime: AsrRuntime,
  snapshot: OriginalAcousticSnapshot,
  audioPath: string,
  requestId: string,
  signal: AbortSignal,
): Promise<OriginalAcousticResult> {
  return runTextAcoustic(runtime, snapshot, audioPath, requestId, signal)
}
