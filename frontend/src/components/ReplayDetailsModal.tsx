import { X, PlayCircle, FolderOpen, Database, Download, PauseCircle, Trash2 } from 'lucide-react'
import { formatBytes, getErrorMessage, getReplayDisplayStatus, getReplayOutputAvailability, isReplayRelocationPending } from '../utils'
import { StatusPill } from './index'
import { useMemo } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import type { AxiosInstance } from 'axios'
import type { Replay } from '../types'
import { deleteReplayFile } from '../api/contracts'

export interface ReplayDetailsModalProps {
  liveKey: string
  onClose: () => void
  apiClient: AxiosInstance
  backendOnline: boolean
  showToast: (toast: any) => number
  t: (key: string, opts?: any) => string
}

export function ReplayDetailsModal({
  liveKey,
  onClose,
  apiClient,
  backendOnline,
  showToast,
  t
}: ReplayDetailsModalProps) {
  const { replays, replaceToast, paused, buildApiUrl, setReplays, patchReplay, upsertReplay, setProgressMap } = useAppStore(useShallow(state => ({
    replays: state.replays,
    replaceToast: state.replaceToast,
    paused: state.paused,
    buildApiUrl: state.buildApiUrl,
    setReplays: state.setReplays,
    patchReplay: state.patchReplay,
    upsertReplay: state.upsertReplay,
    setProgressMap: state.setProgressMap,
  })))
  
  const selectedReplay = useMemo(() => replays.find(r => r.live_key === liveKey), [replays, liveKey])

  if (!selectedReplay) return null

  const renderStatus = (r: any) => {
    switch (getReplayDisplayStatus(r.status, r.message, r.output_state)) {
      case 'pending': return <StatusPill label={t('dashboard.statusPending')} tone="neutral" />
      case 'downloading': return <StatusPill label={t('dashboard.statusDownloading')} tone="good" />
      case 'merging': return <StatusPill label={t('dashboard.statusMerging')} tone="good" />
      case 'done':
      case 'completed': return <StatusPill label={t('dashboard.statusDone')} tone="good" />
      case 'unavailable': return <StatusPill label={t('dashboard.statusUnavailable')} tone="neutral" />
      case 'ownership_changed': return <StatusPill label={t('dashboard.statusOwnershipChanged')} tone="bad" />
      case 'unknown': return <StatusPill label={t('common.loading')} tone="neutral" />
      case 'error':
      case 'failed': return <StatusPill label={t('dashboard.statusError')} tone="bad" />
      case 'paused': return <StatusPill label={t('dashboard.statusPaused')} tone="neutral" />
      case 'deleted': return <StatusPill label={t('dashboard.statusDeleted')} tone="neutral" />
      case 'deleting': return <StatusPill label={t('messages.deleting')} tone="neutral" />
      case 'not_downloaded': return <StatusPill label={t('dashboard.statusNotDownloaded')} tone="neutral" />
      default: return <StatusPill label={r.status} tone="neutral" />
    }
  }

  const isDownloading = ['pending', 'downloading', 'merging'].includes(selectedReplay.status)
  const isDeleting = selectedReplay.status === 'deleting'
  const isBusy = isDownloading || isDeleting
  const isDone = selectedReplay.status === 'completed' || selectedReplay.status === 'done'
  const isDeleted = selectedReplay.status === 'deleted'
  const outputAvailability = getReplayOutputAvailability(selectedReplay.message, selectedReplay.output_state)
  const relocationPending = isReplayRelocationPending(selectedReplay)
  const canOpenOutput = isDone && !isDeleted && outputAvailability === 'available' && Boolean(selectedReplay.file_path)
  const coverUrl = selectedReplay.local_cover ? buildApiUrl(`/covers/${selectedReplay.local_cover.replace(/^covers[/\\]/, '')}`) : ''

  const formatTime = (ts: number) => new Date(ts * 1000).toLocaleString()
  const formatDuration = (sec: number) => `${Math.floor(sec / 60)} ${t('common.min')} ${sec % 60} ${t('common.sec')}`

  const toastAction = async (opts: { loadingTitle: string; loadingMessage?: string; successTitle: string; successMessage?: string; errorTitle: string; action: () => Promise<any> }) => {
    const toastId = showToast({ tone: 'loading', title: opts.loadingTitle, message: opts.loadingMessage })
    try {
      const res = await opts.action()
      replaceToast(toastId, { tone: 'success', title: opts.successTitle, message: opts.successMessage })
      return res
    } catch (e) {
      replaceToast(toastId, { tone: 'error', title: opts.errorTitle, message: getErrorMessage(e) })
      return undefined
    }
  }

  const refreshReplays = async () => {
    const res = await apiClient.get<Replay[]>('/api/replays', { params: { _t: Date.now() } })
    setReplays(res.data || [])
  }

  const handleDownload = async () => {
    await toastAction({
      loadingTitle: t('messages.starting'), loadingMessage: t('messages.creatingTask'), successTitle: t('messages.started'), successMessage: t('messages.watchProgress'), errorTitle: t('messages.startFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${encodeURIComponent(liveKey)}/download`)
        if (res.data?.ok === false) throw new Error(t('messages.operationRejected'))
        patchReplay(liveKey, { status: 'pending', message: t('messages.queued'), progress: 0, speed: '', eta: '' })
        void refreshReplays().catch(() => {})
        return res
      },
    })
  }

  const handlePause = async () => {
    await toastAction({
      loadingTitle: t('messages.pausing'), successTitle: t('messages.paused'), errorTitle: t('messages.pauseFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${encodeURIComponent(liveKey)}/pause`)
        if (res.data?.ok === false) throw new Error(t('messages.operationRejected'))
        patchReplay(liveKey, { status: 'paused', message: t('common.paused'), speed: '', eta: '' })
        void refreshReplays().catch(() => {})
        return res
      },
    })
  }

  const handleResume = async () => {
    await toastAction({
      loadingTitle: t('messages.resuming'), successTitle: t('messages.resumed'), errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${encodeURIComponent(liveKey)}/resume`)
        if (res.data?.ok === false) throw new Error(t('messages.operationRejected'))
        patchReplay(liveKey, { status: 'pending', message: t('messages.resumed'), speed: '', eta: '' })
        void refreshReplays().catch(() => {})
        return res
      },
    })
  }

  const handleCacheM3u8 = async () => {
    await toastAction({
      loadingTitle: t('messages.caching'), loadingMessage: t('messages.fetchingM3u8'), successTitle: t('messages.cached'), successMessage: t('messages.savedM3u8'), errorTitle: t('messages.cacheFailed'),
      action: async () => {
        const res = await apiClient.post<Replay>(`/api/replays/${encodeURIComponent(liveKey)}/cache-m3u8`)
        if (res.data?.live_key) upsertReplay(res.data)
        return res
      },
    })
  }

  const handleDelete = async () => {
    if (!window.confirm(t('messages.confirmDelete'))) return
    const res = await toastAction({
      loadingTitle: t('messages.deleting'), successTitle: t('messages.deleted'), errorTitle: t('messages.deleteFailed'),
      action: async () => {
        const response = await deleteReplayFile(apiClient, liveKey)
        if (response.data?.live_key) upsertReplay(response.data)
        setProgressMap(prev => {
          const next = { ...prev }
          delete next[liveKey]
          return next
        })
        return response
      },
    })
    if (res) onClose()
  }

  const handleOpenFile = async () => {
    try { await apiClient.post('/api/clip/open-file', { filePath: selectedReplay.file_path }) } catch (e) {
      showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(e) })
    }
  }

  const handleOpenFolder = async () => {
    try { await apiClient.post('/api/clip/open-folder', { filePath: selectedReplay.file_path }) } catch (e) {
      showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(e) })
    }
  }

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 app-fade-in" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b bg-slate-50/50">
          <h2 className="text-xl font-bold text-slate-800 line-clamp-1 flex-1 pr-4" title={selectedReplay.title}>
            {selectedReplay.title}
          </h2>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 relative">
          <div className="flex flex-col md:flex-row gap-6">
            <div className="w-full md:w-64 flex-shrink-0">
              <div className="aspect-video bg-slate-100 rounded-xl overflow-hidden border border-slate-200 relative group shadow-inner">
                {coverUrl ? (
                  <img src={coverUrl} alt="Cover" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 gap-2">
                    <PlayCircle className="w-8 h-8 opacity-20" />
                    <span className="text-xs font-medium">No Cover</span>
                  </div>
                )}
                {canOpenOutput && (
                  <button 
                    onClick={handleOpenFile}
                    className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100"
                  >
                    <PlayCircle className="w-12 h-12 text-white drop-shadow-md" />
                  </button>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-2 justify-center">
                {renderStatus(selectedReplay)}
              </div>
            </div>

            <div className="flex-1 min-w-0 space-y-5 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t('dashboard.detailsLiveKey')}</div>
                  <div className="font-mono text-slate-700 bg-slate-50 px-2 py-1 rounded border border-slate-100 inline-block">
                    {selectedReplay.live_key}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t('dashboard.detailsStartTime')}</div>
                  <div className="text-slate-700">{formatTime(selectedReplay.start_time)}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t('dashboard.detailsDuration')}</div>
                  <div className="text-slate-700 font-medium">{formatDuration(selectedReplay.duration)}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t('dashboard.detailsFileSize')}</div>
                  <div className="text-slate-700">{formatBytes(selectedReplay.file_size)}</div>
                </div>
              </div>

              {selectedReplay.file_path && (
                <div className="space-y-1 border-t border-slate-100 pt-4">
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t('dashboard.detailsFilePath')}</div>
                  <div className="text-slate-600 break-all bg-slate-50 p-2 rounded border border-slate-100 text-xs font-mono">
                    {selectedReplay.file_path}
                  </div>
                </div>
              )}

              {selectedReplay.message && (
                <div className="space-y-1 border-t border-slate-100 pt-4">
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t('dashboard.detailsMessage')}</div>
                  <div className="text-slate-600 whitespace-pre-wrap text-xs bg-slate-50 p-2 rounded border border-slate-100">
                    {selectedReplay.message}
                  </div>
                </div>
              )}

              {selectedReplay.status === 'downloading' && (
                <div className="border-t border-slate-100 pt-4 space-y-2">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-[var(--color-bili-blue)]">{(selectedReplay.progress || 0).toFixed(1)}%</span>
                    <span className="text-slate-500">{selectedReplay.speed}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-[var(--color-bili-blue)] h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.max(0, Math.min(100, selectedReplay.progress || 0))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t bg-slate-50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {canOpenOutput && (
              <>
                <button
                  disabled={!backendOnline}
                  onClick={handleOpenFile}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-[var(--color-bili-blue)] bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <PlayCircle className="w-4 h-4" />
                  {t('dashboard.actionOpen')}
                </button>
                <button
                  disabled={!backendOnline}
                  onClick={handleOpenFolder}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('dashboard.actionOpenFolder')}
                </button>
              </>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {!isBusy && !isDone && (
              <button
                disabled={!backendOnline || relocationPending || (paused && selectedReplay.status !== 'paused')}
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-[var(--color-bili-blue)] hover:bg-[#0092c4] rounded-lg shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4" />
                {t('dashboard.actionDownload')}
              </button>
            )}
            {isDownloading && (
              <button
                disabled={!backendOnline}
                onClick={handlePause}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PauseCircle className="w-4 h-4" />
                {t('dashboard.actionPause')}
              </button>
            )}
            {selectedReplay.status === 'paused' && (
              <button
                disabled={!backendOnline || paused || relocationPending}
                onClick={handleResume}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-[var(--color-bili-blue)] hover:bg-[#0092c4] rounded-lg shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PlayCircle className="w-4 h-4" />
                {t('dashboard.actionResume')}
              </button>
            )}
            <button
              disabled={!backendOnline || isBusy || isDone}
              onClick={handleCacheM3u8}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('dashboard.cacheM3u8Tip')}
            >
              <Database className="w-4 h-4" />
              {t('dashboard.actionCacheM3u8')}
            </button>
            <button
              disabled={!backendOnline || isDeleting}
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 bg-white border border-red-200 hover:bg-red-50 hover:border-red-300 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" />
              {t('dashboard.actionDelete')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
