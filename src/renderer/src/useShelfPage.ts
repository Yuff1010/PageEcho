import { useState } from 'react'

/** Filters reset the page by identity; changing progress never resets navigation. */
export function useShelfPage<T>(items: readonly T[], key: string, size = 100) {
  const [selection, setSelection] = useState({ key: '', page: 0 })
  const pages = Math.max(1, Math.ceil(items.length / size))
  const page = selection.key === key ? Math.min(selection.page, pages - 1) : 0
  return {
    page,
    pages,
    items: items.slice(page * size, (page + 1) * size),
    setPage: (value: number) =>
      setSelection({ key, page: Math.max(0, Math.min(pages - 1, value)) }),
  }
}
