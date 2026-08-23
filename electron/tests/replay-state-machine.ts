import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'
import { tryReadFileIdentity } from '../src/utils'

type Harness = { baseDir: string; backend: DesktopBackend }

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function createHarness(prefix: string): Promise<Harness> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), prefix))
  const backend = await DesktopBackend.create(baseDir)
  backend.config.server.port = 0
  backend.config.download.max_concurrent_tasks = 1
  backend.config.download.concurrent_segments = 1
  return { baseDir, backend }
}

async function destroyHarness(harness: Harness) {
  await harness.backend.stop()
  await rm(harness.baseDir, { recursive: true, force: true })
}

function insertReplay(backend: DesktopBackend, liveKey: string, status = 'not_downloaded') {
  backend.db.insertReplay({
    replay_id: Math.floor(Math.random() * 1_000_000) + 1,
    live_key: liveKey,
    room_id: 1,
    title: liveKey,
    start_time: 1_700_000_000,
    end_time: 1_700_000_060,
    duration: 60,
    status,
  })
}

async function testImmediatePauseResume() {
  const harness = await createHarness('replay-immediate-resume-')
  try {
    const { backend } = harness
    insertReplay(backend, 'immediate')

    let calls = 0
    let markFirstStarted: (() => void) | undefined
    let markSecondStarted: (() => void) | undefined
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve })
    ;(backend.downloaderService as any).processReplayTask = (
      _liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>((_resolve, reject) => {
      calls += 1
      if (calls === 1) markFirstStarted?.()
      if (calls === 2) markSecondStarted?.()
      signal.addEventListener('abort', () => {
        setImmediate(() => reject(abortError()))
      }, { once: true })
    })

    assert.equal(backend.enqueueReplay('immediate', { resetProgress: true }), true)
    await withTimeout(firstStarted, 'first replay execution')
    assert.equal(backend.pauseReplay('immediate'), true)
    assert.equal(backend.resumeReplay('immediate'), true, 'resume must queue while the aborted generation winds down')
    assert.equal(backend.db.getReplayByLiveKey(harness.baseDir, 'immediate')?.status, 'pending')
    await withTimeout(secondStarted, 'replacement replay execution')
    assert.equal(calls, 2)

    const replacement = backend.activeTasks.get('immediate')
    assert.ok(replacement)
    assert.equal(backend.pauseReplay('immediate'), true)
    await withTimeout(replacement!.promise, 'replacement cancellation')
    assert.equal(backend.db.getReplayByLiveKey(harness.baseDir, 'immediate')?.status, 'paused')
    assert.equal(backend.activeTasks.size, 0)
    assert.equal(backend.runningTasks, 0)
  } finally {
    await destroyHarness(harness)
  }
}

async function testLateCacheCannotOverwritePause() {
  const harness = await createHarness('replay-late-cache-')
  try {
    const { backend } = harness
    insertReplay(backend, 'late-cache')
    let releaseCache: (() => void) | undefined
    let markCacheStarted: (() => void) | undefined
    const cacheStarted = new Promise<void>(resolve => { markCacheStarted = resolve })
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = () => new Promise<void>(resolve => {
      markCacheStarted?.()
      releaseCache = resolve
    })

    assert.equal(backend.enqueueReplay('late-cache'), true)
    await withTimeout(cacheStarted, 'cache request')
    const execution = backend.activeTasks.get('late-cache')
    assert.ok(execution)
    assert.equal(backend.pauseReplay('late-cache'), true)
    releaseCache?.()
    await withTimeout(execution!.promise, 'late cache callback')

    const replay = backend.db.getReplayByLiveKey(harness.baseDir, 'late-cache')
    assert.equal(replay?.status, 'paused')
    assert.equal(replay?.message, 'Paused')
    assert.equal(backend.activeTasks.size, 0)
  } finally {
    await destroyHarness(harness)
  }
}

async function testRuntimePauseTracksOnlyItsOwnTasks() {
  const harness = await createHarness('replay-global-pause-')
  try {
    const { backend } = harness
    insertReplay(backend, 'manual-paused', 'paused')
    insertReplay(backend, 'runtime-paused', 'pending')

    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    ;(backend.downloaderService as any).processReplayTask = (
      _liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>((_resolve, reject) => {
      markStarted?.()
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })

    assert.equal(backend.pauseAll(), 1)
    assert.deepEqual([...backend.runtimePausedTasks], ['runtime-paused'])
    backend.cachingReplays.add('runtime-paused')
    assert.equal(backend.resumeAll(), 0)
    assert.deepEqual([...backend.runtimePausedTasks], ['runtime-paused'], 'blocked resume must retain its automatic-resume marker')
    backend.cachingReplays.delete('runtime-paused')
    assert.equal(backend.resumeAll(), 1)
    await withTimeout(started, 'runtime-resumed execution')
    assert.equal(backend.db.getReplayByLiveKey(harness.baseDir, 'manual-paused')?.status, 'paused')
    assert.equal(backend.db.getReplayByLiveKey(harness.baseDir, 'runtime-paused')?.status, 'pending')
    assert.equal(backend.runtimePausedTasks.size, 0)

    const execution = backend.activeTasks.get('runtime-paused')
    assert.ok(execution)
    assert.equal(backend.pauseReplay('runtime-paused'), true)
    await withTimeout(execution!.promise, 'runtime-resumed cancellation')
  } finally {
    await destroyHarness(harness)
  }
}

async function testCleanupStaleWaitsForRuntime() {
  const harness = await createHarness('replay-cleanup-stale-')
  try {
    const { backend } = harness
    insertReplay(backend, 'cleanup')
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let cleanupFinished = false
    ;(backend.downloaderService as any).processReplayTask = (
      _liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>((_resolve, reject) => {
      markStarted?.()
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          cleanupFinished = true
          reject(abortError())
        }, 40)
      }, { once: true })
    })

    backend.enqueueReplay('cleanup')
    await withTimeout(started, 'cleanup execution')
    const startedAt = Date.now()
    assert.equal(await backend.cleanupStaleReplayTasks(), 1)
    assert.equal(cleanupFinished, true)
    assert.ok(Date.now() - startedAt >= 30, 'cleanup-stale returned before the active generation settled')
    assert.equal(backend.activeTasks.size, 0)
    assert.equal(backend.db.getReplayByLiveKey(harness.baseDir, 'cleanup')?.status, 'paused')
  } finally {
    await destroyHarness(harness)
  }
}

async function testReplayOutputReservationAndMissingSegments() {
  const harness = await createHarness('replay-output-reservation-')
  try {
    const service = harness.backend.downloaderService as any
    const outputDir = harness.backend.config.download.output_dir
    const desired = path.join(outputDir, 'same.mp4')
    const first = service.reserveOutputPaths(desired) as { finalPath: string; partPath: string }
    const second = service.reserveOutputPaths(desired) as { finalPath: string; partPath: string }
    assert.equal(first.finalPath, desired)
    assert.equal(first.partPath, path.join(outputDir, 'same.part.mp4'))
    assert.equal(second.finalPath, path.join(outputDir, 'same (1).mp4'))
    assert.equal(second.partPath, path.join(outputDir, 'same (1).part.mp4'))
    fs.rmSync(first.partPath, { force: true })
    fs.rmSync(second.partPath, { force: true })

    fs.writeFileSync(path.join(outputDir, 'same.part.mp4'), 'occupied part')
    fs.writeFileSync(path.join(outputDir, 'same (1).mp4'), 'completed suffix')
    const third = service.reserveOutputPaths(desired) as { finalPath: string; partPath: string }
    assert.equal(third.finalPath, path.join(outputDir, 'same (2).mp4'))
    assert.equal(third.partPath, path.join(outputDir, 'same (2).part.mp4'))
    assert.equal(fs.readFileSync(path.join(outputDir, 'same (1).mp4'), 'utf8'), 'completed suffix')
    fs.rmSync(path.join(outputDir, 'same.part.mp4'), { force: true })
    fs.rmSync(path.join(outputDir, 'same (1).mp4'), { force: true })
    fs.rmSync(third.partPath, { force: true })

    const missing = path.join(harness.baseDir, 'missing-segment.ts')
    const output = path.join(outputDir, 'must-not-complete.mp4')
    await assert.rejects(
      service.runFfmpegMerge('missing', [missing], output, 10, new AbortController().signal),
      /Replay segment is missing/,
    )
    assert.equal(fs.existsSync(output), false)
    assert.equal(fs.existsSync(`${output}.ts.tmp`), false)
  } finally {
    await destroyHarness(harness)
  }
}

async function testRejectedPortableResumePreservesPauseBarriers() {
  const harness = await createHarness('replay-portable-resume-rollback-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'portable-paused', 'paused')
    assert.equal(backend.db.setReplayPortableRelocationPending('portable-paused', true), true)
    backend.pausedTasks.add('portable-paused')
    backend.runtimePausedTasks.add('portable-paused')

    assert.equal(backend.resumeReplay('portable-paused'), false)
    assert.equal(backend.db.getReplaySummaryByLiveKey(baseDir, 'portable-paused')?.status, 'paused')
    assert.equal(backend.pausedTasks.has('portable-paused'), true, 'failed resume must retain the scheduler pause barrier')
    assert.equal(backend.runtimePausedTasks.has('portable-paused'), true, 'failed resume must retain runtime-pause ownership')
    assert.equal(backend.queue.includes('portable-paused'), false)
  } finally {
    await destroyHarness(harness)
  }
}

function cleanupQuarantinePath(filePath: string, identity: string) {
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.arc-delete-${identityHash}`)
}

async function testReplayAndClipShareGlobalConcurrencyLimit() {
  const harness = await createHarness('shared-task-concurrency-')
  try {
    const { backend } = harness
    insertReplay(backend, 'replay-blocker')

    let markReplayStarted: (() => void) | undefined
    const replayStarted = new Promise<void>(resolve => { markReplayStarted = resolve })
    ;(backend.downloaderService as any).processReplayTask = (
      _liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>((_resolve, reject) => {
      markReplayStarted?.()
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })

    assert.equal(backend.enqueueReplay('replay-blocker'), true)
    await withTimeout(replayStarted, 'replay concurrency blocker')

    const clipTaskId = backend.db.createClipTask({
      url: 'fixture', title: 'shared-budget-clip', start_time: 0, end_time: 1,
    })
    let markClipStarted: (() => void) | undefined
    const clipStarted = new Promise<void>(resolve => { markClipStarted = resolve })
    assert.equal(backend.enqueueClipTask(clipTaskId, async () => {
      markClipStarted?.()
      backend.db.updateClipTask(clipTaskId, { status: 'done', progress: 100 })
    }), true)

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(
      backend.clipTasksAbort.has(clipTaskId),
      false,
      'a clip must wait while a replay occupies the global concurrency slot',
    )

    const replayExecution = backend.activeTasks.get('replay-blocker')
    assert.ok(replayExecution)
    assert.equal(backend.pauseReplay('replay-blocker'), true)
    await withTimeout(replayExecution!.promise, 'release replay concurrency slot')
    await withTimeout(clipStarted, 'clip scheduled after replay slot release')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(backend.db.getClipTasks().find(task => task.id === clipTaskId)?.status, 'done')
  } finally {
    await destroyHarness(harness)
  }
}

async function testMultiStreamProgressNeverRegresses() {
  const harness = await createHarness('replay-multi-stream-progress-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'multi-stream', 'downloading')
    const replay = backend.db.getReplayByLiveKey(baseDir, 'multi-stream')!
    replay.streams = [
      { id: 1, replay_id: replay.replay_id, start_time: 0, end_time: 20, stream: 'stream-1', type: 0, m3u8_text: '' },
      { id: 2, replay_id: replay.replay_id, start_time: 20, end_time: 40, stream: 'stream-2', type: 0, m3u8_text: '' },
    ]

    const service = backend.downloaderService as any
    const events: string[] = []
    service.parseM3U8 = async (streamUrl: string) => {
      events.push(`parse:${streamUrl}`)
      return [
        { url: `${streamUrl}/1.ts`, duration: 10 },
        { url: `${streamUrl}/2.ts`, duration: 10 },
      ]
    }
    service.downloadSegment = async (url: string, targetPath: string) => {
      events.push(`download:${url}`)
      fs.writeFileSync(targetPath, Buffer.alloc(16, 1))
      return 16
    }
    service.runFfmpegMerge = async (_liveKey: string, _segments: string[], outputPath: string) => {
      fs.writeFileSync(outputPath, Buffer.alloc(64, 2))
    }

    const progressValues: number[] = []
    const originalPatch = backend.db.patchReplayIfStatus.bind(backend.db)
    ;(backend.db as any).patchReplayIfStatus = (liveKey: string, statuses: readonly string[], patch: { progress?: number }) => {
      if (typeof patch.progress === 'number') progressValues.push(patch.progress)
      return originalPatch(liveKey, statuses, patch)
    }

    const output = await service.downloadReplayWithContext(
      replay,
      new AbortController().signal,
      () => true,
    ) as { finalPath: string; partPath: string }

    assert.ok(
      events.indexOf('parse:stream-2') < events.indexOf('download:stream-1/1.ts'),
      'all playlists must be parsed before the first segment download',
    )
    assert.deepEqual(
      progressValues,
      [25, 98, 99],
      'fast segment completions should be coalesced instead of flooding persistence and WebSocket updates',
    )
    assert.equal(
      progressValues.every((value, index) => index === 0 || value >= progressValues[index - 1]),
      true,
      `replay progress regressed: ${progressValues.join(', ')}`,
    )
    fs.rmSync(output.partPath, { force: true })
    fs.rmSync(output.finalPath, { force: true })
  } finally {
    await destroyHarness(harness)
  }
}

async function testAtomicReplayCompletion() {
  const harness = await createHarness('replay-atomic-completion-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'atomic', 'pending')
    const replay = backend.db.getReplayByLiveKey(baseDir, 'atomic')!
    const now = new Date().toISOString()
    backend.db.prepare(
      `INSERT INTO stream_slices
       (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, now, replay.replay_id, replay.start_time, replay.end_time, 'fixture', 0, '#EXTM3U')
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async () => {}

    let finalPath = ''
    let partPath = ''
    const service = backend.downloaderService as any
    service.downloadReplayWithContext = async () => {
      const reserved = service.reserveOutputPaths(path.join(backend.config.download.output_dir, 'atomic.mp4'))
      finalPath = reserved.finalPath
      partPath = reserved.partPath
      fs.writeFileSync(partPath, Buffer.alloc(1024, 7))
      assert.equal(backend.db.patchReplayIfStatus('atomic', ['downloading'], {
        status: 'merging', progress: 99, message: 'fixture merge',
      }), true)
      return { ...reserved, partIdentity: tryReadFileIdentity(partPath) }
    }
    service.verifyDuration = async () => ({ ok: true, duration: 60 })
    service.getFileInfo = async () => ({ size: 1024, resolution: '1x1', bitrate: '1 Mbps' })

    await service.processReplayTask('atomic', new AbortController().signal, baseDir)
    assert.match(partPath, /\.part\.mp4$/)
    assert.equal(fs.existsSync(partPath), false)
    assert.equal(fs.existsSync(finalPath), true)
    assert.equal(fs.statSync(finalPath).size, 1024)
    const completed = backend.db.getReplayByLiveKey(baseDir, 'atomic')
    assert.equal(completed?.status, 'completed')
    assert.equal(completed?.file_path, finalPath)
    assert.equal(completed?.streams.length, 0, 'completed downloads must release their M3U8 cache')
  } finally {
    await destroyHarness(harness)
  }
}

async function testCompletedPartRecoverySkipsDownload() {
  const harness = await createHarness('replay-completed-part-recovery-')
  try {
    const { backend, baseDir } = harness
    backend.config.download.filename_template = '{live_key}.mp4'
    insertReplay(backend, 'recoverable', 'failed')
    fs.mkdirSync(backend.config.download.output_dir, { recursive: true })
    const partPath = path.join(backend.config.download.output_dir, 'recoverable.part.mp4')
    const finalPath = path.join(backend.config.download.output_dir, 'recoverable.mp4')
    fs.writeFileSync(partPath, Buffer.alloc(2_048, 6))
    const staleAt = new Date(Date.now() - 60_000)
    fs.utimesSync(partPath, staleAt, staleAt)
    backend.db.patchReplay('recoverable', {
      recoverable_part_path: partPath,
      output_identity: tryReadFileIdentity(partPath),
    })

    const service = backend.downloaderService as any
    service.verifyDuration = async () => ({ ok: true, duration: 60 })
    service.getFileInfo = async () => ({ size: 2_048, resolution: '1x1', bitrate: '1 Mbps' })
    service.downloadReplayWithContext = async () => {
      throw new Error('a verified completed part must not be downloaded again')
    }
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async () => {
      throw new Error('M3U8 must not be fetched when a completed part is recoverable')
    }

    assert.equal(backend.enqueueReplay('recoverable', { resetProgress: true }), true)
    const execution = backend.activeTasks.get('recoverable')
    assert.ok(execution)
    await withTimeout(execution.promise, 'completed part recovery', 5_000)
    assert.equal(fs.existsSync(partPath), false)
    assert.equal(fs.existsSync(finalPath), true)
    assert.equal(fs.statSync(finalPath).size, 2_048)
    const completed = backend.db.getReplaySummaryByLiveKey(baseDir, 'recoverable')
    assert.equal(completed?.status, 'completed')
    assert.equal(completed?.file_path, finalPath)
    assert.equal(completed?.recoverable_part_path, '')
    assert.equal(completed?.progress, 100)
    assert.match(completed?.message || '', /without downloading again/)
  } finally {
    await destroyHarness(harness)
  }
}

async function testPublishedRecoveryIgnoresForeignPartAndCleansQuarantine() {
  const harness = await createHarness('replay-published-quarantine-recovery-')
  try {
    const { backend, baseDir } = harness
    backend.config.download.filename_template = '{live_key}.mp4'
    insertReplay(backend, 'published-quarantine', 'failed')
    fs.mkdirSync(backend.config.download.output_dir, { recursive: true })
    const partPath = path.join(backend.config.download.output_dir, 'published-quarantine.part.mp4')
    const finalPath = path.join(backend.config.download.output_dir, 'published-quarantine.mp4')
    const ownedContents = Buffer.alloc(2_048, 0x5a)
    fs.writeFileSync(partPath, ownedContents)
    const staleAt = new Date(Date.now() - 60_000)
    fs.utimesSync(partPath, staleAt, staleAt)
    const outputIdentity = tryReadFileIdentity(partPath)
    assert.ok(outputIdentity)
    fs.linkSync(partPath, finalPath)
    const quarantinePath = cleanupQuarantinePath(partPath, outputIdentity)
    fs.renameSync(partPath, quarantinePath)
    fs.writeFileSync(partPath, 'foreign part occupant')

    backend.db.patchReplay('published-quarantine', {
      recoverable_part_path: partPath,
      recoverable_state: 'published_cleanup',
      output_identity: outputIdentity,
    })

    const service = backend.downloaderService as any
    service.verifyDuration = async (candidatePath: string) => {
      assert.equal(path.resolve(candidatePath), path.resolve(finalPath))
      return { ok: true, duration: 60 }
    }
    service.getFileInfo = async (candidatePath: string) => {
      assert.equal(path.resolve(candidatePath), path.resolve(finalPath))
      return { size: ownedContents.length, resolution: '1x1', bitrate: '1 Mbps' }
    }
    service.downloadReplayWithContext = async () => {
      throw new Error('an owned published final must not be downloaded again')
    }
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async () => {
      throw new Error('M3U8 must not be fetched while the owned published final is recoverable')
    }

    assert.equal(backend.enqueueReplay('published-quarantine', { resetProgress: true }), true)
    const execution = backend.activeTasks.get('published-quarantine')
    assert.ok(execution)
    await withTimeout(execution.promise, 'published quarantine recovery', 5_000)

    const completed = backend.db.getReplaySummaryByLiveKey(baseDir, 'published-quarantine')
    assert.equal(completed?.status, 'completed')
    assert.equal(completed?.file_path, finalPath)
    assert.equal(completed?.recoverable_part_path, '')
    assert.deepEqual(fs.readFileSync(finalPath), ownedContents)
    assert.equal(fs.readFileSync(partPath, 'utf8'), 'foreign part occupant')
    assert.equal(fs.existsSync(quarantinePath), false, 'the owned deterministic quarantine debt must be removed')
  } finally {
    await destroyHarness(harness)
  }
}

async function testRandomTombstoneOnlyRecoveryCleansDebtAndContinues() {
  const harness = await createHarness('replay-random-tombstone-recovery-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'random-tombstone-only', 'pending')
    fs.mkdirSync(backend.config.download.output_dir, { recursive: true })
    const partPath = path.join(backend.config.download.output_dir, 'random-tombstone-only.part.mp4')
    fs.writeFileSync(partPath, Buffer.alloc(1_024, 0x2b))
    const outputIdentity = tryReadFileIdentity(partPath)
    assert.ok(outputIdentity)
    const quarantinePath = cleanupQuarantinePath(partPath, outputIdentity)
    const tombstonePath = `${quarantinePath}.tomb-${'ab'.repeat(16)}`
    fs.renameSync(partPath, tombstonePath)
    backend.db.patchReplay('random-tombstone-only', {
      recoverable_part_path: partPath,
      recoverable_state: 'published_cleanup',
      output_identity: outputIdentity,
    })

    let cacheCalls = 0
    const service = backend.downloaderService as any
    service.verifyDuration = async () => {
      throw new Error('a tombstone-only cleanup debt must not be media-validated')
    }
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async () => {
      cacheCalls += 1
      throw new Error('fresh-download-continuation')
    }

    await assert.rejects(
      service.processReplayTask(
        'random-tombstone-only',
        new AbortController().signal,
        baseDir,
      ),
      /fresh-download-continuation/,
    )
    assert.equal(cacheCalls, 1, 'recovery must continue into a fresh download after cleaning q-only debt')
    assert.equal(fs.existsSync(tombstonePath), false)
    assert.equal(fs.existsSync(partPath), false)
    const continued = backend.db.getReplaySummaryByLiveKey(baseDir, 'random-tombstone-only')
    assert.equal(continued?.recoverable_part_path, '')
    assert.equal(continued?.recoverable_state, '')
    assert.equal(continued?.output_identity, '')
  } finally {
    await destroyHarness(harness)
  }
}

async function testRecoverablePartPathSurvivesRestart() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'replay-recovery-persistence-'))
  let backend = await DesktopBackend.create(baseDir)
  try {
    insertReplay(backend, 'persisted-recovery', 'failed')
    const partPath = path.join(baseDir, 'downloads', 'persisted-recovery.part.mp4')
    const finalPath = path.join(baseDir, 'downloads', 'persisted-recovery.mp4')
    backend.db.patchReplay('persisted-recovery', {
      recoverable_part_path: partPath,
      output_identity: 'v1:durable-fixture-identity',
    })
    backend.runtimePaused = true
    assert.equal(backend.enqueueReplay('persisted-recovery', { resetProgress: true }), true)
    assert.equal(
      path.resolve(
        baseDir,
        backend.db.getReplaySummaryByLiveKey(baseDir, 'persisted-recovery')?.recoverable_part_path || '',
      ),
      partPath,
    )

    await backend.stop()
    backend = await DesktopBackend.create(baseDir)
    const persisted = backend.db.getReplaySummaryByLiveKey(baseDir, 'persisted-recovery')
    assert.equal(persisted?.status, 'pending')
    assert.equal(path.resolve(baseDir, persisted?.recoverable_part_path || ''), partPath)

    backend.runtimePaused = true
    backend.recoverInterruptedTasks()
    assert.equal(
      path.resolve(
        baseDir,
        backend.db.getReplaySummaryByLiveKey(baseDir, 'persisted-recovery')?.recoverable_part_path || '',
      ),
      partPath,
      'startup queue reconciliation must not discard the recoverable file owner/path',
    )
  } finally {
    await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

async function testInterruptedDeletionNeverRestartsDownload() {
  const harness = await createHarness('replay-interrupted-deletion-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'interrupted-delete', 'deleting')
    backend.recoverInterruptedTasks()
    const replay = backend.db.getReplaySummaryByLiveKey(baseDir, 'interrupted-delete')
    assert.equal(replay?.status, 'paused')
    assert.match(replay?.message || '', /deletion was interrupted/i)
    assert.equal(backend.queue.includes('interrupted-delete'), false)
    assert.equal(backend.activeTasks.has('interrupted-delete'), false)
    assert.equal(backend.pausedTasks.has('interrupted-delete'), true)
  } finally {
    await destroyHarness(harness)
  }
}

async function testPauseDuringPublishedLinkCleanupKeepsOwnership() {
  const harness = await createHarness('replay-publish-pause-race-')
  const originalRm = fs.promises.rm.bind(fs.promises)
  let rmIntercepted = false
  try {
    const { backend, baseDir } = harness
    backend.config.download.filename_template = '{live_key}.mp4'
    insertReplay(backend, 'publish-pause', 'failed')
    fs.mkdirSync(backend.config.download.output_dir, { recursive: true })
    const partPath = path.join(backend.config.download.output_dir, 'publish-pause.part.mp4')
    const finalPath = path.join(backend.config.download.output_dir, 'publish-pause.mp4')
    fs.writeFileSync(partPath, Buffer.alloc(2_048, 4))
    const staleAt = new Date(Date.now() - 60_000)
    fs.utimesSync(partPath, staleAt, staleAt)
    const outputIdentity = tryReadFileIdentity(partPath)
    const quarantinePrefix = `${cleanupQuarantinePath(partPath, outputIdentity)}.tomb-`
    backend.db.patchReplay('publish-pause', {
      recoverable_part_path: partPath,
      output_identity: outputIdentity,
    })

    const service = backend.downloaderService as any
    service.verifyDuration = async () => ({ ok: true, duration: 60 })
    service.getFileInfo = async () => ({ size: 2_048, resolution: '1x1', bitrate: '1 Mbps' })

    let markCleanupStarted: (() => void) | undefined
    let releaseCleanup: (() => void) | undefined
    const cleanupStarted = new Promise<void>(resolve => { markCleanupStarted = resolve })
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    ;(fs.promises as any).rm = async (candidate: string, options: unknown) => {
      if (!rmIntercepted && path.resolve(String(candidate)).startsWith(path.resolve(quarantinePrefix))) {
        rmIntercepted = true
        markCleanupStarted?.()
        await cleanupGate
      }
      return originalRm(candidate, options as any)
    }

    assert.equal(backend.enqueueReplay('publish-pause'), true)
    const execution = backend.activeTasks.get('publish-pause')
    assert.ok(execution)
    await withTimeout(cleanupStarted, 'hardlink cleanup interception')
    assert.equal(fs.existsSync(finalPath), true, 'the atomic final link must already be published')
    assert.equal(backend.pauseReplay('publish-pause'), true)
    releaseCleanup?.()
    await withTimeout(execution!.promise, 'paused publish cleanup')

    const paused = backend.db.getReplaySummaryByLiveKey(baseDir, 'publish-pause')
    assert.equal(paused?.status, 'paused')
    assert.equal(paused?.file_path, finalPath)
    assert.equal(path.resolve(baseDir, paused?.recoverable_part_path || ''), partPath)
    assert.equal(fs.existsSync(partPath), false)
    assert.equal(fs.existsSync(finalPath), true, 'pause must not orphan or roll back the tracked final output')
  } finally {
    ;(fs.promises as any).rm = originalRm
    await destroyHarness(harness)
  }
}

async function testPublishedCleanupBusyCompletesAndRecoversAfterRestart() {
  const harness = await createHarness('replay-published-cleanup-debt-')
  try {
    const { baseDir } = harness
    let backend = harness.backend
    insertReplay(backend, 'published-cleanup-debt', 'merging')
    fs.mkdirSync(backend.config.download.output_dir, { recursive: true })
    const partPath = path.join(backend.config.download.output_dir, 'published-cleanup-debt.part.mp4')
    const finalPath = path.join(backend.config.download.output_dir, 'published-cleanup-debt.mp4')
    fs.writeFileSync(partPath, Buffer.alloc(2_048, 7))
    await fs.promises.link(partPath, finalPath)
    const outputIdentity = tryReadFileIdentity(finalPath)
    assert.ok(outputIdentity)
    assert.equal(tryReadFileIdentity(partPath), outputIdentity)

    const tracked = await (backend.downloaderService as any).trackCompletedReplayCleanupDebt(
      'published-cleanup-debt',
      partPath,
      finalPath,
      outputIdentity,
      { size: 2_048, resolution: '1x1', bitrate: '1 Mbps' },
      60,
      ['merging'],
      () => true,
      Object.assign(new Error('simulated persistent working-link lock'), { code: 'EBUSY' }),
    )
    assert.equal(tracked, true)
    const completedWithDebt = backend.db.getReplaySummaryByLiveKey(baseDir, 'published-cleanup-debt')
    assert.equal(completedWithDebt?.status, 'completed')
    assert.equal(completedWithDebt?.file_path, finalPath)
    assert.equal(path.resolve(baseDir, completedWithDebt?.cleanup_part_path || ''), partPath)
    assert.equal(completedWithDebt?.cleanup_part_identity, outputIdentity)
    assert.equal(fs.existsSync(finalPath), true)
    assert.equal(fs.existsSync(partPath), true)

    await backend.stop()
    backend = await DesktopBackend.create(baseDir)
    harness.backend = backend
    backend.config.server.port = 0
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async () => {
      assert.fail('startup cleanup of a published replay must not redownload it')
    }
    await backend.listen()
    await backend.waitForStartupReconciliation()

    const recovered = backend.db.getReplaySummaryByLiveKey(baseDir, 'published-cleanup-debt')
    assert.equal(recovered?.status, 'completed')
    assert.equal(recovered?.file_path, finalPath)
    assert.equal(recovered?.cleanup_part_path, '')
    assert.equal(recovered?.cleanup_part_identity, '')
    assert.equal(fs.existsSync(finalPath), true)
    assert.equal(fs.existsSync(partPath), false, 'restart must finish only the deferred working-link cleanup')
  } finally {
    await destroyHarness(harness)
  }
}

async function testDurationMismatchCannotPublishCompletedReplay() {
  const harness = await createHarness('replay-duration-mismatch-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'duration-mismatch')
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async (replay: { live_key: string; replay_id: number }) => {
      const now = new Date().toISOString()
      backend.db.prepare(
        `INSERT INTO stream_slices
         (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(now, now, replay.replay_id, 0, 60, 'fixture', 0, '#EXTM3U\n#EXTINF:60,\nfixture.ts')
    }

    const service = backend.downloaderService as any
    let finalPath = ''
    let partPath = ''
    service.downloadReplayWithContext = async (_replay: unknown, signal: AbortSignal, isCurrent: () => boolean) => {
      const reserved = service.reserveOutputPaths(path.join(backend.config.download.output_dir, 'duration-mismatch.mp4'))
      finalPath = reserved.finalPath
      partPath = reserved.partPath
      fs.writeFileSync(partPath, Buffer.alloc(1024, 9))
      const partIdentity = tryReadFileIdentity(partPath)
      service.patchActiveReplay('duration-mismatch', ['downloading'], {
        status: 'merging',
        progress: 99,
        message: 'fixture merge',
        recoverable_part_path: partPath,
        recoverable_state: 'complete_unverified',
        output_identity: partIdentity,
      }, signal, isCurrent)
      return { ...reserved, partIdentity }
    }
    service.verifyDuration = async () => ({ ok: false, duration: 500 })
    service.getFileInfo = async () => {
      throw new Error('file info must not run after failed duration verification')
    }

    assert.equal(backend.enqueueReplay('duration-mismatch', { resetProgress: true }), true)
    const execution = backend.activeTasks.get('duration-mismatch')
    assert.ok(execution)
    await withTimeout(execution!.promise, 'duration mismatch failure')

    const failed = backend.db.getReplayByLiveKey(baseDir, 'duration-mismatch')
    assert.equal(failed?.status, 'failed')
    assert.match(failed?.message || '', /duration verification failed/i)
    assert.equal(failed?.file_path, '')
    assert.equal(failed?.streams.length, 0, 'failed downloads must release their M3U8 cache')
    assert.equal(
      fs.existsSync(partPath),
      true,
      'a completed but duration-mismatched part must remain recovery-owned for retry or inspection',
    )
    assert.equal(path.resolve(baseDir, failed?.recoverable_part_path || ''), partPath)
    assert.equal(failed?.output_identity, tryReadFileIdentity(partPath))
    assert.equal(fs.existsSync(finalPath), false, 'a failed verification must not publish a final file')
  } finally {
    await destroyHarness(harness)
  }
}

async function testPublicationCollisionKeepsVerifiedReplayRecovery() {
  const harness = await createHarness('replay-publication-collision-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'publication-collision')
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async (replay: { replay_id: number }) => {
      const now = new Date().toISOString()
      backend.db.prepare(
        `INSERT INTO stream_slices
         (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(now, now, replay.replay_id, 0, 60, 'fixture', 0, '#EXTM3U')
    }

    const service = backend.downloaderService as any
    let partPath = ''
    let finalPath = ''
    service.downloadReplayWithContext = async (_replay: unknown, signal: AbortSignal, isCurrent: () => boolean) => {
      const reserved = service.reserveOutputPaths(path.join(backend.config.download.output_dir, 'publication-collision.mp4'))
      partPath = reserved.partPath
      finalPath = reserved.finalPath
      fs.writeFileSync(partPath, Buffer.alloc(2_048, 3))
      fs.writeFileSync(finalPath, 'external sentinel')
      service.patchActiveReplay('publication-collision', ['downloading'], {
        status: 'merging', progress: 99, message: 'fixture merge',
      }, signal, isCurrent)
      return { ...reserved, partIdentity: tryReadFileIdentity(partPath) }
    }
    service.verifyDuration = async () => ({ ok: true, duration: 60 })
    service.getFileInfo = async () => ({ size: 2_048, resolution: '1x1', bitrate: '1 Mbps' })

    assert.equal(backend.enqueueReplay('publication-collision'), true)
    const execution = backend.activeTasks.get('publication-collision')
    assert.ok(execution)
    await withTimeout(execution!.promise, 'publication collision failure', 5_000)

    const failed = backend.db.getReplaySummaryByLiveKey(baseDir, 'publication-collision')
    assert.equal(failed?.status, 'failed')
    assert.equal(path.resolve(baseDir, failed?.recoverable_part_path || ''), partPath)
    assert.equal(fs.existsSync(partPath), true, 'verified replay output must survive an EEXIST publication collision')
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'external sentinel', 'the colliding destination must not be overwritten')
  } finally {
    await destroyHarness(harness)
  }
}

async function testFailedRefreshPreservesExistingManualCache() {
  const harness = await createHarness('replay-cache-refresh-failure-')
  try {
    const { backend, baseDir } = harness
    insertReplay(backend, 'cached-fallback')
    const replay = backend.db.getReplaySummaryByLiveKey(baseDir, 'cached-fallback')!
    const now = new Date().toISOString()
    backend.db.prepare(
      `INSERT INTO stream_slices
       (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, now, replay.replay_id, 0, 60, 'old-fixture', 0, '#EXTM3U\n#EXTINF:60,\nold.ts')
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async () => {
      throw new Error('fixture refresh failed')
    }

    assert.equal(backend.enqueueReplay('cached-fallback', { resetProgress: true }), true)
    const execution = backend.activeTasks.get('cached-fallback')
    assert.ok(execution)
    await withTimeout(execution!.promise, 'failed cache refresh')

    const failed = backend.db.getReplayByLiveKey(baseDir, 'cached-fallback')
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.streams.length, 1)
    assert.match(failed?.streams[0].m3u8_text || '', /old\.ts/)
  } finally {
    await destroyHarness(harness)
  }
}

async function main() {
  await testImmediatePauseResume()
  await testRejectedPortableResumePreservesPauseBarriers()
  await testLateCacheCannotOverwritePause()
  await testRuntimePauseTracksOnlyItsOwnTasks()
  await testReplayAndClipShareGlobalConcurrencyLimit()
  await testCleanupStaleWaitsForRuntime()
  await testReplayOutputReservationAndMissingSegments()
  await testMultiStreamProgressNeverRegresses()
  await testAtomicReplayCompletion()
  await testCompletedPartRecoverySkipsDownload()
  await testPublishedRecoveryIgnoresForeignPartAndCleansQuarantine()
  await testRandomTombstoneOnlyRecoveryCleansDebtAndContinues()
  await testRecoverablePartPathSurvivesRestart()
  await testInterruptedDeletionNeverRestartsDownload()
  await testPauseDuringPublishedLinkCleanupKeepsOwnership()
  await testPublishedCleanupBusyCompletesAndRecoversAfterRestart()
  await testDurationMismatchCannotPublishCompletedReplay()
  await testPublicationCollisionKeepsVerifiedReplayRecovery()
  await testFailedRefreshPreservesExistingManualCache()
  console.log('replay state-machine and output lifecycle regression tests passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
