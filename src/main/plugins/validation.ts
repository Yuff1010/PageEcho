import { PLUGIN_CHANNELS } from '../../shared/plugins'
import { cleanPluginUpdateUrl } from './maintenance'
import {
  invalidPlugin,
  pluginId,
  pluginObject,
  pluginString,
  pluginUrl,
  PLUGIN_SOURCE_ID,
} from './manifest'

export function validatePluginArgs(channel: string, args: unknown[]): void {
  if (
    [PLUGIN_CHANNELS.list, PLUGIN_CHANNELS.choose, PLUGIN_CHANNELS.sourceCatalog].includes(
      channel as typeof PLUGIN_CHANNELS.list,
    )
  ) {
    if (args.length) return invalidPlugin('插件请求不接受参数。')
    return
  }
  if (args.length !== 1) return invalidPlugin('插件请求参数数量无效。')
  const value = pluginObject(args[0])
  const exact = (keys: string[]) => {
    if (Object.keys(value).some((key) => !keys.includes(key)))
      return invalidPlugin('插件请求含不支持的字段。')
  }
  const requestId = () => {
    if (typeof value.requestId !== 'string' || !/^[\w-]{1,120}$/.test(value.requestId))
      return invalidPlugin('插件请求 ID 无效。')
  }
  switch (channel) {
    case PLUGIN_CHANNELS.previewUrl:
      exact(['requestId', 'url'])
      requestId()
      pluginUrl(value.url)
      return
    case PLUGIN_CHANNELS.install:
      exact(['previewId', 'updateUrl'])
      if (!/^[a-f0-9-]{36}$/.test(String(value.previewId)))
        return invalidPlugin('插件预览 ID 无效。')
      if (value.updateUrl !== undefined && value.updateUrl !== null)
        cleanPluginUpdateUrl(value.updateUrl)
      return
    case PLUGIN_CHANNELS.setUpdateUrl:
      exact(['id', 'url'])
      pluginId(value.id)
      if (value.url !== null) cleanPluginUpdateUrl(value.url)
      return
    case PLUGIN_CHANNELS.checkUpdate:
      exact(['requestId', 'id'])
      requestId()
      pluginId(value.id)
      return
    case PLUGIN_CHANNELS.cancel:
      exact(['requestId'])
      requestId()
      return
    case PLUGIN_CHANNELS.toggle:
      exact(['id', 'enabled'])
      pluginId(value.id)
      if (typeof value.enabled !== 'boolean') return invalidPlugin('插件启停值无效。')
      return
    case PLUGIN_CHANNELS.remove:
    case PLUGIN_CHANNELS.rollback:
      exact(['id'])
      pluginId(value.id)
      return
    case PLUGIN_CHANNELS.test:
      exact(['requestId', 'id', 'sourceId', 'query'])
      requestId()
      pluginId(value.id)
      if (typeof value.sourceId !== 'string' || !PLUGIN_SOURCE_ID.test(value.sourceId))
        return invalidPlugin('插件来源 ID 无效。')
      if (value.query !== undefined) pluginString(value.query, 200, true)
      return
    default:
      return invalidPlugin('未知插件请求。')
  }
}
