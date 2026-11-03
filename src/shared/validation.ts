import type { ErrorCode } from './contracts'
import {
  isPluginSourceId,
  isSourceId,
  isSourceItemId,
  sourceQueryLimit,
  type SourceId,
} from './sources'
import { LISTENING_REVIEW_TEXT_LIMITS } from './listening-review'
import { MAX_OFFLINE_ITEMS, MAX_OFFLINE_AUDIO_BUDGET_BYTES } from './offline'
import {
  isTranscriptReplacementLiteral,
  MAX_RETIMED_SEGMENTS,
  MAX_REPLACEMENT_EPISODES,
} from './transcript-editing'

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function isSourceRequest(
  value: unknown,
): value is Record<string, unknown> & { sourceId: SourceId } {
  return typeof value === 'object' && value !== null && isSourceId(Reflect.get(value, 'sourceId'))
}

function isExactObject(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

export function validateRequest(channel: string, args: unknown[]): void {
  const [request] = args
  if (channel.startsWith('book-links:')) {
    if (channel === 'book-links:list' && args.length === 0) return
    const integer = (value: unknown, maximum: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    let valid = false
    if (args.length === 1) {
      if (channel === 'book-links:link' && isExactObject(request, 'bookId', 'readingBookId'))
        valid = isId(request.bookId) && isId(request.readingBookId)
      if (channel === 'book-links:unlink' && isExactObject(request, 'bookId'))
        valid = isId(request.bookId)
      if (
        channel === 'book-links:reading' &&
        isExactObject(request, 'episodeId', 'audioHash', 'positionMs')
      )
        valid =
          isId(request.episodeId) &&
          typeof request.audioHash === 'string' &&
          /^[a-f0-9]{64}$/.test(request.audioHash) &&
          integer(request.positionMs, 3.6e10)
      if (
        channel === 'book-links:listening' &&
        (isExactObject(request, 'readingBookId', 'position') ||
          isExactObject(request, 'readingBookId', 'position', 'bookId'))
      )
        valid =
          isId(request.readingBookId) &&
          integer(request.position, 249999) &&
          (!Object.hasOwn(request, 'bookId') || isId(request.bookId))
    }
    if (!valid) throw new AppError('INVALID_REQUEST', '书籍关联或位置请求无效，请重新选择书籍。')
    return
  }
  if (channel === 'transcription:sync') {
    if (
      args.length === 1 &&
      (isExactObject(request, 'episodeId', 'audioHash') ||
        (isExactObject(request, 'episodeId', 'audioHash', 'knownTranscript') &&
          isExactObject(request.knownTranscript, 'id', 'revision') &&
          isId(request.knownTranscript.id) &&
          Number.isSafeInteger(request.knownTranscript.revision) &&
          Number(request.knownTranscript.revision) >= 1 &&
          Number(request.knownTranscript.revision) <= Number.MAX_SAFE_INTEGER)) &&
      isId(request.episodeId) &&
      typeof request.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(request.audioHash)
    )
      return
    throw new AppError('INVALID_REQUEST', '文稿同步请求无效，请重新打开当前集。')
  }
  if (channel.startsWith('subtitle-import:')) {
    const integer = (value: unknown, minimum: number, maximum: number) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum
    const options = (value: Record<string, unknown>) =>
      ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5'].includes(
        value.encoding as string,
      ) && integer(value.offsetMs, -3.6e10, 3.6e10)
    const preview = (value: Record<string, unknown>) =>
      isId(value.token) && integer(value.revision, 1, 1e9)
    let valid = false
    if (args.length === 1) {
      if (
        channel === 'subtitle-import:preview' &&
        isExactObject(request, 'episodeId', 'audioHash', 'requestId', 'encoding', 'offsetMs')
      )
        valid =
          isId(request.episodeId) &&
          typeof request.audioHash === 'string' &&
          /^[a-f0-9]{64}$/.test(request.audioHash) &&
          isId(request.requestId) &&
          options(request)
      if (
        channel === 'subtitle-import:update' &&
        isExactObject(request, 'token', 'revision', 'encoding', 'offsetMs')
      )
        valid = preview(request) && options(request)
      if (channel === 'subtitle-import:page' && isExactObject(request, 'token', 'revision', 'page'))
        valid = preview(request) && integer(request.page, 0, 1999)
      if (
        channel === 'subtitle-import:apply' &&
        isExactObject(request, 'token', 'revision', 'commandId')
      )
        valid = preview(request) && isId(request.commandId)
      if (channel === 'subtitle-import:cancel' && isExactObject(request, 'requestId'))
        valid = isId(request.requestId)
    }
    if (!valid) throw new AppError('INVALID_REQUEST', '字幕导入请求无效，请重新选择文件并预览。')
    return
  }
  if (channel.startsWith('transcript-edit:')) {
    const integer = (v: unknown, min: number, max: number) =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
    const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
    const segment = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 128
    const target = (v: Record<string, unknown>) => isId(v.episodeId) && hash(v.audioHash)
    const revision = (v: Record<string, unknown>) => target(v) && integer(v.revision, 1, 1e9)
    const ids = (v: unknown, maximum: number, check: (value: unknown) => boolean) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.length <= maximum &&
      v.every(check) &&
      new Set(v).size === v.length
    const literal = isTranscriptReplacementLiteral
    const operation = (v: unknown) => {
      if (isExactObject(v, 'kind', 'segmentId', 'text') && v.kind === 'text')
        return (
          segment(v.segmentId) &&
          typeof v.text === 'string' &&
          !!v.text.trim() &&
          v.text.length <= 10000
        )
      if (isExactObject(v, 'kind', 'segmentId', 'offset', 'atMs') && v.kind === 'split')
        return segment(v.segmentId) && integer(v.offset, 1, 10000) && integer(v.atMs, 1, 3.6e10)
      if (isExactObject(v, 'kind', 'firstId', 'secondId', 'separator') && v.kind === 'merge')
        return (
          segment(v.firstId) &&
          segment(v.secondId) &&
          v.firstId !== v.secondId &&
          ['', ' '].includes(v.separator as string)
        )
      if (
        isExactObject(v, 'kind', 'ranges') &&
        v.kind === 'timing' &&
        Array.isArray(v.ranges) &&
        v.ranges.length > 0 &&
        v.ranges.length <= MAX_RETIMED_SEGMENTS
      ) {
        return (
          new Set(v.ranges.map((r: unknown) => (r as Record<string, unknown>)?.segmentId)).size ===
            v.ranges.length &&
          v.ranges.every(
            (r: unknown) =>
              isExactObject(r, 'segmentId', 'startMs', 'endMs') &&
              segment(r.segmentId) &&
              integer(r.startMs, 0, 3.6e10) &&
              integer(r.endMs, Number(r.startMs) + 1, 3.6e10),
          )
        )
      }
      return false
    }
    if (args.length === 1) {
      if (
        ['transcript-edit:state', 'transcript-edit:alignment-state'].includes(channel) &&
        isExactObject(request, 'episodeId', 'audioHash') &&
        target(request)
      )
        return
      if (
        channel === 'transcript-edit:change' &&
        isExactObject(request, 'episodeId', 'audioHash', 'revision', 'commandId', 'operation') &&
        revision(request) &&
        isId(request.commandId) &&
        operation(request.operation)
      )
        return
      if (
        ['transcript-edit:undo', 'transcript-edit:redo'].includes(channel) &&
        isExactObject(request, 'episodeId', 'audioHash', 'revision', 'commandId', 'historyId') &&
        revision(request) &&
        isId(request.commandId) &&
        isId(request.historyId)
      )
        return
      if (
        channel === 'transcript-edit:replacement-preview' &&
        isExactObject(
          request,
          'episodeId',
          'audioHash',
          'revision',
          'requestId',
          'scope',
          'find',
          'replacement',
        ) &&
        revision(request) &&
        isId(request.requestId) &&
        literal(request.find) &&
        literal(request.replacement) &&
        request.find !== request.replacement
      ) {
        const scope = request.scope
        if (isExactObject(scope, 'kind') && scope.kind === 'episode') return
        if (
          isExactObject(scope, 'kind', 'bookId', 'episodeIds') &&
          scope.kind === 'book' &&
          isId(scope.bookId) &&
          ids(scope.episodeIds, MAX_REPLACEMENT_EPISODES, isId)
        )
          return
      }
      if (
        channel === 'transcript-edit:replacement-page' &&
        isExactObject(request, 'token', 'page') &&
        isId(request.token) &&
        integer(request.page, 0, 199)
      )
        return
      if (
        channel === 'transcript-edit:replacement-apply' &&
        isExactObject(request, 'token', 'commandId') &&
        isId(request.token) &&
        isId(request.commandId)
      )
        return
      if (
        channel === 'transcript-edit:replacement-cancel' &&
        isExactObject(request, 'requestId') &&
        isId(request.requestId)
      )
        return
      if (
        channel === 'transcript-edit:alignment-start' &&
        isExactObject(
          request,
          'episodeId',
          'audioHash',
          'revision',
          'requestId',
          'segmentIds',
          'device',
        ) &&
        revision(request) &&
        isId(request.requestId) &&
        ids(request.segmentIds, MAX_RETIMED_SEGMENTS, segment) &&
        ['cpu', 'cuda'].includes(request.device as string)
      )
        return
      if (
        channel === 'transcript-edit:alignment-cancel' &&
        isExactObject(request, 'id') &&
        isId(request.id)
      )
        return
      if (
        channel === 'transcript-edit:alignment-apply' &&
        isExactObject(request, 'id', 'revision', 'commandId') &&
        isId(request.id) &&
        integer(request.revision, 1, 1e9) &&
        isId(request.commandId)
      )
        return
    }
    throw new AppError('INVALID_REQUEST', '字幕编辑请求无效，请刷新文稿后重试。')
  }
  if (channel.startsWith('offline:')) {
    const integer = (value: unknown, min: number, max: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    const budget = (value: unknown) => integer(value, 0, MAX_OFFLINE_AUDIO_BUDGET_BYTES)
    const selection = (value: unknown) => {
      if (isExactObject(value, 'kind') && value.kind === 'all') return true
      if (isExactObject(value, 'kind', 'from', 'to') && value.kind === 'range')
        return (
          integer(value.from, 1, 100000) &&
          integer(value.to, Number(value.from), 100000) &&
          Number(value.to) - Number(value.from) < MAX_OFFLINE_ITEMS
        )
      return (
        isExactObject(value, 'kind', 'episodeIds') &&
        value.kind === 'ids' &&
        Array.isArray(value.episodeIds) &&
        value.episodeIds.length > 0 &&
        value.episodeIds.length <= MAX_OFFLINE_ITEMS &&
        value.episodeIds.every(isId) &&
        new Set(value.episodeIds).size === value.episodeIds.length
      )
    }
    if (args.length === 1) {
      if (
        channel === 'offline:preview' &&
        isExactObject(request, 'requestId', 'bookId', 'selection', 'profile', 'audioBudgetBytes') &&
        isId(request.requestId) &&
        isId(request.bookId) &&
        selection(request.selection) &&
        budget(request.audioBudgetBytes) &&
        isExactObject(request.profile, 'engine', 'device') &&
        typeof request.profile.engine === 'string' &&
        ['paraformer', 'whisperx'].includes(request.profile.engine) &&
        typeof request.profile.device === 'string' &&
        ['cpu', 'cuda'].includes(request.profile.device)
      )
        return
      if (
        channel === 'offline:preview-cancel' &&
        isExactObject(request, 'requestId') &&
        isId(request.requestId)
      )
        return
      if (channel === 'offline:create' && isExactObject(request, 'token') && isId(request.token))
        return
      if (
        channel === 'offline:list' &&
        isExactObject(request, 'page', 'activeOnly') &&
        integer(request.page, 0, 100000) &&
        typeof request.activeOnly === 'boolean'
      )
        return
      if (
        channel === 'offline:get' &&
        isExactObject(request, 'id', 'itemPage') &&
        isId(request.id) &&
        integer(request.itemPage, 0, 10)
      )
        return
      if (
        channel === 'offline:release' &&
        isExactObject(request, 'id', 'revision') &&
        isId(request.id) &&
        integer(request.revision, 1, 1e9)
      )
        return
      if (
        channel === 'offline:update' &&
        typeof request === 'object' &&
        request !== null &&
        !Array.isArray(request)
      ) {
        const value = request as Record<string, unknown>
        if (isId(value.id) && integer(value.revision, 1, 1e9)) {
          if (
            isExactObject(value, 'id', 'revision', 'action', 'audioBudgetBytes') &&
            value.action === 'set-budget' &&
            budget(value.audioBudgetBytes)
          )
            return
          if (
            isExactObject(value, 'id', 'revision', 'action') &&
            typeof value.action === 'string' &&
            ['pause', 'resume', 'cancel', 'retry-failed'].includes(value.action)
          )
            return
        }
      }
    }
    throw new AppError('INVALID_REQUEST', '离线准备请求无效，请重新打开计划面板。')
  }
  if (channel.startsWith('component-install:')) {
    if (channel === 'component-install:state' && args.length === 0) return
    if (
      args.length === 1 &&
      channel === 'component-install:choose' &&
      isExactObject(request, 'engine', 'device') &&
      typeof request.engine === 'string' &&
      ['whisperx', 'paraformer'].includes(request.engine) &&
      typeof request.device === 'string' &&
      ['cpu', 'cuda'].includes(request.device)
    )
      return
    if (
      args.length === 1 &&
      [
        'component-install:start',
        'component-install:cancel',
        'component-install:activate',
      ].includes(channel) &&
      isExactObject(request, 'id') &&
      isId(request.id)
    )
      return
    throw new AppError('INVALID_REQUEST', '组件安装请求无效，请重新打开安装面板。')
  }
  if (channel.startsWith('resources:')) {
    if (channel === 'resources:state' && args.length === 0) return
    if (
      args.length === 1 &&
      isExactObject(request, 'revision', channel === 'resources:policy' ? 'policy' : 'paused') &&
      Number.isSafeInteger(request.revision) &&
      finiteBetween(request.revision, 1, 1e9)
    ) {
      if (channel === 'resources:paused' && typeof request.paused === 'boolean') return
      if (
        channel === 'resources:policy' &&
        isExactObject(request.policy, 'cpuThreads', 'lowPriority', 'backgroundIdleOnly') &&
        [1, 2, 4].includes(Number(request.policy.cpuThreads)) &&
        typeof request.policy.cpuThreads === 'number' &&
        typeof request.policy.lowPriority === 'boolean' &&
        typeof request.policy.backgroundIdleOnly === 'boolean'
      )
        return
    }
    throw new AppError('INVALID_REQUEST', '处理资源设置无效，请重新打开设置。')
  }
  if (channel.startsWith('acoustic:')) {
    if (args.length === 1 && request && typeof request === 'object' && !Array.isArray(request)) {
      const value = request as Record<string, unknown>
      const revision = Number.isSafeInteger(value.revision) && finiteBetween(value.revision, 1, 1e9)
      if (channel === 'acoustic:cancel' && isExactObject(value, 'id') && isId(value.id)) return
      if (
        channel === 'acoustic:apply' &&
        isExactObject(value, 'id', 'revision') &&
        isId(value.id) &&
        revision
      )
        return
      const target =
        isId(value.episodeId) &&
        typeof value.audioHash === 'string' &&
        /^[0-9a-f]{64}$/.test(value.audioHash)
      if (target) {
        if (channel === 'acoustic:state' && isExactObject(value, 'episodeId', 'audioHash')) return
        const match =
          isId(value.originalId) &&
          revision &&
          typeof value.segmentId === 'string' &&
          value.segmentId.length > 0 &&
          value.segmentId.length <= 128
        if (
          match &&
          channel === 'acoustic:start' &&
          isExactObject(
            value,
            'episodeId',
            'audioHash',
            'originalId',
            'revision',
            'segmentId',
            'device',
          ) &&
          ['cpu', 'cuda'].includes(String(value.device))
        )
          return
        if (
          match &&
          channel === 'acoustic:restore' &&
          isExactObject(
            value,
            'episodeId',
            'audioHash',
            'originalId',
            'revision',
            'segmentId',
            'historyId',
          ) &&
          isId(value.historyId)
        )
          return
      }
    }
    throw new AppError('INVALID_REQUEST', '原文声音对齐请求无效，请重新打开这一句。')
  }
  if (channel === 'transcription:cancel-automatic-subtitles') {
    if (
      args.length === 1 &&
      isExactObject(request, 'episodeId', 'audioHash', 'sessionId') &&
      isId(request.episodeId) &&
      isId(request.sessionId) &&
      typeof request.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(request.audioHash)
    )
      return
    throw new AppError('INVALID_REQUEST', '停止字幕请求无效，请重新打开当前集。')
  }
  if (channel === 'transcription:start-automatic-subtitles') {
    const optional =
      request && typeof request === 'object'
        ? ['explicit', 'positionMs'].filter((key) => Object.hasOwn(request, key))
        : []
    if (
      args.length === 1 &&
      isExactObject(request, 'episodeId', 'audioHash', 'sessionId', ...optional) &&
      isId(request.episodeId) &&
      isId(request.sessionId) &&
      typeof request.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(request.audioHash) &&
      (!Object.hasOwn(request, 'explicit') || typeof request.explicit === 'boolean') &&
      (!Object.hasOwn(request, 'positionMs') ||
        (typeof request.positionMs === 'number' &&
          Number.isSafeInteger(request.positionMs) &&
          request.positionMs >= 0 &&
          request.positionMs <= 3.6e10))
    )
      return
    throw new AppError('INVALID_REQUEST', '自动字幕请求无效，请重新播放当前集。')
  }
  if (channel === 'transcription:prepare-and-start') {
    if (
      args.length === 1 &&
      isExactObject(request, 'episodeId', 'audioHash', 'sessionId', 'settings') &&
      isId(request.episodeId) &&
      isId(request.sessionId) &&
      typeof request.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(request.audioHash) &&
      isExactObject(request.settings, 'mode', 'engine', 'device', 'prepareNext') &&
      ['manual', 'auto', 'ahead'].includes(String(request.settings.mode)) &&
      ['whisperx', 'paraformer'].includes(String(request.settings.engine)) &&
      ['cpu', 'cuda'].includes(String(request.settings.device)) &&
      typeof request.settings.prepareNext === 'boolean'
    )
      return
    throw new AppError('INVALID_REQUEST', '字幕准备请求无效，请重新打开当前集。')
  }
  if (channel === 'transcription:statuses') {
    if (
      args.length === 1 &&
      isExactObject(request, 'episodes') &&
      Array.isArray(request.episodes) &&
      request.episodes.length > 0 &&
      request.episodes.length <= 100 &&
      request.episodes.every(
        (target) =>
          isExactObject(target, 'episodeId', 'audioHash', 'positionMs') &&
          isId(target.episodeId) &&
          typeof target.audioHash === 'string' &&
          /^[0-9a-f]{64}$/.test(target.audioHash) &&
          Number.isSafeInteger(target.positionMs) &&
          finiteBetween(target.positionMs, 0, 3.6e10),
      ) &&
      new Set(request.episodes.map((target) => target.episodeId)).size === request.episodes.length
    )
      return
    throw new AppError('INVALID_REQUEST', '字幕状态请求无效，请重新打开目录。')
  }
  if (channel.startsWith('listening:review-')) {
    const target = request as Record<string, unknown> | null
    const base =
      args.length === 1 &&
      target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      isId(target.episodeId) &&
      typeof target.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(target.audioHash)
    if (base) {
      const historicalReviewId = target.reviewId
      if (
        channel === 'listening:review-get' &&
        (isExactObject(target, 'episodeId', 'audioHash') ||
          (isExactObject(target, 'episodeId', 'audioHash', 'reviewId') && isId(historicalReviewId)))
      )
        return
      if (
        channel === 'listening:review-prepare' &&
        isExactObject(target, 'episodeId', 'audioHash', 'transcriptRevision') &&
        Number.isSafeInteger(target.transcriptRevision) &&
        finiteBetween(target.transcriptRevision, 1, 1e9)
      )
        return
      if (
        channel === 'listening:review-save' &&
        isId(target.reviewId) &&
        Number.isSafeInteger(target.revision) &&
        finiteBetween(target.revision, 1, 1e9)
      ) {
        if (
          target.action === 'add-sample' &&
          isExactObject(
            target,
            'episodeId',
            'audioHash',
            'reviewId',
            'revision',
            'action',
            'segmentId',
          ) &&
          typeof target.segmentId === 'string' &&
          target.segmentId.length > 0 &&
          target.segmentId.length <= 128
        )
          return
        if (
          target.action === 'feedback' &&
          isExactObject(
            target,
            'episodeId',
            'audioHash',
            'reviewId',
            'revision',
            'action',
            'sampleId',
            'entry',
          ) &&
          isId(target.sampleId) &&
          isExactObject(
            target.entry,
            'listened',
            'speech',
            'spokenText',
            'namesChecked',
            'properNames',
            'sync',
            'humanStartMs',
            'humanEndMs',
            'notes',
          )
        ) {
          const entry = target.entry
          if (
            typeof entry.listened === 'boolean' &&
            ['unknown', 'speech', 'silence'].includes(String(entry.speech)) &&
            typeof entry.namesChecked === 'boolean' &&
            ['unknown', 'aligned', 'early', 'late', 'mixed', 'not-applicable'].includes(
              String(entry.sync),
            ) &&
            (
              Object.keys(
                LISTENING_REVIEW_TEXT_LIMITS,
              ) as (keyof typeof LISTENING_REVIEW_TEXT_LIMITS)[]
            ).every((key) => {
              const value = entry[key]
              return (
                value === null ||
                (typeof value === 'string' &&
                  value.length <= LISTENING_REVIEW_TEXT_LIMITS[key] &&
                  !value.includes('\0'))
              )
            }) &&
            [entry.humanStartMs, entry.humanEndMs].every(
              (value) =>
                value === null || (Number.isSafeInteger(value) && finiteBetween(value, 0, 3.6e10)),
            )
          )
            return
        }
      }
    }
    throw new AppError('INVALID_REQUEST', '试听校对请求无效，请重新操作。')
  }
  if (channel === 'transcription:component-use') {
    if (args.length === 1 && isExactObject(request, 'id') && isId(request.id)) return
    throw new AppError('INVALID_REQUEST', '组件选择已失效，请重新检测。')
  }
  if (channel === 'transcription:prioritize') {
    if (
      args.length === 1 &&
      isExactObject(request, 'episodeId', 'audioHash', 'positionMs') &&
      isId(request.episodeId) &&
      typeof request.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(request.audioHash) &&
      Number.isSafeInteger(request.positionMs) &&
      finiteBetween(request.positionMs, 0, 3.6e10)
    )
      return
    throw new AppError('INVALID_REQUEST', '字幕优先位置无效。')
  }
  if (channel === 'transcription:preparation') {
    if (
      args.length === 1 &&
      isExactObject(request, 'id', 'settings') &&
      isId(request.id) &&
      isExactObject(request.settings, 'mode', 'engine', 'device', 'prepareNext') &&
      ['manual', 'auto', 'ahead'].includes(String(request.settings.mode)) &&
      ['whisperx', 'paraformer'].includes(String(request.settings.engine)) &&
      ['cpu', 'cuda'].includes(String(request.settings.device)) &&
      typeof request.settings.prepareNext === 'boolean'
    )
      return
    throw new AppError('INVALID_REQUEST', '字幕准备设置无效。')
  }
  if (channel.startsWith('reading:')) {
    if (['reading:list', 'reading:import'].includes(channel) && args.length === 0) return
    if (args.length === 1 && request && typeof request === 'object') {
      const value = request as Record<string, unknown>
      const ordinal = (v: unknown) =>
        Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < 250_000
      if (isId(value.id)) {
        if (channel === 'reading:remove' && isExactObject(value, 'id')) return
        if (
          channel === 'reading:page' &&
          isExactObject(value, 'id', 'start') &&
          ordinal(value.start)
        )
          return
        if (
          channel === 'reading:progress' &&
          isExactObject(value, 'id', 'position') &&
          ordinal(value.position)
        )
          return
        if (
          channel === 'reading:find' &&
          isExactObject(value, 'id', 'query', 'offset') &&
          typeof value.query === 'string' &&
          value.query.trim().length >= 2 &&
          value.query.length <= 100 &&
          Number.isSafeInteger(value.offset) &&
          Number(value.offset) >= 0 &&
          Number(value.offset) <= 12_000_000
        )
          return
      }
    }
    throw new AppError('INVALID_REQUEST', '电子书阅读请求无效。')
  }
  if (
    channel === 'transcript:export-subtitles' &&
    args.length === 1 &&
    request &&
    typeof request === 'object'
  ) {
    const value = request as Record<string, unknown>
    if (
      isId(value.episodeId) &&
      typeof value.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(value.audioHash) &&
      isId(value.transcriptId) &&
      Number.isSafeInteger(value.transcriptRevision) &&
      Number(value.transcriptRevision) > 0 &&
      ['srt', 'vtt'].includes(String(value.format)) &&
      ((value.source === 'transcript' &&
        isExactObject(
          value,
          'episodeId',
          'audioHash',
          'transcriptId',
          'transcriptRevision',
          'source',
          'format',
        )) ||
        (value.source === 'original' &&
          isExactObject(
            value,
            'episodeId',
            'audioHash',
            'transcriptId',
            'transcriptRevision',
            'source',
            'format',
            'originalId',
            'alignmentRevision',
          ) &&
          isId(value.originalId) &&
          Number.isSafeInteger(value.alignmentRevision) &&
          Number(value.alignmentRevision) > 0))
    )
      return
    throw new AppError('INVALID_REQUEST', '字幕导出请求无效。')
  }
  if (channel === 'original:cancel' && args.length === 0) return
  if (
    channel.startsWith('original:') &&
    args.length === 1 &&
    request &&
    typeof request === 'object' &&
    !Array.isArray(request)
  ) {
    const value = request as Record<string, unknown>
    const base =
      isId(value.episodeId) &&
      typeof value.audioHash === 'string' &&
      /^[0-9a-f]{64}$/.test(value.audioHash)
    const ordinal = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < 250_000
    if (
      base &&
      ['original:state', 'original:import', 'original:match'].includes(channel) &&
      isExactObject(value, 'episodeId', 'audioHash')
    )
      return
    if (base && isId(value.originalId)) {
      if (
        channel === 'original:find' &&
        isExactObject(value, 'episodeId', 'audioHash', 'originalId', 'query', 'offset') &&
        typeof value.query === 'string' &&
        value.query.trim().length >= 2 &&
        value.query.length <= 100 &&
        Number.isSafeInteger(value.offset) &&
        Number(value.offset) >= 0 &&
        Number(value.offset) <= 12_000_000
      )
        return
      if (
        channel === 'original:page' &&
        isExactObject(value, 'episodeId', 'audioHash', 'originalId', 'start') &&
        ordinal(value.start)
      )
        return
      if (
        channel === 'original:search' &&
        isExactObject(value, 'episodeId', 'audioHash', 'originalId', 'query') &&
        typeof value.query === 'string' &&
        value.query.trim().length >= 2 &&
        value.query.length <= 100
      )
        return
      if (
        channel === 'original:correct' &&
        isExactObject(
          value,
          'episodeId',
          'audioHash',
          'originalId',
          'revision',
          'segmentId',
          'selection',
          'startMs',
          'endMs',
        ) &&
        Number.isSafeInteger(value.revision) &&
        Number(value.revision) > 0 &&
        typeof value.segmentId === 'string' &&
        value.segmentId.length > 0 &&
        value.segmentId.length <= 128 &&
        Number.isSafeInteger(value.startMs) &&
        Number.isSafeInteger(value.endMs) &&
        Number(value.startMs) >= 0 &&
        Number(value.endMs) > Number(value.startMs) &&
        Number(value.endMs) <= 3.6e10 &&
        (value.selection === null ||
          (isExactObject(value.selection, 'first', 'last') &&
            ordinal(value.selection.first) &&
            ordinal(value.selection.last) &&
            Number(value.selection.last) >= Number(value.selection.first)))
      )
        return
    }
    throw new AppError('INVALID_REQUEST', '原文请求参数无效。')
  }
  if (
    channel === 'source:preparation' &&
    args.length === 1 &&
    isExactObject(request, 'id', 'settings') &&
    isId(request.id) &&
    isExactObject(request.settings, 'cacheNext', 'transcribeNext', 'engine', 'device') &&
    typeof request.settings.cacheNext === 'boolean' &&
    typeof request.settings.transcribeNext === 'boolean' &&
    ['whisperx', 'paraformer'].includes(String(request.settings.engine)) &&
    ['cpu', 'cuda'].includes(String(request.settings.device))
  )
    return
  if (
    channel === 'source:cache-clear' &&
    args.length === 1 &&
    isExactObject(request, 'token') &&
    isId(request.token)
  )
    return
  if (
    args.length === 1 &&
    isExactObject(request, 'id') &&
    isId(request.id) &&
    channel === 'source:cancel'
  )
    return
  if (
    args.length === 1 &&
    isSourceRequest(request) &&
    ((channel === 'source:search' &&
      isExactObject(request, 'id', 'sourceId', 'query', 'cursor') &&
      typeof request.query === 'string' &&
      request.query.trim().length > 0 &&
      request.query.trim().length <= sourceQueryLimit(request.sourceId) &&
      (request.cursor === null ||
        (isPluginSourceId(request.sourceId)
          ? typeof request.cursor === 'string' &&
            request.cursor.length <= 2048 &&
            !/\p{Cc}/u.test(request.cursor)
          : isId(request.cursor)))) ||
      (['source:book', 'source:add'].includes(channel) &&
        isExactObject(request, 'id', 'sourceId', 'bookId') &&
        typeof request.bookId === 'string' &&
        (isPluginSourceId(request.sourceId)
          ? isSourceItemId(request.bookId)
          : /^[1-9]\d{0,8}$/.test(request.bookId))) ||
      (channel === 'source:episodes' &&
        isExactObject(request, 'id', 'sourceId', 'bookId', 'cursor') &&
        typeof request.bookId === 'string' &&
        (isPluginSourceId(request.sourceId)
          ? isSourceItemId(request.bookId)
          : /^[1-9]\d{0,8}$/.test(request.bookId)) &&
        (request.cursor === null ||
          (isPluginSourceId(request.sourceId)
            ? typeof request.cursor === 'string' &&
              request.cursor.length <= 2048 &&
              !/\p{Cc}/u.test(request.cursor)
            : isId(request.cursor))))) &&
    isId(request.id)
  )
    return
  if (
    [
      'transcript:get',
      'transcript:import',
      'transcription:state',
      'transcription:summary',
      'transcript:regions',
    ].includes(channel) &&
    args.length === 1 &&
    isExactObject(request, 'episodeId', 'audioHash') &&
    isId(request.episodeId) &&
    typeof request.audioHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.audioHash)
  )
    return
  if (
    channel === 'transcript:region-mark' &&
    args.length === 1 &&
    (isExactObject(request, 'episodeId', 'audioHash', 'revision', 'startMs', 'endMs', 'kind') ||
      (isExactObject(
        request,
        'episodeId',
        'audioHash',
        'revision',
        'startMs',
        'endMs',
        'kind',
        'previous',
      ) &&
        isExactObject(request.previous, 'startMs', 'endMs') &&
        Number.isSafeInteger(request.previous.startMs) &&
        finiteBetween(request.previous.startMs, 0, 3.6e10 - 1) &&
        Number.isSafeInteger(request.previous.endMs) &&
        finiteBetween(request.previous.endMs, (request.previous.startMs as number) + 1, 3.6e10))) &&
    isId(request.episodeId) &&
    typeof request.audioHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.audioHash) &&
    Number.isSafeInteger(request.revision) &&
    finiteBetween(request.revision, 0, 1e9) &&
    Number.isSafeInteger(request.startMs) &&
    finiteBetween(request.startMs, 0, 3.6e10 - 1) &&
    Number.isSafeInteger(request.endMs) &&
    finiteBetween(request.endMs, (request.startMs as number) + 1, 3.6e10) &&
    (request.kind === null ||
      (typeof request.kind === 'string' &&
        ['advertisement', 'intro', 'recap'].includes(request.kind)))
  )
    return
  if (
    [
      'app:get-state',
      'library:select-folder',
      'app:quit',
      'transcription:configure',
      'transcription:components-detect',
      'transcription:component-folder',
      'transcription:component-check',
      'maintenance:state',
      'maintenance:prepare-clear',
      'maintenance:log',
      'source:preparation-state',
      'source:cache-state',
      'source:cache-preview',
    ].includes(channel) &&
    args.length === 0
  )
    return
  if (
    channel === 'maintenance:tasks' &&
    args.length === 1 &&
    isExactObject(request, 'page', 'activeOnly') &&
    Number.isSafeInteger(request.page) &&
    finiteBetween(request.page, 0, 1000000) &&
    typeof request.activeOnly === 'boolean'
  )
    return
  if (
    channel === 'maintenance:clear' &&
    args.length === 1 &&
    isExactObject(request, 'token') &&
    isId(request.token)
  )
    return
  if (
    channel === 'maintenance:show-location' &&
    args.length === 1 &&
    isExactObject(request, 'target') &&
    typeof request.target === 'string' &&
    ['data', 'logs', 'cache', 'models'].includes(request.target)
  )
    return
  if (
    channel === 'files:select-audio' &&
    args.length === 1 &&
    isExactObject(request, 'kind') &&
    request.kind === 'audio'
  )
    return
  if (
    [
      'files:forget',
      'library:remove-book',
      'library:import-remembered',
      'library:cancel-import',
      'source:continuation',
      'player:flushed',
      'transcription:cancel',
      'transcription:retry',
      'transcription:preview',
      'listening:bookmarks',
      'listening:bookmark-remove',
    ].includes(channel) &&
    args.length === 1 &&
    isExactObject(request, 'id') &&
    isId(request.id)
  )
    return
  if (
    ['player:open-episode', 'player:cancel-open'].includes(channel) &&
    args.length === 1 &&
    (isExactObject(request, 'id') ||
      (isExactObject(request, 'id', 'requestId') && isId(request.requestId))) &&
    isId(request.id)
  )
    return
  if (
    ['player:source-state', 'player:release-source'].includes(channel) &&
    args.length === 1 &&
    isExactObject(request, 'sessionId') &&
    isId(request.sessionId)
  )
    return
  if (
    channel === 'listening:book-skips' &&
    args.length === 1 &&
    isExactObject(request, 'id', 'introMs', 'outroMs') &&
    isId(request.id) &&
    Number.isInteger(request.introMs) &&
    Number.isInteger(request.outroMs) &&
    finiteBetween(request.introMs, 0, 3600000) &&
    finiteBetween(request.outroMs, 0, 3600000)
  )
    return
  if (
    channel === 'listening:bookmark-save' &&
    args.length === 1 &&
    isExactObject(request, 'episodeId', 'audioHash', 'positionMs', 'note') &&
    isId(request.episodeId) &&
    typeof request.audioHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.audioHash) &&
    Number.isSafeInteger(request.positionMs) &&
    finiteBetween(request.positionMs, 0, 3.6e10) &&
    typeof request.note === 'string' &&
    request.note.length <= 1000
  )
    return
  if (
    channel === 'listening:bookmark-edit' &&
    args.length === 1 &&
    isExactObject(request, 'id', 'note') &&
    isId(request.id) &&
    typeof request.note === 'string' &&
    request.note.length <= 1000
  )
    return
  if (
    channel === 'transcription:start' &&
    args.length === 1 &&
    isExactObject(request, 'episodeId', 'audioHash', 'engine', 'device') &&
    isId(request.episodeId) &&
    typeof request.audioHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.audioHash) &&
    typeof request.engine === 'string' &&
    ['whisperx', 'paraformer'].includes(request.engine) &&
    typeof request.device === 'string' &&
    ['cpu', 'cuda'].includes(request.device)
  )
    return
  if (
    channel === 'transcription:apply' &&
    args.length === 1 &&
    isExactObject(request, 'id', 'revision') &&
    isId(request.id) &&
    Number.isSafeInteger(request.revision) &&
    finiteBetween(request.revision, 0, 1e9)
  )
    return
  if (
    channel === 'transcript:edit' &&
    args.length === 1 &&
    isExactObject(request, 'episodeId', 'audioHash', 'revision', 'segmentId', 'text') &&
    isId(request.episodeId) &&
    typeof request.audioHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.audioHash) &&
    Number.isSafeInteger(request.revision) &&
    finiteBetween(request.revision, 1, 1e9) &&
    typeof request.segmentId === 'string' &&
    request.segmentId.length > 0 &&
    request.segmentId.length <= 128 &&
    typeof request.text === 'string' &&
    request.text.trim().length > 0 &&
    request.text.length <= 10000
  )
    return
  if (
    channel === 'library:confirm-import' &&
    args.length === 1 &&
    isExactObject(request, 'id', 'episodeIds') &&
    isId(request.id) &&
    Array.isArray(request.episodeIds) &&
    request.episodeIds.length > 0 &&
    request.episodeIds.length <= 10000 &&
    request.episodeIds.every(isId) &&
    new Set(request.episodeIds).size === request.episodeIds.length
  )
    return
  if (
    channel === 'player:save-progress' &&
    args.length === 1 &&
    isExactObject(
      request,
      'sessionId',
      'episodeId',
      'positionMs',
      'durationMs',
      'rate',
      'volume',
    ) &&
    isId(request.sessionId) &&
    isId(request.episodeId) &&
    finiteBetween(request.positionMs, 0, 3.6e10) &&
    (request.durationMs === null || finiteBetween(request.durationMs, 1, 3.6e10)) &&
    finiteBetween(request.rate, 0.5, 3) &&
    finiteBetween(request.volume, 0, 1)
  )
    return
  throw new AppError('INVALID_REQUEST', '请求参数无效，请重新操作。')
}

export function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function finiteBetween(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

export function isTrustedRenderer(
  senderId: number,
  expectedId: number,
  isMainFrame: boolean,
  senderUrl: string,
  expectedUrl: string,
): boolean {
  if (senderId !== expectedId || !isMainFrame) return false
  try {
    const actual = new URL(senderUrl)
    const expected = new URL(expectedUrl)
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}
