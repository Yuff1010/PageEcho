import {
  isPluginSourceId,
  SourceError,
  type SourceAdapter,
  type SourceId,
} from '../../shared/sources'
import { sourceMediaUrl, sourcePageUrl } from './ting13'
import { librivoxMediaUrl, librivoxPageUrl } from './librivox'

export function audioSourceMediaUrl(
  sourceId: SourceId,
  value: string,
  original?: string,
  policy?: SourceAdapter['urlPolicy'],
): string {
  if (isPluginSourceId(sourceId)) {
    if (!policy) throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '来源插件未提供有效的媒体权限。')
    return policy.mediaUrl(value, original)
  }
  return sourceId === 'librivox' ? librivoxMediaUrl(value, original) : sourceMediaUrl(value)
}
export function audioSourcePageUrl(
  sourceId: SourceId,
  value: string,
  policy?: SourceAdapter['urlPolicy'],
): URL {
  if (isPluginSourceId(sourceId)) {
    if (!policy) throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '来源插件未提供有效的页面权限。')
    return policy.pageUrl(value)
  }
  return sourceId === 'librivox' ? librivoxPageUrl(value) : sourcePageUrl(value)
}
