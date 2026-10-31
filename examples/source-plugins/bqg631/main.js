/* global registerSource, CryptoJS */
// Public website client protocol, inspected from /js/common.js and /js/read.js on 2026-10-29.
// This plugin does not log in, create accounts, solve verification, or retry through other domains.
registerSource({
  id: 'text',

  website: 'https://www.bqg631.xyz',
  chapterApi: 'https://apibi.cc',

  resourceId: function (value) {
    var id = String(value)
    if (!/^[1-9]\d{0,8}$/.test(id)) throw new Error('网站书籍或章节编号无效。')
    return id
  },

  pageOffset: function (cursor, maximum) {
    var offset = cursor === undefined || cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0 || offset > maximum)
      throw new Error('网站分页位置无效，请重新搜索。')
    return offset
  },

  api: function (path) {
    return this.host.getJson(this.website + '/api/' + path)
  },

  bookValue: function (value, expectedId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('网站书目信息格式已变化。')
    var id = this.resourceId(value.id)
    if (expectedId && id !== expectedId) throw new Error('网站返回了不同的书籍编号。')
    if (typeof value.title !== 'string' || !value.title.trim())
      throw new Error('网站没有返回书名。')
    return {
      id: id,
      title: value.title.trim(),
      authors: typeof value.author === 'string' && value.author ? [value.author] : [],
      description:
        typeof value.intro === 'string' ? value.intro.replace(/<[^>]*>/g, '').trim() : '',
      // Website pages use a # route. SDK navigation URLs currently retain the safe homepage.
      pageUrl: this.website + '/',
      coverUrl: this.website + '/bookimg/' + Math.floor(Number(id) / 1000) + '/' + id + '.jpg',
    }
  },

  search: function (query, cursor) {
    var text = String(query || '').trim()
    if (!text) throw new Error('请输入书名或作者。')
    var offset = this.pageOffset(cursor, 100000)
    var result = this.api('search?q=' + encodeURIComponent(text))
    if (!result || !Array.isArray(result.data)) throw new Error('网站搜索接口格式已变化。')
    if (result.data.length > 100000) throw new Error('搜索结果过多，请缩小关键词。')
    return {
      items: result.data.slice(offset, offset + 80).map(function (book) {
        return this.bookValue(book)
      }, this),
      nextCursor: offset + 80 < result.data.length ? String(offset + 80) : null,
    }
  },

  getBook: function (bookId) {
    var id = this.resourceId(bookId)
    return this.bookValue(this.api('book?id=' + encodeURIComponent(id)), id)
  },

  getChapters: function (bookId, cursor) {
    var id = this.resourceId(bookId)
    var offset = this.pageOffset(cursor, 100000)
    var metadata = this.api('book?id=' + encodeURIComponent(id))
    var directoryId = this.resourceId(metadata.dirid || id)
    var result = this.api('booklist?id=' + encodeURIComponent(directoryId))
    if (!result || !Array.isArray(result.list) || result.list.length > 100000)
      throw new Error('网站章节目录格式已变化。')
    return {
      items: result.list.slice(offset, offset + 1000).map(function (title, index) {
        if (typeof title !== 'string' || !title.trim()) throw new Error('网站章节标题无效。')
        return { id: String(offset + index + 1), title: title.trim() }
      }),
      nextCursor: offset + 1000 < result.list.length ? String(offset + 1000) : null,
    }
  },

  chapterRequest: function (bookId, chapterId) {
    // The public web client derives request encoding from a public fixed phrase.
    // These bytes are not an account password, cookie, or access grant.
    var digest = CryptoJS.MD5(['book', 'token.html'].join('@')).toString()
    var encoded = CryptoJS.AES.encrypt(
      JSON.stringify({
        id: Number(this.resourceId(bookId)),
        chapterid: Number(this.resourceId(chapterId)),
      }),
      CryptoJS.enc.Utf8.parse(digest.slice(16)),
      {
        iv: CryptoJS.enc.Utf8.parse(digest.slice(0, 16)),
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      },
    ).toString()
    return this.chapterApi + '/api/chapter?token=' + encodeURIComponent(encoded)
  },

  getChapterText: function (bookId, chapterId) {
    var id = this.resourceId(bookId),
      chapter = this.resourceId(chapterId)
    var result = this.host.getJson(this.chapterRequest(id, chapter), {
      headers: { Referer: this.website + '/' },
    })
    if (
      !result ||
      String(result.id) !== id ||
      String(result.chapterid) !== chapter ||
      typeof result.txt !== 'string'
    )
      throw new Error('网站返回的正文身份或格式无效。')
    var text = result.txt.trim()
    if (text.length < 10) throw new Error('此章节暂未返回可读正文。')
    return text
  },
})
