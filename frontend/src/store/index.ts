import { create } from 'zustand'
import axios, { AxiosInstance } from 'axios'
import type {
  Replay,
  Config,
  Progress,
  Me,
  Runtime,
  DiskStats,
  PageKey,
  Toast,
  ToastTone,
  ClipTaskRecord,
} from '../types'

interface AppState {
  // --- UI State ---
  page: PageKey
  setPage: (page: PageKey) => void
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  showAdvanced: boolean
  setShowAdvanced: (show: boolean) => void
  exportUseProxy: boolean
  setExportUseProxy: (use: boolean) => void
  showLoginModal: boolean
  setShowLoginModal: (show: boolean) => void
  selectedLiveKey: string | null
  setSelectedLiveKey: (key: string | null) => void
  m3u8Open: boolean
  setM3u8Open: (open: boolean) => void
  showTaskCenter: boolean
  setShowTaskCenter: (show: boolean) => void
  
  // Loading flags
  isScanning: boolean
  setIsScanning: (v: boolean) => void
  isRefreshing: boolean
  setIsRefreshing: (v: boolean) => void
  isSyncingAll: boolean
  setIsSyncingAll: (v: boolean) => void
  savingConfig: boolean
  setSavingConfig: (v: boolean) => void

  // --- Network & Data State ---
  apiBase: string
  setApiBase: (base: string) => void
  backendOnline: boolean
  setBackendOnline: (online: boolean) => void
  wsOnline: boolean
  setWsOnline: (online: boolean) => void
  apiClient: AxiosInstance
  buildApiUrl: (path: string) => string
  buildWsUrl: (path: string) => string

  me: Me | null
  setMe: (me: Me | null) => void
  config: Config | null
  setConfig: (config: Config | null) => void
  diskStats: DiskStats | null
  setDiskStats: (stats: DiskStats | null) => void
  diskStatsLoading: boolean
  setDiskStatsLoading: (v: boolean) => void

  // --- Domain Data ---
  replays: Replay[]
  setReplays: (replays: Replay[]) => void
  progressMap: Record<string, Progress>
  setProgressMap: (map: Record<string, Progress> | ((prev: Record<string, Progress>) => Record<string, Progress>)) => void
  clipTasks: ClipTaskRecord[]
  setClipTasks: (tasks: ClipTaskRecord[]) => void
  runtimeState: Runtime | null
  setRuntimeState: (state: Runtime | null) => void
  paused: boolean
  setPaused: (paused: boolean) => void

  // --- Toasts ---
  toasts: Toast[]
  toastSeq: number
  showToast: (toast: Omit<Toast, 'id'> & { durationMs?: number }) => number
  replaceToast: (id: number, toast: Omit<Toast, 'id'> & { durationMs?: number }) => void
  dismissToast: (id: number) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  page: 'downloads',
  setPage: (page) => set({ page }),
  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  showAdvanced: false,
  setShowAdvanced: (showAdvanced) => set({ showAdvanced }),
  exportUseProxy: false,
  setExportUseProxy: (exportUseProxy) => set({ exportUseProxy }),
  showLoginModal: false,
  setShowLoginModal: (showLoginModal) => set({ showLoginModal }),
  selectedLiveKey: null,
  setSelectedLiveKey: (selectedLiveKey) => set({ selectedLiveKey }),
  m3u8Open: false,
  setM3u8Open: (m3u8Open) => set({ m3u8Open }),
  showTaskCenter: false,
  setShowTaskCenter: (showTaskCenter) => set({ showTaskCenter }),

  isScanning: false,
  setIsScanning: (isScanning) => set({ isScanning }),
  isRefreshing: false,
  setIsRefreshing: (isRefreshing) => set({ isRefreshing }),
  isSyncingAll: false,
  setIsSyncingAll: (isSyncingAll) => set({ isSyncingAll }),
  savingConfig: false,
  setSavingConfig: (savingConfig) => set({ savingConfig }),

  apiBase: '',
  setApiBase: (apiBase) => {
    set({
      apiBase,
      apiClient: axios.create({ baseURL: apiBase || undefined })
    })
  },
  backendOnline: false,
  setBackendOnline: (backendOnline) => set({ backendOnline }),
  wsOnline: false,
  setWsOnline: (wsOnline) => set({ wsOnline }),
  apiClient: axios.create(),
  buildApiUrl: (path) => {
    const { apiBase } = get()
    if (!apiBase) return path
    return `${apiBase}${path}`
  },
  buildWsUrl: (path) => {
    const { apiBase } = get()
    if (!apiBase) return ''
    return `${apiBase.replace(/^http/i, 'ws')}${path}`
  },

  me: null,
  setMe: (me) => set({ me }),
  config: null,
  setConfig: (config) => set({ config }),
  diskStats: null,
  setDiskStats: (diskStats) => set({ diskStats }),
  diskStatsLoading: false,
  setDiskStatsLoading: (diskStatsLoading) => set({ diskStatsLoading }),

  replays: [],
  setReplays: (replays) => set({ replays }),
  progressMap: {},
  setProgressMap: (mapOrFn) => set((state) => ({
    progressMap: typeof mapOrFn === 'function' ? mapOrFn(state.progressMap) : mapOrFn
  })),
  clipTasks: [],
  setClipTasks: (clipTasks) => set({ clipTasks }),
  runtimeState: null,
  setRuntimeState: (runtimeState) => set({ runtimeState }),
  paused: false,
  setPaused: (paused) => set({ paused }),

  toasts: [],
  toastSeq: 1,
  showToast: (t) => {
    const id = get().toastSeq
    set((state) => {
      const next = [...state.toasts, { id, tone: t.tone, title: t.title, message: t.message }]
      return {
        toastSeq: id + 1,
        toasts: next.slice(-4)
      }
    })
    const dur = t.durationMs ?? (t.tone === 'error' ? 9000 : t.tone === 'loading' ? 12000 : 3500)
    window.setTimeout(() => get().dismissToast(id), dur)
    return id
  },
  replaceToast: (id, t) => {
    set((state) => {
      let found = false
      const next = state.toasts.map(toast => {
        if (toast.id === id) {
          found = true
          return { id, tone: t.tone, title: t.title, message: t.message }
        }
        return toast
      })
      if (!found) {
        next.push({ id, tone: t.tone, title: t.title, message: t.message })
      }
      return { toasts: next.slice(-4) }
    })
    const dur = t.durationMs ?? (t.tone === 'error' ? 9000 : t.tone === 'loading' ? 12000 : 3500)
    window.setTimeout(() => get().dismissToast(id), dur)
  },
  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }))
  }
}))
