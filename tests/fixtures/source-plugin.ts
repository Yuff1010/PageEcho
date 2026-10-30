import { zip } from './original-epub'

export interface SourcePluginFixtureOptions {
  id?: string
  name?: string
  version?: string
  broken?: boolean
}

/** Synthetic plugin only talks to the supplied loopback fixture server. */
export function pluginFiles(origin: string, options: SourcePluginFixtureOptions = {}) {
  const manifest = {
    schemaVersion: 1,
    apiVersion: 1,
    id: options.id ?? 'synthetic.books',
    name: options.name ?? '合成来源插件',
    version: options.version ?? '1.0.0',
    scripts: ['main.js'],
    sources: [
      {
        id: 'audio',
        name: '合成音频来源',
        kind: 'audio',
        baseUrl: origin,
        description: '仅用于本机插件回归的合成音频。',
        allowedOrigins: [origin],
        mediaOrigins: [origin],
      },
      {
        id: 'text',
        name: '合成正文来源',
        kind: 'text',
        baseUrl: origin,
        description: '仅用于本机插件回归的合成正文。',
        allowedOrigins: [origin],
      },
    ],
  }
  const base = JSON.stringify(origin)
  const scripts = `
    registerSource({
      id: 'audio',
      search: function (query) { return this.host.getJson(${base} + '/audio/search?q=' + encodeURIComponent(query)); },
      getBook: function (id) { return this.host.getJson(${base} + '/audio/book?id=' + encodeURIComponent(id)); },
      getEpisodes: function (id) { return this.host.getJson(${base} + '/audio/chapters?id=' + encodeURIComponent(id)); },
      resolveAudio: function (bookId, episodeId) { return this.host.getJson(${base} + '/audio/resolve?book=' + encodeURIComponent(bookId) + '&chapter=' + encodeURIComponent(episodeId)); }
    });
    registerSource({
      id: 'text',
      search: function (query) { return this.host.getJson(${base} + '/text/search?q=' + encodeURIComponent(query)); },
      getBook: function (id) { return this.host.getJson(${base} + '/text/book?id=' + encodeURIComponent(id)); },
      getChapters: function (id) { return this.host.getJson(${base} + '/text/chapters?id=' + encodeURIComponent(id)); },
      getChapterText: function (bookId, chapterId) { return this.host.getText(${base} + '/text/chapter?id=' + encodeURIComponent(chapterId)); }
    });
  `
  return {
    'manifest.json': JSON.stringify(manifest),
    'main.js': options.broken ? `${scripts}\nthis is an intentional syntax error (` : scripts,
  }
}

export function pluginPackage(origin: string, options: SourcePluginFixtureOptions = {}) {
  return zip(pluginFiles(origin, options))
}
