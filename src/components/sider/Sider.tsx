import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconDataOutline16, IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
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
import { openPlans } from '../platform/plansDialogState.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const pinnedIds = useSettings((state) => state.pinnedSessionIds)
  const groups = useMemo(() => groupSessions(sessions, now, t, pinnedIds), [sessions, now, t, pinnedIds])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HistoryMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setResults([])
    setSearchError(false)
    setSearching(!!query.trim())
    if (!query.trim()) {
      return () => controller.abort()
    }
    const timer = setTimeout(() => {
      void searchHistory(query, useChatStore.getState().sessionCache,
        new Set(sessions.map((session) => session.id)), controller.signal)
        .then((matches) => {
          if (!controller.signal.aborted) {
            setResults(matches)
          }
        }).catch(() => {
          if (!controller.signal.aborted) {
            setSearchError(true)
          }
        }).finally(() => {
          if (!controller.signal.aborted) {
            setSearching(false)
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
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {query.trim() ? (
            <div className={styles.searchResults}>
              <div role="status" className={styles.sectionHeader}>
                {t(searching ? 'historySearching' : searchError ? 'historySearchFailed' : 'historySearchCount', { count: results.length })}
              </div>
              {results.map((match) => (
                <button key={match.sessionId} className={styles.searchResult} onClick={() => {
                  void openHistoryMatch(match.sessionId, match.messageId)
                  closeMobileSider()
                }}>
                  <strong>{match.title || t('untitledChat')}</strong>
                  <span>{match.excerpt}</span>
                </button>
              ))}
            </div>
          ) : groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  pinned={group.key === 'pinned'}
                  onDelete={() => setDeleting(session)}
                />
              ))}
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
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
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
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
