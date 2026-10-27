import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { validateTranscript } from '../src/shared/transcript'

interface EvaluationReport {
  status: string
  samples: {
    id: string
    audioHash: string
    offsetMs: number
    durationMs: number
    attempts: { status: string; transcript?: string }[]
  }[]
}

const directories = process.argv.slice(2).map((directory) => resolve(directory))
if (directories.length === 0) {
  throw new Error('请提供评估运行目录：npm run asr:validate -- cache/asr-evaluation/runs/<运行>')
}
let failed = false
for (const directory of directories) {
  const report = JSON.parse(
    await readFile(join(directory, 'report.json'), 'utf8'),
  ) as EvaluationReport
  const checks: { sample: string; transcript: string; segments?: number; error?: string }[] = []
  for (const sample of report.samples) {
    for (const attempt of sample.attempts) {
      if (!attempt.transcript) continue
      const check: (typeof checks)[number] = {
        sample: sample.id,
        transcript: attempt.transcript,
      }
      checks.push(check)
      try {
        if (
          isAbsolute(attempt.transcript) ||
          attempt.transcript.includes('/') ||
          attempt.transcript.includes('\\')
        ) {
          throw new Error('文稿文件必须位于评估目录中')
        }
        const document = validateTranscript(
          JSON.parse(await readFile(join(directory, attempt.transcript), 'utf8')),
          sample.audioHash,
          sample.offsetMs + sample.durationMs,
        )
        if (
          document.coverage.length !== 1 ||
          document.coverage[0]?.startMs !== sample.offsetMs ||
          document.coverage[0]?.endMs !== sample.offsetMs + sample.durationMs
        ) {
          throw new Error('已处理范围与原始音频偏移不符')
        }
        check.segments = document.segments.length
      } catch (error) {
        failed = true
        check.error = error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (checks.length === 0) failed = true
  const result = {
    checkedAt: new Date().toISOString(),
    status: checks.length > 0 && checks.every((check) => !check.error) ? 'passed' : 'failed',
    scope: 'M2 schema, content hash binding and original time offset; not recognition accuracy',
    modelEvaluationStatus: report.status,
    rejectedModelAttempts: report.samples
      .flatMap((sample) => sample.attempts)
      .filter((attempt) => attempt.status === 'failed' || attempt.status === 'invalid-timestamps')
      .length,
    checks,
  }
  await writeFile(
    join(directory, 'transcript-validation.json'),
    JSON.stringify(result, null, 2) + '\n',
  )
  console.log(`${directory}: ${result.status} (${checks.length} 文稿)`)
}
process.exitCode = failed ? 1 : 0
