import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { DesktopBackend } from '../src/backend'

type ClipTaskUpdate = {
  type: 'clip_task_update'
  data: { id: number; status: string; title: string; progress: number; message: string }
}

function waitForClipTaskUpdate(ws: WebSocket, predicate: (update: ClipTaskUpdate) => boolean = () => true) {
  return new Promise<ClipTaskUpdate>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('timed out waiting for clip_task_update'))
    }, 5000)

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Partial<ClipTaskUpdate>
      if (message.type !== 'clip_task_update' || !message.data) return
      if (!predicate(message as ClipTaskUpdate)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message as ClipTaskUpdate)
    }

    ws.on('message', onMessage)
  })
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'clip-task-center-'))
  let backend: DesktopBackend | undefined
  let ws: WebSocket | undefined

  try {
    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    backend.config.download.max_concurrent_tasks = 1
    let reportProgress: ((progress: number, message?: string) => void) | undefined
    let finishClip: ((result: { path: string; message: string }) => void) | undefined
    let executionSignal: AbortSignal | undefined
    let executionCount = 0
    ;(backend.clipService as any).executeClip = (
      _url: string, _title: string, _start: number, _end: number,
      _audioQuality: number, _videoQuality: number,
      onProgress: (progress: number, message?: string) => void,
      _prefix: boolean, _suffix: boolean, _mode: string, signal: AbortSignal,
    ) => new Promise(resolve => {
      executionCount += 1
      reportProgress = onProgress
      executionSignal = signal
      finishClip = resolve
    })

    const baseURL = await backend.listen()
    ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws`)
    await once(ws, 'open')

    const localAudioResponse = await fetch(`${baseURL}/api/clip/audio-proxy?url=${encodeURIComponent('http://127.0.0.1/private')}`)
    assert.equal(localAudioResponse.status, 400, 'audio proxy must reject local-network SSRF targets')
    const fileAudioResponse = await fetch(`${baseURL}/api/clip/audio-proxy?url=${encodeURIComponent('file:///etc/passwd')}`)
    assert.equal(fileAudioResponse.status, 400, 'audio proxy must reject non-HTTP protocols')

    const updatePromise = waitForClipTaskUpdate(ws)
    const createResponse = await fetch(`${baseURL}/api/clip/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.invalid/video',
        title: 'task-center-regression',
        startTime: 10,
        endTime: 20,
        clipMode: 'smart',
      }),
    })
    assert.equal(createResponse.status, 200)
    const created = await createResponse.json() as { taskId: number; status: string }

    const update = await updatePromise
    assert.equal(update.data.id, created.taskId)
    assert.equal(update.data.status, 'pending')
    assert.equal(update.data.title, 'task-center-regression')

    const listResponse = await fetch(`${baseURL}/api/clip/tasks`)
    assert.equal(listResponse.headers.get('cache-control'), 'no-store')
    const tasks = await listResponse.json() as Array<{ id: number; status: string }>
    assert.equal(tasks.some(task => task.id === created.taskId && task.status === 'processing'), true)

    const secondPending = waitForClipTaskUpdate(ws, update => update.data.title === 'queued-regression' && update.data.status === 'pending')
    const secondResponse = await fetch(`${baseURL}/api/clip/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'fixture-2', title: 'queued-regression', startTime: 1, endTime: 2 }),
    })
    const second = await secondResponse.json() as { taskId: number }
    await secondPending
    assert.equal(executionCount, 1, 'the second FFmpeg task must remain queued at the concurrency limit')
    const cancelQueued = await fetch(`${baseURL}/api/clip/cancel/${second.taskId}`, { method: 'POST' })
    assert.equal(cancelQueued.status, 200)
    assert.equal(executionCount, 1, 'cancelling a queued task must not start it')

    const processingUpdate = waitForClipTaskUpdate(ws, update => update.data.id === created.taskId && update.data.status === 'processing')
    reportProgress?.(42, 'working')
    assert.equal((await processingUpdate).data.progress, 42)

    const cancelledUpdate = waitForClipTaskUpdate(ws, update => update.data.id === created.taskId && update.data.message === 'Cancelled')
    const cancelResponse = await fetch(`${baseURL}/api/clip/cancel/${created.taskId}`, { method: 'POST' })
    assert.equal(cancelResponse.status, 200)
    assert.deepEqual(await cancelResponse.json(), { ok: true, status: 'error', message: 'Cancelled' })
    assert.equal(executionSignal?.aborted, true)
    const cancelled = await cancelledUpdate
    assert.equal(cancelled.data.status, 'error')
    assert.equal(cancelled.data.progress, 42)
    const repeatedCancel = await fetch(`${baseURL}/api/clip/cancel/${created.taskId}`, { method: 'POST' })
    assert.equal(repeatedCancel.status, 200, 'repeating cancellation must be idempotent')
    assert.deepEqual(await repeatedCancel.json(), { ok: true, status: 'error', message: 'Cancelled' })

    // A progress callback and successful resolution racing after cancel must not
    // revive the task or attach an output path.
    reportProgress?.(99, 'late progress')
    finishClip?.({ path: 'late-result.mp4', message: 'late success' })
    await new Promise(resolve => setImmediate(resolve))
    const afterLateCallbacks = (await (await fetch(`${baseURL}/api/clip/tasks`)).json()) as Array<{
      id: number; status: string; progress: number; message: string; file_path: string
    }>
    const finalTask = afterLateCallbacks.find(task => task.id === created.taskId)
    assert.deepEqual(finalTask && {
      status: finalTask.status,
      progress: finalTask.progress,
      message: finalTask.message,
      file_path: finalTask.file_path,
    }, { status: 'error', progress: 42, message: 'Cancelled', file_path: '' })
    assert.equal(backend.clipTasksAbort.has(created.taskId), false)
    assert.equal(backend.clipTaskPromises.has(created.taskId), false)

    const configuredClipDir = path.join(baseDir, 'persisted-clips')
    const outputDirResponse = await fetch(`${baseURL}/api/clip/output-dir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: configuredClipDir }),
    })
    assert.equal(outputDirResponse.status, 200)

    let shutdownCleanupFinished = false
    ;(backend.clipService as any).executeClip = (
      _url: string, _title: string, _start: number, _end: number,
      _audioQuality: number, _videoQuality: number, _progress: unknown,
      _prefix: boolean, _suffix: boolean, _mode: string, signal: AbortSignal,
    ) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          shutdownCleanupFinished = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, 50)
      }, { once: true })
    })
    const shutdownTaskResponse = await fetch(`${baseURL}/api/clip/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'fixture', title: 'shutdown-wait', startTime: 1, endTime: 2 }),
    })
    assert.equal(shutdownTaskResponse.status, 200)

    const closed = once(ws, 'close')
    ws.close()
    await closed
    ws = undefined
    const stopStartedAt = Date.now()
    await backend.stop()
    assert.equal(shutdownCleanupFinished, true, 'backend stop must wait for clip cleanup')
    assert.ok(Date.now() - stopStartedAt >= 40, 'backend stop returned before the clip promise settled')
    assert.equal(backend.clipTaskPromises.size, 0)
    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    const restartedURL = await backend.listen()
    const persistedResponse = await fetch(`${restartedURL}/api/clip/output-dir`)
    assert.deepEqual(await persistedResponse.json(), { path: configuredClipDir })

    const missingOutputTaskId = backend.db.createClipTask({
      url: 'fixture-missing-output', title: 'missing-output', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(missingOutputTaskId, {
      status: 'done', progress: 100, file_path: path.join(baseDir, 'does-not-exist.mp4'),
    })
    const healedTasks = await (await fetch(`${restartedURL}/api/clip/tasks`)).json() as Array<{
      id: number; status: string; progress: number; message: string; file_path: string
    }>
    const healedTask = healedTasks.find(task => task.id === missingOutputTaskId)
    assert.deepEqual(healedTask && {
      status: healedTask.status,
      progress: healedTask.progress,
      message: healedTask.message,
      file_path: healedTask.file_path,
    }, { status: 'error', progress: 0, message: 'Output file is missing', file_path: '' })

    console.log('clip task lifecycle and output-dir persistence integration test passed')
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, 'close')
      ws.close()
      await closed
    }
    if (backend) await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
