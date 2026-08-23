import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { getErrorMessage, isBackendReachableError, mergeRealtimeProgress, shouldUseRealtimeProgress } from '../utils'
import { RealtimeHeartbeat, startClipTaskPolling } from '../utils/taskStateSync'
import type { Replay, DiskStats, Runtime, ClipTaskRecord, Progress } from '../types'

const REALTIME_RENDER_INTERVAL_MS = 250

export function AppController() {
  const { t } = useTranslation()
  const {
    apiBase, apiClient, buildWsUrl,
    setBackendOnline, setWsOnline,
    setReplays, setProgressMap,
    setDiskStats, setDiskStatsLoading,
    setRuntimeState, setPaused,
    reconcileClipTaskSnapshot, upsertClipTask,
    hasActiveReplay, showTaskCenter,
    showToast
  } = useAppStore(useShallow(state => ({

    apiBase: state.apiBase,
    apiClient: state.apiClient,
    buildWsUrl: state.buildWsUrl,
    setBackendOnline: state.setBackendOnline,
    setWsOnline: state.setWsOnline,
    setReplays: state.setReplays,
    setProgressMap: state.setProgressMap,
    setDiskStats: state.setDiskStats,
    setDiskStatsLoading: state.setDiskStatsLoading,
    setRuntimeState: state.setRuntimeState,
    setPaused: state.setPaused,
    reconcileClipTaskSnapshot: state.reconcileClipTaskSnapshot,
    upsertClipTask: state.upsertClipTask,
    showTaskCenter: state.showTaskCenter,
    hasActiveReplay:
      state.replays.some(replay => ['pending', 'downloading', 'merging'].includes(replay.status)) ||
      Object.values(state.progressMap).some(progress => ['pending', 'downloading', 'merging'].includes(progress.status)),
    showToast: state.showToast,
  
  })))

  const diskStatsErrorShown = useRef(false)
  const replaysRequest = useRef<Promise<void> | null>(null)
  const replaysRefreshQueued = useRef(false)
  const pendingRealtimeProgress = useRef<Record<string, Progress>>({})
  const realtimeFlushTimer = useRef<number | undefined>(undefined)

  const flushRealtimeProgress = useCallback(() => {
    if (realtimeFlushTimer.current !== undefined) {
      window.clearTimeout(realtimeFlushTimer.current)
      realtimeFlushTimer.current = undefined
    }
    const pending = pendingRealtimeProgress.current
    if (Object.keys(pending).length === 0) return
    pendingRealtimeProgress.current = {}
    useAppStore.setState(state => ({
      progressMap: { ...state.progressMap, ...pending },
      replays: state.replays.map(replay => {
        const progress = pending[replay.live_key]
        if (!progress || !shouldUseRealtimeProgress(progress, replay)) return replay
        const patch = {
          status: progress.status || replay.status,
          progress: progress.progress,
          message: progress.message,
          speed: progress.speed,
          elapsed: progress.elapsed,
          eta: progress.eta,
        }
        if (
          patch.status === replay.status
          && patch.progress === replay.progress
          && patch.message === replay.message
          && patch.speed === replay.speed
          && patch.elapsed === replay.elapsed
          && patch.eta === replay.eta
        ) return replay
        return { ...replay, ...patch }
      }),
    }))
  }, [])

  // Determine apiBase
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
        useAppStore.getState().setApiBase(resolved.replace(/\/$/, ''))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const fetchReplays = useCallback(() => {
    if (replaysRequest.current) {
      replaysRefreshQueued.current = true
      return replaysRequest.current
    }
    const request = (async () => {
      try {
        const res = await apiClient.get('/api/replays', { params: { _t: Date.now() } })
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
      } catch (e) {
        setBackendOnline(isBackendReachableError(e))
      }
    })()
    replaysRequest.current = request
    void request.finally(() => {
      if (replaysRequest.current === request) replaysRequest.current = null
      if (replaysRefreshQueued.current) {
        replaysRefreshQueued.current = false
        void fetchReplays()
      }
    })
    return request
  }, [apiClient, setReplays, setProgressMap, setBackendOnline])

  const fetchClipTasks = useCallback(async () => {
    const requestStartedAt = Date.now()
    try {
      const res = await apiClient.get('/api/clip/tasks', { params: { _t: requestStartedAt } })
      reconcileClipTaskSnapshot(res.data as ClipTaskRecord[], requestStartedAt)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
    }
  }, [apiClient, reconcileClipTaskSnapshot, setBackendOnline])

  // WebSocket
  useEffect(() => {
    if (!apiBase) return
    let ws: WebSocket | undefined
    let reconnectTimer: number | undefined
    let disposed = false
    let connectionGeneration = 0
    const healthTimers = new Set<number>()
    const heartbeat = new RealtimeHeartbeat()

    const scheduleReconnect = (generation: number) => {
      if (disposed || generation !== connectionGeneration || reconnectTimer !== undefined) return
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        if (!disposed && generation === connectionGeneration) connect()
      }, 3000)
    }

    const connect = () => {
      const generation = ++connectionGeneration
      const socket = new WebSocket(buildWsUrl('/ws'))
      let socketHealthTimer: number | undefined
      const stopSocketHealth = () => {
        if (socketHealthTimer === undefined) return
        window.clearInterval(socketHealthTimer)
        healthTimers.delete(socketHealthTimer)
        socketHealthTimer = undefined
      }
      ws = socket
      socket.onopen = () => {
        if (generation !== connectionGeneration) return
        heartbeat.reset()
        setWsOnline(true)
        void fetchReplays()
        void fetchClipTasks()
        socketHealthTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            heartbeat.pulse(
              () => socket.send(JSON.stringify({ type: 'ping' })),
              () => {
                stopSocketHealth()
                setWsOnline(false)
                socket.close(4000, 'Heartbeat timeout')
                scheduleReconnect(generation)
              },
            )
          }
        }, 15000)
        healthTimers.add(socketHealthTimer)
      }
      socket.onclose = () => {
        stopSocketHealth()
        if (generation !== connectionGeneration) return
        setWsOnline(false)
        scheduleReconnect(generation)
      }
      socket.onerror = () => {
        stopSocketHealth()
        if (generation !== connectionGeneration) return
        setWsOnline(false)
        socket.close()
        scheduleReconnect(generation)
      }
      socket.onmessage = (e) => {
        if (generation !== connectionGeneration) return
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        if (data.type === 'pong') {
          heartbeat.acknowledge()
          return
        }
        if (data.type === 'clip_task_update') {
          const task = data.data as ClipTaskRecord | undefined
          if (!task || !Number.isFinite(task.id)) return
          upsertClipTask(task)
          if (task.status === 'done') {
            showToast({ tone: 'success', title: t('clipTask.completed'), message: task.title })
          } else if (task.status === 'error') {
            showToast({ tone: 'error', title: t('clipTask.failed'), message: task.message })
          }
          return
        }
        if (data.type === 'state_reconciled') {
          void fetchReplays()
          void fetchClipTasks()
          return
        }
        if (!data.live_key) return
        const liveKey = String(data.live_key)
        const currentProgress = pendingRealtimeProgress.current[liveKey] || useAppStore.getState().progressMap[liveKey] || {
          live_key: liveKey,
          updated_at: '',
          progress: 0,
          merge_progress: 0,
          status: '',
          message: '',
          speed: '',
          speed_history: [],
          elapsed: '',
          eta: '',
        }
        const nextProgress = mergeRealtimeProgress(currentProgress, data)
        pendingRealtimeProgress.current[liveKey] = nextProgress
        if (realtimeFlushTimer.current === undefined) {
          realtimeFlushTimer.current = window.setTimeout(flushRealtimeProgress, REALTIME_RENDER_INTERVAL_MS)
        }
        if (data.status === 'completed' || data.status === 'failed') {
          flushRealtimeProgress()
          void fetchReplays()
        }
      }
    }
    connect()
    return () => {
      disposed = true
      connectionGeneration += 1
      for (const timer of healthTimers) window.clearInterval(timer)
      healthTimers.clear()
      window.clearTimeout(reconnectTimer)
      if (realtimeFlushTimer.current !== undefined) window.clearTimeout(realtimeFlushTimer.current)
      realtimeFlushTimer.current = undefined
      pendingRealtimeProgress.current = {}
      setWsOnline(false)
      if (ws) ws.close()
    }
  }, [apiBase, buildWsUrl, fetchClipTasks, fetchReplays, flushRealtimeProgress, setWsOnline, showToast, t, upsertClipTask])

  const fetchDiskStats = useCallback(async () => {
    if (!apiBase || !useAppStore.getState().backendOnline) return
    if (!useAppStore.getState().config?.download?.output_dir) return
    setDiskStatsLoading(true)
    try {
      const res = await apiClient.get('/api/stats/disk')
      setDiskStats(res.data as DiskStats)
      diskStatsErrorShown.current = false
    } catch (e) {
      setDiskStats(null)
      setBackendOnline(isBackendReachableError(e))
      if (!diskStatsErrorShown.current) {
        diskStatsErrorShown.current = true
        const status = (e as any)?.response?.status
        const msg = status === 404 ? t('messages.endpointNotFound') : getErrorMessage(e)
        showToast({ tone: 'error', title: t('messages.diskStatsFailed'), message: msg })
      }
    } finally {
      setDiskStatsLoading(false)
    }
  }, [apiBase, apiClient, setBackendOnline, setDiskStats, setDiskStatsLoading, showToast, t])

  const fetchRuntime = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/runtime')
      const rt = res.data as Runtime
      setPaused(!!rt.paused)
      setRuntimeState(rt)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
    }
  }, [apiClient, setPaused, setRuntimeState, setBackendOnline])

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/config')
      useAppStore.getState().setConfig(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
    }
  }, [apiClient, setBackendOnline])

  const fetchMe = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/me')
      useAppStore.getState().setMe(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
    }
  }, [apiClient, setBackendOnline])

  // Initial loads
  useEffect(() => {
    if (!apiBase) return
    void fetchReplays()
    void fetchConfig()
    void fetchMe()
    void fetchClipTasks()
  }, [apiBase, fetchClipTasks, fetchConfig, fetchMe, fetchReplays])

  useEffect(() => {
    if (!apiBase) return
    return startClipTaskPolling({
      refresh: fetchClipTasks,
      getTasks: () => useAppStore.getState().clipTasks,
    })
  }, [apiBase, fetchClipTasks])

  useEffect(() => {
    if (apiBase && showTaskCenter) void fetchClipTasks()
  }, [apiBase, fetchClipTasks, showTaskCenter])

  useEffect(() => {
    if (!apiBase) return
    const refreshOnFocus = () => { void fetchClipTasks() }
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [apiBase, fetchClipTasks])

  // Timers
  useEffect(() => {
    void fetchDiskStats()
    const intervalMs = hasActiveReplay ? 15000 : 60000
    const t = window.setInterval(fetchDiskStats, intervalMs)
    return () => window.clearInterval(t)
  }, [fetchDiskStats, hasActiveReplay])

  useEffect(() => {
    if (!apiBase || !useAppStore.getState().backendOnline || !hasActiveReplay) return
    const timer = window.setInterval(fetchReplays, 15000)
    return () => window.clearInterval(timer)
  }, [apiBase, hasActiveReplay, fetchReplays])

  useEffect(() => {
    if (!apiBase) return
    const intervalMs = hasActiveReplay ? 5000 : 30000
    const timer = window.setInterval(fetchRuntime, intervalMs)
    void fetchRuntime()
    return () => window.clearInterval(timer)
  }, [apiBase, fetchRuntime, hasActiveReplay])

  return null
}
