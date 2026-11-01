import { SourceError } from '../../shared/sources'
import { MAX_PLUGIN_ZIP_BYTES, invalidPlugin, pluginUrl } from './manifest'

/** ZIP downloads share one bounded, credential-free path for installs and update checks. */
export async function downloadPluginPackage(address: string, signal: AbortSignal): Promise<Buffer> {
  const initial = pluginUrl(address)
  let url = initial.href
  for (let redirect = 0; redirect <= 4; redirect++) {
    signal.throwIfAborted()
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/zip, application/octet-stream' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || redirect === 4) return invalidPlugin('插件下载重定向过多或无效。')
      const target = pluginUrl(new URL(location, url).href)
      if (target.origin !== initial.origin)
        return invalidPlugin('插件包下载重定向超出原域名，请使用直接下载地址。')
      url = target.href
      continue
    }
    const length = response.headers.get('content-length')
    if (
      response.status !== 200 ||
      response.headers.has('content-range') ||
      !response.body ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_PLUGIN_ZIP_BYTES))
    ) {
      await response.body?.cancel()
      throw new SourceError('SOURCE_UNAVAILABLE', '插件包下载失败、响应不完整或超过 8 MiB。')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_PLUGIN_ZIP_BYTES) {
        await response.body.cancel().catch(() => undefined)
        return invalidPlugin('插件包超过 8 MiB。')
      }
      chunks.push(Buffer.from(chunk))
    }
    signal.throwIfAborted()
    if (length !== null && Number(length) !== size)
      throw new SourceError('SOURCE_UNAVAILABLE', '插件包下载不完整，请重试。')
    return Buffer.concat(chunks)
  }
  throw new SourceError('SOURCE_UNAVAILABLE', '插件包下载失败。')
}
