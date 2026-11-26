import clsx from 'clsx'
import { useState } from 'react'
import { useChatStore } from '../../services/chat/store.js'
import { useTranslate } from '../../i18n/index.js'
import { DEFAULT_DEEPSEEK_SEARCH_API_BASE_URL, deleteModelPreset, saveModelPreset, useSettings } from '../../services/settings.js'
import { normalizeApiBaseUrl, supportsDeepSeekExtras } from '../../services/api/connection.js'
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
  const presets = useSettings((state) => state.modelPresets)
  const activeModelPresetId = useSettings((state) => state.activeModelPresetId)
  const matchesEditor = (preset: typeof presets[number]) => preset.apiKey === editor.value &&
    preset.apiBaseUrl === editor.baseUrl && preset.apiProtocol === editor.protocol && preset.model === editor.model
  const currentPreset = presets.find((preset) => preset.id === activeModelPresetId && matchesEditor(preset)) ??
    presets.find(matchesEditor)
  const [presetId, setPresetId] = useState(currentPreset?.id ?? '')
  const [presetName, setPresetName] = useState(currentPreset?.name ?? '')
  const [presetNotice, setPresetNotice] = useState<'modelPresetSaved' | 'modelPresetNameRequired' | 'modelPresetInvalid' | 'searchApiCountInvalid' | null>(null)
  const streaming = useChatStore((state) => Object.keys(state.streaming).length > 0)
  const choices = [...new Set([editor.model, ...editor.models].filter(Boolean))]
  const disabled = editor.busy !== null
  const selectPreset = (id: string) => {
    if (id === '__new__') {
      setPresetId('')
      setPresetName('')
      setPresetNotice(null)
      setCustomModel(false)
      return
    }
    const preset = presets.find((entry) => entry.id === id)
    if (preset) {
      setPresetId(id)
      setPresetName(preset.name)
      setPresetNotice(null)
      setCustomModel(false)
      editor.loadPreset(preset)
    }
  }
  const savePreset = () => {
    if (!presetName.trim()) {
      setPresetNotice('modelPresetNameRequired')
      return
    }
    if (!editor.value.trim() || !editor.model.trim()) {
      setPresetNotice('modelPresetInvalid')
      return
    }
    if (!supportsDeepSeekExtras({ baseUrl: editor.baseUrl, protocol: editor.protocol }) &&
        (!Number.isInteger(editor.searchApiCount) || editor.searchApiCount < 1 || editor.searchApiCount > 50)) {
      setPresetNotice('searchApiCountInvalid')
      return
    }
    try {
      const id = saveModelPreset({
        name: presetName,
        apiKey: editor.value,
        apiBaseUrl: normalizeApiBaseUrl(editor.baseUrl),
        apiProtocol: editor.protocol,
        model: editor.model,
        models: editor.models,
        ...(!supportsDeepSeekExtras({ baseUrl: editor.baseUrl, protocol: editor.protocol }) ? {
          searchApi: {
            apiKey: editor.searchApiKey,
            baseUrl: editor.searchApiBaseUrl || DEFAULT_DEEPSEEK_SEARCH_API_BASE_URL,
            count: editor.searchApiCount,
          },
        } : {}),
      }, presetId || undefined)
      setPresetId(id)
      setPresetName(presetName.trim())
      setPresetNotice('modelPresetSaved')
    } catch {
      setPresetNotice('modelPresetInvalid')
    }
  }
  const removePreset = () => {
    if (presetId) {
      deleteModelPreset(presetId)
      setPresetId('')
      setPresetName('')
      setPresetNotice(null)
    }
  }
  return (
    <div className={styles.cell}>
      <div className={apiStyles.fields}>
        <div className={apiStyles.fieldRow}>
          <span className={styles.label}>{t('modelPresetsLabel')}</span>
          <Select value={presetId || '__new__'} ariaLabel={t('modelPresetsLabel')}
            options={[{ value: '__new__', label: t('modelPresetNew') }, ...presets.map((preset) => ({ value: preset.id, label: preset.name }))]}
            onChange={selectPreset} />
        </div>
        <label className={apiStyles.fieldRow}>
          <span className={styles.label}>{t('modelPresetName')}</span>
          <div className={styles.apiKeyInput}>
            <input value={presetName} maxLength={64} autoComplete="off" onChange={(event) => {
              setPresetName(event.target.value)
              setPresetNotice(null)
            }} />
          </div>
        </label>
        <div className={apiStyles.actionsRow}>
          <span aria-hidden="true" />
          <div className={apiStyles.actions}>
            <Button variant="outlined" size="s" disabled={disabled || streaming} onClick={savePreset}>
              {t(presetId ? 'modelPresetUpdate' : 'modelPresetSave')}
            </Button>
            {presetId ? <Button variant="dangerOutlined" size="s" disabled={disabled || streaming} onClick={removePreset}>
              {t('modelPresetDelete')}
            </Button> : null}
          </div>
        </div>
        {presetNotice ? <div className={apiStyles.messageRow}><span aria-hidden="true" /><div role="status" className={presetNotice === 'modelPresetInvalid' || presetNotice === 'modelPresetNameRequired' ? styles.error : styles.description}>{t(presetNotice)}</div></div> : null}
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
        {!supportsDeepSeekExtras({ baseUrl: editor.baseUrl, protocol: editor.protocol }) ? <>
          <div className={apiStyles.searchTitle}>{t('searchApiTitle')}</div>
          <div className={apiStyles.searchDescription}>{t('searchApiDescription')}</div>
          <label className={apiStyles.fieldRow}>
            <span className={styles.label}>{t('searchApiBaseUrl')}</span>
            <div className={styles.apiKeyInput}>
              <input type="url" disabled={disabled} autoCapitalize="none" autoComplete="off" spellCheck={false}
                value={editor.searchApiBaseUrl} onChange={(event) => editor.setSearchApiBaseUrl(event.target.value)} />
            </div>
          </label>
          <label className={apiStyles.fieldRow}>
            <span className={styles.label}>{t('searchApiKey')}</span>
            <div className={styles.apiKeyInput}>
              <input type="password" disabled={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false}
                value={editor.searchApiKey} onChange={(event) => editor.setSearchApiKey(event.target.value)} />
            </div>
          </label>
          <label className={apiStyles.fieldRow}>
            <span className={styles.label}>{t('searchApiCount')}</span>
            <div className={styles.apiKeyInput}>
              <input type="number" disabled={disabled} min={1} max={50} step={1}
                value={Number.isFinite(editor.searchApiCount) ? editor.searchApiCount : ''}
                onChange={(event) => editor.setSearchApiCount(event.target.value === '' ? Number.NaN : Number(event.target.value))} />
            </div>
          </label>
        </> : null}
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
