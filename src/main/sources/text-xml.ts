import { DOMParser } from '@xmldom/xmldom'
import { SourceError } from '../../shared/sources'

export function textXml(text: string, html = false): Document {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text))
    throw new SourceError('SOURCE_CHANGED', '书库 XML 含不支持的文档声明。')
  let broken = false
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => {
        broken = true
      },
      fatalError: () => {
        broken = true
      },
    },
  }).parseFromString(text, html ? 'text/html' : 'application/xml')
  if ((!html && broken) || !document.documentElement)
    throw new SourceError('SOURCE_CHANGED', '书库返回了无效 XML。')
  return document
}

export function childElements(node: Node, name?: string): Element[] {
  return Array.from(node.childNodes)
    .filter((child): child is Element => child.nodeType === 1)
    .filter((child) => !name || child.localName === name)
}

export function childText(node: Node, name: string): string {
  return cleanText(childElements(node, name)[0]?.textContent ?? '')
}

export function cleanText(value: string, limit = 4000): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}
