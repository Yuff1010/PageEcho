/* global registerSource */
// ReadAndListenBook SDK v1. Synchronous methods use only this.host; no Node or browser globals.
registerSource({
  id: 'zh-text',

  api: function (params) {
    params.format = 'json'
    params.formatversion = '2'
    var query = Object.keys(params)
      .map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key]))
      })
      .join('&')
    var data = this.host.getJson('https://zh.wikisource.org/w/api.php?' + query)
    if (data.error) throw new Error('维基文库页面暂不可用，请重试。')
    return data
  },

  parse: function (params) {
    params.action = 'parse'
    params.prop = 'text|links'
    params.redirects = '1'
    var data = this.api(params).parse
    if (!data || typeof data.text !== 'string') throw new Error('维基文库页面格式发生变化。')
    return data
  },

  search: function (query, cursor) {
    var offset = cursor ? Number(cursor) : 0
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
      throw new Error('搜索分页位置无效。')
    var data = this.api({
      action: 'query',
      list: 'search',
      srsearch: query || '吶喊',
      srnamespace: 0,
      srlimit: 20,
      sroffset: offset,
    })
    return {
      items: data.query.search.map(function (item) {
        return {
          id: String(item.pageid),
          title: item.title,
          description: String(item.snippet || '').replace(/<[^>]*>/g, ''),
          pageUrl: 'https://zh.wikisource.org/wiki/' + encodeURIComponent(item.title),
        }
      }),
      nextCursor: data.continue ? String(data.continue.sroffset) : null,
    }
  },

  getBook: function (id) {
    var page = this.parse({ pageid: id })
    return {
      id: id,
      title: page.title,
      pageUrl: 'https://zh.wikisource.org/wiki/' + encodeURIComponent(page.title),
    }
  },

  getChapters: function (id) {
    var page = this.parse({ pageid: id })
    var allowed = Object.create(null)
    ;(page.links || []).forEach(function (link) {
      if (link.ns === 0 && link.exists) allowed[link.title] = true
    })
    var seen = Object.create(null)
    var chapters = [{ id: 'pageid:' + id, title: '本页正文' }]
    this.host
      .select(page.text, 'ul a[title], ol a[title], table a[title]')
      .forEach(function (link) {
        var title = link.attributes.title
        if (
          allowed[title] &&
          !seen[title] &&
          String(link.attributes.href || '').indexOf('/wiki/') === 0 &&
          chapters.length < 1000
        ) {
          seen[title] = true
          chapters.push({ id: 'title:' + title, title: link.text || title })
        }
      })
    return { items: chapters, nextCursor: null }
  },

  getChapterText: function (bookId, chapterId) {
    var params =
      chapterId.indexOf('pageid:') === 0
        ? { pageid: chapterId.slice(7) }
        : { page: chapterId.slice(6) }
    var page = this.parse(params)
    var paragraphs = this.host
      .select(page.text, 'p')
      .map(function (item) {
        return item.text.trim()
      })
      .filter(function (text) {
        return text.length > 1
      })
    if (!paragraphs.length) throw new Error('本页未取得可读段落，请选择具体章节。')
    return paragraphs.join('\n\n')
  },
})
