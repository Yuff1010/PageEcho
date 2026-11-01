import { managedGeneratedStorage } from '../build/managed-generated'
const args = process.argv.slice(2),
  action = args.shift() ?? 'preview'
const owned = managedGeneratedStorage()
await owned.refresh()
let result: unknown
if (action === 'preview' && !args.length) result = await owned.service.preview()
else if (action === 'state' && !args.length) result = await owned.service.state()
else if (action === 'apply' && args.length === 2 && args[0] === '--token')
  result = await owned.service.clear(args[1]!)
else if (action === 'policy' && args.length === 8) {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    if (
      values.has(args[i]!) ||
      !['--automatic', '--keep', '--max-gib', '--days'].includes(args[i]!)
    )
      throw new Error('Invalid policy flags')
    values.set(args[i]!, args[i + 1]!)
  }
  if (!['true', 'false'].includes(values.get('--automatic') ?? ''))
    throw new Error('--automatic must be true or false')
  result = await owned.service.savePolicy({
    automatic: values.get('--automatic') === 'true',
    keepLatest: Number(values.get('--keep')),
    maxBytes: Number(values.get('--max-gib')) * 1024 ** 3,
    maxAgeDays: Number(values.get('--days')),
  })
} else
  throw new Error(
    'Usage: workspace:storage [preview|state|apply --token <token>|policy --automatic false --keep 2 --max-gib 2 --days 30]',
  )
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
