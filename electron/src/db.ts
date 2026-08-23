import fs from 'node:fs'
import fsp from 'node:fs/promises'
import initSqlJs, { type BindParams, type Database as SqlDatabase } from 'sql.js'
import { ReplayRecord, ReplayPatch, StreamSlice, ClipTaskRecord } from './types'
import { safeNumber, boolFromDb, fileMatchesIdentity, tryReadFileIdentity } from './utils'
import { resolveAppPathWithBase } from './config'
import path from 'node:path'

// sql.js persists by exporting the whole in-memory database. Progress updates can
// arrive many times per second, so a short debounce turns a large database into a
// continuous full-file rewrite. Keep writes coalesced while close() still forces a
// final durable snapshot.
const DATABASE_FLUSH_INTERVAL_MS = 5_000
const DATABASE_URGENT_FLUSH_DELAY_MS = 500
const DATABASE_REPLACE_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const
const DATABASE_SCHEMA_VERSION = 5

export const REPLAY_OUTPUT_UNAVAILABLE_PREFIX = 'Local output is currently unavailable; ownership path retained:'
export const REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX = 'Local output ownership changed; replacement path retained:'

export function isUsableClipOutput(filePath: string, baseDir = process.cwd()) {
  if (!filePath) return false
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
  try {
    const stats = fs.statSync(resolvedPath)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

export function isUsableReplayOutput(filePath: string, baseDir = process.cwd()) {
  return isUsableClipOutput(filePath, baseDir)
}

async function inspectOutputAsync(filePath: string, baseDir = process.cwd()) {
  if (!filePath) return { usable: false, identity: '' }
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
  try {
    const stat = await fsp.stat(resolvedPath, { bigint: true })
    return {
      usable: stat.isFile() && stat.size > 0n,
      identity: stat.isFile() && stat.ino !== 0n
        ? `v1:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
        : '',
    }
  } catch {
    return { usable: false, identity: '' }
  }
}

function isStoredPathInsideBase(filePath: string, baseDir: string) {
  if (!filePath) return true
  const resolvedPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath)
  const relative = path.relative(baseDir, resolvedPath)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function normalizeSqlParams(paramsRaw: unknown[]) {
  if (paramsRaw.length === 0) return undefined
  if (paramsRaw.length === 1) {
    const single = paramsRaw[0]
    if (single && typeof single === 'object' && !Array.isArray(single)) {
      const mapped: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(single as Record<string, unknown>)) {
        mapped[key] = value
        if (!/^[@:$/]/.test(key)) {
          mapped[`@${key}`] = value
        }
      }
      return mapped as BindParams
    }
    if (Array.isArray(single)) {
      return single as BindParams
    }
    return [single] as BindParams
  }
  return paramsRaw as unknown as BindParams
}

function mapClipTaskRow(r: Record<string, unknown>, baseDir: string): ClipTaskRecord {
  const resolveStoredPath = (value: unknown) => {
    const storedPath = String(value || '')
    return storedPath && !path.isAbsolute(storedPath) ? path.resolve(baseDir, storedPath) : storedPath
  }
  const filePath = resolveStoredPath(r.file_path)
  const partPath = resolveStoredPath(r.part_path)
  const artifactState = String(r.artifact_state || '') as ClipTaskRecord['artifact_state']
  const artifactIdentity = String(r.artifact_identity || '')
  const partIdentity = String(r.part_identity || '')
  const portableRelocationPending = boolFromDb(r.portable_relocation_pending)
  const status = String(r.status || 'pending') as ClipTaskRecord['status']
  const message = String(r.message || '')
  const ownershipChanged = /(?:ownership|identity) changed|no longer match|could not be matched/i.test(message)
  const temporarilyUnavailable = /currently unavailable|temporarily unavailable/i.test(message)
  const explicitlyRecoverable = message.includes('完整切片已保留')
    || message.startsWith('Published output is missing; verified working file was preserved:')
  const recoverablePath = artifactState === 'published_cleanup' ? filePath : partPath
  const recoverableIdentity = artifactState === 'published_cleanup'
    ? artifactIdentity
    : (partIdentity || artifactIdentity)
  const outputState: ClipTaskRecord['output_state'] = portableRelocationPending && Boolean(filePath || partPath)
    ? 'unknown'
    : ownershipChanged
      ? 'ownership_changed'
      : temporarilyUnavailable
        ? 'unavailable'
        : status === 'done'
          ? !filePath
            ? 'unavailable'
            : artifactIdentity
              ? 'available'
              : 'unknown'
          : status === 'error'
            && explicitlyRecoverable
            && ['built', 'verified', 'published_cleanup'].includes(artifactState)
            && recoverablePath
              ? recoverableIdentity ? 'available' : 'unknown'
              : 'not_applicable'
  return {
    id: safeNumber(r.id),
    created_at: String(r.created_at || ''),
    updated_at: String(r.updated_at || ''),
    url: String(r.url || ''),
    title: String(r.title || ''),
    start_time: safeNumber(r.start_time),
    end_time: safeNumber(r.end_time),
    file_path: filePath,
    part_path: partPath,
    artifact_state: artifactState,
    artifact_identity: artifactIdentity,
    part_identity: partIdentity,
    portable_relocation_pending: portableRelocationPending,
    output_state: outputState,
    status,
    progress: safeNumber(r.progress),
    message,
  }
}

export class SqlStatement {
  constructor(
    private readonly store: SqliteStore,
    private readonly sql: string,
  ) {}

  run(...paramsRaw: unknown[]) {
    this.store.run(this.sql, normalizeSqlParams(paramsRaw))
    const changesRow = this.store.get<{ changes: number }>('SELECT changes() AS changes')
    return { changes: safeNumber(changesRow?.changes) }
  }

  get<T extends Record<string, unknown>>(...paramsRaw: unknown[]) {
    return this.store.get<T>(this.sql, normalizeSqlParams(paramsRaw))
  }

  all<T extends Record<string, unknown>>(...paramsRaw: unknown[]) {
    return this.store.all<T>(this.sql, normalizeSqlParams(paramsRaw))
  }
}

export class SqliteStore {
  private batchDepth = 0
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null
  private flushTimerDueAt = 0
  private pendingFlushDelayMs = DATABASE_FLUSH_INTERVAL_MS
  private isFlushing = false
  private lastFlushError: unknown = null
  private applicationBaseDir: string

  private constructor(
    private readonly filePath: string,
    private readonly db: SqlDatabase,
  ) {
    this.applicationBaseDir = path.dirname(filePath)
  }

  private toDurablePath(filePath: unknown) {
    const value = String(filePath || '')
    if (!value || !path.isAbsolute(value)) return value
    const relative = path.relative(this.applicationBaseDir, path.resolve(value))
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      return value
    }
    return relative
  }

  static async open(filePath: string) {
    const SQL = await initSqlJs({
      locateFile: file => require.resolve(`sql.js/dist/${file}`).replace('app.asar', 'app.asar.unpacked'),
    })
    const existingData = fs.existsSync(filePath) ? await fsp.readFile(filePath) : undefined
    const db = existingData ? new SQL.Database(existingData) : new SQL.Database()
    return new SqliteStore(filePath, db)
  }

  prepare(sql: string) {
    return new SqlStatement(this, sql)
  }

  exec(sql: string) {
    this.db.run(sql)
    this.markDirtyOrFlush()
  }

  run(sql: string, params?: BindParams) {
    if (params === undefined) {
      this.db.run(sql)
    } else {
      this.db.run(sql, params)
    }
    this.markDirtyOrFlush()
  }

  get<T extends Record<string, unknown>>(sql: string, params?: BindParams) {
    return this.all<T>(sql, params)[0]
  }

  all<T extends Record<string, unknown>>(sql: string, params?: BindParams) {
    const stmt = this.db.prepare(sql)
    try {
      if (params !== undefined) {
        stmt.bind(params)
      }
      const rows: T[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  async close() {
    // Never close the in-memory database while durable persistence is still
    // failing; callers may retry close after the filesystem issue is resolved.
    await this.checkpoint()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
      this.flushTimerDueAt = 0
    }
    this.db.close()
  }

  async withBatch<T>(fn: () => Promise<T> | T): Promise<T> {
    this.batchDepth += 1
    try {
      return await fn()
    } finally {
      this.batchDepth = Math.max(0, this.batchDepth - 1)
      if (this.batchDepth === 0 && this.dirty) {
        this.markDirtyOrFlush()
      }
    }
  }

  withTransaction<T>(fn: () => T): T {
    this.db.run('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.run('COMMIT')
      this.markDirtyOrFlush()
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  private markDirtyOrFlush() {
    this.dirty = true
    this.scheduleFlush()
  }

  public flushSoon() {
    if (!this.dirty) return
    this.pendingFlushDelayMs = Math.min(this.pendingFlushDelayMs, DATABASE_URGENT_FLUSH_DELAY_MS)
    this.scheduleFlush()
  }

  public async checkpoint() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
      this.flushTimerDueAt = 0
    }

    let consecutiveFailures = 0
    while (this.dirty || this.isFlushing) {
      if (this.isFlushing) {
        await new Promise(resolve => setTimeout(resolve, 25))
        continue
      }

      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
        this.flushTimerDueAt = 0
      }
      // This immediate checkpoint consumes any earlier flushSoon request. Reset
      // the next ordinary write to the normal coalescing interval before I/O;
      // a genuinely new flushSoon during I/O can still lower it back to 500ms.
      this.pendingFlushDelayMs = DATABASE_FLUSH_INTERVAL_MS
      await this.flushNow()
      if (this.dirty && this.lastFlushError) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) {
          throw new Error(
            `Failed to persist database: ${this.lastFlushError instanceof Error ? this.lastFlushError.message : String(this.lastFlushError)}`,
          )
        }
      } else {
        // A successful snapshot may still leave dirty=true when a legitimate
        // write happened while the file was being written. Persist that newer
        // state too; it is not a failed retry.
        consecutiveFailures = 0
      }
    }
  }

  private scheduleFlush() {
    if (!this.dirty || this.batchDepth > 0 || this.isFlushing) return
    const delayMs = this.pendingFlushDelayMs
    const dueAt = Date.now() + delayMs
    if (this.flushTimer && this.flushTimerDueAt <= dueAt) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimerDueAt = dueAt
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushTimerDueAt = 0
      this.pendingFlushDelayMs = DATABASE_FLUSH_INTERVAL_MS
      void this.flushNow()
    }, delayMs)
  }

  private async flushNow() {
    if (this.isFlushing || !this.dirty) return
    this.isFlushing = true
    this.dirty = false
    try {
      const data = this.db.export()
      const tempPath = `${this.filePath}.tmp`
      await fsp.writeFile(tempPath, data)
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fsp.rename(tempPath, this.filePath)
          break
        } catch (renameError) {
          const code = (renameError as NodeJS.ErrnoException).code || ''
          const delayMs = DATABASE_REPLACE_RETRY_DELAYS_MS[attempt]
          if (!['EBUSY', 'EACCES', 'EPERM'].includes(code) || delayMs === undefined) throw renameError
          console.warn(
            `[database] Snapshot replace blocked by ${code}; retry ${attempt + 1}/${DATABASE_REPLACE_RETRY_DELAYS_MS.length} in ${delayMs}ms`,
          )
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
      this.lastFlushError = null
    } catch (err) {
      console.error('Failed to flush database to disk:', err)
      this.lastFlushError = err
      this.dirty = true // Try again later
    } finally {
      this.isFlushing = false
      this.scheduleFlush()
    }
  }

  ensureSchema(baseDir = path.dirname(this.filePath)) {
    this.applicationBaseDir = path.resolve(baseDir)
    const tableExists = (tableName: string) => Boolean(this.get<Record<string, unknown>>(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [tableName],
    ))
    const indexExists = (indexName: string) => Boolean(this.get<Record<string, unknown>>(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?`,
      [indexName],
    ))
    const initialUserVersion = safeNumber(this.get<Record<string, unknown>>('PRAGMA user_version')?.user_version)
    const hadAnyApplicationTable = ['bilibili_replays', 'stream_slices', 'clip_tasks'].some(tableExists)
    let changed = false

    // auto_vacuum must be selected before the first table is created. Existing
    // databases are converted by the explicit maintenance VACUUM path instead.
    if (!hadAnyApplicationTable) {
      this.db.run('PRAGMA auto_vacuum = INCREMENTAL')
      changed = true
    }

    this.db.run('BEGIN IMMEDIATE')
    try {
      if (!tableExists('bilibili_replays')) {
        this.db.run(`CREATE TABLE bilibili_replays (
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
        recoverable_part_path TEXT DEFAULT '',
        recoverable_state TEXT DEFAULT '',
        cleanup_part_path TEXT DEFAULT '',
        output_identity TEXT DEFAULT '',
        cleanup_part_identity TEXT DEFAULT '',
        legacy_identity_pending INTEGER DEFAULT 0,
        portable_relocation_pending INTEGER DEFAULT 0,
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
        changed = true
      }
      if (!tableExists('stream_slices')) {
        this.db.run(`CREATE TABLE stream_slices (
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
        changed = true
      }
      if (!tableExists('clip_tasks')) {
        this.db.run(`CREATE TABLE clip_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT,
        updated_at TEXT,
        url TEXT DEFAULT '',
        title TEXT DEFAULT '',
        start_time REAL DEFAULT 0,
        end_time REAL DEFAULT 0,
        file_path TEXT DEFAULT '',
        part_path TEXT DEFAULT '',
        artifact_state TEXT DEFAULT '',
        artifact_identity TEXT DEFAULT '',
        part_identity TEXT DEFAULT '',
        legacy_identity_pending INTEGER DEFAULT 0,
        portable_relocation_pending INTEGER DEFAULT 0,
        progress REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        message TEXT DEFAULT ''
        )`)
        changed = true
      }
      if (!tableExists('app_metadata')) {
        this.db.run(`CREATE TABLE app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT DEFAULT ''
        )`)
        changed = true
      }

      const replayColumns = this.prepare('PRAGMA table_info(bilibili_replays)').all() as Array<{ name: string }>
      const replayColumnNames = new Set(replayColumns.map(column => column.name))
      const addReplayColumn = (name: string, definition: string) => {
        if (replayColumnNames.has(name)) return
        this.db.run(`ALTER TABLE bilibili_replays ADD COLUMN ${name} ${definition}`)
        replayColumnNames.add(name)
        changed = true
      }
      addReplayColumn('recoverable_part_path', "TEXT DEFAULT ''")
      addReplayColumn('recoverable_state', "TEXT DEFAULT ''")
      addReplayColumn('cleanup_part_path', "TEXT DEFAULT ''")
      addReplayColumn('output_identity', "TEXT DEFAULT ''")
      addReplayColumn('cleanup_part_identity', "TEXT DEFAULT ''")
      addReplayColumn('legacy_identity_pending', 'INTEGER DEFAULT 0')
      addReplayColumn('portable_relocation_pending', 'INTEGER DEFAULT 0')

      const clipTaskColumns = this.prepare('PRAGMA table_info(clip_tasks)').all() as Array<{ name: string }>
      const clipTaskColumnNames = new Set(clipTaskColumns.map(column => column.name))
      const addClipTaskColumn = (name: string, definition: string) => {
        if (clipTaskColumnNames.has(name)) return
        this.db.run(`ALTER TABLE clip_tasks ADD COLUMN ${name} ${definition}`)
        clipTaskColumnNames.add(name)
        changed = true
      }
      addClipTaskColumn('part_path', "TEXT DEFAULT ''")
      addClipTaskColumn('artifact_state', "TEXT DEFAULT ''")
      addClipTaskColumn('artifact_identity', "TEXT DEFAULT ''")
      addClipTaskColumn('part_identity', "TEXT DEFAULT ''")
      addClipTaskColumn('legacy_identity_pending', 'INTEGER DEFAULT 0')
      addClipTaskColumn('portable_relocation_pending', 'INTEGER DEFAULT 0')

      if (!indexExists('idx_stream_slices_replay_active')) {
        this.db.run(`CREATE INDEX idx_stream_slices_replay_active
          ON stream_slices(replay_id, deleted_at)`)
        changed = true
      }

      const legacyDone = safeNumber(this.get<Record<string, unknown>>(
        "SELECT COUNT(*) AS count FROM bilibili_replays WHERE status = 'done'",
      )?.count)
      if (legacyDone > 0) {
        this.db.run("UPDATE bilibili_replays SET status = 'completed' WHERE status = 'done'")
        changed = true
      }
      const legacyError = safeNumber(this.get<Record<string, unknown>>(
        "SELECT COUNT(*) AS count FROM bilibili_replays WHERE status = 'error'",
      )?.count)
      if (legacyError > 0) {
        this.db.run("UPDATE bilibili_replays SET status = 'failed' WHERE status = 'error'")
        changed = true
      }

      if (initialUserVersion < DATABASE_SCHEMA_VERSION) {
        // Filesystem identity adoption used to happen synchronously inside the
        // schema transaction. On a large history backed by a disconnected drive
        // that could block the Electron main thread before the backend was even
        // listening. Mark only pre-v3 rows here; listen() adopts them with async,
        // abortable stat calls. Newly-created rows default to not pending, so a
        // later same-name replacement is never silently trusted.
        this.db.run(
          `UPDATE bilibili_replays
           SET legacy_identity_pending = 1
           WHERE status = 'completed'
             AND COALESCE(file_path, '') <> ''
             AND COALESCE(output_identity, '') = ''`,
        )
        this.db.run(
          `UPDATE clip_tasks
           SET legacy_identity_pending = 1
           WHERE status = 'done'
             AND COALESCE(file_path, '') <> ''
             AND COALESCE(artifact_identity, '') = ''`,
        )
      }
      if (initialUserVersion < 2) {
        const replayPaths = this.prepare(
          `SELECT live_key, file_path, recoverable_part_path, cleanup_part_path FROM bilibili_replays`,
        ).all() as Array<{
          live_key: string
          file_path: string
          recoverable_part_path: string
          cleanup_part_path: string
        }>
        for (const replay of replayPaths) {
          const filePath = this.toDurablePath(replay.file_path)
          const recoverablePartPath = this.toDurablePath(replay.recoverable_part_path)
          const cleanupPartPath = this.toDurablePath(replay.cleanup_part_path)
          if (
            filePath === replay.file_path
            && recoverablePartPath === replay.recoverable_part_path
            && cleanupPartPath === replay.cleanup_part_path
          ) continue
          this.db.run(
            `UPDATE bilibili_replays
             SET file_path = ?, recoverable_part_path = ?, cleanup_part_path = ?
             WHERE live_key = ?`,
            [filePath, recoverablePartPath, cleanupPartPath, replay.live_key],
          )
          changed = true
        }
        const clipPaths = this.prepare('SELECT id, file_path, part_path FROM clip_tasks').all() as Array<{
          id: number
          file_path: string
          part_path: string
        }>
        for (const task of clipPaths) {
          const filePath = this.toDurablePath(task.file_path)
          const partPath = this.toDurablePath(task.part_path)
          if (filePath === task.file_path && partPath === task.part_path) continue
          this.db.run(
            'UPDATE clip_tasks SET file_path = ?, part_path = ? WHERE id = ?',
            [filePath, partPath, task.id],
          )
          changed = true
        }
      }
      if (initialUserVersion < DATABASE_SCHEMA_VERSION) {
        this.db.run(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`)
        changed = true
      }

      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }

    // DDL above intentionally bypasses exec()/run(), otherwise idempotent
    // CREATE/PRAGMA statements would schedule a full sql.js export on every
    // launch. Persist only when a real schema/data migration occurred.
    if (changed) this.markDirtyOrFlush()
  }

  deleteReplayStreamCache(liveKey: string, reclaimFreePages = false) {
    const deleted = this.prepare(
      `DELETE FROM stream_slices
       WHERE replay_id IN (
         SELECT replay_id FROM bilibili_replays WHERE live_key = ?
       )`,
    ).run(liveKey).changes

    if (deleted > 0 && reclaimFreePages) {
      const autoVacuum = this.get<Record<string, unknown>>('PRAGMA auto_vacuum')
      if (safeNumber(autoVacuum?.auto_vacuum) === 2) {
        this.exec('PRAGMA incremental_vacuum')
      }
    }
    return deleted
  }

  async cleanupStreamCacheAndCompact() {
    const getCacheStats = () => this.prepare(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(LENGTH(CAST(m3_u8_text AS BLOB))), 0) AS m3u8_bytes
       FROM stream_slices`,
    ).get<{ rows: number; m3u8_bytes: number }>()
    const getFileSize = () => {
      try {
        return fs.statSync(this.filePath).size
      } catch {
        return 0
      }
    }
    const getLogicalFileSize = () => {
      const pageCount = this.get<Record<string, unknown>>('PRAGMA page_count')
      const pageSize = this.get<Record<string, unknown>>('PRAGMA page_size')
      return safeNumber(pageCount?.page_count) * safeNumber(pageSize?.page_size)
    }

    const before = getCacheStats()
    const beforeFileBytes = getFileSize()
    const beforeLogicalFileBytes = getLogicalFileSize()
    // The maintenance route rejects active/queued replay and clip work before
    // entering this method. Cached playlists are disposable discovery data and
    // are fetched again before a download starts, so retaining even
    // not_downloaded rows only leaves the largest part of old databases behind.
    const removedRows = this.withTransaction(() => this.prepare(
      'DELETE FROM stream_slices',
    ).run().changes)

    // DELETE only adds free pages to SQLite's freelist. Enabling incremental
    // auto-vacuum and rebuilding once makes this cleanup shrink the actual file
    // and lets short-lived downloader caches be reclaimed cheaply afterwards.
    this.exec('PRAGMA auto_vacuum = INCREMENTAL')
    this.exec('VACUUM')
    await this.checkpoint()

    const after = getCacheStats()
    const afterFileBytes = getFileSize()
    return {
      count: removedRows,
      removed_m3u8_bytes: Math.max(0, safeNumber(before?.m3u8_bytes) - safeNumber(after?.m3u8_bytes)),
      remaining_count: safeNumber(after?.rows),
      remaining_m3u8_bytes: safeNumber(after?.m3u8_bytes),
      before_file_bytes: beforeFileBytes,
      before_logical_file_bytes: beforeLogicalFileBytes,
      after_file_bytes: afterFileBytes,
      reclaimed_file_bytes: Math.max(0, beforeFileBytes - afterFileBytes),
    }
  }

  healDeletedReplays(baseDir = process.cwd()) {
    const unavailablePrefix = REPLAY_OUTPUT_UNAVAILABLE_PREFIX
    const ownershipPrefix = REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX
    const replays = this.prepare(
      `SELECT live_key, file_path, recoverable_part_path, cleanup_part_path, output_identity, message FROM bilibili_replays
       WHERE status = 'completed'`,
    ).all() as Array<{
      live_key: string
      file_path: string
      recoverable_part_path: string
      cleanup_part_path: string
      output_identity: string
      message: string
    }>
    let count = 0
    let updated = 0
    for (const r of replays) {
      if (!r.file_path) {
        const hasRecoveryDebt = Boolean(r.recoverable_part_path || r.cleanup_part_path)
        if (this.patchReplay(r.live_key, {
          status: hasRecoveryDebt ? 'failed' : 'not_downloaded',
          progress: hasRecoveryDebt ? 99 : 0,
          message: hasRecoveryDebt
            ? 'Completed row had no published output; retained recovery artifact is ready to retry'
            : 'Completed row had no local output; ready to download again',
          ...(!hasRecoveryDebt ? {
            output_identity: '',
            file_size: 0,
            resolution: '',
            bitrate: '',
            verify_ok: false,
            actual_duration: 0,
          } : {}),
        })) updated++
        count++
        continue
      }
      const resolvedPath = path.isAbsolute(r.file_path) ? r.file_path : path.resolve(baseDir, r.file_path)
      const usable = isUsableReplayOutput(resolvedPath, baseDir)
      const ownershipChanged = usable
        && Boolean(r.output_identity)
        && !fileMatchesIdentity(resolvedPath, r.output_identity)
      if (!usable || ownershipChanged) {
        // A detached external/network drive and a transient EACCES are
        // indistinguishable from a deleted file here.  Never forget ownership
        // merely because one stat attempt failed; otherwise reconnecting the
        // drive leaves an orphan and a retry downloads a suffixed duplicate.
        const nextMessage = `${ownershipChanged ? ownershipPrefix : unavailablePrefix} ${r.file_path}`
        count++
        if (r.message !== nextMessage) {
          this.prepare(
            `UPDATE bilibili_replays
             SET message = ?, updated_at = ?
             WHERE live_key = ?`,
          ).run(nextMessage, new Date().toISOString(), r.live_key)
          updated++
        }
      } else if (
        String(r.message || '').startsWith(unavailablePrefix)
        || String(r.message || '').startsWith(ownershipPrefix)
      ) {
        this.prepare(
          `UPDATE bilibili_replays SET message = '', updated_at = ? WHERE live_key = ?`,
        ).run(new Date().toISOString(), r.live_key)
        updated++
      }
    }
    if (updated > 0) this.flushSoon()
    return count
  }

  async healDeletedReplaysAsync(
    baseDir = process.cwd(),
    signal?: AbortSignal,
    options: { baseLocalOnly?: boolean } = {},
  ) {
    const unavailablePrefix = REPLAY_OUTPUT_UNAVAILABLE_PREFIX
    const ownershipPrefix = REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX
    const replays = this.prepare(
      `SELECT live_key, file_path, recoverable_part_path, cleanup_part_path, output_identity, message FROM bilibili_replays
       WHERE status = 'completed'`,
    ).all() as Array<{
      live_key: string
      file_path: string
      recoverable_part_path: string
      cleanup_part_path: string
      output_identity: string
      message: string
    }>
    let count = 0
    let updated = 0
    for (const replay of replays) {
      signal?.throwIfAborted()
      if (!replay.file_path) {
        const hasRecoveryDebt = Boolean(replay.recoverable_part_path || replay.cleanup_part_path)
        if (this.patchReplayIfStatus(replay.live_key, ['completed'], {
          status: hasRecoveryDebt ? 'failed' : 'not_downloaded',
          progress: hasRecoveryDebt ? 99 : 0,
          message: hasRecoveryDebt
            ? 'Completed row had no published output; retained recovery artifact is ready to retry'
            : 'Completed row had no local output; ready to download again',
          ...(!hasRecoveryDebt ? {
            output_identity: '',
            file_size: 0,
            resolution: '',
            bitrate: '',
            verify_ok: false,
            actual_duration: 0,
          } : {}),
        })) updated++
        count++
        continue
      }
      if (options.baseLocalOnly && !isStoredPathInsideBase(replay.file_path, baseDir)) continue
      const inspected = await inspectOutputAsync(replay.file_path, baseDir)
      signal?.throwIfAborted()
      const ownershipChanged = inspected.usable
        && Boolean(replay.output_identity)
        && inspected.identity !== replay.output_identity
      if (!inspected.usable || ownershipChanged) {
        count++
        const nextMessage = `${ownershipChanged ? ownershipPrefix : unavailablePrefix} ${replay.file_path}`
        if (replay.message !== nextMessage) {
          const result = this.prepare(
            `UPDATE bilibili_replays SET message = ?, updated_at = ?
             WHERE live_key = ? AND status = 'completed'
               AND COALESCE(file_path, '') = ? AND COALESCE(output_identity, '') = ?`,
          ).run(nextMessage, new Date().toISOString(), replay.live_key, replay.file_path, replay.output_identity)
          updated += result.changes
        }
      } else if (
        String(replay.message || '').startsWith(unavailablePrefix)
        || String(replay.message || '').startsWith(ownershipPrefix)
      ) {
        const result = this.prepare(
          `UPDATE bilibili_replays SET message = '', updated_at = ?
           WHERE live_key = ? AND status = 'completed'
             AND COALESCE(file_path, '') = ? AND COALESCE(output_identity, '') = ?`,
        ).run(new Date().toISOString(), replay.live_key, replay.file_path, replay.output_identity)
        updated += result.changes
      }
      if (replays.length > 50) await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (updated > 0) this.flushSoon()
    return count
  }

  cleanupCorruptedReplays() {
    const deleted = this.prepare(
      `DELETE FROM bilibili_replays
       WHERE COALESCE(live_key, '') = ''
         AND COALESCE(replay_id, 0) = 0
         AND COALESCE(title, '') = ''
         AND COALESCE(file_path, '') = ''
         AND COALESCE(recoverable_part_path, '') = ''
         AND COALESCE(cleanup_part_path, '') = ''`,
    ).run().changes
    return deleted
  }

  async adoptLegacyOutputIdentitiesAsync(
    baseDir = process.cwd(),
    signal?: AbortSignal,
    options: { baseLocalOnly?: boolean } = {},
  ) {
    const replayRows = this.prepare(
      `SELECT live_key, file_path
       FROM bilibili_replays
       WHERE legacy_identity_pending = 1
         AND portable_relocation_pending = 0
         AND status = 'completed'
         AND COALESCE(file_path, '') <> ''
         AND COALESCE(output_identity, '') = ''`,
    ).all() as Array<{ live_key: string; file_path: string }>
    const clipRows = this.prepare(
      `SELECT id, file_path
       FROM clip_tasks
       WHERE legacy_identity_pending = 1
         AND portable_relocation_pending = 0
         AND status = 'done'
         AND COALESCE(file_path, '') <> ''
         AND COALESCE(artifact_identity, '') = ''`,
    ).all() as Array<{ id: number; file_path: string }>
    let adopted = 0

    for (const replay of replayRows) {
      signal?.throwIfAborted()
      if (options.baseLocalOnly && !isStoredPathInsideBase(replay.file_path, baseDir)) continue
      const inspected = await inspectOutputAsync(replay.file_path, baseDir)
      signal?.throwIfAborted()
      if (inspected.usable && inspected.identity) {
        const result = this.prepare(
          `UPDATE bilibili_replays
           SET output_identity = ?, legacy_identity_pending = 0, updated_at = ?
           WHERE live_key = ? AND status = 'completed'
             AND legacy_identity_pending = 1 AND COALESCE(output_identity, '') = ''
             AND COALESCE(file_path, '') = ?`,
        ).run(inspected.identity, new Date().toISOString(), replay.live_key, replay.file_path)
        adopted += result.changes
      }
      if (replayRows.length + clipRows.length > 50) await new Promise<void>(resolve => setImmediate(resolve))
    }

    for (const task of clipRows) {
      signal?.throwIfAborted()
      if (options.baseLocalOnly && !isStoredPathInsideBase(task.file_path, baseDir)) continue
      const inspected = await inspectOutputAsync(task.file_path, baseDir)
      signal?.throwIfAborted()
      if (inspected.usable && inspected.identity) {
        const result = this.prepare(
          `UPDATE clip_tasks
           SET artifact_identity = ?, legacy_identity_pending = 0, updated_at = ?
           WHERE id = ? AND status = 'done'
             AND legacy_identity_pending = 1 AND COALESCE(artifact_identity, '') = ''
             AND COALESCE(file_path, '') = ?`,
        ).run(inspected.identity, new Date().toISOString(), task.id, task.file_path)
        adopted += result.changes
      }
      if (replayRows.length + clipRows.length > 50) await new Promise<void>(resolve => setImmediate(resolve))
    }

    if (adopted > 0) this.flushSoon()
    return adopted
  }

  getAppMetadata(key: string) {
    return String(this.prepare('SELECT value FROM app_metadata WHERE key = ?').get<{ value: string }>(key)?.value || '')
  }

  setAppMetadata(key: string, value: string) {
    const current = this.getAppMetadata(key)
    if (current === value) return false
    this.prepare(
      `INSERT INTO app_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value)
    return true
  }

  setReplayPortableRelocationPending(liveKey: string, pending: boolean) {
    const current = this.prepare(
      'SELECT portable_relocation_pending FROM bilibili_replays WHERE live_key = ?',
    ).get<{ portable_relocation_pending: number }>(liveKey)
    if (!current || boolFromDb(current.portable_relocation_pending) === pending) return false
    this.prepare(
      'UPDATE bilibili_replays SET portable_relocation_pending = ?, updated_at = ? WHERE live_key = ?',
    ).run(pending ? 1 : 0, new Date().toISOString(), liveKey)
    return true
  }

  cleanupStaleClipTasks() {
    const tasks = this.prepare(
      `SELECT id FROM clip_tasks
       WHERE status IN ('pending', 'processing', 'cancelling')
         AND COALESCE(file_path, '') = ''
         AND COALESCE(part_path, '') = ''
         AND COALESCE(artifact_state, '') = ''`,
    ).all() as Array<{ id: number }>
    for (const task of tasks) {
      this.updateClipTask(task.id, {
        status: 'error',
        message: 'App closed during processing',
        file_path: '',
        part_path: '',
        artifact_state: '',
        artifact_identity: '',
        part_identity: '',
      })
    }
    return tasks.length
  }

  healMissingClipFiles(baseDir = process.cwd()) {
    const unavailablePrefix = 'Output is currently unavailable; ownership path retained:'
    const outputOwnershipPrefix = 'Output ownership changed;'
    const workingOwnershipPrefix = 'Working-file ownership changed;'
    const workingFallbackPrefix = 'Published output is missing; verified working file was preserved:'
    const tasks = this.prepare(
      `SELECT id, file_path, part_path, artifact_state, artifact_identity, part_identity, status, message FROM clip_tasks
       WHERE status = 'done'
          OR message LIKE 'Output is currently unavailable; ownership path retained:%'
          OR message LIKE 'Output ownership changed;%'
          OR message LIKE 'Working-file ownership changed;%'
          OR message LIKE 'Published output is missing; verified working file was preserved:%'`,
    ).all() as Array<{ id: number; file_path: string; part_path: string; artifact_state: string; artifact_identity: string; part_identity: string; status: string; message: string }>
    const healedIds: number[] = []
    for (const task of tasks) {
      const filePath = String(task.file_path || '')
      const resolvedFilePath = filePath && !path.isAbsolute(filePath) ? path.resolve(baseDir, filePath) : filePath
      if (isUsableClipOutput(filePath, baseDir)) {
        if (task.artifact_identity && !fileMatchesIdentity(resolvedFilePath, task.artifact_identity)) {
          this.updateClipTask(task.id, {
            status: 'error',
            message: `Output ownership changed; the replacement path was preserved and was not accepted: ${resolvedFilePath}`,
          })
          healedIds.push(task.id)
          continue
        }
        if (
          String(task.message || '').startsWith(unavailablePrefix)
          || String(task.message || '').startsWith(outputOwnershipPrefix)
          || String(task.message || '').startsWith(workingOwnershipPrefix)
          || String(task.message || '').startsWith(workingFallbackPrefix)
        ) {
          this.updateClipTask(task.id, { status: 'done', progress: 100, message: '' })
          healedIds.push(task.id)
        }
        continue
      }
      const partPath = String(task.part_path || '')
      const resolvedPartPath = partPath && !path.isAbsolute(partPath) ? path.resolve(baseDir, partPath) : partPath
      if (isUsableClipOutput(partPath, baseDir)) {
        const expectedPartIdentity = task.part_identity || task.artifact_identity
        if (expectedPartIdentity && !fileMatchesIdentity(resolvedPartPath, expectedPartIdentity)) {
          this.updateClipTask(task.id, {
            status: 'error',
            message: `Working-file ownership changed; the replacement path was preserved: ${resolvedPartPath}`,
          })
          healedIds.push(task.id)
          continue
        }
        this.updateClipTask(task.id, {
          status: 'error',
          progress: 99,
          file_path: filePath,
          part_path: partPath,
          artifact_state: 'verified',
          part_identity: expectedPartIdentity,
          message: `Published output is missing; verified working file was preserved: ${resolvedPartPath}`,
        })
        healedIds.push(task.id)
        continue
      }
      const nextMessage = `${unavailablePrefix} ${resolvedFilePath}`
      if (task.message !== nextMessage) {
        this.updateClipTask(task.id, {
          // Preserve the durable path/identity.  A removable drive being absent
          // for one request must not turn a valid output into an untracked orphan.
          status: 'error',
          progress: 99,
          message: nextMessage,
        })
        healedIds.push(task.id)
      }
    }
    return healedIds
  }

  async healMissingClipFilesAsync(
    baseDir = process.cwd(),
    signal?: AbortSignal,
    options: { baseLocalOnly?: boolean } = {},
  ) {
    const unavailablePrefix = 'Output is currently unavailable; ownership path retained:'
    const outputOwnershipPrefix = 'Output ownership changed;'
    const workingOwnershipPrefix = 'Working-file ownership changed;'
    const workingFallbackPrefix = 'Published output is missing; verified working file was preserved:'
    const tasks = this.prepare(
      `SELECT id, file_path, part_path, artifact_state, artifact_identity, part_identity, status, message FROM clip_tasks
       WHERE status = 'done'
          OR message LIKE 'Output is currently unavailable; ownership path retained:%'
          OR message LIKE 'Output ownership changed;%'
          OR message LIKE 'Working-file ownership changed;%'
          OR message LIKE 'Published output is missing; verified working file was preserved:%'`,
    ).all() as Array<{
      id: number
      file_path: string
      part_path: string
      artifact_state: ClipTaskRecord['artifact_state']
      artifact_identity: string
      part_identity: string
      status: string
      message: string
    }>
    const healedIds: number[] = []
    for (const task of tasks) {
      signal?.throwIfAborted()
      if (
        options.baseLocalOnly
        && !isStoredPathInsideBase(task.file_path, baseDir)
        && !isStoredPathInsideBase(task.part_path, baseDir)
      ) continue
      const resolvedFilePath = task.file_path && !path.isAbsolute(task.file_path)
        ? path.resolve(baseDir, task.file_path)
        : task.file_path
      const resolvedPartPath = task.part_path && !path.isAbsolute(task.part_path)
        ? path.resolve(baseDir, task.part_path)
        : task.part_path
      const finalOutput = await inspectOutputAsync(task.file_path, baseDir)
      signal?.throwIfAborted()
      if (finalOutput.usable) {
        if (task.artifact_identity && finalOutput.identity !== task.artifact_identity) {
          this.updateClipTask(task.id, {
            status: 'error',
            message: `Output ownership changed; the replacement path was preserved and was not accepted: ${resolvedFilePath}`,
          })
          healedIds.push(task.id)
        } else if (
          String(task.message || '').startsWith(unavailablePrefix)
          || String(task.message || '').startsWith(outputOwnershipPrefix)
          || String(task.message || '').startsWith(workingOwnershipPrefix)
          || String(task.message || '').startsWith(workingFallbackPrefix)
        ) {
          this.updateClipTask(task.id, { status: 'done', progress: 100, message: '' })
          healedIds.push(task.id)
        }
        continue
      }

      const partOutput = await inspectOutputAsync(task.part_path, baseDir)
      signal?.throwIfAborted()
      if (partOutput.usable) {
        const expectedPartIdentity = task.part_identity || task.artifact_identity
        if (expectedPartIdentity && partOutput.identity !== expectedPartIdentity) {
          this.updateClipTask(task.id, {
            status: 'error',
            message: `Working-file ownership changed; the replacement path was preserved: ${resolvedPartPath}`,
          })
        } else {
          this.updateClipTask(task.id, {
            status: 'error',
            progress: 99,
            file_path: task.file_path,
            part_path: task.part_path,
            artifact_state: 'verified',
            part_identity: expectedPartIdentity,
            message: `Published output is missing; verified working file was preserved: ${resolvedPartPath}`,
          })
        }
        healedIds.push(task.id)
        continue
      }

      const nextMessage = `${unavailablePrefix} ${resolvedFilePath}`
      if (task.message !== nextMessage) {
        this.updateClipTask(task.id, { status: 'error', progress: 99, message: nextMessage })
        healedIds.push(task.id)
      }
      if (tasks.length > 50) await new Promise<void>(resolve => setImmediate(resolve))
    }
    return healedIds
  }

  getReplays(baseDir: string): ReplayRecord[] {
    const replayRows = this.prepare(
      `SELECT *
       FROM bilibili_replays
       WHERE deleted_at IS NULL
       ORDER BY start_time DESC`,
    ).all() as Record<string, unknown>[]
    
    // List and UI-facing callers only need metadata. M3U8 bodies can be several
    // megabytes per replay and must stay behind the downloader-only lookup.
    return replayRows.map(row => this.mapReplayRow(baseDir, row))
  }

  getKnownReplayStorageBytes(): number {
    const row = this.prepare(
      `SELECT COALESCE(SUM(file_size), 0) AS total_bytes
       FROM bilibili_replays
       WHERE deleted_at IS NULL
         AND COALESCE(file_path, '') <> ''
         AND COALESCE(file_size, 0) > 0`,
    ).get<{ total_bytes: number }>()
    return Math.max(0, safeNumber(row?.total_bytes))
  }

  getReplaySummaryByLiveKey(baseDir: string, liveKey: string) {
    const row = this.prepare(
      `SELECT * FROM bilibili_replays WHERE live_key = ? AND deleted_at IS NULL`,
    ).get<Record<string, unknown>>(liveKey)
    return row ? this.mapReplayRow(baseDir, row) : null
  }

  getReplayByLiveKey(baseDir: string, liveKey: string) {
    const row = this.prepare(
      `SELECT * FROM bilibili_replays WHERE live_key = ? AND deleted_at IS NULL`,
    ).get<Record<string, unknown>>(liveKey)
    if (!row) return null

    const replayId = safeNumber(row.replay_id)
    const streams = this.prepare(
      `SELECT id, replay_id, start_time, end_time, stream, type, m3_u8_text
       FROM stream_slices
       WHERE replay_id = ? AND deleted_at IS NULL
       ORDER BY id ASC`,
    ).all<Record<string, unknown>>(replayId)

    const streamSlices: StreamSlice[] = streams.map(s => ({
      id: safeNumber(s.id),
      replay_id: safeNumber(s.replay_id),
      start_time: safeNumber(s.start_time),
      end_time: safeNumber(s.end_time),
      stream: String(s.stream || ''),
      type: safeNumber(s.type),
      m3u8_text: String(s.m3_u8_text || ''),
    }))

    return this.mapReplayRow(baseDir, row, streamSlices)
  }

  private mapReplayRow(baseDir: string, row: Record<string, unknown>, streams: StreamSlice[] = []): ReplayRecord {
    let filePath = String(row.file_path || '')
    if (filePath && !path.isAbsolute(filePath)) {
      filePath = resolveAppPathWithBase(baseDir, filePath)
    }
    const status = String(row.status || 'not_downloaded')
    const message = String(row.message || '')
    const outputIdentity = String(row.output_identity || '')
    const portableRelocationPending = boolFromDb(row.portable_relocation_pending)
    const hasTrackedArtifactPath = Boolean(
      filePath
      || String(row.recoverable_part_path || '')
      || String(row.cleanup_part_path || ''),
    )
    const outputState: ReplayRecord['output_state'] = portableRelocationPending && hasTrackedArtifactPath
      ? 'unknown'
      : status !== 'completed'
      ? 'not_applicable'
      : !filePath
        ? 'unavailable'
      : message.startsWith(REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX)
        ? 'ownership_changed'
        : message.startsWith(REPLAY_OUTPUT_UNAVAILABLE_PREFIX)
          ? 'unavailable'
          : outputIdentity
            ? 'available'
            : 'unknown'

    return {
      ID: safeNumber(row.id),
      UpdatedAt: String(row.updated_at || ''),
      replay_id: safeNumber(row.replay_id),
      live_key: String(row.live_key || ''),
      room_id: safeNumber(row.room_id),
      title: String(row.title || ''),
      start_time: safeNumber(row.start_time),
      end_time: safeNumber(row.end_time),
      duration: safeNumber(row.duration),
      file_path: filePath,
      recoverable_part_path: String(row.recoverable_part_path || ''),
      recoverable_state: String(row.recoverable_state || '') as ReplayRecord['recoverable_state'],
      cleanup_part_path: String(row.cleanup_part_path || ''),
      output_identity: outputIdentity,
      cleanup_part_identity: String(row.cleanup_part_identity || ''),
      cover_url: String(row.cover_url || ''),
      local_cover: String(row.local_cover || ''),
      file_size: safeNumber(row.file_size),
      resolution: String(row.resolution || ''),
      bitrate: String(row.bitrate || ''),
      progress: safeNumber(row.progress),
      speed: String(row.speed || ''),
      elapsed: String(row.elapsed || ''),
      eta: String(row.eta || ''),
      status: status,
      message,
      output_state: outputState,
      verify_ok: boolFromDb(row.verify_ok),
      actual_duration: safeNumber(row.actual_dur),
      portable_relocation_pending: portableRelocationPending,
      streams,
    } satisfies ReplayRecord
  }

  patchReplay(liveKey: string, patch: ReplayPatch) {
    return this.patchReplayInternal(liveKey, patch)
  }

  patchReplayIfStatus(liveKey: string, allowedStatuses: readonly string[], patch: ReplayPatch) {
    if (allowedStatuses.length === 0) return false
    return this.patchReplayInternal(liveKey, patch, allowedStatuses)
  }

  private patchReplayInternal(liveKey: string, patch: ReplayPatch, allowedStatuses?: readonly string[]) {
    const currentRow = this.prepare('SELECT * FROM bilibili_replays WHERE live_key = ?').get<Record<string, unknown>>(liveKey)
    if (!currentRow) return false
    const currentStatus = String(currentRow.status || 'not_downloaded')
    if (allowedStatuses && !allowedStatuses.includes(currentStatus)) return false
    const next = {
      ...currentRow,
      ...patch,
    }
    const previousUpdatedAt = Date.parse(String(currentRow.updated_at || ''))
    const nextUpdatedAt = Number.isFinite(previousUpdatedAt) && previousUpdatedAt >= Date.now()
      ? previousUpdatedAt + 1
      : Date.now()
    const condition = allowedStatuses ? ' AND status = ?' : ''
    const result = this.prepare(
      `UPDATE bilibili_replays
       SET replay_id = ?,
           room_id = ?,
           title = ?,
           start_time = ?,
           end_time = ?,
           duration = ?,
           cover_url = ?,
           local_cover = ?,
            file_path = ?,
            recoverable_part_path = ?,
            recoverable_state = ?,
             cleanup_part_path = ?,
             output_identity = ?,
             cleanup_part_identity = ?,
           file_size = ?,
           resolution = ?,
           bitrate = ?,
           progress = ?,
           speed = ?,
           elapsed = ?,
           eta = ?,
           status = ?,
           message = ?,
           verify_ok = ?,
           actual_dur = ?,
           updated_at = ?
       WHERE live_key = ?${condition}`,
    ).run(
      next.replay_id ?? 0,
      next.room_id ?? 0,
      next.title ?? '',
      next.start_time ?? 0,
      next.end_time ?? 0,
      next.duration ?? 0,
      next.cover_url ?? '',
      next.local_cover ?? '',
      this.toDurablePath(next.file_path),
      this.toDurablePath(next.recoverable_part_path),
      next.recoverable_state ?? '',
      this.toDurablePath(next.cleanup_part_path),
      next.output_identity ?? '',
      next.cleanup_part_identity ?? '',
      next.file_size ?? 0,
      next.resolution ?? '',
      next.bitrate ?? '',
      next.progress ?? 0,
      next.speed ?? '',
      next.elapsed ?? '',
      next.eta ?? '',
      next.status ?? 'not_downloaded',
      next.message ?? '',
      next.verify_ok ? 1 : 0,
      patch.actual_duration ?? safeNumber(currentRow.actual_dur),
      new Date(nextUpdatedAt).toISOString(),
      liveKey,
      ...(allowedStatuses ? [currentStatus] : []),
    )
    const changed = result.changes > 0
    if (changed && patch.status !== undefined && patch.status !== currentStatus) this.flushSoon()
    return changed
  }

  // --- Clip Tasks ---
  createClipTask(task: Omit<ClipTaskRecord, 'id' | 'created_at' | 'updated_at' | 'progress' | 'status' | 'message' | 'file_path' | 'part_path' | 'artifact_state' | 'artifact_identity' | 'part_identity' | 'portable_relocation_pending'>): number {
    const now = new Date().toISOString()
    this.prepare(
      `INSERT INTO clip_tasks (created_at, updated_at, url, title, start_time, end_time, status, progress) 
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`
    ).run(now, now, task.url, task.title, task.start_time, task.end_time)
    this.flushSoon()
    
    const lastInsert = this.get<{ id: number }>('SELECT last_insert_rowid() AS id')
    return lastInsert?.id || 0
  }

  insertReplay(data: Partial<ReplayRecord> & { live_key: string }) {
    const now = new Date().toISOString()
    this.prepare(
      `INSERT INTO bilibili_replays (
         created_at, updated_at, replay_id, live_key, room_id, title, start_time, end_time, duration,
         cover_url, local_cover, file_path, recoverable_part_path, recoverable_state, cleanup_part_path, output_identity, cleanup_part_identity, file_size, resolution, bitrate, progress, speed, elapsed, eta,
         status, message, verify_ok, actual_dur
       ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?
       )`
    ).run(
      now, now, data.replay_id || 0, data.live_key, data.room_id || 0, data.title || '', data.start_time || 0, data.end_time || 0, data.duration || 0,
       data.cover_url || '', data.local_cover || '', this.toDurablePath(data.file_path), this.toDurablePath(data.recoverable_part_path), data.recoverable_state || '', this.toDurablePath(data.cleanup_part_path), data.output_identity || '', data.cleanup_part_identity || '', data.file_size || 0, data.resolution || '', data.bitrate || '', data.progress || 0, data.speed || '', data.elapsed || '', data.eta || '',
      data.status || 'not_downloaded', data.message || '', data.verify_ok ? 1 : 0, data.actual_duration || 0
    )
    this.flushSoon()
  }

  updateClipTask(id: number, patch: Partial<Pick<ClipTaskRecord, 'status' | 'progress' | 'message' | 'file_path' | 'part_path' | 'artifact_state' | 'artifact_identity' | 'part_identity' | 'portable_relocation_pending'>>) {
    const updates: string[] = []
    const params: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      updates.push(`${k} = ?`)
      params.push(
        k === 'file_path' || k === 'part_path'
          ? this.toDurablePath(v)
          : k === 'portable_relocation_pending'
            ? (v ? 1 : 0)
            : v,
      )
    }
    if (updates.length === 0) return
    const current = this.prepare('SELECT updated_at, status FROM clip_tasks WHERE id = ?')
      .get<{ updated_at: string; status: string }>(id)
    const previousUpdatedAt = Date.parse(String(current?.updated_at || ''))
    const nextUpdatedAt = Number.isFinite(previousUpdatedAt) && previousUpdatedAt >= Date.now()
      ? previousUpdatedAt + 1
      : Date.now()
    updates.push('updated_at = ?')
    params.push(new Date(nextUpdatedAt).toISOString())
    params.push(id)
    
    this.prepare(`UPDATE clip_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    if (patch.status !== undefined && patch.status !== current?.status) this.flushSoon()
  }

  getClipTasks(limit?: number): ClipTaskRecord[] {
    const boundedLimit = limit === undefined ? 0 : Math.max(1, Math.min(2_000, Math.floor(limit)))
    const rows = boundedLimit > 0
      ? [
        ...this.prepare(
          `SELECT * FROM clip_tasks
           WHERE status IN ('pending', 'processing', 'cancelling') OR COALESCE(artifact_state, '') <> ''`,
        ).all<Record<string, unknown>>(),
        ...this.prepare(
          `SELECT * FROM clip_tasks
           WHERE status NOT IN ('pending', 'processing', 'cancelling') AND COALESCE(artifact_state, '') = ''
           ORDER BY created_at DESC LIMIT ?`,
        ).all<Record<string, unknown>>(boundedLimit),
      ].sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))
      : this.prepare('SELECT * FROM clip_tasks ORDER BY created_at DESC').all()
    return (rows as Record<string, unknown>[]).map(row => mapClipTaskRow(row, this.applicationBaseDir))
  }

  getClipTaskById(id: number): ClipTaskRecord | undefined {
    const row = this.prepare('SELECT * FROM clip_tasks WHERE id = ?').get<Record<string, unknown>>(id)
    return row ? mapClipTaskRow(row, this.applicationBaseDir) : undefined
  }
}
