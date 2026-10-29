import { TEXT_SOURCE_CHANNELS } from '../../shared/text-source-api'
import { SourceError } from '../../shared/sources'
import { validateRemoteLibrary } from './text-service'

const invalid = (): never => {
  throw new SourceError('INVALID_SOURCE_REQUEST', '书库请求参数无效，请重新操作。')
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\r\n]/.test(value) &&
  !value.includes('\u0000')

export function validateTextSourceArgs(channel: string, args: unknown[]): void {
  const channels = TEXT_SOURCE_CHANNELS
  if ([channels.state, channels.manifestExport].includes(channel as typeof channels.state)) {
    if (args.length) invalid()
    return
  }
  if (args.length !== 1 || !isObject(args[0])) invalid()
  const request = args[0] as Record<string, unknown>
  if (channel === channels.save) {
    validateRemoteLibrary(request)
    return
  }
  if (
    [channels.manifestPreview, channels.manifestApply].includes(
      channel as typeof channels.manifestPreview,
    )
  ) {
    if (
      Object.keys(request).length !== 1 ||
      typeof request.rawJson !== 'string' ||
      !request.rawJson.trim() ||
      Buffer.byteLength(request.rawJson, 'utf8') > 128 * 1024 ||
      request.rawJson.includes('\u0000')
    )
      invalid()
    return
  }
  if (channel === channels.remove) {
    if (
      Object.keys(request).length !== 1 ||
      !string(request.id, 100) ||
      !/^[\w-]+$/.test(String(request.id))
    )
      invalid()
    return
  }
  if (!string(request.requestId, 120) || !/^[\w-]+$/.test(String(request.requestId))) invalid()
  if (channel === channels.cancel) {
    if (Object.keys(request).length !== 1) invalid()
    return
  }
  if (!string(request.sourceId, 100) || !/^[\w-]+$/.test(String(request.sourceId))) invalid()
  let allowed = ['requestId', 'sourceId']
  if (channel === channels.browse) {
    allowed = [...allowed, 'query', 'cursor']
    if (
      request.query !== undefined &&
      (typeof request.query !== 'string' ||
        request.query.length > 200 ||
        /[\r\n]/.test(request.query) ||
        request.query.includes('\u0000'))
    )
      invalid()
    if (request.cursor !== undefined && !string(request.cursor, 12_000)) invalid()
  } else if ([channels.detail, channels.import].includes(channel as typeof channels.detail)) {
    allowed = [...allowed, 'workId']
    if (!string(request.workId, 12_000)) invalid()
    if (channel === channels.import) {
      allowed = [...allowed, 'chapterIds', 'acquisitionId']
      if (
        request.chapterIds !== undefined &&
        (!Array.isArray(request.chapterIds) ||
          !request.chapterIds.length ||
          request.chapterIds.length > 20 ||
          request.chapterIds.some((id) => !string(id, 1000)))
      )
        invalid()
      if (request.acquisitionId !== undefined && !string(request.acquisitionId, 12_000)) invalid()
    }
  } else if (channel !== channels.check) invalid()
  if (Object.keys(request).some((key) => !allowed.includes(key))) invalid()
}
