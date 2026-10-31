import { useState } from 'react'
import { BookCover } from './Icons'
import { Tooltip } from './Tooltip'
import { SOURCE_COVER_PREFIX } from '../../shared/source-covers'
import './source-book-result.css'

/** Only main-process-registered cover candidates may reach an image element. */
function localCover(value?: string | null): string | null {
  return value &&
    value.startsWith(SOURCE_COVER_PREFIX) &&
    /^[a-zA-Z0-9_-]+$/.test(value.slice(SOURCE_COVER_PREFIX.length))
    ? value
    : null
}

export function SourceBookImage({
  id,
  title,
  coverUrl,
}: {
  id: string
  title: string
  coverUrl?: string | null
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const image = localCover(coverUrl)
  return (
    <span
      className="source-book-image"
      data-cover-state={image && failed !== image ? 'original' : 'fallback'}
    >
      {image && failed !== image ? (
        <img
          src={image}
          alt={`${title}的封面`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(image)}
        />
      ) : (
        <BookCover title={title} id={id} />
      )}
    </span>
  )
}

export function SourceBookResult({
  id,
  title,
  coverUrl,
  credit,
  description,
  label,
  disabled,
  onOpen,
}: {
  id: string
  title: string
  coverUrl?: string | null
  credit?: string | null
  description?: string | null
  label: string
  disabled: boolean
  onOpen: () => void
}) {
  return (
    <li className="source-book-result">
      <Tooltip content={label}>
        <button
          type="button"
          className="source-book-open"
          aria-label={label}
          disabled={disabled}
          onClick={onOpen}
        >
          <SourceBookImage id={id} title={title} coverUrl={coverUrl} />
        </button>
      </Tooltip>
      <div className="source-book-result-copy">
        <h3>{title}</h3>
        {!!credit && <p className="source-credit">{credit}</p>}
        {!!description && <p className="source-description">{description}</p>}
      </div>
    </li>
  )
}
