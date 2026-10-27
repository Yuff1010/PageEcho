import { isAbsolute, relative, resolve } from 'node:path'

export const APP_URL = 'readlisten://app/index.html'
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"

export function resolveRendererResource(root: string, requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== 'readlisten:' || url.host !== 'app' || url.username || url.password)
      return null
    const pathname = decodeURIComponent(url.pathname)
    if (pathname.includes('\\') || pathname.includes('\0')) return null
    const resolved = resolve(root, `.${pathname}`)
    const inside = relative(root, resolved)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
    return resolved
  } catch {
    return null
  }
}
