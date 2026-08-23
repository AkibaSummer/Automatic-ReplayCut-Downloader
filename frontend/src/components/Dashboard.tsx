import { RefreshCcw, Loader2, Download, MoreHorizontal, Copy, CheckCircle, XCircle, PauseCircle, Play, Pause, FolderOpen, Wrench, FileVideo } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { formatBytes, getErrorMessage, getReplayDisplayStatus, isReplayRelocationPending, shouldUseRealtimeProgress, statusColor } from '../utils'
import { Tooltip } from './index'
import React, { useRef, useEffect } from 'react'

export function Dashboard({
  fetchReplays,
  handleScan,
  handleSyncAll,
}: {
  fetchReplays: (opts?: { notify?: boolean }) => Promise<void>
  handleScan: () => Promise<void>
  handleSyncAll: () => Promise<void>
}) {
  const { t } = useTranslation()

  const {
    showAdvanced, setShowAdvanced,
    isRefreshing, isScanning, isSyncingAll,
    backendOnline, paused,
    replays, progressMap, runtimeState,
    buildApiUrl, apiClient, showToast, replaceToast,
    setSelectedLiveKey, patchReplay
  } = useAppStore(useShallow(state => ({

    showAdvanced: state.showAdvanced, setShowAdvanced: state.setShowAdvanced,
    isRefreshing: state.isRefreshing, isScanning: state.isScanning, isSyncingAll: state.isSyncingAll,
    backendOnline: state.backendOnline, paused: state.paused,
    replays: state.replays, progressMap: state.progressMap, runtimeState: state.runtimeState,
    buildApiUrl: state.buildApiUrl, apiClient: state.apiClient, showToast: state.showToast, replaceToast: state.replaceToast,
    setSelectedLiveKey: state.setSelectedLiveKey, patchReplay: state.patchReplay
  
})))

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
  }, [showAdvanced, setShowAdvanced])

  const runtimeSnapshot = runtimeState || {
    max_concurrent_tasks: 0,
    concurrent_segments: 0,
    downloading_tasks: 0,
    queued_tasks: 0,
    paused_tasks: 0,
    failed_tasks: 0,
  }

  const runtimeCards = [
    { label: t('dashboard.concurrencyLimit'), value: runtimeSnapshot.max_concurrent_tasks, tone: 'text-[var(--color-bili-blue)]' },
    { label: t('dashboard.downloadingTasks'), value: runtimeSnapshot.downloading_tasks, tone: 'text-green-600' },
    { label: t('dashboard.queuedTasks'), value: runtimeSnapshot.queued_tasks, tone: 'text-amber-600' },
    { label: t('dashboard.pausedTasks'), value: runtimeSnapshot.paused_tasks, tone: 'text-slate-600' },
  ]

  const activeDownloading = replays.filter(r => r.status === 'downloading' || r.status === 'merging').length

  const handleCopyExport = async () => {
    try {
      const res = await apiClient.get('/api/export-tsv')
      await navigator.clipboard.writeText(res.data)
      showToast({ tone: 'success', title: t('messages.copyExportOk') })
    } catch (e) {
      showToast({ tone: 'error', title: t('messages.copyExportFailed'), message: getErrorMessage(e) })
    }
  }

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

  const handleDownload = async (liveKey: string) => {
    await toastAction({
      loadingTitle: t('messages.starting'), loadingMessage: t('messages.creatingTask'), successTitle: t('messages.started'), successMessage: t('messages.watchProgress'), errorTitle: t('messages.startFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${encodeURIComponent(liveKey)}/download`)
        if (res.data?.ok === false) throw new Error(t('messages.operationRejected'))
        patchReplay(liveKey, { status: 'pending', message: t('messages.queued'), progress: 0, speed: '', eta: '' })
        void fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handlePauseReplay = async (liveKey: string) => {
    await toastAction({
      loadingTitle: t('messages.pausing'), successTitle: t('messages.paused'), errorTitle: t('messages.pauseFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${encodeURIComponent(liveKey)}/pause`)
        if (res.data?.ok === false) throw new Error(t('messages.operationRejected'))
        patchReplay(liveKey, { status: 'paused', message: t('common.paused'), speed: '', eta: '' })
        void fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleResumeReplay = async (liveKey: string) => {
    await toastAction({
      loadingTitle: t('messages.resuming'), successTitle: t('messages.resumed'), errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post(`/api/replays/${encodeURIComponent(liveKey)}/resume`)
        if (res.data?.ok === false) throw new Error(t('messages.operationRejected'))
        patchReplay(liveKey, { status: 'pending', message: t('messages.resumed'), speed: '', eta: '' })
        void fetchReplays({ notify: false })
        return res
      },
    })
  }

  const getCoverUrl = (localCover: string) => {
    if (!localCover) return null
    const filename = localCover.replace(/^covers[/\\]/, '')
    return buildApiUrl(`/covers/${filename}`)
  }

  return (
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
                  onClick={() => { window.open(buildApiUrl('/api/export-tsv'), '_blank'); setShowAdvanced(false); }}
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
            const rawDisplayStatus = p?.status || r.status
            const displayStatus = getReplayDisplayStatus(rawDisplayStatus, r.message, r.output_state)
            const relocationPending = isReplayRelocationPending(r)
            const baseProgress = Math.max(0, Math.min(100, p?.progress ?? r.progress ?? 0))
            const mergeProgress = Math.max(0, Math.min(100, p?.merge_progress ?? 0))

            let displayProgress = baseProgress
            if (displayStatus === 'downloading') {
              displayProgress = baseProgress * 0.95
            } else if (displayStatus === 'merging') {
              displayProgress = 95 + (mergeProgress * 0.05)
            }

            const showProgress = ['downloading', 'merging', 'paused', 'deleting'].includes(displayStatus)
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
                          {displayStatus === 'unavailable'
                            ? t('dashboard.statusUnavailable')
                            : displayStatus === 'ownership_changed'
                            ? t('dashboard.statusOwnershipChanged')
                            : displayStatus === 'unknown'
                            ? t('common.loading')
                            : displayStatus.toUpperCase()}
                        </span>
                        {displayStatus === 'completed' && <CheckCircle className="w-4 h-4 text-green-500" />}
                        {displayStatus === 'failed' && <XCircle className="w-4 h-4 text-red-500" />}
                        {displayStatus === 'deleted' && <XCircle className="w-4 h-4 text-violet-500" />}
                        {(displayStatus === 'downloading' || displayStatus === 'merging') && <Loader2 className="w-4 h-4 text-[var(--color-bili-blue)] animate-spin" />}
                        {displayStatus === 'deleting' && <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />}
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
                        disabled={!backendOnline || paused || relocationPending}
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
                        disabled={!backendOnline || paused || relocationPending}
                        className="p-2.5 text-slate-500 hover:text-green-600 rounded-xl bg-white border border-slate-200 shadow-sm transition duration-200 hover:-translate-y-0.5 disabled:opacity-50"
                      >
                        <Tooltip content={t('dashboard.resumeBtn')}>
                          <Play className="w-4 h-4" />
                        </Tooltip>
                      </button>
                    )}
                    {r.file_path && displayStatus === 'completed' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => { void apiClient.post('/api/clip/open-file', { filePath: r.file_path }).catch(error => showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(error) })) }}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[var(--color-bili-blue)] bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                        >
                          <FileVideo className="w-4 h-4" />
                          {t('clipTask.openFile')}
                        </button>
                        <button
                          onClick={() => { void apiClient.post('/api/clip/open-folder', { filePath: r.file_path }).catch(error => showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(error) })) }}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                        >
                          <FolderOpen className="w-4 h-4" />
                          {t('clipTask.openFolder')}
                        </button>
                      </div>
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
  )
}
