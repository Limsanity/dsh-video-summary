/**
 * 极简 markdown → React 渲染。
 *
 * 只覆盖总结里真会出现的语法:标题、段落、无序/有序列表、引用、代码块、水平线,
 * 以及行内的 **粗体** / `代码` / [链接](url)。不做 HTML 透传,避免注入。
 */
import { createElement as h } from 'react'

function inline(text, keyPrefix) {
  const nodes = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let index = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-i${index++}`
    if (token.startsWith('**')) {
      nodes.push(h('strong', { key }, token.slice(2, -2)))
    } else if (token.startsWith('`')) {
      nodes.push(h('code', { key, className: 'vs-code' }, token.slice(1, -1)))
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      nodes.push(
        h(
          'a',
          { key, href: link?.[2] ?? '#', target: '_blank', rel: 'noreferrer noopener', className: 'vs-link' },
          link?.[1] ?? token,
        ),
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes.length > 0 ? nodes : [text]
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r/g, '').split('\n')
  const blocks = []
  let list = null
  let paragraph = []
  let code = null
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(h('p', { key: `p${key++}`, className: 'vs-p' }, inline(paragraph.join(' '), `p${key}`)))
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      h(
        Tag,
        { key: `l${key++}`, className: 'vs-md-list' },
        list.items.map((item, i) => h('li', { key: `li${i}` }, inline(item, `l${key}-${i}`))),
      ),
    )
    list = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (code !== null) {
      if (/^\s*```/.test(line)) {
        blocks.push(h('pre', { key: `c${key++}`, className: 'vs-pre' }, code.join('\n')))
        code = null
      } else {
        code.push(raw)
      }
      continue
    }
    if (/^\s*```/.test(line)) {
      flushParagraph()
      flushList()
      code = []
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(6, heading[1].length + 2)
      blocks.push(h(`h${level}`, { key: `h${key++}`, className: `vs-h vs-h${level}` }, inline(heading[2], `h${key}`)))
      continue
    }

    if (/^>\s?/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push(h('blockquote', { key: `q${key++}`, className: 'vs-quote' }, inline(line.replace(/^>\s?/, ''), `q${key}`)))
      continue
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      flushParagraph()
      flushList()
      blocks.push(h('hr', { key: `hr${key++}`, className: 'vs-hr' }))
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1])
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[1])
      continue
    }

    paragraph.push(line.trim())
  }

  if (code !== null) blocks.push(h('pre', { key: `c${key++}`, className: 'vs-pre' }, code.join('\n')))
  flushParagraph()
  flushList()
  return blocks
}
