import { crc32, deflateRawSync } from 'node:zlib'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parsePluginPackage } from '../../src/main/plugins/package'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--directory' || args[2] !== '--output')
  throw new Error(
    'Usage: npm run plugin:pack -- --directory <plugin-folder> --output <new-plugin.zip>',
  )
const root = resolve(args[1]!),
  output = resolve(args[3]!)
const files: Array<{ name: string; bytes: Buffer }> = []
async function collect(directory: string, prefix = '') {
  if (prefix.split('/').length > 9) throw new Error('Plugin folder nesting exceeds 8 levels.')
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name,
      path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Plugin folders cannot contain symbolic links.')
    if (entry.isDirectory()) await collect(path, `${name}/`)
    else if (entry.isFile()) {
      if (files.length >= 128) throw new Error('Plugin folder contains too many files.')
      const bytes = await readFile(path)
      if (bytes.length > 2 * 1024 * 1024) throw new Error('A plugin file exceeds 2 MiB.')
      files.push({ name: name.replaceAll('\\', '/'), bytes })
    } else throw new Error('Unsupported plugin file type.')
  }
}
await collect(root)
const locals: Buffer[] = [],
  central: Buffer[] = []
let offset = 0
for (const file of files) {
  const name = Buffer.from(file.name),
    data = deflateRawSync(file.bytes),
    crc = crc32(file.bytes)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(file.bytes.length, 22)
  local.writeUInt16LE(name.length, 26)
  locals.push(local, name, data)
  const record = Buffer.alloc(46)
  record.writeUInt32LE(0x02014b50)
  record.writeUInt16LE(20, 4)
  record.writeUInt16LE(20, 6)
  record.writeUInt16LE(0x800, 8)
  record.writeUInt16LE(8, 10)
  record.writeUInt32LE(crc, 16)
  record.writeUInt32LE(data.length, 20)
  record.writeUInt32LE(file.bytes.length, 24)
  record.writeUInt16LE(name.length, 28)
  record.writeUInt32LE(offset, 42)
  central.push(record, name)
  offset += local.length + name.length + data.length
}
const records = Buffer.concat(central),
  end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(records.length, 12)
end.writeUInt32LE(offset, 16)
const archive = Buffer.concat([...locals, records, end])
const parsed = parsePluginPackage(archive)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, archive, { flag: 'wx' })
console.log(
  JSON.stringify(
    {
      path: output,
      id: parsed.manifest.id,
      version: parsed.manifest.version,
      sources: parsed.manifest.sources.length,
      bytes: archive.length,
      sha256: parsed.sha256,
    },
    null,
    2,
  ),
)
