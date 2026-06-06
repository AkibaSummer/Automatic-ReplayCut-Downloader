import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import axios from 'axios'
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

import type {
  Replay,
  Config,
  Progress,
  Me,
  Runtime,
  ScanSummary,
  DiskStats,
  PageKey,
  FsEntry,
  FsListResponse,
  Toast,
  ToastTone,
} from './types'
import {
  getErrorMessage,
  formatBytes,
  statusColor,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  shouldUseRealtimeProgress,
} from './utils'
import { StatusPill, Tooltip, LoginModal } from './components'
import { ClipPage } from './ClipPage'
import { SettingsPage } from './SettingsPage'





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
              <SettingsPage
                config={config}
                setConfig={setConfig}
                savingConfig={savingConfig}
                handleSaveConfig={handleSaveConfig}
                handleQuitApp={handleQuitApp}
                backendOnline={backendOnline}
                paused={paused}
                openDirModal={openDirModal}
                t={t}
              />
            )}

            {page === 'clip' && <ClipPage apiClient={apiClient} apiBase={apiBase} showToast={showToast} t={t} />}
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
