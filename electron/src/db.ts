import fs from 'node:fs'
import fsp from 'node:fs/promises'
import initSqlJs, { type BindParams, type Database as SqlDatabase } from 'sql.js'
import { ReplayRecord, StreamSlice, ClipTaskRecord } from './types'
import { safeNumber, boolFromDb } from './utils'
import { resolveAppPathWithBase } from './config'
import path from 'node:path'

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
  private isFlushing = false

  private constructor(
    private readonly filePath: string,
    private readonly db: SqlDatabase,
  ) {}

  static async open(filePath: string) {
    const SQL = await initSqlJs({
      locateFile: file => require.resolve(`sql.js/dist/${file}`).replace('app.asar', 'app.asar.unpacked'),
    })
    const db = fs.existsSync(filePath)
      ? new SQL.Database(fs.readFileSync(filePath))
      : new SQL.Database()
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.dirty || this.isFlushing) {
      if (!this.isFlushing && this.dirty) {
        await this.flushNow()
      } else {
        await new Promise(r => setTimeout(r, 50))
      }
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

  private markDirtyOrFlush() {
    this.dirty = true
    if (this.batchDepth > 0) {
      return
    }
    if (!this.flushTimer && !this.isFlushing) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flushNow()
      }, 500)
    }
  }

  private async flushNow() {
    if (this.isFlushing || !this.dirty) return
    this.isFlushing = true
    this.dirty = false
    try {
      const data = this.db.export()
      const tempPath = `${this.filePath}.tmp`
      await fsp.writeFile(tempPath, Buffer.from(data))
      await fsp.rename(tempPath, this.filePath)
    } catch (err) {
      console.error('Failed to flush database to disk:', err)
      this.dirty = true // Try again later
    } finally {
      this.isFlushing = false
      if (this.dirty && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null
          void this.flushNow()
        }, 500)
      }
    }
  }

  ensureSchema() {
    this.exec(`
      CREATE TABLE IF NOT EXISTS bilibili_replays (
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
      );
      CREATE TABLE IF NOT EXISTS stream_slices (
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
      );
      CREATE TABLE IF NOT EXISTS clip_tasks (
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
      );
    `)
  }

  cleanupCorruptedReplays() {
    const deleted = this.prepare(
      `DELETE FROM bilibili_replays
       WHERE COALESCE(live_key, '') = ''
         AND COALESCE(replay_id, 0) = 0
         AND COALESCE(title, '') = ''
         AND COALESCE(file_path, '') = ''`,
    ).run().changes
    return deleted
  }

  getReplays(baseDir: string): ReplayRecord[] {
    const replayRows = this.prepare(
      `SELECT *
       FROM bilibili_replays
       WHERE deleted_at IS NULL
       ORDER BY start_time DESC`,
    ).all() as Record<string, unknown>[]
    
    const streams = this.prepare(
      `SELECT id, replay_id, start_time, end_time, stream, type, m3_u8_text
       FROM stream_slices
       WHERE deleted_at IS NULL
       ORDER BY id ASC`,
    ).all() as Record<string, unknown>[]

    const streamMap = new Map<number, StreamSlice[]>()
    for (const stream of streams) {
      const replayId = safeNumber(stream.replay_id)
      const list = streamMap.get(replayId) ?? []
      list.push({
        id: safeNumber(stream.id),
        replay_id: replayId,
        start_time: safeNumber(stream.start_time),
        end_time: safeNumber(stream.end_time),
        stream: String(stream.stream || ''),
        type: safeNumber(stream.type),
        m3u8_text: String(stream.m3_u8_text || ''),
      })
      streamMap.set(replayId, list)
    }

    return replayRows.map(row => {
      let filePath = String(row.file_path || '')
      if (filePath && !path.isAbsolute(filePath)) {
        filePath = resolveAppPathWithBase(baseDir, filePath)
      }
      if (filePath && !fs.existsSync(filePath) && ['completed', 'deleted'].includes(String(row.status || ''))) {
        filePath = ''
      }
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
        cover_url: String(row.cover_url || ''),
        local_cover: String(row.local_cover || ''),
        file_size: safeNumber(row.file_size),
        resolution: String(row.resolution || ''),
        bitrate: String(row.bitrate || ''),
        progress: safeNumber(row.progress),
        speed: String(row.speed || ''),
        elapsed: String(row.elapsed || ''),
        eta: String(row.eta || ''),
        status: String(row.status || 'not_downloaded'),
        message: String(row.message || ''),
        verify_ok: boolFromDb(row.verify_ok),
        actual_duration: safeNumber(row.actual_dur),
        streams: streamMap.get(safeNumber(row.replay_id)) ?? [],
      } satisfies ReplayRecord
    })
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

    let filePath = String(row.file_path || '')
    if (filePath && !path.isAbsolute(filePath)) {
      filePath = resolveAppPathWithBase(baseDir, filePath)
    }
    if (filePath && !fs.existsSync(filePath) && ['completed', 'deleted'].includes(String(row.status || ''))) {
      filePath = ''
    }

    return {
      ID: safeNumber(row.id),
      UpdatedAt: String(row.updated_at || ''),
      replay_id: replayId,
      live_key: String(row.live_key || ''),
      room_id: safeNumber(row.room_id),
      title: String(row.title || ''),
      start_time: safeNumber(row.start_time),
      end_time: safeNumber(row.end_time),
      duration: safeNumber(row.duration),
      file_path: filePath,
      cover_url: String(row.cover_url || ''),
      local_cover: String(row.local_cover || ''),
      file_size: safeNumber(row.file_size),
      resolution: String(row.resolution || ''),
      bitrate: String(row.bitrate || ''),
      progress: safeNumber(row.progress),
      speed: String(row.speed || ''),
      elapsed: String(row.elapsed || ''),
      eta: String(row.eta || ''),
      status: String(row.status || 'not_downloaded'),
      message: String(row.message || ''),
      verify_ok: boolFromDb(row.verify_ok),
      actual_duration: safeNumber(row.actual_dur),
      streams: streamSlices,
    } satisfies ReplayRecord
  }

  patchReplay(
    liveKey: string,
    patch: Partial<Pick<ReplayRecord, 'file_path' | 'file_size' | 'resolution' | 'bitrate' | 'progress' | 'speed' | 'elapsed' | 'eta' | 'status' | 'message' | 'verify_ok' | 'actual_duration'>>,
  ) {
    const currentRow = this.prepare('SELECT * FROM bilibili_replays WHERE live_key = ?').get<Record<string, unknown>>(liveKey)
    if (!currentRow) return null
    const next = {
      ...currentRow,
      ...patch,
    }
    this.prepare(
      `UPDATE bilibili_replays
       SET file_path = ?,
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
       WHERE live_key = ?`,
    ).run(
      next.file_path ?? '',
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
      (next as any).actual_dur ?? next.actual_duration ?? 0,
      new Date().toISOString(),
      liveKey,
    )
    return true
  }

  // --- Clip Tasks ---
  createClipTask(task: Omit<ClipTaskRecord, 'id' | 'created_at' | 'updated_at' | 'progress' | 'status' | 'message' | 'file_path'>): number {
    const now = new Date().toISOString()
    this.prepare(
      `INSERT INTO clip_tasks (created_at, updated_at, url, title, start_time, end_time, status, progress) 
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`
    ).run(now, now, task.url, task.title, task.start_time, task.end_time)
    
    const lastInsert = this.get<{ id: number }>('SELECT last_insert_rowid() AS id')
    return lastInsert?.id || 0
  }

  updateClipTask(id: number, patch: Partial<Pick<ClipTaskRecord, 'status' | 'progress' | 'message' | 'file_path'>>) {
    const updates: string[] = []
    const params: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      updates.push(`${k} = ?`)
      params.push(v)
    }
    if (updates.length === 0) return
    updates.push('updated_at = ?')
    params.push(new Date().toISOString())
    params.push(id)
    
    this.prepare(`UPDATE clip_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  }

  getClipTasks(): ClipTaskRecord[] {
    const rows = this.prepare('SELECT * FROM clip_tasks ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(r => ({
      id: safeNumber(r.id),
      created_at: String(r.created_at || ''),
      updated_at: String(r.updated_at || ''),
      url: String(r.url || ''),
      title: String(r.title || ''),
      start_time: safeNumber(r.start_time),
      end_time: safeNumber(r.end_time),
      file_path: String(r.file_path || ''),
      status: String(r.status || 'pending') as ClipTaskRecord['status'],
      progress: safeNumber(r.progress),
      message: String(r.message || '')
    }))
  }
}

