export type Katex = typeof import('katex').default

const ARRAY_START = '\\begin{array}'
const ARRAY_END = '\\end{array}'

/** Identify a complete array with only optional TeX box decoration around it. */
export const getDisplayArray = (input: string): string | null => {
  const start = input.indexOf(ARRAY_START)
  const end = input.lastIndexOf(ARRAY_END)
  if (start < 0 || end <= start) {
    return null
  }
  const after = end + ARRAY_END.length
  const prefix = input.slice(0, start).trim()
  const suffix = input.slice(after).trim()
  return /^(?:\\(?:boxed|fbox)\{\s*|\\colorbox\{[^{}\r\n]*\}\{\s*|\\fcolorbox\{[^{}\r\n]*\}\{[^{}\r\n]*\}\{\s*)?\$?$/.test(
    prefix
  ) && /^\$?\s*\}*$/.test(suffix)
    ? input.slice(start, after)
    : null
}

export const renderFormula = (katex: Katex, input: string, displayMode: boolean): string => {
  const options = { throwOnError: true, strict: false, displayMode } as const
  try {
    return katex.renderToString(input, options)
  } catch (error) {
    const array = getDisplayArray(input)
    if (!array || array === input.trim()) {
      throw error
    }
    return katex.renderToString(array, options)
  }
}

let katex: Katex | null = null
let katexPromise: Promise<Katex> | null = null

/** 按需加载 KaTeX 及其样式、化学公式扩展；已加载时同步返回 */
export const ensureKatex = (): Katex | Promise<Katex> => {
  if (katex !== null) {
    return katex
  }
  katexPromise ??= Promise.all([
    import('katex'),
    import('katex/contrib/mhchem'),
    import('katex/dist/katex.min.css'),
  ]).then(([module]) => (katex = module.default))
  return katexPromise
}
