import clsx from 'clsx'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
  IconWarningOutline16,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { recordDiagnostic } from '../../services/diagnostics/log.js'
import {
  setChatFont,
  setChatFontSize,
  setLocale,
  setThemePreference,
  setTtsVoice,
  useSettings,
  bundledChatFonts,
  getChatFontFamily,
  type ChatFont,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select, type SelectOption } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { ChatBackgroundSetting, ThinkingCollapseSetting } from './AppearanceSetting.js'
import { ContextMemorySetting } from './ContextMemorySetting.js'
import { DiagnosticsSetting } from './DiagnosticsSetting.js'
import { GenerationSetting, ReplyPreferenceSettings } from './GenerationSetting.js'
import { UpdateSetting } from './UpdateSetting.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'appearance', label: 'settingsAppearance', icon: <IconLightOutline16 /> },
  { value: 'chat', label: 'settingsChat', icon: null },
  { value: 'api', label: 'settingsApi', icon: null },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'diagnostics', label: 'settingsDiagnostics', icon: <IconWarningOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyBusy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" aria-label={t('settings')} className={styles.navigation}>
          {sections.map((item, index) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`settings-tab-${item.value}`}
              aria-controls="settings-panel"
              aria-selected={section === item.value}
              tabIndex={section === item.value ? 0 : -1}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => {
                if (!historyBusy) {
                  setSection(item.value)
                }
              }}
              onKeyDown={(event) => {
                if (historyBusy) {
                  return
                }
                const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 :
                  event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0
                const target = event.key === 'Home' ? sections[0] : event.key === 'End' ? sections[sections.length - 1] :
                  direction ? sections[(index + direction + sections.length) % sections.length] : null
                if (!target) {
                  return
                }
                event.preventDefault()
                setSection(target.value)
                document.getElementById(`settings-tab-${target.value}`)?.focus()
              }}
            >
              <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>
              {t(item.label)}
            </button>
          ))}
        </div>
        <div key={section} id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`} className={styles.content}>
          {section === 'general' && (
            <>
              <LocaleSetting />
              <UpdateSetting />
            </>
          )}
          {section === 'appearance' && (
            <>
              <ThemeSetting />
              <TypographySetting />
              <ChatBackgroundSetting />
            </>
          )}
          {section === 'chat' && (
            <>
              <ThinkingCollapseSetting />
              <ContextMemorySetting />
              <GenerationSetting />
              <ReplyPreferenceSettings />
              <TtsVoiceSetting />
            </>
          )}
          {section === 'api' && <ApiKeyField editor={apiKeyEditor} />}
          {section === 'diagnostics' && <DiagnosticsSetting />}
          {section === 'data' && (
            <>
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      recordDiagnostic({ area: 'history', operation: 'delete', outcome: 'ok' })
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      recordDiagnostic({ area: 'history', operation: 'delete', outcome: 'failed' })
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const TypographySetting = () => {
  const t = useTranslate()
  const font = useSettings((state) => state.chatFont)
  const size = useSettings((state) => state.chatFontSize)
  const system = t('avatarMenuSettingsDialogThemeSelectSystemOption')
  const chineseFonts = ['ma-shan-zheng', 'noto-sans-sc', 'noto-serif-sc']
  const fontOptions: SelectOption<ChatFont>[] = [
    { value: 'system', label: system },
    { value: 'serif', label: t('chatFontSerif') },
    { value: 'mono', label: t('chatFontMono') },
    ...bundledChatFonts.map((item) => ({
      value: item.value,
      label: item.value === 'ma-shan-zheng' ? t('chatFontMaShanZheng') :
        item.value === 'noto-sans-sc' ? t('chatFontNotoSansSC') :
          item.value === 'noto-serif-sc' ? t('chatFontNotoSerifSC') : `${item.label} · ${t('chatFontLatin')}`,
    })),
  ]
  return (
    <>
      <SettingCell label={t('chatFont')} status={null} action={
        <Select ariaLabel={t('chatFont')} value={font} onChange={setChatFont} options={fontOptions} />
      } />
      <SettingCell label={t('chatFontSize')} status={null} action={
        <Select ariaLabel={t('chatFontSize')} value={size} onChange={setChatFontSize} options={[
          { value: 'system', label: system },
          { value: 'small', label: t('chatFontSmall') },
          { value: 'normal', label: t('chatFontNormal') },
          { value: 'large', label: t('chatFontLarge') },
          { value: 'extraLarge', label: t('chatFontExtraLarge') },
        ]} />
      } />
      <div className={styles.fontPreview} aria-live="polite">
        <p style={{ fontFamily: getChatFontFamily(font) }}>
          Aa 你好，DeepStay · 0123456789
        </p>
        {bundledChatFonts.some((item) => item.value === font) && !chineseFonts.includes(font) ? (
          <small>{t('chatFontLatinFallback')}</small>
        ) : null}
      </div>
    </>
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 新增导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="outlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先确认；确认后串行导入，成功新增会话，失败保留原有记录。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [progress, setProgress] = useState(0)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setProgress(0)
    setStatus(null)
    try {
      const count = await importHistory(file, setProgress)
      recordDiagnostic({ area: 'history', operation: 'import', outcome: 'ok' })
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      recordDiagnostic({ area: 'history', operation: 'import', outcome: 'failed' })
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, progress, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入作为独立会话新增，保留本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <SettingCell
        label={t('historyImport')}
        description={t('historyImportDescription')}
        status={historyImport.status}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              aria-busy={historyImport.busy}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t(historyImport.busy ? 'historyImporting' : 'upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  historyImport.select(file)
                }
              }}
            />
          </>
        }
      />
      {historyImport.busy ? (
        <div className={styles.importProgress}>
          <progress aria-label={t('historyImporting')} value={historyImport.progress} max={100} />
          <span>{historyImport.progress}%</span>
        </div>
      ) : null}
    </>
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      if (Capacitor.getPlatform() === 'android') {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        const files = registerPlugin<{
          save(options: { name: string; data: string; mimeType: string }): Promise<{ cancelled: boolean }>
        }>('LocalFiles')
        const { cancelled } = await files.save({ name, data, mimeType: 'application/zip' })
        if (!cancelled) {
          recordDiagnostic({ area: 'history', operation: 'export', outcome: 'ok' })
        }
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      recordDiagnostic({ area: 'history', operation: 'export', outcome: 'ok' })
    } catch (error) {
      recordDiagnostic({ area: 'history', operation: 'export', outcome: 'failed' })
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
