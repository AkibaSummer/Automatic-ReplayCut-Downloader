import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './components/Dashboard'
import { AppController } from './components/AppController'
import { ToastContainer } from './components/ToastContainer'
import { ReplayDetailsModal } from './components/ReplayDetailsModal'
import { DirectoryModal } from './components/DirectoryModal'
import { LoginModal } from './components/index'
import { ClipPage } from './ClipPage'
import { SettingsPage } from './SettingsPage'
import { useAppStore } from './store'
import { useShallow } from 'zustand/react/shallow'
import { getErrorMessage, isBackendReachableError } from './utils'
import { quitDesktopApp, scanReplays } from './api/contracts'
import { FileText, FolderOpen, X } from 'lucide-react'
import { StatusPill } from './components/index'
import type { Config, Me, Replay, ScanSummary } from './types'
import React from 'react'

function App() {
  const { t } = useTranslation()
  const {
    page, showLoginModal, setShowLoginModal, selectedLiveKey, setSelectedLiveKey,
    showTaskCenter, setShowTaskCenter, clipTasks,
    config, setConfig, backendOnline, apiBase, isScanning, isSyncingAll, savingConfig, paused,
    setIsScanning, setIsRefreshing, setIsSyncingAll,
    apiClient, setReplays, setBackendOnline, showToast, replaceToast
  } = useAppStore(useShallow(state => ({
    page: state.page, showLoginModal: state.showLoginModal, setShowLoginModal: state.setShowLoginModal,
    selectedLiveKey: state.selectedLiveKey, setSelectedLiveKey: state.setSelectedLiveKey,
    showTaskCenter: state.showTaskCenter, setShowTaskCenter: state.setShowTaskCenter, clipTasks: state.clipTasks,
    config: state.config, setConfig: state.setConfig, backendOnline: state.backendOnline, apiBase: state.apiBase,
    isScanning: state.isScanning, isSyncingAll: state.isSyncingAll, savingConfig: state.savingConfig, paused: state.paused,
    setIsScanning: state.setIsScanning, setIsRefreshing: state.setIsRefreshing, setIsSyncingAll: state.setIsSyncingAll,
    apiClient: state.apiClient, setReplays: state.setReplays, setBackendOnline: state.setBackendOnline,
    showToast: state.showToast, replaceToast: state.replaceToast
  })))

  const fetchReplays = async (opts?: { notify?: boolean }) => {
    if (!useAppStore.getState().apiBase) return
    if (opts?.notify) setIsRefreshing(true)
    try {
      const res = await apiClient.get('/api/replays', { params: { _t: Date.now() } })
      const list = (res.data || []) as Replay[]
      setReplays(list)
      useAppStore.getState().setProgressMap(prev => {
        const liveKeys = new Set(list.map(replay => replay.live_key))
        const next = { ...prev }
        for (const liveKey of Object.keys(next)) {
          if (!liveKeys.has(liveKey)) delete next[liveKey]
        }
        return next
      })
      setBackendOnline(true)
      if (opts?.notify) showToast({ tone: 'success', title: t('common.refreshed') })
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
      if (opts?.notify) showToast({ tone: 'error', title: t('messages.refreshFailed'), message: getErrorMessage(e) })
    } finally {
      if (opts?.notify) setIsRefreshing(false)
    }
  }

  const fetchRuntime = async () => {
    try {
      const res = await apiClient.get('/api/runtime')
      useAppStore.getState().setPaused(!!res.data.paused)
      useAppStore.getState().setRuntimeState(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
    }
  }

  const fetchDiskStats = async () => {
    if (!useAppStore.getState().apiBase || !useAppStore.getState().backendOnline || !useAppStore.getState().config?.download?.output_dir) return
    useAppStore.getState().setDiskStatsLoading(true)
    try {
      const res = await apiClient.get('/api/stats/disk')
      useAppStore.getState().setDiskStats(res.data)
    } catch (e) {
      useAppStore.getState().setDiskStats(null)
      setBackendOnline(isBackendReachableError(e))
    } finally {
      useAppStore.getState().setDiskStatsLoading(false)
    }
  }

  const handleScan = async () => {
    if (isScanning) return
    setIsScanning(true)
    const toastId = showToast({ tone: 'loading', title: t('messages.scanning'), message: t('messages.scanWait') })
    try {
      const res = await scanReplays(apiClient)
      const raw = res.data || {}
      const summary: ScanSummary = {
        fetched: raw.fetched ?? raw.total ?? 0,
        new_records: raw.new_records ?? raw.added ?? 0,
        updated_records: raw.updated_records ?? raw.updated ?? 0,
        covers_updated: raw.covers_updated ?? 0,
        marked_deleted: raw.marked_deleted ?? 0,
        already_up_to_date: raw.already_up_to_date ?? 0,
      }
      setBackendOnline(true)
      replaceToast(toastId, {
        tone: 'success', title: t('messages.scanSuccess'), durationMs: 15000,
        message: t('messages.scanSummary', summary as any) as string,
      })
      await fetchReplays({ notify: false })
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
      replaceToast(toastId, { tone: 'error', title: t('messages.scanFailed'), message: getErrorMessage(e) })
    } finally {
      setIsScanning(false)
    }
  }

  const handleSyncAll = async () => {
    if (isSyncingAll) return
    setIsSyncingAll(true)
    const toastId = showToast({ tone: 'loading', title: t('messages.starting'), message: t('messages.syncAllPending') })
    try {
      await apiClient.post('/api/download-unfinished')
      setBackendOnline(true)
      replaceToast(toastId, { tone: 'success', title: t('messages.started'), message: t('messages.syncAllStarted') })
      await fetchReplays({ notify: false })
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
      replaceToast(toastId, { tone: 'error', title: t('messages.startFailed'), message: getErrorMessage(e) })
    } finally {
      setIsSyncingAll(false)
    }
  }

  const handleSaveConfig = async () => {
    const newConf = useAppStore.getState().config
    if (!newConf) return
    useAppStore.getState().setSavingConfig(true)
    const toastId = showToast({ tone: 'loading', title: t('messages.saving') })
    try {
      const res = await apiClient.post<Config>('/api/config', newConf)
      if (res.data?.download) setConfig(res.data)
      setBackendOnline(true)
      replaceToast(toastId, { tone: 'success', title: t('messages.saveSuccess') })
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
      replaceToast(toastId, { tone: 'error', title: t('messages.saveFailed'), message: getErrorMessage(e) })
    } finally {
      useAppStore.getState().setSavingConfig(false)
    }
  }

  const handleQuitApp = async () => {
    if (!window.desktopAPI?.quitApp) {
      showToast({ tone: 'error', title: t('messages.quitFailed'), message: t('messages.quitUnavailable') })
      return
    }
    try {
      await quitDesktopApp(window.desktopAPI)
    } catch (e) {
      showToast({ tone: 'error', title: t('messages.quitFailed'), message: getErrorMessage(e) })
    }
  }

  const [dirModalOpen, setDirModalOpen] = React.useState(false)

  const handleLoginSuccess = React.useCallback(async () => {
    try {
      const res = await apiClient.get<Me>('/api/me', { params: { _t: Date.now() } })
      useAppStore.getState().setMe(res.data)
      setBackendOnline(true)
    } catch (e) {
      setBackendOnline(isBackendReachableError(e))
      showToast({ tone: 'error', title: t('messages.loginRefreshFailed'), message: getErrorMessage(e) })
    } finally {
      setShowLoginModal(false)
    }
  }, [apiClient, setBackendOnline, setShowLoginModal, showToast, t])

  return (
    <>
      <AppController />
      <ToastContainer />
      <div className="flex h-screen bg-slate-50 text-slate-800 font-sans antialiased overflow-hidden selection:bg-[var(--color-bili-pink)] selection:text-white">
        <Sidebar fetchReplays={fetchReplays} fetchRuntime={fetchRuntime} fetchDiskStats={fetchDiskStats} />
        
        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <div className="h-16 flex items-center justify-between px-4 sm:px-6 border-b border-slate-200 bg-white md:hidden">
            <button className="p-2 rounded hover:bg-slate-100" onClick={() => useAppStore.getState().setSidebarOpen(true)}>
              <span className="sr-only">Open sidebar</span>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <div className="font-bold tracking-tight">随缘公会工作台</div>
            <div className="w-8" />
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            {page === 'downloads' && (
              <Dashboard fetchReplays={fetchReplays} handleScan={handleScan} handleSyncAll={handleSyncAll} />
            )}

            {page === 'settings' && (
              <SettingsPage
                config={config}
                setConfig={setConfig}
                savingConfig={savingConfig}
                handleSaveConfig={() => handleSaveConfig()}
                handleQuitApp={handleQuitApp}
                backendOnline={backendOnline}
                paused={paused}
                openDirModal={() => setDirModalOpen(true)}
                t={t}
              />
            )}

            <div style={{ display: page === 'clip' ? undefined : 'none' }}>
              <ClipPage apiClient={apiClient} apiBase={apiBase} showToast={showToast} t={t} clipTasks={clipTasks} />
            </div>
          </div>
        </main>
      </div>

      {selectedLiveKey && (
        <ReplayDetailsModal
          liveKey={selectedLiveKey}
          onClose={() => setSelectedLiveKey(null)}
          apiClient={apiClient}
          backendOnline={backendOnline}
          showToast={showToast}
          t={t}
        />
      )}

      {dirModalOpen && (
        <DirectoryModal
          apiClient={apiClient}
          onClose={() => setDirModalOpen(false)}
          onSelect={(path) => {
            if (config) {
              const newConfig = { ...config, download: { ...config.download, output_dir: path } }
              useAppStore.getState().setConfig(newConfig)
              handleSaveConfig()
            }
            setDirModalOpen(false)
          }}
          t={t}
        />
      )}

      {showLoginModal && (
        <LoginModal apiClient={apiClient} onClose={() => setShowLoginModal(false)} onSuccess={handleLoginSuccess} />
      )}

      {showTaskCenter && (
        <div className="fixed inset-0 bg-black/40 flex justify-end z-[90]" onClick={e => { if (e.target === e.currentTarget) setShowTaskCenter(false) }}>
          <div className="bg-white w-full max-w-md h-full flex flex-col shadow-2xl app-slide-in">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="font-bold text-lg">{t('clipTask.center')}</div>
              <button className="p-2 rounded hover:bg-slate-100" onClick={() => setShowTaskCenter(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
              {clipTasks.length === 0 ? (
                <div className="text-center text-slate-400 mt-10">{t('clipTask.empty')}</div>
              ) : clipTasks.map(task => (
                <div key={task.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="flex justify-between items-start mb-2">
                    <div className="font-medium text-slate-900 truncate pr-2">{task.title}</div>
                    <StatusPill 
                      label={task.status.toUpperCase()} 
                      tone={task.status === 'done' ? 'good' : task.status === 'error' ? 'bad' : 'neutral'} 
                    />
                  </div>
                  <div className="text-xs text-slate-500 mb-3">
                    {new Date(task.created_at).toLocaleString()}
                  </div>
                  
                  {(task.status === 'processing' || task.status === 'pending') && (
                    <div>
                      <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-[var(--color-bili-blue)] h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${task.progress}%` }}
                        />
                      </div>
                      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                        <span className="truncate pr-2">{task.message || t('clipTask.clipping')}</span>
                        <span className="flex-shrink-0">{Math.round(task.progress)}%</span>
                      </div>
                    </div>
                  )}

                  {task.status === 'done' && (
                    <div className="mt-2">
                      {task.message && <div className="text-xs text-green-700 mb-1.5">{task.message}</div>}
                      <div className="text-xs text-green-600 bg-green-50 p-2 rounded truncate mb-2" title={task.file_path}>
                        {task.file_path}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => { void apiClient.post('/api/clip/open-file', { filePath: task.file_path }).catch(error => showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(error) })) }}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
                        >
                          <FileText className="w-3 h-3" />
                          {t('clipTask.openFile')}
                        </button>
                        <button
                          onClick={() => { void apiClient.post('/api/clip/open-folder', { filePath: task.file_path }).catch(error => showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(error) })) }}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
                        >
                          <FolderOpen className="w-3 h-3" />
                          {t('clipTask.openFolder')}
                        </button>
                      </div>
                    </div>
                  )}

                  {task.status === 'error' && (
                    <div className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded">
                      {task.message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default App
