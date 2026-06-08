import { X, PlayCircle, FolderOpen, Database, Download, PauseCircle, Trash2 } from 'lucide-react'
import { formatBytes, getErrorMessage, statusColor } from '../utils'
import { useTranslation } from 'react-i18next'
import { StatusPill } from './index'
import React, { useMemo } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { AxiosInstance } from 'axios'

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
  const replays = useAppStore(state => state.replays)
  const replaceToast = useAppStore(state => state.replaceToast)
  const paused = useAppStore(state => state.paused)
  const buildApiUrl = useAppStore(state => state.buildApiUrl)
  
  const selectedReplay = useMemo(() => replays.find(r => r.live_key === liveKey), [replays, liveKey])

  if (!selectedReplay) return null

  const renderStatus = (r: any) => {
    switch (r.status) {
      case 'pending': return <StatusPill label={t('dashboard.statusPending')} tone="neutral" />
      case 'downloading': return <StatusPill label={t('dashboard.statusDownloading')} tone="good" />
      case 'merging': return <StatusPill label={t('dashboard.statusMerging')} tone="good" />
      case 'done':
      case 'completed': return <StatusPill label={t('dashboard.statusDone')} tone="good" />
      case 'error':
      case 'failed': return <StatusPill label={t('dashboard.statusError')} tone="bad" />
      case 'paused': return <StatusPill label={t('dashboard.statusPaused')} tone="neutral" />
      case 'deleted': return <StatusPill label={t('dashboard.statusDeleted')} tone="neutral" />
      default: return <StatusPill label={r.status} tone="neutral" />
    }
  }

  const isDownloading = selectedReplay.status === 'downloading' || selectedReplay.status === 'merging'
  const isDone = selectedReplay.status === 'completed' || selectedReplay.status === 'done'
  const isDeleted = selectedReplay.status === 'deleted'
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
      throw e
    }
  }

  const handleDownload = async () => {
    await toastAction({
      loadingTitle: t('messages.starting'), successTitle: t('messages.started'), errorTitle: t('messages.startFailed'),
      action: () => apiClient.post(`/api/replays/${liveKey}/download`),
    })
  }

  const handlePause = async () => {
    await toastAction({
      loadingTitle: t('messages.pausing'), successTitle: t('messages.paused'), errorTitle: t('messages.pauseFailed'),
      action: () => apiClient.post(`/api/replays/${liveKey}/pause`),
    })
  }

  const handleResume = async () => {
    await toastAction({
      loadingTitle: t('messages.resuming'), successTitle: t('messages.resumed'), errorTitle: t('messages.resumeFailed'),
      action: () => apiClient.post(`/api/replays/${liveKey}/resume`),
    })
  }

  const handleCacheM3u8 = async () => {
    await toastAction({
      loadingTitle: t('messages.starting'), successTitle: t('messages.started'), errorTitle: t('messages.startFailed'),
      action: () => apiClient.post(`/api/replays/${liveKey}/cache-m3u8`),
    })
  }

  const handleDelete = async () => {
    if (!window.confirm(t('messages.confirmDelete'))) return
    await toastAction({
      loadingTitle: t('messages.deleting'), successTitle: t('messages.deleted'), errorTitle: t('messages.deleteFailed'),
      action: () => apiClient.delete(`/api/replays/${liveKey}`),
    })
    onClose()
  }

  const handleOpenFile = async () => {
    try { await apiClient.post('/api/clip/open-file', { filePath: selectedReplay.file_path }) } catch (e) {}
  }

  const handleOpenFolder = async () => {
    try { await apiClient.post('/api/clip/open-folder', { filePath: selectedReplay.file_path }) } catch (e) {}
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
                {isDone && !isDeleted && (
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
            {isDone && !isDeleted && (
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
            {!isDownloading && !isDone && !isDeleted && (
              <button
                disabled={!backendOnline || (paused && selectedReplay.status !== 'paused')}
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
                disabled={!backendOnline || paused}
                onClick={handleResume}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-[var(--color-bili-blue)] hover:bg-[#0092c4] rounded-lg shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PlayCircle className="w-4 h-4" />
                {t('dashboard.actionResume')}
              </button>
            )}
            <button
              disabled={!backendOnline || isDownloading || isDone}
              onClick={handleCacheM3u8}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('dashboard.cacheM3u8Tip')}
            >
              <Database className="w-4 h-4" />
              {t('dashboard.actionCacheM3u8')}
            </button>
            <button
              disabled={!backendOnline}
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
