import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { getErrorMessage, isBackendReachableError, mergeRealtimeProgress, shouldUseRealtimeProgress } from '../utils'
import type { Replay, DiskStats, Runtime, ClipTaskRecord } from '../types'

export function AppController() {
  const { t } = useTranslation()
  const {
    apiBase, apiClient, buildWsUrl,
    setBackendOnline, setWsOnline,
    setReplays, patchReplay, setProgressMap,
    setDiskStats, setDiskStatsLoading,
    setRuntimeState, setPaused,
    mergeClipTasks, upsertClipTask,
    hasActiveReplay,
    showToast
  } = useAppStore(useShallow(state => ({

    apiBase: state.apiBase,
    apiClient: state.apiClient,
    buildWsUrl: state.buildWsUrl,
    setBackendOnline: state.setBackendOnline,
    setWsOnline: state.setWsOnline,
    setReplays: state.setReplays,
    patchReplay: state.patchReplay,
    setProgressMap: state.setProgressMap,
    setDiskStats: state.setDiskStats,
    setDiskStatsLoading: state.setDiskStatsLoading,
    setRuntimeState: state.setRuntimeState,
    setPaused: state.setPaused,
    mergeClipTasks: state.mergeClipTasks,
    upsertClipTask: state.upsertClipTask,
    hasActiveReplay:
      state.replays.some(replay => ['pending', 'downloading', 'merging'].includes(replay.status)) ||
      Object.values(state.progressMap).some(progress => ['pending', 'downloading', 'merging'].includes(progress.status)),
    showToast: state.showToast,
  
  })))

  const diskStatsErrorShown = useRef(false)

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

  const fetchReplays = useCallback(async () => {
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
  }, [apiClient, setReplays, setProgressMap, setBackendOnline])

  // WebSocket
  useEffect(() => {
    if (!apiBase) return
    let ws: WebSocket
    let healthTimer: number
    let reconnectTimer: number
    let disposed = false

    const connect = () => {
      ws = new WebSocket(buildWsUrl('/ws'))
      ws.onopen = () => {
        setWsOnline(true)
        void fetchReplays()
        apiClient.get('/api/clip/tasks', { params: { _t: Date.now() } })
          .then(res => mergeClipTasks(res.data as ClipTaskRecord[]))
          .catch(() => {})
        healthTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 15000)
      }
      ws.onclose = () => {
        setWsOnline(false)
        window.clearInterval(healthTimer)
        if (!disposed) reconnectTimer = window.setTimeout(connect, 3000)
      }
      ws.onerror = () => {
        setWsOnline(false)
      }
      ws.onmessage = (e) => {
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        if (data.type === 'pong') return
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
        if (!data.live_key) return
        const liveKey = String(data.live_key)
        const currentProgress = useAppStore.getState().progressMap[liveKey] || {
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
        setProgressMap(prev => {
          return {
            ...prev,
            [liveKey]: nextProgress,
          }
        })
        const replay = useAppStore.getState().replays.find(item => item.live_key === liveKey)
        if (replay && shouldUseRealtimeProgress(nextProgress, replay)) {
          patchReplay(liveKey, {
            status: nextProgress.status || replay.status,
            progress: nextProgress.progress,
            message: nextProgress.message,
            speed: nextProgress.speed,
            elapsed: nextProgress.elapsed,
            eta: nextProgress.eta,
          })
        }
        if (data.status === 'completed' || data.status === 'failed') void fetchReplays()
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearInterval(healthTimer)
      window.clearTimeout(reconnectTimer)
      setWsOnline(false)
      if (ws) ws.close()
    }
  }, [apiBase, apiClient, buildWsUrl, fetchReplays, mergeClipTasks, patchReplay, setProgressMap, setWsOnline, showToast, t, upsertClipTask])

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

  const fetchClipTasks = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/clip/tasks')
      mergeClipTasks(res.data as ClipTaskRecord[])
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
    }
  }, [apiClient, mergeClipTasks, setBackendOnline])

  // Initial loads
  useEffect(() => {
    if (!apiBase) return
    void fetchReplays()
    void fetchConfig()
    void fetchMe()
    void fetchClipTasks()
  }, [apiBase, fetchClipTasks, fetchConfig, fetchMe, fetchReplays])

  // Timers
  useEffect(() => {
    void fetchDiskStats()
    const intervalMs = hasActiveReplay ? 15000 : 60000
    const t = window.setInterval(fetchDiskStats, intervalMs)
    return () => window.clearInterval(t)
  }, [fetchDiskStats, hasActiveReplay])

  useEffect(() => {
    if (!apiBase || !useAppStore.getState().backendOnline || !hasActiveReplay) return
    const timer = window.setInterval(fetchReplays, 5000)
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
