import assert from 'node:assert/strict'

import type { ClipTaskRecord } from '../src/types'
import {
  ACTIVE_CLIP_TASK_POLL_MS,
  IDLE_CLIP_TASK_POLL_MS,
  RealtimeHeartbeat,
  startClipTaskPolling,
} from '../src/utils/taskStateSync'

const makeTask = (status: ClipTaskRecord['status']): ClipTaskRecord => ({
  id: 1,
  created_at: '2026-08-18T00:00:00.000Z',
  updated_at: '2026-08-18T00:00:00.000Z',
  url: 'fixture',
  title: 'missed-websocket-event',
  start_time: 0,
  end_time: 10,
  file_path: status === 'done' ? 'clip.mp4' : '',
  progress: status === 'done' ? 100 : 25,
  status,
  message: '',
})

type Scheduled = { handle: number; callback: () => void; delayMs: number }
let scheduled: Scheduled | undefined
const cleared: number[] = []
let nextHandle = 1
const scheduler = {
  setTimeout(callback: () => void, delayMs: number) {
    const handle = nextHandle++
    scheduled = { handle, callback, delayMs }
    return handle
  },
  clearTimeout(handle: unknown) {
    cleared.push(Number(handle))
  },
}

let tasks = [makeTask('processing')]
let refreshCount = 0
const stopPolling = startClipTaskPolling({
  scheduler,
  getTasks: () => tasks,
  refresh: async () => {
    refreshCount += 1
    // The WebSocket completion event was deliberately not delivered. This is
    // the canonical GET result observed by the scheduled reconciliation poll.
    tasks = [makeTask('done')]
  },
})

assert.equal(scheduled?.delayMs, ACTIVE_CLIP_TASK_POLL_MS, 'active clips must use the fast reconciliation interval')
const activePoll = scheduled
scheduled = undefined
activePoll?.callback()
await new Promise(resolve => setImmediate(resolve))
assert.equal(refreshCount, 1, 'a missed WebSocket update must trigger a canonical refresh without reconnecting')
assert.equal(tasks[0].status, 'done')
assert.equal(scheduled?.delayMs, IDLE_CLIP_TASK_POLL_MS, 'polling should back off once the canonical state is terminal')

const finalTimer = scheduled
stopPolling()
assert.deepEqual(cleared, [finalTimer?.handle], 'disposing the controller must cancel the pending reconciliation poll')

const heartbeat = new RealtimeHeartbeat()
let pingCount = 0
let closeCount = 0
let wsOnline = true
let reconnectScheduled = false
assert.equal(heartbeat.pulse(() => { pingCount += 1 }, () => { closeCount += 1 }), true)
assert.equal(heartbeat.pulse(
  () => { pingCount += 1 },
  () => {
    closeCount += 1
    wsOnline = false
    reconnectScheduled = true
  },
), false)
assert.deepEqual(
  { pingCount, closeCount, wsOnline, reconnectScheduled },
  { pingCount: 1, closeCount: 1, wsOnline: false, reconnectScheduled: true },
  'a socket that misses pong must be closed so the owner can mark it offline and reconnect',
)

heartbeat.reset()
heartbeat.pulse(() => { pingCount += 1 }, () => { closeCount += 1 })
heartbeat.acknowledge()
heartbeat.pulse(() => { pingCount += 1 }, () => { closeCount += 1 })
assert.deepEqual(
  { pingCount, closeCount },
  { pingCount: 3, closeCount: 1 },
  'a received pong must keep the connection healthy for the next heartbeat',
)

console.log('clip task polling and websocket heartbeat regression test passed')
