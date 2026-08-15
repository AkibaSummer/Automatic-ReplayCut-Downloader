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

console.log('clip task store regression test passed')
