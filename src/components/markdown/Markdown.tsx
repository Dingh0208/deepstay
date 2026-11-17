import { memo, useMemo, useRef } from 'react'
import type { Root } from 'mdast'
import type { Source } from '../../services/chat/view.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const previousAst = useRef<Root | null>(null)
  const ast = useMemo(() => {
    const next = throttledMarkdown
      ? toMdAst(throttledMarkdown, { sources, disableLink }, previousAst.current)
      : null
    previousAst.current = next
    return next
  }, [throttledMarkdown, sources, disableLink])
  return ast ? (
    <MarkdownAstRenderer key={cacheKey} className={className} ast={ast} loading={loading} />
  ) : null
})
