import clsx from 'clsx'
import { useState } from 'react'
import { useChatStore } from '../../services/chat/store.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { ApiBalanceQueryButton } from './ApiBalanceSetting.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import styles from './Settings.module.css'
import apiStyles from './ApiKeyField.module.css'

export const useApiKeyEditor = useApiKeyForm

export const ApiKeyField = ({ editor }: { editor: ReturnType<typeof useApiKeyEditor> }) => {
  const t = useTranslate()
  const [customModel, setCustomModel] = useState(false)
  const streaming = useChatStore((state) => Object.keys(state.streaming).length > 0)
  const choices = [...new Set([editor.model, ...editor.models].filter(Boolean))]
  const disabled = editor.busy !== null
  return (
    <div className={styles.cell}>
      <div className={apiStyles.fields}>
        <label className={apiStyles.fieldRow}>
          <span className={styles.label}>{t('apiBaseUrl')}</span>
          <div className={clsx(styles.apiKeyInput, editor.protocol === 'deepseek' && apiStyles.readOnly)}>
            <input type="url" disabled={editor.protocol === 'deepseek' || disabled} autoCapitalize="none" autoComplete="off" spellCheck={false}
              value={editor.baseUrl} onChange={(event) => editor.setBaseUrl(event.target.value)}
              placeholder="https://api.deepseek.com" />
          </div>
        </label>
        <div className={apiStyles.fieldRow}>
          <span className={styles.label}>{t('apiProtocol')}</span>
          <Select value={editor.protocol} ariaLabel={t('apiProtocol')}
            options={[{ value: 'deepseek', label: t('apiProtocolDeepSeek') }, { value: 'openai', label: t('apiProtocolOpenAI') }]}
            onChange={editor.setProtocol} />
        </div>
        <label className={apiStyles.fieldRow}>
          <span className={styles.label}>API Key</span>
          <div className={styles.apiKeyInput}>
            <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={editor.value} placeholder={t('apiKeyPlaceholder')}
              onChange={(event) => editor.setValue(event.target.value)} />
          </div>
        </label>
        <div className={apiStyles.actionsRow}>
          <span aria-hidden="true" />
          <div className={apiStyles.actions}>
            <Button variant="outlined" size="s" disabled={disabled} onClick={() => void editor.run('test')}>
              {t(editor.busy === 'test' ? 'apiTesting' : 'apiTestConnection')}
            </Button>
            <Button variant="outlined" size="s" disabled={disabled} onClick={() => void editor.run('models')}>
              {t(editor.busy === 'models' ? 'apiLoadingModels' : 'apiLoadModels')}
            </Button>
            {editor.protocol === 'deepseek' ? (
              <ApiBalanceQueryButton apiKey={editor.value} apiBaseUrl={editor.baseUrl} apiProtocol={editor.protocol} />
            ) : null}
          </div>
        </div>
        <div className={apiStyles.fieldRow}>
          <span className={styles.label}>{t('apiModel')}</span>
          <Select value={customModel ? '__custom__' : editor.model} ariaLabel={t('apiModel')} disabled={disabled}
            options={[...choices.map((value) => ({ value, label: value })), { value: '__custom__', label: t('apiCustomModel') }]}
            onChange={(value) => {
              setCustomModel(value === '__custom__')
              if (value !== '__custom__') {
                editor.setModel(value)
              }
            }} />
        </div>
        {customModel ? (
          <label className={apiStyles.fieldRow}>
            <span className={styles.label}>{t('apiModelId')}</span>
            <div className={styles.apiKeyInput}>
              <input value={editor.model} disabled={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false}
                onChange={(event) => editor.setModel(event.target.value)} />
            </div>
          </label>
        ) : null}
        {editor.error ? <div className={apiStyles.messageRow}><span aria-hidden="true" /><div role="alert" className={styles.error}>{editor.error}</div></div> : null}
        {editor.status ? <div className={apiStyles.messageRow}><span aria-hidden="true" /><div role="status" className={editor.status.error ? styles.error : styles.description}>{t(editor.status.key)}</div></div> : null}
        {streaming ? <div className={apiStyles.messageRow}><span aria-hidden="true" /><div className={styles.description}>{t('apiSaveAfterReply')}</div></div> : null}
        <Button variant="primary" size="m" className={apiStyles.save} disabled={disabled || streaming} onClick={editor.submit}>{t('save')}</Button>
      </div>
    </div>
  )
}
