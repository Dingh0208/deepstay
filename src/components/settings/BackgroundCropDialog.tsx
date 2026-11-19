import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  encodeChatBackground,
  getBackgroundCrop,
  openChatBackground,
  setChatBackground,
  type BackgroundCrop,
} from '../../services/chatBackground.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './BackgroundCropDialog.module.css'

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const percent = (value: number) => String(value * 100) + '%'

export const BackgroundCropDialog = ({ file, onClose }: { file: File; onClose: () => void }) => {
  const t = useTranslate()
  const [aspect] = useState(() => {
    const area = document.querySelector('[data-chat-background-area]')?.getBoundingClientRect()
    return area?.width && area.height ? area.width / area.height : window.innerWidth / window.innerHeight
  })
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null)
  const [selection, setSelection] = useState<BackgroundCrop>({ x: 0.5, y: 0.5, zoom: 1 })
  const [error, setError] = useState<TranslationKey | null>(null)
  const [saving, setSaving] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  useEffect(() => {
    let closed = false
    let source: string | undefined
    void openChatBackground(file).then((image) => {
      if (closed) {
        URL.revokeObjectURL(image.src)
      } else {
        source = image.src
        setPhoto(image)
      }
    }).catch((reason: unknown) => {
      if (!closed) {
        setError(reason instanceof Error && reason.message === 'size'
          ? 'chatBackgroundTooLarge'
          : 'chatBackgroundInvalid')
      }
    })
    return () => {
      closed = true
      if (source) {
        URL.revokeObjectURL(source)
      }
    }
  }, [file])

  const crop = photo && getBackgroundCrop(photo, aspect, selection)
  const pan = (x: number, y: number) => {
    if (!photo) {
      return
    }
    setSelection((current) => {
      const region = getBackgroundCrop(photo, aspect, current)
      const spaceX = photo.naturalWidth - region.width
      const spaceY = photo.naturalHeight - region.height
      return {
        ...current,
        x: spaceX > 0 ? clamp(current.x + x * region.width / spaceX) : current.x,
        y: spaceY > 0 ? clamp(current.y + y * region.height / spaceY) : current.y,
      }
    })
  }
  const save = async () => {
    if (!photo || !crop || saving) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await setChatBackground(await encodeChatBackground(photo, crop))
      onClose()
    } catch {
      setError('chatBackgroundSaveFailed')
    } finally {
      setSaving(false)
    }
  }
  const close = () => {
    if (!saving) {
      onClose()
    }
  }

  return (
    <Modal title={t('chatBackgroundCrop')} className={styles.dialog} onClose={close}
      footer={
        <>
          <Button size="m" variant="outlined" disabled={saving} onClick={close}>{t('cancel')}</Button>
          <Button size="m" disabled={!crop || saving} onClick={() => void save()}>
            {t(saving ? 'chatBackgroundSaving' : 'save')}
          </Button>
        </>
      }
    >
      {photo && crop ? (
        <>
          <div
            className={styles.preview}
            style={{ width: Math.min(420, Math.max(100, Math.min(320, window.innerHeight - 252)) * aspect) }}
          >
            <div
              className={styles.frame}
              style={{ paddingTop: percent(1 / aspect) }}
              tabIndex={0}
              aria-label={t('chatBackgroundCrop')}
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
              onKeyDown={(event) => {
                if (saving || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                  return
                }
                event.preventDefault()
                pan(event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0,
                  event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0)
              }}
              onPointerDown={(event) => {
                if (saving || drag.current || event.button !== 0) {
                  return
                }
                event.currentTarget.setPointerCapture(event.pointerId)
                drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
              }}
              onPointerMove={(event) => {
                const previous = drag.current
                if (previous?.id !== event.pointerId) {
                  return
                }
                const { clientWidth, clientHeight } = event.currentTarget
                drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
                pan((previous.x - event.clientX) / clientWidth, (previous.y - event.clientY) / clientHeight)
              }}
              onLostPointerCapture={(event) => {
                if (drag.current?.id === event.pointerId) {
                  drag.current = null
                }
              }}
            >
              <img
                alt=""
                src={photo.src}
                style={{
                  width: percent(photo.naturalWidth / crop.width),
                  height: percent(photo.naturalHeight / crop.height),
                  left: percent(-crop.x / crop.width),
                  top: percent(-crop.y / crop.height),
                }}
              />
            </div>
          </div>
          <label className={styles.zoom}>
            {t('chatBackgroundZoom')}
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={selection.zoom}
              disabled={saving}
              aria-valuetext={percent(selection.zoom)}
              onChange={(event) => {
                const zoom = event.target.valueAsNumber
                setSelection((current) => ({ ...current, zoom }))
              }}
            />
            <span aria-hidden="true">{Math.round(selection.zoom * 100)}%</span>
          </label>
        </>
      ) : !error ? <p role="status">{t('chatBackgroundLoading')}</p> : null}
      {error ? <p className={styles.error} role="alert">{t(error)}</p> : null}
    </Modal>
  )
}
