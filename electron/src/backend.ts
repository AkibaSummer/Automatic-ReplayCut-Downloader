import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import express, { type Response } from 'express'
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { parseFile } from 'music-metadata'
import initSqlJs, { type BindParams, type Database as SqlDatabase } from 'sql.js'
import YAML from 'yaml'
import { WebSocketServer } from 'ws'

type AppConfig = {
  bilibili: {
    anchor_id: number
    cookies: Record<string, string>
    cookie_file: string
  }
  download: {
    output_dir: string
    temp_dir: string
    filename_template: string
    max_concurrent_tasks: number
    concurrent_segments: number
  }
  database: {
    dsn: string
  }
  server: {
    port: number
  }
}

type ReplayRecord = {
  ID: number
  UpdatedAt: string
  replay_id: number
  live_key: string
  room_id: number
  title: string
  start_time: number
  end_time: number
  duration: number
  file_path: string
  cover_url: string
  local_cover: string
  file_size: number
  resolution: string
  bitrate: string
  progress: number
  speed: string
  elapsed: string
  eta: string
  status: string
  message: string
  verify_ok: boolean
  actual_duration: number
  streams: StreamSlice[]
}

type StreamSlice = {
  replay_id: number
  start_time: number
  end_time: number
  stream: string
  type: number
  m3u8_text: string
}

type RuntimeSnapshot = {
  paused: boolean
  max_concurrent_tasks: number
  concurrent_segments: number
  downloading_tasks: number
  queued_tasks: number
  paused_tasks: number
  failed_tasks: number
}

type ScanSummary = {
  fetched: number
  new_records: number
  updated_records: number
  covers_updated: number
  marked_deleted: number
  already_up_to_date: number
}

type ProgressUpdate = {
  live_key: string
  progress: number
  merge_progress: number
  status: string
  message: string
  speed: string
  speed_history: number[]
  elapsed: string
  eta: string
}

type TaskHandle = {
  controller: AbortController
  promise: Promise<void>
}

type FileInfo = {
  size: number
  resolution: string
  bitrate: string
}

type M3U8Segment = {
  url: string
  duration: number
}

const DEFAULT_CONFIG: AppConfig = {
  bilibili: {
    anchor_id: 0,
    cookies: {},
    cookie_file: 'cookies.json',
  },
  download: {
    output_dir: 'downloads',
    temp_dir: 'temp',
    filename_template: '{yy}-{MM}-{dd} {start:150405} {title}.mp4',
    max_concurrent_tasks: 2,
    concurrent_segments: 5,
  },
  database: {
    dsn: 'replays.db',
  },
  server: {
    port: 8081,
  },
}

const START_LAYOUT_RE = /\{start:([^}]+)\}/g
const END_LAYOUT_RE = /\{end:([^}]+)\}/g
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

function formatSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(patch)) {
    return (patch ?? base) as T
  }
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) {
    return (patch ?? base) as T
  }
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key]
    next[key] = deepMerge(current as never, value as never)
  }
  return next as T
}

function sanitizeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function renderFilenameTemplate(template: string, replay: ReplayRecord) {
  const start = new Date(replay.start_time * 1000)
  const end = new Date(replay.end_time * 1000)
  let out = template

  out = out.replace(START_LAYOUT_RE, (_, layout: string) => formatDate(start, layout))
  out = out.replace(END_LAYOUT_RE, (_, layout: string) => formatDate(end, layout))
  out = out
    .replaceAll('{title}', replay.title)
    .replaceAll('{live_key}', replay.live_key)
    .replaceAll('{yyyy}', `${start.getFullYear()}`)
    .replaceAll('{yy}', formatDate(start, '06'))
    .replaceAll('{MM}', formatDate(start, '01'))
    .replaceAll('{dd}', formatDate(start, '02'))
    .replaceAll('{start}', formatDate(start, '2006-01-02 15-04-05'))
    .replaceAll('{end}', formatDate(end, '2006-01-02 15-04-05'))
    .replaceAll('{start_unix}', `${replay.start_time}`)
    .replaceAll('{end_unix}', `${replay.end_time}`)

  return sanitizeFilename(out || replay.live_key)
}

function formatDate(date: Date, layout: string) {
  const tokens: Record<string, string> = {
    '2006': `${date.getFullYear()}`,
    '06': `${date.getFullYear()}`.slice(-2),
    '01': `${date.getMonth() + 1}`.padStart(2, '0'),
    '02': `${date.getDate()}`.padStart(2, '0'),
    '15': `${date.getHours()}`.padStart(2, '0'),
    '04': `${date.getMinutes()}`.padStart(2, '0'),
    '05': `${date.getSeconds()}`.padStart(2, '0'),
  }
  let out = layout
  for (const [token, value] of Object.entries(tokens)) {
    out = out.replaceAll(token, value)
  }
  return out
}

function uniquePath(targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    return targetPath
  }
  const ext = path.extname(targetPath)
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath, ext)
  for (let i = 1; i < 10000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) {
      return candidate
    }
  }
  return targetPath
}

function safeNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function boolFromDb(value: unknown) {
  return value === 1 || value === '1' || value === true
}

function detectBaseDir(fallbackCwd: string) {
  const envDir = process.env.APP_BASE_DIR?.trim()
  if (envDir) {
    return path.resolve(envDir)
  }
  const cwdConfig = path.join(fallbackCwd, 'config.yaml')
  if (fs.existsSync(cwdConfig)) {
    return fallbackCwd
  }
  const exeDir = path.dirname(process.execPath)
  if (fs.existsSync(path.join(exeDir, 'config.yaml'))) {
    return exeDir
  }
  return fallbackCwd
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
    return single as BindParams
  }
  return paramsRaw as unknown as BindParams
}

class SqlStatement {
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

class SqliteStore {
  private batchDepth = 0

  private dirty = false

  private constructor(
    private readonly filePath: string,
    private readonly db: SqlDatabase,
  ) {}

  static async open(filePath: string) {
    const SQL = await initSqlJs({
      locateFile: file => require.resolve(`sql.js/dist/${file}`),
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

  close() {
    if (this.dirty) {
      this.flush()
      this.dirty = false
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
        this.flush()
        this.dirty = false
      }
    }
  }

  private markDirtyOrFlush() {
    if (this.batchDepth > 0) {
      this.dirty = true
      return
    }
    this.flush()
    this.dirty = false
  }

  private flush() {
    fs.writeFileSync(this.filePath, Buffer.from(this.db.export()))
  }
}

class DesktopBackend {
  private readonly baseDir: string

  private readonly configPath: string

  private config: AppConfig

  private readonly db: SqliteStore

  private readonly cookies = new Map<string, string>()

  private readonly app = express()

  private readonly server = http.createServer(this.app)

  private readonly wss = new WebSocketServer({ noServer: true })

  private runtimePaused = false

  private readonly activeTasks = new Map<string, TaskHandle>()

  private readonly pausedTasks = new Set<string>()

  private runningTasks = 0

  private readonly queue: string[] = []

  private diskStatsCache:
    | {
        value: {
          path: string
          total_bytes: number
          free_bytes: number
          used_by_service_bytes: number
        }
        expiresAt: number
      }
    | null = null

  private diskStatsPromise: Promise<{
    path: string
    total_bytes: number
    free_bytes: number
    used_by_service_bytes: number
  }> | null = null

  private constructor(baseDir: string, config: AppConfig, db: SqliteStore) {
    this.baseDir = baseDir
    this.configPath = path.join(baseDir, 'config.yaml')
    this.config = config
    this.ensureDir(this.config.download.output_dir)
    this.ensureDir(this.config.download.temp_dir)
    this.ensureDir(path.join(this.config.download.output_dir, 'covers'))
    this.loadCookies()
    this.db = db
    this.ensureSchema()
    this.app.use(express.json({ limit: '2mb' }))
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      if (req.method === 'OPTIONS') {
        res.status(204).end()
        return
      }
      next()
    })
    this.registerRoutes()
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        ws.send(JSON.stringify({ live_key: '', progress: 0, merge_progress: 0, status: 'idle', message: 'connected', speed: '', speed_history: [], elapsed: '', eta: '' }))
      })
    })
  }

  static async create(baseDir: string) {
    const configPath = path.join(baseDir, 'config.yaml')
    const config = DesktopBackend.loadConfigFile(baseDir, configPath)
    const db = await SqliteStore.open(config.database.dsn)
    return new DesktopBackend(baseDir, config, db)
  }

  async listen() {
    this.cleanupCorruptedReplays()
    await new Promise<void>(resolve => {
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    this.recoverInterruptedTasks()
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to resolve backend port')
    }
    return `http://127.0.0.1:${addr.port}`
  }

  private cleanupCorruptedReplays() {
    const deleted = this.db
      .prepare(
        `DELETE FROM bilibili_replays
         WHERE COALESCE(live_key, '') = ''
           AND COALESCE(replay_id, 0) = 0
           AND COALESCE(title, '') = ''
           AND COALESCE(file_path, '') = ''`,
      )
      .run().changes
    if (deleted > 0) {
      // corrupted rows cleaned
    }
  }

  async stop() {
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    this.db.close()
  }

  private registerRoutes() {
    this.app.get('/api/health', (_req, res) => {
      res.json({ ok: true })
    })

    this.app.get('/api/runtime', (_req, res) => {
      res.json(this.getRuntime())
    })

    this.app.get('/api/config', (_req, res) => {
      res.json(this.config)
    })

    this.app.post('/api/config', async (req, res) => {
      try {
        const previous = this.config
        const incoming = req.body as Partial<AppConfig>
        const next = deepMerge(this.config, incoming)
        next.server = previous.server
        next.database = previous.database
        this.config = this.normalizeConfig(next)
        this.ensureDir(this.config.download.output_dir)
        this.ensureDir(this.config.download.temp_dir)
        this.ensureDir(path.join(this.config.download.output_dir, 'covers'))
        await this.saveConfig()
        res.setHeader('x-migrated-files', '0')
        res.setHeader('x-renamed-files', '0')
        res.json(this.config)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/replays', (_req, res) => {
      try {
        res.json(this.getReplays())
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/me', async (_req, res) => {
      try {
        const me = await this.getCurrentUser()
        res.json(me)
      } catch {
        res.json({ logged_in: false, uname: '', face: '' })
      }
    })

    this.app.get('/api/login/qr', async (_req, res) => {
      try {
        const data = await this.fetchJSON<{
          code: number
          message: string
          data: { url: string; qrcode_key: string }
        }>('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
        if (data.code !== 0) {
          throw new Error(data.message || 'Generate QR failed')
        }
        res.json(data.data)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/login/poll', async (req, res) => {
      try {
        const key = String(req.query.qrcode_key || '')
        if (!key) {
          res.status(400).json({ error: 'missing qrcode_key' })
          return
        }
        const data = await this.fetchJSON<{
          data: { code: number }
        }>(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`)
        await this.saveCookies()
        res.json({ code: safeNumber(data?.data?.code) })
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.post('/api/scan', async (_req, res) => {
      try {
        const summary = await this.scanReplays()
        res.json(summary)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.post('/api/pause-all', (_req, res) => {
      const count = this.pauseAll()
      res.json({ ok: true, count })
    })

    this.app.post('/api/resume-all', (_req, res) => {
      const count = this.resumeAll()
      res.json({ ok: true, count })
    })

    this.app.post('/api/cleanup-stale', (_req, res) => {
      const result = this.db
        .prepare(
          `UPDATE bilibili_replays
           SET status = 'paused',
               message = 'Reset by cleanup-stale',
               progress = 0,
               speed = '',
               elapsed = '',
               eta = '',
               updated_at = ?
           WHERE status IN ('pending', 'downloading', 'merging')`,
        )
        .run(new Date().toISOString())
      res.json({ count: result.changes })
    })

    this.app.post('/api/cleanup-streams', (_req, res) => {
      const result = this.db.prepare('DELETE FROM stream_slices WHERE replay_id NOT IN (SELECT replay_id FROM bilibili_replays)').run()
      res.json({ count: result.changes })
    })

    this.app.post('/api/sync-all', (_req, res) => {
      const count = this.syncAllPending()
      res.json({ ok: true, count })
    })

    this.app.post('/api/download-unfinished', (_req, res) => {
      const count = this.downloadUnfinished()
      res.json({ ok: true, count })
    })

    this.app.post('/api/retry-failed', (_req, res) => {
      const count = this.retryFailed()
      res.json({ ok: true, count })
    })

    this.app.post('/api/replays/:liveKey/download', (req, res) => {
      const replay = this.getReplayByLiveKey(String(req.params.liveKey))
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      this.pausedTasks.delete(replay.live_key)
      this.enqueueReplay(replay.live_key, { resetProgress: replay.status !== 'paused', message: 'Queued' })
      res.json({ ok: true })
    })

    this.app.post('/api/replays/:liveKey/pause', (req, res) => {
      const ok = this.pauseReplay(String(req.params.liveKey))
      res.json({ ok })
    })

    this.app.post('/api/replays/:liveKey/resume', (req, res) => {
      const ok = this.resumeReplay(String(req.params.liveKey))
      res.json({ ok })
    })

    this.app.post('/api/replays/:liveKey/cache-m3u8', async (req, res) => {
      try {
        const replay = await this.cacheReplayM3U8(String(req.params.liveKey))
        res.json(replay)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.post('/api/replays/:liveKey/delete-file', async (req, res) => {
      try {
        const replay = this.getReplayByLiveKey(String(req.params.liveKey))
        if (!replay) {
          res.status(404).json({ error: 'Replay not found' })
          return
        }
        const target = replay.file_path
        if (target && fs.existsSync(target)) {
          await fsp.unlink(target)
        }
        this.db
          .prepare(
            `UPDATE bilibili_replays
             SET file_path = '',
                 file_size = 0,
                 status = 'deleted',
                 message = 'Local file deleted',
                 updated_at = ?
             WHERE live_key = ?`,
          )
          .run(new Date().toISOString(), replay.live_key)
        res.json(this.getReplayByLiveKey(replay.live_key))
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/stats/disk', async (_req, res) => {
      try {
        const stats = await this.getDiskStats()
        res.json(stats)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/fs/list', async (req, res) => {
      try {
        res.json(await this.listDirectories(String(req.query.path || '')))
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/export-tsv', (_req, res) => {
      const rows = this.getReplays()
      const lines = [
        ['live_key', 'title', 'status', 'start_time', 'end_time', 'duration', 'file_path'].join('\t'),
        ...rows.map(row =>
          [
            row.live_key,
            row.title.replaceAll('\t', ' '),
            row.status,
            `${row.start_time}`,
            `${row.end_time}`,
            `${row.duration}`,
            row.file_path.replaceAll('\t', ' '),
          ].join('\t'),
        ),
      ]
      res.type('text/plain; charset=utf-8').send(lines.join('\n'))
    })

    this.app.get('/api/avatar', async (req, res) => {
      try {
        const raw = String(req.query.url || '')
        const target = new URL(raw)
        if (!target.hostname.endsWith('hdslb.com')) {
          res.status(400).json({ error: 'host not allowed' })
          return
        }
        const response = await fetch(target, {
          headers: {
            'user-agent': USER_AGENT,
            referer: 'https://www.bilibili.com/',
          },
        })
        res.status(response.status)
        res.setHeader('content-type', response.headers.get('content-type') || 'application/octet-stream')
        res.send(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/covers/*', (req, res) => {
      const relative = decodeURIComponent(req.path.replace(/^\/covers\//, ''))
      const fullPath = path.resolve(path.join(this.config.download.output_dir, 'covers', relative))
      const coverDir = path.resolve(path.join(this.config.download.output_dir, 'covers'))
      if (!fullPath.startsWith(coverDir)) {
        res.status(400).json({ error: 'invalid path' })
        return
      }
      if (!fs.existsSync(fullPath)) {
        res.status(404).end()
        return
      }
      res.sendFile(fullPath)
    })

    // --- 视频切片 API ---
    this.app.post('/api/clip/info', async (req, res) => {
      try {
        const info = await this.getBilibiliVideoInfo(req.body.url || '')
        const audioProxyPath = `/api/clip/audio-proxy?url=${encodeURIComponent(info.audioUrl)}`
        res.json({ ...info, audioProxyPath })
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/clip/audio-proxy', async (req, res) => {
      try {
        const url = req.query.url as string
        if (!url) throw new Error('Missing audio URL')
        const response = await this.fetchWithCookies(url)
        res.setHeader('content-type', response.headers.get('content-type') || 'audio/mp4')
        res.setHeader('content-length', response.headers.get('content-length') || '')
        res.setHeader('accept-ranges', 'bytes')
        const buffer = Buffer.from(await response.arrayBuffer())
        res.send(buffer)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.post('/api/clip/execute', async (req, res) => {
      try {
        const { url, startTime, endTime } = req.body
        const result = await this.executeClip(url, Number(startTime) || 0, Number(endTime) || 0)
        res.json(result)
      } catch (error) {
        this.sendError(res, error)
      }
    })
  }

  private ensureSchema() {
    this.db.exec(`
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
    `)
  }

  private static loadConfigFile(baseDir: string, configPath: string) {
    if (!fs.existsSync(configPath)) {
      return DesktopBackend.normalizeConfigWithBase(baseDir, DEFAULT_CONFIG)
    }
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig> | null
    return DesktopBackend.normalizeConfigWithBase(baseDir, deepMerge(DEFAULT_CONFIG, parsed ?? {}))
  }

  private normalizeConfig(config: AppConfig) {
    return DesktopBackend.normalizeConfigWithBase(this.baseDir, config)
  }

  private static normalizeConfigWithBase(baseDir: string, config: AppConfig) {
    const normalized = structuredClone(config)
    normalized.bilibili.cookie_file = DesktopBackend.resolveAppPathWithBase(baseDir, normalized.bilibili.cookie_file || DEFAULT_CONFIG.bilibili.cookie_file)
    normalized.download.output_dir = DesktopBackend.resolveAppPathWithBase(baseDir, normalized.download.output_dir || DEFAULT_CONFIG.download.output_dir)
    normalized.download.temp_dir = DesktopBackend.resolveAppPathWithBase(baseDir, normalized.download.temp_dir || DEFAULT_CONFIG.download.temp_dir)
    normalized.database.dsn = DesktopBackend.resolveAppPathWithBase(baseDir, normalized.database.dsn || DEFAULT_CONFIG.database.dsn)
    normalized.download.filename_template ||= DEFAULT_CONFIG.download.filename_template
    normalized.download.max_concurrent_tasks ||= DEFAULT_CONFIG.download.max_concurrent_tasks
    normalized.download.concurrent_segments ||= DEFAULT_CONFIG.download.concurrent_segments
    normalized.bilibili.anchor_id ||= 0
    normalized.server.port ||= DEFAULT_CONFIG.server.port
    normalized.bilibili.cookies ||= {}
    return normalized
  }

  private async saveConfig() {
    const clone = structuredClone(this.config)
    clone.bilibili.cookie_file = this.relativizeAppPath(clone.bilibili.cookie_file)
    clone.download.output_dir = this.relativizeAppPath(clone.download.output_dir)
    clone.download.temp_dir = this.relativizeAppPath(clone.download.temp_dir)
    clone.database.dsn = this.relativizeAppPath(clone.database.dsn)
    await fsp.writeFile(this.configPath, YAML.stringify(clone), 'utf8')
  }

  private resolveAppPath(target: string) {
    return DesktopBackend.resolveAppPathWithBase(this.baseDir, target)
  }

  private static resolveAppPathWithBase(baseDir: string, target: string) {
    if (!target) return ''
    if (path.isAbsolute(target)) return path.normalize(target)
    return path.resolve(baseDir, target)
  }

  private relativizeAppPath(target: string) {
    if (!target) return ''
    const normalized = path.resolve(target)
    const relative = path.relative(this.baseDir, normalized)
    if (!relative || relative.startsWith('..')) {
      return normalized
    }
    return relative
  }

  private ensureDir(dir: string) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private loadCookies() {
    const fromConfig = this.config.bilibili.cookies || {}
    for (const [key, value] of Object.entries(fromConfig)) {
      this.cookies.set(key, value)
    }
    const cookieFile = this.config.bilibili.cookie_file
    if (!cookieFile || !fs.existsSync(cookieFile)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(cookieFile, 'utf8')) as Record<string, string>
      for (const [key, value] of Object.entries(parsed)) {
        this.cookies.set(key, value)
      }
    } catch {
      // Ignore broken cookie file and let user relogin.
    }
  }

  private async saveCookies() {
    const cookieFile = this.config.bilibili.cookie_file
    if (!cookieFile) return
    const payload = Object.fromEntries(this.cookies.entries())
    await fsp.writeFile(cookieFile, JSON.stringify(payload, null, 2), 'utf8')
  }

  private cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
  }

  private async fetchJSON<T>(url: string, init?: RequestInit) {
    const response = await this.fetchWithCookies(url, init)
    const text = await response.text()
    return JSON.parse(text) as T
  }

  private async fetchWithCookies(url: string | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers ?? {})
    headers.set('user-agent', USER_AGENT)
    headers.set('accept', '*/*')
    headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
    if (!headers.has('referer')) {
      headers.set('referer', 'https://live.bilibili.com/')
    }
    if (!headers.has('origin')) {
      headers.set('origin', 'https://live.bilibili.com')
    }
    const cookie = this.cookieHeader()
    if (cookie) {
      headers.set('cookie', cookie)
    }
    const response = await fetch(url, { ...init, headers })
    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    for (const line of setCookies) {
      const pair = line.split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index > 0) {
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
      }
    }
    return response
  }

  private getRuntime(): RuntimeSnapshot {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('downloading', 'merging') THEN 1 ELSE 0 END) AS downloading,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM bilibili_replays
         WHERE deleted_at IS NULL`,
      )
      .get() as Record<string, unknown>
    return {
      paused: this.runtimePaused,
      max_concurrent_tasks: this.config.download.max_concurrent_tasks,
      concurrent_segments: this.config.download.concurrent_segments,
      downloading_tasks: safeNumber(counts.downloading),
      queued_tasks: safeNumber(counts.queued),
      paused_tasks: safeNumber(counts.paused),
      failed_tasks: safeNumber(counts.failed),
    }
  }

  private getReplayByLiveKey(liveKey: string) {
    return this.getReplays().find(item => item.live_key === liveKey) || null
  }

  private getReplays() {
    const replayRows = this.db
      .prepare(
        `SELECT *
         FROM bilibili_replays
         WHERE deleted_at IS NULL
         ORDER BY start_time DESC`,
      )
      .all() as Record<string, unknown>[]
    const streams = this.db
      .prepare(
        `SELECT replay_id, start_time, end_time, stream, type, m3_u8_text
         FROM stream_slices
         WHERE deleted_at IS NULL
         ORDER BY id ASC`,
      )
      .all() as Record<string, unknown>[]

    const streamMap = new Map<number, StreamSlice[]>()
    for (const stream of streams) {
      const replayId = safeNumber(stream.replay_id)
      const list = streamMap.get(replayId) ?? []
      list.push({
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
        filePath = this.resolveAppPath(filePath)
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

  private async getCurrentUser() {
    try {
      const result = await this.fetchJSON<{
        code: number
        data?: { uname?: string; face?: string }
      }>('https://api.bilibili.com/x/web-interface/nav')
      if (result.code !== 0 || !result.data) {
        return { logged_in: false, uname: '', face: '' }
      }
      return {
        logged_in: true,
        uname: result.data.uname || '',
        face: result.data.face || '',
      }
    } catch {
      return { logged_in: false, uname: '', face: '' }
    }
  }

  private async scanReplays() {
    if (!this.config.bilibili.anchor_id) {
      throw new Error('请先在设置中填写 Bilibili 主播 UID')
    }
    const params = new URLSearchParams({
      live_uid: `${this.config.bilibili.anchor_id}`,
      time_range: '30',
      page: '1',
      page_size: '100',
      web_location: '444.194',
    })
    const payload = await this.fetchJSON<{
      code: number
      message: string
      data?: {
        replay_info?: Array<{
          replay_id: number
          room_id: number
          live_key: string
          start_time: number
          end_time: number
          live_info?: { title?: string; cover?: string }
          video_info?: { duration?: number }
        }>
      }
    }>(`https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetOtherSliceList?${params.toString()}`)
    if (payload.code !== 0) {
      throw new Error(payload.message || 'Scan failed')
    }

    const now = new Date().toISOString()
    const rows = payload.data?.replay_info ?? []
    const existingByLiveKey = new Map(this.getReplays().map(item => [item.live_key, item]))
    let newRecords = 0
    let updatedRecords = 0
    let coversUpdated = 0
    let alreadyUpToDate = 0

    const upsert = this.db.prepare(
      `INSERT INTO bilibili_replays (
         created_at, updated_at, replay_id, live_key, room_id, title, start_time, end_time, duration,
         cover_url, local_cover, file_path, file_size, resolution, bitrate, progress, speed, elapsed, eta,
         status, message, verify_ok, actual_dur
       ) VALUES (
         @created_at, @updated_at, @replay_id, @live_key, @room_id, @title, @start_time, @end_time, @duration,
         @cover_url, @local_cover, @file_path, @file_size, @resolution, @bitrate, @progress, @speed, @elapsed, @eta,
         @status, @message, @verify_ok, @actual_dur
       )
       ON CONFLICT(live_key) DO UPDATE SET
         updated_at = excluded.updated_at,
         replay_id = excluded.replay_id,
         room_id = excluded.room_id,
         title = excluded.title,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         duration = excluded.duration,
         cover_url = excluded.cover_url,
         local_cover = excluded.local_cover`,
    )

    const liveKeys = new Set<string>()
    let restoredHistorical = 0
    await this.db.withBatch(async () => {
      for (const item of rows) {
        liveKeys.add(item.live_key)
        const previous = existingByLiveKey.get(item.live_key)
        const localCover = await this.downloadCover(item.live_key, item.live_info?.cover || '')
        if (localCover) coversUpdated += 1
        upsert.run({
          created_at: previous?.UpdatedAt || now,
          updated_at: now,
          replay_id: item.replay_id,
          live_key: item.live_key,
          room_id: item.room_id,
          title: item.live_info?.title || previous?.title || '',
          start_time: item.start_time,
          end_time: item.end_time,
          duration: safeNumber(item.video_info?.duration),
          cover_url: item.live_info?.cover || previous?.cover_url || '',
          local_cover: localCover || previous?.local_cover || '',
          file_path: previous?.file_path || '',
          file_size: previous?.file_size || 0,
          resolution: previous?.resolution || '',
          bitrate: previous?.bitrate || '',
          progress: previous?.progress || 0,
          speed: previous?.speed || '',
          elapsed: previous?.elapsed || '',
          eta: previous?.eta || '',
          status: previous?.status || 'not_downloaded',
          message: previous?.message || '',
          verify_ok: previous?.verify_ok ? 1 : 0,
          actual_dur: previous?.actual_duration || 0,
        })
        if (!previous) newRecords += 1
        else if (
          previous.title !== (item.live_info?.title || '') ||
          previous.start_time !== item.start_time ||
          previous.end_time !== item.end_time ||
          previous.duration !== safeNumber(item.video_info?.duration)
        ) updatedRecords += 1
        else alreadyUpToDate += 1
      }

      const existing = this.getReplays()
      for (const replay of existing) {
        if (liveKeys.has(replay.live_key)) continue
        const coverPath = replay.local_cover
          ? path.join(this.config.download.output_dir, 'covers', replay.local_cover.replace(/^covers[/\\]/, ''))
          : ''
        const fileExists = replay.file_path ? fs.existsSync(replay.file_path) : false
        const coverExists = coverPath ? fs.existsSync(coverPath) : false
        if (replay.status === 'deleted' && (fileExists || coverExists)) {
          const restoredStatus = fileExists ? 'completed' : 'not_downloaded'
          this.db
            .prepare('UPDATE bilibili_replays SET status = ?, message = ?, updated_at = ? WHERE live_key = ?')
            .run(restoredStatus, 'Retained local replay outside remote scan window', now, replay.live_key)
          restoredHistorical += 1
        }
      }
    })
    updatedRecords += restoredHistorical
    const markedDeleted = 0

    return {
      fetched: rows.length,
      new_records: newRecords,
      updated_records: updatedRecords,
      covers_updated: coversUpdated,
      marked_deleted: markedDeleted,
      already_up_to_date: alreadyUpToDate,
    } satisfies ScanSummary
  }

  private async downloadCover(liveKey: string, coverUrl: string) {
    if (!coverUrl) return ''
    try {
      const ext = path.extname(new URL(coverUrl).pathname) || '.jpg'
      const filename = `${liveKey}${ext}`
      const fullPath = path.join(this.config.download.output_dir, 'covers', filename)
      if (!fs.existsSync(fullPath)) {
        const response = await this.fetchWithCookies(coverUrl, {
          headers: {
            referer: 'https://live.bilibili.com/',
            origin: 'https://live.bilibili.com',
          },
        })
        await fsp.writeFile(fullPath, Buffer.from(await response.arrayBuffer()))
      }
      return filename
    } catch {
      return ''
    }
  }

  private async cacheReplayM3U8(liveKey: string) {
    const replay = this.getReplayByLiveKey(liveKey)
    if (!replay) {
      throw new Error('Replay not found')
    }
    const params = new URLSearchParams({
      live_key: replay.live_key,
      start_time: `${replay.start_time}`,
      end_time: `${replay.end_time}`,
      live_uid: `${this.config.bilibili.anchor_id}`,
      web_location: '444.194',
    })
    const payload = await this.fetchJSON<{
      code: number
      message: string
      data?: { list?: Array<{ start_time: number; end_time: number; stream: string; type: number }> }
    }>(`https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetUserSliceStream?${params.toString()}`)
    if (payload.code !== 0) {
      throw new Error(payload.message || 'Load streams failed')
    }
    const list = payload.data?.list ?? []
    const rows: StreamSlice[] = []
    for (const item of list) {
      const response = await this.fetchWithCookies(item.stream)
      rows.push({
        replay_id: replay.replay_id,
        start_time: safeNumber(item.start_time),
        end_time: safeNumber(item.end_time),
        stream: item.stream,
        type: safeNumber(item.type),
        m3u8_text: await response.text(),
      })
    }
    this.db.prepare('DELETE FROM stream_slices WHERE replay_id = ?').run(replay.replay_id)
    const insert = this.db.prepare(
      `INSERT INTO stream_slices (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = new Date().toISOString()
    for (const row of rows) {
      insert.run(now, now, row.replay_id, row.start_time, row.end_time, row.stream, row.type, row.m3u8_text)
    }
    return this.getReplayByLiveKey(liveKey)
  }

  private async getDiskStats() {
    const now = Date.now()
    if (this.diskStatsCache && this.diskStatsCache.expiresAt > now) {
      return this.diskStatsCache.value
    }
    if (this.diskStatsPromise) {
      return await this.diskStatsPromise
    }
    this.diskStatsPromise = (async () => {
      const target = this.config.download.output_dir || this.baseDir
      const stat = await fsp.statfs(target)
      const usedByService = (await this.getDirSize(this.config.download.output_dir)) + (await this.getDirSize(this.config.download.temp_dir))
      const value = {
        path: target,
        total_bytes: stat.bsize * stat.blocks,
        free_bytes: stat.bsize * stat.bfree,
        used_by_service_bytes: usedByService,
      }
      this.diskStatsCache = {
        value,
        expiresAt: Date.now() + 60_000,
      }
      return value
    })()
    try {
      return await this.diskStatsPromise
    } finally {
      this.diskStatsPromise = null
    }
  }

  private async getDirSize(target: string): Promise<number> {
    if (!target || !fs.existsSync(target)) return 0
    const entries = await fsp.readdir(target, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name)
      if (entry.isDirectory()) {
        total += await this.getDirSize(fullPath)
      } else if (entry.isFile()) {
        total += (await fsp.stat(fullPath)).size
      }
    }
    return total
  }

  private async listDirectories(current: string) {
    if (!current) {
      if (process.platform === 'win32') {
        const entries = []
        for (let code = 65; code <= 90; code += 1) {
          const drive = `${String.fromCharCode(code)}:\\`
          if (fs.existsSync(drive)) {
            entries.push({ name: drive, path: drive })
          }
        }
        return { current: '', parent: '', entries }
      }
      current = path.sep
    }
    const stat = await fsp.stat(current)
    if (!stat.isDirectory()) {
      throw new Error('path is not a directory')
    }
    const items = await fsp.readdir(current, { withFileTypes: true })
    const entries = items
      .filter(item => item.isDirectory())
      .map(item => ({ name: item.name, path: path.join(current, item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = path.dirname(current)
    return {
      current,
      parent: parent === current ? '' : parent,
      entries,
    }
  }

  private recoverInterruptedTasks() {
    const replays = this.getReplays()
    for (const replay of replays) {
      if (['pending', 'downloading', 'merging'].includes(replay.status)) {
        this.enqueueReplay(replay.live_key, { resetProgress: false, message: 'Recovered pending task' })
      }
    }
  }

  private emitProgress(update: Partial<ProgressUpdate> & Pick<ProgressUpdate, 'live_key' | 'status'>) {
    const payload: ProgressUpdate = {
      live_key: update.live_key,
      progress: update.progress ?? 0,
      merge_progress: update.merge_progress ?? 0,
      status: update.status,
      message: update.message ?? '',
      speed: update.speed ?? '',
      speed_history: update.speed_history ?? [],
      elapsed: update.elapsed ?? '',
      eta: update.eta ?? '',
    }
    const raw = JSON.stringify(payload)
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(raw)
      }
    }
  }

  private enqueueReplay(liveKey: string, options?: { resetProgress?: boolean; message?: string }) {
    const replay = this.getReplayByLiveKey(liveKey)
    if (!replay) return false
    if (this.activeTasks.has(liveKey)) return true
    if (!this.queue.includes(liveKey)) {
      this.queue.push(liveKey)
    }
    const nextProgress = options?.resetProgress ? 0 : replay.progress
    this.patchReplay(liveKey, {
      status: 'pending',
      message: options?.message || 'Queued',
      progress: nextProgress,
      speed: '',
      elapsed: options?.resetProgress ? '' : replay.elapsed,
      eta: '',
    })
    this.emitProgress({
      live_key: liveKey,
      status: 'pending',
      progress: nextProgress,
      message: options?.message || 'Queued',
    })
    this.scheduleQueue()
    return true
  }

  private scheduleQueue() {
    while (!this.runtimePaused && this.runningTasks < this.config.download.max_concurrent_tasks && this.queue.length > 0) {
      const liveKey = this.queue.shift()
      if (!liveKey) break
      if (this.activeTasks.has(liveKey) || this.pausedTasks.has(liveKey)) {
        continue
      }
      const replay = this.getReplayByLiveKey(liveKey)
      if (!replay) continue
      const controller = new AbortController()
      this.runningTasks += 1
      const promise = this.processReplayTask(liveKey, controller.signal)
        .catch(error => {
          const message = error instanceof Error ? error.message : 'Unknown error'
          this.patchReplay(liveKey, { status: 'failed', message, speed: '', eta: '' })
          this.emitProgress({ live_key: liveKey, status: 'failed', progress: 0, message })
        })
        .finally(() => {
          this.runningTasks = Math.max(0, this.runningTasks - 1)
          this.activeTasks.delete(liveKey)
          this.scheduleQueue()
        })
      this.activeTasks.set(liveKey, { controller, promise })
    }
  }

  private pauseReplay(liveKey: string) {
    const replay = this.getReplayByLiveKey(liveKey)
    if (!replay) return false
    this.pausedTasks.add(liveKey)
    this.runtimePaused = false
    this.removeFromQueue(liveKey)
    this.patchReplay(liveKey, {
      status: 'paused',
      message: 'Paused',
      speed: '',
      eta: '',
    })
    this.emitProgress({
      live_key: liveKey,
      status: 'paused',
      progress: replay.progress,
      message: 'Paused',
      elapsed: replay.elapsed,
    })
    const active = this.activeTasks.get(liveKey)
    if (active) {
      active.controller.abort()
    }
    return true
  }

  private resumeReplay(liveKey: string) {
    const replay = this.getReplayByLiveKey(liveKey)
    if (!replay) return false
    this.pausedTasks.delete(liveKey)
    return this.enqueueReplay(liveKey, { resetProgress: false, message: 'Resumed' })
  }

  private pauseAll() {
    this.runtimePaused = true
    let count = 0
    for (const replay of this.getReplays()) {
      if (['pending', 'downloading', 'merging', 'failed'].includes(replay.status)) {
        if (this.pauseReplay(replay.live_key)) {
          count += 1
        }
      }
    }
    return count
  }

  private resumeAll() {
    this.runtimePaused = false
    let count = 0
    for (const replay of this.getReplays()) {
      if (replay.status === 'paused') {
        if (this.resumeReplay(replay.live_key)) {
          count += 1
        }
      }
    }
    this.scheduleQueue()
    return count
  }

  private retryFailed() {
    let count = 0
    for (const replay of this.getReplays()) {
      if (replay.status === 'failed') {
        this.pausedTasks.delete(replay.live_key)
        if (this.enqueueReplay(replay.live_key, { resetProgress: true, message: 'Retrying' })) {
          count += 1
        }
      }
    }
    return count
  }

  private downloadUnfinished() {
    let count = 0
    for (const replay of this.getReplays()) {
      if (replay.status === 'not_downloaded') {
        this.pausedTasks.delete(replay.live_key)
        if (this.enqueueReplay(replay.live_key, { resetProgress: true, message: 'Queued' })) {
          count += 1
        }
      }
    }
    return count
  }

  private syncAllPending() {
    let count = 0
    for (const replay of this.getReplays()) {
      if (replay.status === 'pending') {
        if (!this.queue.includes(replay.live_key) && !this.activeTasks.has(replay.live_key)) {
          this.queue.push(replay.live_key)
          count += 1
        }
      }
    }
    this.scheduleQueue()
    return count
  }

  private removeFromQueue(liveKey: string) {
    let idx = this.queue.indexOf(liveKey)
    while (idx >= 0) {
      this.queue.splice(idx, 1)
      idx = this.queue.indexOf(liveKey)
    }
  }

  private patchReplay(
    liveKey: string,
    patch: Partial<Pick<ReplayRecord, 'file_path' | 'file_size' | 'resolution' | 'bitrate' | 'progress' | 'speed' | 'elapsed' | 'eta' | 'status' | 'message' | 'verify_ok' | 'actual_duration'>>,
  ) {
    const current = this.getReplayByLiveKey(liveKey)
    if (!current) return null
    const next = {
      ...current,
      ...patch,
    }
    this.db
      .prepare(
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
      )
      .run(
        next.file_path || '',
        next.file_size || 0,
        next.resolution || '',
        next.bitrate || '',
        next.progress || 0,
        next.speed || '',
        next.elapsed || '',
        next.eta || '',
        next.status || 'not_downloaded',
        next.message || '',
        next.verify_ok ? 1 : 0,
        next.actual_duration || 0,
        new Date().toISOString(),
        liveKey,
      )
    return this.getReplayByLiveKey(liveKey)
  }

  private async processReplayTask(liveKey: string, signal: AbortSignal) {
    let replay = this.getReplayByLiveKey(liveKey)
    if (!replay) return
    if (this.pausedTasks.has(liveKey)) return

    if (replay.streams.length === 0) {
      this.patchReplay(liveKey, { status: 'pending', message: 'Fetching stream list...' })
      this.emitProgress({ live_key: liveKey, status: 'pending', progress: replay.progress, message: 'Fetching stream list...' })
      replay = (await this.cacheReplayM3U8(liveKey)) || this.getReplayByLiveKey(liveKey)
      if (!replay || replay.streams.length === 0) {
        throw new Error('No streams found for replay')
      }
    }

    this.patchReplay(liveKey, {
      status: 'downloading',
      message: 'Initializing download...',
      speed: '',
      eta: '',
      elapsed: replay.elapsed || '',
    })
    this.emitProgress({ live_key: liveKey, status: 'downloading', progress: replay.progress, message: 'Initializing download...' })

    const finalPath = await this.downloadReplayWithContext(this.getReplayByLiveKey(liveKey) || replay, signal)
    const targetReplay = this.getReplayByLiveKey(liveKey) || replay

    this.patchReplay(liveKey, { message: 'Verifying duration...' })
    let verifyOk = true
    let actualDuration = 0
    try {
      const verified = await this.verifyDuration(finalPath, targetReplay.duration)
      verifyOk = verified.ok
      actualDuration = verified.duration
    } catch {
      verifyOk = false
    }

    let fileInfo: FileInfo = { size: 0, resolution: '', bitrate: '' }
    try {
      fileInfo = await this.getFileInfo(finalPath)
    } catch {
      fileInfo = {
        size: fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0,
        resolution: '',
        bitrate: '',
      }
    }

    this.patchReplay(liveKey, {
      file_path: finalPath,
      file_size: fileInfo.size,
      resolution: fileInfo.resolution,
      bitrate: fileInfo.bitrate,
      progress: 100,
      speed: '',
      eta: '',
      status: 'completed',
      message: verifyOk ? 'Success' : `Duration mismatch: expected ${targetReplay.duration}, got ${actualDuration.toFixed(1)}`,
      verify_ok: verifyOk,
      actual_duration: actualDuration,
    })
    this.emitProgress({ live_key: liveKey, status: 'completed', progress: 100, message: 'Success' })
  }

  private async downloadReplayWithContext(replay: ReplayRecord, signal: AbortSignal) {
    const streams = [...replay.streams].sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time)
    if (streams.length === 0) {
      throw new Error(`no streams found for replay ${replay.live_key}`)
    }

    let finalFilename = renderFilenameTemplate(this.config.download.filename_template, replay)
    if (!finalFilename.toLowerCase().endsWith('.mp4')) {
      finalFilename += '.mp4'
    }
    let finalPath = path.join(this.config.download.output_dir, finalFilename)
    finalPath = uniquePath(finalPath)

    const startAt = Date.now()
    const speedHistory: number[] = []
    let downloadedBytes = 0
    let doneSegments = 0
    let totalSegments = 0
    let expectedDuration = 0
    const allSegmentFiles: string[] = []
    const allSegmentDurations: number[] = []
    const streamDirs: string[] = []

    for (let streamIdx = 0; streamIdx < streams.length; streamIdx += 1) {
      this.throwIfAborted(signal)
      const stream = streams[streamIdx]
      const segments = await this.parseM3U8(stream.stream, stream.m3u8_text)
      totalSegments += segments.length
      expectedDuration += segments.reduce((sum, item) => sum + item.duration, 0)
      const streamDir = path.join(this.config.download.temp_dir, `${replay.live_key}_stream${streamIdx}`)
      await fsp.mkdir(streamDir, { recursive: true })
      streamDirs.push(streamDir)

      for (let i = 0; i < segments.length; i += 1) {
        this.throwIfAborted(signal)
        const seg = segments[i]
        const segPath = path.join(streamDir, `seg_${String(i).padStart(5, '0')}.ts`)
        if (!fs.existsSync(segPath) || fs.statSync(segPath).size === 0) {
          const bytes = await this.downloadSegment(seg.url, segPath, signal)
          downloadedBytes += bytes
        } else {
          downloadedBytes += fs.statSync(segPath).size
        }
        doneSegments += 1
        allSegmentFiles.push(segPath)
        allSegmentDurations.push(seg.duration)
        const elapsedSeconds = Math.max(1, (Date.now() - startAt) / 1000)
        const speedMb = downloadedBytes / elapsedSeconds / 1024 / 1024
        speedHistory.push(speedMb)
        if (speedHistory.length > 30) speedHistory.shift()
        const progress = Math.min(98, (doneSegments / Math.max(1, totalSegments)) * 100)
        const elapsed = this.formatElapsed(elapsedSeconds)
        const etaSeconds = speedMb <= 0 ? 0 : ((totalSegments - doneSegments) * elapsedSeconds) / Math.max(1, doneSegments)
        this.patchReplay(replay.live_key, {
          progress,
          speed: `${speedMb.toFixed(2)} MB/s`,
          elapsed,
          eta: etaSeconds > 0 ? this.formatElapsed(etaSeconds) : '',
          status: 'downloading',
          message: `Stream ${streamIdx + 1}/${streams.length}, Segment ${i + 1}/${segments.length}`,
        })
        this.emitProgress({
          live_key: replay.live_key,
          status: 'downloading',
          progress,
          message: `Stream ${streamIdx + 1}/${streams.length}, Segment ${i + 1}/${segments.length}`,
          speed: `${speedMb.toFixed(2)} MB/s`,
          speed_history: [...speedHistory],
          elapsed,
          eta: etaSeconds > 0 ? this.formatElapsed(etaSeconds) : '',
        })
      }
    }

    const localM3U8Path = path.join(this.config.download.temp_dir, `${replay.live_key}_local.m3u8`)
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0']
    for (let i = 0; i < allSegmentFiles.length; i += 1) {
      playlist.push(`#EXTINF:${(allSegmentDurations[i] || 10).toFixed(6)},`)
      playlist.push(allSegmentFiles[i].replaceAll('\\', '/'))
    }
    playlist.push('#EXT-X-ENDLIST')
    await fsp.writeFile(localM3U8Path, playlist.join('\n'), 'utf8')

    this.patchReplay(replay.live_key, { status: 'merging', message: 'Merging all segments...', progress: 99 })
    this.emitProgress({ live_key: replay.live_key, status: 'merging', progress: 99, merge_progress: 0, message: 'Merging all segments...' })

    await this.runFfmpegMerge(replay.live_key, localM3U8Path, finalPath, expectedDuration, signal)

    await fsp.rm(localM3U8Path, { force: true })
    for (const dir of streamDirs) {
      await fsp.rm(dir, { recursive: true, force: true })
    }
    return finalPath
  }

  private async parseM3U8(streamUrl: string, existingText?: string) {
    const text = existingText || (await (await this.fetchWithCookies(streamUrl)).text())
    const lines = text.split(/\r?\n/)
    const base = streamUrl.slice(0, streamUrl.lastIndexOf('/') + 1)
    const segments: M3U8Segment[] = []
    let nextDuration = 0
    for (const lineRaw of lines) {
      const line = lineRaw.trim()
      if (!line) continue
      if (line.startsWith('#EXTINF:')) {
        const raw = line.slice('#EXTINF:'.length).split(',')[0]
        nextDuration = Number.parseFloat(raw) || 0
        continue
      }
      if (line.startsWith('#')) continue
      const resolved = /^https?:\/\//i.test(line) ? line : new URL(line, base).toString()
      segments.push({ url: resolved, duration: nextDuration })
      nextDuration = 0
    }
    return segments
  }

  private async downloadSegment(url: string, targetPath: string, signal: AbortSignal) {
    const tmpPath = `${targetPath}.tmp`
    const response = await this.fetchWithCookies(url, { signal })
    if (!response.ok) {
      throw new Error(`segment download failed: ${response.status} ${response.statusText}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await fsp.writeFile(tmpPath, buffer)
    await fsp.rename(tmpPath, targetPath)
    return buffer.byteLength
  }

  private async runFfmpegMerge(liveKey: string, inputM3U8: string, outputPath: string, expectedSeconds: number, signal: AbortSignal) {
    const segments = await this.parseM3U8(inputM3U8)
    let totalBytes = 0
    for (const seg of segments) {
      const localPath = decodeURI(new URL(seg.url).pathname).replace(/\//g, path.sep)
      const fullPath = path.join(path.dirname(inputM3U8), path.basename(localPath))
      if (fs.existsSync(fullPath)) {
        totalBytes += fs.statSync(fullPath).size
      }
    }

    const tempPath = `${outputPath}.ts.tmp`
    const outStream = createWriteStream(tempPath)
    let written = 0

    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => { outStream.close(); reject(new Error('aborted')) }, { once: true })
      outStream.on('error', reject)

      const appendNext = (idx: number) => {
        if (signal.aborted) return
        if (idx >= segments.length) {
          outStream.end(() => resolve())
          return
        }
        const seg = segments[idx]
        const localPath = decodeURI(new URL(seg.url).pathname).replace(/\//g, path.sep)
        const fullPath = path.join(path.dirname(inputM3U8), path.basename(localPath))
        if (!fs.existsSync(fullPath)) {
          appendNext(idx + 1)
          return
        }
        const rs = createReadStream(fullPath)
        rs.on('data', (chunk: string | Buffer) => {
          written += chunk.length
          const mergeProgress = totalBytes > 0 ? Math.max(0, Math.min(100, (written / totalBytes) * 100)) : 0
          this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: mergeProgress, message: `Merging... ${Math.round(mergeProgress)}%` })
        })
        rs.on('end', () => appendNext(idx + 1))
        rs.on('error', reject)
        rs.pipe(outStream, { end: false })
      }
      appendNext(0)
    })

    if (signal.aborted) { await fsp.rm(tempPath, { force: true }); return }

    try {
      await this.remuxTsToMp4(tempPath, outputPath, signal)
    } finally {
      await fsp.rm(tempPath, { force: true })
    }
  }

  private async remuxTsToMp4(tsPath: string, mp4Path: string, signal: AbortSignal) {
    const buffer = fs.readFileSync(tsPath)
    if (signal.aborted) return
    const data = new Uint8Array(buffer)

    // --- Pass 1: find PAT / PMT → stream PIDs & codec info ---
    const patPid = 0x00
    let pmtPid = -1
    let videoPid = -1; let videoCodec = ''
    let audioPid = -1; let audioCodec = ''
    let width = 1920; let height = 1080; let sampleRate = 48000; let channels = 2

    for (let i = 0; i + 188 <= data.length && (videoPid < 0 || audioPid < 0); i += 188) {
      if (data[i] !== 0x47) continue
      const pid = ((data[i + 1] & 0x1F) << 8) | data[i + 2]
      if (pid === patPid && pmtPid < 0) pmtPid = this.parsePatPmtPid(data, i)
      if (pmtPid >= 0 && pid === pmtPid) {
        const info = this.parsePmtInfo(data, i)
        if (info.videoPid >= 0) { videoPid = info.videoPid; videoCodec = info.videoCodec; width = info.width; height = info.height }
        if (info.audioPid >= 0) { audioPid = info.audioPid; audioCodec = info.audioCodec; sampleRate = info.sampleRate; channels = info.channels }
      }
    }
    if (videoPid < 0 && audioPid < 0) { fs.writeFileSync(mp4Path, buffer); return }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: videoPid >= 0 ? { codec: (videoCodec || 'avc') as 'avc' | 'hevc', width, height } : undefined,
      audio: audioPid >= 0 ? { codec: (audioCodec || 'aac') as 'aac' | 'opus', numberOfChannels: channels, sampleRate } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    } satisfies ConstructorParameters<typeof Muxer>[0])

    // --- Pass 2: extract PES → feed elementary streams to muxer ---
    const accumVideo = new Uint8Array(4 * 1024 * 1024)
    const accumAudio = new Uint8Array(512 * 1024)
    let accumVideoLen = 0; let accumAudioLen = 0
    let videoPts = 0; let audioPts = 0
    let hasKeyFrame = false

    const processVideoPes = (payload: Uint8Array) => {
      let idx = 0
      const buf = payload
      const end = buf.length
      while (idx + 4 < end) {
        // find Annex-B start code
        let start = -1
        if (buf[idx] === 0 && buf[idx + 1] === 0 && buf[idx + 2] === 1) { start = idx; idx += 3 }
        else if (buf[idx] === 0 && buf[idx + 1] === 0 && buf[idx + 2] === 0 && buf[idx + 3] === 1) { start = idx; idx += 4 }
        else { idx++; continue }
        // find next start code
        let nalEnd = end
        for (let j = idx; j + 2 < end; j++) {
          if (buf[j] === 0 && buf[j + 1] === 0 && (buf[j + 2] === 1 || (buf[j + 2] === 0 && buf[j + 3] === 1))) { nalEnd = j; break }
        }
        const nalType = buf[idx] & 0x1F
        if (nalType === 5) hasKeyFrame = true
        if (hasKeyFrame) {
          const body = buf.subarray(idx, nalEnd)
          const avcc = new Uint8Array(4 + body.length)
          const sz = body.length
          avcc[0] = (sz >> 24) & 0xFF; avcc[1] = (sz >> 16) & 0xFF
          avcc[2] = (sz >> 8) & 0xFF; avcc[3] = sz & 0xFF
          avcc.set(body, 4)
          muxer.addVideoChunkRaw(avcc, nalType === 5 ? 'key' : 'delta', videoPts, 0)
        }
        idx = nalEnd
      }
    }

    const sampleRateTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    const processAudioPes = (payload: Uint8Array) => {
      let idx = 0
      const buf = payload
      const end = buf.length
      while (idx + 2 < end) {
        if (buf[idx] === 0xFF && (buf[idx + 1] & 0xF6) === 0xF0) {
          const prot = (buf[idx + 1] & 0x01) !== 0
          const srIdx = (buf[idx + 1] & 0x3C) >> 2
          const headerLen = prot ? 7 : 9
          const rawLen = (((buf[idx + 3] & 0x03) << 11) | ((buf[idx + 4] & 0xFF) << 3) | ((buf[idx + 5] & 0xE0) >> 5)) - headerLen
          if (rawLen > 0 && idx + headerLen + rawLen <= end) {
            muxer.addAudioChunkRaw(buf.subarray(idx + headerLen, idx + headerLen + rawLen), 'key', audioPts, (1024 * 1000000) / (sampleRateTable[srIdx] || 48000))
            audioPts += (1024 * 1000000) / (sampleRateTable[srIdx] || 48000)
          }
          idx += headerLen + Math.max(0, rawLen)
        } else { idx++ }
      }
    }

    for (let i = 0; i + 188 <= data.length; i += 188) {
      if (signal.aborted) return
      if (data[i] !== 0x47) continue
      const pid = ((data[i + 1] & 0x1F) << 8) | data[i + 2]
      const isPusi = (data[i + 1] & 0x40) !== 0
      const afc = (data[i + 3] & 0x30) >> 4
      let pStart = 4
      if (afc === 3) pStart = 5 + data[i + 4]
      const payload = data.subarray(i + pStart, i + 188)

      if (pid === videoPid) {
        if (isPusi) {
          if (accumVideoLen > 0) processVideoPes(accumVideo.subarray(0, accumVideoLen))
          accumVideoLen = 0
          // parse PES header for PTS
          if (payload[0] < payload.length && payload.length >= 10) {
            const pesStart = 1 + payload[0]
            if (pesStart + 5 < payload.length && (payload[pesStart + 7] & 0x80)) {
              videoPts = Number((BigInt(payload[pesStart + 9] & 0x0E) << 29n) | (BigInt(payload[pesStart + 10]) << 22n) | (BigInt(payload[pesStart + 11] & 0xFE) << 14n) | (BigInt(payload[pesStart + 12]) << 7n) | (BigInt(payload[pesStart + 13] & 0xFE) >> 1n))
            }
            if (pesStart < payload.length) { accumVideo.set(payload.subarray(pesStart), 0); accumVideoLen = payload.length - pesStart }
          }
        } else if (accumVideoLen + payload.length <= accumVideo.length) {
          accumVideo.set(payload, accumVideoLen); accumVideoLen += payload.length
        }
      } else if (pid === audioPid) {
        if (isPusi) {
          if (accumAudioLen > 0) processAudioPes(accumAudio.subarray(0, accumAudioLen))
          accumAudioLen = 0
          if (payload[0] < payload.length && payload.length >= 10) {
            const pesStart = 1 + payload[0]
            if (pesStart + 5 < payload.length && (payload[pesStart + 7] & 0x80)) {
              audioPts = Number((BigInt(payload[pesStart + 9] & 0x0E) << 29n) | (BigInt(payload[pesStart + 10]) << 22n) | (BigInt(payload[pesStart + 11] & 0xFE) << 14n) | (BigInt(payload[pesStart + 12]) << 7n) | (BigInt(payload[pesStart + 13] & 0xFE) >> 1n))
            }
            if (pesStart < payload.length) { accumAudio.set(payload.subarray(pesStart), 0); accumAudioLen = payload.length - pesStart }
          }
        } else if (accumAudioLen + payload.length <= accumAudio.length) {
          accumAudio.set(payload, accumAudioLen); accumAudioLen += payload.length
        }
      }
    }
    if (accumVideoLen > 0) processVideoPes(accumVideo.subarray(0, accumVideoLen))
    if (accumAudioLen > 0) processAudioPes(accumAudio.subarray(0, accumAudioLen))

    muxer.finalize()
    fs.writeFileSync(mp4Path, Buffer.from(muxer.target.buffer as ArrayBuffer))
  }

  private parsePatPmtPid(data: Uint8Array, offset: number): number {
    for (let i = offset + 4; i + 4 <= offset + 188; i += 4) {
      if (((data[i] << 8) | data[i + 1]) === 0) continue
      return ((data[i + 2] & 0x1F) << 8) | (data[i + 3] & 0xFF)
    }
    return -1
  }

  private parsePmtInfo(data: Uint8Array, offset: number) {
    const result = { videoPid: -1, videoCodec: '', width: 1920, height: 1080, audioPid: -1, audioCodec: '', sampleRate: 48000, channels: 2 }
    const ptr = data[offset + 4] & 0xFF
    const sectionEnd = offset + 4 + (((data[offset + 1] & 0x0F) << 8) | data[offset + 2])
    let i = offset + 4 + 1 + ptr + 4
    i += ((data[offset + 8 + ptr] & 0x0F) << 8) | data[offset + 9 + ptr]
    while (i + 5 <= Math.min(offset + 188, sectionEnd)) {
      const st = data[i] & 0xFF
      const esPid = ((data[i + 1] & 0x1F) << 8) | data[i + 2]
      const esLen = ((data[i + 3] & 0x0F) << 8) | data[i + 4]
      i += 5
      const esEnd = i + esLen
      if ((st === 0x1B || st === 0x24) && result.videoPid < 0) {
        result.videoPid = esPid; result.videoCodec = st === 0x24 ? 'hevc' : 'avc'
        for (let j = esEnd - 1; j - 8 >= i; j--) {
          if (data[j - 8] === 0x28 && data[j - 7] === 0x00 && data[j - 6] === 0x00 && data[j - 5] === 0x1E) {
            result.width = ((data[j - 2] & 0xFF) << 8) | (data[j - 1] & 0xFF)
            result.height = ((data[j] & 0xFF) << 8) | (data[j + 1] & 0xFF)
            break
          }
        }
      } else if ((st === 0x0F || st === 0x11) && result.audioPid < 0) {
        result.audioPid = esPid; result.audioCodec = 'aac'
        const srTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
        for (let j = i; j + 3 <= esEnd; j++) {
          if (data[j] === 0xFF && (data[j + 1] & 0xF6) === 0xF0) {
            result.sampleRate = srTable[(data[j + 1] & 0x3C) >> 2] || 48000
            result.channels = Math.max(1, ((data[j + 1] & 0x01) << 2) | ((data[j + 2] & 0xC0) >> 6))
            break
          }
        }
      }
      i = esEnd
    }
    return result
  }

  private async verifyDuration(filePath: string, expectedSeconds: number) {
    if (!fs.existsSync(filePath)) return { ok: false, duration: 0 }
    try {
      const metadata = await parseFile(filePath)
      const duration = metadata.format.duration || 0
      if (expectedSeconds <= 0) return { ok: duration > 0, duration }
      const diff = Math.abs(duration - expectedSeconds)
      const margin = Math.min(600, 60 + expectedSeconds * 0.02)
      return { ok: diff <= margin, duration }
    } catch {
      return { ok: false, duration: 0 }
    }
  }

  private async getFileInfo(filePath: string): Promise<FileInfo> {
    if (!fs.existsSync(filePath)) return { size: 0, resolution: '', bitrate: '' }
    const stat = fs.statSync(filePath)
    try {
      const metadata = await parseFile(filePath)
      const videoTrack = metadata.format.trackInfo.find(t => t.video)?.video
      const bitRate = metadata.format.bitrate || 0
      return {
        size: stat.size,
        resolution: videoTrack ? `${videoTrack.pixelWidth || videoTrack.displayWidth || 0}x${videoTrack.pixelHeight || videoTrack.displayHeight || 0}` : '',
        bitrate: bitRate > 0 ? `${(bitRate / 1000000).toFixed(2)} Mbps` : '',
      }
    } catch {
      return { size: stat.size, resolution: '', bitrate: '' }
    }
  }

  private formatElapsed(totalSeconds: number) {
    const safe = Math.max(0, Math.floor(totalSeconds))
    const h = Math.floor(safe / 3600)
    const m = Math.floor((safe % 3600) / 60)
    const s = safe % 60
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // --- B站视频切片 ---

  private parseBilibiliUrl(url: string): { type: 'bv' | 'av'; id: string } | null {
    const bvMatch = url.match(/BV([a-zA-Z0-9]+)/)
    if (bvMatch) return { type: 'bv', id: `BV${bvMatch[1]}` }
    const avMatch = url.match(/av(\d+)/i)
    if (avMatch) return { type: 'av', id: avMatch[1] }
    return null
  }

  private async getBilibiliVideoInfo(rawUrl: string) {
    const parsed = this.parseBilibiliUrl(rawUrl)
    if (!parsed) throw new Error('无法解析 B站视频链接')
    const queryParam = parsed.type === 'bv' ? `bvid=${parsed.id}` : `aid=${parsed.id}`
    const info = await this.fetchJSON<{ code: number; message: string; data: { title: string; duration: number; cid: number; owner: { name: string; face: string }; pic: string; stat: { view: number; danmaku: number } } }>(
      `https://api.bilibili.com/x/web-interface/view?${queryParam}`,
    )
    if (info.code !== 0) throw new Error(info.message || '获取视频信息失败')
    const { title, duration, cid, owner, pic } = info.data

    // Get audio stream URL
    const playUrl = await this.fetchJSON<{ code: number; data: { dash?: { audio: Array<{ base_url: string; bandwidth: number; codecs: string }> } } }>(
      `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${cid}&fnval=4048`,
    )
    const audioList = playUrl?.data?.dash?.audio || []
    if (audioList.length === 0) throw new Error('无法获取音频流')
    // Pick highest quality audio
    audioList.sort((a, b) => b.bandwidth - a.bandwidth)
    const audioUrl = audioList[0].base_url

    return { title, duration, cid, author: owner.name, cover: pic, audioUrl, audioCodec: audioList[0].codecs || 'aac' }
  }

  private async executeClip(rawUrl: string, startTime: number, endTime: number) {
    if (startTime < 0) startTime = 0
    if (endTime <= startTime) throw new Error('结束时间必须大于开始时间')
    const info = await this.getBilibiliVideoInfo(rawUrl)
    if (endTime > info.duration) endTime = info.duration

    const clipDir = path.join(this.config.download.output_dir, 'clips')
    this.ensureDir(clipDir)
    const safeTitle = sanitizeFilename(info.title || 'clip')
    const ts = `${formatSeconds(startTime)}-${formatSeconds(endTime)}`
    const outPath = uniquePath(path.join(clipDir, `[cut] ${safeTitle} (${ts}).m4a`))

    const response = await this.fetchWithCookies(info.audioUrl)
    if (!response.ok) throw new Error(`音频下载失败: ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(outPath, buffer)

    return { path: outPath, fileName: path.basename(outPath), size: fs.statSync(outPath).size, title: info.title, duration: info.duration, startTime, endTime }
  }

  private throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
      throw new Error('aborted')
    }
  }

  private sendError(res: Response, error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
}

export async function startDesktopBackend(options?: { baseDir?: string }) {
  const baseDir = detectBaseDir(options?.baseDir || process.cwd())
  const backend = await DesktopBackend.create(baseDir)
  const baseURL = await backend.listen()
  return {
    baseURL,
    stop: () => backend.stop(),
  }
}
