import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'

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
      return reserved
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
  } finally {
    await destroyHarness(harness)
  }
}

async function main() {
  await testImmediatePauseResume()
  await testLateCacheCannotOverwritePause()
  await testRuntimePauseTracksOnlyItsOwnTasks()
  await testCleanupStaleWaitsForRuntime()
  await testReplayOutputReservationAndMissingSegments()
  await testAtomicReplayCompletion()
  console.log('replay state-machine and output lifecycle regression tests passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
