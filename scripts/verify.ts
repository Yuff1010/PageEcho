import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyVerification } from './verification-status'

type Status = 'running' | 'passed' | 'failed' | 'blocked' | 'not-run'
interface Step {
  name: string
  task: string
  args?: string[]
  packaged?: boolean
  status: Status
  log: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  exitCode?: number | null
  pid?: number
  reason?: string
}

const root = fileURLToPath(new URL('..', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli || !existsSync(npmCli)) throw new Error('请通过 npm run verify 执行验证。')
const options = process.argv.slice(2)
if (options.some((option) => !['--packaged', '--asr'].includes(option)))
  throw new Error('仅支持可选参数 --packaged、--asr。')
const startedAt = new Date().toISOString()
const reportRoot = join(root, 'cache', 'verification')
const runDirectory = join(reportRoot, startedAt.replace(/[:.]/g, '-'))
mkdirSync(runDirectory, { recursive: true })
const steps: Step[] = [
  { name: '静态检查与单元测试', task: 'check', status: 'not-run', log: '' },
  ...(options.includes('--asr')
    ? [
        {
          name: '转写进程协议、取消与分块测试（无需模型）',
          task: 'test:worker',
          status: 'not-run' as Status,
          log: '',
        },
      ]
    : []),
  { name: '真实开发窗口', task: 'test:dev', status: 'not-run', log: '' },
  { name: '生产构建', task: 'build', status: 'not-run', log: '' },
  {
    name: '源码生产桌面测试',
    task: 'test:desktop',
    args: ['--output=test-results/verify-source', '--max-failures=1'],
    status: 'not-run',
    log: '',
  },
  ...(options.includes('--packaged')
    ? [
        { name: 'Windows 安装包构建', task: 'dist:win', status: 'not-run' as Status, log: '' },
        {
          name: '打包程序桌面测试',
          task: 'test:desktop',
          args: ['--output=test-results/verify-packaged', '--max-failures=1'],
          packaged: true,
          status: 'not-run' as Status,
          log: '',
        },
      ]
    : []),
]
const plan = readFileSync(join(root, 'docs', 'PLAN.md'), 'utf8')
let milestone = ''
const pendingItems: { milestone: string; task: string }[] = []
for (const line of plan.split(/\r?\n/)) {
  const heading = /^### (M\d+)[：:]/.exec(line)
  if (heading) milestone = heading[1]!
  const item = /^- \[ \] (.+)$/.exec(line)
  if (item) pendingItems.push({ milestone, task: item[1]! })
}
const report = {
  version: (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
    .version,
  startedAt,
  finishedAt: null as string | null,
  status: 'running' as Status,
  plan: 'docs/PLAN.md',
  nextTask: plan.split('## 6. 下一次开发的最小任务')[1]?.trim() ?? '',
  pendingItems,
  steps,
}
function saveReport() {
  const content = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(join(runDirectory, 'report.json'), content)
  writeFileSync(join(reportRoot, 'latest.json'), content)
}

async function run(step: Step, index: number): Promise<void> {
  console.log(`\n[${index + 1}/${steps.length}] ${step.name}`)
  step.status = 'running'
  step.startedAt = new Date().toISOString()
  step.log = join(runDirectory, `${index + 1}-${step.task.replaceAll(':', '-')}.log`)
  const started = performance.now()
  const env = { ...process.env, FORCE_COLOR: '0' }
  Reflect.deleteProperty(env, 'NO_COLOR')
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  Reflect.deleteProperty(env, 'RALB_EXECUTABLE')
  if (step.packaged)
    Reflect.set(env, 'RALB_EXECUTABLE', resolve(root, 'release/win-unpacked/ReadAndListenBook.exe'))
  let output = ''
  let spawnError = ''
  const exitCode = await new Promise<number | null>((complete) => {
    const child = spawn(
      process.execPath,
      [npmCli!, 'run', step.task, ...(step.args ? ['--', ...step.args] : [])],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    step.pid = child.pid
    saveReport()
    const capture = (text: string) => {
      process.stdout.write(text)
      appendFileSync(step.log, text)
      output = (output + text).slice(-128000)
    }
    child.stdout.setEncoding('utf8').on('data', capture)
    child.stderr.setEncoding('utf8').on('data', capture)
    child.once('error', (error) => {
      spawnError = error.message
    })
    child.once('close', complete)
  })
  step.exitCode = exitCode
  step.durationMs = Math.round(performance.now() - started)
  step.finishedAt = new Date().toISOString()
  Object.assign(step, classifyVerification(exitCode, output, spawnError))
  saveReport()
}

saveReport()
try {
  for (const [index, step] of steps.entries()) {
    await run(step, index)
    if (step.status !== 'passed') {
      report.status = step.status
      break
    }
  }
  if (report.status === 'running') report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  console.error(error)
} finally {
  report.finishedAt = new Date().toISOString()
  saveReport()
}
console.log(`\n验证结果：${report.status}。报告：${join(reportRoot, 'latest.json')}`)
console.log(`计划中仍有 ${pendingItems.length} 个待完成项目；测试通过不会自动勾选计划。`)
process.exitCode = report.status === 'passed' ? 0 : 1
