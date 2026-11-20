import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { supportsApiBalance } from '../../services/api/balance.js'
import { getCachedBalance, queryCachedBalance, selectBalanceAccount, subscribeBalance } from '../../services/api/balanceCache.js'
import type { ApiProtocol } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import settingsStyles from './Settings.module.css'
import styles from './ApiBalanceSetting.module.css'

const ApiBalanceContent = ({
  apiKey,
  apiBaseUrl,
  apiProtocol,
  autoLoad = false,
}: {
  apiKey: string
  apiBaseUrl: string
  apiProtocol: ApiProtocol
  autoLoad?: boolean
}) => {
  const t = useTranslate()
  const request = useMemo(() => ({ apiKey, connection: { baseUrl: apiBaseUrl, protocol: apiProtocol } }),
    [apiKey, apiBaseUrl, apiProtocol])
  const snapshot = useCallback(() => getCachedBalance(request), [request])
  const state = useSyncExternalStore(subscribeBalance, snapshot)
  const supported = supportsApiBalance({ baseUrl: apiBaseUrl, protocol: apiProtocol })

  useEffect(() => {
    selectBalanceAccount(request)
    if (autoLoad) {
      void queryCachedBalance(request)
    }
  }, [request, autoLoad])

  if (!supported) {
    return null
  }
  return (
    <div className={styles.content} aria-busy={state.status === 'loading'}>
      <div className={styles.row}>
        <span className={settingsStyles.label}>{t('apiBalanceLabel')}</span>
        <Button
          variant="outlined"
          size="m"
          disabled={!apiKey || state.status === 'loading'}
          onClick={() => void queryCachedBalance(request)}
        >
          {t(state.status === 'loading' ? 'apiBalanceLoading' : 'apiBalanceQuery')}
        </Button>
      </div>
      {state.message ? (
        <div role="alert" className={settingsStyles.error}>
          {t(state.message)}
        </div>
      ) : null}
      {state.balance ? (
        <div role="status" className={styles.result}>
          {state.checkedAt !== undefined ? (
            <div className={settingsStyles.description}>
              {t('apiBalanceLastChecked', { time: new Date(state.checkedAt).toLocaleTimeString() })}
            </div>
          ) : null}
          {state.balance.balance_infos.length === 0 ? (
            <div>{t('apiBalanceEmpty')}</div>
          ) : (
            state.balance.balance_infos.map((info, index) => (
              <div key={`${info.currency}-${index}`} className={styles.account}>
                <div className={styles.row}>
                  <span>{t('apiBalanceTotal')}</span>
                  <strong>
                    {info.currency} {info.total_balance}
                  </strong>
                </div>
                <div className={styles.row}>
                  <span className={settingsStyles.description}>{t('apiBalanceGranted')}</span>
                  <span>
                    {info.currency} {info.granted_balance}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className={settingsStyles.description}>{t('apiBalanceToppedUp')}</span>
                  <span>
                    {info.currency} {info.topped_up_balance}
                  </span>
                </div>
              </div>
            ))
          )}
          {!state.balance.is_available ? (
            <div className={settingsStyles.error}>{t('apiBalanceUnavailable')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const ApiBalanceQueryButton = ({
  apiKey,
  apiBaseUrl,
  apiProtocol,
}: {
  apiKey: string
  apiBaseUrl: string
  apiProtocol: ApiProtocol
}) => {
  const t = useTranslate()
  const supported = supportsApiBalance({ baseUrl: apiBaseUrl, protocol: apiProtocol })
  const [open, setOpen] = useState(false)
  useEffect(() => {
    selectBalanceAccount({ apiKey, connection: { baseUrl: apiBaseUrl, protocol: apiProtocol } })
  }, [apiKey, apiBaseUrl, apiProtocol])
  if (!supported) {
    return null
  }
  return (
    <>
      <Button variant="outlined" size="s" disabled={!apiKey.trim()} onClick={() => setOpen(true)}>
        {t('apiBalanceQuery')}
      </Button>
      {open ? (
        <Modal title={t('apiBalanceLabel')} closable onClose={() => setOpen(false)}>
          <ApiBalanceContent
            apiKey={apiKey}
            apiBaseUrl={apiBaseUrl}
            apiProtocol={apiProtocol}
            autoLoad
          />
        </Modal>
      ) : null}
    </>
  )
}
