import {
  TranscriptSearchIndex,
  type TranscriptSearchInput,
  type TranscriptSearchOutput,
} from '../../shared/transcript-search'

let index: TranscriptSearchIndex | null = null
self.onmessage = (event: MessageEvent<TranscriptSearchInput>) => {
  const request = event.data
  const reply = (message: TranscriptSearchOutput) => self.postMessage(message)
  try {
    if (request.type === 'init') {
      index = new TranscriptSearchIndex(request.segments)
      reply({ type: 'ready' })
    } else {
      if (!index) throw new Error('文稿搜索尚未准备完成。')
      reply({ type: 'result', id: request.id, page: index.find(request.query, request.offset) })
    }
  } catch (error) {
    reply({
      type: 'error',
      ...('id' in request ? { id: request.id } : {}),
      error: error instanceof Error ? error.message : '文稿搜索失败。',
    })
  }
}
