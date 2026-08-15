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

// Axios only sets `response` after receiving an HTTP response. A 4xx/5xx may
// represent an upstream or business failure, but it still proves that the local
// desktop backend is reachable. Network/connection failures have no response.
export function isBackendReachableError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  return Boolean((error as { response?: unknown }).response)
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
// `not_downloaded` is restartable. A freshly queued download can emit WS progress
// before the follow-up replay fetch observes `pending`, so treating it as terminal
// would discard the first (and sometimes only) realtime update.
export const TERMINAL_STATUSES = ['completed', 'failed', 'deleted'] as const

export function mergeRealtimeProgress(current: Progress, update: Partial<Progress>): Progress {
  return {
    ...current,
    updated_at: update.updated_at ?? current.updated_at,
    progress: update.progress ?? current.progress,
    merge_progress: update.merge_progress ?? current.merge_progress,
    status: update.status || current.status,
    message: update.message ?? current.message,
    speed: update.speed ?? current.speed,
    speed_history: Array.isArray(update.speed_history) ? update.speed_history : current.speed_history,
    elapsed: update.elapsed ?? current.elapsed,
    eta: update.eta ?? current.eta,
  }
}

export function shouldUseRealtimeProgress(progress: Progress | undefined, replay: Replay) {
  if (!progress) return false
  const progressUpdatedAt = Date.parse(progress.updated_at || '')
  const replayUpdatedAt = Date.parse(replay.UpdatedAt || '')
  if (Number.isFinite(progressUpdatedAt) && Number.isFinite(replayUpdatedAt) && (
    progressUpdatedAt < replayUpdatedAt
    || (progressUpdatedAt === replayUpdatedAt && progress.status !== replay.status)
  )) {
    return false
  }
  if (TERMINAL_STATUSES.includes(replay.status as typeof TERMINAL_STATUSES[number]) &&
      ACTIVE_STATUSES.includes(progress.status as typeof ACTIVE_STATUSES[number])) {
    return false
  }
  return true
}
