import { X, Folder, ChevronRight, CornerLeftUp, Loader2 } from 'lucide-react'
import type { FsEntry, FsListResponse } from '../types'
import { useTranslation } from 'react-i18next'
import React, { useState, useEffect, useCallback } from 'react'
import { AxiosInstance } from 'axios'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'

export interface DirectoryModalProps {
  onClose: () => void
  onSelect: (path: string) => void
  apiClient: AxiosInstance
  t: (key: string, opts?: any) => string
}

export function DirectoryModal({
  onClose,
  onSelect,
  apiClient,
  t
}: DirectoryModalProps) {
  const [dirCurrent, setDirCurrent] = useState('')
  const [dirParent, setDirParent] = useState('')
  const [dirLoading, setDirLoading] = useState(false)
  const [dirEntries, setDirEntries] = useState<FsEntry[]>([])
  const showToast = useAppStore(state => state.showToast)

  const loadDirList = useCallback(async (path?: string) => {
    setDirLoading(true)
    try {
      const res = await apiClient.get<FsListResponse>('/api/fs/list', {
        params: { path: path || '' }
      })
      setDirCurrent(res.data.current)
      setDirParent(res.data.parent)
      setDirEntries(res.data.entries || [])
    } catch (e: any) {
      showToast({ tone: 'error', title: t('dashboard.fsFailed') })
    } finally {
      setDirLoading(false)
    }
  }, [apiClient, showToast, t])

  useEffect(() => {
    const config = useAppStore.getState().config
    loadDirList(config?.download?.output_dir || '')
  }, [loadDirList])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 app-fade-in" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex justify-between items-center bg-slate-50">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <Folder className="w-5 h-5 text-[var(--color-bili-blue)]" />
            {t('settings.selectDirectory')}
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded transition-colors text-slate-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 py-2 bg-slate-100 border-b flex items-center gap-2 overflow-x-auto text-sm text-slate-700 whitespace-nowrap scrollbar-hide">
          {dirCurrent || '(Root)'}
        </div>

        <div className="flex-1 h-80 overflow-y-auto p-2 bg-white relative">
          {dirLoading && (
            <div className="absolute inset-0 z-10 bg-white/80 flex items-center justify-center backdrop-blur-[1px]">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--color-bili-blue)]" />
            </div>
          )}

          {dirParent && (
            <button
              onClick={() => loadDirList(dirParent)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-lg text-left transition-colors group"
            >
              <CornerLeftUp className="w-5 h-5 text-slate-400 group-hover:text-slate-600" />
              <span className="text-sm font-medium text-slate-700">..</span>
            </button>
          )}
          {dirEntries.map(entry => (
            <button
              key={entry.name}
              onClick={() => loadDirList(entry.path)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-lg text-left transition-colors group"
            >
              <Folder className="w-5 h-5 text-blue-300 group-hover:text-[var(--color-bili-blue)] fill-current opacity-80" />
              <span className="text-sm text-slate-700 flex-1 truncate">{entry.name}</span>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500" />
            </button>
          ))}
          {dirEntries.length === 0 && !dirLoading && (
            <div className="h-full flex items-center justify-center text-sm text-slate-400">
              {t('settings.noSubDirs')}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t bg-slate-50 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors">
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              if (dirCurrent) onSelect(dirCurrent)
            }}
            disabled={!dirCurrent}
            className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-bili-blue)] hover:bg-[#0092c4] rounded-lg shadow-sm transition-colors disabled:opacity-50"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
