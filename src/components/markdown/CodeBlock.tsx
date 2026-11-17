import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useState } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import { IconCheckOutline16, IconCopyOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

/** 代码块标题栏：左侧语言名，右侧复制 */
const CodeInfoRow = ({
  code,
  infostring,
  showDiagram,
  onToggleDiagram,
}: {
  code: string
  infostring: string
  showDiagram: boolean
  onToggleDiagram?: () => void
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.container}>
      {onToggleDiagram ? (
        <div className="md-code-block-switch" aria-label={t('mermaidSwitchLabel')}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showDiagram}
            onClick={() => !showDiagram && onToggleDiagram()}
          >
            {t('mermaidDiagram')}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={!showDiagram}
            onClick={() => showDiagram && onToggleDiagram()}
          >
            {t('mermaidCode')}
          </button>
        </div>
      ) : (
        <span className={styles.name}>{infostring}</span>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={async () => {
          if (!(await copyText(code))) {
            showToast({ key: 'copyFailed' })
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        <span>{t(copied ? 'copied' : 'copy')}</span>
      </button>
    </div>
  )
}

/** 流式代码先显示原文，完成后加载语言包并高亮，避免每个增量重算整段代码。 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
}: {
  code: string
  infostring: string
  loading?: boolean
}) {
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  const [showDiagram, setShowDiagram] = useState(true)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  const diagramVisible = isMermaid && showDiagram
  useEffect(() => {
    if (loading || diagramVisible || lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [loading, diagramVisible, lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    if (loading || diagramVisible || lang === null || !loaded) {
      return null
    }
    return Prism.highlight(code, Prism.languages[lang], lang)
  }, [code, loading, diagramVisible, lang, loaded])
  return (
    <div className="md-code-block">
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          showDiagram={showDiagram}
          onToggleDiagram={isMermaid ? () => setShowDiagram((show) => !show) : undefined}
        />
      </div>
      {diagramVisible ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : renderedHtml === null ? (
        <pre>{code}</pre>
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
      )}
    </div>
  )
})
