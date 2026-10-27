import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export function createDataPaths(root: string) {
  if (!isAbsolute(root)) throw new Error('用户数据目录必须是绝对路径。')
  const paths = {
    root,
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    models: join(root, 'models'),
    logs: join(root, 'logs'),
    session: join(root, 'chromium'),
  }
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  return { ...paths, database: join(paths.data, 'library.sqlite3') }
}
