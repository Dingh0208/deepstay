import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { fetchApiBalance, supportsApiBalance, type ApiBalance } from '../../services/api/balance.js'
import { ApiError } from '../../services/api/http.js'
import type { ApiProtocol } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import settingsStyles from './Settings.module.css'
import styles from './ApiBalanceSetting.module.css'

type BalanceState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: TranslationKey }
  | { status: 'ready'; balance: ApiBalance }

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
  const [state, setState] = useState<BalanceState>({ status: 'idle' })
  const pending = useRef<AbortController | null>(null)
  const supported = supportsApiBalance({ baseUrl: apiBaseUrl, protocol: apiProtocol })
  const query = useCallback(async () => {
    if (pending.current || !apiKey || !supported) {
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setState({ status: 'loading' })
    try {
      const balance = await fetchApiBalance(controller.signal, {
        apiKey,
        connection: { baseUrl: apiBaseUrl, protocol: apiProtocol },
      })
      if (!controller.signal.aborted) {
        setState({ status: 'ready', balance })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          status: 'error',
          message:
            error instanceof ApiError && error.status === 401
              ? 'apiKeyInvalid'
              : error instanceof ApiError && error.localMessage
                ? error.localMessage.key
                : 'apiBalanceFailed',
        })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
      }
    }
  }, [apiKey, apiBaseUrl, apiProtocol, supported])

  useEffect(() => {
    setState({ status: 'idle' })
    if (autoLoad) {
      void query()
    }
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [apiKey, apiBaseUrl, apiProtocol, autoLoad, query])

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
          onClick={() => void query()}
        >
          {t(state.status === 'loading' ? 'apiBalanceLoading' : 'apiBalanceQuery')}
        </Button>
      </div>
      <div className={settingsStyles.description}>{t('apiBalanceHint')}</div>
      {state.status === 'error' ? (
        <div role="alert" className={settingsStyles.error}>
          {t(state.message)}
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div role="status" className={styles.result}>
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
