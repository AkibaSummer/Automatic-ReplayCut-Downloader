import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { SqliteStore } from '../src/db'
import { tryReadFileIdentity } from '../src/utils'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'db-schema-migration-'))
  // Keep the database outside the app base itself so the test catches a
  // regression where relative legacy outputs are resolved against the DSN.
  const databasePath = path.join(baseDir, 'database', 'replays.db')
  const legacyOutputPath = path.join(baseDir, 'legacy.mp4')
  const legacyDonePath = path.join(baseDir, 'legacy-done.mp4')
  const emptyOutputPath = path.join(baseDir, 'empty.mp4')
  const postMigrationOutputPath = path.join(baseDir, 'post-migration.mp4')
  let db: SqliteStore | undefined

  try {
    await mkdir(path.dirname(databasePath), { recursive: true })
    await writeFile(legacyOutputPath, 'legacy completed output')
    await writeFile(legacyDonePath, 'legacy done output')
    await writeFile(emptyOutputPath, '')

    // Reproduce the pre-v1 schema: all historical columns are present, while
    // durable replay/clip artifact ownership columns and the stream index are not.
    db = await SqliteStore.open(databasePath)
    db.exec(`CREATE TABLE bilibili_replays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      replay_id INTEGER UNIQUE,
      live_key TEXT UNIQUE,
      room_id INTEGER DEFAULT 0,
      title TEXT DEFAULT '',
      start_time INTEGER DEFAULT 0,
      end_time INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      file_path TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      local_cover TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      resolution TEXT DEFAULT '',
      bitrate TEXT DEFAULT '',
      progress REAL DEFAULT 0,
      speed TEXT DEFAULT '',
      elapsed TEXT DEFAULT '',
      eta TEXT DEFAULT '',
      status TEXT DEFAULT 'not_downloaded',
      message TEXT DEFAULT '',
      verify_ok INTEGER DEFAULT 0,
      actual_dur REAL DEFAULT 0
    )`)
    db.exec(`CREATE TABLE stream_slices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      replay_id INTEGER,
      start_time INTEGER DEFAULT 0,
      end_time INTEGER DEFAULT 0,
      stream TEXT DEFAULT '',
      type INTEGER DEFAULT 0,
      m3_u8_text TEXT DEFAULT ''
    )`)
    db.exec(`CREATE TABLE clip_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      updated_at TEXT,
      url TEXT DEFAULT '',
      title TEXT DEFAULT '',
      start_time REAL DEFAULT 0,
      end_time REAL DEFAULT 0,
      file_path TEXT DEFAULT '',
      progress REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      message TEXT DEFAULT ''
    )`)
    const insertLegacyReplay = db.prepare(
      `INSERT INTO bilibili_replays
       (created_at, updated_at, replay_id, live_key, file_path, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const now = new Date().toISOString()
    insertLegacyReplay.run(now, now, 1, 'legacy-completed', path.basename(legacyOutputPath), 'completed')
    insertLegacyReplay.run(now, now, 2, 'legacy-done', path.basename(legacyDonePath), 'done')
    insertLegacyReplay.run(now, now, 3, 'legacy-empty', path.basename(emptyOutputPath), 'completed')
    insertLegacyReplay.run(now, now, 4, 'legacy-missing', 'missing.mp4', 'completed')
    insertLegacyReplay.run(now, now, 5, 'legacy-error', '', 'error')
    assert.equal(db.prepare('PRAGMA user_version').get<any>()?.user_version, 0)
    await db.close()
    db = undefined

    db = await SqliteStore.open(databasePath)
    assert.equal((db as any).dirty, false)
    db.ensureSchema(baseDir)
    assert.equal((db as any).dirty, true, 'a real legacy migration must schedule persistence')

    const replayColumns = new Set(
      db.prepare('PRAGMA table_info(bilibili_replays)').all<{ name: string }>().map(column => column.name),
    )
    assert.deepEqual(
      ['recoverable_part_path', 'recoverable_state', 'cleanup_part_path', 'output_identity', 'cleanup_part_identity', 'legacy_identity_pending', 'portable_relocation_pending']
        .filter(column => !replayColumns.has(column)),
      [],
    )
    const clipColumns = new Set(
      db.prepare('PRAGMA table_info(clip_tasks)').all<{ name: string }>().map(column => column.name),
    )
    assert.deepEqual(
      ['part_path', 'artifact_state', 'artifact_identity', 'part_identity', 'legacy_identity_pending', 'portable_relocation_pending']
        .filter(column => !clipColumns.has(column)),
      [],
    )
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get<any>('idx_stream_slices_replay_active')?.count,
      1,
    )
    assert.equal(db.prepare('PRAGMA user_version').get<any>()?.user_version, 5)
    assert.equal(
      db.prepare('SELECT output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('legacy-completed')?.output_identity,
      '',
      'schema migration must not synchronously stat historical output paths',
    )
    await db.adoptLegacyOutputIdentitiesAsync(baseDir)
    assert.equal(
      db.prepare('SELECT output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('legacy-completed')?.output_identity,
      tryReadFileIdentity(legacyOutputPath),
      'the first v1 migration must adopt an existing usable legacy output using the app base directory',
    )
    assert.deepEqual(
      db.prepare('SELECT status, output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('legacy-done'),
      { status: 'completed', output_identity: tryReadFileIdentity(legacyDonePath) },
      'legacy status normalization must happen before the one-time identity adoption',
    )
    assert.equal(
      db.prepare('SELECT output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('legacy-empty')?.output_identity,
      '',
      'zero-byte legacy outputs must not be adopted',
    )
    assert.equal(
      db.prepare('SELECT output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('legacy-missing')?.output_identity,
      '',
      'missing legacy outputs must not be adopted',
    )
    assert.equal(
      db.prepare('SELECT legacy_identity_pending FROM bilibili_replays WHERE live_key = ?')
        .get<any>('legacy-missing')?.legacy_identity_pending,
      1,
      'an offline legacy path must remain eligible for one-time adoption after the drive reconnects',
    )
    assert.equal(
      db.prepare('SELECT status FROM bilibili_replays WHERE live_key = ?').get<any>('legacy-error')?.status,
      'failed',
    )

    // Exercise the post-migration INSERT column/placeholder mapping and prove
    // that a later same-name file is not silently trusted on a normal reopen.
    await writeFile(postMigrationOutputPath, 'created after schema migration')
    db.insertReplay({
      replay_id: 6,
      live_key: 'post-migration',
      title: 'post migration',
      status: 'completed',
      file_path: path.basename(postMigrationOutputPath),
    })
    assert.equal(
      db.prepare('SELECT output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('post-migration')?.output_identity,
      '',
    )
    await db.close()
    db = undefined

    const migratedMtimeNs = fs.statSync(databasePath, { bigint: true }).mtimeNs
    await wait(50)

    db = await SqliteStore.open(databasePath)
    assert.equal((db as any).dirty, false)
    db.ensureSchema(baseDir)
    assert.equal((db as any).dirty, false, 'an idempotent reopen must not mark the database dirty')
    await db.adoptLegacyOutputIdentitiesAsync(baseDir)
    assert.equal(
      db.prepare('SELECT output_identity FROM bilibili_replays WHERE live_key = ?')
        .get<any>('post-migration')?.output_identity,
      '',
      'identity adoption must run only once during the v1 migration',
    )
    await db.close()
    db = undefined

    assert.equal(
      fs.statSync(databasePath, { bigint: true }).mtimeNs,
      migratedMtimeNs,
      'an unchanged startup/close cycle must not export and replace the whole database',
    )
    assert.equal(fs.existsSync(`${databasePath}.tmp`), false)
    console.log('database schema migration, legacy identity adoption, and no-op reopen tests passed')
  } finally {
    if (db) await db.close()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
