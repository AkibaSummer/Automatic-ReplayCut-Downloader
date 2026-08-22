import type { ClipTaskRecord } from '../types'

export const ACTIVE_CLIP_TASK_POLL_MS = 3_000
export const IDLE_CLIP_TASK_POLL_MS = 60_000

type TimerHandle = unknown

type PollScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
}

type ClipTaskPollingOptions = {
  refresh: () => Promise<void>
  getTasks: () => ClipTaskRecord[]
  scheduler?: PollScheduler
  onError?: (error: unknown) => void
}

const defaultScheduler: PollScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function getClipTaskPollInterval(tasks: ClipTaskRecord[]) {
  return tasks.some(task => task.status === 'pending' || task.status === 'processing')
    ? ACTIVE_CLIP_TASK_POLL_MS
    : IDLE_CLIP_TASK_POLL_MS
}

/**
 * Poll the canonical task list without overlapping requests. WebSocket updates
 * remain the fast path; polling guarantees eventual convergence when an event
 * is lost while the socket still appears connected.
 */
export function startClipTaskPolling(options: ClipTaskPollingOptions) {
  const scheduler = options.scheduler ?? defaultScheduler
  let stopped = false
  let timer: TimerHandle | undefined

  const scheduleNext = () => {
    if (stopped) return
    timer = scheduler.setTimeout(() => { void poll() }, getClipTaskPollInterval(options.getTasks()))
  }

  const poll = async () => {
    try {
      await options.refresh()
    } catch (error) {
      if (options.onError) options.onError(error)
      else console.error('Failed to refresh clip task state:', error)
    } finally {
      scheduleNext()
    }
  }

  scheduleNext()
  return () => {
    stopped = true
    if (timer !== undefined) scheduler.clearTimeout(timer)
  }
}

/** App-level WebSocket heartbeat state, kept independent for deterministic tests. */
export class RealtimeHeartbeat {
  private awaitingPong = false

  pulse(sendPing: () => void, closeStaleConnection: () => void) {
    if (this.awaitingPong) {
      this.awaitingPong = false
      closeStaleConnection()
      return false
    }
    this.awaitingPong = true
    sendPing()
    return true
  }

  acknowledge() {
    this.awaitingPong = false
  }

  reset() {
    this.awaitingPong = false
  }
}
