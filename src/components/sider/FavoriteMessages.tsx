import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { loadSession } from '../../services/chat/db.js'
import { openHistoryMatch, useChatStore } from '../../services/chat/store.js'
import type { Message, SessionSummary } from '../../services/chat/types.js'
import { favoriteMessageKey, removeFavoriteMessages, useSettings } from '../../services/settings.js'
import { hasOwn } from '../../utils/object.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconHeartOutline16 } from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './Sider.module.css'

const PAGE_SIZE = 30
const PREVIEW_LENGTH = 160
type Preview = { role: Message['role']; text: string; fileName?: string }

const preview = (message: Message): Preview => {
  if (message.role === 'user') {
    const text = message.content.slice(0, PREVIEW_LENGTH).trim()
    return { role: message.role, text, fileName: message.files[0]?.name }
  }
  // Start at the first visible answer block; don't copy long responses or hidden reasoning.
  const part = message.blocks.find((block) => block.type === 'text' && block.text.slice(0, PREVIEW_LENGTH).trim())
  return { role: message.role, text: part?.type === 'text' ? part.text.slice(0, PREVIEW_LENGTH).trim() : '' }
}

export const FavoriteMessages = ({ sessions }: { sessions: SessionSummary[] }) => {
  const t = useTranslate()
  const favorites = useSettings((state) => state.favoriteMessages)
  const streaming = useChatStore((state) => state.streaming)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [previews, setPreviews] = useState<Map<string, Preview> | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const page = favorites.slice(0, limit)

  useEffect(() => {
    let cancelled = false
    const resolve = async () => {
      const groups = new Map<string, Set<string>>()
      for (const favorite of favorites.slice(0, limit)) {
        const ids = groups.get(favorite.sessionId) ?? new Set<string>()
        ids.add(favorite.messageId)
        groups.set(favorite.sessionId, ids)
      }
      const result = new Map<string, Preview>()
      const available = new Set(sessions.map(({ id }) => id))
      for (const [sessionId, ids] of groups) {
        if (!available.has(sessionId)) {
          continue
        }
        const cache = useChatStore.getState().sessionCache
        const session = (hasOwn(cache, sessionId) ? cache[sessionId] : undefined) ?? await loadSession(sessionId)
        if (cancelled) {
          return
        }
        for (const message of session?.messages ?? []) {
          if (ids.delete(message.id)) {
            result.set(favoriteMessageKey({ sessionId, messageId: message.id }), preview(message))
          }
          if (!ids.size) {
            break
          }
        }
      }
      if (!cancelled) {
        setPreviews(result)
      }
    }
    setFailed(false)
    void resolve().catch(() => {
      if (!cancelled) {
        setFailed(true)
      }
    })
    return () => { cancelled = true }
  }, [favorites, limit, retry, sessions])

  const titles = new Map(sessions.map(({ id, title }) => [id, title]))
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>{t('messageFavorites')}</div>
      {favorites.length === 0 ? (
        <p className={styles.favoritesEmpty}>{t('messageFavoritesEmpty')}</p>
      ) : failed ? (
        <Button className={styles.searchMore} size="s" variant="outlined" onClick={() => setRetry((value) => value + 1)}>
          {t('messageFavoritesRetry')}
        </Button>
      ) : !previews ? (
        <p className={styles.favoritesEmpty} role="status">{t('messageFavoritesLoading')}</p>
      ) : page.map((favorite) => {
        const key = favoriteMessageKey(favorite)
        const data = previews.get(key)
        return (
          <div key={key} className={styles.favoriteRow}>
            <button type="button" className={styles.searchResult} disabled={!data || !!streaming[favorite.sessionId]} onClick={() => {
              void openHistoryMatch(favorite.sessionId, favorite.messageId)
              closeMobileSider()
            }}>
              <strong>{titles.get(favorite.sessionId) || t('untitledChat')}</strong>
              <span>{data ? t(data.role === 'user' ? 'favoriteUserPreview' : 'favoriteAssistantPreview', {
                text: data.text || data.fileName || t('favoriteNoText'),
              }) : t('favoriteMessageUnavailable')}</span>
            </button>
            <IconButton icon={<IconHeartOutline16 filled />} tooltip={t('messageFavoriteRemove')}
              onClick={() => removeFavoriteMessages(favorite.sessionId, [favorite.messageId])} />
          </div>
        )
      })}
      {!failed && limit < favorites.length ? (
        <Button className={styles.searchMore} size="s" variant="outlined" onClick={() => setLimit(limit + PAGE_SIZE)}>
          {t('historySearchMore')}
        </Button>
      ) : null}
    </div>
  )
}
