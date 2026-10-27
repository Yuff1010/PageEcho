import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication } from '@playwright/test'

const execute = promisify(execFile)
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Only accepts the application returned by this test's own electron.launch(). */
export async function closeOwnedElectron(app: ElectronApplication, timeoutMs = 10000) {
  const child = app.process()
  const pid = child.pid
  if (!pid) throw new Error('Owned Electron launcher has no PID')
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const started = Date.now()
  if (exited()) return { kind: 'already-exited' as const, launcherPid: pid, elapsedMs: 0 }
  let closeError = ''
  const closeAttempt = app.close().then(
    () => true,
    (error: unknown) => {
      closeError = error instanceof Error ? error.message : String(error)
      return false
    },
  )
  const closed = await within(closeAttempt, timeoutMs)
  if (closed && exited())
    return { kind: 'graceful' as const, launcherPid: pid, elapsedMs: Date.now() - started }
  // A closed automation context can reject close() while its Windows cmd/Electron tree survives.
  // Use the still-live ChildProcess handle from our launch, never a PID taken from a report.
  if (!exited()) {
    if (process.platform === 'win32') {
      try {
        await execute(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 },
        )
      } catch (error) {
        if (!exited()) throw error
      }
    } else {
      child.kill('SIGKILL')
    }
  }
  let onExit: (() => void) | undefined
  let didExit = exited()
  if (!didExit) {
    try {
      didExit = !!(await within(
        new Promise<boolean>((resolve) => {
          onExit = () => resolve(true)
          child.once('exit', onExit)
        }),
        5000,
      ))
    } finally {
      if (onExit) child.removeListener('exit', onExit)
    }
  }
  if (!didExit && !exited())
    throw new Error(`Owned Electron launcher ${pid} did not exit after cleanup`)
  await within(closeAttempt, 500)
  return { kind: 'forced' as const, launcherPid: pid, elapsedMs: Date.now() - started, closeError }
}
