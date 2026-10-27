export function classifyVerification(
  exitCode: number | null,
  output: string,
  spawnError = '',
): {
  status: 'passed' | 'failed' | 'blocked'
  reason?: string
} {
  if (exitCode === 0 && !spawnError) return { status: 'passed' }
  // Windows may emit the policy message in Chinese or English; the policy name and exit code remain stable.
  if (/Device Guard/i.test(output) && /exitCode[=:]\s*4551\b/.test(output))
    return { status: 'blocked', reason: 'Windows Device Guard 拦截程序启动；尚未执行应用断言。' }
  return { status: 'failed', reason: spawnError || `命令退出码 ${String(exitCode)}，请查看日志。` }
}
