import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { deleteMessageRound, deleteMessages, selectMessageVersion } from '../../services/chat/store.js'
import { useHistoryTarget } from '../../services/chat/historySearch.js'
import type { AssistantMessage as AssistantReply, Message, Session } from '../../services/chat/types.js'
import { addFavoriteMessages } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconChevronDownOutline14, IconHeartOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { UserMessage } from './UserMessage.js'
import styles from './MessageList.module.css'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages[messages.length - 1]
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
const MESSAGE_PAGE_SIZE = 24
const MESSAGE_WINDOW_SIZE = MESSAGE_PAGE_SIZE * 2

type MessageWindow = { start: number; end: number }

const windowAround = (index: number, length: number): MessageWindow => {
  const start = Math.max(0, Math.min(index - MESSAGE_PAGE_SIZE / 2, length - MESSAGE_PAGE_SIZE))
  return { start, end: Math.min(length, start + MESSAGE_PAGE_SIZE) }
}

export const MessageList = ({
  session,
  streaming,
  footer,
  jumpRequest = 0,
}: {
  session: Session
  streaming: boolean
  jumpRequest?: number
  footer: ((latestReply: AssistantReply | undefined) => React.ReactNode) | null
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const searchTarget = useHistoryTarget()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const scrollFrameRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const historyAnchorRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = useMemo(() => getVisibleMessages(session), [session])
  let latestReply: AssistantReply | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'assistant') {
      latestReply = message
      break
    }
  }
  const [historyWindow, setHistoryWindow] = useState<MessageWindow | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteRoundId, setDeleteRoundId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const chooseMessages = useCallback((id: string) => setSelected(new Set([id])), [])
  const chooseRound = useCallback((id: string) => setDeleteRoundId(id), [])
  const previousVersions = useRef<ReadonlyMap<string, MessageVersions>>(new Map())
  const previousLastMessageId = useRef<string>()
  const lastMessageId = messages[messages.length - 1]?.id
  const targetIndex =
    searchTarget.sessionId === session.id
      ? messages.findIndex((message) => message.id === searchTarget.messageId)
      : -1
  const branchIndex = restoreScrollRef.current
    ? messages.findIndex((message) => message.id === restoreScrollRef.current?.messageId)
    : -1
  const recentWindow = { start: Math.max(0, messages.length - MESSAGE_PAGE_SIZE), end: messages.length }
  const readingWindow = historyWindow && historyWindow.end <= messages.length
    ? historyWindow
    : recentWindow
  const anchorIndex = targetIndex >= 0 ? targetIndex : branchIndex
  const { start, end } = anchorIndex >= 0 &&
    (anchorIndex < readingWindow.start || anchorIndex >= readingWindow.end)
    ? windowAround(anchorIndex, messages.length)
    : readingWindow
  const shown = useMemo(() => messages.slice(start, end), [messages, start, end])
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions.current, shown),
    [session, shown]
  )
  useLayoutEffect(() => {
    previousVersions.current = versions
  }, [versions])

  useLayoutEffect(() => {
    if (targetIndex < 0 || !searchTarget.messageId) {
      return
    }
    const node = contentRef.current?.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(searchTarget.messageId)}"]`)
    if (node) {
      setSelected(null)
      setConfirmDelete(false)
      stickyRef.current = false
      setHistoryWindow({ start, end })
      node.scrollIntoView({ block: 'center' })
      const scroll = scrollRef.current
      if (scroll) {
        scrollTopRef.current = scroll.scrollTop
        setAtBottom(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICKY_THRESHOLD)
      }
      useHistoryTarget.setState({ sessionId: null, messageId: null })
    }
  }, [searchTarget, start, end, targetIndex])
  const scrollToBottom = useCallback(() => {
    if (scrollFrameRef.current || !stickyRef.current) {
      return
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      const el = scrollRef.current
      if (el && stickyRef.current) {
        const top = Math.max(0, el.scrollHeight - el.clientHeight)
        if (el.scrollTop !== top) {
          el.scrollTop = top
        }
        scrollTopRef.current = top
        setAtBottom(true)
      }
    })
  }, [])

  const jumpToLatest = () => {
    historyAnchorRef.current = null
    stickyRef.current = true
    setHistoryWindow(null)
    scrollToBottom()
  }

  const lastJumpRequest = useRef(jumpRequest)
  useLayoutEffect(() => {
    if (lastJumpRequest.current === jumpRequest) {
      return
    }
    lastJumpRequest.current = jumpRequest
    stickyRef.current = false
    historyAnchorRef.current = null
    restoreScrollRef.current = null
    useHistoryTarget.setState({ sessionId: null, messageId: null })
    setHistoryWindow({ start: 0, end: Math.min(messages.length, MESSAGE_PAGE_SIZE) })
    setAtBottom(false)
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
      scrollTopRef.current = 0
    }
  }, [jumpRequest, messages.length])

  useEffect(
    () => () => {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = 0
    },
    []
  )

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    if (previousLastMessageId.current === lastMessageId) {
      return
    }
    previousLastMessageId.current = lastMessageId
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      scrollTopRef.current = scroll.scrollTop
      restoreScrollRef.current = null
      setHistoryWindow({ start, end })
      return
    }
    if (targetIndex < 0) {
      setHistoryWindow(null)
      stickyRef.current = true
      scrollToBottom()
    }
    // 分页保持阅读位置，新消息才跟随到最新一轮。
  }, [lastMessageId, start, end, targetIndex, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  const firstShownId = shown[0]?.id
  const lastShownId = shown[shown.length - 1]?.id
  const count = messages.length
  const showHistory = useCallback((direction: 'older' | 'newer') => {
    const older = direction === 'older'
    const messageId = older ? firstShownId : lastShownId
    if (!messageId || (older ? start === 0 : end === count)) {
      return
    }
    const node = contentRef.current?.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(messageId)}"]`)
    if (node) {
      historyAnchorRef.current = { messageId, top: node.getBoundingClientRect().top }
    }
    stickyRef.current = false
    if (older) {
      const nextStart = Math.max(0, start - MESSAGE_PAGE_SIZE)
      setHistoryWindow({ start: nextStart, end: Math.min(count, nextStart + MESSAGE_WINDOW_SIZE) })
    } else {
      const nextEnd = Math.min(count, end + MESSAGE_PAGE_SIZE)
      setHistoryWindow({ start: Math.max(0, nextEnd - MESSAGE_WINDOW_SIZE), end: nextEnd })
    }
  }, [firstShownId, lastShownId, count, start, end])

  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const node = contentRef.current?.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(anchor.messageId)}"]`)
      if (node) {
        scroll.scrollTop += node.getBoundingClientRect().top - anchor.top
      }
      scrollTopRef.current = scroll.scrollTop
      historyAnchorRef.current = null
    }
  }, [start, end])

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollTopRef.current = el.scrollTop
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
  }, [isMobile, scrollToBottom])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      setAtBottom(nearBottom)
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      const movedUp = el.scrollTop < scrollTopRef.current
      if (nearBottom && end === messages.length) {
        stickyRef.current = true
      } else if (movedUp) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      if (start > 0 && movedUp && el.scrollTop < STICKY_THRESHOLD && !historyAnchorRef.current) {
        showHistory('older')
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, start, end, messages.length, showHistory])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const favoriteSelected = () => {
    if (selected?.size && !streaming) {
      addFavoriteMessages(session.id, [...selected])
      setSelected(null)
      showToast({ key: 'messagesFavorited' })
    }
  }
  const deleteSelected = async () => {
    if (!selected?.size || streaming || deleting) {
      return
    }
    setDeleting(true)
    try {
      if (await deleteMessages(session.id, [...selected])) {
        setSelected(null)
        setConfirmDelete(false)
      } else {
        showToast({ key: 'messageDeleteFailed', type: 'error' })
      }
    } catch {
      showToast({ key: 'messageDeleteFailed', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }
  const deleteRound = async () => {
    if (!deleteRoundId || streaming || deleting) {
      return
    }
    setDeleting(true)
    try {
      if (await deleteMessageRound(session.id, deleteRoundId)) {
        setDeleteRoundId(null)
      } else {
        showToast({ key: 'messageDeleteFailed', type: 'error' })
      }
    } catch {
      showToast({ key: 'messageDeleteFailed', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }
  return (
    <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
      <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
        <div ref={contentRef} className={styles.column}>
          {start > 0 ? (
            <Button variant="outlined" size="s" className={styles.historyButton} onClick={() => showHistory('older')}>
              {t('showOlderMessages')}
            </Button>
          ) : null}
          {shown.map((message, offset) => {
            const index = start + offset
            const content = message.role === 'user' ? (
              <UserMessage
                sessionId={session.id}
                message={message}
                retryUploadId={uploadRetryId}
                isFirst={index === 0}
                isLast={index === lastIndex || index === lastIndex - 1}
                busy={streaming}
                versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                onSelectVersion={selectVersion}
                onMultiSelect={selected ? undefined : chooseMessages}
                onDelete={selected ? undefined : chooseRound}
              />
            ) : (
              <AssistantMessage
                sessionId={session.id}
                message={message}
                isLast={index === lastIndex}
                streaming={streaming && index === lastIndex}
                busy={streaming}
                versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                onSelectVersion={selectVersion}
                onMultiSelect={selected ? undefined : chooseMessages}
                onDelete={selected ? undefined : chooseRound}
              />
            )
            return (
              <div key={message.id} className={selected ? styles.selectableMessage : undefined}>
                <div aria-hidden={selected ? true : undefined} {...(selected ? { inert: '' } : {})}>{content}</div>
                {selected ? (
                  <label className={styles.messageCheckbox}>
                    <input
                      type="checkbox"
                      aria-label={t(message.role === 'user' ? 'selectUserMessage' : 'selectAssistantMessage', { number: index + 1 })}
                      checked={selected.has(message.id)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked
                        setSelected((previous) => {
                          const next = new Set(previous)
                          if (checked) {
                            next.add(message.id)
                          } else {
                            next.delete(message.id)
                          }
                          return next
                        })
                      }}
                    />
                  </label>
                ) : null}
              </div>
            )
          })}
          {end < messages.length ? (
            <Button variant="outlined" size="s" className={styles.historyButton} onClick={() => showHistory('newer')}>
              {t('showNewerMessages')}
            </Button>
          ) : null}
        </div>
      </div>
      <div className={styles.footer}>
        {(!atBottom || end < messages.length) && (
          <IconButton
            icon={<IconChevronDownOutline14 />}
            size="xl"
            tone="primary"
            tooltip={t('jumpToLatest')}
            className={styles.jumpToLatest}
            onClick={jumpToLatest}
          />
        )}
        <div hidden={selected !== null}>{footer?.(latestReply)}</div>
        {selected ? (
          <div className={styles.selectionBar} role="group" aria-label={t('messageMultiSelect')}>
            <span role="status">{t('messagesSelected', { count: selected.size })}</span>
            <Button size="s" variant="outlined" onClick={() => setSelected(null)}>{t('cancel')}</Button>
            <Button size="s" className={styles.selectionAction} disabled={!selected.size || streaming} onClick={favoriteSelected}>
              <IconHeartOutline16 /> {t('favoriteAction')}
            </Button>
            <Button size="s" variant="dangerOutlined" className={styles.selectionAction}
              disabled={!selected.size || streaming} onClick={() => setConfirmDelete(true)}>
              <IconTrashOutline16 /> {t('delete')}
            </Button>
          </div>
        ) : null}
      </div>
      {confirmDelete && selected ? (
        <Modal title={t('deleteMessagesTitle')} onClose={() => { if (!deleting) { setConfirmDelete(false) } }}
          footer={
            <>
              <Button variant="outlined" disabled={deleting} onClick={() => setConfirmDelete(false)}>{t('cancel')}</Button>
              <Button variant="danger" disabled={deleting} onClick={() => void deleteSelected()}>{t('delete')}</Button>
            </>
          }
        >
          {t('deleteMessagesConfirmation', { count: selected.size })}
        </Modal>
      ) : null}
      {deleteRoundId ? (
        <Modal title={t('deleteMessageRound')} onClose={() => { if (!deleting) { setDeleteRoundId(null) } }}
          footer={
            <>
              <Button variant="outlined" disabled={deleting} onClick={() => setDeleteRoundId(null)}>{t('cancel')}</Button>
              <Button variant="danger" disabled={deleting || streaming} onClick={() => void deleteRound()}>{t('delete')}</Button>
            </>
          }
        >
          {t('deleteMessageRoundConfirmation')}
        </Modal>
      ) : null}
    </div>
  )
}
