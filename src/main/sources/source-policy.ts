import type { SourceId } from '../../shared/sources'
import { sourceMediaUrl, sourcePageUrl } from './ting13'
import { librivoxMediaUrl, librivoxPageUrl } from './librivox'

export function audioSourceMediaUrl(sourceId: SourceId, value: string, original?: string): string {
  return sourceId === 'librivox' ? librivoxMediaUrl(value, original) : sourceMediaUrl(value)
}
export function audioSourcePageUrl(sourceId: SourceId, value: string): URL {
  return sourceId === 'librivox' ? librivoxPageUrl(value) : sourcePageUrl(value)
}
