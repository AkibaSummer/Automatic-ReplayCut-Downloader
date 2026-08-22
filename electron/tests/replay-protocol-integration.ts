import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { DesktopBackend } from '../src/backend'

type JsonObject = Record<string, any>

function waitForMessage(ws: WebSocket, predicate: (message: JsonObject) => boolean, label: string) {
  return new Promise<JsonObject>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`Timed out waiting for ${label}`))
    }, 3_000)
    const onMessage = (raw: WebSocket.RawData) => {
      let message: JsonObject
      try {
        message = JSON.parse(raw.toString()) as JsonObject
      } catch {
        return
      }
      if (!predicate(message)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}

async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function expectRejectedWebSocket(url: string) {
  const ws = new WebSocket(url, { headers: { Origin: 'https://evil.example' } })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('malicious-origin WebSocket was not rejected')), 2_000)
    ws.once('open', () => {
      clearTimeout(timer)
      reject(new Error('malicious-origin WebSocket unexpectedly opened'))
    })
    const rejected = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.once('error', rejected)
    ws.once('close', rejected)
  })
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'replay-protocol-'))
  const occupiedBaseDir = await mkdtemp(path.join(os.tmpdir(), 'replay-port-conflict-'))
  let backend: DesktopBackend | undefined
  let occupiedBackend: DesktopBackend | undefined
  let ws: WebSocket | undefined

  try {
    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    backend.config.bilibili.anchor_id = 123
    backend.config.download.max_concurrent_tasks = 1
    const baseURL = await backend.listen()
    const wsURL = `${baseURL.replace(/^http/, 'ws')}/ws`

    const evil = await fetch(`${baseURL}/api/health`, { headers: { Origin: 'https://evil.example' } })
    assert.equal(evil.status, 403)
    const local = await fetch(`${baseURL}/api/health`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(local.status, 200)
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    const preflight = await fetch(`${baseURL}/api/config`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'PUT' },
    })
    assert.equal(preflight.status, 204)
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /PUT/)
    await expectRejectedWebSocket(wsURL)

    ws = new WebSocket(wsURL)
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', resolve)
      ws!.once('error', reject)
    })
    const pong = waitForMessage(ws, message => message.type === 'pong', 'WebSocket pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    assert.deepEqual(await pong, { type: 'pong' })

    const coverDir = path.join(backend.config.download.output_dir, 'covers')
    await writeFile(path.join(coverDir, 'valid.txt'), 'valid cover')
    const validCover = await fetch(`${baseURL}/covers/valid.txt`)
    assert.equal(validCover.status, 200)
    const siblingDir = path.join(backend.config.download.output_dir, 'covers_evil')
    await mkdir(siblingDir, { recursive: true })
    await writeFile(path.join(siblingDir, 'secret.txt'), 'must not leak')
    const traversal = await fetch(`${baseURL}/covers/${encodeURIComponent('..\\covers_evil\\secret.txt')}`)
    assert.equal(traversal.status, 400)

    backend.db.insertReplay({
      replay_id: 10,
      live_key: 'metadata',
      room_id: 11,
      title: 'old title',
      start_time: 100,
      end_time: 200,
      duration: 100,
      cover_url: 'https://old.invalid/cover.jpg',
      local_cover: 'old.jpg',
      status: 'not_downloaded',
    })
    await writeFile(path.join(coverDir, 'old.jpg'), 'old')
    await writeFile(path.join(baseDir, 'relative-existing.mp4'), 'fixture')
    backend.db.insertReplay({
      replay_id: 20, live_key: 'relative-file', title: 'relative', status: 'completed',
      file_path: 'relative-existing.mp4', file_size: 7,
    })
    backend.db.insertReplay({
      replay_id: 21, live_key: 'missing-file', title: 'missing', status: 'completed',
      file_path: 'relative-missing.mp4', file_size: 7,
    })
    await writeFile(path.join(baseDir, 'empty-replay.mp4'), '')
    backend.db.insertReplay({
      replay_id: 22, live_key: 'empty-file', title: 'empty', status: 'completed',
      file_path: 'empty-replay.mp4', file_size: 7,
    })
    backend.db.insertReplay({
      replay_id: 23, live_key: 'empty-path', title: 'empty path', status: 'completed',
      file_path: '', file_size: 7,
    })
    ;(backend.bilibiliClient as any).fetchJSON = async () => ({
      code: 0,
      message: '',
      data: {
        replay_info: [{
          replay_id: 101,
          room_id: 202,
          live_key: 'metadata',
          start_time: 300,
          end_time: 450,
          live_info: { title: 'new title', cover: 'https://new.invalid/cover.jpg' },
          video_info: { duration: 150 },
        }],
      },
    })
    ;(backend as any).downloadCover = async (_liveKey: string, _url: string, force: boolean) => {
      assert.equal(force, true)
      await writeFile(path.join(coverDir, 'new.jpg'), 'new')
      return 'new.jpg'
    }

    const scanResponse = await fetch(`${baseURL}/api/replays/scan`, { method: 'POST' })
    assert.equal(scanResponse.status, 200)
    assert.deepEqual(await scanResponse.json(), {
      fetched: 1,
      new_records: 0,
      updated_records: 1,
      covers_updated: 1,
      marked_deleted: 3,
      already_up_to_date: 0,
    })
    const metadata = backend.db.getReplayByLiveKey(baseDir, 'metadata')!
    assert.deepEqual({
      replay_id: metadata.replay_id,
      room_id: metadata.room_id,
      title: metadata.title,
      start_time: metadata.start_time,
      end_time: metadata.end_time,
      duration: metadata.duration,
      cover_url: metadata.cover_url,
      local_cover: metadata.local_cover,
    }, {
      replay_id: 101,
      room_id: 202,
      title: 'new title',
      start_time: 300,
      end_time: 450,
      duration: 150,
      cover_url: 'https://new.invalid/cover.jpg',
      local_cover: 'new.jpg',
    })
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'relative-file')?.status, 'completed')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'missing-file')?.status, 'deleted')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'empty-file')?.status, 'deleted')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'empty-path')?.status, 'deleted')
    const secondScan = await fetch(`${baseURL}/api/scan`, { method: 'POST' })
    assert.deepEqual(await secondScan.json(), {
      fetched: 1,
      new_records: 0,
      updated_records: 0,
      covers_updated: 0,
      marked_deleted: 0,
      already_up_to_date: 1,
    })

    backend.db.insertReplay({ replay_id: 28, live_key: 'slot-blocker', title: 'blocker', status: 'not_downloaded' })
    backend.db.insertReplay({ replay_id: 29, live_key: 'queued-cache', title: 'queued cache', status: 'not_downloaded' })
    let markBlockerStarted: (() => void) | undefined
    const blockerStarted = new Promise<void>(resolve => { markBlockerStarted = resolve })
    ;(backend.downloaderService as any).processReplayTask = (
      liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>((_resolve, reject) => {
      if (liveKey === 'slot-blocker') markBlockerStarted?.()
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    backend.enqueueReplay('slot-blocker')
    await blockerStarted
    backend.enqueueReplay('queued-cache')
    assert.equal(backend.queue.includes('queued-cache'), true)
    const queuedCache = await fetch(`${baseURL}/api/replays/queued-cache/cache-m3u8`, { method: 'POST' })
    assert.equal(queuedCache.status, 409)
    assert.equal(backend.pauseReplay('queued-cache'), true)
    const blockerExecution = backend.activeTasks.get('slot-blocker')!
    assert.equal(backend.pauseReplay('slot-blocker'), true)
    await blockerExecution.promise

    backend.db.insertReplay({ replay_id: 30, live_key: 'failure', title: 'failure', status: 'not_downloaded' })
    ;(backend.downloaderService as any).processReplayTask = async (liveKey: string) => {
      assert.equal(backend!.db.patchReplayIfStatus(liveKey, ['pending'], {
        status: 'downloading', progress: 63, message: 'working', speed: '1 MB/s', eta: '0:01',
      }), true)
      throw new Error('fixture failure')
    }
    const failedUpdate = waitForMessage(ws, message => message.live_key === 'failure' && message.status === 'failed', 'failed replay update')
    assert.equal(backend.enqueueReplay('failure', { resetProgress: true }), true)
    const failurePayload = await failedUpdate
    const failureRecord = backend.db.getReplayByLiveKey(baseDir, 'failure')!
    assert.deepEqual({
      status: failurePayload.status,
      progress: failurePayload.progress,
      message: failurePayload.message,
      speed: failurePayload.speed,
      eta: failurePayload.eta,
    }, {
      status: failureRecord.status,
      progress: failureRecord.progress,
      message: failureRecord.message,
      speed: failureRecord.speed,
      eta: failureRecord.eta,
    })
    await waitUntil(() => !backend!.activeTasks.has('failure'), 'failed generation cleanup')

    const deleteTarget = path.join(backend.config.download.output_dir, 'delete-me.mp4')
    await writeFile(deleteTarget, 'delete fixture')
    backend.db.insertReplay({
      replay_id: 31, live_key: 'delete', title: 'delete', status: 'not_downloaded',
      file_path: deleteTarget, file_size: 14,
    })
    const ownedTemp = path.join(backend.config.download.temp_dir, 'delete_stream0')
    const collidingTemp = path.join(backend.config.download.temp_dir, 'delete_stream_other_stream0')
    await mkdir(ownedTemp, { recursive: true })
    await mkdir(collidingTemp, { recursive: true })
    let markDeleteStarted: (() => void) | undefined
    const deleteStarted = new Promise<void>(resolve => { markDeleteStarted = resolve })
    let staleWriteAccepted: boolean | undefined
    ;(backend.downloaderService as any).processReplayTask = (
      liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>(resolve => {
      markDeleteStarted?.()
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          staleWriteAccepted = backend!.db.patchReplayIfStatus(liveKey, ['pending', 'downloading', 'merging'], {
            status: 'completed', file_path: deleteTarget, progress: 100,
          })
          resolve()
        }, 30)
      }, { once: true })
    })
    const queueDelete = await fetch(`${baseURL}/api/replays/delete/download`, { method: 'POST' })
    assert.equal(queueDelete.status, 200)
    await deleteStarted
    const busyCache = await fetch(`${baseURL}/api/replays/delete/cache-m3u8`, { method: 'POST' })
    assert.equal(busyCache.status, 409)
    const deletedUpdate = waitForMessage(ws, message => message.live_key === 'delete' && message.status === 'deleted', 'deleted replay update')
    const deleteResponse = await fetch(`${baseURL}/api/replays/delete/delete-file`, { method: 'POST' })
    assert.equal(deleteResponse.status, 200)
    const deleted = await deleteResponse.json() as JsonObject
    assert.equal(deleted.status, 'deleted')
    assert.equal((await deletedUpdate).status, 'deleted')
    assert.equal(staleWriteAccepted, false)
    assert.equal(fs.existsSync(deleteTarget), false)
    assert.equal(fs.existsSync(ownedTemp), false)
    assert.equal(fs.existsSync(collidingTemp), true)
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'delete')?.status, 'deleted')

    const completedPath = path.join(backend.config.download.output_dir, 'completed.mp4')
    await writeFile(completedPath, 'done')
    backend.db.insertReplay({
      replay_id: 32, live_key: 'completed', title: 'completed', status: 'completed', file_path: completedPath,
    })
    const illegalDownload = await fetch(`${baseURL}/api/replays/completed/download`, { method: 'POST' })
    assert.equal(illegalDownload.status, 409)
    assert.deepEqual(await illegalDownload.json(), {
      ok: false,
      error: 'Replay cannot be queued in its current state',
    })

    const previousOutput = backend.config.download.output_dir
    const previousGeneration = backend.diskStatsGeneration
    const sentinelCache = {
      value: { path: 'sentinel', total_bytes: 1, free_bytes: 1, used_by_service_bytes: 0 },
      expiresAt: Date.now() + 60_000,
    }
    backend.diskStatsCache = sentinelCache
    const originalConfigPath = backend.configPath
    const blockedConfigParent = path.join(baseDir, 'blocked-config-parent')
    await writeFile(blockedConfigParent, 'not a directory')
    ;(backend as any).configPath = path.join(blockedConfigParent, 'config.yaml')
    const failedConfig = await fetch(`${baseURL}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ download: { output_dir: path.join(baseDir, 'failed-output') } }),
    })
    assert.equal(failedConfig.status, 500)
    assert.equal(backend.config.download.output_dir, previousOutput)
    assert.equal(backend.diskStatsGeneration, previousGeneration)
    assert.equal(backend.diskStatsCache, sentinelCache)
    ;(backend as any).configPath = originalConfigPath

    backend.diskStatsCache = null
    backend.diskStatsPromise = null
    const originalGetDirSize = backend.getDirSize.bind(backend)
    let markOldStatsStarted: (() => void) | undefined
    let releaseOldStats: (() => void) | undefined
    const oldStatsStarted = new Promise<void>(resolve => { markOldStatsStarted = resolve })
    const oldStatsGate = new Promise<void>(resolve => { releaseOldStats = resolve })
    let firstDirSize = true
    ;(backend as any).getDirSize = async () => {
      if (firstDirSize) {
        firstDirSize = false
        markOldStatsStarted?.()
        await oldStatsGate
      }
      return 1
    }
    const oldStatsPromise = backend.getDiskStats()
    await oldStatsStarted
    const newOutput = path.join(baseDir, 'new-output')
    const newTemp = path.join(baseDir, 'new-temp')
    const configResponse = await fetch(`${baseURL}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ download: { output_dir: newOutput, temp_dir: newTemp } }),
    })
    assert.equal(configResponse.status, 200)
    const newStats = await backend.getDiskStats()
    releaseOldStats?.()
    const oldStats = await oldStatsPromise
    assert.equal(oldStats.path, previousOutput)
    assert.equal(newStats.path, newOutput)
    assert.equal(backend.diskStatsCache?.value.path, newOutput, 'old in-flight stats must not overwrite the new cache')

    backend.diskStatsCache = null
    backend.diskStatsPromise = null
    let failDirSize = true
    ;(backend as any).getDirSize = async (target: string) => {
      if (failDirSize) {
        failDirSize = false
        throw new Error('fixture disk failure')
      }
      return originalGetDirSize(target)
    }
    await assert.rejects(backend.getDiskStats(), /fixture disk failure/)
    assert.equal(backend.diskStatsPromise, null)
    assert.equal((await backend.getDiskStats()).path, newOutput)

    occupiedBackend = await DesktopBackend.create(occupiedBaseDir)
    occupiedBackend.config.server.port = (backend.server.address() as AddressInfo).port
    await assert.rejects(
      occupiedBackend.listen(),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
    )
    await occupiedBackend.stop()
    occupiedBackend = undefined

    let markScanStarted: (() => void) | undefined
    const scanStarted = new Promise<void>(resolve => { markScanStarted = resolve })
    let scanCleanupFinished = false
    ;(backend as any).scanReplays = (signal: AbortSignal) => new Promise((_resolve, reject) => {
      markScanStarted?.()
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          scanCleanupFinished = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, 50)
      }, { once: true })
    })
    const scanRequest = fetch(`${baseURL}/api/scan`, { method: 'POST' }).catch(() => undefined)
    await scanStarted
    const wsClosed = new Promise<void>(resolve => ws!.once('close', () => resolve()))
    const stopped = backend.stop()
    assert.equal(backend.resumeAll(), 0, 'resume-all must be inert once shutdown begins')
    assert.equal(backend.runtimePaused, true, 'shutdown must remain paused')
    assert.equal(backend.enqueueReplay('metadata'), false, 'shutdown must reject new replay work')
    assert.equal(backend.downloadUnfinished(), 0, 'bulk download must be inert once shutdown begins')
    await Promise.race([
      stopped,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('backend stop timed out with an open WS client')), 2_000)),
    ])
    await scanRequest
    assert.equal(scanCleanupFinished, true, 'backend stop must abort and await in-flight mutation handlers')
    await wsClosed
    ws = undefined
    backend = undefined

    console.log('replay protocol, CORS, scan, deletion, disk, and shutdown integration tests passed')
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate()
    if (occupiedBackend) await occupiedBackend.stop()
    if (backend) await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
    await rm(occupiedBaseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
