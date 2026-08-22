import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'
import { useAppStore } from '../../frontend/src/store'
import type { ClipTaskRecord } from '../../frontend/src/types'
import { ACTIVE_CLIP_TASK_POLL_MS, startClipTaskPolling } from '../../frontend/src/utils/taskStateSync'

type Scheduled = { callback: () => void; delayMs: number; handle: number }

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'clip-state-reconciliation-'))
  let backend: DesktopBackend | undefined
  let stopPolling: (() => void) | undefined

  try {
    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    backend.config.download.max_concurrent_tasks = 1

    let finishClip!: (result: { path: string; message: string }) => void
    ;(backend.clipService as any).executeClip = () => new Promise(resolve => {
      finishClip = resolve
    })

    const baseURL = await backend.listen()
    const createdResponse = await fetch(`${baseURL}/api/clip/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'fixture', title: 'missed-ws', startTime: 1, endTime: 2 }),
    })
    assert.equal(createdResponse.status, 200)
    const created = await createdResponse.json() as { taskId: number }

    const initialRequestAt = Date.now()
    const initialTasks = await (await fetch(`${baseURL}/api/clip/tasks`)).json() as ClipTaskRecord[]
    useAppStore.setState({ clipTasks: [] })
    useAppStore.getState().reconcileClipTaskSnapshot(initialTasks, initialRequestAt)
    assert.equal(useAppStore.getState().clipTasks[0]?.status, 'processing')

    let scheduled: Scheduled | undefined
    let nextHandle = 1
    const completedRefreshes: Array<() => void> = []
    stopPolling = startClipTaskPolling({
      scheduler: {
        setTimeout(callback, delayMs) {
          const handle = nextHandle++
          scheduled = { callback, delayMs, handle }
          return handle
        },
        clearTimeout() {},
      },
      getTasks: () => useAppStore.getState().clipTasks,
      refresh: async () => {
        const requestStartedAt = Date.now()
        const tasks = await (await fetch(`${baseURL}/api/clip/tasks`)).json() as ClipTaskRecord[]
        useAppStore.getState().reconcileClipTaskSnapshot(tasks, requestStartedAt)
        completedRefreshes.shift()?.()
      },
    })
    assert.equal(scheduled?.delayMs, ACTIVE_CLIP_TASK_POLL_MS)

    const outputPath = path.join(baseDir, 'completed-clip.mp4')
    await writeFile(outputPath, 'valid clip fixture')
    finishClip({ path: outputPath, message: 'complete' })
    await waitFor(() => backend!.clipTaskPromises.size === 0, 'clip task did not finish')
    assert.equal(
      useAppStore.getState().clipTasks[0]?.status,
      'processing',
      'fixture must model a lost WS completion while the socket stays connected',
    )

    const ghost = {
      ...useAppStore.getState().clipTasks[0],
      id: 999,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      title: 'client-only ghost',
    } as ClipTaskRecord
    useAppStore.getState().upsertClipTask(ghost)

    const firstRefresh = new Promise<void>(resolve => completedRefreshes.push(resolve))
    scheduled?.callback()
    await firstRefresh
    await new Promise(resolve => setImmediate(resolve))
    const reconciledDone = useAppStore.getState().clipTasks
    assert.equal(reconciledDone.find(task => task.id === created.taskId)?.status, 'done')
    assert.equal(reconciledDone.some(task => task.id === ghost.id), false, 'canonical GET must delete old ghost tasks')

    await unlink(outputPath)
    const secondRefresh = new Promise<void>(resolve => completedRefreshes.push(resolve))
    scheduled?.callback()
    await secondRefresh
    const healed = useAppStore.getState().clipTasks.find(task => task.id === created.taskId)
    assert.deepEqual(
      healed && { status: healed.status, progress: healed.progress, file_path: healed.file_path, message: healed.message },
      { status: 'error', progress: 0, file_path: '', message: 'Output file is missing or empty' },
      'opening/polling the task center must reconcile a deleted output to the actual server state',
    )

    const monotonicTaskId = backend.db.createClipTask({
      url: 'fixture-monotonic', title: 'timestamp-order', start_time: 0, end_time: 1,
    })
    backend.db.updateClipTask(monotonicTaskId, { status: 'done', progress: 100, file_path: 'first.mp4' })
    const doneTimestamp = backend.db.getClipTasks().find(task => task.id === monotonicTaskId)?.updated_at || ''
    backend.db.updateClipTask(monotonicTaskId, { status: 'error', progress: 0, file_path: '' })
    const errorTimestamp = backend.db.getClipTasks().find(task => task.id === monotonicTaskId)?.updated_at || ''
    assert.ok(
      Date.parse(errorTimestamp) > Date.parse(doneTimestamp),
      'successive clip status mutations must have a strictly monotonic protocol timestamp',
    )

    console.log('clip task canonical state reconciliation integration test passed')
  } finally {
    stopPolling?.()
    useAppStore.setState({ clipTasks: [] })
    if (backend) await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
