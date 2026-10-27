import { deflateRawSync, crc32 } from 'node:zlib'
export function zip(files: Record<string, string>, method = 8): Buffer {
  const locals: Buffer[] = [],
    directory: Buffer[] = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path),
      bytes = Buffer.from(text),
      compressed = method === 8 ? deflateRawSync(bytes) : bytes
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(bytes), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed)
    directory.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const end = Buffer.alloc(22),
    central = Buffer.concat(directory)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}
export const epub = {
  mimetype: 'application/epub+zip',
  'META-INF/container.xml':
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OPS/book.opf':
    '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
  'OPS/a.xhtml':
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第2章 远方</h1><p>这是书中的第二段正文。</p><script>危险脚本不会成为正文。</script><img src="https://example.test/never-fetch"/></body></html>',
  'OPS/b.xhtml':
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第1章 起点</h1><p>这是阅读顺序中的第一段正文。</p></body></html>',
}
