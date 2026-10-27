export function offlineBytes(bytes: number | null) {
  if (bytes === null) return '未知'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${Math.max(0, bytes)} 字节`
}
