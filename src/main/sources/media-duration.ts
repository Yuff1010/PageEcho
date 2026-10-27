import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { MEDIA_PREFIX } from '../media'
import { AppError, isId } from '../../shared/validation'

// Use the same Chromium decoder as playback, without adding/changing the persistent player.
export async function cachedMediaDuration(
  window: BrowserWindow,
  id: string,
  hash: string,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted()
  if (!isId(id) || !/^[a-f0-9]{64}$/.test(hash))
    throw new AppError('INVALID_REQUEST', '音频版本无效。')
  const url = JSON.stringify(`${MEDIA_PREFIX}${id}/${hash}`)
  const key = JSON.stringify(`ralbMetadata${randomUUID()}`)
  const cancel = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      void window.webContents
        .executeJavaScriptInIsolatedWorld(1003, [
          { code: `globalThis[${key}]?.('读取音频时长已取消。')` },
        ])
        .catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  let result: unknown
  try {
    result = await window.webContents.executeJavaScriptInIsolatedWorld(1003, [
      {
        code: `
    new Promise((resolve,reject)=>{
      const audio=document.createElement('audio');audio.preload='metadata';audio.volume=0;
      let timer,finished=false;
      const finish=(error)=>{
        if(finished)return;finished=true;delete globalThis[${key}];
        clearTimeout(timer);const duration=audio.duration*1000;
        audio.onloadedmetadata=null;audio.onerror=null;audio.removeAttribute('src');audio.load();
        if(error)reject(new Error(error));else resolve(duration);
      };
      globalThis[${key}]=finish;
      audio.onloadedmetadata=()=>finish();audio.onerror=()=>finish('无法读取缓存音频时长。');
      timer=setTimeout(()=>finish('读取缓存音频时长超时。'),10000);
      audio.src=${url};audio.load();
    })`,
      },
    ])
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
  signal?.throwIfAborted()
  if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0 || result > 3.6e10)
    throw new AppError('SOURCE_MEDIA_UNAVAILABLE', '缓存音频时长无效，已保留音频供重试。')
  return result
}
