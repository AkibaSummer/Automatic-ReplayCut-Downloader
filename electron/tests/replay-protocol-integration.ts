import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { DesktopBackend } from '../src/backend'
import { REPLAY_TEMP_SENTINEL, replayTempSentinelContent, tryReadFileIdentity } from '../src/utils'

type JsonObject = Record<string, any>

function assertPublicReplayHasNoStreams(replay: JsonObject, marker: string, label: string) {
  const serialized = JSON.stringify(replay)
  assert.equal(serialized.includes(marker), false, `${label} must not expose cached M3U8 content`)
  assert.equal(serialized.includes('"m3u8_text"'), false, `${label} must not expose the M3U8 field`)
  assert.equal(serialized.includes('"m3_u8_text"'), false, `${label} must not expose the database M3U8 field`)
  assert.equal(
    replay.streams === undefined || (Array.isArray(replay.streams) && replay.streams.length === 0),
    true,
    `${label} must omit streams or return an empty stream list`,
  )
}

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
    await backend.waitForStartupReconciliation()
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
    assert.equal(
      backend.db.getReplayByLiveKey(baseDir, 'empty-path')?.output_state,
      'unavailable',
      'an inconsistent completed row without a path must never be reported as available',
    )
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
      marked_deleted: 0,
      unavailable_outputs: 3,
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
    const missingReplay = backend.db.getReplayByLiveKey(baseDir, 'missing-file')!
    assert.equal(missingReplay.status, 'completed')
    assert.equal(missingReplay.file_path, path.join(baseDir, 'relative-missing.mp4'))
    assert.match(missingReplay.message, /ownership path retained/)
    const emptyReplay = backend.db.getReplayByLiveKey(baseDir, 'empty-file')!
    assert.equal(emptyReplay.status, 'completed')
    assert.equal(emptyReplay.file_path, path.join(baseDir, 'empty-replay.mp4'))
    assert.match(emptyReplay.message, /ownership path retained/)
    const emptyPathReplay = backend.db.getReplayByLiveKey(baseDir, 'empty-path')
    assert.equal(emptyPathReplay?.status, 'not_downloaded')
    assert.equal(emptyPathReplay?.output_state, 'not_applicable')
    assert.match(emptyPathReplay?.message || '', /ready to download again/i)
    const secondScan = await fetch(`${baseURL}/api/scan`, { method: 'POST' })
    assert.deepEqual(await secondScan.json(), {
      fetched: 1,
      new_records: 0,
      updated_records: 0,
      covers_updated: 0,
      marked_deleted: 0,
      unavailable_outputs: 2,
      already_up_to_date: 1,
    })

    const privateM3U8Marker = 'PRIVATE_M3U8_PAYLOAD_MUST_NEVER_LEAK'
    const privateM3U8Text = `#EXTM3U\n#EXTINF:10,\n${privateM3U8Marker.repeat(16_000)}\nfixture.ts`
    backend.db.insertReplay({
      replay_id: 24,
      live_key: 'payload-guard',
      title: 'payload guard',
      start_time: 1,
      end_time: 11,
      duration: 10,
      status: 'not_downloaded',
    })
    const now = new Date().toISOString()
    const insertPrivateStream = backend.db.prepare(
      `INSERT INTO stream_slices
       (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insertPrivateStream.run(now, now, 24, 1, 11, 'https://private.invalid/replay.m3u8', 0, privateM3U8Text)

    const replayListResponse = await fetch(`${baseURL}/api/replays`)
    assert.equal(replayListResponse.status, 200)
    const replayListText = await replayListResponse.text()
    assert.equal(replayListText.includes(privateM3U8Marker), false, 'replay list must not expose cached M3U8 content')
    assert.equal(replayListText.includes('"m3u8_text"'), false, 'replay list must not expose the M3U8 field')
    assert.equal(replayListText.includes('"m3_u8_text"'), false, 'replay list must not expose the database M3U8 field')
    assert.ok(Buffer.byteLength(replayListText) < 128 * 1024, 'replay list response must remain compact')
    const replayList = JSON.parse(replayListText) as JsonObject[]
    const publicPayloadGuard = replayList.find(replay => replay.live_key === 'payload-guard')
    assert.ok(publicPayloadGuard)
    assertPublicReplayHasNoStreams(publicPayloadGuard, privateM3U8Marker, 'replay list item')
    assert.equal(
      backend.db.getReplayByLiveKey(baseDir, 'payload-guard')?.streams[0]?.m3u8_text.includes(privateM3U8Marker),
      true,
      'the private downloader record must retain its cached M3U8 content',
    )

    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async (replay: JsonObject) => {
      assert.equal(replay.live_key, 'payload-guard')
      assertPublicReplayHasNoStreams(replay, privateM3U8Marker, 'cache-m3u8 input metadata')
    }
    const cacheResponse = await fetch(`${baseURL}/api/replays/payload-guard/cache-m3u8`, { method: 'POST' })
    assert.equal(cacheResponse.status, 200)
    const cacheText = await cacheResponse.text()
    assert.ok(Buffer.byteLength(cacheText) < 32 * 1024, 'cache-m3u8 response must remain compact')
    const cachedPublicReplay = JSON.parse(cacheText) as JsonObject
    assertPublicReplayHasNoStreams(cachedPublicReplay, privateM3U8Marker, 'cache-m3u8 response')

    backend.db.insertReplay({
      replay_id: 26,
      live_key: 'portable-relocation-blocked',
      title: 'portable relocation blocked',
      status: 'paused',
    })
    assert.equal(backend.db.setReplayPortableRelocationPending('portable-relocation-blocked', true), true)
    backend.pausedTasks.add('portable-relocation-blocked')
    const portableListResponse = await fetch(`${baseURL}/api/replays`)
    const portableList = await portableListResponse.json() as JsonObject[]
    assert.equal(
      portableList.find(replay => replay.live_key === 'portable-relocation-blocked')?.portable_relocation_pending,
      true,
      'the public replay protocol must expose unresolved portable relocation debt',
    )
    const blockedResume = await fetch(`${baseURL}/api/replays/portable-relocation-blocked/resume`, { method: 'POST' })
    assert.equal(blockedResume.status, 409)
    assert.equal(backend.pausedTasks.has('portable-relocation-blocked'), true)
    assert.equal(backend.db.getReplaySummaryByLiveKey(baseDir, 'portable-relocation-blocked')?.status, 'paused')
    const blockedDownload = await fetch(`${baseURL}/api/replays/portable-relocation-blocked/download`, { method: 'POST' })
    assert.equal(blockedDownload.status, 409)
    assert.equal(backend.pausedTasks.has('portable-relocation-blocked'), true, 'failed download alias must not clear pause')
    assert.equal(backend.queue.includes('portable-relocation-blocked'), false)

    backend.db.insertReplay({ replay_id: 27, live_key: 'cache-lock', title: 'cache lock', status: 'not_downloaded' })
    let markCacheLockStarted: (() => void) | undefined
    let releaseCacheLock: (() => void) | undefined
    const cacheLockStarted = new Promise<void>(resolve => { markCacheLockStarted = resolve })
    const cacheLockGate = new Promise<void>(resolve => { releaseCacheLock = resolve })
    ;(backend.bilibiliClient as any).cacheReplayM3U8 = async (replay: JsonObject) => {
      assert.equal(replay.live_key, 'cache-lock')
      markCacheLockStarted?.()
      await cacheLockGate
    }
    const cacheLockRequest = fetch(`${baseURL}/api/replays/cache-lock/cache-m3u8`, { method: 'POST' })
    await cacheLockStarted
    assert.equal(backend.cachingReplays.has('cache-lock'), true)
    const duplicateCache = await fetch(`${baseURL}/api/replays/cache-lock/cache-m3u8`, { method: 'POST' })
    assert.equal(duplicateCache.status, 409)
    const downloadDuringCache = await fetch(`${baseURL}/api/replays/cache-lock/download`, { method: 'POST' })
    assert.equal(downloadDuringCache.status, 409)
    const deleteDuringCache = await fetch(`${baseURL}/api/replays/cache-lock/delete-file`, { method: 'POST' })
    assert.equal(deleteDuringCache.status, 409)
    releaseCacheLock?.()
    assert.equal((await cacheLockRequest).status, 200)
    assert.equal(backend.cachingReplays.has('cache-lock'), false)

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
    const recoverableDeleteTarget = path.join(backend.config.download.output_dir, 'delete-me.part.mp4')
    const cleanupDeleteTarget = path.join(backend.config.download.output_dir, 'delete-me.partial.mp4')
    await writeFile(recoverableDeleteTarget, 'recoverable delete fixture')
    await fs.promises.link(recoverableDeleteTarget, deleteTarget)
    await writeFile(cleanupDeleteTarget, 'cleanup delete fixture')
    backend.db.insertReplay({
      replay_id: 31, live_key: 'delete', title: 'delete', status: 'not_downloaded',
      file_path: '', recoverable_part_path: recoverableDeleteTarget,
      cleanup_part_path: cleanupDeleteTarget,
      output_identity: tryReadFileIdentity(recoverableDeleteTarget),
      cleanup_part_identity: tryReadFileIdentity(cleanupDeleteTarget),
      file_size: 26,
    })
    insertPrivateStream.run(now, now, 31, 1, 11, 'https://private.invalid/delete.m3u8', 0, privateM3U8Text)
    const ownedTemp = path.join(backend.config.download.temp_dir, 'replay-Ab12Z9')
    const collidingTemp = path.join(backend.config.download.temp_dir, 'replay-Ab12Z9-user-data')
    await mkdir(ownedTemp, { recursive: true })
    await writeFile(path.join(ownedTemp, REPLAY_TEMP_SENTINEL), replayTempSentinelContent('delete', 0))
    await mkdir(collidingTemp, { recursive: true })
    let markDeleteStarted: (() => void) | undefined
    const deleteStarted = new Promise<void>(resolve => { markDeleteStarted = resolve })
    let markDeleteAbortObserved: (() => void) | undefined
    let releaseDeleteAbort: (() => void) | undefined
    const deleteAbortObserved = new Promise<void>(resolve => { markDeleteAbortObserved = resolve })
    const deleteAbortGate = new Promise<void>(resolve => { releaseDeleteAbort = resolve })
    let staleWriteAccepted: boolean | undefined
    ;(backend.downloaderService as any).processReplayTask = (
      liveKey: string,
      signal: AbortSignal,
    ) => new Promise<void>(resolve => {
      markDeleteStarted?.()
      signal.addEventListener('abort', () => {
        markDeleteAbortObserved?.()
        void deleteAbortGate.then(() => {
          staleWriteAccepted = backend!.db.patchReplayIfStatus(liveKey, ['pending', 'downloading', 'merging'], {
            status: 'completed', file_path: deleteTarget, progress: 100,
          })
          resolve()
        })
      }, { once: true })
    })
    const queueDelete = await fetch(`${baseURL}/api/replays/delete/download`, { method: 'POST' })
    assert.equal(queueDelete.status, 200)
    await deleteStarted
    const busyCache = await fetch(`${baseURL}/api/replays/delete/cache-m3u8`, { method: 'POST' })
    assert.equal(busyCache.status, 409)
    const deletedUpdate = waitForMessage(ws, message => message.live_key === 'delete' && message.status === 'deleted', 'deleted replay update')
    const deleteRequest = fetch(`${baseURL}/api/replays/delete/delete-file`, { method: 'POST' })
    await deleteAbortObserved
    assert.equal(
      backend.db.getReplayByLiveKey(baseDir, 'delete')?.status,
      'deleting',
      'active deletion must expose its real busy state while the downloader winds down',
    )
    assert.equal((await fetch(`${baseURL}/api/replays/delete/pause`, { method: 'POST' })).status, 409)
    assert.equal((await fetch(`${baseURL}/api/replays/delete/resume`, { method: 'POST' })).status, 409)
    assert.equal((await fetch(`${baseURL}/api/replays/delete/download`, { method: 'POST' })).status, 409)
    assert.equal((await fetch(`${baseURL}/api/replays/delete/delete-file`, { method: 'POST' })).status, 409)
    releaseDeleteAbort?.()
    const deleteResponse = await deleteRequest
    assert.equal(deleteResponse.status, 200)
    const deleteText = await deleteResponse.text()
    assert.ok(Buffer.byteLength(deleteText) < 32 * 1024, 'delete-file response must remain compact')
    const deleted = JSON.parse(deleteText) as JsonObject
    assertPublicReplayHasNoStreams(deleted, privateM3U8Marker, 'delete-file response')
    assert.equal(deleted.status, 'deleted')
    assert.equal((await deletedUpdate).status, 'deleted')
    assert.equal(staleWriteAccepted, false)
    assert.equal(fs.existsSync(deleteTarget), false)
    assert.equal(fs.existsSync(recoverableDeleteTarget), false)
    assert.equal(fs.existsSync(cleanupDeleteTarget), false)
    assert.equal(fs.existsSync(ownedTemp), false)
    assert.equal(fs.existsSync(collidingTemp), true)
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'delete')?.status, 'deleted')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'delete')?.recoverable_part_path, '')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'delete')?.cleanup_part_path, '')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'delete')?.streams.length, 0)

    const foreignPart = path.join(backend.config.download.output_dir, 'foreign-preserve.part.mp4')
    const foreignFinal = path.join(backend.config.download.output_dir, 'foreign-preserve.mp4')
    await writeFile(foreignPart, 'owned recoverable part')
    await writeFile(foreignFinal, 'foreign replacement')
    const foreignPartStat = fs.statSync(foreignPart)
    const foreignFinalStat = fs.statSync(foreignFinal)
    assert.equal(
      foreignPartStat.dev !== foreignFinalStat.dev || foreignPartStat.ino !== foreignFinalStat.ino,
      true,
      'fixture final must have a different filesystem identity from the recoverable part',
    )
    backend.db.insertReplay({
      replay_id: 33,
      live_key: 'foreign-preserve',
      title: 'foreign preserve',
      status: 'failed',
      file_path: process.platform === 'win32' ? foreignFinal.toUpperCase() : foreignFinal,
      recoverable_part_path: foreignPart,
      output_identity: tryReadFileIdentity(foreignPart),
    })
    const foreignDeleteResponse = await fetch(`${baseURL}/api/replays/foreign-preserve/delete-file`, { method: 'POST' })
    assert.equal(foreignDeleteResponse.status, 200)
    assert.equal((await foreignDeleteResponse.json() as JsonObject).status, 'deleted')
    assert.equal(fs.existsSync(foreignPart), false, 'the owned recoverable part must be deleted')
    assert.equal(fs.existsSync(foreignFinal), true, 'a same-name final with a different identity must be preserved')
    assert.equal(fs.readFileSync(foreignFinal, 'utf8'), 'foreign replacement')

    const blockedCleanupTarget = path.join(backend.config.download.output_dir, 'blocked-cleanup.part.mp4')
    await writeFile(blockedCleanupTarget, 'cleanup must remain after failure')
    backend.db.insertReplay({
      replay_id: 34,
      live_key: 'cleanup-failure',
      title: 'cleanup failure',
      status: 'failed',
      cleanup_part_path: blockedCleanupTarget,
      cleanup_part_identity: tryReadFileIdentity(blockedCleanupTarget),
    })
    const originalRename = fs.promises.rename
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (path.resolve(String(source)) === path.resolve(blockedCleanupTarget)) {
        throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }
    let failedCleanupResponse: Response
    try {
      failedCleanupResponse = await fetch(`${baseURL}/api/replays/cleanup-failure/delete-file`, { method: 'POST' })
    } finally {
      ;(fs.promises as any).rename = originalRename
    }
    assert.equal(failedCleanupResponse.status, 500)
    assert.equal(fs.existsSync(blockedCleanupTarget), true)
    const cleanupFailure = backend.db.getReplayByLiveKey(baseDir, 'cleanup-failure')!
    assert.equal(cleanupFailure.status, 'paused', 'failed cleanup must leave a retryable non-busy state')
    assert.match(cleanupFailure.message, /retained for retry/i)
    assert.equal(
      path.resolve(baseDir, cleanupFailure.cleanup_part_path),
      blockedCleanupTarget,
      'failed cleanup debt must remain durable',
    )

    const cleanupRetryResponse = await fetch(`${baseURL}/api/replays/cleanup-failure/delete-file`, { method: 'POST' })
    assert.equal(cleanupRetryResponse.status, 200)
    assert.equal(fs.existsSync(blockedCleanupTarget), false)
    const cleanupRetried = backend.db.getReplayByLiveKey(baseDir, 'cleanup-failure')!
    assert.equal(cleanupRetried.status, 'deleted')
    assert.equal(cleanupRetried.cleanup_part_path, '')

    const partialDeleteFinal = path.join(backend.config.download.output_dir, 'partial-delete-final.mp4')
    const partialDeleteCleanup = path.join(backend.config.download.output_dir, 'partial-delete-cleanup.part.mp4')
    await writeFile(partialDeleteFinal, 'owned completed final')
    await writeFile(partialDeleteCleanup, 'owned independent cleanup debt')
    backend.db.insertReplay({
      replay_id: 36,
      live_key: 'partial-delete-failure',
      title: 'partial delete failure',
      status: 'completed',
      progress: 100,
      file_path: partialDeleteFinal,
      output_identity: tryReadFileIdentity(partialDeleteFinal),
      cleanup_part_path: partialDeleteCleanup,
      cleanup_part_identity: tryReadFileIdentity(partialDeleteCleanup),
    })
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (path.resolve(String(source)) === path.resolve(partialDeleteCleanup)) {
        throw Object.assign(new Error('simulated second-candidate cleanup failure'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }
    let partialDeleteResponse: Response
    try {
      partialDeleteResponse = await fetch(`${baseURL}/api/replays/partial-delete-failure/delete-file`, { method: 'POST' })
    } finally {
      ;(fs.promises as any).rename = originalRename
    }
    assert.equal(partialDeleteResponse.status, 500)
    assert.equal(fs.existsSync(partialDeleteFinal), false)
    assert.equal(fs.existsSync(partialDeleteCleanup), true)
    const partialDeleteFailed = backend.db.getReplayByLiveKey(baseDir, 'partial-delete-failure')!
    assert.equal(partialDeleteFailed.status, 'paused')
    assert.notEqual(partialDeleteFailed.output_state, 'available')
    assert.equal(partialDeleteFailed.file_path, '')
    assert.equal(path.resolve(baseDir, partialDeleteFailed.cleanup_part_path), partialDeleteCleanup)
    const partialDeleteRetry = await fetch(`${baseURL}/api/replays/partial-delete-failure/delete-file`, { method: 'POST' })
    assert.equal(partialDeleteRetry.status, 200)
    assert.equal(fs.existsSync(partialDeleteCleanup), false)
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'partial-delete-failure')?.status, 'deleted')

    const tombstoneDeleteFinal = path.join(backend.config.download.output_dir, 'tombstone-delete-final.mp4')
    await writeFile(tombstoneDeleteFinal, 'owned completed output moved into a tombstone')
    const tombstoneDeleteIdentity = tryReadFileIdentity(tombstoneDeleteFinal)
    backend.db.insertReplay({
      replay_id: 37,
      live_key: 'tombstone-delete-failure',
      title: 'tombstone delete failure',
      status: 'completed',
      progress: 100,
      file_path: tombstoneDeleteFinal,
      output_identity: tombstoneDeleteIdentity,
      file_size: fs.statSync(tombstoneDeleteFinal).size,
    })
    const originalDeleteRm = fs.promises.rm.bind(fs.promises)
    const originalDeleteLink = fs.promises.link.bind(fs.promises)
    let tombstoneRmAttempts = 0
    let blockedRestoreAttempts = 0
    ;(fs.promises as any).rm = async (...args: Parameters<typeof fs.promises.rm>) => {
      const candidate = path.resolve(String(args[0]))
      if (candidate.includes('.tombstone-delete-final.mp4.arc-delete-')) {
        tombstoneRmAttempts += 1
        throw Object.assign(
          new Error(tombstoneRmAttempts === 1 ? 'simulated tombstone EBUSY' : 'stop retries after exercising EBUSY'),
          { code: tombstoneRmAttempts === 1 ? 'EBUSY' : 'EIO' },
        )
      }
      return originalDeleteRm(...args)
    }
    ;(fs.promises as any).link = async (source: string, destination: string) => {
      if (
        path.resolve(String(destination)) === path.resolve(tombstoneDeleteFinal)
        && String(source).includes('.tombstone-delete-final.mp4.arc-delete-')
      ) {
        blockedRestoreAttempts += 1
        throw Object.assign(new Error('simulated hard-link restore EBUSY'), { code: 'EBUSY' })
      }
      return originalDeleteLink(source, destination)
    }
    let tombstoneDeleteResponse: Response
    try {
      tombstoneDeleteResponse = await fetch(`${baseURL}/api/replays/tombstone-delete-failure/delete-file`, { method: 'POST' })
    } finally {
      ;(fs.promises as any).rm = originalDeleteRm
      ;(fs.promises as any).link = originalDeleteLink
    }
    assert.equal(tombstoneDeleteResponse.status, 500)
    assert.equal(tombstoneRmAttempts >= 2, true)
    assert.equal(blockedRestoreAttempts, 1)
    assert.equal(fs.existsSync(tombstoneDeleteFinal), false, 'the original name must remain absent when restoration is locked')
    const tombstoneDeleteFailed = backend.db.getReplayByLiveKey(baseDir, 'tombstone-delete-failure')!
    assert.equal(tombstoneDeleteFailed.status, 'paused', 'a tombstoned final cannot remain completed')
    assert.notEqual(tombstoneDeleteFailed.output_state, 'available')
    assert.equal(tombstoneDeleteFailed.file_path, tombstoneDeleteFinal, 'the durable name must be retained for tombstone discovery')
    assert.equal(tombstoneDeleteFailed.output_identity, tombstoneDeleteIdentity)
    assert.equal(
      fs.readdirSync(path.dirname(tombstoneDeleteFinal)).some(name => name.includes('.tombstone-delete-final.mp4.arc-delete-')),
      true,
      'the identity-bound tombstone must remain discoverable',
    )
    const tombstoneDeleteRetry = await fetch(`${baseURL}/api/replays/tombstone-delete-failure/delete-file`, { method: 'POST' })
    assert.equal(tombstoneDeleteRetry.status, 200)
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'tombstone-delete-failure')?.status, 'deleted')
    assert.equal(
      fs.readdirSync(path.dirname(tombstoneDeleteFinal)).some(name => name.includes('.tombstone-delete-final.mp4.arc-delete-')),
      false,
    )

    const legacyUnverifiedPath = path.join(backend.config.download.output_dir, 'legacy-unverified.mp4')
    await writeFile(legacyUnverifiedPath, 'legacy file without a durable identity')
    backend.db.insertReplay({
      replay_id: 35,
      live_key: 'legacy-unverified',
      title: 'legacy unverified',
      status: 'completed',
      file_path: legacyUnverifiedPath,
      file_size: fs.statSync(legacyUnverifiedPath).size,
    })
    const legacyDeleteResponse = await fetch(`${baseURL}/api/replays/legacy-unverified/delete-file`, { method: 'POST' })
    assert.equal(legacyDeleteResponse.status, 409, 'an existing path without durable identity must not be deleted')
    assert.equal(fs.readFileSync(legacyUnverifiedPath, 'utf8'), 'legacy file without a durable identity')
    const legacyAfterBlockedDelete = backend.db.getReplayByLiveKey(baseDir, 'legacy-unverified')!
    assert.equal(legacyAfterBlockedDelete.status, 'completed')
    assert.equal(legacyAfterBlockedDelete.file_path, legacyUnverifiedPath)
    assert.equal(legacyAfterBlockedDelete.output_state, 'unavailable')
    const legacyDownloadResponse = await fetch(`${baseURL}/api/replays/legacy-unverified/download`, { method: 'POST' })
    assert.equal(legacyDownloadResponse.status, 409, 'a blocked completed delete must not become queueable')
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'legacy-unverified')?.file_path, legacyUnverifiedPath)

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
    const originalGetKnownServiceStorageBytes = backend.getKnownServiceStorageBytes.bind(backend)
    let markOldStatsStarted: (() => void) | undefined
    let releaseOldStats: (() => void) | undefined
    const oldStatsStarted = new Promise<void>(resolve => { markOldStatsStarted = resolve })
    const oldStatsGate = new Promise<void>(resolve => { releaseOldStats = resolve })
    let firstKnownStorageRead = true
    ;(backend as any).getKnownServiceStorageBytes = async () => {
      if (firstKnownStorageRead) {
        firstKnownStorageRead = false
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
    let failKnownStorage = true
    ;(backend as any).getKnownServiceStorageBytes = async () => {
      if (failKnownStorage) {
        failKnownStorage = false
        throw new Error('fixture disk failure')
      }
      return originalGetKnownServiceStorageBytes()
    }
    await assert.rejects(backend.getDiskStats(), /fixture disk failure/)
    assert.equal(backend.diskStatsPromise, null)
    assert.equal((await backend.getDiskStats()).path, newOutput)

    occupiedBackend = await DesktopBackend.create(occupiedBaseDir)
    occupiedBackend.config.server.port = (backend.server.address() as AddressInfo).port
    const occupiedFallbackURL = await occupiedBackend.listen()
    await occupiedBackend.waitForStartupReconciliation()
    assert.notEqual(
      (occupiedBackend.server.address() as AddressInfo).port,
      (backend.server.address() as AddressInfo).port,
      'a packaged instance must fall back to a free loopback port when the configured port is occupied',
    )
    assert.deepEqual(await (await fetch(`${occupiedFallbackURL}/api/health`)).json(), { ok: true })
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
