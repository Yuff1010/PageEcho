import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output'))
  throw new Error('Usage: npm run workspace:inventory -- [--output cache/maintenance/report.json]')
const root = fileURLToPath(new URL('../..', import.meta.url))
const reportRoot = resolve(root, 'cache/maintenance')
const output = resolve(root, args[1] ?? 'cache/maintenance/inventory.json')
const inside = (base: string, path: string) => {
  const local = relative(base, path)
  return local !== '' && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local)
}
if (!inside(reportRoot, output) || !output.endsWith('.json'))
  throw new Error('Inventory reports must be JSON files under cache/maintenance.')
for (let ancestor = dirname(output); ancestor.length >= root.length; ancestor = dirname(ancestor)) {
  const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (info?.isSymbolicLink()) throw new Error('The report path cannot pass through a link.')
  if (resolve(ancestor) === resolve(root)) break
}
const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
})
if (existing && (!existing.isFile() || existing.isSymbolicLink()))
  throw new Error('The inventory report cannot replace a link or a special file.')

const groups = new Map<string, { path: string; bytes: number; files: number }>()
const skippedLinks: string[] = []
const errors: string[] = []
const pending = [root]
while (pending.length) {
  const directory = pending.pop()!
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (let start = 0; start < entries.length; start += 32) {
      await Promise.all(
        entries.slice(start, start + 32).map(async (entry) => {
          const path = join(directory, entry.name)
          const local = relative(root, path).split(sep).join('/')
          try {
            const info = await lstat(path)
            if (info.isSymbolicLink()) {
              skippedLinks.push(local)
            } else if (info.isDirectory()) {
              pending.push(path)
            } else if (info.isFile()) {
              const parts = local.split('/')
              let key = parts[0]!
              if (['cache', 'release'].includes(parts[0]!) && parts.length > 1)
                key += '/' + parts[1]
              if (
                parts[0] === 'cache' &&
                ['optimization', 'asr-evaluation'].includes(parts[1]!) &&
                parts.length > 2
              )
                key += '/' + parts[2]
              const group = groups.get(key) ?? { path: key, bytes: 0, files: 0 }
              group.bytes += info.size
              group.files++
              groups.set(key, group)
            }
          } catch (error) {
            errors.push(`${local}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }),
      )
    }
  } catch (error) {
    errors.push(`${relative(root, directory)}: ${String(error)}`)
  }
}
const items = [...groups.values()].sort((a, b) => b.bytes - a.bytes)
const totalBytes = items.reduce((total, item) => total + item.bytes, 0)
await mkdir(dirname(output), { recursive: true })
const temporary = join(dirname(output), `.inventory-${randomUUID()}.json`)
await writeFile(
  temporary,
  JSON.stringify(
    {
      root,
      recordedAt: new Date().toISOString(),
      mode: 'read-only-inventory',
      totalBytes,
      groups: items,
      skippedLinks: skippedLinks.sort(),
      errors,
      deletedFiles: 0,
      deletedBytes: 0,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
)
// Replace the directory entry instead of following an existing leaf or hard link.
await rename(temporary, output)
process.stdout.write(`Total: ${(totalBytes / 1024 ** 3).toFixed(3)} GiB. No files deleted.\n`)
for (const item of items.slice(0, 15))
  process.stdout.write(`${(item.bytes / 1024 ** 3).toFixed(3)} GiB\t${item.path}\n`)
process.stdout.write(`Report: ${output}\n`)
if (errors.length) process.stderr.write(`Inventory errors: ${errors.length}; see report.\n`)
