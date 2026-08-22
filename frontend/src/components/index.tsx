import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { X } from 'lucide-react'
import type { AxiosInstance } from 'axios'
import { getErrorMessage } from '../utils'

export function StatusPill({ label, tone }: { label: string; tone: 'good' | 'bad' | 'neutral' }) {
  const cls =
    tone === 'good'
      ? 'bg-green-50 text-green-700 border-green-200'
      : tone === 'bad'
      ? 'bg-red-50 text-red-700 border-red-200'
      : 'bg-slate-50 text-slate-700 border-slate-200'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border ${cls}`}>{label}</span>
  )
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; placement: 'top' | 'bottom' } | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)

  const calc = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const preferTop = r.top > 56
    const placement: 'top' | 'bottom' = preferTop ? 'top' : 'bottom'
    const x = r.left + r.width / 2
    const y = placement === 'top' ? r.top - 10 : r.bottom + 10
    setPos({ x, y, placement })
  }, [])

  const onEnter = useCallback(() => {
    calc()
    setOpen(true)
  }, [calc])

  const onLeave = useCallback(() => {
    setOpen(false)
  }, [])

  const bubble = useCallback(() => {
    if (!open) return
    calc()
  }, [open, calc])

  const node = (
    <span
      ref={anchorRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onMouseMove={bubble}
      className="inline-flex"
    >
      {children}
    </span>
  )

  if (!open || !pos) return node

  const tip = (
    <div
      className="fixed z-[200] pointer-events-none"
      style={{
        left: pos.x,
        top: pos.y,
        transform: pos.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <div className="max-w-[min(360px,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white/95 text-slate-800 shadow-lg px-3 py-2 backdrop-blur">
        <div className="text-xs leading-5 break-words">{content}</div>
      </div>
    </div>
  )

  return (
    <>
      {node}
      {createPortal(tip, document.body)}
    </>
  )
}

export function LoginModal({ apiClient, onClose, onSuccess }: { apiClient: AxiosInstance; onClose: () => void; onSuccess: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [statusText, setStatusText] = useState('')
  const [errorText, setErrorText] = useState('')

  const fetchQR = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/login/qr')
      setUrl(res.data.url)
      setKey(res.data.qrcode_key)
      setStatusText(t('common.loginScanWait'))
      setErrorText('')
    } catch (err: any) {
      setErrorText(t('common.loginFailed') + ' ' + getErrorMessage(err))
    }
  }, [apiClient, t])

  useEffect(() => {
    fetchQR()
  }, [fetchQR])

  useEffect(() => {
    if (!key) return
    let disposed = false
    let pollTimer: number | undefined
    let successTimer: number | undefined
    let request: AbortController | null = null

    const scheduleNext = () => {
      if (!disposed) pollTimer = window.setTimeout(() => { void poll() }, 2000)
    }
    const poll = async () => {
      request = new AbortController()
      let terminal = false
      try {
        const res = await apiClient.get(`/api/login/poll?qrcode_key=${key}`, { signal: request.signal })
        if (disposed) return
        const code = res.data.code
        setErrorText('')
        if (code === 0) {
          terminal = true
          setStatusText(t('common.loginSuccess'))
          successTimer = window.setTimeout(() => {
            if (!disposed) onSuccess()
          }, 1000)
        } else if (code === 86090) {
          setStatusText(t('common.loginScanConfirm'))
        } else if (code === 86038) {
          terminal = true
          setErrorText(t('common.loginExpired'))
        }
      } catch (err: any) {
        if (disposed || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return
        // A failed poll means the current login state is unknown. Keeping the
        // previous "waiting" text without surfacing the error made an offline
        // backend look like a QR code that was still valid forever.
        setErrorText(`${t('common.loginFailed')} ${getErrorMessage(err)}`)
      } finally {
        request = null
        if (!terminal) scheduleNext()
      }
    }

    scheduleNext()
    return () => {
      disposed = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      if (successTimer !== undefined) window.clearTimeout(successTimer)
      request?.abort()
    }
  }, [apiClient, key, onSuccess, t])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm sm:p-6" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col pt-6 pb-8 px-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-bold text-slate-800 text-center mb-6">{t('common.loginTitle')}</h2>
        <div className="flex flex-col items-center">
          {url ? (
            <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
              <QRCodeSVG value={url} size={200} level="L" />
            </div>
          ) : (
            <div className="w-[232px] h-[232px] mb-4 bg-slate-100 animate-pulse rounded-xl" />
          )}
          {errorText ? (
            <div className="text-red-500 text-sm text-center font-medium mb-4">{errorText}</div>
          ) : (
            <div className="text-slate-600 text-sm text-center font-medium mb-4">{statusText}</div>
          )}
          {errorText && (
            <button
              onClick={fetchQR}
              className="px-4 py-2 bg-[var(--color-bili-blue)] text-white text-sm font-medium rounded-lg hover:brightness-110 transition active:scale-95"
            >
              {t('common.loginRefresh')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
