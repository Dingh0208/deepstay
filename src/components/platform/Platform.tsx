import { Modal } from '../base/Modal.js'
import { IconDataOutline16 } from '../base/icons.js'
import { useSettings } from '../../services/settings.js'
import { closePlans, usePlansDialog } from './plansDialogState.js'
import styles from './Platform.module.css'
import settingsStyles from '../settings/Settings.module.css'

export const PlatformDialog = () => {
  const open = usePlansDialog((state) => state.open)
  const locale = useSettings((state) => state.locale)
  if (!open) {
    return null
  }
  const title = locale === 'zh-CN' ? '方案' : 'Plans'
  return (
    <Modal
      title={title}
      closable
      className={settingsStyles.dialog}
      mainClassName={settingsStyles.dialogMain}
      onClose={closePlans}
    >
      <div role="tablist" className={settingsStyles.navigation} aria-label={title}>
        <button
          type="button"
          role="tab"
          aria-selected
          className={`${settingsStyles.navItem} ${settingsStyles.navItemActive}`}
        >
          <IconDataOutline16 />
          {title}
        </button>
      </div>
      <div role="tabpanel" className={`${settingsStyles.content} ${styles.placeholder}`}>
        <p>
          {locale === 'zh-CN'
            ? '该功能还在开发中，后续开放。'
            : 'This feature is in development and will be available later.'}
        </p>
      </div>
    </Modal>
  )
}
