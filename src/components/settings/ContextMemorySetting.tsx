import { useTranslate } from '../../i18n/index.js'
import { setContextMemoryEnabled, useSettings } from '../../services/settings.js'
import settingsStyles from './Settings.module.css'
import appearanceStyles from './AppearanceSetting.module.css'

export const ContextMemorySetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.contextMemoryEnabled)
  return (
    <div className={settingsStyles.cell}>
      <div className={appearanceStyles.row}>
        <label className={settingsStyles.label} htmlFor="context-memory-enabled">
          {t('contextMemoryLabel')}
        </label>
        <input
          id="context-memory-enabled"
          type="checkbox"
          role="switch"
          checked={enabled}
          className={appearanceStyles.switch}
          title={t('contextMemoryManualHint')}
          onChange={(event) => setContextMemoryEnabled(event.target.checked)}
        />
      </div>
    </div>
  )
}
