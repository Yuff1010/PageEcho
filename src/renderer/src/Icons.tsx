import type { ReactNode } from 'react'

export type IconName =
  | 'library'
  | 'clock'
  | 'headphones'
  | 'book'
  | 'globe'
  | 'settings'
  | 'plus'
  | 'folder'
  | 'search'
  | 'grid'
  | 'list'
  | 'arrow'
  | 'chevron'
  | 'play'
  | 'pause'
  | 'previous'
  | 'next'
  | 'rewind'
  | 'forward'
  | 'volume'
  | 'bookmark'
  | 'close'
  | 'check'
  | 'leaf'
  | 'logout'
  | 'music'
  | 'more'
  | 'info'
  | 'fullscreen'
  | 'focus'
  | 'transcript'
  | 'follow'
  | 'link'
  | 'stop'
  | 'sort'
  | 'upload'

const paths: Record<IconName, ReactNode> = {
  transcript: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 10h4M14 10h3M7 14h3M13 14h4" />
    </>
  ),
  follow: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  link: (
    <>
      <path d="m9 15 6-6M7.5 13.5l-2 2a3.5 3.5 0 0 0 5 5l4-4a3.5 3.5 0 0 0 0-5M16.5 10.5l2-2a3.5 3.5 0 0 0-5-5l-4 4a3.5 3.5 0 0 0 0 5" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
  sort: (
    <>
      <path d="M5 3v18m-3-3 3 3 3-3M13 21V3m-3 3 3-3 3 3M18 7h3M18 12h3M18 17h3" />
    </>
  ),
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />,
  focus: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  fullscreen: <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  library: (
    <>
      <path d="M4 4h4v16H4zM11 4h4v16h-4zM17 5l3-1 4 15-3 1z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  headphones: (
    <>
      <path d="M4 13v-2a8 8 0 0 1 16 0v2M4 12H3v7h4v-7H4ZM20 12h1v7h-4v-7h3Z" />
    </>
  ),
  book: (
    <>
      <path d="M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1ZM12 5v15" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-.7 2.1-2 .9-2.1-.4-2 3.4 1.4 1.7v2.6L2.2 15l2 3.4 2.1-.4 2 .9L9 21h4l.7-2.1 2-.9 2.1.4 2-3.4-1.4-1.7v-2.6L19.8 9l-2-3.4-2.1.4-2-.9L13 3Z" />
      <circle cx="11" cy="12" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3 7V5h6l2 2h10v13H3ZM3 7h18" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  grid: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
  list: <path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  play: <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
  pause: <path d="M7 5h4v14H7zM15 5h4v14h-4z" fill="currentColor" stroke="none" />,
  previous: (
    <>
      <path d="M5 5v14" />
      <path d="m19 5-10 7 10 7Z" fill="currentColor" stroke="none" />
    </>
  ),
  next: (
    <>
      <path d="M19 5v14" />
      <path d="m5 5 10 7-10 7Z" fill="currentColor" stroke="none" />
    </>
  ),
  rewind: (
    <>
      <path d="M5 8a8 8 0 1 1-1 7M5 3v5h5" />
      <text x="8" y="16" fontSize="9" stroke="none" fill="currentColor" fontWeight="600">
        15
      </text>
    </>
  ),
  forward: (
    <>
      <path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5" />
      <text x="8" y="16" fontSize="9" stroke="none" fill="currentColor" fontWeight="600">
        15
      </text>
    </>
  ),
  volume: (
    <>
      <path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" />
    </>
  ),
  bookmark: <path d="M6 3h12v18l-6-4-6 4Z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  leaf: (
    <>
      <path d="M20 3C8 1 1 9 6 16s16 0 14-13ZM5 20 16 9" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H4v16h6M9 12h12m-5-5 5 5-5 5" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13M9 9l11-2" />
      <ellipse cx="6" cy="18" rx="3" ry="2.5" />
      <ellipse cx="17" cy="16" rx="3" ry="2.5" />
    </>
  ),
}

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

export function BookCover({
  title,
  id,
  small = false,
}: {
  title: string
  id: string
  small?: boolean
}) {
  const tone = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5
  return (
    <div
      className={`book-cover cover-tone-${tone}${small ? ' cover-small' : ''}`}
      aria-hidden="true"
    >
      <span className="cover-label">READ & LISTEN</span>
      <span className="cover-book-title">
        {title.replace(/\.(mp3|m4a|m4b|wav|ogg|flac|txt|epub)$/i, '')}
      </span>
      <svg viewBox="0 0 200 130" fill="none">
        <circle cx="145" cy="37" r="24" fill="currentColor" opacity=".4" />
        <path
          d="M-20 120 62 35l57 68 37-39 65 66M-20 133 60 75l60 58"
          stroke="currentColor"
          strokeWidth="1"
          opacity=".7"
        />
        <path d="M10 125h180M30 119h140" stroke="currentColor" opacity=".4" />
      </svg>
      <span className="cover-edition">声音里的另一种生活</span>
    </div>
  )
}
