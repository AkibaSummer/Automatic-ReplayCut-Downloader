import assert from 'node:assert/strict'
import { useAppStore } from '../../frontend/src/store'
import type { ClipTaskRecord } from '../../frontend/src/types'

const task = (id: number, status: ClipTaskRecord['status']): ClipTaskRecord => ({
  id,
  created_at: `2026-08-16T00:00:0${id}.000Z`,
  updated_at: `2026-08-16T00:00:0${id}.000Z`,
  url: `https://example.invalid/video/${id}`,
  title: `clip-${id}`,
  start_time: 10,
  end_time: 20,
  file_path: '',
  part_path: '',
  artifact_state: '',
  artifact_identity: '',
  progress: status === 'done' ? 100 : 0,
  status,
  message: '',
})

useAppStore.setState({ clipTasks: [] })

const first = task(1, 'pending')
useAppStore.getState().upsertClipTask(first)
assert.deepEqual(useAppStore.getState().clipTasks, [first], 'a new task should be inserted')

const completed = task(1, 'done')
useAppStore.getState().upsertClipTask(completed)
assert.equal(useAppStore.getState().clipTasks.length, 1, 'an update must not duplicate a task')
assert.equal(useAppStore.getState().clipTasks[0].status, 'done', 'an existing task should be updated')

useAppStore.getState().mergeClipTasks([first])
assert.equal(useAppStore.getState().clipTasks[0].status, 'done', 'a stale list response must not roll a task back')

const newest = task(2, 'processing')
useAppStore.getState().upsertClipTask(newest)
assert.deepEqual(useAppStore.getState().clipTasks.map(item => item.id), [2, 1], 'new tasks should appear first')

const canonicalError = {
  ...completed,
  status: 'error' as const,
  progress: 0,
  file_path: '',
  message: 'Output file is missing or empty',
}
useAppStore.getState().reconcileClipTaskSnapshot([canonicalError], Date.parse('2026-08-16T00:01:00.000Z'))
assert.equal(
  useAppStore.getState().clipTasks[0].status,
  'error',
  'a canonical snapshot must win a same-millisecond done-to-error collision',
)
assert.deepEqual(
  useAppStore.getState().clipTasks.map(item => item.id),
  [1],
  'a complete canonical snapshot must remove old client-only ghost tasks',
)

const requestStartedAt = Date.parse('2026-08-16T00:02:00.000Z')
const concurrentTask = {
  ...task(3, 'pending'),
  created_at: new Date(requestStartedAt + 1).toISOString(),
  updated_at: new Date(requestStartedAt + 1).toISOString(),
}
useAppStore.getState().upsertClipTask(concurrentTask)
useAppStore.getState().reconcileClipTaskSnapshot([canonicalError], requestStartedAt)
assert.equal(
  useAppStore.getState().clipTasks.some(item => item.id === concurrentTask.id),
  true,
  'a task created after snapshot request start must survive an older in-flight response',
)

console.log('clip task store regression test passed')
