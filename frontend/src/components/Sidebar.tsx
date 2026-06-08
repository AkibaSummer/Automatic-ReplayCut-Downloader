import { LayoutDashboard, Settings, Scissors, Download, Tv, X, Play, Pause, Wrench, Eraser } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { formatBytes, getErrorMessage } from '../utils'
import { StatusPill } from './index'

export function Sidebar({
  fetchReplays,
  fetchRuntime,
  fetchDiskStats,
}: {
  fetchReplays: (opts?: { notify?: boolean }) => Promise<void>
  fetchRuntime: () => Promise<void>
  fetchDiskStats: () => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const {
    page, setPage,
    sidebarOpen, setSidebarOpen,
    showTaskCenter, setShowTaskCenter,
    clipTasks,
    runtimeState, paused,
    me, config, diskStats, diskStatsLoading,
    backendOnline, apiClient, showToast, replaceToast,
    buildApiUrl, setShowLoginModal, setPaused
  } = useAppStore(useShallow(state => ({

    page: state.page, setPage: state.setPage,
    sidebarOpen: state.sidebarOpen, setSidebarOpen: state.setSidebarOpen,
    showTaskCenter: state.showTaskCenter, setShowTaskCenter: state.setShowTaskCenter,
    clipTasks: state.clipTasks,
    runtimeState: state.runtimeState, paused: state.paused,
    me: state.me, config: state.config, diskStats: state.diskStats, diskStatsLoading: state.diskStatsLoading,
    backendOnline: state.backendOnline, apiClient: state.apiClient, showToast: state.showToast, replaceToast: state.replaceToast,
    buildApiUrl: state.buildApiUrl, setShowLoginModal: state.setShowLoginModal, setPaused: state.setPaused
  
})))

  const runtimeSnapshot = runtimeState || {
    max_concurrent_tasks: 0,
    concurrent_segments: 0,
    downloading_tasks: 0,
    queued_tasks: 0,
    paused_tasks: 0,
    failed_tasks: 0,
  }

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

  const handleCleanupStale = async () => {
    const toastId = showToast({ tone: 'loading', title: t('messages.fixing'), message: t('messages.cleaningStale') })
    try {
      const res = await apiClient.post('/api/cleanup-stale')
      const count = res.data?.count ?? 0
      replaceToast(toastId, { tone: 'success', title: t('messages.fixed'), message: t('messages.fixedCount', { count }) })
      await fetchReplays({ notify: false })
    } catch (e) {
      replaceToast(toastId, { tone: 'error', title: t('messages.fixFailed'), message: getErrorMessage(e) })
    }
  }

  const handleCleanupStreams = async () => {
    const toastId = showToast({ tone: 'loading', title: t('common.cleaning'), message: t('messages.cleaningStreams') })
    try {
      const res = await apiClient.post('/api/cleanup-streams')
      const count = res.data?.count ?? 0
      replaceToast(toastId, { tone: 'success', title: t('messages.cleanSuccess'), message: t('messages.cleanStreamsCount', { count }) })
      await fetchReplays({ notify: false })
    } catch (e) {
      replaceToast(toastId, { tone: 'error', title: t('messages.cleanFailed'), message: getErrorMessage(e) })
    }
  }

  const handlePauseAll = async () => {
    await toastAction({
      loadingTitle: t('messages.pausing'), loadingMessage: t('messages.stoppingTasks'), successTitle: t('messages.paused'), errorTitle: t('messages.pauseFailed'),
      action: async () => {
        const res = await apiClient.post('/api/pause-all')
        setPaused(true)
        await fetchReplays({ notify: false })
        return res
      },
    })
  }

  const handleResumeAll = async () => {
    await toastAction({
      loadingTitle: t('messages.resuming'), loadingMessage: t('messages.allowingTasks'), successTitle: t('messages.resumed'), errorTitle: t('messages.resumeFailed'),
      action: async () => {
        const res = await apiClient.post('/api/resume-all')
        setPaused(false)
        await fetchRuntime()
        return res
      },
    })
  }

  const runtimePills = []
  if (paused) runtimePills.push(<StatusPill key="paused" label={t('common.paused')} tone="neutral" />)

  return (
    <>
      <div className={`fixed inset-0 z-40 bg-black/30 ${sidebarOpen ? '' : 'hidden'}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`fixed z-50 inset-y-0 left-0 w-72 h-screen bg-white border-r border-slate-200 flex flex-col transform transition-transform md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:w-64 md:h-screen md:flex-shrink-0`}>
        <div className="h-16 flex items-center justify-between px-6 border-b border-slate-200">
          <div className="flex items-center">
            <Tv className="w-6 h-6 text-[var(--color-bili-pink)] mr-2" />
            <h1 className="font-bold text-lg tracking-tight">随缘公会工作台</h1>
          </div>
          <button className="md:hidden p-2 rounded hover:bg-slate-100" onClick={() => setSidebarOpen(false)}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
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
          <button
            onClick={() => { setShowTaskCenter(true); setSidebarOpen(false) }}
            className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md ${showTaskCenter ? 'bg-stone-100 text-[var(--color-bili-blue)]' : 'text-slate-700 hover:bg-slate-50'}`}
          >
            <Download className="w-5 h-5 mr-3" />
            {t('clipTask.center')}
            {clipTasks.filter(t => t.status === 'processing' || t.status === 'pending').length > 0 && (
              <span className="ml-auto flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-bili-pink)] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-bili-pink)]"></span>
              </span>
            )}
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
                  <span className="font-mono">{runtimeSnapshot.max_concurrent_tasks}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t('dashboard.segmentConcurrency')}</span>
                  <span className="font-mono">{runtimeSnapshot.concurrent_segments}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t('dashboard.downloadingTasks')}</span>
                  <span className="font-mono">{runtimeSnapshot.downloading_tasks}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t('dashboard.queuedTasks')}</span>
                  <span className="font-mono">{runtimeSnapshot.queued_tasks}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t('dashboard.pausedTasks')}</span>
                  <span className="font-mono">{runtimeSnapshot.paused_tasks}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t('dashboard.failedTasks')}</span>
                  <span className="font-mono">{runtimeSnapshot.failed_tasks}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 px-3 pb-4">
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
    </>
  )
}
