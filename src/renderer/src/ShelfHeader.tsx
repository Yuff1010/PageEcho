import type { Ref } from 'react'
import { Icon } from './Icons'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import type { ShelfLayout } from './library-shelf'
import './shelf-header.css'

export function ShelfHeader({
  ebook,
  searchOpen,
  query,
  searchRef,
  importRef,
  busy,
  disabled,
  onOpenSearch,
  onQuery,
  onCloseSearch,
  onImport,
  onImportFolder,
}: {
  ebook: boolean
  searchOpen: boolean
  query: string
  searchRef: Ref<HTMLInputElement>
  importRef: Ref<HTMLButtonElement>
  busy: boolean
  disabled: boolean
  onOpenSearch: () => void
  onQuery: (query: string) => void
  onCloseSearch: () => void
  onImport: () => void
  onImportFolder: () => void
}) {
  return (
    <header className="topbar shelf-header">
      <h1>我的书架</h1>
      <div className="header-actions">
        {searchOpen ? (
          <div className="library-search">
            <Icon name="search" />
            <input
              ref={searchRef}
              aria-label="搜索书架"
              placeholder="搜索书名…"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCloseSearch()
              }}
            />
            <Tooltip content="清除搜索 · Esc">
              <button className="icon-button" aria-label="清除搜索" onClick={onCloseSearch}>
                <Icon name="close" />
              </button>
            </Tooltip>
          </div>
        ) : (
          <Tooltip content="搜索书架 · Ctrl+K">
            <button
              className="icon-button search-trigger"
              aria-label="搜索书架"
              title="搜索书架 · Ctrl+K"
              onClick={onOpenSearch}
            >
              <Icon name="search" />
            </button>
          </Tooltip>
        )}
        <div className="import-button-group">
          <Tooltip content={ebook ? '导入电子书 · TXT / EPUB' : '导入音频文件'}>
            <button
              className="secondary-button audio-import"
              ref={importRef}
              data-shelf-import
              aria-label={ebook ? '导入电子书' : busy ? '正在处理…' : '选择音频文件'}
              disabled={disabled}
              onClick={onImport}
            >
              {busy ? <span className="loading-ring" /> : <Icon name="plus" />}
            </button>
          </Tooltip>
          <Popover
            label="更多导入方式"
            icon="chevron"
            className="import-options"
            disabled={disabled}
          >
            <button role="menuitem" onClick={ebook ? onImport : onImportFolder}>
              <Icon name={ebook ? 'book' : 'folder'} />
              {ebook ? '选择 TXT / EPUB' : '导入文件夹'}
            </button>
          </Popover>
        </div>
      </div>
    </header>
  )
}

export function ShelfControls({
  ebook,
  sort,
  layout,
  onShelf,
  onSort,
  onLayout,
}: {
  ebook: boolean
  sort: string
  layout: ShelfLayout
  onShelf: (shelf: 'library' | 'ebook') => void
  onSort: (sort: string) => void
  onLayout: (layout: ShelfLayout) => void
}) {
  return (
    <div className="library-heading shelf-controls">
      <nav className="library-tabs" aria-label="书籍类型">
        <Tooltip content="有声书">
          <button
            className={!ebook ? 'active' : ''}
            aria-label="有声书"
            aria-current={!ebook ? 'page' : undefined}
            onClick={() => onShelf('library')}
          >
            <Icon name="headphones" />
          </button>
        </Tooltip>
        <Tooltip content="电子书">
          <button
            className={ebook ? 'active' : ''}
            aria-label="电子书"
            aria-current={ebook ? 'page' : undefined}
            onClick={() => onShelf('ebook')}
          >
            <Icon name="book" />
          </button>
        </Tooltip>
      </nav>
      <div className="library-options">
        <div className="shelf-sort">
          <Icon name="sort" />
          <Tooltip
            content={`排序 · ${{ added: '最近添加', recent: '最近使用', title: '书名排序', played: '已有进度' }[sort] ?? '最近添加'}`}
          >
            <select
              aria-label="书架排序"
              value={sort}
              onChange={(event) => onSort(event.target.value)}
            >
              <option value="added">最近添加</option>
              <option value="recent">最近使用</option>
              <option value="title">书名排序</option>
              <option value="played">已有进度</option>
            </select>
          </Tooltip>
        </div>
        <Popover label="书架选项" icon={layout === 'grid' ? 'grid' : 'list'}>
          <button role="menuitem" aria-pressed={layout === 'grid'} onClick={() => onLayout('grid')}>
            <Icon name="grid" />
            网格视图{layout === 'grid' && <Icon name="check" />}
          </button>
          <button role="menuitem" aria-pressed={layout === 'list'} onClick={() => onLayout('list')}>
            <Icon name="list" />
            列表视图{layout === 'list' && <Icon name="check" />}
          </button>
        </Popover>
      </div>
    </div>
  )
}
