import { useId, useMemo, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { IconSearchOutline16 } from '../base/icons.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { createPortal } from 'react-dom'
import styles from './ReasoningEffortDialog.module.css'

export const REASONING_EFFORT_LEVELS = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
] as const

export type ReasoningEffortLevel = typeof REASONING_EFFORT_LEVELS[number]

const labels: Record<ReasoningEffortLevel, TranslationKey> = {
  none: 'reasoningEffortNone',
  minimal: 'reasoningEffortMinimal',
  low: 'reasoningEffortLow',
  medium: 'reasoningEffortMedium',
  high: 'reasoningEffortHigh',
  xhigh: 'reasoningEffortXhigh',
  max: 'reasoningEffortMax',
  ultra: 'reasoningEffortUltra',
}

export const ReasoningEffortDialog = ({
  open,
  anchor,
  supportedLevels,
  selectedLevel,
  defaultLevel,
  loading,
  visibleLevels,
  customizable,
  onSelect,
  onVisibleLevelsChange,
  onClose,
}: {
  open: boolean
  anchor: HTMLButtonElement | null
  supportedLevels: readonly ReasoningEffortLevel[]
  selectedLevel: ReasoningEffortLevel | null
  defaultLevel: ReasoningEffortLevel | null
  loading: boolean
  visibleLevels: readonly ReasoningEffortLevel[]
  customizable: boolean
  onSelect: (level: ReasoningEffortLevel | null) => void
  onVisibleLevelsChange: (levels: ReasoningEffortLevel[]) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(open, {
    side: 'top',
    align: 'start',
    offset: 8,
  })
  anchorRef.current = anchor
  const searchId = useId()
  const [customizing, setCustomizing] = useState(false)
  const [search, setSearch] = useState('')
  const availableLevels = useMemo(() => {
    const supported = new Set(supportedLevels)
    const visible = new Set(visibleLevels)
    return REASONING_EFFORT_LEVELS.filter((level) => supported.has(level) &&
      (!customizable || visible.has(level)))
  }, [customizable, supportedLevels, visibleLevels])
  const choices: (ReasoningEffortLevel | null)[] = [null, ...availableLevels]
  const effectiveLevel = selectedLevel ?? defaultLevel
  const selectedIndex = effectiveLevel ? Math.max(1, availableLevels.indexOf(effectiveLevel) + 1) : 0
  const selectedChoice = choices[selectedIndex]
  useDismiss(open, [anchorRef, floatingRef], onClose, { captureEscape: true })
  const currentLevel = selectedLevel ?? defaultLevel
  const matchingLevels = REASONING_EFFORT_LEVELS.filter((level) => {
    const query = search.trim().toLocaleLowerCase()
    return !query || level.includes(query) || t(labels[level]).toLocaleLowerCase().includes(query)
  })

  if (!open) {
    return null
  }

  const toggleVisibleLevel = (level: ReasoningEffortLevel) => {
    const next = new Set(visibleLevels)
    if (next.has(level)) {
      if (next.size === 1) {
        return
      }
      next.delete(level)
    } else {
      next.add(level)
    }
    onVisibleLevelsChange(REASONING_EFFORT_LEVELS.filter((item) => next.has(item)))
  }

  return createPortal(
    <div
      ref={floatingRef}
      className={styles.popover}
      style={{ ...(position ?? {}), visibility: position ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label={t('reasoningEffortTitle')}
    >
      <div className={styles.header}>
        <div className={styles.current}>
          <strong>{currentLevel ? t(labels[currentLevel]) : t('reasoningEffortDefault')}</strong>
          <span>{t('reasoningEffortCurrent')}</span>
        </div>
        {customizable ? (
          <button
            type="button"
            className={styles.customize}
            aria-expanded={customizing}
            onClick={() => setCustomizing((value) => !value)}
          >
            {t('reasoningEffortCustomize')}
          </button>
        ) : null}
      </div>
      {loading ? (
        <p className={styles.empty}>{t('reasoningEffortLoading')}</p>
      ) : availableLevels.length > 0 ? (
        <div className={styles.sliderGroup}>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={choices.length - 1}
            step={1}
            value={selectedIndex}
            aria-label={t('reasoningEffortTitle')}
            aria-valuetext={selectedChoice ? t(labels[selectedChoice]) : t('reasoningEffortDefault')}
            disabled={choices.length < 2}
            onChange={(event) => onSelect(choices[Number(event.currentTarget.value)])}
          />
          <div className={styles.sliderLabels} aria-hidden="true">
            <span>{t('reasoningEffortDefault')}</span>
            <span>{t(labels[availableLevels[availableLevels.length - 1]])}</span>
          </div>
        </div>
      ) : (
        <p className={styles.empty}>{t('reasoningEffortUnavailable')}</p>
      )}
      {customizable && customizing ? (
            <section className={styles.customPanel} aria-label={t('reasoningEffortCustomize')}>
              <label className={styles.search} htmlFor={searchId}>
                <IconSearchOutline16 />
                <input
                  id={searchId}
                  type="search"
                  value={search}
                  placeholder={t('reasoningEffortSearch')}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
              </label>
              <div className={styles.checklist}>
                {matchingLevels.map((level) => (
                  <label key={level} className={styles.levelOption}>
                    <input
                      type="checkbox"
                      checked={visibleLevels.includes(level)}
                      disabled={visibleLevels.length === 1 && visibleLevels.includes(level)}
                      onChange={() => toggleVisibleLevel(level)}
                    />
                    <span>{t(labels[level])}</span>
                    <code>{level}</code>
                  </label>
                ))}
                {matchingLevels.length === 0 ? <p className={styles.empty}>{t('reasoningEffortNoResults')}</p> : null}
              </div>
            </section>
      ) : null}
    </div>,
    document.body
  )
}
