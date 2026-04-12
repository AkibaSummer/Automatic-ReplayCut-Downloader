import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'
import {
  Download,
  LayoutDashboard,
  Menu,
  Pause,
  PauseCircle,
  Play,
  RefreshCcw,
  Settings,
  Tv,
  Wrench,
  X,
  CheckCircle,
  XCircle,
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

type PageKey = 'downloads' | 'settings'

type FsEntry = { name: string; path: string }
type FsListResponse = { current: string; parent: string; entries: FsEntry[] }

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

function App() {
  const [lang, setLang] = useState<'zh' | 'en'>(() => {
    const v = localStorage.getItem('lang')
    return v === 'en' ? 'en' : 'zh'
  })
  const [page, setPage] = useState<PageKey>('downloads')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem('lang', lang)
  }, [lang])

  const texts = useMemo(() => {
    const zh = {
      downloads: '下载',
      settings: '配置',
      backendOnline: '后端在线',
      backendOffline: '后端离线',
      paused: '已暂停',
      loggedIn: '已登录',
      notLoggedIn: '未登录',
      pauseAll: '暂停全部',
      resumeAll: '继续全部',
      fixStale: '修复异常状态',
      refresh: '刷新',
      scan: '扫描',
      refreshing: '正在刷新…',
      refreshOk: '刷新完成',
      refreshFailed: '刷新失败',
      refreshTip: '从本地数据库重新拉一遍任务列表（不会去 B 站请求）。',
      scanStarting: '开始扫描…',
      scanOk: '扫描已启动',
      scanFailed: '扫描失败',
      scanTip: '去 B 站拉取最近的录播列表，增量写入/更新本地数据库。',
      renamePrompt: '你修改了文件名模板。要不要顺便把历史已下载的视频文件也改名？（只影响“已完成且文件还在”的视频）',
      syncAllPending: '一键下载未完成',
      syncing: '下载中…',
      records: '记录数',
      active: '进行中',
      mode: '模式',
      running: '运行中',
      downloadsTitle: '下载',
      downloadsDesc: '管理录播下载、暂停与恢复',
      queue: '下载队列',
      empty: '暂无记录，点击“扫描”拉取最新录播。',
      start: '开始',
      duration: '时长',
      size: '大小',
      speed: '速度',
      startBtn: '开始下载',
      pauseBtn: '暂停下载',
      resumeBtn: '继续下载',
      details: '详情',
      detailsTitle: '录播详情',
      status: '状态',
      startTime: '开始时间',
      endTime: '结束时间',
      resolution: '分辨率',
      bitrate: '码率',
      fileSize: '文件大小',
      localPath: '本地路径',
      close: '关闭',
      configTitle: '配置',
      configDesc: 'Anchor ID、下载目录、并发与命名规则',
      save: '保存配置',
      saving: '保存中…',
      systemConfig: '系统配置',
      anchorId: 'Anchor ID',
      outputDir: '下载目录',
      browse: '选择',
      outputTip: '修改目录会自动搬迁已下载的视频与封面文件。',
      filenameTpl: '文件名模板',
      maxTasks: '任务并发',
      segConc: '分片并发',
      chooseDir: '选择下载目录',
      drives: '磁盘',
      up: '上一级',
      noSubfolders: '没有子文件夹',
      selected: '已选择',
      useFolder: '使用该目录',
    }
    const en = {
      downloads: 'Downloads',
      settings: 'Settings',
      backendOnline: 'Backend Online',
      backendOffline: 'Backend Offline',
      paused: 'Paused',
      loggedIn: 'Logged In',
      notLoggedIn: 'Not Logged In',
      pauseAll: 'Pause All',
      resumeAll: 'Resume All',
      fixStale: 'Fix Stale',
      refresh: 'Refresh',
      scan: 'Scan',
      refreshing: 'Refreshing…',
      refreshOk: 'Refresh completed',
      refreshFailed: 'Refresh failed',
      refreshTip: 'Reload task list from local DB (no Bilibili request).',
      scanStarting: 'Scanning…',
      scanOk: 'Scan started',
      scanFailed: 'Scan failed',
      scanTip: 'Fetch recent replays from Bilibili and update local DB incrementally.',
      renamePrompt: 'Filename template changed. Rename already-downloaded videos too? (only completed + existing files)',
      syncAllPending: 'Download Pending',
      syncing: 'Downloading…',
      records: 'Records',
      active: 'Active',
      mode: 'Mode',
      running: 'Running',
      downloadsTitle: 'Downloads',
      downloadsDesc: 'Manage downloads, pause and resume',
      queue: 'Download Queue',
      empty: 'No records. Click Scan to fetch latest.',
      start: 'Start',
      duration: 'Duration',
      size: 'Size',
      speed: 'Speed',
      startBtn: 'Start',
      pauseBtn: 'Pause',
      resumeBtn: 'Resume',
      details: 'Details',
      detailsTitle: 'Replay Details',
      status: 'Status',
      startTime: 'Start Time',
      endTime: 'End Time',
      resolution: 'Resolution',
      bitrate: 'Bitrate',
      fileSize: 'File Size',
      localPath: 'Local File Path',
      close: 'Close',
      configTitle: 'Settings',
      configDesc: 'Anchor ID, output directory, concurrency and naming',
      save: 'Save',
      saving: 'Saving…',
      systemConfig: 'System Configuration',
      anchorId: 'Anchor ID',
      outputDir: 'Output Directory',
      browse: 'Browse',
      outputTip: 'Changing directory will migrate existing files.',
      filenameTpl: 'Filename Template',
      maxTasks: 'Max Tasks',
      segConc: 'Segment Concurrency',
      chooseDir: 'Choose Output Directory',
      drives: 'Drives',
      up: 'Up',
      noSubfolders: 'No subfolders',
      selected: 'Selected',
      useFolder: 'Use This Folder',
    }
    return lang === 'en' ? en : zh
  }, [lang])

  const [replays, setReplays] = useState<Replay[]>([])
  const [config, setConfig] = useState<Config | null>(null)
  const loadedConfigRef = useRef<Config | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [backendOnline, setBackendOnline] = useState(false)
  const [paused, setPaused] = useState(false)
  const [progressMap, setProgressMap] = useState<Record<string, Progress>>({})
  const [selectedReplay, setSelectedReplay] = useState<Replay | null>(null)
  const [m3u8Open, setM3u8Open] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(1)
  const toastTimers = useRef<Record<number, number>>({})

  const [dirModalOpen, setDirModalOpen] = useState(false)
  const [dirCurrent, setDirCurrent] = useState('')
  const [dirParent, setDirParent] = useState('')
  const [dirEntries, setDirEntries] = useState<FsEntry[]>([])
  const [dirLoading, setDirLoading] = useState(false)

  const [diskStats, setDiskStats] = useState<DiskStats | null>(null)
  const [diskStatsLoading, setDiskStatsLoading] = useState(false)
  const diskStatsErrorShown = useRef(false)

  useEffect(() => {
    setM3u8Open(false)
  }, [selectedReplay?.live_key])

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
    setToasts(prev => [...prev, { id, tone: t.tone, title: t.title, message: t.message }].slice(-4))
    upsertToastTimer(id, t.tone, t.durationMs)
    return id
  }, [upsertToastTimer])

  const replaceToast = useCallback((id: number, t: Omit<Toast, 'id'> & { durationMs?: number }) => {
    setToasts(prev => prev.map(x => (x.id === id ? { id, tone: t.tone, title: t.title, message: t.message } : x)))
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

  useEffect(() => {
    fetchReplays()
    fetchConfig()
    fetchMe()
    fetchRuntime()
    pingHealth()
    const healthTimer = setInterval(pingHealth, 5000)

    const ws = new WebSocket(`ws://${window.location.host}/ws`)
    ws.onopen = () => setBackendOnline(true)
    ws.onerror = () => setBackendOnline(false)
    ws.onclose = () => setBackendOnline(false)
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
      if (data.status === 'completed' || data.status === 'failed') fetchReplays()
    }
    return () => {
      clearInterval(healthTimer)
      ws.close()
    }
  }, [])

  const fetchDiskStats = useCallback(async () => {
    if (!backendOnline) return
    if (!config?.download?.output_dir) return
    setDiskStatsLoading(true)
    try {
      const res = await axios.get('/api/stats/disk')
      setDiskStats(res.data as DiskStats)
      diskStatsErrorShown.current = false
    } catch (e) {
      setDiskStats(null)
      if (!diskStatsErrorShown.current) {
        diskStatsErrorShown.current = true
        const status = (e as any)?.response?.status
        const msg =
          status === 404
            ? (lang === 'en'
                ? 'Endpoint not found. Backend may be outdated or not restarted.'
                : '接口不存在（404）。后端可能还是旧版本，或没有重启到最新二进制。')
            : getErrorMessage(e)
        showToast({ tone: 'error', title: lang === 'en' ? 'Disk stats failed' : '磁盘统计失败', message: msg })
      }
    } finally {
      setDiskStatsLoading(false)
    }
  }, [backendOnline, config?.download?.output_dir, getErrorMessage, lang, showToast])

  useEffect(() => {
    fetchDiskStats()
    const t = window.setInterval(fetchDiskStats, 15000)
    return () => window.clearInterval(t)
  }, [fetchDiskStats])

  useEffect(() => {
    return () => {
      Object.values(toastTimers.current).forEach(t => window.clearTimeout(t))
      toastTimers.current = {}
    }
  }, [])

  const pingHealth = async () => {
    try {
      await axios.get('/api/health', { timeout: 2000 })
      setBackendOnline(true)
    } catch {
      setBackendOnline(false)
    }
  }

  const fetchReplays = async (opts?: { notify?: boolean }) => {
    const notify = !!opts?.notify
    const toastId = notify ? showToast({ tone: 'loading', title: texts.refreshing }) : null
    if (notify) setIsRefreshing(true)
    try {
      const res = await axios.get('/api/replays')
      const list = (res.data || []) as Replay[]
      setReplays(list)
      setBackendOnline(true)
      if (toastId) {
        const counts: Record<string, number> = {}
        for (const r of list) counts[r.status] = (counts[r.status] || 0) + 1
        const msg =
          lang === 'en'
            ? `Total ${list.length}. Completed ${counts.completed || 0}, Active ${(counts.downloading || 0) + (counts.merging || 0)}, Paused ${counts.paused || 0}, Deleted ${counts.deleted || 0}, Failed ${counts.failed || 0}, Pending ${counts.pending || 0}.`
            : `共 ${list.length} 条：已完成 ${counts.completed || 0}，进行中 ${(counts.downloading || 0) + (counts.merging || 0)}，暂停 ${counts.paused || 0}，Deleted ${counts.deleted || 0}，失败 ${counts.failed || 0}，待处理 ${counts.pending || 0}。`
        replaceToast(toastId, {
          tone: 'success',
          title: texts.refreshOk,
          message: msg,
        })
      }
    } catch (e) {
      setBackendOnline(false)
      if (toastId) {
        replaceToast(toastId, { tone: 'error', title: texts.refreshFailed, message: getErrorMessage(e) })
      }
    } finally {
      if (notify) setIsRefreshing(false)
    }
  }

  const fetchConfig = async () => {
    try {
      const res = await axios.get('/api/config')
      setConfig(res.data)
      loadedConfigRef.current = res.data
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }

  const fetchMe = async () => {
    try {
      const res = await axios.get('/api/me')
      setMe(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }

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

  const fetchRuntime = async () => {
    try {
      const res = await axios.get('/api/runtime')
      const rt = res.data as Runtime
      setPaused(!!rt.paused)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }

  const handleScan = async () => {
    setIsScanning(true)
    const toastId = showToast({ tone: 'loading', title: texts.scanStarting })
    try {
      const res = await axios.post('/api/scan')
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
        lang === 'en'
          ? `Fetched ${s.fetched}. New ${s.new_records}, Updated ${s.updated_records}, Covers ${s.covers_updated}, Marked Deleted ${s.marked_deleted}, Unchanged ${s.already_up_to_date}.`
          : `我去 B 站看了一圈：获取到列表 ${s.fetched} 条。新增 ${s.new_records}，更新 ${s.updated_records}，补封面 ${s.covers_updated}，标记 Deleted ${s.marked_deleted}，没变化 ${s.already_up_to_date}。${
              s.fetched === 0
                ? '（如果你最近一段时间没有录播，0 是正常；如果你确定有录播但仍为 0，可能是扫描范围太小或账号状态异常。）'
                : ''
            }`
      replaceToast(toastId, { tone: 'success', title: texts.scanOk, message: msg })
      window.setTimeout(() => fetchReplays({ notify: false }), 1500)
    } catch (e) {
      setBackendOnline(false)
      replaceToast(toastId, { tone: 'error', title: texts.scanFailed, message: getErrorMessage(e) })
    } finally {
      setIsScanning(false)
    }
  }

  const handleSyncAll = async () => {
    setIsSyncingAll(true)
    try {
      await toastAction({
        loadingTitle: lang === 'en' ? 'Starting…' : '正在启动…',
        loadingMessage: lang === 'en' ? 'Dispatching download tasks.' : '正在把未完成的任务推进下载队列。',
        successTitle: lang === 'en' ? 'Started' : '已启动',
        successMessage: lang === 'en' ? 'Tasks are running in background.' : '后台开始跑任务了，进度会自动刷新。',
        errorTitle: lang === 'en' ? 'Start failed' : '启动失败',
        action: () => axios.post('/api/sync-all'),
      })
    } finally {
      setIsSyncingAll(false)
    }
  }

  const handleCleanupStale = async () => {
    const toastId = showToast({
      tone: 'loading',
      title: lang === 'en' ? 'Fixing…' : '正在修复…',
      message: lang === 'en' ? 'Cleaning stale states.' : '正在清理异常的“卡住状态”。',
    })
    try {
      const res = await axios.post('/api/cleanup-stale')
      setBackendOnline(true)
      const count = res.data?.count ?? 0
      replaceToast(toastId, {
        tone: 'success',
        title: lang === 'en' ? 'Fixed' : '已修复',
        message: lang === 'en' ? `Fixed ${count}.` : `已修复 ${count} 条。`,
      })
      await fetchReplays({ notify: false })
    } catch (e) {
      setBackendOnline(false)
      replaceToast(toastId, { tone: 'error', title: lang === 'en' ? 'Fix failed' : '修复失败', message: getErrorMessage(e) })
    }
  }

  const handlePauseAll = async () => {
    await toastAction({
      loadingTitle: lang === 'en' ? 'Pausing…' : '正在暂停…',
      loadingMessage: lang === 'en' ? 'Stopping active tasks.' : '正在把进行中的任务全部暂停。',
      successTitle: lang === 'en' ? 'Paused' : '已暂停',
      errorTitle: lang === 'en' ? 'Pause failed' : '暂停失败',
      action: async () => {
        const res = await axios.post('/api/pause-all')
        setBackendOnline(true)
        setPaused(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleResumeAll = async () => {
    await toastAction({
      loadingTitle: lang === 'en' ? 'Resuming…' : '正在继续…',
      loadingMessage: lang === 'en' ? 'Allowing tasks to run.' : '解除全局暂停，允许任务继续跑。',
      successTitle: lang === 'en' ? 'Resumed' : '已继续',
      errorTitle: lang === 'en' ? 'Resume failed' : '继续失败',
      action: async () => {
        const res = await axios.post('/api/resume-all')
        setBackendOnline(true)
        setPaused(false)
        await fetchRuntime()
        return res
      },
    })
  }

  const handleDownload = async (liveKey: string) => {
    await toastAction({
      loadingTitle: lang === 'en' ? 'Starting…' : '正在启动…',
      loadingMessage: lang === 'en' ? 'Creating task.' : '正在创建下载任务。',
      successTitle: lang === 'en' ? 'Started' : '已启动',
      successMessage: lang === 'en' ? 'Watch progress in the list.' : '回到列表看进度条就行。',
      errorTitle: lang === 'en' ? 'Start failed' : '启动失败',
      action: () => axios.post(`/api/replays/${liveKey}/download`),
    })
  }

  const handlePauseReplay = async (liveKey: string) => {
    await toastAction({
      loadingTitle: lang === 'en' ? 'Pausing…' : '正在暂停…',
      successTitle: lang === 'en' ? 'Paused' : '已暂停',
      errorTitle: lang === 'en' ? 'Pause failed' : '暂停失败',
      action: async () => {
        const res = await axios.post(`/api/replays/${liveKey}/pause`)
        setBackendOnline(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleResumeReplay = async (liveKey: string) => {
    await toastAction({
      loadingTitle: lang === 'en' ? 'Resuming…' : '正在继续…',
      successTitle: lang === 'en' ? 'Resumed' : '已继续',
      errorTitle: lang === 'en' ? 'Resume failed' : '继续失败',
      action: async () => {
        const res = await axios.post(`/api/replays/${liveKey}/resume`)
        setBackendOnline(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleDeleteReplayFile = async (r: Replay) => {
    const ok = window.confirm(
      lang === 'en'
        ? 'Delete the local video file? This will not delete the DB record.'
        : '确定要删除这条录播对应的本地视频文件吗？不会删除数据库记录，只是把文件删掉。',
    )
    if (!ok) return
    const res = await toastAction({
      loadingTitle: lang === 'en' ? 'Deleting…' : '正在删除…',
      loadingMessage: lang === 'en' ? 'Removing local file.' : '正在删除本地文件。',
      successTitle: lang === 'en' ? 'Deleted' : '已删除',
      successMessage: lang === 'en' ? 'Local file deleted.' : '本地文件已删除。',
      errorTitle: lang === 'en' ? 'Delete failed' : '删除失败',
      action: () => axios.post(`/api/replays/${r.live_key}/delete-file`),
    })
    const updated = res.data as Replay
    setSelectedReplay(prev => (prev?.live_key === updated.live_key ? updated : prev))
    await fetchReplays({ notify: false })
  }

  const handleCacheM3U8 = async (r: Replay) => {
    const res = await toastAction({
      loadingTitle: lang === 'en' ? 'Caching…' : '正在缓存…',
      loadingMessage: lang === 'en' ? 'Fetching m3u8.' : '正在拉取并缓存 m3u8。',
      successTitle: lang === 'en' ? 'Cached' : '已缓存',
      successMessage: lang === 'en' ? 'Saved latest m3u8.' : '已保存最新的 m3u8。',
      errorTitle: lang === 'en' ? 'Cache failed' : '缓存失败',
      action: () => axios.post(`/api/replays/${r.live_key}/cache-m3u8`),
    })
    const updated = res.data as Replay
    setSelectedReplay(prev => (prev?.live_key === updated.live_key ? updated : prev))
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
    return `/covers/${filename}`
  }

  const openDirModal = async () => {
    setDirModalOpen(true)
    await loadDirList('')
  }

  const loadDirList = async (path: string) => {
    setDirLoading(true)
    try {
      const res = await axios.get('/api/fs/list', { params: { path } })
      const data = res.data as FsListResponse
      setDirCurrent(data.current || '')
      setDirParent(data.parent || '')
      setDirEntries(data.entries || [])
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
      showToast({ tone: 'error', title: lang === 'en' ? 'List failed' : '读取目录失败', message: getErrorMessage(e) })
    } finally {
      setDirLoading(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!config) return
    setSavingConfig(true)
    try {
      const prevTpl = loadedConfigRef.current?.download?.filename_template || ''
      const tplChanged = prevTpl && prevTpl !== config.download.filename_template
      const renameExisting = tplChanged ? window.confirm(texts.renamePrompt) : false
      const res = await axios.post('/api/config', config, { params: { rename_existing: renameExisting ? 1 : 0 } })
      const migrated = parseInt(res.headers?.['x-migrated-files'] || '0')
      const renamed = parseInt(res.headers?.['x-renamed-files'] || '0')
      setConfig(res.data)
      loadedConfigRef.current = res.data
      setBackendOnline(true)
      fetchRuntime()
      if (migrated > 0 || renamed > 0) {
        showToast({
          tone: 'success',
          title: lang === 'en' ? 'Saved' : '已保存',
          message:
            lang === 'en'
              ? `Moved ${migrated}, Renamed ${renamed}.`
              : `搬迁 ${migrated} 个文件，重命名 ${renamed} 个文件。`,
        })
      } else {
        showToast({ tone: 'success', title: lang === 'en' ? 'Saved' : '已保存' })
      }
    } catch (e) {
      setBackendOnline(false)
      showToast({ tone: 'error', title: lang === 'en' ? 'Save failed' : '保存失败', message: getErrorMessage(e) })
      fetchConfig()
    } finally {
      setSavingConfig(false)
    }
  }

  const runtimePills = useMemo(() => {
    const pills: JSX.Element[] = []
    pills.push(<StatusPill key="backend" label={backendOnline ? texts.backendOnline : texts.backendOffline} tone={backendOnline ? 'good' : 'bad'} />)
    if (paused) pills.push(<StatusPill key="paused" label={texts.paused} tone="neutral" />)
    return pills
  }, [backendOnline, paused, texts])

  return (
    <div className="min-h-screen bg-neutral-100 text-slate-800">
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
      <div className="flex min-h-screen">
        <div className={`fixed inset-0 z-40 bg-black/30 ${sidebarOpen ? '' : 'hidden'}`} onClick={() => setSidebarOpen(false)} />

        <aside className={`fixed z-50 inset-y-0 left-0 w-72 bg-white border-r border-slate-200 flex flex-col transform transition-transform md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:w-64`}>
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
              {texts.downloads}
            </button>
            <button
              onClick={() => { setPage('settings'); setSidebarOpen(false) }}
              className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md ${page === 'settings' ? 'bg-stone-100 text-[var(--color-bili-blue)]' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              <Settings className="w-5 h-5 mr-3" />
              {texts.settings}
            </button>

            <div className="pt-4">
              <div className="flex flex-wrap gap-2 px-3">{runtimePills}</div>
            </div>

            <div className="mt-4 px-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full overflow-hidden bg-white border border-slate-200 flex items-center justify-center">
                    {me?.logged_in && me.face ? (
                      <img src={`/api/avatar?url=${encodeURIComponent(me.face)}`} alt="" className="w-full h-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{me?.logged_in ? (me?.uname || '-') : '-'}</div>
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${me?.logged_in ? 'bg-green-500' : 'bg-slate-400'}`}></span>
                      {me?.logged_in ? texts.loggedIn : texts.notLoggedIn}
                    </div>
                  </div>
                </div>
              </div>
              {config?.download?.output_dir ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">{lang === 'en' ? 'Disk' : '磁盘统计'}</div>
                    <button
                      onClick={fetchDiskStats}
                      disabled={diskStatsLoading || !backendOnline}
                      className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {diskStatsLoading ? (lang === 'en' ? 'Loading…' : '读取中…') : (lang === 'en' ? 'Refresh' : '刷新')}
                    </button>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-slate-600">
                    {diskStats ? (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <span>{lang === 'en' ? 'Total' : '总容量'}</span>
                          <span className="font-mono">{formatBytes(diskStats.total_bytes)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>{lang === 'en' ? 'Free' : '剩余'}</span>
                          <span className="font-mono">{formatBytes(diskStats.free_bytes)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>{lang === 'en' ? 'Used by this app' : '本服务占用'}</span>
                          <span className="font-mono">{formatBytes(diskStats.used_by_service_bytes)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-400">{lang === 'en' ? 'No data' : '暂无数据'}</div>
                    )}
                  </div>
                </div>
              ) : null}
              <button
                onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
                className="mt-3 w-full flex items-center justify-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition"
              >
                {lang === 'en' ? '中文' : 'EN'}
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
              {paused ? texts.resumeAll : texts.pauseAll}
            </button>
            <button
              onClick={handleCleanupStale}
              disabled={!backendOnline}
              className="w-full flex items-center justify-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
            >
              <Wrench className="w-4 h-4 mr-2" />
              {texts.fixStale}
            </button>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-h-screen">
          <div className="h-16 flex items-center justify-between px-4 sm:px-6 border-b border-slate-200 bg-white md:hidden">
            <button className="p-2 rounded hover:bg-slate-100" onClick={() => setSidebarOpen(true)}>
              <Menu className="w-5 h-5" />
            </button>
            <div className="font-semibold">Replay Manager</div>
            <div className="w-9" />
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            {page === 'downloads' && (
              <div className="max-w-6xl mx-auto">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                  <div>
                    <div className="text-2xl font-bold tracking-tight">{texts.downloadsTitle}</div>
                    <div className="text-sm text-slate-500 mt-1">{texts.downloadsDesc}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => fetchReplays({ notify: true })}
                      disabled={isRefreshing}
                      className="flex items-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
                    >
                      <Tooltip content={texts.refreshTip}>
                        <span className="inline-flex items-center">
                          <RefreshCcw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                          {texts.refresh}
                        </span>
                      </Tooltip>
                    </button>
                    <button
                      onClick={handleScan}
                      disabled={isScanning}
                      className="flex items-center px-3 py-2 bg-[var(--color-bili-blue)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition disabled:opacity-50"
                    >
                      <Tooltip content={texts.scanTip}>
                        <span className="inline-flex items-center">
                          <Loader2 className={`w-4 h-4 mr-2 ${isScanning ? 'animate-spin' : ''}`} />
                          {texts.scan}
                        </span>
                      </Tooltip>
                    </button>
                    <button
                      onClick={handleSyncAll}
                      disabled={!backendOnline || paused || isSyncingAll}
                      className="flex items-center px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {isSyncingAll ? texts.syncing : texts.syncAllPending}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                  <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
                    <div className="text-sm text-slate-500">{texts.records}</div>
                    <div className="text-2xl font-bold mt-1">{replays.length}</div>
                  </div>
                  <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
                    <div className="text-sm text-slate-500">{texts.active}</div>
                    <div className="text-2xl font-bold mt-1">{activeDownloading}</div>
                  </div>
                  <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
                    <div className="text-sm text-slate-500">{texts.mode}</div>
                    <div className="text-2xl font-bold mt-1">{paused ? texts.paused : texts.running}</div>
                  </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                    <h2 className="font-semibold flex items-center">
                      <Download className="w-5 h-5 text-slate-500 mr-2" />
                      {texts.queue}
                    </h2>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {replays.length === 0 && (
                      <div className="text-center py-12 text-slate-500">{texts.empty}</div>
                    )}

                    {replays.map(r => {
                      const p = progressMap[r.live_key]
                      const displayStatus = p?.status || r.status
                      const displayProgress = Math.max(0, Math.min(100, p?.progress ?? r.progress ?? 0))
                      const mergeProgress = Math.max(0, Math.min(100, p?.merge_progress ?? 0))
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
                        <div key={r.ID} className="p-4 sm:p-5 hover:bg-slate-50 transition">
                          <div className="flex gap-4 items-start">
                            <div className="w-32 h-20 bg-slate-200 rounded-lg overflow-hidden flex-shrink-0 relative">
                              {r.local_cover ? (
                                <img src={getCoverUrl(r.local_cover)!} className="w-full h-full object-cover" />
                              ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">No Cover</div>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                <div className="min-w-0">
                                  <Tooltip content={r.title}>
                                    <div className="font-medium text-slate-900 truncate">{r.title}</div>
                                  </Tooltip>
                                  <div className="text-[11px] text-slate-400 font-mono mt-1 truncate">{r.live_key}</div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className={`inline-flex items-center gap-2 text-xs font-medium px-2 py-1 rounded border border-slate-200 bg-white`}>
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

                              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                                <span>{texts.start}: {new Date(r.start_time * 1000).toLocaleString()}</span>
                                <span>{texts.duration}: {Math.floor(r.duration / 60)}m</span>
                                <span>{texts.size}: {formatBytes(r.file_size)}</span>
                                {p?.speed ? <span>{texts.speed}: {p.speed}</span> : null}
                              </div>

                              <div className="mt-3">
                                <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                                  <div
                                    className={`${barColor} h-1.5 rounded-full transition-all duration-500`}
                                    style={{ width: `${showProgress ? displayProgress : (displayStatus === 'completed' ? 100 : 0)}%` }}
                                  />
                                </div>
                                <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                                  <span className="truncate max-w-[70%]">{progText || '--'}</span>
                                  <span>{showProgress ? `${Math.round(displayProgress)}%` : ''}</span>
                                </div>
                                {displayStatus === 'merging' ? (
                                  <div className="mt-2">
                                    <div className="w-full bg-slate-200 rounded-full h-1 overflow-hidden">
                                      <div
                                        className="bg-[var(--color-bili-pink)] h-1 rounded-full transition-all duration-500"
                                        style={{ width: `${mergeProgress}%` }}
                                      />
                                    </div>
                                    <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                                      <span className="truncate max-w-[70%]">{lang === 'en' ? 'Merge progress' : '合并进度'}</span>
                                      <span>{`${Math.round(mergeProgress)}%`}</span>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex flex-col gap-2">
                              {['pending', 'failed', 'deleted'].includes(displayStatus) && (
                                <button
                                  onClick={() => handleDownload(r.live_key)}
                                  disabled={!backendOnline || paused}
                                  className="p-2 text-slate-500 hover:text-[var(--color-bili-blue)] rounded bg-white border border-slate-200 shadow-sm transition disabled:opacity-50"
                                >
                                  <Tooltip content={texts.startBtn}>
                                    <Play className="w-4 h-4" />
                                  </Tooltip>
                                </button>
                              )}
                              {(displayStatus === 'downloading' || displayStatus === 'merging') && (
                                <button
                                  onClick={() => handlePauseReplay(r.live_key)}
                                  disabled={!backendOnline}
                                  className="p-2 text-slate-500 hover:text-amber-500 rounded bg-white border border-slate-200 shadow-sm transition disabled:opacity-50"
                                >
                                  <Tooltip content={texts.pauseBtn}>
                                    <Pause className="w-4 h-4" />
                                  </Tooltip>
                                </button>
                              )}
                              {displayStatus === 'paused' && (
                                <button
                                  onClick={() => handleResumeReplay(r.live_key)}
                                  disabled={!backendOnline || paused}
                                  className="p-2 text-slate-500 hover:text-green-600 rounded bg-white border border-slate-200 shadow-sm transition disabled:opacity-50"
                                >
                                  <Tooltip content={texts.resumeBtn}>
                                    <Play className="w-4 h-4" />
                                  </Tooltip>
                                </button>
                              )}
                              <button
                                onClick={() => setSelectedReplay(r)}
                                className="p-2 text-slate-500 hover:text-slate-800 rounded bg-white border border-slate-200 shadow-sm transition"
                              >
                                <Tooltip content={texts.details}>
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
              <div className="max-w-4xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <div className="text-2xl font-bold tracking-tight">{texts.configTitle}</div>
                    <div className="text-sm text-slate-500 mt-1">{texts.configDesc}</div>
                  </div>
                  <button
                    onClick={handleSaveConfig}
                    disabled={!backendOnline || paused || savingConfig || !config}
                    className="flex items-center px-4 py-2 bg-[var(--color-bili-pink)] hover:opacity-90 text-white rounded-lg font-medium transition disabled:opacity-50"
                  >
                    <RefreshCcw className={`w-4 h-4 mr-2 ${savingConfig ? 'animate-spin' : ''}`} />
                    {savingConfig ? texts.saving : texts.save}
                  </button>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
                  <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center">
                    <Settings className="w-5 h-5 text-slate-500 mr-2" />
                    <h2 className="font-semibold">{texts.systemConfig}</h2>
                  </div>

                  {!config ? (
                    <div className="p-6 text-slate-500">Loading…</div>
                  ) : (
                    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{texts.anchorId}</label>
                        <input
                          value={config.bilibili.anchor_id || 0}
                          onChange={e => setConfig({ ...config, bilibili: { ...config.bilibili, anchor_id: parseInt(e.target.value || '0') } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{texts.outputDir}</label>
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
                            {texts.browse}
                          </button>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{texts.outputTip}</div>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-slate-700 mb-1">{texts.filenameTpl}</label>
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
                        <label className="block text-sm font-medium text-slate-700 mb-1">{texts.maxTasks}</label>
                        <input
                          value={config.download.max_concurrent_tasks || 1}
                          onChange={e => setConfig({ ...config, download: { ...config.download, max_concurrent_tasks: parseInt(e.target.value || '1') } })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">{texts.segConc}</label>
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
          </div>
        </main>
      </div>

      {selectedReplay && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full overflow-hidden">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900">{texts.detailsTitle}</h3>
              <button onClick={() => setSelectedReplay(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6 space-y-6">
              <div className="flex gap-6">
                {selectedReplay.local_cover && (
                  <img src={getCoverUrl(selectedReplay.local_cover)!} alt="" className="w-48 h-28 object-cover rounded-lg shadow-sm" />
                )}
                <div className="grid grid-cols-2 gap-x-8 gap-y-4 flex-1">
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.status}</label>
                    <p className="capitalize font-medium">{selectedReplay.status}</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.startTime}</label>
                    <p className="text-sm">{new Date(selectedReplay.start_time * 1000).toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.endTime}</label>
                    <p className="text-sm">{new Date(selectedReplay.end_time * 1000).toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">Duration</label>
                    <p className="text-sm">{Math.floor(selectedReplay.duration / 60)} min {selectedReplay.duration % 60} sec</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 rounded-lg">
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.resolution}</label>
                  <p className="font-medium">{selectedReplay.resolution || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.bitrate}</label>
                  <p className="font-medium">{selectedReplay.bitrate || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.fileSize}</label>
                  <p className="font-medium">{formatBytes(selectedReplay.file_size)}</p>
                </div>
              </div>
              
              <div>
                <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">Current Message / Error</label>
                <div className={`mt-1 p-3 rounded bg-gray-50 font-mono text-sm border ${selectedReplay.status === 'failed' ? 'border-red-100 text-red-600 bg-red-50' : 'border-gray-100'}`}>
                  {progressMap[selectedReplay.live_key]?.message || selectedReplay.message || 'No message available'}
                </div>
              </div>

              {selectedReplay.file_path && (
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{texts.localPath}</label>
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
                      {lang === 'en' ? 'Cache' : '缓存'}
                    </button>
                    <button
                      onClick={() => setM3u8Open(v => !v)}
                      className="px-3 py-1.5 bg-white border border-gray-200 text-xs font-medium rounded hover:bg-gray-50 transition"
                    >
                      {m3u8Open ? (lang === 'en' ? 'Hide' : '收起') : (lang === 'en' ? 'Show' : '展开')}
                    </button>
                  </div>
                </div>
                {m3u8Open ? (
                  <div className="mt-3 space-y-3">
                    {(selectedReplay.streams || []).length === 0 ? (
                      <div className="text-xs text-gray-400">{lang === 'en' ? 'No streams cached yet.' : '还没有缓存到 streams/m3u8。'}</div>
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

              <div className="flex items-center justify-between gap-3 pt-4 border-t">
                <button
                  onClick={() => handleDeleteReplayFile(selectedReplay)}
                  disabled={!backendOnline || !selectedReplay.file_path}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  {lang === 'en' ? 'Delete File' : '删除文件'}
                </button>
                <button
                  onClick={() => setSelectedReplay(null)}
                  className="px-8 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
                >
                  {texts.close}
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
              <div className="font-semibold">{texts.chooseDir}</div>
              <button className="p-2 rounded hover:bg-slate-100" onClick={() => setDirModalOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
              <div className="text-sm text-slate-600 truncate">{dirCurrent || texts.drives}</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadDirList(dirParent)}
                  disabled={dirLoading || (!dirParent && !!dirCurrent)}
                  className="px-3 py-1.5 bg-white border border-slate-300 text-sm font-medium rounded hover:bg-slate-50 transition disabled:opacity-50"
                >
                  {texts.up}
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
                  {dirEntries.length === 0 && <div className="p-6 text-slate-500">{texts.noSubfolders}</div>}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex justify-between items-center">
              <div className="text-xs text-slate-500 truncate">{dirCurrent ? `${texts.selected}: ${dirCurrent}` : ''}</div>
              <button
                onClick={() => {
                  if (!config || !dirCurrent) return
                  setConfig({ ...config, download: { ...config.download, output_dir: dirCurrent } })
                  setDirModalOpen(false)
                }}
                disabled={!config || !dirCurrent}
                className="px-4 py-2 bg-[var(--color-bili-blue)] text-white rounded-lg font-medium hover:opacity-90 transition disabled:opacity-50"
              >
                {texts.useFolder}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
