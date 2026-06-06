import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import express, { type Response } from 'express'
import { WebSocketServer } from 'ws'

import {
  AppConfig,
  ReplayRecord,
  RuntimeSnapshot,
  ScanSummary,
  ProgressUpdate,
  TaskHandle,
} from './types'
import {
  DEFAULT_CONFIG,
  deepMerge,
  loadConfigFile,
  saveConfigFile,
  normalizeConfigWithBase,
  detectBaseDir,
  resolveAppPathWithBase,
} from './config'
import { safeNumber, ensureDir } from './utils'
import { SqliteStore } from './db'
import { BilibiliClient, USER_AGENT } from './bilibili'
import { DownloaderService } from './downloader'
import { ClipService } from './clip'

class DesktopBackend {
  private readonly baseDir: string
  private readonly configPath: string
  private config: AppConfig
  private readonly db: SqliteStore
  private readonly bilibiliClient: BilibiliClient
  private readonly downloaderService: DownloaderService
  private readonly clipService: ClipService

  private readonly app = express()
  private readonly server = http.createServer(this.app)
  private readonly wss = new WebSocketServer({ noServer: true })

  private runtimePaused = false
  private readonly activeTasks = new Map<string, TaskHandle>()
  private readonly pausedTasks = new Set<string>()
  private runningTasks = 0
  private readonly queue: string[] = []

  private diskStatsCache: {
    value: { path: string; total_bytes: number; free_bytes: number; used_by_service_bytes: number }
    expiresAt: number
  } | null = null
  private diskStatsPromise: Promise<{
    path: string; total_bytes: number; free_bytes: number; used_by_service_bytes: number
  }> | null = null

  private constructor(baseDir: string, config: AppConfig, db: SqliteStore, customFetch?: typeof globalThis.fetch) {
    this.baseDir = baseDir
    this.configPath = path.join(baseDir, 'config.yaml')
    this.config = config
    this.db = db

    this.bilibiliClient = new BilibiliClient(config, db, customFetch)
    this.downloaderService = new DownloaderService(config, db, this.bilibiliClient, (p) => this.emitProgress(p))
    this.clipService = new ClipService(config, this.bilibiliClient, baseDir)

    ensureDir(this.config.download.output_dir)
    ensureDir(this.config.download.temp_dir)
    ensureDir(path.join(this.config.download.output_dir, 'covers'))
    this.bilibiliClient.loadCookies()
    this.db.ensureSchema()

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

  static async create(baseDir: string, customFetch?: typeof globalThis.fetch) {
    const configPath = path.join(baseDir, 'config.yaml')
    const config = loadConfigFile(baseDir, configPath)
    const db = await SqliteStore.open(config.database.dsn)
    return new DesktopBackend(baseDir, config, db, customFetch)
  }

  async listen() {
    this.db.cleanupCorruptedReplays()
    await new Promise<void>(resolve => {
      this.server.listen(this.config.server.port, '127.0.0.1', () => resolve())
    })
    this.recoverInterruptedTasks()
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to resolve backend port')
    }
    return `http://127.0.0.1:${addr.port}`
  }

  async stop() {
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    await this.db.close()
  }

  // ──────────────────────────── Routes ────────────────────────────

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
        this.config = normalizeConfigWithBase(this.baseDir, next)
        ensureDir(this.config.download.output_dir)
        ensureDir(this.config.download.temp_dir)
        ensureDir(path.join(this.config.download.output_dir, 'covers'))
        await saveConfigFile(this.baseDir, this.configPath, this.config)
        res.setHeader('x-migrated-files', '0')
        res.setHeader('x-renamed-files', '0')
        res.json(this.config)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/replays', (_req, res) => {
      try {
        res.json(this.db.getReplays(this.baseDir))
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/me', async (_req, res) => {
      try {
        const me = await this.bilibiliClient.getCurrentUser()
        res.json(me)
      } catch {
        res.json({ logged_in: false, uname: '', face: '' })
      }
    })

    this.app.get('/api/login/qr', async (_req, res) => {
      try {
        const data = await this.bilibiliClient.fetchJSON<{
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
        const data = await this.bilibiliClient.fetchJSON<{
          data: { code: number }
        }>(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`)
        await this.bilibiliClient.saveCookies()
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
      const replay = this.db.getReplayByLiveKey(this.baseDir, String(req.params.liveKey))
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
        const liveKey = String(req.params.liveKey)
        const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
        if (!replay) {
          res.status(404).json({ error: 'Replay not found' })
          return
        }
        await this.bilibiliClient.cacheReplayM3U8(replay)
        res.json(this.db.getReplayByLiveKey(this.baseDir, liveKey))
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.post('/api/replays/:liveKey/delete-file', async (req, res) => {
      try {
        const replay = this.db.getReplayByLiveKey(this.baseDir, String(req.params.liveKey))
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
        res.json(this.db.getReplayByLiveKey(this.baseDir, replay.live_key))
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
      const rows = this.db.getReplays(this.baseDir)
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
    // Cover image proxy — fetches external B站 cover images to avoid mixed-content blocks
    this.app.get('/api/clip/cover-proxy', async (req, res) => {
      try {
        const url = req.query.url as string
        if (!url) throw new Error('Missing cover URL')
        const response = await this.bilibiliClient.fetchWithCookies(url)
        const contentType = response.headers.get('content-type') || 'image/jpeg'
        res.setHeader('content-type', contentType)
        res.setHeader('cache-control', 'public, max-age=86400')
        const buffer = Buffer.from(await response.arrayBuffer())
        res.send(buffer)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    // Clip output directory config
    this.app.get('/api/clip/output-dir', (req, res) => {
      const clipDir = resolveAppPathWithBase(this.baseDir, this.config.download.clip_output_dir || path.join(this.config.download.output_dir, 'clips'))
      res.json({ path: clipDir })
    })

    this.app.post('/api/clip/output-dir', (req, res) => {
      try {
        const newDir = req.body.path as string
        if (!newDir) throw new Error('Missing path')
        this.config.download.clip_output_dir = newDir
        ensureDir(resolveAppPathWithBase(this.baseDir, newDir))
        res.json({ ok: true, path: resolveAppPathWithBase(this.baseDir, newDir) })
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.post('/api/clip/info', async (req, res) => {
      try {
        const info = await this.bilibiliClient.getBilibiliVideoInfo(req.body.url || '')
        const audioProxyPath = `/api/clip/audio-proxy?url=${encodeURIComponent(info.audioUrl)}`
        // Proxy the cover image through our backend to avoid mixed-content blocks
        const coverProxy = info.cover ? `/api/clip/cover-proxy?url=${encodeURIComponent(info.cover)}` : ''
        res.json({ ...info, cover: coverProxy, audioProxyPath })
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/clip/audio-proxy', async (req, res) => {
      try {
        const url = req.query.url as string
        const start = Number(req.query.start) || 0
        const duration = Number(req.query.duration) || 0
        if (!url) throw new Error('Missing audio URL')
        
        if (duration > 0) {
          res.setHeader('content-type', 'audio/mpeg')
          // Use child_process.spawn directly because fluent-ffmpeg doesn't properly quote -headers
          const cookie = this.bilibiliClient.cookieHeader()
          const headers = `Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nCookie: ${cookie}\r\n`
          const ffmpegPath = (require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked')
          const { spawn } = require('node:child_process')
          const args = [
            '-ss', `${start}`,
            '-headers', headers,
            '-i', url,
            '-t', `${duration}`,
            '-f', 'mp3',
            '-c:a', 'libmp3lame',
            '-b:a', '32k',
            '-ar', '8000',
            '-ac', '1',
            'pipe:1'
          ]
          console.log('[audio-proxy] spawning ffmpeg')
          const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
          proc.stdout.pipe(res)
          proc.stderr.on('data', (d: Buffer) => {
            const msg = d.toString()
            if (msg.includes('Error') || msg.includes('error')) console.error('[audio-proxy] ffmpeg stderr:', msg)
          })
          proc.on('error', (err: Error) => {
            console.error('[audio-proxy] spawn error:', err)
            if (!res.headersSent) res.status(500).json({ error: err.message })
          })
          proc.on('close', (code: number) => {
            if (code !== 0) console.error('[audio-proxy] ffmpeg exited with code', code)
            res.end()
          })
          return
        }

        // For non-duration requests, use ffmpeg to stream directly too
        const cookie = this.bilibiliClient.cookieHeader()
        const headers = `Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nCookie: ${cookie}\r\n`
        const response = await this.bilibiliClient.fetchWithCookies(url)
        res.setHeader('content-type', response.headers.get('content-type') || 'audio/mp4')
        res.setHeader('content-length', response.headers.get('content-length') || '')
        res.setHeader('accept-ranges', 'bytes')
        const buffer = Buffer.from(await response.arrayBuffer())
        res.send(buffer)
      } catch (error) {
        this.sendError(res, error)
      }
    })

    this.app.get('/api/clip/tasks', (req, res) => {
      res.json(this.db.getClipTasks())
    })

    this.app.post('/api/clip/execute', async (req, res) => {
      try {
        const { url, title, startTime, endTime, audioQualityIndex, videoQualityIndex } = req.body
        const taskId = this.db.createClipTask({
          url,
          title: title || 'Clip',
          start_time: Number(startTime) || 0,
          end_time: Number(endTime) || 0
        })

        res.json({ taskId, status: 'pending' })

        // Execute in background
        this.clipService.executeClip(
          url, Number(startTime) || 0, Number(endTime) || 0, Number(audioQualityIndex) || 0, Number(videoQualityIndex) || 0,
          (progress) => {
            this.db.updateClipTask(taskId, { progress, status: 'processing' })
            this.emitClipTaskUpdate(taskId)
          }
        ).then(result => {
          this.db.updateClipTask(taskId, { progress: 100, status: 'done', file_path: (result as { path: string }).path })
          this.emitClipTaskUpdate(taskId)
        }).catch(error => {
          this.db.updateClipTask(taskId, { status: 'error', message: error.message })
          this.emitClipTaskUpdate(taskId)
        })

      } catch (error) {
        this.sendError(res, error)
      }
    })
  }

  private emitClipTaskUpdate(taskId: number) {
    const tasks = this.db.getClipTasks()
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    const raw = JSON.stringify({ type: 'clip_task_update', data: task })
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(raw)
      }
    }
  }

  // ──────────────────────── Runtime / Queue ────────────────────────

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

  private recoverInterruptedTasks() {
    const replays = this.db.getReplays(this.baseDir)
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
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay) return false
    if (this.activeTasks.has(liveKey)) return true
    if (!this.queue.includes(liveKey)) {
      this.queue.push(liveKey)
    }
    const nextProgress = options?.resetProgress ? 0 : replay.progress
    this.db.patchReplay(liveKey, {
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
      const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
      if (!replay) continue
      const controller = new AbortController()
      this.runningTasks += 1
      const promise = this.downloaderService.processReplayTask(liveKey, controller.signal, this.baseDir)
        .catch(error => {
          const message = error instanceof Error ? error.message : 'Unknown error'
          this.db.patchReplay(liveKey, { status: 'failed', message, speed: '', eta: '' })
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
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay) return false
    this.pausedTasks.add(liveKey)
    this.runtimePaused = false
    this.removeFromQueue(liveKey)
    this.db.patchReplay(liveKey, {
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
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay) return false
    this.pausedTasks.delete(liveKey)
    return this.enqueueReplay(liveKey, { resetProgress: false, message: 'Resumed' })
  }

  private pauseAll() {
    this.runtimePaused = true
    let count = 0
    for (const replay of this.db.getReplays(this.baseDir)) {
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
    for (const replay of this.db.getReplays(this.baseDir)) {
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
    for (const replay of this.db.getReplays(this.baseDir)) {
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
    for (const replay of this.db.getReplays(this.baseDir)) {
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
    for (const replay of this.db.getReplays(this.baseDir)) {
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

  // ──────────────────────── Scan / Covers ────────────────────────

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
    const payload = await this.bilibiliClient.fetchJSON<{
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
    const existingByLiveKey = new Map(this.db.getReplays(this.baseDir).map(item => [item.live_key, item]))
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

      const existing = this.db.getReplays(this.baseDir)
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
        const response = await this.bilibiliClient.fetchWithCookies(coverUrl, {
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

  // ──────────────────────── Disk / FS ────────────────────────

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

  // ──────────────────────── Helpers ────────────────────────

  private sendError(res: Response, error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
}

export async function startDesktopBackend(options?: { baseDir?: string }) {
  const baseDir = detectBaseDir(options?.baseDir || process.cwd())

  // Use Electron's net.fetch (Chromium network stack) to avoid TLS fingerprint blocking
  let customFetch: typeof globalThis.fetch | undefined
  try {
    const { net } = require('electron')
    if (net?.fetch) customFetch = net.fetch.bind(net)
  } catch {}

  const backend = await DesktopBackend.create(baseDir, customFetch)
  const baseURL = await backend.listen()
  return {
    baseURL,
    stop: () => backend.stop(),
  }
}
