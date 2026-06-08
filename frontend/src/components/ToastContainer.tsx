import { CheckCircle, XCircle, Loader2, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import React from 'react'

export function ToastContainer() {
  const toasts = useAppStore(state => state.toasts)
  const dismissToast = useAppStore(state => state.dismissToast)

  return (
    <div className="fixed top-4 right-4 z-[100] w-[min(360px,calc(100vw-2rem))] space-y-2">
      {toasts.map(t => {
        const toneCls =
          t.tone === 'success'
            ? 'border-green-200 bg-green-50 text-green-900'
            : t.tone === 'error'
            ? 'border-red-200 bg-red-50 text-red-900'
            : t.tone === 'loading'
            ? 'border-slate-200 bg-white text-slate-900'
            : 'border-slate-200 bg-slate-50 text-slate-900'
        return (
          <div key={t.id} className={`rounded-xl border shadow-sm px-3 py-2 ${toneCls}`}>
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                {t.tone === 'success' ? (
                  <CheckCircle className="w-4 h-4 text-green-600" />
                ) : t.tone === 'error' ? (
                  <XCircle className="w-4 h-4 text-red-600" />
                ) : t.tone === 'loading' ? (
                  <Loader2 className="w-4 h-4 text-[var(--color-bili-blue)] animate-spin" />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-slate-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{t.title}</div>
                {t.message ? <div className="text-xs text-slate-600 mt-0.5 break-words">{t.message}</div> : null}
              </div>
              <button onClick={() => dismissToast(t.id)} className="p-1 rounded hover:bg-black/5">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
