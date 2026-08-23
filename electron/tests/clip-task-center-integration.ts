import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { DesktopBackend } from '../src/backend'
import { SqliteStore } from '../src/db'
import { CLIP_TEMP_SENTINEL, CLIP_TEMP_SENTINEL_CONTENT, tryReadFileIdentity } from '../src/utils'

type ClipTaskUpdate = {
  type: 'clip_task_update'
  data: { id: number; status: string; title: string; progress: number; message: string }
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${label}`)
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
    const clipTempRoot = path.resolve(backend.config.download.temp_dir)
    const staleClipTempDir = path.join(clipTempRoot, 'clip-Ab12Z9')
    const preservedTempSibling = path.join(clipTempRoot, 'clip-Ab12Z9-user-data')
    const preservedTempFile = path.join(preservedTempSibling, 'keep.txt')
    fs.mkdirSync(path.join(staleClipTempDir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(staleClipTempDir, 'nested', 'stale.bin'), Buffer.alloc(128, 1))
    fs.writeFileSync(path.join(staleClipTempDir, CLIP_TEMP_SENTINEL), CLIP_TEMP_SENTINEL_CONTENT)
    fs.mkdirSync(preservedTempSibling, { recursive: true })
    fs.writeFileSync(preservedTempFile, 'keep this sibling')
    let reportProgress: ((progress: number, message?: string) => void) | undefined
    let finishClip: ((result: { path: string; message: string }) => Promise<void>) | undefined
    let executionSignal: AbortSignal | undefined
    let executionCount = 0
    ;(backend.clipService as any).executeClip = (
      _url: string, _title: string, _start: number, _end: number,
      _audioQuality: number, _videoQuality: number,
      onProgress: (progress: number, message?: string) => void,
      _prefix: boolean, _suffix: boolean, _mode: string, signal: AbortSignal,
      _qualitySelection: unknown,
      lifecycle: {
        onPublished?: (paths: { outPath: string; partPath: string; sourceRemoved: boolean }) => Promise<void>
      },
    ) => new Promise(resolve => {
      executionCount += 1
      reportProgress = onProgress
      executionSignal = signal
      finishClip = async result => {
        await lifecycle.onPublished?.({ outPath: result.path, partPath: '', sourceRemoved: true })
        resolve(result)
      }
    })

    const baseURL = await backend.listen()
    await backend.waitForStartupReconciliation()
    await waitUntil(
      () => !fs.existsSync(staleClipTempDir),
      'background stale clip temp cleanup',
    )
    assert.equal(
      fs.existsSync(staleClipTempDir),
      false,
      'startup must recursively remove an exact clip-XXXXXX stale temp directory',
    )
    assert.equal(
      fs.readFileSync(preservedTempFile, 'utf8'),
      'keep this sibling',
      'startup temp recovery must preserve non-matching sibling directories and their contents',
    )
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
    const prePublishUpdate = waitForClipTaskUpdate(
      ws,
      update => update.data.id === created.taskId && update.data.message === 'pre-publish',
    )
    reportProgress?.(100, 'pre-publish')
    assert.equal((await prePublishUpdate).data.progress, 99, 'processing must remain below 100 until output is published')

    const cancellingUpdate = waitForClipTaskUpdate(ws, update => update.data.id === created.taskId && update.data.status === 'cancelling')
    const cancelResponse = await fetch(`${baseURL}/api/clip/cancel/${created.taskId}`, { method: 'POST' })
    assert.equal(cancelResponse.status, 200)
    const cancelPayload = await cancelResponse.json() as { ok: boolean; status: string; message: string; task?: { id: number; updated_at: string } }
    assert.deepEqual(
      { ok: cancelPayload.ok, status: cancelPayload.status, message: cancelPayload.message, taskId: cancelPayload.task?.id },
      { ok: true, status: 'cancelling', message: 'Cancelling; waiting for worker cleanup...', taskId: created.taskId },
      'cancel must expose a canonical non-terminal state until the runner finishes cleanup',
    )
    const persistedCancellationStore = await SqliteStore.open(backend.config.database.dsn)
    try {
      const persistedCancellation = persistedCancellationStore.getClipTaskById(created.taskId)
      assert.equal(
        persistedCancellation?.status,
        'cancelling',
        'a successful active-cancel response must durably checkpoint intent before aborting the worker',
      )
    } finally {
      await persistedCancellationStore.close()
    }
    assert.equal(executionSignal?.aborted, true)
    const cancelling = await cancellingUpdate
    assert.equal(cancelling.data.status, 'cancelling')
    assert.equal(cancelling.data.progress, 99)
    assert.equal(backend.clipTaskPromises.has(created.taskId), true)
    const repeatedCancel = await fetch(`${baseURL}/api/clip/cancel/${created.taskId}`, { method: 'POST' })
    assert.equal(repeatedCancel.status, 200, 'repeating cancellation must be idempotent')
    const repeatedPayload = await repeatedCancel.json() as { ok: boolean; status: string; message: string; task?: { id: number } }
    assert.deepEqual(
      { ok: repeatedPayload.ok, status: repeatedPayload.status, message: repeatedPayload.message, taskId: repeatedPayload.task?.id },
      { ok: true, status: 'cancelling', message: 'Cancelling; waiting for worker cleanup...', taskId: created.taskId },
    )

    // A progress callback and successful resolution racing after cancel must not
    // revive the task or attach an output path.
    reportProgress?.(99, 'late progress')
    const lateResultPath = path.join(baseDir, 'late-result.mp4')
    fs.writeFileSync(lateResultPath, Buffer.alloc(1_024, 1))
    const lateExecution = backend.clipTaskPromises.get(created.taskId)
    assert.ok(lateExecution)
    await finishClip?.({ path: lateResultPath, message: 'late success' })
    await lateExecution
    assert.equal(fs.existsSync(lateResultPath), false, 'a cancelled task must remove an output that resolves late')
    const afterLateCallbacks = (await (await fetch(`${baseURL}/api/clip/tasks`)).json()) as Array<{
      id: number; status: string; progress: number; message: string; file_path: string
    }>
    const finalTask = afterLateCallbacks.find(task => task.id === created.taskId)
    assert.deepEqual(finalTask && {
      status: finalTask.status,
      progress: finalTask.progress,
      message: finalTask.message,
      file_path: finalTask.file_path,
    }, { status: 'error', progress: 99, message: 'Cancelled', file_path: '' })
    assert.equal(backend.clipTasksAbort.has(created.taskId), false)
    assert.equal(backend.clipTaskPromises.has(created.taskId), false)

    const cancelCleanupPart = path.join(baseDir, 'cancel-during-cleanup.part.mp4')
    const cancelCleanupFinal = path.join(baseDir, 'cancel-during-cleanup.mp4')
    fs.writeFileSync(cancelCleanupPart, Buffer.alloc(1_024, 5))
    await fs.promises.link(cancelCleanupPart, cancelCleanupFinal)
    ;(backend.clipService as any).executeClip = async (
      _url: string, _title: string, _start: number, _end: number,
      _audioQuality: number, _videoQuality: number, _progress: unknown,
      _prefix: boolean, _suffix: boolean, _mode: string, _signal: AbortSignal,
      _qualitySelection: unknown,
      lifecycle: {
        onPublished?: (paths: { outPath: string; partPath: string; sourceRemoved: boolean; identity?: string }) => Promise<void>
      },
    ) => {
      const identity = tryReadFileIdentity(cancelCleanupFinal)
      await lifecycle.onPublished?.({
        outPath: cancelCleanupFinal,
        partPath: cancelCleanupPart,
        sourceRemoved: false,
        identity,
      })
      return {
        path: cancelCleanupFinal,
        workingPath: cancelCleanupPart,
        message: '',
        identity,
      }
    }
    const originalFsRename = fs.promises.rename.bind(fs.promises)
    let markWorkingCleanupStarted: (() => void) | undefined
    let releaseWorkingCleanup: (() => void) | undefined
    const workingCleanupStarted = new Promise<void>(resolve => { markWorkingCleanupStarted = resolve })
    const workingCleanupGate = new Promise<void>(resolve => { releaseWorkingCleanup = resolve })
    let interceptedWorkingCleanup = false
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (!interceptedWorkingCleanup && path.resolve(String(source)) === path.resolve(cancelCleanupPart)) {
        interceptedWorkingCleanup = true
        markWorkingCleanupStarted?.()
        await workingCleanupGate
      }
      return originalFsRename(source, destination)
    }
    try {
      const cleanupRaceResponse = await fetch(`${baseURL}/api/clip/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'fixture', title: 'cancel-during-cleanup', startTime: 1, endTime: 2 }),
      })
      const cleanupRaceTask = await cleanupRaceResponse.json() as { taskId: number }
      await waitUntil(() => interceptedWorkingCleanup, 'published working-link cleanup to start')
      const cleanupRaceExecution = backend.clipTaskPromises.get(cleanupRaceTask.taskId)
      assert.ok(cleanupRaceExecution)
      assert.equal((await fetch(`${baseURL}/api/clip/cancel/${cleanupRaceTask.taskId}`, { method: 'POST' })).status, 200)
      const cleanupRaceCancelling = backend.db.getClipTasks().find(task => task.id === cleanupRaceTask.taskId)
      assert.equal(cleanupRaceCancelling?.status, 'cancelling')
      assert.notEqual(cleanupRaceCancelling?.message, 'Cancelled', 'cleanup cannot expose its terminal result while the working file is still locked')
      releaseWorkingCleanup?.()
      await cleanupRaceExecution
      const cancelledCleanupTask = backend.db.getClipTasks().find(task => task.id === cleanupRaceTask.taskId)
      assert.equal(cancelledCleanupTask?.status, 'error')
      assert.equal(cancelledCleanupTask?.message, 'Cancelled')
      assert.equal(fs.existsSync(cancelCleanupPart), false)
      assert.equal(fs.existsSync(cancelCleanupFinal), false, 'cancel during working-link cleanup must not be overwritten by done')
    } finally {
      releaseWorkingCleanup?.()
      ;(fs.promises as any).rename = originalFsRename
      releaseWorkingCleanup?.()
    }

    const originalCheckpoint = backend.db.checkpoint.bind(backend.db)
    const terminalFinalPath = path.join(baseDir, 'terminal-checkpoint.mp4')
    let releaseTerminalService: (() => void) | undefined
    const terminalServiceGate = new Promise<void>(resolve => { releaseTerminalService = resolve })
    ;(backend.clipService as any).executeClip = async () => {
      await terminalServiceGate
      fs.writeFileSync(terminalFinalPath, Buffer.alloc(1_024, 6))
      return {
        path: terminalFinalPath,
        message: 'terminal success',
        identity: tryReadFileIdentity(terminalFinalPath),
      }
    }
    let terminalTaskId = 0
    let terminalCheckpointIntercepted = false
    let markTerminalCheckpoint: (() => void) | undefined
    let releaseTerminalCheckpoint: (() => void) | undefined
    const terminalCheckpoint = new Promise<void>(resolve => { markTerminalCheckpoint = resolve })
    const terminalCheckpointGate = new Promise<void>(resolve => { releaseTerminalCheckpoint = resolve })
    ;(backend.db as any).checkpoint = async () => {
      const task = terminalTaskId ? backend!.db.getClipTasks().find(candidate => candidate.id === terminalTaskId) : undefined
      if (!terminalCheckpointIntercepted && task?.status === 'done') {
        terminalCheckpointIntercepted = true
        markTerminalCheckpoint?.()
        await terminalCheckpointGate
      }
      return originalCheckpoint()
    }
    try {
      const terminalResponse = await fetch(`${baseURL}/api/clip/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'fixture', title: 'terminal-checkpoint', startTime: 1, endTime: 2 }),
      })
      terminalTaskId = ((await terminalResponse.json()) as { taskId: number }).taskId
      releaseTerminalService?.()
      await terminalCheckpoint
      assert.equal(backend.clipTasksAbort.has(terminalTaskId), false, 'a synchronously committed terminal task must no longer accept cancellation')
      assert.equal(
        (await fetch(`${baseURL}/api/clip/cancel/${terminalTaskId}`, { method: 'POST' })).status,
        404,
        'cancel must not be acknowledged after terminal state is committed',
      )
      releaseTerminalCheckpoint?.()
      await backend.clipTaskPromises.get(terminalTaskId)
      assert.equal(backend.db.getClipTasks().find(task => task.id === terminalTaskId)?.status, 'done')
      assert.equal(fs.existsSync(terminalFinalPath), true)
    } finally {
      ;(backend.db as any).checkpoint = originalCheckpoint
      releaseTerminalService?.()
      releaseTerminalCheckpoint?.()
    }

    const configuredClipDir = path.join(baseDir, 'persisted-clips')
    const outputDirResponse = await fetch(`${baseURL}/api/clip/output-dir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: configuredClipDir }),
    })
    assert.equal(outputDirResponse.status, 200)

    const verifiedPartPath = path.join(baseDir, 'verified-after-crash.part.mp4')
    const verifiedTargetPath = path.join(baseDir, 'verified-after-crash.mp4')
    fs.writeFileSync(verifiedPartPath, Buffer.alloc(2_048, 6))
    const verifiedIdentity = tryReadFileIdentity(verifiedPartPath)
    assert.ok(verifiedIdentity, 'verified recovery fixture must have a stable file identity')
    const verifiedTaskId = backend.db.createClipTask({
      url: 'fixture-verified', title: 'verified-after-crash', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(verifiedTaskId, {
      status: 'processing', progress: 99, file_path: verifiedTargetPath,
      part_path: verifiedPartPath, artifact_state: 'verified', artifact_identity: verifiedIdentity,
    })

    const publishedPartPath = path.join(baseDir, 'published-after-crash.part.mp4')
    const publishedFinalPath = path.join(baseDir, 'published-after-crash.mp4')
    fs.writeFileSync(publishedPartPath, Buffer.alloc(2_048, 7))
    await fs.promises.link(publishedPartPath, publishedFinalPath)
    const publishedIdentity = tryReadFileIdentity(publishedPartPath)
    assert.ok(publishedIdentity, 'published recovery fixture must have a stable file identity')
    assert.equal(tryReadFileIdentity(publishedFinalPath), publishedIdentity)
    const publishedTaskId = backend.db.createClipTask({
      url: 'fixture-published', title: 'published-after-crash', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(publishedTaskId, {
      status: 'processing', progress: 99, file_path: publishedFinalPath,
      part_path: publishedPartPath, artifact_state: 'published_cleanup', artifact_identity: publishedIdentity,
    })

    const preCheckpointPartPath = path.join(baseDir, 'pre-checkpoint-crash.part.mp4')
    const preCheckpointFinalPath = path.join(baseDir, 'pre-checkpoint-crash.mp4')
    fs.writeFileSync(preCheckpointPartPath, Buffer.alloc(2_048, 8))
    await fs.promises.link(preCheckpointPartPath, preCheckpointFinalPath)
    const preCheckpointIdentity = tryReadFileIdentity(preCheckpointPartPath)
    assert.ok(preCheckpointIdentity, 'verified hardlink fixture must have a stable file identity')
    assert.equal(tryReadFileIdentity(preCheckpointFinalPath), preCheckpointIdentity)
    const preCheckpointTaskId = backend.db.createClipTask({
      url: 'fixture-pre-checkpoint', title: 'pre-checkpoint-crash', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(preCheckpointTaskId, {
      status: 'processing', progress: 99, file_path: preCheckpointFinalPath,
      part_path: preCheckpointPartPath, artifact_state: 'verified', artifact_identity: preCheckpointIdentity,
    })

    const finalOnlyMissingPartPath = path.join(baseDir, 'final-only-after-crash.part.mp4')
    const finalOnlyPath = path.join(baseDir, 'final-only-after-crash.mp4')
    fs.writeFileSync(finalOnlyMissingPartPath, Buffer.alloc(2_048, 9))
    await fs.promises.link(finalOnlyMissingPartPath, finalOnlyPath)
    const finalOnlyIdentity = tryReadFileIdentity(finalOnlyPath)
    const finalOnlyTaskId = backend.db.createClipTask({
      url: 'fixture-final-only', title: 'final-only-after-crash', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(finalOnlyTaskId, {
      status: 'processing', progress: 99, file_path: finalOnlyPath,
      part_path: finalOnlyMissingPartPath, artifact_state: 'verified', artifact_identity: finalOnlyIdentity,
    })
    await fs.promises.rm(finalOnlyMissingPartPath)

    const replacedCleanupPartPath = path.join(baseDir, 'replaced-cleanup.part.mp4')
    const replacedCleanupFinalPath = path.join(baseDir, 'replaced-cleanup.mp4')
    const foreignReplacementPath = path.join(baseDir, 'foreign-replacement.tmp')
    fs.writeFileSync(replacedCleanupPartPath, Buffer.alloc(2_048, 10))
    await fs.promises.link(replacedCleanupPartPath, replacedCleanupFinalPath)
    const replacedCleanupIdentity = tryReadFileIdentity(replacedCleanupPartPath)
    assert.ok(replacedCleanupIdentity, 'cleanup fixture must have a stable owned identity')
    assert.equal(tryReadFileIdentity(replacedCleanupFinalPath), replacedCleanupIdentity)
    fs.writeFileSync(foreignReplacementPath, Buffer.from('foreign final must survive startup recovery'))
    const stagedForeignReplacementIdentity = tryReadFileIdentity(foreignReplacementPath)
    assert.ok(stagedForeignReplacementIdentity)
    assert.notEqual(stagedForeignReplacementIdentity, replacedCleanupIdentity)
    const replacedCleanupTaskId = backend.db.createClipTask({
      url: 'fixture-replaced-cleanup', title: 'replaced-cleanup', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(replacedCleanupTaskId, {
      status: 'error', progress: 99, message: 'Cancelled', file_path: replacedCleanupFinalPath,
      part_path: replacedCleanupPartPath, artifact_state: 'cleanup_pending', artifact_identity: replacedCleanupIdentity,
    })
    const interruptedCancellingTaskId = backend.db.createClipTask({
      url: 'fixture-cancelling', title: 'cancelling-after-crash', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(interruptedCancellingTaskId, {
      status: 'cancelling', progress: 42, message: 'Cancelling; waiting for worker cleanup...',
    })
    await backend.db.checkpoint()
    await fs.promises.rm(replacedCleanupFinalPath)
    await fs.promises.rename(foreignReplacementPath, replacedCleanupFinalPath)
    const foreignReplacementIdentity = tryReadFileIdentity(replacedCleanupFinalPath)
    assert.ok(foreignReplacementIdentity)
    assert.notEqual(foreignReplacementIdentity, replacedCleanupIdentity)

    let shutdownCleanupFinished = false
    let markShutdownPublished: (() => void) | undefined
    const shutdownPublished = new Promise<void>(resolve => { markShutdownPublished = resolve })
    const shutdownPartPath = path.join(baseDir, 'shutdown-published.part.mp4')
    const shutdownFinalPath = path.join(baseDir, 'shutdown-published.mp4')
    ;(backend.clipService as any).executeClip = async (
      _url: string, _title: string, _start: number, _end: number,
      _audioQuality: number, _videoQuality: number, _progress: unknown,
      _prefix: boolean, _suffix: boolean, _mode: string, signal: AbortSignal,
      _qualitySelection: unknown,
      lifecycle: {
        onReserved?: (paths: { outPath: string; partPath: string; identity?: string }) => Promise<void>
        onVerified?: (paths: { outPath: string; partPath: string; identity?: string }) => Promise<void>
        onPublished?: (paths: { outPath: string; partPath: string; sourceRemoved: boolean; identity?: string }) => Promise<void>
      },
    ) => {
      fs.writeFileSync(shutdownPartPath, Buffer.alloc(2_048, 9))
      const identity = tryReadFileIdentity(shutdownPartPath)
      await lifecycle.onReserved?.({ outPath: shutdownFinalPath, partPath: shutdownPartPath, identity })
      await lifecycle.onVerified?.({ outPath: shutdownFinalPath, partPath: shutdownPartPath, identity })
      await fs.promises.link(shutdownPartPath, shutdownFinalPath)
      await lifecycle.onPublished?.({ outPath: shutdownFinalPath, partPath: shutdownPartPath, sourceRemoved: false, identity })
      markShutdownPublished?.()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            shutdownCleanupFinished = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }, 50)
        }, { once: true })
      })
    }
    const shutdownTaskResponse = await fetch(`${baseURL}/api/clip/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'fixture', title: 'shutdown-wait', startTime: 1, endTime: 2 }),
    })
    assert.equal(shutdownTaskResponse.status, 200)
    const shutdownTask = await shutdownTaskResponse.json() as { taskId: number }
    await shutdownPublished

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
    const originalRecoveryRename = fs.promises.rename.bind(fs.promises)
    let observedPublishedCheckpointBeforeCleanup = false
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (
        !observedPublishedCheckpointBeforeCleanup
        && path.resolve(String(source)) === path.resolve(preCheckpointPartPath)
      ) {
        const persistedStore = await SqliteStore.open(backend!.config.database.dsn)
        try {
          const persistedTask = persistedStore.getClipTasks().find(task => task.id === preCheckpointTaskId)
          assert.equal(
            persistedTask?.artifact_state,
            'published_cleanup',
            'verified+hardlink recovery must persist publication ownership before unlinking the part name',
          )
          assert.equal(persistedTask?.file_path, preCheckpointFinalPath)
          assert.equal(persistedTask?.part_path, preCheckpointPartPath)
          assert.equal(persistedTask?.artifact_identity, preCheckpointIdentity)
          observedPublishedCheckpointBeforeCleanup = true
        } finally {
          await persistedStore.close()
        }
      }
      return originalRecoveryRename(source, destination)
    }
    let restartedURL = ''
    try {
      restartedURL = await backend.listen()
      await backend.waitForStartupReconciliation()
    } finally {
      ;(fs.promises as any).rename = originalRecoveryRename
    }
    assert.equal(
      observedPublishedCheckpointBeforeCleanup,
      true,
      'restart recovery must reach the verified+hardlink persisted-before-unlink checkpoint',
    )
    const persistedResponse = await fetch(`${restartedURL}/api/clip/output-dir`)
    assert.deepEqual(await persistedResponse.json(), { path: configuredClipDir })

    const recoveredArtifactTasks = backend.db.getClipTasks()
    const recoveredVerified = recoveredArtifactTasks.find(task => task.id === verifiedTaskId)
    assert.equal(recoveredVerified?.status, 'done')
    assert.equal(recoveredVerified?.file_path, verifiedTargetPath)
    assert.equal(recoveredVerified?.part_path, '')
    assert.equal(recoveredVerified?.artifact_state, '')
    assert.equal(fs.existsSync(verifiedTargetPath), true, 'restart must retry and complete verified publication')
    assert.equal(fs.existsSync(verifiedPartPath), false, 'published working link must be safely cleaned')
    const recoveredPublished = recoveredArtifactTasks.find(task => task.id === publishedTaskId)
    assert.equal(recoveredPublished?.status, 'done')
    assert.equal(recoveredPublished?.file_path, publishedFinalPath)
    assert.equal(recoveredPublished?.part_path, '')
    assert.equal(recoveredPublished?.artifact_state, '')
    assert.equal(fs.existsSync(publishedFinalPath), true)
    assert.equal(fs.existsSync(publishedPartPath), false, 'restart recovery must remove only the matching hardlink name')
    const recoveredPreCheckpoint = recoveredArtifactTasks.find(task => task.id === preCheckpointTaskId)
    assert.equal(recoveredPreCheckpoint?.status, 'done')
    assert.equal(recoveredPreCheckpoint?.file_path, preCheckpointFinalPath)
    assert.equal(recoveredPreCheckpoint?.artifact_state, '')
    assert.equal(recoveredPreCheckpoint?.artifact_identity, preCheckpointIdentity)
    assert.equal(fs.existsSync(preCheckpointFinalPath), true)
    assert.equal(fs.existsSync(preCheckpointPartPath), false, 'a crash between link and published checkpoint must remain recoverable')
    const recoveredFinalOnly = recoveredArtifactTasks.find(task => task.id === finalOnlyTaskId)
    assert.equal(recoveredFinalOnly?.status, 'done')
    assert.equal(recoveredFinalOnly?.file_path, finalOnlyPath)
    assert.equal(recoveredFinalOnly?.part_path, '')
    assert.equal(recoveredFinalOnly?.artifact_state, '')
    assert.equal(recoveredFinalOnly?.artifact_identity, finalOnlyIdentity)
    assert.equal(fs.existsSync(finalOnlyPath), true, 'verified final-only recovery must retain the published output')
    const persistedRecoveryStore = await SqliteStore.open(backend.config.database.dsn)
    try {
      const persistedRecoveredTask = persistedRecoveryStore.getClipTasks().find(task => task.id === preCheckpointTaskId)
      assert.equal(persistedRecoveredTask?.status, 'done')
      assert.equal(persistedRecoveredTask?.file_path, preCheckpointFinalPath)
      assert.equal(persistedRecoveredTask?.part_path, '')
      assert.equal(persistedRecoveredTask?.artifact_state, '')
      assert.equal(persistedRecoveredTask?.artifact_identity, preCheckpointIdentity)
    } finally {
      await persistedRecoveryStore.close()
    }
    const recoveredReplacedCleanup = recoveredArtifactTasks.find(task => task.id === replacedCleanupTaskId)
    assert.equal(recoveredReplacedCleanup?.status, 'error')
    assert.equal(recoveredReplacedCleanup?.file_path, replacedCleanupFinalPath)
    assert.equal(recoveredReplacedCleanup?.part_path, '')
    assert.equal(recoveredReplacedCleanup?.artifact_state, 'cleanup_pending')
    assert.equal(recoveredReplacedCleanup?.artifact_identity, replacedCleanupIdentity)
    assert.equal(fs.existsSync(replacedCleanupPartPath), false, 'startup may delete the identity-matching part name')
    assert.equal(fs.readFileSync(replacedCleanupFinalPath, 'utf8'), 'foreign final must survive startup recovery')
    assert.equal(
      tryReadFileIdentity(replacedCleanupFinalPath),
      foreignReplacementIdentity,
      'startup must preserve a foreign file that replaced the tracked final path',
    )
    const recoveredInterruptedCancelling = recoveredArtifactTasks.find(task => task.id === interruptedCancellingTaskId)
    assert.equal(recoveredInterruptedCancelling?.status, 'error')
    assert.equal(recoveredInterruptedCancelling?.message, 'Cancelled')
    const recoveredShutdown = recoveredArtifactTasks.find(task => task.id === shutdownTask.taskId)
    assert.equal(recoveredShutdown?.status, 'done', 'normal shutdown must preserve an already-published clip')
    assert.equal(recoveredShutdown?.file_path, shutdownFinalPath)
    assert.equal(fs.existsSync(shutdownFinalPath), true)
    assert.equal(fs.existsSync(shutdownPartPath), false)

    const missingOutputTaskId = backend.db.createClipTask({
      url: 'fixture-missing-output', title: 'missing-output', start_time: 1, end_time: 2,
    })
    backend.db.updateClipTask(missingOutputTaskId, {
      status: 'done', progress: 100, file_path: path.join(baseDir, 'does-not-exist.mp4'),
    })
    // The task-list hot path intentionally schedules filesystem reconciliation
    // in the background so a slow or disconnected output drive cannot freeze
    // the task center.  Wait for that asynchronous repair before asserting the
    // durable result.
    await fetch(`${restartedURL}/api/clip/tasks`)
    await waitUntil(
      () => backend.db.getClipTaskById(missingOutputTaskId)?.status === 'error',
      'background missing-output reconciliation',
    )
    const healedTasks = await (await fetch(`${restartedURL}/api/clip/tasks`)).json() as Array<{
      id: number; status: string; progress: number; message: string; file_path: string
    }>
    const healedTask = healedTasks.find(task => task.id === missingOutputTaskId)
    assert.deepEqual(healedTask && {
      status: healedTask.status,
      progress: healedTask.progress,
      message: healedTask.message,
      file_path: healedTask.file_path,
    }, {
      status: 'error',
      progress: 99,
      message: `Output is currently unavailable; ownership path retained: ${path.join(baseDir, 'does-not-exist.mp4')}`,
      file_path: path.join(baseDir, 'does-not-exist.mp4'),
    })

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
