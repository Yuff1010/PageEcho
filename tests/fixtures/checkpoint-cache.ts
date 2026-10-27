import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const cacheManifest = {
  version: 1,
  audioHash: 'a'.repeat(64),
  configuration: {
    engine: 'whisperx',
    device: 'cpu',
    transcriptVersion: 1,
    postprocessVersion: 2,
    chunkMs: 30000,
    overlapMs: 2000,
  },
  startMs: 0,
  endMs: 60000,
}
// The key follows Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')).
export const checkpointKey = createHash('sha256')
  .update(
    '{"audioHash":"' +
      'a'.repeat(64) +
      '","configuration":{"chunkMs":30000,"device":"cpu","engine":"whisperx","overlapMs":2000,"postprocessVersion":2,"transcriptVersion":1},"endMs":60000,"startMs":0}',
  )
  .digest('hex')
export async function checkpointFixture(root: string) {
  const directory = join(root, 'jobs', checkpointKey)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(cacheManifest))
  await writeFile(join(directory, 'chunk-000000.json'), '{"fixture":"reusable chunk"}')
  return directory
}
