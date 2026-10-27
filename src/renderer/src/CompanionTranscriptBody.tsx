import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  locateTranscript,
  type StoredTranscript,
  type TranscriptPosition,
} from '../../shared/transcript'
import {
  classifyRegion,
  REGION_LABELS,
  regionKey,
  regionReadingRows,
  type ReadingRow,
} from '../../shared/regions'
import {
  RegionEditor,
  RegionManager,
  type RegionDraft,
  type useTranscriptRegions,
} from './RegionEditor'
import { player } from './player'
import { TranscriptSearch } from './TranscriptSearch'
import type { TranscriptSearchHit } from '../../shared/transcript-search'
import { companionProseBlocks, companionSentenceSpace } from './companion-prose'
import type { ReaderSettings } from './reader-settings'
import { ReaderFooter, ReaderAction } from './ReaderToolbar'
import { ReaderDockSlot } from './ReaderDock'
import { CompanionReadingViewport } from './CompanionReadingViewport'
import { useCompanionPagination } from './useCompanionPagination'

const PAGE_SIZE = 60
export interface ReadingSettings extends ReaderSettings {
  foldRegions: boolean
}

const STATUS_LABELS: Record<TranscriptPosition['status'], string> = {
  sentence: '当前句已定位',
  pause: '句间停顿 · 已覆盖区间暂无句子',
  uncovered: '此处尚无文稿 · 未覆盖区间',
  ended: '播放已结束',
}

export function ReadingBody({
  stored,
  visible,
  settings,
  regions,
  durationMs,
  editable,
  editStructure,
  saveEdit,
  proofreading,
  searchOpen,
  onSearchClose,
  episodeTitle,
}: {
  proofreading: boolean
  searchOpen: boolean
  onSearchClose: () => void
  episodeTitle?: string
  stored: StoredTranscript
  visible: boolean
  settings: ReadingSettings
  regions: ReturnType<typeof useTranscriptRegions>
  durationMs: number | null
  editable: boolean
  editStructure: (id: string) => void
  saveEdit: (id: string, text: string, revision: number) => Promise<boolean>
}) {
  const document = stored.document
  const getLocation = useCallback(() => {
    const state = player.getSnapshot()
    if (state.episode?.id !== stored.episodeId || state.episode.contentHash !== document.audioHash)
      return 'uncovered:-1:0|'
    const position = player.getPosition()
    const value = locateTranscript(document, position, state.durationMs)
    const current = classifyRegion(regions.data?.regions ?? [], {
      startMs: Math.floor(position),
      endMs: Math.floor(position) + 1,
    }).complete
    return `${value.status}:${value.index}:${value.anchor}|${current ? regionKey(current) : ''}`
  }, [stored.episodeId, document, regions.data])
  const location = useSyncExternalStore(player.subscribeClock, getLocation)
  const [timeline, activeRegionKey = ''] = location.split('|')
  const [status, indexText, anchorText] = timeline!.split(':')
  const activeIndex = Number(indexText)
  const anchor = Number(anchorText)
  const [following, setFollowing] = useState(true)
  const followingIntent = useRef(true)
  const [browsedPage, setBrowsedPage] = useState(0)
  const [editing, setEditing] = useState<{ id: string; text: string; revision: number } | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [marking, setMarking] = useState<{ id: string; draft: RegionDraft } | null>(null)
  const [expandedRegions, setExpandedRegions] = useState<ReadonlySet<string>>(new Set())
  const [searchHit, setSearchHit] = useState<(TranscriptSearchHit & { revision: number }) | null>(
    null,
  )
  const hit = searchHit?.revision === stored.revision ? searchHit : null
  const pageCount = Math.max(1, Math.ceil(document.segments.length / PAGE_SIZE))
  const page = following
    ? Math.min(pageCount - 1, Math.floor(anchor / PAGE_SIZE))
    : Math.min(pageCount - 1, browsedPage)
  const start = page * PAGE_SIZE
  const segments = useMemo(
    () => document.segments.slice(start, start + PAGE_SIZE),
    [document, start],
  )
  const rows = useMemo(
    () =>
      regionReadingRows(
        segments,
        regions.data?.regions ?? [],
        settings.foldRegions,
        expandedRegions,
      ),
    [segments, regions.data, settings.foldRegions, expandedRegions],
  )
  const prose = useMemo(() => companionProseBlocks(rows, segments), [rows, segments])
  const pagination = useCompanionPagination({
    settings,
    visible,
    contentKey: `${stored.id}:${stored.revision}:${start}:${proofreading}:${[...expandedRegions].join(',')}:${editing?.id ?? ''}`,
    firstOrdinal: start,
    lastOrdinal: start + segments.length - 1,
    total: document.segments.length,
    onManualBrowse: pauseFollowing,
    onBoundary: (ordinal) => browse(Math.floor(ordinal / PAGE_SIZE)),
  })
  const { viewport, reveal } = pagination
  const searchPanel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!searchOpen || !visible) return
    const panel = searchPanel.current
    const details = panel?.querySelector<HTMLDetailsElement>('.transcript-search')
    if (details) details.open = true
    panel?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [searchOpen, visible, stored.id, stored.revision])
  useEffect(() => {
    if (!following || !visible || !followingIntent.current) return
    const current = rows.find(
      (row) => row.type === 'region' && activeRegionKey === regionKey(row.region),
    )
    const ordinal = current ? start + current.index : activeIndex
    if (ordinal >= 0) reveal(ordinal)
  }, [
    following,
    visible,
    activeIndex,
    activeRegionKey,
    start,
    rows,
    settings,
    proofreading,
    reveal,
  ])
  useEffect(() => {
    if (!hit || following || !visible) return
    reveal(hit.first, true)
  }, [hit, following, visible, start, rows, settings, proofreading, reveal])
  function pauseFollowing() {
    followingIntent.current = false
    setBrowsedPage(page)
    setFollowing(false)
  }
  function browse(next: number) {
    followingIntent.current = false
    setBrowsedPage(Math.max(0, Math.min(pageCount - 1, next)))
    setFollowing(false)
  }
  function seek(startMs: number) {
    followingIntent.current = true
    setSearchHit(null)
    player.seek(startMs)
    setFollowing(true)
  }
  function beginMark(id: string, draft: RegionDraft) {
    regions.clearError()
    setEditing(null)
    pauseFollowing()
    setMarking({ id, draft })
  }

  function closeSearch() {
    onSearchClose()
    requestAnimationFrame(() => viewport.current?.focus({ preventScroll: true }))
  }
  const keyboardSentence =
    rows.find((row) => row.type === 'sentence' && start + row.index === activeIndex)?.index ??
    rows.find((row) => row.type === 'sentence')?.index
  function sentenceElement(index: number) {
    const segment = segments[index]!
    const attributes = {
      className: 'transcript-sentence',
      'aria-current': start + index === activeIndex ? ('true' as const) : undefined,
      'data-segment-id': segment.id,
      'data-search-hit':
        hit && start + index >= hit.first && start + index <= hit.last
          ? ('true' as const)
          : undefined,
      onClick: () => {
        if (!window.getSelection()?.toString()) seek(segment.startMs)
      },
    }
    const content = (
      <>
        <span className="sentence-number" aria-hidden="true" hidden={!proofreading}>
          {start + index + 1}
        </span>
        <span className="transcript-sentence-text" data-sentence={start + index}>
          {segment.text}
        </span>
      </>
    )
    return proofreading ? (
      <button {...attributes} type="button">
        {content}
      </button>
    ) : (
      <span
        {...attributes}
        role="button"
        tabIndex={index === keyboardSentence ? 0 : -1}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          seek(segment.startMs)
        }}
      >
        {content}
      </span>
    )
  }
  function regionContent(row: Extract<ReadingRow, { type: 'region' }>) {
    const active = activeRegionKey === regionKey(row.region)
    return (
      <>
        <div className="folded-region-heading" aria-current={active ? 'true' : undefined}>
          <span data-sentence={start + row.index}>
            {REGION_LABELS[row.region.kind]} · 本页 {row.lastIndex - row.index + 1} 句已折叠
            {active ? ' · 当前播放位置' : ''}
          </span>
          <button
            className="text-button"
            aria-label={`展开${REGION_LABELS[row.region.kind]}片段`}
            onClick={() => {
              pauseFollowing()
              setExpandedRegions((previous) => new Set(previous).add(regionKey(row.region)))
            }}
          >
            展开文字
          </button>
          <button
            className="text-button"
            aria-label={`跳到${REGION_LABELS[row.region.kind]}片段`}
            onClick={() => seek(segments[row.index]!.startMs)}
          >
            定位
          </button>
        </div>
        {proofreading && (
          <p>
            原音频 {row.region.startMs / 1000}–{row.region.endMs / 1000} 秒 · 播放照常继续
          </p>
        )}
      </>
    )
  }
  function sentenceTools(index: number) {
    const segment = segments[index]!
    const annotation = classifyRegion(regions.data?.regions ?? [], segment)
    return (
      <>
        {annotation.kinds.length > 0 && (
          <p className="region-label">
            {annotation.kinds.map((kind) => REGION_LABELS[kind]).join(' / ')}
            {!annotation.complete ? ' · 与标注边界部分重叠，保持展开' : ''}
            {settings.foldRegions &&
              annotation.complete &&
              expandedRegions.has(regionKey(annotation.complete)) && (
                <button
                  className="text-button"
                  aria-label={`折叠${REGION_LABELS[annotation.complete.kind]}片段`}
                  onClick={() => {
                    pauseFollowing()
                    setExpandedRegions((previous) => {
                      const next = new Set(previous)
                      next.delete(regionKey(annotation.complete!))
                      return next
                    })
                  }}
                >
                  折叠文字
                </button>
              )}
          </p>
        )}
        <div className="sentence-actions">
          <button
            className="sentence-mark text-button"
            disabled={!regions.data}
            aria-label={`标注第 ${start + index + 1} 句`}
            onClick={() => {
              beginMark(segment.id, {
                startMs: segment.startMs,
                endMs: segment.endMs,
                kind: annotation.complete?.kind ?? null,
                revision: regions.data!.revision,
              })
            }}
          >
            标注
          </button>
          {editable && (
            <>
              <button
                className="sentence-edit text-button"
                aria-label={`编辑第 ${start + index + 1} 句`}
                onClick={() => {
                  setEditing({ id: segment.id, text: segment.text, revision: stored.revision })
                  setMarking(null)
                  pauseFollowing()
                }}
              >
                纠错
              </button>
              <button
                className="sentence-edit text-button"
                aria-label={`结构编辑第 ${start + index + 1} 句`}
                onClick={() => {
                  setEditing(null)
                  setMarking(null)
                  pauseFollowing()
                  editStructure(segment.id)
                }}
              >
                编辑
              </button>
            </>
          )}
        </div>
        {editing?.id === segment.id && (
          <form
            className="sentence-editor"
            onSubmit={(event) => {
              event.preventDefault()
              setSaving(true)
              void saveEdit(editing.id, editing.text, editing.revision)
                .then((saved) => {
                  if (saved) setEditing(null)
                })
                .finally(() => setSaving(false))
            }}
          >
            <textarea
              aria-label="纠正这句文字"
              value={editing.text}
              maxLength={10000}
              rows={3}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
            />
            <p>保留这句的起止时间，仅支持小范围文字纠错。</p>
            <button className="secondary-button" type="submit" disabled={saving || !editable}>
              保存纠错
            </button>
            <button
              className="text-button"
              type="button"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              取消纠错
            </button>
          </form>
        )}
      </>
    )
  }

  return (
    <div className="transcript-reader companion-transcript-body" data-proofreading={proofreading}>
      {regions.error && !marking && (
        <div className="error-message" role="alert">
          {regions.error}
        </div>
      )}
      {proofreading && marking && (
        <RegionEditor
          key={`${marking.id}:${marking.draft.revision}`}
          draft={marking.draft}
          durationMs={durationMs}
          serverError={regions.error}
          save={regions.save}
          close={() => setMarking(null)}
        />
      )}
      {visible && searchOpen && (
        <aside
          className="companion-search-panel"
          aria-label="搜索伴读文稿"
          ref={searchPanel}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            closeSearch()
          }}
        >
          <div className="companion-panel-heading">
            <h2>搜索文稿</h2>
            <ReaderAction
              className="icon-button"
              onClick={closeSearch}
              label="关闭伴读搜索"
              icon="close"
            />
          </div>
          <TranscriptSearch
            key={`search:${stored.id}:${stored.revision}`}
            stored={stored}
            browse={pauseFollowing}
            locate={(result) => {
              followingIntent.current = false
              setFollowing(false)
              setBrowsedPage(Math.floor(result.first / PAGE_SIZE))
              setSearchHit({ ...result, revision: stored.revision })
              setExpandedRegions((previous) => {
                const next = new Set(previous)
                for (const region of regions.data?.regions ?? [])
                  if (region.startMs < result.endMs && region.endMs > result.startMs)
                    next.add(regionKey(region))
                return next
              })
              closeSearch()
            }}
          />
        </aside>
      )}
      <CompanionReadingViewport pagination={pagination} settings={settings} label="文稿阅读区">
        {segments.length ? (
          proofreading ? (
            <ol className="transcript-segments companion-flow-prose" start={start + 1}>
              {rows.map((row) =>
                row.type === 'region' ? (
                  <li
                    key={`region-${regionKey(row.region)}`}
                    className="folded-region"
                    data-region-kind={row.region.kind}
                  >
                    {regionContent(row)}
                  </li>
                ) : (
                  <li key={segments[row.index]!.id}>
                    {sentenceElement(row.index)}
                    {sentenceTools(row.index)}
                  </li>
                ),
              )}
            </ol>
          ) : (
            <article className="companion-prose transcript-segments companion-flow-prose">
              {page === 0 && episodeTitle && (
                <h1 className="companion-chapter-title">{episodeTitle}</h1>
              )}
              {prose.map((block) =>
                block.type === 'region' ? (
                  <div
                    key={`region-${regionKey(block.region)}`}
                    className="folded-region"
                    data-region-kind={block.region.kind}
                  >
                    {regionContent(block)}
                  </div>
                ) : (
                  <p className="companion-paragraph" key={segments[block.rows[0]!.index]!.id}>
                    {block.rows.map((row, index) => (
                      <Fragment key={segments[row.index]!.id}>
                        {index > 0 &&
                          companionSentenceSpace(
                            segments[block.rows[index - 1]!.index]!.text,
                            segments[row.index]!.text,
                          )}
                        {sentenceElement(row.index)}
                      </Fragment>
                    ))}
                  </p>
                ),
              )}
            </article>
          )
        ) : (
          <p className="reader-placeholder">此文稿没有句子。已声明的覆盖区间将显示为句间停顿。</p>
        )}
      </CompanionReadingViewport>
      <ReaderDockSlot name="navigation" active={visible}>
        <ReaderFooter className="companion-reading-footer">
          <div className="companion-reading-status reader-follow">
            {proofreading && (
              <RegionManager
                data={regions.data}
                activeKey={activeRegionKey}
                seek={seek}
                edit={(region) => {
                  beginMark('range', {
                    ...region,
                    previous: { startMs: region.startMs, endMs: region.endMs },
                    revision: regions.data!.revision,
                  })
                }}
                add={() => {
                  const startMs = Math.max(
                    0,
                    Math.min(Math.round(player.getPosition()), (durationMs ?? 3.6e10) - 1),
                  )
                  beginMark('new-range', {
                    startMs,
                    endMs: Math.min(startMs + 5000, durationMs ?? 3.6e10),
                    kind: 'advertisement',
                    revision: regions.data!.revision,
                  })
                }}
              />
            )}
            <span className="timeline-status" role="status">
              {STATUS_LABELS[status as TranscriptPosition['status']]}
            </span>
            <span className="follow-state">{following ? '跟随播放' : '自由阅读'}</span>
            {!following && (
              <ReaderAction
                className="text-button"
                onClick={() => {
                  followingIntent.current = true
                  setSearchHit(null)
                  setFollowing(true)
                }}
                label="回到当前播放位置"
                icon="follow"
              />
            )}
          </div>
          <nav className="reader-pagination" aria-label="文稿翻页">
            <ReaderAction
              className="reader-action-previous text-button"
              disabled={!pagination.canPrevious}
              onClick={() => pagination.turn(-1)}
              label="上一页"
              icon="chevron"
            />
            {settings.mode === 'pages' && (
              <label title="屏数随窗口和排版设置变化；这里只显示当前加载内容的实际屏数。">
                <input
                  type="number"
                  aria-label="文稿页码"
                  min={1}
                  max={pagination.metrics.columns}
                  value={pagination.metrics.column + 1}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (
                      Number.isInteger(value) &&
                      value >= 1 &&
                      value <= pagination.metrics.columns
                    )
                      pagination.goPage(value - 1)
                  }}
                />
                / {pagination.metrics.columns}
              </label>
            )}
            <span className="reader-window-position" data-position={pagination.location.ordinal}>
              {Math.round(
                ((pagination.location.ordinal + 1) / Math.max(1, document.segments.length)) * 100,
              )}
              %
            </span>
            <ReaderAction
              className="text-button"
              disabled={!pagination.canNext}
              onClick={() => pagination.turn(1)}
              label="下一页"
              icon="chevron"
            />
          </nav>
        </ReaderFooter>
      </ReaderDockSlot>
    </div>
  )
}
