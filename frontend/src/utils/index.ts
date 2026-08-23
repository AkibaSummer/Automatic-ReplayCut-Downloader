import type { ClipTaskRecord, Progress, Replay } from '../types'

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
  if (status === 'unavailable') return 'bg-amber-500'
  if (status === 'ownership_changed') return 'bg-red-500'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'deleted') return 'bg-violet-500'
  if (status === 'deleting') return 'bg-amber-500'
  if (status === 'paused') return 'bg-amber-500'
  if (status === 'downloading' || status === 'merging') return 'bg-[var(--color-bili-blue)]'
  return 'bg-slate-400'
}

export const REPLAY_OUTPUT_UNAVAILABLE_PREFIX = 'Local output is currently unavailable; ownership path retained:'
export const REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX = 'Local output ownership changed; replacement path retained:'

export type ReplayOutputAvailability = 'available' | 'unavailable' | 'ownership_changed' | 'unknown'

/**
 * Completed replay rows deliberately retain their original path when the file
 * disappears or another file takes its place. The backend persists that state
 * in `message`, so the renderer must not treat the retained path as playable.
 */
export function getReplayOutputAvailability(
  message: string | null | undefined,
  outputState?: 'available' | 'unavailable' | 'ownership_changed' | 'unknown' | 'not_applicable',
): ReplayOutputAvailability {
  if (outputState && outputState !== 'not_applicable') return outputState
  if (message?.startsWith(REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX)) return 'ownership_changed'
  if (message?.startsWith(REPLAY_OUTPUT_UNAVAILABLE_PREFIX)) return 'unavailable'
  return 'available'
}

export function getReplayDisplayStatus(
  status: string,
  message: string | null | undefined,
  outputState?: 'available' | 'unavailable' | 'ownership_changed' | 'unknown' | 'not_applicable',
) {
  if (status !== 'completed' && status !== 'done') return status
  const availability = getReplayOutputAvailability(message, outputState)
  return availability === 'available' ? status : availability
}

export function getClipTaskDisplayStatus(task: Pick<ClipTaskRecord, 'status' | 'message' | 'output_state'>) {
  return getReplayDisplayStatus(task.status, task.message, task.output_state)
}

export function getClipTaskOpenablePath(
  task: Pick<ClipTaskRecord, 'status' | 'file_path' | 'part_path' | 'artifact_state' | 'output_state'>,
) {
  if (task.output_state !== 'available') return ''
  if (task.status === 'done') return task.file_path
  if (task.status !== 'error') return ''
  return task.artifact_state === 'published_cleanup'
    ? task.file_path
    : ['built', 'verified'].includes(task.artifact_state) ? task.part_path : ''
}

export function isReplayRelocationPending(replay: Pick<Replay, 'portable_relocation_pending'>) {
  return Boolean(replay.portable_relocation_pending)
}

export const ACTIVE_STATUSES = ['pending', 'downloading', 'merging', 'paused', 'deleting'] as const
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
