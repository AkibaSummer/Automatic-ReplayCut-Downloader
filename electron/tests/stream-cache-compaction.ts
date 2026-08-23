import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'
import { DEFAULT_CONFIG, normalizeConfigWithBase } from '../src/config'
import { SqliteStore } from '../src/db'

function largePlaylist(tag: string) {
  return `#EXTM3U\n${(`#EXTINF:1,\n${tag}.ts\n`).repeat(40_000)}`
}

async function testFullCacheCompactionAndFileShrink() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'stream-cache-compaction-'))
  const config = normalizeConfigWithBase(baseDir, structuredClone(DEFAULT_CONFIG))
  let db: SqliteStore | undefined

  try {
    db = await SqliteStore.open(config.database.dsn)
    db.ensureSchema()
    const statuses = [
      [1, 'keep', 'not_downloaded'],
      [2, 'pending', 'pending'],
      [3, 'completed', 'completed'],
      [4, 'failed', 'failed'],
      [5, 'deleted', 'deleted'],
      [6, 'paused', 'paused'],
      [7, 'soft-parent', 'not_downloaded'],
      [8, 'unknown', 'future_status'],
      [9, 'legacy-done', 'done'],
      [10, 'legacy-error', 'error'],
    ] as const
    for (const [replayId, liveKey, status] of statuses) {
      db.insertReplay({ replay_id: replayId, live_key: liveKey, title: liveKey, status })
    }
    db.prepare('UPDATE bilibili_replays SET deleted_at = ? WHERE live_key = ?')
      .run(new Date().toISOString(), 'soft-parent')

    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO stream_slices
       (created_at, updated_at, deleted_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const add = (replayId: number, tag: string, start: number, end: number, deletedAt: string | null = null) => {
      insert.run(now, now, deletedAt, replayId, start, end, `https://fixture.invalid/${tag}.m3u8`, 0, largePlaylist(tag))
    }

    // Include current, pending, unknown, deleted, and orphaned rows. Manual
    // maintenance is allowed only while work is idle and must discard all of
    // these disposable playlists so an old database can actually shrink.
    add(1, 'keep-0', 0, 100)
    add(1, 'keep-1', 100, 200)
    add(1, 'legacy-soft-deleted', 200, 300, now)
    add(2, 'pending', 0, 100)
    add(3, 'completed', 0, 100)
    add(4, 'failed', 0, 100)
    add(5, 'deleted', 0, 100)
    add(6, 'paused', 0, 100)
    add(7, 'soft-parent', 0, 100)
    add(8, 'unknown', 0, 100)
    add(9, 'legacy-done', 0, 100)
    add(10, 'legacy-error', 0, 100)
    add(999, 'orphan', 0, 100)

    await db.checkpoint()
    assert.equal((db as any).pendingFlushDelayMs, 5_000, 'checkpoint must restore the normal write-coalescing interval')
    const sizeBefore = fs.statSync(config.database.dsn).size
    assert.ok(sizeBefore > 5 * 1024 * 1024, 'fixture must create a meaningfully large database')

    const result = await db.cleanupStreamCacheAndCompact()
    assert.equal(result.count, 13)
    assert.equal(result.remaining_count, 0)
    assert.equal(result.remaining_m3u8_bytes, 0)
    assert.equal(result.before_file_bytes, sizeBefore)
    assert.equal(result.after_file_bytes, fs.statSync(config.database.dsn).size)
    assert.ok(result.removed_m3u8_bytes > 8 * 1024 * 1024)
    assert.ok(result.after_file_bytes < result.before_file_bytes / 2)
    assert.equal(result.reclaimed_file_bytes, result.before_file_bytes - result.after_file_bytes)
    assert.equal(db.prepare('PRAGMA freelist_count').get<any>()?.freelist_count, 0)
    assert.equal(db.prepare('PRAGMA auto_vacuum').get<any>()?.auto_vacuum, 2)

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stream_slices').get<any>()?.count, 0)

    await db.close()
    db = undefined
    const reopened = await SqliteStore.open(config.database.dsn)
    try {
      reopened.ensureSchema()
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM stream_slices').get<any>()?.count, 0)
      assert.equal(reopened.prepare('PRAGMA auto_vacuum').get<any>()?.auto_vacuum, 2)
      assert.equal(reopened.prepare('SELECT status FROM bilibili_replays WHERE live_key = ?').get<any>('legacy-done')?.status, 'completed')
      assert.equal(reopened.prepare('SELECT status FROM bilibili_replays WHERE live_key = ?').get<any>('legacy-error')?.status, 'failed')
    } finally {
      await reopened.close()
    }
  } finally {
    if (db) await db.close()
    await rm(baseDir, { recursive: true, force: true })
  }
}

async function testCleanupRouteBusyGuard() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'stream-cache-route-'))
  let backend: DesktopBackend | undefined
  try {
    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    const baseURL = await backend.listen()
    await backend.waitForStartupReconciliation()
    backend.db.insertReplay({ replay_id: 20, live_key: 'busy', title: 'busy', status: 'pending' })
    const now = new Date().toISOString()
    backend.db.prepare(
      `INSERT INTO stream_slices
       (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, now, 20, 0, 1, 'https://fixture.invalid/busy.m3u8', 0, largePlaylist('busy'))

    const busy = await fetch(`${baseURL}/api/cleanup-streams`, { method: 'POST' })
    assert.equal(busy.status, 409)
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'busy')?.streams.length, 1)

    backend.pauseReplay('busy')
    const compacted = await fetch(`${baseURL}/api/cleanup-streams`, { method: 'POST' })
    assert.equal(compacted.status, 200)
    const payload = await compacted.json() as Record<string, number>
    assert.equal(payload.count, 1)
    assert.deepEqual(Object.keys(payload).sort(), [
      'after_file_bytes',
      'before_file_bytes',
      'before_logical_file_bytes',
      'count',
      'reclaimed_file_bytes',
      'remaining_count',
      'remaining_m3u8_bytes',
      'removed_m3u8_bytes',
    ])
    assert.equal(payload.remaining_count, 0)
    assert.equal(payload.remaining_m3u8_bytes, 0)
    assert.equal(payload.after_file_bytes, fs.statSync(path.join(baseDir, 'replays.db')).size)
    assert.equal(backend.db.getReplayByLiveKey(baseDir, 'busy')?.streams.length, 0)
    assert.equal(backend.databaseMaintenance, false)
  } finally {
    if (backend) await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

async function main() {
  await testFullCacheCompactionAndFileShrink()
  await testCleanupRouteBusyGuard()
  console.log('full stream cache compaction, persistence, API contract, and busy-guard tests passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
