import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { TextBookDetail, TextContinueResult } from '../../shared/text-sources'

interface SessionEntry<T> {
  value: T
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  snapshot: () => T
  set: Dispatch<SetStateAction<T>>
}
// In-memory UI state only: never persist queries, source responses or credentials to disk.
const sessions = new Map<string, SessionEntry<unknown>>()
function entryFor<T>(key: string, initial: T | (() => T)): SessionEntry<T> {
  const existing = sessions.get(key)
  if (existing) return existing as SessionEntry<T>
  const entry: SessionEntry<T> = {
    value: typeof initial === 'function' ? (initial as () => T)() : initial,
    listeners: new Set(),
    subscribe: (listener) => {
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    snapshot: () => entry.value,
    set: (action) => {
      const next = typeof action === 'function' ? (action as (value: T) => T)(entry.value) : action
      if (Object.is(next, entry.value)) return
      entry.value = next
      for (const listener of entry.listeners) listener()
    },
  }
  if (sessions.size >= 48) {
    for (const [oldKey, old] of sessions) {
      if (!old.listeners.size) {
        sessions.delete(oldKey)
        break
      }
    }
  }
  sessions.set(key, entry as SessionEntry<unknown>)
  return entry
}
export function useSourceSession<T>(key: string, initial: T | (() => T)) {
  const entry = entryFor(key, initial)
  return [useSyncExternalStore(entry.subscribe, entry.snapshot), entry.set] as const
}

export function recentSourceView<T>(views: Record<string, T>, id: string, value: T) {
  const next = { ...views }
  delete next[id]
  next[id] = value
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - 20))) delete next[old]
  return next
}

interface ReadingSessionView {
  detail?: TextBookDetail | null
  selectedChapters?: string[]
}

/** Keep restored source details accurate after a reader appends chapters off-page. */
export function updateSourceReadingSession(result: TextContinueResult) {
  for (const key of ['sources.text.views', 'sources.personal.views']) {
    const entry = sessions.get(key) as SessionEntry<Record<string, ReadingSessionView>> | undefined
    entry?.set((views) => {
      let next = views
      for (const [id, view] of Object.entries(views)) {
        const detail = view.detail
        if (!detail || detail.readingBookId !== result.book.id) continue
        const downloaded = new Set([
          ...(detail.downloadedChapterIds ?? []),
          ...result.addedChapterIds,
        ])
        const last = Math.max(detail.lastDownloadedOrder ?? -1, result.lastDownloadedOrder)
        const orders = new Map(detail.chapters.map((chapter) => [chapter.id, chapter.order]))
        if (next === views) next = { ...views }
        next[id] = {
          ...view,
          detail: { ...detail, downloadedChapterIds: [...downloaded], lastDownloadedOrder: last },
          selectedChapters: view.selectedChapters?.filter((chapterId) => {
            const order = orders.get(chapterId)
            return !downloaded.has(chapterId) && (order === undefined || order > last)
          }),
        }
      }
      return next
    })
  }
}
