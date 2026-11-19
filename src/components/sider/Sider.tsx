import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconDataOutline16, IconHeartOutline16, IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed, useSettings } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, openHistoryMatch, removeSession, useChatStore } from '../../services/chat/store.js'
import { searchHistory, type HistoryMatch } from '../../services/chat/historySearch.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { FavoriteMessages } from './FavoriteMessages.js'
import { openPlans } from '../platform/plansDialogState.js'
import { useUpdateState } from '../../services/appUpdates.js'
import styles from './Sider.module.css'

const HISTORY_PAGE_SIZE = 50

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const locale = useSettings((state) => state.locale)
  const hasUpdate = useUpdateState((state) => state.hasUpdate)
  const pinnedIds = useSettings((state) => state.pinnedSessionIds)
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const [showFavorites, setShowFavorites] = useState(false)
  const groups = useMemo(() => groupSessions(sessions, now, t, pinnedIds), [sessions, now, t, pinnedIds])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HistoryMatch[]>([])
  const [searchStatus, setSearchStatus] = useState<'searching' | 'done' | 'failed' | 'cancelled'>('done')
  const [oldestFirst, setOldestFirst] = useState(false)
  const [resultLimit, setResultLimit] = useState(HISTORY_PAGE_SIZE)
  const searchController = useRef<AbortController>()
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }), [locale])
  const page = oldestFirst ? results.slice(-resultLimit).reverse() : results.slice(0, resultLimit)
  useEffect(() => {
    const controller = new AbortController()
    searchController.current = controller
    setResults([])
    setResultLimit(HISTORY_PAGE_SIZE)
    setSearchStatus(query.trim() ? 'searching' : 'done')
    if (!query.trim()) {
      return () => controller.abort()
    }
    const timer = setTimeout(() => {
      void searchHistory(query, useChatStore.getState().sessionCache,
        new Set(sessions.map((session) => session.id)), controller.signal)
        .then((matches) => {
          if (!controller.signal.aborted) {
            setResults(matches)
            setSearchStatus('done')
          }
        }).catch(() => {
          if (!controller.signal.aborted) {
            setSearchStatus('failed')
          }
        })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, sessions])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const renderSession = (session: SessionSummary) => (
    <SessionItem
      key={session.id}
      session={session}
      active={session.id === activeId}
      pinned={pinnedSet.has(session.id)}
      onDelete={() => setDeleting(session)}
    />
  )

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <input type="search" className={styles.historySearch} value={query}
          aria-label={t('historySearchPlaceholder')} placeholder={t('historySearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)} />
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          setShowFavorites(false)
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <button
        type="button"
        className={clsx(styles.settings, styles.favoritesEntry)}
        aria-pressed={showFavorites && !query.trim()}
        onClick={() => {
          setShowFavorites(!showFavorites || !!query.trim())
          setQuery('')
        }}
      >
        <span className={styles.settingsIcon}>
          <IconHeartOutline16 filled={showFavorites && !query.trim()} />
        </span>
        <span className={styles.settingsLabel}>{t('messageFavorites')}</span>
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {query.trim() ? (
            <div className={styles.searchResults}>
              <div role="status" className={styles.sectionHeader}>
                {t(searchStatus === 'searching' ? 'historySearching'
                  : searchStatus === 'failed' ? 'historySearchFailed'
                  : searchStatus === 'cancelled' ? 'historySearchCancelled'
                  : 'historySearchCount', { count: results.length })}
              </div>
              {searchStatus === 'searching' ? (
                <Button className={styles.searchMore} size="s" variant="outlined" onClick={() => {
                  searchController.current?.abort()
                  setSearchStatus('cancelled')
                }}>{t('cancel')}</Button>
              ) : null}
              {results.length ? (
                <div className={styles.searchControls}>
                  <select aria-label={t('historySearchSort')} value={oldestFirst ? 'oldest' : 'newest'} onChange={(event) => {
                    setOldestFirst(event.currentTarget.value === 'oldest')
                    setResultLimit(HISTORY_PAGE_SIZE)
                  }}>
                    <option value="newest">{t('historySearchNewest')}</option>
                    <option value="oldest">{t('historySearchOldest')}</option>
                  </select>
                </div>
              ) : null}
              {page.map((match) => (
                <button type="button" key={JSON.stringify([match.sessionId, match.messageId])} className={styles.searchResult} onClick={() => {
                  void openHistoryMatch(match.sessionId, match.messageId)
                  closeMobileSider()
                }}>
                  <strong>{match.title || t('untitledChat')}</strong>
                  {match.excerpt ? <span>{match.excerpt}</span> : null}
                  {Number.isFinite(match.timestamp) ? <time>{formatter.format(match.timestamp)}</time> : null}
                </button>
              ))}
              {resultLimit < results.length ? (
                <Button className={styles.searchMore} size="s" variant="outlined" onClick={() => setResultLimit((limit) => limit + HISTORY_PAGE_SIZE)}>
                  {t('historySearchMore')}
                </Button>
              ) : null}
            </div>
          ) : showFavorites ? (
            <FavoriteMessages sessions={sessions} />
          ) : groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map(renderSession)}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={openPlans}>
          <span className={styles.settingsIcon}>
            <IconDataOutline16 />
          </span>
          <span className={styles.settingsLabel}>方案</span>
        </button>
        <button type="button" className={styles.settings}
          title={hasUpdate ? t('updateAutoAvailable') : undefined}
          onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>
            {t('settings')}
            {hasUpdate ? <span className={styles.updateDot} aria-hidden="true" /> : null}
          </span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  return (
    <>
      <div className={clsx(styles.drawerMask, open && styles.drawerMaskOpen)} data-mobile-drawer-layer
        aria-hidden="true" onClick={closeMobileSider} />
      <div className={clsx(styles.drawer, open && styles.drawerOpen)} data-mobile-drawer-layer
        data-mobile-drawer-panel aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
        <Sider mobile />
      </div>
    </>
  )
}
