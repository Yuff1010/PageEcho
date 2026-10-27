// Only public site navigation and the script services observed in its normal player.
export function allowTing13Request(value: string, resourceType: string): boolean {
  if (value === 'about:blank') return resourceType === 'mainFrame'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false
  const site = url.hostname === 'www.ting13.cc' || url.hostname === 'ting13.cc'
  if (resourceType === 'mainFrame') return site
  if (['subFrame', 'media', 'image', 'font', 'object', 'ping', 'webSocket'].includes(resourceType))
    return false
  if (site) return true
  return (
    resourceType === 'script' &&
    ((url.hostname === 'cdnjs.cloudflare.com' &&
      /^\/ajax\/libs\/(jquery|jplayer)\//.test(url.pathname)) ||
      (url.hostname === 'apps.bdimg.com' && /^\/libs\/jquery\//.test(url.pathname)))
  )
}
