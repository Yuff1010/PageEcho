import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookSummary, LibraryOverview, ReadingBookSummary } from '../../shared/library'
import type {
  BookLink,
  LinkedListeningCandidate,
  ResolveLinkedListeningResult,
} from '../../shared/book-links'
import { player } from './player'
import { storeReaderAnchor } from './reader-layout'
import { parseAppRoute } from './app-navigation'
import './book-connections.css'

type LinkTarget = {
  bookId?: string
  readingBookId?: string
  position?: number
  readAfter?: boolean
}
const titleKey = (title: string) =>
  title
    .replace(/\.(txt|epub|mp3|m4a|m4b|wav|flac)$/i, '')
    .replace(/[\s\p{P}]/gu, '')
    .toLocaleLowerCase()

export function useBookConnections(
  state: LibraryOverview | null,
  read: (id: string) => void,
  listen: () => void,
) {
  const [links, setLinks] = useState<BookLink[]>([])
  const [target, setTarget] = useState<LinkTarget | null>(null)
  const [choice, setChoice] = useState<{
    readingBookId: string
    position: number
    result: ResolveLinkedListeningResult
    links: BookLink[]
  } | null>(null)
  const [notice, setNotice] = useState<{ id: number; bookId: string; message: string } | null>(null)
  const noticeSerial = useRef(0)
  const [error, setError] = useState('')
  const currentRequest = useRef(0)
  const refresh = useCallback(async () => {
    const result = await window.desktop.getBookLinks()
    if (!result.ok) throw new Error(result.error.message)
    setLinks(result.value)
    return result.value
  }, [])
  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch(() => {})
  }, [refresh, state?.books.length])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current))
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    const cancel = () => {
      currentRequest.current++
      setChoice(null)
      setTarget(null)
      const route = parseAppRoute(window.location.hash)
      setNotice((current) =>
        route.view === 'reader' && route.bookId === current?.bookId ? current : null,
      )
    }
    window.addEventListener('hashchange', cancel)
    return () => window.removeEventListener('hashchange', cancel)
  }, [])

  async function choose(
    candidate: LinkedListeningCandidate,
    context: { readingBookId: string; position: number },
  ) {
    const request = ++currentRequest.current
    const origin = window.location.hash
    setError('')
    const verified = await window.desktop.resolveLinkedListening({
      ...context,
      bookId: candidate.bookId,
    })
    if (request !== currentRequest.current || window.location.hash !== origin) return
    if (!verified.ok) {
      setError(verified.error.message)
      return
    }
    if (
      !verified.value.candidates.some(
        (next) =>
          next.episodeId === candidate.episodeId &&
          next.audioHash === candidate.audioHash &&
          next.positionMs === candidate.positionMs &&
          next.first === candidate.first &&
          next.last === candidate.last,
      )
    ) {
      setError('同步点或书籍关联已经更新，请重新选择声音位置。')
      const latestLinks = await refresh()
      if (request === currentRequest.current)
        setChoice({
          ...context,
          result: verified.value,
          links: latestLinks.filter((link) => link.readingBookId === context.readingBookId),
        })
      return
    }
    setChoice(null)
    const current = player.getSnapshot()
    if (
      current.episode?.id === candidate.episodeId &&
      current.episode.contentHash === candidate.audioHash &&
      current.ready
    ) {
      player.seek(candidate.positionMs)
      await player.play(true)
    } else await player.load(candidate.episodeId, true, false, candidate)
    if (request !== currentRequest.current || window.location.hash !== origin) return
    try {
      localStorage.setItem(`ralb:companion:source:${candidate.bookId}`, 'original')
    } catch {
      /* Reading remains usable without preferences. */
    }
    listen()
  }
  async function listenAt(readingBookId: string, position?: number) {
    if (position === undefined) {
      listen()
      return
    }
    const request = ++currentRequest.current
    setError('')
    try {
      const currentLinks = await refresh()
      if (request !== currentRequest.current) return
      const linked = currentLinks.filter((item) => item.readingBookId === readingBookId)
      if (!linked.length) {
        setTarget({ readingBookId, position })
        return
      }
      const result = await window.desktop.resolveLinkedListening({ readingBookId, position })
      if (request !== currentRequest.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.status === 'mapped' && result.value.candidates[0])
        await choose(result.value.candidates[0], { readingBookId, position })
      else setChoice({ readingBookId, position, result: result.value, links: linked })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法定位声音，请重试。')
    }
  }
  async function readAtPlayback() {
    const current = player.getSnapshot()
    if (!current.episode) return
    const request = ++currentRequest.current
    const origin = window.location.hash
    const positionMs = Math.max(0, Math.floor(player.getPosition()))
    const valid = () =>
      request === currentRequest.current &&
      window.location.hash === origin &&
      player.getSnapshot().episode?.id === current.episode?.id &&
      player.getSnapshot().episode?.contentHash === current.episode?.contentHash
    setError('')
    try {
      const original = await window.desktop.getOriginalState({
        episodeId: current.episode.id,
        audioHash: current.episode.contentHash,
      })
      if (!valid()) return
      if (!original.ok) throw new Error(original.error.message)
      if (!original.value.info) {
        setTarget({ bookId: current.episode.bookId, readAfter: true })
        return
      }
      const result = await window.desktop.openLinkedReading({
        episodeId: current.episode.id,
        audioHash: current.episode.contentHash,
        positionMs,
      })
      if (!valid()) return
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.position !== null)
        storeReaderAnchor(result.value.book.id, { ordinal: result.value.position, offset: 0 })
      await refresh()
      if (!valid()) return
      setNotice({
        id: ++noticeSerial.current,
        bookId: result.value.book.id,
        message:
          result.value.status === 'mapped'
            ? '已定位到当前声音对应的原文。'
            : '当前声音尚未匹配，已打开上次阅读位置。',
      })
      read(result.value.book.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法打开对应电子书，请重试。')
    }
  }
  const dialogs = (
    <>
      {target && (
        <BookLinkDialog
          key={`${target.bookId}:${target.readingBookId}`}
          books={state?.books ?? []}
          links={links}
          target={target}
          close={() => {
            currentRequest.current++
            setTarget(null)
          }}
          linked={async (removed) => {
            const next = target
            setTarget(null)
            await refresh()
            if (removed) return
            if (next.readAfter) await readAtPlayback()
            else if (next.readingBookId && next.position !== undefined)
              await listenAt(next.readingBookId, next.position)
          }}
        />
      )}
      {choice && (
        <ListeningChoice
          books={state?.books ?? []}
          value={choice}
          close={() => {
            currentRequest.current++
            setChoice(null)
          }}
          choose={(candidate) =>
            choose(candidate, {
              readingBookId: choice.readingBookId,
              position: choice.position,
            }).catch(() => setError('暂时无法校验声音位置，请重试。'))
          }
          openBook={async (id) => {
            const book = state?.books.find((item) => item.id === id)
            const episodeId = book?.currentEpisodeId ?? book?.firstEpisodeId
            if (!episodeId) return
            setChoice(null)
            listen()
            if (player.getSnapshot().episode?.id !== episodeId) await player.load(episodeId, false)
            await player.prepareSubtitles(true)
          }}
        />
      )}
      {error && (
        <div className="book-connection-message" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
    </>
  )
  return {
    links,
    dialogs,
    notice,
    dismissNotice: () => setNotice(null),
    link: (value: LinkTarget) => {
      setTarget(value)
      void refresh().catch(() => {})
    },
    readAtPlayback,
    listenAt,
    refresh,
  }
}

function BookLinkDialog({
  books,
  links,
  target,
  close,
  linked,
}: {
  books: BookSummary[]
  links: BookLink[]
  target: LinkTarget
  close: () => void
  linked: (removed?: boolean) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [ebooks, setEbooks] = useState<ReadingBookSummary[]>([])
  const [audioId, setAudioId] = useState(target.bookId ?? '')
  const [ebookId, setEbookId] = useState(target.readingBookId ?? '')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const initial = useRef(target)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    let alive = true
    void window.desktop
      .getReadingSummaries()
      .then((result) => {
        if (!alive) return
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setEbooks(result.value)
        const known = links.find(
          (link) =>
            link.audioBookId === initial.current.bookId ||
            link.readingBookId === initial.current.readingBookId,
        )
        if (!initial.current.bookId && known) setAudioId(known.audioBookId)
        if (!initial.current.readingBookId && known) setEbookId(known.readingBookId)
      })
      .catch(() => {
        if (alive) setError('无法读取电子书书架，请重试。')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [links])
  const audio = books.find((book) => book.id === audioId)
  const ebook = ebooks.find((book) => book.id === ebookId)
  const candidates = target.bookId
    ? ebooks.filter((book) => titleKey(book.title) === titleKey(audio?.title ?? ''))
    : books.filter((book) => titleKey(book.title) === titleKey(ebook?.title ?? ''))
  const existing = links.find((link) => link.audioBookId === audioId)
  async function save() {
    setBusy(true)
    setError('')
    try {
      const result = await window.desktop.linkReadingBook({
        bookId: audioId,
        readingBookId: ebookId,
      })
      if (!result.ok) throw new Error(result.error.message)
      await linked()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '关联未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="listening-dialog book-link-dialog"
      aria-label="关联有声书与电子书"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <h2>把听书和阅读连起来</h2>
      <p>
        选择同一作品的有声书与电子书。完成后，电子书将作为伴读原文，有同步点的位置可以双向切换。
      </p>
      {loading ? (
        <p role="status">正在读取书架…</p>
      ) : (
        <>
          <label>
            有声书
            <select
              aria-label="关联有声书"
              value={audioId}
              disabled={!!target.bookId || busy}
              onChange={(event) => setAudioId(event.target.value)}
            >
              <option value="">选择有声书</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            电子书
            <select
              aria-label="关联电子书"
              value={ebookId}
              disabled={!!target.readingBookId || busy}
              onChange={(event) => setEbookId(event.target.value)}
            >
              <option value="">选择电子书</option>
              {ebooks.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.title}
                </option>
              ))}
            </select>
          </label>
          {!!candidates.length && (
            <div className="book-link-suggestions">
              <p>书架中有同名作品，确认版本后可选用：</p>
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    target.bookId ? setEbookId(candidate.id) : setAudioId(candidate.id)
                  }
                >
                  {candidate.title}
                </button>
              ))}
            </div>
          )}
          {!target.readingBookId && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  const result = await window.desktop.importReadingBook()
                  if (!result.ok) throw new Error(result.error.message)
                  if (!result.value.canceled) {
                    const { chapters, ...metadata } = result.value.book
                    const added: ReadingBookSummary = { ...metadata, chapterCount: chapters.length }
                    setEbooks((current) => [
                      ...current.filter((item) => item.id !== added.id),
                      added,
                    ])
                    setEbookId(added.id)
                  }
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : '导入失败，请重试。')
                } finally {
                  setBusy(false)
                }
              }}
            >
              导入 TXT / EPUB 电子书
            </button>
          )}
          {existing && existing.readingBookId !== ebookId && ebookId && (
            <p>本次选择会更换这本有声书使用的原文；旧版本的校正记录会保留。</p>
          )}
        </>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="import-actions">
        <button
          className="primary-button"
          disabled={busy || loading || !audioId || !ebookId}
          onClick={() => void save()}
        >
          {busy ? '正在关联…' : '关联并用于伴读'}
        </button>
        <button className="secondary-button" disabled={busy} onClick={close}>
          取消
        </button>
        {existing && (
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                const result = await window.desktop.unlinkReadingBook({ bookId: audioId })
                if (!result.ok) throw new Error(result.error.message)
                await linked(true)
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : '解除关联未完成，请重试。')
              } finally {
                setBusy(false)
              }
            }}
          >
            解除原文关联
          </button>
        )}
      </div>
    </dialog>
  )
}

function ListeningChoice({
  value,
  books,
  close,
  choose,
  openBook,
}: {
  value: { result: ResolveLinkedListeningResult; links: BookLink[] }
  books: BookSummary[]
  close: () => void
  choose: (candidate: LinkedListeningCandidate) => Promise<void>
  openBook: (id: string) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="listening-dialog book-link-dialog"
      aria-label="选择对应的声音位置"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <h2>
        {value.result.status === 'ambiguous'
          ? '这段文字对应多个声音位置'
          : '这段文字还没有声音同步点'}
      </h2>
      <p>
        {value.result.status === 'ambiguous'
          ? '选择要继续收听的演播版本和片段。'
          : '可以一键准备字幕并匹配，先保留上次收听位置；准备完成前不会猜测这段文字对应的声音位置。'}
      </p>
      <ul className="book-listening-choices">
        {value.result.candidates.map((candidate) => (
          <li key={`${candidate.episodeId}:${candidate.positionMs}`}>
            <button className="secondary-button" onClick={() => void choose(candidate)}>
              {candidate.bookTitle} · {candidate.episodeTitle} ·{' '}
              {Math.floor(candidate.positionMs / 60000)}:
              {Math.floor((candidate.positionMs / 1000) % 60)
                .toString()
                .padStart(2, '0')}
            </button>
          </li>
        ))}
      </ul>
      {!value.result.candidates.length &&
        value.links.map((link) => (
          <button
            key={link.audioBookId}
            className="secondary-button"
            onClick={() => void openBook(link.audioBookId)}
          >
            准备字幕并匹配
            {value.links.length > 1 &&
              ` · ${books.find((book) => book.id === link.audioBookId)?.title ?? link.audioTitle}`}
          </button>
        ))}
      <button className="reader-button" onClick={close}>
        继续阅读
      </button>
    </dialog>
  )
}
