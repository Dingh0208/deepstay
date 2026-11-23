import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { IconEditOutline16, IconListCheckOutline16, IconTrashOutline16 } from '../base/icons.js'
import { retryUpload, setFileContextExcluded } from '../../services/chat/store.js'
import type { UserMessage as UserMessageType } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageFile } from './MessageFile.js'
import { MessageActions } from './MessageActions.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  versions,
  onSelectVersion,
  onMultiSelect,
  onDelete,
  onEditMessage,
  editingTarget,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
  onMultiSelect?: (id: string) => void
  onDelete?: (id: string) => void
  onEditMessage: (message: UserMessageType) => void
  editingTarget: boolean
}) {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const select = onMultiSelect && !busy && !editingTarget ? () => onMultiSelect(message.id) : undefined
  const remove = onDelete && !busy && !editingTarget ? () => onDelete(message.id) : undefined

  return (
    <MessageActions
      className={clsx(styles.container, isFirst && styles.isFirst, editingTarget && styles.editingTarget)}
      messageId={message.id}
      text={message.content}
      onEdit={busy || editingTarget ? undefined : () => onEditMessage(message)}
      onMultiSelect={select}
      onDelete={remove}
    >
      {message.files.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            message.files.some((file) => !file.isImage) && styles.filesWithDocuments
          )}
        >
          {message.files.map((file) => (
            <MessageFile
              key={file.id}
              file={file}
              onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
              onToggleContext={file.isImage ? undefined : () => {
                void setFileContextExcluded(sessionId, file.id, !file.contextExcluded)
              }}
              busy={busy}
            />
          ))}
        </div>
      ) : null}
      {message.content ? <div className={styles.bubble}>{message.content}</div> : null}
      <div className={styles.bottom}>
        <div className={clsx(styles.actions, (isLast || (isMobile && !message.content)) && styles.alwaysShow)}>
          {message.content ? <CopyButton text={message.content} /> : null}
          <IconButton
            icon={<IconEditOutline16 />}
            tooltip={t('editMessage')}
            tooltipPlacement="bottom"
            disabled={busy || editingTarget}
            onClick={() => onEditMessage(message)}
          />
          {select && (!isMobile || !message.content) ? (
            <IconButton icon={<IconListCheckOutline16 />} tooltip={t('messageMultiSelect')} tooltipPlacement="bottom" onClick={select} />
          ) : null}
          {remove ? (
            <IconButton icon={<IconTrashOutline16 />} tooltip={t('deleteMessageRound')} tooltipPlacement="bottom" onClick={remove} />
          ) : null}
        </div>
        <BranchSwitcher versions={versions} disabled={busy || editingTarget} onSelect={onSelectVersion} />
      </div>
    </MessageActions>
  )
})
