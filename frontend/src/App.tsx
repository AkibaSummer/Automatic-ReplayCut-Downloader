import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import axios, { type AxiosInstance } from 'axios'
import { QRCodeSVG } from 'qrcode.react'
import {
  Download,
  LayoutDashboard,
  Menu,
  Pause,
  PauseCircle,
  Play,
  RefreshCcw,
  Scissors,
  Settings,
  Tv,
  Wrench,
  X,
  CheckCircle,
  XCircle,
  Copy,
  MoreHorizontal,
  Eraser,
  Loader2,
} from 'lucide-react'

interface Replay {
  ID: number
  UpdatedAt: string
  replay_id: number
  live_key: string
  title: string
  start_time: number
  end_time: number
  duration: number
  status: string
  message: string
  file_path: string
  cover_url: string
  local_cover: string
  file_size: number
  resolution: string
  bitrate: string
  progress: number
  speed: string
  elapsed: string
  eta: string
  verify_ok: boolean
  actual_duration: number
  cover_src?: string
  streams?: StreamSlice[]
}

interface StreamSlice {
  replay_id: number
  start_time: number
  end_time: number
  stream: string
  type: number
  m3u8_text: string
}

interface Config {
  bilibili: {
    anchor_id: number
  }
  download: {
    output_dir: string
    filename_template: string
    max_concurrent_tasks: number
    concurrent_segments: number
    clip_output_dir: string
  }
}

interface Progress {
  live_key: string
  progress: number
  merge_progress: number
  status: string
  message: string
  speed: string
  speed_history: number[]
  elapsed: string
  eta: string
}

interface Me {
  logged_in: boolean
  uname: string
  face: string
}

interface Runtime {
  paused: boolean
  max_concurrent_tasks: number
  concurrent_segments: number
  downloading_tasks: number
  queued_tasks: number
  paused_tasks: number
  failed_tasks: number
}

interface ScanSummary {
  fetched: number
  new_records: number
  updated_records: number
  covers_updated: number
  marked_deleted: number
  already_up_to_date: number
}

interface DiskStats {
  path: string
  total_bytes: number
  free_bytes: number
  used_by_service_bytes: number
}

type PageKey = 'downloads' | 'settings' | 'clip'

type FsEntry = { name: string; path: string }
type FsListResponse = { current: string; parent: string; entries: FsEntry[] }

function getErrorMessage(e: any) {
  const apiErr = e?.response?.data?.error
  if (apiErr) return apiErr
  const status = e?.response?.status
  if (status) {
    const statusText = e?.response?.statusText || ''
    return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  }
  return e?.message || 'Unknown error'
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function statusColor(status: string) {
  if (status === 'completed') return 'bg-green-500'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'deleted') return 'bg-violet-500'
  if (status === 'paused') return 'bg-amber-500'
  if (status === 'downloading' || status === 'merging') return 'bg-[var(--color-bili-blue)]'
  return 'bg-slate-400'
}

const ACTIVE_STATUSES = ['pending', 'downloading', 'merging', 'paused'] as const
const TERMINAL_STATUSES = ['completed', 'failed', 'deleted', 'not_downloaded'] as const

function shouldUseRealtimeProgress(progress: Progress | undefined, replay: Replay) {
  if (!progress) return false
  if (TERMINAL_STATUSES.includes(replay.status as typeof TERMINAL_STATUSES[number]) &&
      ACTIVE_STATUSES.includes(progress.status as typeof ACTIVE_STATUSES[number])) {
    return false
  }
  return true
}

function StatusPill({ label, tone }: { label: string; tone: 'good' | 'bad' | 'neutral' }) {
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

function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
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

type ToastTone = 'loading' | 'success' | 'error' | 'info'
type Toast = { id: number; tone: ToastTone; title: string; message?: string }


function LoginModal({ apiClient, onClose, onSuccess }: { apiClient: AxiosInstance; onClose: () => void; onSuccess: () => void }) {
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
    const interval = setInterval(async () => {
      try {
        const res = await apiClient.get(`/api/login/poll?qrcode_key=${key}`)
        const code = res.data.code
        if (code === 0) {
          setStatusText(t('common.loginSuccess'))
          clearInterval(interval)
          setTimeout(() => onSuccess(), 1000)
        } else if (code === 86090) {
          setStatusText(t('common.loginScanConfirm'))
        } else if (code === 86038) {
          setErrorText(t('common.loginExpired'))
          clearInterval(interval)
        }
      } catch (err: any) {}
    }, 2000)
    return () => clearInterval(interval)
  }, [apiClient, key, onSuccess, t])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm sm:p-6">
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

function App() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [page, setPage] = useState<PageKey>('downloads')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [exportUseProxy, setExportUseProxy] = useState(false)
  const [apiBase, setApiBase] = useState('')

  const apiClient = useMemo(() => axios.create({
    baseURL: apiBase || undefined,
  }), [apiBase])

  const buildApiUrl = useCallback((path: string) => {
    if (!apiBase) return path
    return `${apiBase}${path}`
  }, [apiBase])

  const buildWsUrl = useCallback((path: string) => {
    if (!apiBase) return ''
    return `${apiBase.replace(/^http/i, 'ws')}${path}`
  }, [apiBase])

  const [replays, setReplays] = useState<Replay[]>([])
  const [config, setConfig] = useState<Config | null>(null)
  const loadedConfigRef = useRef<Config | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [backendOnline, setBackendOnline] = useState(false)
  const [wsOnline, setWsOnline] = useState(false)
  const [paused, setPaused] = useState(false)
  const [runtimeState, setRuntimeState] = useState<Runtime | null>(null)
  const [progressMap, setProgressMap] = useState<Record<string, Progress>>({})
  const [selectedLiveKey, setSelectedLiveKey] = useState<string | null>(null)
  const [m3u8Open, setM3u8Open] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(1)
  const toastTimers = useRef<Record<number, number>>({})
  const advancedMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (advancedMenuRef.current && !advancedMenuRef.current.contains(event.target as Node)) {
        setShowAdvanced(false)
      }
    }
    if (showAdvanced) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showAdvanced])

  const [dirModalOpen, setDirModalOpen] = useState(false)
  const [dirCurrent, setDirCurrent] = useState('')
  const [dirParent, setDirParent] = useState('')
  const [dirEntries, setDirEntries] = useState<FsEntry[]>([])
  const [dirLoading, setDirLoading] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)

  const [diskStats, setDiskStats] = useState<DiskStats | null>(null)
  const [diskStatsLoading, setDiskStatsLoading] = useState(false)
  const diskStatsErrorShown = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let resolved = ''
      try {
        resolved = (await window.desktopAPI?.getBackendBaseURL?.()) || ''
      } catch {
        resolved = ''
      }
      if (!resolved && /^https?:$/i.test(window.location.protocol)) {
        resolved = window.location.origin
      }
      if (!cancelled) {
        setApiBase(resolved.replace(/\/$/, ''))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setM3u8Open(false)
  }, [selectedLiveKey])

  const selectedReplay = useMemo(
    () => replays.find(r => r.live_key === selectedLiveKey) || null,
    [replays, selectedLiveKey],
  )

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    const timer = toastTimers.current[id]
    if (timer) {
      window.clearTimeout(timer)
      delete toastTimers.current[id]
    }
  }, [])

  const upsertToastTimer = useCallback((id: number, tone: ToastTone, durationMs?: number) => {
    const timer = toastTimers.current[id]
    if (timer) window.clearTimeout(timer)
    const dur =
      durationMs ??
      (tone === 'error' ? 9000 : tone === 'loading' ? 12000 : 3500)
    toastTimers.current[id] = window.setTimeout(() => dismissToast(id), dur)
  }, [dismissToast])

  const showToast = useCallback((t: Omit<Toast, 'id'> & { durationMs?: number }) => {
    const id = toastSeq.current++
    setToasts(prev => {
      const next = [...prev, { id, tone: t.tone, title: t.title, message: t.message }]
      const removed = next.slice(0, Math.max(0, next.length - 4))
      for (const toast of removed) {
        const timer = toastTimers.current[toast.id]
        if (timer) {
          window.clearTimeout(timer)
          delete toastTimers.current[toast.id]
        }
      }
      return next.slice(-4)
    })
    upsertToastTimer(id, t.tone, t.durationMs)
    return id
  }, [upsertToastTimer])

  const replaceToast = useCallback((id: number, t: Omit<Toast, 'id'> & { durationMs?: number }) => {
    let found = false
    setToasts(prev => {
      found = prev.some(x => x.id === id)
      if (!found) {
        return [...prev, { id, tone: t.tone, title: t.title, message: t.message }].slice(-4)
      }
      return prev.map(x => (x.id === id ? { id, tone: t.tone, title: t.title, message: t.message } : x))
    })
    upsertToastTimer(id, t.tone, t.durationMs)
  }, [upsertToastTimer])

  const toastAction = useCallback(async (opts: {
    loadingTitle: string
    loadingMessage?: string
    successTitle: string
    successMessage?: string
    errorTitle: string
    action: () => Promise<any>
    onSuccess?: (res: any) => void
  }) => {
    const id = showToast({ tone: 'loading', title: opts.loadingTitle, message: opts.loadingMessage })
    try {
      const res = await opts.action()
      opts.onSuccess?.(res)
      replaceToast(id, { tone: 'success', title: opts.successTitle, message: opts.successMessage })
      return res
    } catch (e) {
      setBackendOnline(false)
      replaceToast(id, { tone: 'error', title: opts.errorTitle, message: getErrorMessage(e) })
      throw e
    }
  }, [replaceToast, showToast])

  const activeDownloading = useMemo(
    () => Object.values(progressMap).filter(p => p.status === 'downloading' || p.status === 'merging').length,
    [progressMap],
  )

  const hasActiveReplay = useMemo(
    () =>
      replays.some(r => ACTIVE_STATUSES.includes(r.status as typeof ACTIVE_STATUSES[number])) ||
      Object.values(progressMap).some(p => ACTIVE_STATUSES.includes(p.status as typeof ACTIVE_STATUSES[number])),
    [progressMap, replays],
  )

  const runtimeSnapshot = useMemo(() => {
    const fallbackDownloading = replays.filter(r => r.status === 'downloading' || r.status === 'merging').length
    const fallbackQueued = replays.filter(r => r.status === 'pending').length
    const fallbackPaused = replays.filter(r => r.status === 'paused').length
    const fallbackFailed = replays.filter(r => r.status === 'failed').length
    return {
      maxConcurrentTasks: runtimeState?.max_concurrent_tasks ?? config?.download?.max_concurrent_tasks ?? 0,
      concurrentSegments: runtimeState?.concurrent_segments ?? config?.download?.concurrent_segments ?? 0,
      downloadingTasks: runtimeState?.downloading_tasks ?? fallbackDownloading,
      queuedTasks: runtimeState?.queued_tasks ?? fallbackQueued,
      pausedTasks: runtimeState?.paused_tasks ?? fallbackPaused,
      failedTasks: runtimeState?.failed_tasks ?? fallbackFailed,
    }
  }, [config?.download?.concurrent_segments, config?.download?.max_concurrent_tasks, replays, runtimeState])

  useEffect(() => {
    if (!apiBase) return
    fetchReplays()
    fetchConfig()
    fetchMe()
    fetchRuntime()
    pingHealth()
    const healthTimer = setInterval(pingHealth, 30000)

    const ws = new WebSocket(buildWsUrl('/ws'))
    ws.onopen = () => setWsOnline(true)
    ws.onerror = () => setWsOnline(false)
    ws.onclose = () => setWsOnline(false)
    ws.onmessage = (event) => {
      const data: Progress = JSON.parse(event.data)
      setProgressMap(prev => {
        const prevItem = prev[data.live_key]
        let next = data
        if (prevItem) {
          const prevInProgress = ['downloading', 'merging', 'paused'].includes(prevItem.status)
          const nextInProgress = ['downloading', 'merging', 'paused'].includes(data.status)
          if (prevInProgress && nextInProgress && data.progress < prevItem.progress) {
            next = { ...data, progress: prevItem.progress }
          }
          if (data.status === 'paused' && data.progress === 0 && prevItem.progress > 0) {
            next = { ...data, progress: prevItem.progress }
          }
        }
        let mergeProgress = data.merge_progress || 0
        if (prevItem && data.status === 'merging' && prevItem.status === 'merging') {
          const prevMerge = prevItem.merge_progress || 0
          if (mergeProgress < prevMerge) mergeProgress = prevMerge
        }
        next = { ...next, merge_progress: data.status === 'merging' ? mergeProgress : 0 }
        if (data.status === 'completed') {
          next = { ...next, progress: 100 }
        }
        return { ...prev, [data.live_key]: next }
      })
      setReplays(prev =>
        prev.map(item =>
          item.live_key === data.live_key
            ? {
                ...item,
                status: data.status === 'merging' ? 'downloading' : data.status,
                message: data.message || item.message,
                progress: data.status === 'completed' ? 100 : (data.progress ?? item.progress),
                speed: data.speed || item.speed,
                elapsed: data.elapsed || item.elapsed,
                eta: data.eta || item.eta,
              }
            : item,
        ),
      )
      if (data.status === 'completed' || data.status === 'failed') fetchReplays()
    }
    return () => {
      clearInterval(healthTimer)
      setWsOnline(false)
      ws.close()
    }
  }, [apiBase, buildWsUrl])

  const fetchDiskStats = useCallback(async () => {
    if (!apiBase || !backendOnline) return
    if (!config?.download?.output_dir) return
    setDiskStatsLoading(true)
    try {
      const res = await apiClient.get('/api/stats/disk')
      setDiskStats(res.data as DiskStats)
      diskStatsErrorShown.current = false
    } catch (e) {
      setDiskStats(null)
      if (!diskStatsErrorShown.current) {
        diskStatsErrorShown.current = true
        const status = (e as any)?.response?.status
        const msg =
          status === 404
            ? (t('messages.endpointNotFound'))
            : getErrorMessage(e)
        showToast({ tone: 'error', title: t('messages.diskStatsFailed'), message: msg })
      }
    } finally {
      setDiskStatsLoading(false)
    }
  }, [apiBase, apiClient, backendOnline, config?.download?.output_dir, getErrorMessage, lang, showToast])

  useEffect(() => {
    fetchDiskStats()
    const intervalMs = activeDownloading > 0 ? 15000 : 60000
    const t = window.setInterval(fetchDiskStats, intervalMs)
    return () => window.clearInterval(t)
  }, [fetchDiskStats, activeDownloading])

  useEffect(() => {
    return () => {
      Object.values(toastTimers.current).forEach(t => window.clearTimeout(t))
      toastTimers.current = {}
    }
  }, [])

  const pingHealth = async () => {
    if (!apiBase) return
    try {
      await apiClient.get('/api/health', { timeout: 2000 })
      setBackendOnline(true)
    } catch {
      setBackendOnline(false)
    }
  }

  const fetchReplays = async (opts?: { notify?: boolean }) => {
    const notify = !!opts?.notify
    const toastId = notify ? showToast({ tone: 'loading', title: t('messages.refreshing') }) : null
    if (notify) setIsRefreshing(true)
    try {
      const res = await apiClient.get('/api/replays')
      const list = (res.data || []) as Replay[]
      setReplays(list)
      setProgressMap(prev => {
        const liveKeys = new Set(list.map(replay => replay.live_key))
        const next = { ...prev }
        for (const liveKey of Object.keys(next)) {
          if (!liveKeys.has(liveKey)) {
            delete next[liveKey]
          }
        }
        for (const replay of list) {
          if (!shouldUseRealtimeProgress(next[replay.live_key], replay)) {
            delete next[replay.live_key]
          }
        }
        return next
      })
      setBackendOnline(true)
      if (toastId) {
        const counts: Record<string, number> = {}
        for (const r of list) counts[r.status] = (counts[r.status] || 0) + 1
        const msg =
          t('messages.refreshSummary', { 'total': list.length, 'completed': counts.completed || 0, 'active': (counts.downloading || 0) + (counts.merging || 0), 'paused': counts.paused || 0, 'deleted': counts.deleted || 0, 'failed': counts.failed || 0, 'pending': counts.pending || 0 })
        replaceToast(toastId, {
          tone: 'success',
          title: t('messages.refreshOk'),
          message: msg,
        })
      }
    } catch (e) {
      setBackendOnline(false)
      if (toastId) {
        replaceToast(toastId, { tone: 'error', title: t('messages.refreshFailed'), message: getErrorMessage(e) })
      }
    } finally {
      if (notify) setIsRefreshing(false)
    }
  }

  useEffect(() => {
    if (!apiBase || !backendOnline || !hasActiveReplay) return
    const timer = window.setInterval(() => {
      fetchReplays({ notify: false })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [apiBase, backendOnline, hasActiveReplay])

  const fetchConfig = async () => {
    try {
      const res = await apiClient.get('/api/config')
      setConfig(res.data)
      loadedConfigRef.current = res.data
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }

  const fetchMe = async () => {
    try {
      const res = await apiClient.get('/api/me')
      setMe(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }

  const fetchRuntime = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/runtime')
      const rt = res.data as Runtime
      setPaused(!!rt.paused)
      setRuntimeState(rt)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }, [apiClient])

  useEffect(() => {
    if (!apiBase) return
    const intervalMs = hasActiveReplay ? 5000 : 30000
    const timer = window.setInterval(fetchRuntime, intervalMs)
    return () => window.clearInterval(timer)
  }, [apiBase, fetchRuntime, hasActiveReplay])

  const handleScan = async () => {
    setIsScanning(true)
    const toastId = showToast({ tone: 'loading', title: t('messages.scanStarting') })
    try {
      const res = await apiClient.post('/api/scan')
      setBackendOnline(true)
      const raw = (res.data || {}) as any
      const s: ScanSummary = {
        fetched: raw.fetched ?? raw.Fetched ?? 0,
        new_records: raw.new_records ?? raw.NewRecords ?? 0,
        updated_records: raw.updated_records ?? raw.UpdatedRecords ?? 0,
        covers_updated: raw.covers_updated ?? raw.CoversUpdated ?? 0,
        marked_deleted: raw.marked_deleted ?? raw.MarkedDeleted ?? 0,
        already_up_to_date: raw.already_up_to_date ?? raw.AlreadyUpToDate ?? 0,
      }
      const msg =
        t('messages.scanSummary', { 'fetched': s.fetched, 'new_records': s.new_records, 'updated_records': s.updated_records, 'covers_updated': s.covers_updated, 'marked_deleted': s.marked_deleted, 'already_up_to_date': s.already_up_to_date }) + (s.fetched === 0 ? t('messages.scanSummaryZero') : '')
      replaceToast(toastId, { tone: 'success', title: t('messages.scanOk'), message: msg })
      window.setTimeout(() => fetchReplays({ notify: false }), 1500)
    } catch (e) {
      setBackendOnline(false)
      replaceToast(toastId, { tone: 'error', title: t('messages.scanFailed'), message: getErrorMessage(e) })
    } finally {
      setIsScanning(false)
    }
  }

  const handleCopyExport = async () => {
    try {
      const res = await apiClient.get(`/api/export-tsv?proxy=${exportUseProxy}`)
      await navigator.clipboard.writeText(res.data)
      showToast({ tone: 'success', title: t('messages.copyExportOk') })
    } catch (e) {
      showToast({ tone: 'error', title: t('messages.copyExportFailed'), message: getErrorMessage(e) })
    }
  }

  const handleSyncAll = async () => {
    setIsSyncingAll(true)
    try {
      await toastAction({
        loadingTitle: t('messages.starting'),
        loadingMessage: t('messages.dispatchingTasks'),
        successTitle: t('messages.started'),
        successMessage: t('messages.tasksRunning'),
        errorTitle: t('messages.startFailed'),
        action: () => apiClient.post('/api/sync-all'),
      })
    } finally {
      setIsSyncingAll(false)
    }
  }

  const handleCleanupStale = async () => {
    const toastId = showToast({
      tone: 'loading',
      title: t('messages.fixing'),
      message: t('messages.cleaningStale'),
    })
    try {
      const res = await apiClient.post('/api/cleanup-stale')
      setBackendOnline(true)
      const count = res.data?.count ?? 0
      replaceToast(toastId, {
        tone: 'success',
        title: t('messages.fixed'),
        message: t('messages.fixedCount', { 'count': count }),
      })
      await fetchReplays({ notify: false })
    } catch (e) {
      setBackendOnline(false)
      replaceToast(toastId, { tone: 'error', title: t('messages.fixFailed'), message: getErrorMessage(e) })
    }
  }

  const handleCleanupStreams = async () => {
    const toastId = showToast({
      tone: 'loading',
      title: t('common.cleaning'),
      message: t('messages.cleaningStreams'),
    })
    try {
      const res = await apiClient.post('/api/cleanup-streams')
      setBackendOnline(true)
      const count = res.data?.count ?? 0
      replaceToast(toastId, {
        tone: 'success',
        title: t('messages.cleanSuccess'),
        message: t('messages.cleanStreamsCount', { count }),
      })
      await fetchReplays({ notify: false })
    } catch (e) {
      setBackendOnline(false)
      replaceToast(toastId, { tone: 'error', title: t('messages.cleanFailed'), message: getErrorMessage(e) })
    }
  }

  const handlePauseAll = async () => {
    await toastAction({
      loadingTitle: t('messages.pausing'),
      loadingMessage: t('messages.stoppingTasks'),
      successTitle: t('messages.paused'),
      errorTitle: t('messages.pauseFailed'),
      action: async () => {
        const res = await apiClient.post('/api/pause-all')
        setBackendOnline(true)
        setPaused(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleResumeAll = async () => {
    await toastAction({
      loadingTitle: t('messages.resuming'),
      loadingMessage: t('messages.allowingTasks'),
      successTitle: t('messages.resumed'),
      errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post('/api/resume-all')
        setBackendOnline(true)
        setPaused(false)
        await fetchRuntime()
        return res
      },
    })
  }

  const handleRetryAllFailed = async () => {
    await toastAction({
      loadingTitle: t('dashboard.retryAllFailed'),
      loadingMessage: t('messages.allowingTasks'),
      successTitle: t('messages.resumed'),
      errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post('/api/retry-failed')
        setBackendOnline(true)
        setPaused(false)
        await fetchRuntime()
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleDownloadUnfinished = async () => {
    await toastAction({
      loadingTitle: t('dashboard.syncAllPending'),
      loadingMessage: t('messages.allowingTasks'),
      successTitle: t('messages.resumed'),
      errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post('/api/download-unfinished')
        setBackendOnline(true)
        await fetchRuntime()
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleDownload = async (liveKey: string) => {
    await toastAction({
      loadingTitle: t('messages.starting'),
      loadingMessage: t('messages.creatingTask'),
      successTitle: t('messages.started'),
      successMessage: t('messages.watchProgress'),
      errorTitle: t('messages.startFailed'),
      action: () => apiClient.post(`/api/replays/${liveKey}/download`),
    })
  }

  const handlePauseReplay = async (liveKey: string) => {
    await toastAction({
      loadingTitle: t('messages.pausing'),
      successTitle: t('messages.paused'),
      errorTitle: t('messages.pauseFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${liveKey}/pause`)
        setBackendOnline(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleResumeReplay = async (liveKey: string) => {
    await toastAction({
      loadingTitle: t('messages.resuming'),
      successTitle: t('messages.resumed'),
      errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${liveKey}/resume`)
        setBackendOnline(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleDeleteReplayFile = async (r: Replay) => {
    const ok = window.confirm(
      t('messages.deleteConfirm'),
    )
    if (!ok) return
    const res = await toastAction({
      loadingTitle: t('messages.deleting'),
      loadingMessage: t('messages.removingLocal'),
      successTitle: t('messages.deleted'),
      successMessage: t('messages.localDeleted'),
      errorTitle: t('messages.deleteFailed'),
      action: () => apiClient.post(`/api/replays/${r.live_key}/delete-file`),
    })
    const updated = res.data as Replay
    setSelectedLiveKey(updated.live_key)
    await fetchReplays({ notify: false })
  }

  const handleCacheM3U8 = async (r: Replay) => {
    const res = await toastAction({
      loadingTitle: t('messages.caching'),
      loadingMessage: t('messages.fetchingM3u8'),
      successTitle: t('messages.cached'),
      successMessage: t('messages.savedM3u8'),
      errorTitle: t('messages.cacheFailed'),
      action: () => apiClient.post(`/api/replays/${r.live_key}/cache-m3u8`),
    })
    const updated = res.data as Replay
    setSelectedLiveKey(updated.live_key)
    await fetchReplays({ notify: false })
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const getCoverUrl = (localCover: string) => {
    if (!localCover) return null
    // Remove any leading 'covers/' if it exists to avoid double /covers/
    const filename = localCover.replace(/^covers[/\\]/, '')
    return buildApiUrl(`/covers/${filename}`)
  }

  const openDirModal = async () => {
    setDirModalOpen(true)
    await loadDirList('')
  }

  const loadDirList = async (path: string) => {
    setDirLoading(true)
    try {
      const res = await apiClient.get('/api/fs/list', { params: { path } })
      const data = res.data as FsListResponse
      setDirCurrent(data.current || '')
      setDirParent(data.parent || '')
      setDirEntries(data.entries || [])
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
      showToast({ tone: 'error', title: t('messages.listFailed'), message: getErrorMessage(e) })
    } finally {
      setDirLoading(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!config) return
    setSavingConfig(true)
    try {
      const prevDir = loadedConfigRef.current?.download?.output_dir || ''
      const dirChanged = prevDir && prevDir !== config.download.output_dir
      if (dirChanged) {
        const confirmDir = window.confirm(t('messages.dirChangePrompt'))
        if (!confirmDir) {
          setSavingConfig(false)
          return
        }
      }

      const prevTpl = loadedConfigRef.current?.download?.filename_template || ''
      const tplChanged = prevTpl && prevTpl !== config.download.filename_template
      const renameExisting = tplChanged ? window.confirm(t('messages.renamePrompt')) : false
      const res = await apiClient.post('/api/config', config, { params: { rename_existing: renameExisting ? 1 : 0 } })
      const migrated = parseInt(res.headers?.['x-migrated-files'] || '0')
      const renamed = parseInt(res.headers?.['x-renamed-files'] || '0')
      setConfig(res.data)
      loadedConfigRef.current = res.data
      setBackendOnline(true)
      fetchRuntime()
      if (migrated > 0 || renamed > 0) {
        showToast({
          tone: 'success',
          title: t('messages.saved'),
          message:
            t('messages.migratedRenamed', { 'migrated': migrated, 'renamed': renamed }),
        })
      } else {
        showToast({ tone: 'success', title: t('messages.saved') })
      }
    } catch (e) {
      setBackendOnline(false)
      showToast({ tone: 'error', title: t('messages.saveFailed'), message: getErrorMessage(e) })
      fetchConfig()
    } finally {
      setSavingConfig(false)
    }
  }

  const handleQuitApp = async () => {
    try {
      if (window.desktopAPI?.quitApp) {
        await window.desktopAPI.quitApp()
        return
      }
    } catch (e) {
      showToast({ tone: 'error', title: '退出失败', message: getErrorMessage(e) })
    }
  }

  const runtimePills = useMemo(() => {
    const pills: JSX.Element[] = []
    pills.push(<StatusPill key="backend" label={backendOnline ? t('dashboard.backendOnline') : t('dashboard.backendOffline')} tone={backendOnline ? 'good' : 'bad'} />)
    pills.push(<StatusPill key="ws" label={wsOnline ? 'WS Live' : 'WS Polling'} tone={wsOnline ? 'good' : 'neutral'} />)
    if (paused) pills.push(<StatusPill key="paused" label={t('common.paused')} tone="neutral" />)
    return pills
  }, [backendOnline, paused, t, wsOnline])

  const runtimeCards = [
    { label: t('dashboard.concurrencyLimit'), value: runtimeSnapshot.maxConcurrentTasks, tone: 'text-[var(--color-bili-blue)]' },
    { label: t('dashboard.downloadingTasks'), value: runtimeSnapshot.downloadingTasks, tone: 'text-green-600' },
    { label: t('dashboard.queuedTasks'), value: runtimeSnapshot.queuedTasks, tone: 'text-amber-600' },
    { label: t('dashboard.pausedTasks'), value: runtimeSnapshot.pausedTasks, tone: 'text-slate-600' },
  ]

  function ClipPage() {
    const [url, setUrl] = useState('')
    const [videoInfo, setVideoInfo] = useState<{ title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string }[] } } | null>(null)
    const [startTime, setStartTime] = useState(0)
    const [endTime, setEndTime] = useState(30)
    const [clipLoading, setClipLoading] = useState(false)
    const [clipError, setClipError] = useState('')
    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null)
    const [playing, setPlaying] = useState(false)
    const [clipResult, setClipResult] = useState<{ fileName: string; path: string } | null>(null)
    const [audioLoading, setAudioLoading] = useState(false)
    const [zoomWindow, setZoomWindow] = useState(120)
    const [scrollOffset, setScrollOffset] = useState(0)
    const [audioQualityIndex, setAudioQualityIndex] = useState(0)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const audioCtxRef = useRef<AudioContext | null>(null)
    const sourceRef = useRef<AudioBufferSourceNode | null>(null)
    const dragRef = useRef<'start' | 'end' | 'pan' | null>(null)
    const panStartRef = useRef<{ x: number; offset: number } | null>(null)

    // Create ONE AudioContext at mount time, never close until unmount
    useEffect(() => {
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      return () => {
        ctx.close().catch(() => {})
      }
    }, [])

    const fmtTime = useCallback((s: number) => {
      const m = Math.floor(s / 60)
      const sec = (s % 60).toFixed(1)
      return `${m}:${String(sec).padStart(4, '0')}`
    }, [])

    const fmtTimeLong = useCallback((s: number) => {
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = s % 60
      return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`
    }, [])

    const formatBandwidth = (bps: number) => {
      if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`
      if (bps >= 1000) return `${(bps / 1000).toFixed(0)} kbps`
      return `${bps} bps`
    }

    const fetchInfo = async () => {
      setClipLoading(true)
      setClipError('')
      setVideoInfo(null)
      setAudioBuffer(null)
      setClipResult(null)
      setAudioQualityIndex(0)
      try {
        const res = await apiClient.post('/api/clip/info', { url })
        const info = res.data as { title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string }[] } }
        setVideoInfo(info)
        setStartTime(0)
        setEndTime(Math.min(info.duration, 30))
        setScrollOffset(Math.min(info.duration, 30) / 2)
        if (info.audioProxyPath) {
          loadAudio(info.audioProxyPath)
        }
      } catch (e) {
        setClipError(getErrorMessage(e))
      }
      setClipLoading(false)
    }

    const loadAudio = async (proxyPath: string) => {
      setAudioLoading(true)
      try {
        const ctx = audioCtxRef.current!
        // Resume context if suspended (autoplay policy)
        if (ctx.state === 'suspended') {
          await ctx.resume()
        }
        const audioUrl = proxyPath.startsWith('http') ? proxyPath : `${apiBase}${proxyPath}`
        const resp = await apiClient.get(audioUrl, { responseType: 'arraybuffer' })
        const buffer = await ctx.decodeAudioData(resp.data as ArrayBuffer)
        setAudioBuffer(buffer)
      } catch (e) {
        showToast({ tone: 'error', title: 'Failed to load audio', message: getErrorMessage(e) })
      }
      setAudioLoading(false)
    }

    const drawWaveform = useCallback(() => {
      const canvas = canvasRef.current
      const buffer = audioBuffer
      if (!canvas || !buffer) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'

      const dur = buffer.duration
      const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
      const viewEnd = Math.min(dur, viewStart + zoomWindow)
      const viewDur = Math.max(0.1, viewEnd - viewStart)

      const data = buffer.getChannelData(0)
      const sampleRate = buffer.sampleRate
      const startSample = Math.floor(viewStart * sampleRate)
      const endSample = Math.min(data.length, Math.ceil(viewEnd * sampleRate))
      const viewSamples = endSample - startSample
      if (viewSamples <= 0) return

      const step = Math.ceil(viewSamples / w)
      ctx.clearRect(0, 0, w, h)
      const mid = h / 2
      const pixelsPerSecond = w / viewDur
      const startX = (startTime - viewStart) * pixelsPerSecond
      const endX = (endTime - viewStart) * pixelsPerSecond

      for (let i = 0; i < w; i++) {
        let max = 0
        const s = startSample + i * step
        const e = Math.min(startSample + (i + 1) * step, data.length)
        for (let j = s; j < e; j++) { const v = Math.abs(data[j]); if (v > max) max = v }
        const barH = max * mid * 1.2
        const inRange = i >= startX && i <= endX
        ctx.fillStyle = inRange ? 'rgba(0,161,214,0.7)' : 'rgba(148,163,184,0.55)'
        ctx.fillRect(i, mid - barH / 2, 1.5, Math.max(1, barH))
      }
      if (endX > startX) { ctx.fillStyle = 'rgba(0,161,214,0.08)'; ctx.fillRect(startX, 0, endX - startX, h) }

      const drawHandle = (x: number, label: string) => {
        ctx.strokeStyle = 'rgba(0,161,214,0.9)'; ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
        ctx.fillStyle = 'rgba(0,161,214,1)'
        ctx.beginPath(); ctx.arc(x, 0, 6, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'
        ctx.fillText(label, Math.max(15, Math.min(w - 15, x)), 16)
      }
      if (startX >= 0 && startX <= w) drawHandle(startX, fmtTime(startTime))
      if (endX >= 0 && endX <= w) drawHandle(endX, fmtTime(endTime))
    }, [audioBuffer, startTime, endTime, zoomWindow, scrollOffset, fmtTime])

    useEffect(() => {
      if (audioBuffer && videoInfo) drawWaveform()
    }, [drawWaveform, audioBuffer, videoInfo])

    useEffect(() => {
      return () => {
        if (sourceRef.current) {
          try { sourceRef.current.stop() } catch {}
        }
      }
    }, [])

    const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!audioBuffer || !videoInfo) return
      const canvas = canvasRef.current; if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const dur = audioBuffer.duration
      const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
      const viewDur = Math.min(dur - viewStart, zoomWindow)
      const pps = rect.width / viewDur
      const startX = (startTime - viewStart) * pps
      const endX = (endTime - viewStart) * pps
      const threshold = 12
      if (Math.abs(x - startX) < threshold) { dragRef.current = 'start' }
      else if (Math.abs(x - endX) < threshold) { dragRef.current = 'end' }
      else {
        dragRef.current = 'pan'
        panStartRef.current = { x: e.clientX, offset: scrollOffset }
      }
    }

    const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dragRef.current || !audioBuffer || !videoInfo) return
      const canvas = canvasRef.current; if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const dur = audioBuffer.duration
      if (dragRef.current === 'pan' && panStartRef.current) {
        const dx = (panStartRef.current.x - e.clientX) * (zoomWindow / rect.width)
        setScrollOffset(Math.max(zoomWindow / 2, Math.min(dur - zoomWindow / 2, panStartRef.current.offset + dx)))
        return
      }
      const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
      const viewDur = Math.min(dur - viewStart, zoomWindow)
      const t = viewStart + (Math.max(0, Math.min(rect.width, e.clientX - rect.left)) / rect.width) * viewDur
      if (dragRef.current === 'start') setStartTime(Math.max(0, Math.min(endTime - 0.5, t)))
      else setEndTime(Math.max(startTime + 0.5, Math.min(dur, t)))
    }

    const handleCanvasMouseUp = () => { dragRef.current = null; panStartRef.current = null }

    const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!audioBuffer) return
      e.preventDefault()
      const canvas = canvasRef.current; if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const dur = audioBuffer.duration
      const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
      const cursorTime = viewStart + ((e.clientX - rect.left) / rect.width) * zoomWindow

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Wheel = zoom at cursor
        const factor = e.deltaY > 0 ? 1.5 : 1 / 1.5
        const newZoom = Math.max(5, Math.min(dur, zoomWindow * factor))
        setZoomWindow(newZoom)
        setScrollOffset(Math.max(newZoom / 2, Math.min(dur - newZoom / 2, cursorTime)))
      } else {
        // Plain wheel = pan/scroll
        const shift = (e.deltaY / 100) * (zoomWindow / 2)
        setScrollOffset(Math.max(zoomWindow / 2, Math.min(dur - zoomWindow / 2, scrollOffset + shift)))
      }
    }

    const playPreview = () => {
      if (!audioBuffer) return
      const ctx = audioCtxRef.current
      if (!ctx) return
      if (ctx.state === 'closed') return
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {})
      }
      if (sourceRef.current) {
        try { sourceRef.current.stop() } catch {}
      }
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      const offset = Math.max(0, startTime)
      const dur = Math.max(0.1, endTime - startTime)
      source.start(0, offset, dur)
      source.onended = () => setPlaying(false)
      sourceRef.current = source
      setPlaying(true)
    }

    const stopPreview = () => {
      if (sourceRef.current) {
        try { sourceRef.current.stop() } catch {}
        sourceRef.current = null
      }
      setPlaying(false)
    }

    const executeClip = async () => {
      if (!videoInfo) return
      setClipLoading(true)
      setClipError('')
      try {
        const res = await apiClient.post('/api/clip/execute', { url, startTime, endTime, qualityIndex: audioQualityIndex })
        setClipResult(res.data as { fileName: string; path: string })
        showToast({ tone: 'success', title: 'Clip completed', message: (res.data as { fileName: string }).fileName })
      } catch (e) {
        setClipError(getErrorMessage(e))
        showToast({ tone: 'error', title: 'Clip failed', message: getErrorMessage(e) })
      }
      setClipLoading(false)
    }

    return (
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Scissors className="w-6 h-6 text-[var(--color-bili-blue)]" />
          <h2 className="text-2xl font-bold tracking-tight">{t('common.clip')}</h2>
        </div>

        {/* URL Input + Fetch */}
        <div className="flex gap-3">
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.bilibili.com/video/BV..."
            className="flex-1 px-4 py-3 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] focus:border-transparent outline-none transition"
            onKeyDown={e => { if (e.key === 'Enter') fetchInfo() }}
          />
          <button
            onClick={fetchInfo}
            disabled={clipLoading || !url.trim()}
            className="px-6 py-3 bg-[var(--color-bili-blue)] text-white font-medium rounded-xl hover:brightness-110 transition disabled:opacity-50"
          >
            {clipLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Fetch Info'}
          </button>
        </div>

        {clipError && (
          <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{clipError}</div>
        )}

        {/* Video Info Card */}
        {videoInfo && (
          <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm space-y-4">
            <div className="flex gap-4">
              {videoInfo.cover && (
                <img
                  src={videoInfo.cover.startsWith('http') ? videoInfo.cover : `${apiBase}${videoInfo.cover}`}
                  alt=""
                  className="w-40 h-24 object-cover rounded-lg flex-shrink-0"
                />
              )}
              <div className="min-w-0">
                <div className="font-semibold text-slate-900 text-lg leading-6 truncate">{videoInfo.title}</div>
                <div className="text-sm text-slate-500 mt-1">By {videoInfo.author}</div>
                <div className="text-sm text-slate-500 mt-0.5">{t('common.duration')}: {fmtTime(videoInfo.duration)}</div>
              </div>
            </div>

            {/* Quality Selectors */}
            {videoInfo.qualities && (
              <div className="flex flex-wrap gap-4">
                {videoInfo.qualities.audio.length > 1 && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-slate-600">Audio Quality:</label>
                    <select
                      value={audioQualityIndex}
                      onChange={e => setAudioQualityIndex(Number(e.target.value))}
                      className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
                    >
                      {videoInfo.qualities.audio.map((a, i) => (
                        <option key={a.id} value={i}>
                          {formatBandwidth(a.bandwidth)} {a.codecs ? `(${a.codecs})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {videoInfo.qualities.video.length > 1 && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-slate-600">Video Quality:</label>
                    <select
                      className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
                    >
                      {videoInfo.qualities.video.map((v, i) => (
                        <option key={v.id} value={i}>
                          {v.width}x{v.height} {formatBandwidth(v.bandwidth)} {v.codecs ? `(${v.codecs})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Time Range Inputs */}
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">{t('common.startTime')}:</label>
                <input
                  type="number"
                  value={startTime}
                  onChange={e => setStartTime(Math.max(0, Math.min(endTime - 0.5, parseFloat(e.target.value) || 0)))}
                  step="0.1"
                  min="0"
                  max={videoInfo.duration}
                  className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
                />
                <span className="text-xs text-slate-400">{t('common.sec')}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">{t('common.endTime')}:</label>
                <input
                  type="number"
                  value={endTime}
                  onChange={e => setEndTime(Math.max(startTime + 0.5, Math.min(videoInfo.duration, parseFloat(e.target.value) || 0)))}
                  step="0.1"
                  min="0"
                  max={videoInfo.duration}
                  className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
                />
                <span className="text-xs text-slate-400">{t('common.sec')}</span>
              </div>
              <div className="text-xs text-slate-400">({fmtTime(endTime - startTime)})</div>
            </div>

            {/* Range sliders */}
            <div className="space-y-1">
              <input
                type="range"
                value={startTime}
                onChange={e => setStartTime(Math.max(0, Math.min(endTime - 0.5, parseFloat(e.target.value))))}
                min="0"
                max={videoInfo.duration}
                step="0.1"
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[var(--color-bili-blue)]"
              />
              <input
                type="range"
                value={endTime}
                onChange={e => setEndTime(Math.max(startTime + 0.5, Math.min(videoInfo.duration, parseFloat(e.target.value))))}
                min="0"
                max={videoInfo.duration}
                step="0.1"
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[var(--color-bili-blue)]"
              />
            </div>
          </div>
        )}

        {/* Waveform */}
        {(audioBuffer || audioLoading) && (
          <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm font-semibold text-slate-700">Audio Waveform</div>
              <div className="text-xs text-slate-400">
                Ctrl+Wheel zoom · drag to pan · {fmtTime(zoomWindow)} view
              </div>
            </div>
            {audioLoading ? (
              <div className="flex items-center justify-center h-32 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading audio...
              </div>
            ) : audioBuffer ? (
              <canvas
                ref={canvasRef}
                className="w-full h-24 rounded-lg bg-slate-50 border border-slate-200 cursor-col-resize"
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
                onWheel={handleCanvasWheel}
              />
            ) : null}

            {/* Play/Pause */}
            {audioBuffer && (
              <div className="flex items-center gap-3">
                <button
                  onClick={playing ? stopPreview : playPreview}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
                >
                  {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  {playing ? 'Stop' : 'Play Preview'}
                </button>
                <span className="text-xs text-slate-500">
                  {fmtTime(startTime)} – {fmtTime(endTime)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Execute Clip */}
        {videoInfo && (
          <div className="flex items-center gap-4">
            <button
              onClick={executeClip}
              disabled={clipLoading || !audioBuffer}
              className="flex items-center gap-2 px-6 py-3 bg-[var(--color-bili-pink)] text-white font-medium rounded-xl hover:brightness-110 transition disabled:opacity-50"
            >
              {clipLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scissors className="w-5 h-5" />}
              Execute Clip
            </button>
          </div>
        )}

        {/* Result */}
        {clipResult && (
          <div className="p-4 rounded-xl bg-green-50 border border-green-200 space-y-1">
            <div className="flex items-center gap-2 text-green-700 text-sm font-semibold">
              <CheckCircle className="w-4 h-4" />
              Clip completed successfully!
            </div>
            <div className="text-sm text-green-600 font-mono">{clipResult.fileName}</div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_right,_rgba(0,161,214,0.10),_transparent_28%),linear-gradient(180deg,_#f8fafc_0%,_#f1f5f9_100%)] text-slate-800 app-fade-in">
      <div className="fixed top-4 right-4 z-[100] w-[min(360px,calc(100vw-2rem))] space-y-2">
        {toasts.map(t => {
          const toneCls =
            t.tone === 'success'
              ? 'border-green-200 bg-green-50 text-green-900'
              : t.tone === 'error'
              ? 'border-red-200 bg-red-50 text-red-900'
              : t.tone === 'loading'
              ? 'border-slate-200 bg-white text-slate-900'
              : 'border-slate-200 bg-slate-50 text-slate-900'
          return (
            <div key={t.id} className={`rounded-xl border shadow-sm px-3 py-2 ${toneCls}`}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {t.tone === 'success' ? (
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  ) : t.tone === 'error' ? (
                    <XCircle className="w-4 h-4 text-red-600" />
                  ) : t.tone === 'loading' ? (
                    <Loader2 className="w-4 h-4 text-[var(--color-bili-blue)] animate-spin" />
                  ) : (
                    <div className="w-4 h-4 rounded-full bg-slate-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">{t.title}</div>
                  {t.message ? <div className="text-xs text-slate-600 mt-0.5 break-words">{t.message}</div> : null}
                </div>
                <button onClick={() => dismissToast(t.id)} className="p-1 rounded hover:bg-black/5">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex h-screen overflow-hidden">
        <div className={`fixed inset-0 z-40 bg-black/30 ${sidebarOpen ? '' : 'hidden'}`} onClick={() => setSidebarOpen(false)} />

        <aside className={`fixed z-50 inset-y-0 left-0 w-72 h-screen bg-white border-r border-slate-200 flex flex-col transform transition-transform md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:w-64 md:h-screen md:flex-shrink-0`}>
          <div className="h-16 flex items-center justify-between px-6 border-b border-slate-200">
            <div className="flex items-center">
              <Tv className="w-6 h-6 text-[var(--color-bili-pink)] mr-2" />
              <h1 className="font-bold text-lg tracking-tight">Replay Manager</h1>
            </div>
            <button className="md:hidden p-2 rounded hover:bg-slate-100" onClick={() => setSidebarOpen(false)}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <nav className="flex-1 py-4 px-3 space-y-1">
            <button
              onClick={() => { setPage('downloads'); setSidebarOpen(false) }}
              className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md ${page === 'downloads' ? 'bg-stone-100 text-[var(--color-bili-blue)]' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              <LayoutDashboard className="w-5 h-5 mr-3" />
              {t('common.downloads')}
            </button>
            <button
              onClick={() => { setPage('settings'); setSidebarOpen(false) }}
              className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md ${page === 'settings' ? 'bg-stone-100 text-[var(--color-bili-blue)]' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              <Settings className="w-5 h-5 mr-3" />
              {t('common.settings')}
            </button>
            <button
              onClick={() => { setPage('clip'); setSidebarOpen(false) }}
              className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md ${page === 'clip' ? 'bg-stone-100 text-[var(--color-bili-blue)]' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              <Scissors className="w-5 h-5 mr-3" />
              {t('common.clip')}
            </button>

            <div className="pt-4">
              <div className="flex flex-wrap gap-2 px-3">{runtimePills}</div>
            </div>

            <div className="mt-3 px-3">
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-sm font-semibold">{t('dashboard.runtimeCard')}</div>
                <div className="mt-2 space-y-1 text-xs text-slate-600">
                  <div className="flex items-center justify-between gap-3">
                    <span>{t('dashboard.concurrencyLimit')}</span>
                    <span className="font-mono">{runtimeSnapshot.maxConcurrentTasks}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>{t('dashboard.segmentConcurrency')}</span>
                    <span className="font-mono">{runtimeSnapshot.concurrentSegments}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>{t('dashboard.downloadingTasks')}</span>
                    <span className="font-mono">{runtimeSnapshot.downloadingTasks}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>{t('dashboard.queuedTasks')}</span>
                    <span className="font-mono">{runtimeSnapshot.queuedTasks}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>{t('dashboard.pausedTasks')}</span>
                    <span className="font-mono">{runtimeSnapshot.pausedTasks}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>{t('dashboard.failedTasks')}</span>
                    <span className="font-mono">{runtimeSnapshot.failedTasks}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 px-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full overflow-hidden bg-white border border-slate-200 flex items-center justify-center">
                    {me?.logged_in && me.face ? (
                      <img src={buildApiUrl(`/api/avatar?url=${encodeURIComponent(me.face)}`)} alt="" className="w-full h-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{me?.logged_in ? (me?.uname || '-') : '-'}</div>
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${me?.logged_in ? 'bg-green-500' : 'bg-slate-400'}`}></span>
                      {me?.logged_in ? t('common.loggedIn') : (<button onClick={() => setShowLoginModal(true)} className="hover:text-slate-800 underline decoration-slate-300 underline-offset-2 transition-colors">{t('common.login')}</button>)}
                    </div>
                  </div>
                </div>
              </div>
              {config?.download?.output_dir ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">{t('dashboard.disk')}</div>
                    <button
                      onClick={fetchDiskStats}
                      disabled={diskStatsLoading || !backendOnline}
                      className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {diskStatsLoading ? (t('dashboard.loading')) : (t('common.refresh'))}
                    </button>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-slate-600">
                    {diskStats ? (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <span>{t('dashboard.total')}</span>
                          <span className="font-mono">{formatBytes(diskStats.total_bytes)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>{t('dashboard.free')}</span>
                          <span className="font-mono">{formatBytes(diskStats.free_bytes)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>{t('dashboard.usedByApp')}</span>
                          <span className="font-mono">{formatBytes(diskStats.used_by_service_bytes)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-400">{t('dashboard.noData')}</div>
                    )}
                  </div>
                </div>
              ) : null}
              <button
                onClick={() => { const nextLang = lang === 'en' ? 'zh' : 'en'; i18n.changeLanguage(nextLang); localStorage.setItem('lang', nextLang); }}
                className="mt-3 w-full flex items-center justify-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition"
              >
                {lang === 'en' ? '中文 (ZH)' : 'English (EN)'}
              </button>
            </div>
          </nav>

          <div className="p-4 border-t border-slate-200 space-y-2">
            <button
              onClick={paused ? handleResumeAll : handlePauseAll}
              disabled={!backendOnline}
              className="w-full flex items-center justify-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
            >
              {paused ? <Play className="w-4 h-4 mr-2" /> : <Pause className="w-4 h-4 mr-2" />}
              {paused ? t('dashboard.resumeAll') : t('dashboard.pauseAll')}
            </button>
            <button
              onClick={handleCleanupStale}
              disabled={!backendOnline}
              className="w-full flex items-center justify-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
            >
              <Wrench className="w-4 h-4 mr-2" />
              {t('dashboard.fixStale')}
            </button>
            <button
              onClick={handleCleanupStreams}
              disabled={!backendOnline}
              className="w-full flex items-center justify-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
            >
              <Eraser className="w-4 h-4 mr-2" />
              {t('dashboard.cleanStreams')}
            </button>
          </div>
        </aside>

        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <div className="h-16 flex items-center justify-between px-4 sm:px-6 border-b border-slate-200 bg-white md:hidden">
            <button className="p-2 rounded hover:bg-slate-100" onClick={() => setSidebarOpen(true)}>
              <Menu className="w-5 h-5" />
            </button>
            <div className="font-semibold">Replay Manager</div>
            <div className="w-9" />
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            {page === 'downloads' && (
              <div className="max-w-[min(100%,96rem)] mx-auto">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                  <div>
                    <div className="text-2xl font-bold tracking-tight">{t('dashboard.downloadsTitle')}</div>
                    <div className="text-sm text-slate-500 mt-1">{t('dashboard.downloadsDesc')}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => fetchReplays({ notify: true })}
                      disabled={isRefreshing}
                      className="flex items-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
                    >
                      <Tooltip content={t('dashboard.refreshTip')}>
                        <span className="inline-flex items-center">
                          <RefreshCcw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                          {t('common.refresh')}
                        </span>
                      </Tooltip>
                    </button>
                    <button
                      onClick={handleScan}
                      disabled={isScanning}
                      className="flex items-center px-3 py-2 bg-[var(--color-bili-blue)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition disabled:opacity-50"
                    >
                      <Tooltip content={t('dashboard.scanTip')}>
                        <span className="inline-flex items-center">
                          <Loader2 className={`w-4 h-4 mr-2 ${isScanning ? 'animate-spin' : ''}`} />
                          {t('common.scan')}
                        </span>
                      </Tooltip>
                    </button>
                    <button
                      onClick={handleSyncAll}
                      disabled={!backendOnline || paused || isSyncingAll}
                      className="flex items-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {isSyncingAll ? t('dashboard.syncing') : t('dashboard.syncAllPending')}
                    </button>
                    <div className="relative" ref={advancedMenuRef}>
                      <button
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className={`flex items-center px-2 py-2 border text-sm font-medium rounded-lg transition ${showAdvanced ? 'bg-slate-100 border-slate-400 text-slate-800' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'}`}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {showAdvanced && (
                        <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-[150] overflow-hidden py-1">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={exportUseProxy}
                            onClick={() => setExportUseProxy(!exportUseProxy)}
                            className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                          >
                            <span>{t('common.exportUseProxy', '本地代理流')}</span>
                            <div className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${exportUseProxy ? 'bg-[var(--color-bili-blue)]' : 'bg-slate-300'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${exportUseProxy ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                            </div>
                          </button>
                          <div className="h-px bg-slate-100 my-1 mx-2" />
                          <button
                            onClick={() => { window.open(buildApiUrl(`/api/export-tsv?proxy=${exportUseProxy}`), '_blank'); setShowAdvanced(false); }}
                            className="w-full flex items-center px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                          >
                            <Download className="w-4 h-4 mr-3 text-slate-400" />
                            {t('common.export')}
                          </button>
                          <button
                            onClick={() => { handleCopyExport(); setShowAdvanced(false); }}
                            className="w-full flex items-center px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                          >
                            <Copy className="w-4 h-4 mr-3 text-slate-400" />
                            {t('common.copyExport')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                  {runtimeCards.map(card => (
                    <div key={card.label} className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm">
                      <div className="text-sm text-slate-500">{card.label}</div>
                      <div className={`text-2xl font-bold mt-1 ${card.tone}`}>{card.value}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
                  <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm">
                    <div className="text-sm text-slate-500">{t('common.records')}</div>
                    <div className="text-2xl font-bold mt-1">{replays.length}</div>
                  </div>
                  <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm">
                    <div className="text-sm text-slate-500">{t('common.active')}</div>
                    <div className="text-2xl font-bold mt-1">{activeDownloading}</div>
                  </div>
                  <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm">
                    <div className="text-sm text-slate-500">{t('common.mode')}</div>
                    <div className="text-2xl font-bold mt-1">{paused ? t('common.paused') : t('common.running')}</div>
                  </div>
                </div>

                <div className="app-card rounded-2xl border border-white/70 bg-white/90 overflow-hidden backdrop-blur-sm">
                  <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                    <h2 className="font-semibold flex items-center">
                      <Download className="w-5 h-5 text-slate-500 mr-2" />
                      {t('dashboard.queue')}
                    </h2>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {replays.length === 0 && (
                      <div className="text-center py-12 text-slate-500">{t('dashboard.empty')}</div>
                    )}

                    {replays.map(r => {
                      const rawProgress = progressMap[r.live_key]
                      const p = shouldUseRealtimeProgress(rawProgress, r) ? rawProgress : undefined
                      const displayStatus = p?.status || r.status
                      const baseProgress = Math.max(0, Math.min(100, p?.progress ?? r.progress ?? 0))
                      const mergeProgress = Math.max(0, Math.min(100, p?.merge_progress ?? 0))

                      let displayProgress = baseProgress
                      if (displayStatus === 'downloading') {
                        displayProgress = baseProgress * 0.95
                      } else if (displayStatus === 'merging') {
                        displayProgress = 95 + (mergeProgress * 0.05)
                      }

                      const showProgress = ['downloading', 'merging', 'paused'].includes(displayStatus)
                      const progText = p?.message || r.message
                      const barColor =
                        displayStatus === 'paused'
                          ? 'bg-amber-500'
                          : displayStatus === 'completed'
                          ? 'bg-green-500'
                          : displayStatus === 'failed'
                          ? 'bg-red-500'
                          : displayStatus === 'deleted'
                          ? 'bg-violet-500'
                          : showProgress
                          ? 'bg-[var(--color-bili-blue)]'
                          : 'bg-slate-400'
                      return (
                        <div key={r.ID} className="p-4 sm:p-5 hover:bg-slate-50/80 transition-colors duration-300">
                          <div className="flex flex-col xl:flex-row gap-4 items-stretch xl:items-start">
                            <div className="w-full sm:w-44 xl:w-32 h-28 sm:h-24 xl:h-20 bg-slate-200 rounded-xl overflow-hidden flex-shrink-0 relative shadow-sm">
                              {r.local_cover ? (
                                <img src={getCoverUrl(r.local_cover)!} className="w-full h-full object-cover" />
                              ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">{t('dashboard.noCover')}</div>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                                <div className="min-w-0">
                                  <Tooltip content={r.title}>
                                    <div className="font-medium text-slate-900 break-words leading-6">{r.title}</div>
                                  </Tooltip>
                                  <div className="text-[11px] text-slate-400 font-mono mt-1 break-all">{r.live_key}</div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`inline-flex items-center gap-2 text-xs font-medium px-2 py-1 rounded-full border border-slate-200 bg-white shadow-sm`}>
                                    <span className={`w-2 h-2 rounded-full ${statusColor(displayStatus)}`}></span>
                                    {displayStatus.toUpperCase()}
                                  </span>
                                  {displayStatus === 'completed' && <CheckCircle className="w-4 h-4 text-green-500" />}
                                  {displayStatus === 'failed' && <XCircle className="w-4 h-4 text-red-500" />}
                                  {displayStatus === 'deleted' && <XCircle className="w-4 h-4 text-violet-500" />}
                                  {(displayStatus === 'downloading' || displayStatus === 'merging') && <Loader2 className="w-4 h-4 text-[var(--color-bili-blue)] animate-spin" />}
                                  {displayStatus === 'paused' && <PauseCircle className="w-4 h-4 text-amber-500" />}
                                </div>
                              </div>

                              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
                                <span>{t('common.start')}: {new Date(r.start_time * 1000).toLocaleString()}</span>
                                <span>{t('common.duration')}: {Math.floor(r.duration / 60)}m</span>
                                <span>{t('common.size')}: {formatBytes(r.file_size)}</span>
                                {p?.speed ? <span>{t('common.speed')}: {p.speed}</span> : null}
                              </div>

                              <div className="mt-4">
                                <div className="w-full bg-slate-200/80 rounded-full h-2 overflow-hidden">
                                  <div
                                    className={`${barColor} h-2 rounded-full transition-all duration-500 ease-out`}
                                    style={{ width: `${showProgress ? displayProgress : (displayStatus === 'completed' ? 100 : 0)}%` }}
                                  />
                                </div>
                                <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                                  <span className="truncate max-w-[70%]">{progText || '--'}</span>
                                  <span>{showProgress ? `${Math.round(displayProgress)}%` : ''}</span>
                                </div>
                                {displayStatus === 'merging' ? (
                                  <div className="mt-2">
                                    <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                                      <div
                                        className="bg-[var(--color-bili-pink)] h-1.5 rounded-full transition-all duration-500 ease-out"
                                        style={{ width: `${mergeProgress}%` }}
                                      />
                                    </div>
                                    <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                                      <span className="truncate max-w-[70%]">{t('dashboard.mergeProgress')}</span>
                                      <span>{`${Math.round(mergeProgress)}%`}</span>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex flex-row xl:flex-col flex-wrap gap-2 xl:w-auto">
                              {['failed', 'deleted', 'not_downloaded'].includes(displayStatus) && (
                                <button
                                  onClick={() => handleDownload(r.live_key)}
                                  disabled={!backendOnline || paused}
                                  className="p-2.5 text-slate-500 hover:text-[var(--color-bili-blue)] rounded-xl bg-white border border-slate-200 shadow-sm transition duration-200 hover:-translate-y-0.5 disabled:opacity-50"
                                >
                                  <Tooltip content={t('dashboard.startBtn')}>
                                    <Play className="w-4 h-4" />
                                  </Tooltip>
                                </button>
                              )}
                              {(displayStatus === 'downloading' || displayStatus === 'merging' || displayStatus === 'pending') && (
                                <button
                                  onClick={() => handlePauseReplay(r.live_key)}
                                  disabled={!backendOnline}
                                  className="p-2.5 text-slate-500 hover:text-amber-500 rounded-xl bg-white border border-slate-200 shadow-sm transition duration-200 hover:-translate-y-0.5 disabled:opacity-50"
                                >
                                  <Tooltip content={t('dashboard.pauseBtn')}>
                                    <Pause className="w-4 h-4" />
                                  </Tooltip>
                                </button>
                              )}
                              {displayStatus === 'paused' && (
                                <button
                                  onClick={() => handleResumeReplay(r.live_key)}
                                  disabled={!backendOnline || paused}
                                  className="p-2.5 text-slate-500 hover:text-green-600 rounded-xl bg-white border border-slate-200 shadow-sm transition duration-200 hover:-translate-y-0.5 disabled:opacity-50"
                                >
                                  <Tooltip content={t('dashboard.resumeBtn')}>
                                    <Play className="w-4 h-4" />
                                  </Tooltip>
                                </button>
                              )}
                                <button
                                  onClick={() => setSelectedLiveKey(r.live_key)}
                                className="p-2.5 text-slate-500 hover:text-slate-800 rounded-xl bg-white border border-slate-200 shadow-sm transition duration-200 hover:-translate-y-0.5"
                              >
                                <Tooltip content={t('common.details')}>
                                  <Wrench className="w-4 h-4" />
                                </Tooltip>
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {page === 'settings' && (
              <div className="max-w-5xl mx-auto">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
                  <div>
                    <div className="text-2xl font-bold tracking-tight">{t('settings.configTitle')}</div>
                    <div className="text-sm text-slate-500 mt-1">{t('settings.configDesc')}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={handleQuitApp}
                      className="flex items-center px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg font-medium transition hover:bg-slate-50"
                    >
                      退出程序
                    </button>
                    <button
                      onClick={handleSaveConfig}
                      disabled={!backendOnline || paused || savingConfig || !config}
                      className="flex items-center px-4 py-2 bg-[var(--color-bili-pink)] hover:opacity-90 text-white rounded-lg font-medium transition disabled:opacity-50"
                    >
                      <RefreshCcw className={`w-4 h-4 mr-2 ${savingConfig ? 'animate-spin' : ''}`} />
                      {savingConfig ? t('settings.saving') : t('common.save')}
                    </button>
                  </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
                  <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center">
                    <Settings className="w-5 h-5 text-slate-500 mr-2" />
                    <h2 className="font-semibold">{t('settings.systemConfig')}</h2>
                  </div>

                  {!config ? (
                    <div className="p-6 text-slate-500">Loading…</div>
                  ) : (
                    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.anchorId')}</label>
                        <input
                          value={config.bilibili.anchor_id || 0}
                          onChange={e => setConfig({ ...config, bilibili: { ...config.bilibili, anchor_id: parseInt(e.target.value || '0') } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.outputDir')}</label>
                        <div className="flex gap-2">
                          <input
                            value={config.download.output_dir || ''}
                            onChange={e => setConfig({ ...config, download: { ...config.download, output_dir: e.target.value } })}
                            className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                          />
                          <button
                            type="button"
                            onClick={openDirModal}
                            disabled={!backendOnline}
                            className="px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
                          >
                            {t('common.browse')}
                          </button>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{t('settings.outputTip')}</div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">Clip Output Dir</label>
                        <input
                          value={config.download.clip_output_dir || ''}
                          onChange={e => setConfig({ ...config, download: { ...config.download, clip_output_dir: e.target.value } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                        <div className="text-xs text-slate-500 mt-1">Output directory for clipped audio files</div>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.filenameTpl')}</label>
                        <input
                          value={config.download.filename_template || ''}
                          onChange={e => setConfig({ ...config, download: { ...config.download, filename_template: e.target.value } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                        <div className="text-xs text-slate-500 mt-1">
                          {'{yy}'} {'{MM}'} {'{dd}'} {'{start:150405}'} {'{title}'} {'{live_key}'} {'{start}'} {'{end}'}
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.maxTasks')}</label>
                        <input
                          value={config.download.max_concurrent_tasks || 1}
                          onChange={e => setConfig({ ...config, download: { ...config.download, max_concurrent_tasks: parseInt(e.target.value || '1') } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.segConc')}</label>
                        <input
                          value={config.download.concurrent_segments || 1}
                          onChange={e => setConfig({ ...config, download: { ...config.download, concurrent_segments: parseInt(e.target.value || '1') } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {page === 'clip' && <ClipPage />}
          </div>
        </main>
      </div>

      {selectedReplay && (
        <div className="fixed inset-0 bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50 app-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[88vh] overflow-hidden border border-white/70">
            <div className="p-4 sm:p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900">{t('dashboard.detailsTitle')}</h3>
              <button onClick={() => setSelectedLiveKey(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-4 sm:p-6 space-y-6 overflow-y-auto max-h-[calc(88vh-76px)]">
              <div className="flex flex-col xl:flex-row gap-6">
                {selectedReplay.local_cover && (
                  <img src={getCoverUrl(selectedReplay.local_cover)!} alt="" className="w-full xl:w-72 h-44 xl:h-40 object-cover rounded-xl shadow-sm" />
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 flex-1">
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.status')}</label>
                    <p className="capitalize font-medium">{selectedReplay.status}</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.startTime')}</label>
                    <p className="text-sm">{new Date(selectedReplay.start_time * 1000).toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.endTime')}</label>
                    <p className="text-sm">{new Date(selectedReplay.end_time * 1000).toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.duration')}</label>
                    <p className="text-sm">{Math.floor(selectedReplay.duration / 60)} {t('common.min')} {selectedReplay.duration % 60} {t('common.sec')}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 p-4 bg-gray-50 rounded-xl">
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.resolution')}</label>
                  <p className="font-medium">{selectedReplay.resolution || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.bitrate')}</label>
                  <p className="font-medium">{selectedReplay.bitrate || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.fileSize')}</label>
                  <p className="font-medium">{formatBytes(selectedReplay.file_size)}</p>
                </div>
              </div>
              
              <div>
                <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('dashboard.currentMessage')}</label>
                <div className={`mt-1 p-3 rounded bg-gray-50 font-mono text-sm border ${selectedReplay.status === 'failed' ? 'border-red-100 text-red-600 bg-red-50' : 'border-gray-100'}`}>
                  {(shouldUseRealtimeProgress(progressMap[selectedReplay.live_key], selectedReplay) ? progressMap[selectedReplay.live_key]?.message : undefined) || selectedReplay.message || '-'}
                </div>
              </div>

              {selectedReplay.file_path && (
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{t('common.localPath')}</label>
                  <p className="text-xs font-mono break-all mt-1 bg-gray-50 p-2 rounded border border-gray-100">{selectedReplay.file_path}</p>
                </div>
              )}

              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-gray-500">m3u8</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleCacheM3U8(selectedReplay)}
                      disabled={!backendOnline}
                      className="px-3 py-1.5 bg-white border border-gray-200 text-xs font-medium rounded hover:bg-gray-50 transition disabled:opacity-50"
                    >
                      {t('dashboard.cache')}
                    </button>
                    <button
                      onClick={() => setM3u8Open(v => !v)}
                      className="px-3 py-1.5 bg-white border border-gray-200 text-xs font-medium rounded hover:bg-gray-50 transition"
                    >
                      {m3u8Open ? (t('dashboard.hide')) : (t('dashboard.show'))}
                    </button>
                  </div>
                </div>
                {m3u8Open ? (
                  <div className="mt-3 space-y-3">
                    {(selectedReplay.streams || []).length === 0 ? (
                      <div className="text-xs text-gray-400">{t('dashboard.noStreams')}</div>
                    ) : (
                      (selectedReplay.streams || []).map((s, idx) => (
                        <div key={idx} className="bg-white border border-gray-100 rounded-lg p-3">
                          <div className="text-[11px] text-gray-500 font-mono break-all">{s.stream}</div>
                          <div className="mt-2">
                            <textarea
                              readOnly
                              value={s.m3u8_text || ''}
                              className="w-full h-32 text-[11px] font-mono border border-gray-100 rounded p-2 bg-gray-50"
                            />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t">
                <button
                  onClick={() => handleDeleteReplayFile(selectedReplay)}
                  disabled={!backendOnline || !selectedReplay.file_path}
                  className="w-full sm:w-auto px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  {t('dashboard.deleteFile')}
                </button>
                <button
                  onClick={() => setSelectedLiveKey(null)}
                  className="w-full sm:w-auto px-8 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dirModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="font-semibold">{t('dashboard.chooseDir')}</div>
              <button className="p-2 rounded hover:bg-slate-100" onClick={() => setDirModalOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
              <div className="text-sm text-slate-600 truncate">{dirCurrent || t('dashboard.drives')}</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadDirList(dirParent)}
                  disabled={dirLoading || (!dirParent && !!dirCurrent)}
                  className="px-3 py-1.5 bg-white border border-slate-300 text-sm font-medium rounded hover:bg-slate-50 transition disabled:opacity-50"
                >
                  {t('common.up')}
                </button>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {dirLoading ? (
                <div className="p-6 text-slate-500">Loading…</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {dirEntries.map(en => (
                    <button
                      key={en.path}
                      onClick={() => loadDirList(en.path)}
                      className="w-full px-6 py-3 flex items-center justify-between hover:bg-slate-50 transition text-left"
                    >
                      <div className="text-sm font-medium text-slate-800">{en.name}</div>
                      <div className="text-xs text-slate-400 truncate ml-4">{en.path}</div>
                    </button>
                  ))}
                  {dirEntries.length === 0 && <div className="p-6 text-slate-500">{t('dashboard.noSubfolders')}</div>}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex justify-between items-center">
              <div className="text-xs text-slate-500 truncate">{dirCurrent ? `${t('common.selected')}: ${dirCurrent}` : ''}</div>
              <button
                onClick={() => {
                  if (!config || !dirCurrent) return
                  setConfig({ ...config, download: { ...config.download, output_dir: dirCurrent } })
                  setDirModalOpen(false)
                }}
                disabled={!config || !dirCurrent}
                className="px-4 py-2 bg-[var(--color-bili-blue)] text-white rounded-lg font-medium hover:opacity-90 transition disabled:opacity-50"
              >
                {t('common.useFolder')}
              </button>
            </div>
          </div>
        </div>
      )}
    {showLoginModal && <LoginModal apiClient={apiClient} onClose={() => setShowLoginModal(false)} onSuccess={() => { setShowLoginModal(false); fetchMe(); }} />}
      </div>
  )
}

export default App
