import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { getErrorMessage, shouldUseRealtimeProgress } from '../utils'
import type { Replay, DiskStats, Runtime, ClipTaskRecord } from '../types'

export function AppController() {
  const { t } = useTranslation()
  const {
    apiBase, apiClient, buildWsUrl,
    setBackendOnline, setWsOnline,
    setReplays, setProgressMap,
    setDiskStats, setDiskStatsLoading,
    setRuntimeState, setPaused,
    setClipTasks,
    replays, activeDownloading,
    showToast, replaceToast
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
    setClipTasks: state.setClipTasks,
    replays: state.replays,
    activeDownloading: state.replays.filter(r => r.status === 'downloading' || r.status === 'merging').length,
    showToast: state.showToast,
    replaceToast: state.replaceToast
  
})))

  const diskStatsErrorShown = useRef(false)
  const hasActiveReplay = activeDownloading > 0

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

  // WebSocket
  useEffect(() => {
    if (!apiBase) return
    let ws: WebSocket
    let healthTimer: number

    const connect = () => {
      ws = new WebSocket(buildWsUrl('/api/ws'))
      ws.onopen = () => {
        setWsOnline(true)
        healthTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 15000)
      }
      ws.onclose = () => {
        setWsOnline(false)
        window.clearInterval(healthTimer)
        window.setTimeout(connect, 3000)
      }
      ws.onerror = () => {
        setWsOnline(false)
      }
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data)
        if (data.type === 'pong') return
        setProgressMap(prev => {
          const item = prev[data.live_key] || {
            live_key: data.live_key, progress: 0, merge_progress: 0, status: '', message: '', speed: '', speed_history: [], elapsed: '', eta: ''
          }
          return {
            ...prev,
            [data.live_key]: {
              ...item,
              progress: data.progress ?? item.progress,
              merge_progress: data.merge_progress ?? item.merge_progress,
              status: data.status || item.status,
              message: data.message || item.message,
              speed: data.speed || item.speed,
              elapsed: data.elapsed || item.elapsed,
              eta: data.eta || item.eta,
            }
          }
        })
        if (data.status === 'completed' || data.status === 'failed') fetchReplays()
      }
    }
    connect()
    return () => {
      window.clearInterval(healthTimer)
      setWsOnline(false)
      ws.close()
    }
  }, [apiBase, buildWsUrl, setProgressMap, setWsOnline])

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
      setBackendOnline(false)
    }
  }, [apiClient, setReplays, setProgressMap, setBackendOnline])

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
      if (!diskStatsErrorShown.current) {
        diskStatsErrorShown.current = true
        const status = (e as any)?.response?.status
        const msg = status === 404 ? t('messages.endpointNotFound') : getErrorMessage(e)
        showToast({ tone: 'error', title: t('messages.diskStatsFailed'), message: msg })
      }
    } finally {
      setDiskStatsLoading(false)
    }
  }, [apiBase, apiClient, setDiskStats, setDiskStatsLoading, showToast, t])

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
  }, [apiClient, setPaused, setRuntimeState, setBackendOnline])

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/config')
      useAppStore.getState().setConfig(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }, [apiClient, setBackendOnline])

  const fetchMe = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/me')
      useAppStore.getState().setMe(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(false)
    }
  }, [apiClient, setBackendOnline])

  const fetchClipTasks = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/clip/tasks')
      setClipTasks(res.data as ClipTaskRecord[])
    } catch (e) {
      // ignore
    }
  }, [apiClient, setClipTasks])

  // Initial loads
  useEffect(() => {
    if (!apiBase) return
    fetchReplays()
    fetchConfig()
    fetchMe()
    fetchClipTasks()
  }, [apiBase])

  // Timers
  useEffect(() => {
    fetchDiskStats()
    const intervalMs = activeDownloading > 0 ? 15000 : 60000
    const t = window.setInterval(fetchDiskStats, intervalMs)
    return () => window.clearInterval(t)
  }, [fetchDiskStats, activeDownloading])

  useEffect(() => {
    if (!apiBase || !useAppStore.getState().backendOnline || !hasActiveReplay) return
    const timer = window.setInterval(fetchReplays, 5000)
    return () => window.clearInterval(timer)
  }, [apiBase, hasActiveReplay, fetchReplays])

  useEffect(() => {
    if (!apiBase) return
    const intervalMs = hasActiveReplay ? 5000 : 30000
    const timer = window.setInterval(fetchRuntime, intervalMs)
    fetchRuntime()
    return () => window.clearInterval(timer)
  }, [apiBase, fetchRuntime, hasActiveReplay])

  return null
}
