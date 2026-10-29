import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { BookCover, Icon } from './Icons'
import { addCurrentBookmark, sleepText, type ListeningToolsSection } from './ListeningTools'
import { Popover } from './Popover'
import { player } from './player'
import { SubtitleStatus } from './UISubtitleStatus'
import { ReaderDockOutlet, useReaderDock } from './ReaderDock'
import { readerChromeVariables } from './ReaderToolbar'
import { useAppAppearance } from './app-appearance'
import { Tooltip } from './Tooltip'
import './player-chrome.css'

function time(ms: number) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${
    minutes >= 60
      ? `${Math.floor(minutes / 60)
          .toString()
          .padStart(2, '0')}:`
      : ''
  }${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function PlayerBar({
  playback,
  hidden,
  onRead,
  onTools,
  onChapters,
  reading = false,
}: {
  playback: ReturnType<typeof player.getSnapshot>
  hidden: boolean
  onRead: () => void
  onTools: (bookId: string, section?: ListeningToolsSection) => void
  onChapters: (bookId: string) => void
  reading?: boolean
}) {
  const dock = useReaderDock()
  const { resolvedTheme } = useAppAppearance()
  const [notice, setNotice] = useState('')
  const feedback =
    playback.error ||
    playback.saveError ||
    notice ||
    sleepText(playback.sleepTimer, playback.sleepRemainingMs) ||
    playback.timerNotice
  const inlineNotice =
    playback.subtitleWaiting ||
    playback.subtitleSetupNeeded ||
    playback.subtitlePreparationPhase === 'canceling' ||
    !!playback.skipNotice ||
    playback.loading
  const checkingNotice =
    playback.subtitlePreparationPhase === 'checking' &&
    !playback.subtitleWaiting &&
    !playback.subtitleSetupNeeded &&
    !playback.loading
      ? playback.subtitleNotice || '正在后台检查字幕…'
      : undefined
  const inlineNoticeText = playback.loading
    ? '正在加载音频…'
    : checkingNotice
      ? playback.skipNotice
      : playback.subtitleNotice || playback.skipNotice
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])
  async function bookmark() {
    try {
      await addCurrentBookmark()
      setNotice('书签已保存')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '书签保存失败，请重试。')
    }
  }
  const content = (
    <section
      className="player-panel"
      aria-label="播放器"
      hidden={hidden}
      data-reader-dock={reading}
      style={
        reading
          ? ({
              ...readerChromeVariables(resolvedTheme),
              '--ui-nav': resolvedTheme === 'light' ? '#FFFFFF' : '#1C2822',
              '--ui-field': resolvedTheme === 'light' ? '#F5F8F5' : '#17221C',
            } as CSSProperties)
          : undefined
      }
    >
      {reading && (
        <div className="reader-dock-row" aria-label="听读状态与控制">
          <ReaderDockOutlet name="source" />
          <ReaderDockOutlet name="activity" />
          <ReaderDockOutlet name="navigation" />
        </div>
      )}
      <div
        className="player-seek-rail"
        style={
          {
            '--player-position': `${Math.min(100, Math.max(0, playback.durationMs > 0 ? (playback.positionMs / playback.durationMs) * 100 : 0))}%`,
          } as CSSProperties
        }
      >
        <Tooltip
          content={`已播放 ${time(playback.positionMs)} / 总时长 ${time(playback.durationMs)}`}
        >
          <input
            type="range"
            aria-label="播放进度"
            min="0"
            max={Math.max(1, playback.durationMs)}
            step="1"
            value={Math.min(playback.positionMs, Math.max(1, playback.durationMs))}
            aria-valuetext={`已播放 ${time(playback.positionMs)}，总时长 ${time(playback.durationMs)}`}
            disabled={!playback.ready}
            onChange={(event) => player.seek(Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return
              const position = player.getPosition()
              const target =
                event.key === 'ArrowRight' || event.key === 'ArrowUp'
                  ? position + 5000
                  : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                    ? position - 5000
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? playback.durationMs
                        : null
              if (target === null) return
              event.preventDefault()
              player.seek(target)
            }}
          />
        </Tooltip>
      </div>
      <div className="player-heading">
        <div className="player-cover">
          {playback.episode ? (
            <BookCover title={playback.bookTitle} id={playback.episode.bookId} small />
          ) : (
            <Icon name="headphones" />
          )}
        </div>
        <div className="now-playing">
          <h2>
            <Tooltip content={playback.episode?.title ?? '选择一本书，开始收听'}>
              <span className="player-title" tabIndex={0}>
                {playback.episode?.title ?? '尚未播放'}
              </span>
            </Tooltip>
          </h2>
          <p>{playback.episode ? playback.bookTitle : '选择一本书，开始收听'}</p>
        </div>
      </div>
      <div className="player-center">
        <div className="transport">
          <Tooltip content="后退 15 秒">
            <button
              disabled={!playback.ready}
              onClick={() => player.seek(playback.positionMs - 15000)}
              aria-label="后退 15 秒"
            >
              <Icon name="rewind" />
            </button>
          </Tooltip>
          <Tooltip
            content={playback.subtitleWaiting ? '取消等待' : playback.playing ? '暂停' : '播放'}
          >
            <button
              className="play-button"
              disabled={!playback.ready}
              onClick={() =>
                playback.playing || playback.subtitleWaiting ? player.pause() : void player.play()
              }
              aria-label={
                playback.subtitleWaiting ? '取消等待' : playback.playing ? '暂停' : '播放'
              }
            >
              <Icon name={playback.playing || playback.subtitleWaiting ? 'pause' : 'play'} />
            </button>
          </Tooltip>
          <Tooltip content="前进 15 秒">
            <button
              disabled={!playback.ready}
              onClick={() => player.seek(playback.positionMs + 15000)}
              aria-label="前进 15 秒"
            >
              <Icon name="forward" />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="player-right">
        <div className="audio-settings">
          {!reading && playback.episode && (
            <SubtitleStatus
              snapshot={playback.subtitleStatus}
              rate={playback.rate}
              variant="icon"
              checkingNotice={checkingNotice}
            />
          )}
          <Tooltip content="字幕与伴读设置">
            <button
              className="icon-button player-action subtitle-settings-button"
              aria-label="字幕与伴读"
              disabled={!playback.episode}
              onClick={() => playback.episode && onTools(playback.episode.bookId, 'subtitles')}
            >
              <Icon name="settings" />
            </button>
          </Tooltip>
          {!reading && (
            <Tooltip
              content={
                playback.episode ? '打开当前音频的听书字幕' : '打开听书字幕，选择有声书开始伴读'
              }
            >
              <button
                className="icon-button player-action read-along-button"
                aria-label="伴读阅读"
                onClick={onRead}
              >
                <Icon name="book" />
              </button>
            </Tooltip>
          )}
          <Tooltip content="播放倍速">
            <select
              aria-label="播放倍速"
              value={playback.rate}
              onChange={(event) => player.setRate(Number(event.target.value))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </Tooltip>
          <Popover
            label="调整音量"
            icon="volume"
            placement="top"
            kind="group"
            className="volume-control"
          >
            <label>
              音量
              <input
                type="range"
                aria-label="音量"
                min="0"
                max="1"
                step="0.01"
                value={playback.volume}
                onChange={(event) => player.setVolume(Number(event.target.value))}
              />
              <span>{Math.round(playback.volume * 100)}%</span>
            </label>
          </Popover>
          <Popover label="播放选项" placement="top">
            <button
              role="menuitem"
              disabled={!playback.episode}
              onClick={() => void player.next(-1)}
            >
              <Icon name="previous" />
              上一集
            </button>
            <button
              role="menuitem"
              disabled={!playback.episode}
              onClick={() => void player.next(1)}
            >
              <Icon name="next" />
              下一集
            </button>
            <div className="menu-divider" />
            <button role="menuitem" disabled={!playback.ready} onClick={() => void bookmark()}>
              <Icon name="bookmark" />
              添加书签
            </button>
            <button
              role="menuitem"
              disabled={!playback.episode}
              onClick={() => onChapters(playback.episode!.bookId)}
            >
              <Icon name="list" />
              章节目录
            </button>
            <button
              role="menuitem"
              disabled={!playback.episode}
              onClick={() => onTools(playback.episode!.bookId)}
            >
              <Icon name="clock" />
              收听工具
            </button>
          </Popover>
        </div>
        <div className="player-messages">
          {feedback && (
            <div
              className={`player-dock-feedback${playback.error || playback.saveError ? ' error-message' : ''}`}
              role={playback.error || playback.saveError ? 'alert' : 'status'}
            >
              <Tooltip content={feedback}>
                <span tabIndex={0}>{feedback}</span>
              </Tooltip>
              {playback.error && playback.episode ? (
                <button onClick={() => void player.load(playback.episode!.id)}>重试播放</button>
              ) : playback.saveError ? (
                <button onClick={() => void player.save()}>重试保存</button>
              ) : notice ? (
                <button
                  className="icon-button"
                  aria-label="关闭书签提示"
                  onClick={() => setNotice('')}
                >
                  <Icon name="close" />
                </button>
              ) : null}
            </div>
          )}
          {inlineNotice && !reading && (
            <div className="player-notice player-subtitle-notice" role="status">
              <Tooltip content={inlineNoticeText}>
                <span tabIndex={0}>{inlineNoticeText}</span>
              </Tooltip>
              {playback.subtitleWaiting && (
                <button className="text-button" onClick={() => void player.play(true)}>
                  立即播放
                </button>
              )}
              {playback.subtitleSetupNeeded && playback.episode && (
                <button
                  className="text-button"
                  onClick={() => onTools(playback.episode!.bookId, 'subtitles')}
                >
                  配置字幕组件
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
  return reading && dock?.playerHost ? createPortal(content, dock.playerHost) : content
}
