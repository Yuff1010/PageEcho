// Query declared Python pins without importing Python packages or changing components.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PythonPin {
  name: string
  version: string
  originalVersions: string[]
  sources: string[]
}
interface Advisory {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  withdrawn?: string
  affected?: unknown[]
  references?: { type: string; url: string }[]
  severity?: unknown[]
  database_specific?: { severity?: string }
}
const canonical = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')
const OSV = 'https://api.osv.dev/v1/'

export function parsePythonPins(inputs: { source: string; content: string }[]): PythonPin[] {
  const pins = new Map<string, PythonPin>()
  for (const { source, content } of inputs) {
    if (Buffer.byteLength(content) > 256 * 1024)
      throw new Error('Requirements file exceeds 256 KiB')
    const names = new Set<string>()
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const value = line.trim()
      if (!value || value.startsWith('#')) continue
      if (/^--extra-index-url https:\/\/download\.pytorch\.org\/whl\/(?:cpu|cu\d+)$/.test(value))
        continue
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.!+_-]*)$/.exec(value)
      if (!match) throw new Error(`Unsupported exact pin at ${source}:${index + 1}`)
      const name = canonical(match[1]!)
      if (names.has(name)) throw new Error(`Duplicate package at ${source}:${index + 1}`)
      names.add(name)
      // CPU/CUDA wheel local versions share the public PyPI release's advisory ranges.
      const original = match[2]!,
        version = original.split('+')[0]!,
        key = `${name}@${version}`
      const pin = pins.get(key) ?? { name, version, originalVersions: [], sources: [] }
      if (!pin.originalVersions.includes(original)) pin.originalVersions.push(original)
      if (!pin.sources.includes(source)) pin.sources.push(source)
      pins.set(key, pin)
      if (pins.size > 400) throw new Error('Audit exceeds 400 unique package versions')
    }
  }
  if (!pins.size) throw new Error('No exact Python pins found')
  return [...pins.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )
}

export function groupPythonAdvisories(advisories: Advisory[]) {
  const parent = new Map<string, string>()
  function find(id: string): string {
    if (!parent.has(id)) parent.set(id, id)
    const next = parent.get(id)!
    if (next !== id) parent.set(id, find(next))
    return parent.get(id)!
  }
  for (const item of advisories)
    for (const alias of item.aliases ?? []) parent.set(find(alias), find(item.id))
  const groups = new Map<string, Advisory[]>()
  for (const item of advisories) {
    const key = find(item.id)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const ranks = ['UNKNOWN', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL']
  return [...groups.values()]
    .map((items) => {
      const ids = items.map((item) => item.id).sort()
      const severity = items
        .map((item) => item.database_specific?.severity?.toUpperCase() ?? 'UNKNOWN')
        .reduce((a, b) => (ranks.indexOf(b) > ranks.indexOf(a) ? b : a), 'UNKNOWN')
      return {
        id: ids.find((id) => id.startsWith('GHSA-')) ?? ids[0]!,
        ids,
        aliases: [...new Set(items.flatMap((item) => item.aliases ?? []))].sort(),
        severity,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function auditPythonPins(
  pins: PythonPin[],
  options: {
    fetch?: typeof fetch
    responseBytes?: number
    requestTimeoutMs?: number
    totalTimeoutMs?: number
  } = {},
) {
  if (!pins.length || pins.length > 400) throw new Error('Expected 1–400 unique Python pins')
  const request = options.fetch ?? fetch
  const budget = options.responseBytes ?? 16 * 1024 * 1024
  const total = AbortSignal.timeout(options.totalTimeoutMs ?? 120000)
  async function json(url: string, body?: unknown): Promise<unknown> {
    const response = await request(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PageEcho dependency audit' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([total, AbortSignal.timeout(options.requestTimeoutMs ?? 20000)]),
    })
    if (!response.ok || !response.body)
      throw new Error(`OSV request failed: HTTP ${response.status}`)
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        bytes += result.value.byteLength
        if (bytes > budget) throw new Error('OSV response exceeds byte budget')
        chunks.push(result.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const batch = (await json(OSV + 'querybatch', {
    queries: pins.map((pin) => ({
      package: { name: pin.name, ecosystem: 'PyPI' },
      version: pin.version,
    })),
  })) as { results?: { vulns?: { id: string }[]; next_page_token?: unknown }[] }
  if (!Array.isArray(batch?.results) || batch.results.length !== pins.length)
    throw new Error('OSV returned an incomplete batch; no clean result can be inferred')
  const records = batch.results.map((result) => {
    if (
      !result ||
      typeof result !== 'object' ||
      (result.vulns !== undefined && !Array.isArray(result.vulns))
    )
      throw new Error('Malformed OSV query result')
    if (result.next_page_token !== undefined && result.next_page_token !== '')
      throw new Error('OSV returned a paginated result; the audit is incomplete')
    return (result.vulns ?? []).map((item) => {
      if (!item || !/^[A-Za-z0-9][A-Za-z0-9-]{0,95}$/.test(item.id))
        throw new Error('Malformed OSV advisory identity')
      return item.id
    })
  })
  const ids = [...new Set(records.flat())].sort()
  if (ids.length > 2000) throw new Error('OSV advisory count exceeds audit budget')
  const advisories = new Map<string, Advisory>()
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(6, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++]!
        const item = (await json(OSV + 'vulns/' + encodeURIComponent(id))) as Advisory
        if (
          item?.id !== id ||
          (item.aliases !== undefined &&
            (!Array.isArray(item.aliases) ||
              item.aliases.some((alias) => typeof alias !== 'string')))
        )
          throw new Error('OSV advisory response does not match the requested identity')
        advisories.set(id, item)
      }
    }),
  )
  const findings = pins.flatMap((pin, index) =>
    records[index]!.length
      ? [{ ...pin, advisories: [...new Set(records[index])].map((id) => advisories.get(id)!) }]
      : [],
  )
  return {
    status: 'complete',
    generatedUtc: new Date().toISOString(),
    source: OSV,
    scope:
      'Declared exact Python pins, Windows CPU/CUDA local versions use public release ranges. No installed packages, model weights or application data are executed or modified. An empty finding list is not a security guarantee.',
    packageVersions: pins.length,
    affectedPackageVersions: findings.length,
    rawAdvisoryRecords: advisories.size,
    advisoryGroups: groupPythonAdvisories([...advisories.values()]),
    findings,
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--output'))
    throw new Error('Usage: npm run audit:python -- [--output cache/<fresh-report>.json]')
  const filename = resolve(
    args[1] ??
      `cache/dependency-audits/python-${new Date().toISOString().replaceAll(':', '-')}.json`,
  )
  const local = relative(resolve('cache'), filename)
  if (
    !local ||
    isAbsolute(local) ||
    local === '..' ||
    local.startsWith('..\\') ||
    local.startsWith('../')
  )
    throw new Error('Audit output must be a new file inside workspace cache/')
  const files = ['python/requirements-cpu.txt', 'python/requirements-evaluation.txt']
  const inputs = await Promise.all(
    files.map(async (source) => ({ source, content: await readFile(source, 'utf8') })),
  )
  const report = await auditPythonPins(parsePythonPins(inputs))
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(
    JSON.stringify({
      report: filename,
      status: report.status,
      packageVersions: report.packageVersions,
      affectedPackageVersions: report.affectedPackageVersions,
      rawAdvisoryRecords: report.rawAdvisoryRecords,
      uniqueAdvisories: report.advisoryGroups.length,
    }),
  )
  if (report.findings.length) process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    process.exitCode = 2
  })
