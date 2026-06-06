import type { Progress, Replay } from '../types'

export function getErrorMessage(e: any) {
  const apiErr = e?.response?.data?.error
  if (apiErr) return apiErr
  const status = e?.response?.status
  if (status) {
    const statusText = e?.response?.statusText || ''
    return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  }
  return e?.message || 'Unknown error'
}

export function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function statusColor(status: string) {
  if (status === 'completed') return 'bg-green-500'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'deleted') return 'bg-violet-500'
  if (status === 'paused') return 'bg-amber-500'
  if (status === 'downloading' || status === 'merging') return 'bg-[var(--color-bili-blue)]'
  return 'bg-slate-400'
}

export const ACTIVE_STATUSES = ['pending', 'downloading', 'merging', 'paused'] as const
export const TERMINAL_STATUSES = ['completed', 'failed', 'deleted', 'not_downloaded'] as const

export function shouldUseRealtimeProgress(progress: Progress | undefined, replay: Replay) {
  if (!progress) return false
  if (TERMINAL_STATUSES.includes(replay.status as typeof TERMINAL_STATUSES[number]) &&
      ACTIVE_STATUSES.includes(progress.status as typeof ACTIVE_STATUSES[number])) {
    return false
  }
  return true
}
