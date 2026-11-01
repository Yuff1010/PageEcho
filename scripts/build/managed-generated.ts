import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { GeneratedStorageService } from '../../src/main/maintenance/storage-policy'

/** Only future builder outputs under this new receipt-owned root can be managed. */
export function managedGeneratedStorage(workspace = process.cwd()) {
  let active: string[] | null = null
  const service = new GeneratedStorageService({
    directory: resolve(workspace, 'cache/managed-generated'),
    isActive: (path) =>
      active === null ||
      active.some((command) => command.toLowerCase().includes(path.toLowerCase())),
  })
  const refresh = async () => {
    if (process.platform !== 'win32') {
      active = null
      return
    }
    try {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress',
        ],
        { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 10000 },
      )
      const value: unknown = JSON.parse(stdout)
      if (Array.isArray(value) && value.every((item) => item === null || typeof item === 'string'))
        active = value.filter((item): item is string => typeof item === 'string')
      else active = null
    } catch {
      active = null
    }
  }
  return { service, refresh }
}
export async function beginManagedGenerated(kind: 'build' | 'package', label: string) {
  const owned = managedGeneratedStorage()
  const slot = await owned.service.create(kind, label)
  return {
    ...slot,
    complete: async () => {
      await owned.refresh()
      return owned.service.complete(slot.id)
    },
  }
}
