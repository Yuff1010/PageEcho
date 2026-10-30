import { parentPort, workerData } from 'node:worker_threads'
import { load } from 'cheerio'
import { newQuickJSAsyncWASMModule, type QuickJSHandle } from 'quickjs-emscripten'
import { SourceError, type SourceErrorCode } from '../../shared/sources'
import type { PluginHostMessage, PluginWorkerInput, PluginWorkerMessage } from './runtime-types'

const MAX_JSON_CHARACTERS = 4 * 1024 * 1024
const ERROR_CODES: SourceErrorCode[] = [
  'INVALID_SOURCE_REQUEST',
  'SOURCE_BUSY',
  'SOURCE_CANCELED',
  'SOURCE_TIMEOUT',
  'SOURCE_UNAVAILABLE',
  'SOURCE_CHANGED',
  'SOURCE_VERIFICATION_REQUIRED',
  'SOURCE_MEDIA_UNAVAILABLE',
]

// This is trusted bootstrap code. Third-party scripts are evaluated only inside QuickJS/WASM.
const BOOTSTRAP = `(() => {
  'use strict';
  const sources = Object.create(null);
  const methods = ['search','getBook','getEpisodes','resolveAudio','getChapters','getChapterText'];
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
  const own = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);
  const apply = Reflect.apply.bind(Reflect);
  const host = Object.freeze({
    getText(url, options) {
      const result = parse(__ralbHttp(String(url), stringify(options || {})));
      if (!result.ok) { const error = new Error(result.message); error.code = result.code; throw error; }
      return result.text;
    },
    getJson(url, options) { return parse(host.getText(url, options)); },
    select(html, selector) { return parse(__ralbSelect(String(html), String(selector))); },
    resolveUrl(value, base) { return __ralbResolve(String(value), String(base)); }
  });
  Object.defineProperty(globalThis, 'registerSource', { value(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(source.id)) throw new Error('插件来源标识无效。');
    if (own(sources, source.id)) throw new Error('插件重复注册了来源。');
    Object.defineProperty(source, 'host', { value: host, writable: false, configurable: false });
    sources[source.id] = source;
  }, writable: false, configurable: false });
  Object.defineProperty(globalThis, '__ralbRuntimeInspect', { value() {
    return stringify(Object.keys(sources).map(id => ({ id, methods: methods.filter(method => typeof sources[id][method] === 'function') })));
  }, writable: false, configurable: false });
  Object.defineProperty(globalThis, '__ralbRuntimeInvoke', { value(input) {
    const request = parse(input), source = sources[request.sourceId];
    if (!source || !methods.includes(request.method) || typeof source[request.method] !== 'function') throw new Error('插件未提供此来源操作。');
    const result = apply(source[request.method], source, request.args);
    if (result && typeof result.then === 'function') throw new Error('插件方法必须同步返回结果；网络请求请使用 this.host。');
    const output = stringify(result);
    if (typeof output !== 'string') throw new Error('插件操作没有返回 JSON 数据。');
    if (output.length > ${MAX_JSON_CHARACTERS}) throw new Error('插件结果超过 4 MiB。');
    return output;
  }, writable: false, configurable: false });
})();`

async function run() {
  const input = workerData as PluginWorkerInput
  const pending = new Map<number, (message: PluginHostMessage) => void>()
  let sequence = 0
  parentPort!.on('message', (message: PluginHostMessage) => {
    if (message.kind !== 'response') return
    const complete = pending.get(message.id)
    if (complete) {
      pending.delete(message.id)
      complete(message)
    }
  })
  const module = await newQuickJSAsyncWASMModule()
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(32 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(() => Date.now() >= input.deadline)
  const context = runtime.newContext()
  const string = (value?: QuickJSHandle) => {
    if (!value || context.typeof(value) !== 'string') throw new Error('插件宿主参数必须是字符串。')
    return context.getString(value)
  }
  try {
    context
      .newAsyncifiedFunction('__ralbHttp', async (url, options) => {
        const value = string(url),
          raw = string(options)
        if (value.length > 16_000 || raw.length > 256 * 1024) throw new Error('插件网络参数过长。')
        const id = ++sequence
        const result = await new Promise<PluginHostMessage>((resolve) => {
          pending.set(id, resolve)
          parentPort!.postMessage({
            kind: 'request',
            id,
            url: value,
            options: JSON.parse(raw),
          } satisfies PluginWorkerMessage)
        })
        return context.newString(
          JSON.stringify(
            'error' in result
              ? { ok: false, code: result.code, message: result.error }
              : { ok: true, text: result.text },
          ),
        )
      })
      .consume((fn) => context.setProp(context.global, '__ralbHttp', fn))
    context
      .newFunction('__ralbSelect', (htmlHandle, selectorHandle) => {
        const html = string(htmlHandle),
          selector = string(selectorHandle)
        if (html.length > 2 * 1024 * 1024 || selector.length > 512 || !selector.trim())
          throw new Error('插件 HTML 或选择器超过限制。')
        const $ = load(html)
        const matches = $(selector)
        if (matches.length > 1000) throw new Error('插件 HTML 选择结果超过 1000 项。')
        const result = matches.toArray().map((element) => ({
          text: $(element).text(),
          html: $(element).html() ?? '',
          attributes:
            element.type === 'tag'
              ? Object.fromEntries(Object.entries(element.attribs).slice(0, 100))
              : {},
        }))
        const json = JSON.stringify(result)
        if (json.length > MAX_JSON_CHARACTERS) throw new Error('插件 HTML 结果超过大小限制。')
        return context.newString(json)
      })
      .consume((fn) => context.setProp(context.global, '__ralbSelect', fn))
    context
      .newFunction('__ralbResolve', (valueHandle, baseHandle) => {
        const value = string(valueHandle),
          base = string(baseHandle)
        if (value.length > 16_000 || base.length > 16_000) throw new Error('插件链接过长。')
        const url = new URL(value, base)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('插件链接必须是无凭据的 HTTP／HTTPS 地址。')
        return context.newString(url.href)
      })
      .consume((fn) => context.setProp(context.global, '__ralbResolve', fn))

    const evaluate = async (script: string, filename: string): Promise<string | undefined> => {
      const result = await context.evalCodeAsync(script, filename)
      if (result.error) {
        let message = '插件脚本运行失败。',
          code: SourceErrorCode = 'SOURCE_CHANGED'
        try {
          const messageHandle = context.getProp(result.error, 'message')
          if (context.typeof(messageHandle) === 'string')
            message = context.getString(messageHandle).slice(0, 500)
          messageHandle.dispose()
          const codeHandle = context.getProp(result.error, 'code')
          const value = context.typeof(codeHandle) === 'string' ? context.getString(codeHandle) : ''
          codeHandle.dispose()
          if (ERROR_CODES.includes(value as SourceErrorCode)) code = value as SourceErrorCode
        } finally {
          result.error.dispose()
        }
        throw new SourceError(code, message)
      }
      try {
        return context.typeof(result.value) === 'string'
          ? context.getString(result.value)
          : undefined
      } finally {
        result.value.dispose()
      }
    }
    await evaluate(BOOTSTRAP, 'plugin-host.js')
    for (const [index, script] of input.scripts.entries())
      await evaluate(script, `plugin-${index + 1}.js`)
    const expression = input.method
      ? `__ralbRuntimeInvoke(${JSON.stringify(JSON.stringify({ sourceId: input.sourceId, method: input.method, args: input.args ?? [] }))})`
      : '__ralbRuntimeInspect()'
    const output = await evaluate(expression, 'plugin-call.js')
    if (output === undefined || Buffer.byteLength(output, 'utf8') > MAX_JSON_CHARACTERS)
      throw new SourceError('SOURCE_CHANGED', '插件未返回有效结果或结果过大。')
    parentPort!.postMessage({
      kind: 'done',
      value: JSON.parse(output),
    } satisfies PluginWorkerMessage)
  } finally {
    // The parent unconditionally terminates this disposable worker. Asyncify host-ref
    // teardown may throw in the engine wrapper; it must never replace the plugin error.
    try {
      context.dispose()
    } catch {
      /* Worker termination releases the isolated VM. */
    }
    try {
      runtime.dispose()
    } catch {
      /* Worker termination releases the isolated VM. */
    }
  }
}

void run().then(
  () => parentPort!.close(),
  (error: unknown) => {
    const input = workerData as PluginWorkerInput
    const timedOut = Date.now() >= input.deadline
    parentPort!.postMessage({
      kind: 'error',
      code: timedOut
        ? 'SOURCE_TIMEOUT'
        : error instanceof SourceError
          ? error.code
          : 'SOURCE_CHANGED',
      message: timedOut
        ? '插件运行超时，已停止。'
        : error instanceof SourceError
          ? error.message
          : '插件运行失败，请检查脚本及其资源限制。',
    } satisfies PluginWorkerMessage)
    parentPort!.close()
  },
)
