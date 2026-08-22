import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import express, { type Response } from 'express'
import { WebSocketServer } from 'ws'

import {
  AppConfig,
  ReplayRecord,
  ReplayPatch,
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
import { FeishuClient } from './feishu'
import { registerBilibiliRoutes } from './routes/bilibili'
import { registerSystemRoutes } from './routes/system'
import { registerReplayRoutes } from './routes/replays'
import { registerClipRoutes } from './routes/clip'
import { registerFeishuRoutes } from './routes/feishu'

const ACTIVE_REPLAY_STATUSES = ['pending', 'downloading', 'merging'] as const

function isAllowedLocalOrigin(origin: string | undefined) {
  if (!origin || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  } catch {
    return false
  }
}

export class DesktopBackend {
  public readonly baseDir: string
  public readonly configPath: string
  public config: AppConfig
  public readonly db: SqliteStore
  public readonly bilibiliClient: BilibiliClient
  public readonly downloaderService: DownloaderService
  public readonly clipService: ClipService
  public feishuClient: FeishuClient

  public readonly app = express()
  public readonly server = http.createServer(this.app)
  public readonly wss = new WebSocketServer({ noServer: true })

  public runtimePaused = false
  public readonly activeTasks = new Map<string, TaskHandle>()
  public readonly pausedTasks = new Set<string>()
  public readonly runtimePausedTasks = new Set<string>()
  public readonly deletingReplays = new Set<string>()
  public runningTasks = 0
  public readonly queue: string[] = []
  private readonly replayTaskGenerations = new Map<string, number>()
  public readonly clipTaskPromises = new Map<number, Promise<void>>()
  public readonly clipTaskQueue: number[] = []
  private readonly clipTaskRunners = new Map<number, (controller: AbortController) => Promise<void>>()
  private stopPromise: Promise<void> | null = null
  private configMutationQueue: Promise<void> = Promise.resolve()
  private stopping = false
  private mutationSequence = 0
  private readonly inFlightMutations = new Map<number, { controller: AbortController; promise: Promise<void> }>()

  public diskStatsCache: {
    value: { path: string; total_bytes: number; free_bytes: number; used_by_service_bytes: number }
    expiresAt: number
  } | null = null
  public diskStatsPromise: Promise<{
    path: string; total_bytes: number; free_bytes: number; used_by_service_bytes: number
  }> | null = null
  public diskStatsGeneration = 0

  private constructor(baseDir: string, config: AppConfig, db: SqliteStore, customFetch?: typeof globalThis.fetch) {
    this.baseDir = baseDir
    this.configPath = path.join(baseDir, 'config.yaml')
    this.config = config
    this.db = db

    this.bilibiliClient = new BilibiliClient(config, db, customFetch)
    this.downloaderService = new DownloaderService(config, db, this.bilibiliClient, (p) => this.emitProgress(p))
    this.clipService = new ClipService(config, this.bilibiliClient, baseDir)
    this.feishuClient = new FeishuClient(config.feishu)

    ensureDir(this.config.download.output_dir)
    ensureDir(this.config.download.temp_dir)
    ensureDir(path.join(this.config.download.output_dir, 'covers'))
    this.bilibiliClient.loadCookies()
    this.db.ensureSchema()

    this.app.use(express.json({ limit: '2mb' }))
    this.app.use((req, res, next) => {
      const origin = req.headers.origin
      if (!isAllowedLocalOrigin(origin)) {
        res.status(403).json({ error: 'Origin not allowed' })
        return
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      if (req.method === 'OPTIONS') {
        res.status(204).end()
        return
      }
      next()
    })
    this.app.use((_req, res, next) => {
      if (this.stopping) {
        res.status(503).json({ error: 'Backend is shutting down' })
        return
      }
      next()
    })
    this.registerRoutes()
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws' || !isAllowedLocalOrigin(req.headers.origin)) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        ws.send(JSON.stringify({ live_key: '', progress: 0, merge_progress: 0, status: 'idle', message: 'connected', speed: '', speed_history: [], elapsed: '', eta: '' }))
        ws.on('message', raw => {
          try {
            const message = JSON.parse(raw.toString()) as { type?: string }
            if (message.type === 'ping' && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }))
            }
          } catch {
            // Ignore malformed client messages; progress is server-driven.
          }
        })
      })
    })
  }

  static async create(baseDir: string, customFetch?: typeof globalThis.fetch) {
    const configPath = path.join(baseDir, 'config.yaml')
    const config = loadConfigFile(baseDir, configPath)
    const db = await SqliteStore.open(config.database.dsn)
    return new DesktopBackend(baseDir, config, db, customFetch)
  }

  public updateConfig(mutator: (draft: AppConfig) => AppConfig | void): Promise<AppConfig> {
    const operation = this.configMutationQueue.then(async () => {
      const previous = structuredClone(this.config)
      const draft = structuredClone(this.config)
      const candidate = mutator(draft) ?? draft
      const normalized = normalizeConfigWithBase(this.baseDir, candidate)

      ensureDir(normalized.download.output_dir)
      ensureDir(normalized.download.temp_dir)
      ensureDir(normalized.download.clip_output_dir)
      ensureDir(path.join(normalized.download.output_dir, 'covers'))
      await saveConfigFile(this.baseDir, this.configPath, normalized)

      for (const key of Object.keys(this.config)) delete (this.config as any)[key]
      Object.assign(this.config, normalized)
      if (JSON.stringify(previous.feishu) !== JSON.stringify(normalized.feishu)) {
        this.feishuClient = new FeishuClient(this.config.feishu)
      }
      this.diskStatsGeneration += 1
      this.diskStatsCache = null
      this.diskStatsPromise = null
      this.scheduleQueue()
      this.scheduleClipTasks()
      return structuredClone(this.config)
    })
    this.configMutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  public beginMutation() {
    if (this.stopping) {
      throw new Error('Backend is shutting down')
    }
    const id = ++this.mutationSequence
    const controller = new AbortController()
    let resolvePromise!: () => void
    const promise = new Promise<void>(resolve => { resolvePromise = resolve })
    this.inFlightMutations.set(id, { controller, promise })
    let finished = false
    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return
        finished = true
        this.inFlightMutations.delete(id)
        resolvePromise()
      },
    }
  }

  async listen() {
    this.db.cleanupCorruptedReplays()
    this.db.healDeletedReplays(this.baseDir)
    this.db.cleanupStaleClipTasks()
    this.db.healMissingClipFiles(this.baseDir)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.server.port, '127.0.0.1')
    })
    this.recoverInterruptedTasks()
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to resolve backend port')
    }
    return `http://127.0.0.1:${addr.port}`
  }

  async stop() {
    if (!this.stopPromise) this.stopPromise = this.stopInternal()
    await this.stopPromise
  }

  private async stopInternal() {
    this.stopping = true
    this.runtimePaused = true
    this.queue.splice(0, this.queue.length)
    for (const taskId of this.clipTaskQueue.splice(0, this.clipTaskQueue.length)) {
      this.clipTaskRunners.delete(taskId)
      this.db.updateClipTask(taskId, { status: 'error', message: 'App closed before processing', file_path: '' })
      this.emitClipTaskUpdate(taskId)
    }

    const replayPromises = [...this.activeTasks.values()].map(handle => handle.promise)
    const clipPromises = [...this.clipTaskPromises.values()]
    const mutationPromises = [...this.inFlightMutations.values()].map(handle => handle.promise)
    for (const handle of this.activeTasks.values()) handle.controller.abort()
    for (const controller of this.clipTasksAbort.values()) controller.abort()
    for (const mutation of this.inFlightMutations.values()) mutation.controller.abort()

    for (const client of this.wss.clients) client.terminate()
    const websocketClosed = new Promise<void>(resolve => {
      try {
        this.wss.close(() => resolve())
      } catch {
        resolve()
      }
    })

    const serverClosed = new Promise<void>(resolve => {
      if (!this.server.listening) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      this.server.closeIdleConnections?.()
    })

    await Promise.allSettled([...replayPromises, ...clipPromises, ...mutationPromises, this.configMutationQueue])
    this.server.closeAllConnections?.()
    await Promise.all([websocketClosed, serverClosed])
    await this.db.close()
  }

  // ──────────────────────────── Routes ────────────────────────────

  public registerRoutes() {
    registerSystemRoutes(this)
    registerBilibiliRoutes(this)
    registerReplayRoutes(this)
    registerClipRoutes(this)
    registerFeishuRoutes(this)
  }

  public emitClipTaskUpdate(taskId: number) {
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

  public updateProgressDebounced: Record<string, NodeJS.Timeout> = {}
  public clipTasksAbort = new Map<number, AbortController>()

  public getRuntime(): RuntimeSnapshot {
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

  public recoverInterruptedTasks() {
    const replays = this.db.getReplays(this.baseDir)
    for (const replay of replays) {
      if (['pending', 'downloading', 'merging'].includes(replay.status)) {
        this.enqueueReplay(replay.live_key, { resetProgress: false, message: 'Recovered pending task' })
      }
    }
  }

  public emitProgress(update: Partial<ProgressUpdate> & Pick<ProgressUpdate, 'live_key' | 'status'>) {
    const replay = this.db.getReplayByLiveKey(this.baseDir, update.live_key)
    const payload: ProgressUpdate = {
      live_key: update.live_key,
      updated_at: replay?.UpdatedAt ?? update.updated_at ?? new Date().toISOString(),
      progress: replay?.progress ?? update.progress ?? 0,
      merge_progress: update.merge_progress ?? 0,
      status: replay?.status ?? update.status,
      message: replay?.message ?? update.message ?? '',
      speed: replay?.speed ?? update.speed ?? '',
      speed_history: update.speed_history ?? [],
      elapsed: replay?.elapsed ?? update.elapsed ?? '',
      eta: replay?.eta ?? update.eta ?? '',
    }
    const raw = JSON.stringify(payload)
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(raw)
      }
    }
  }

  public enqueueClipTask(taskId: number, runner: (controller: AbortController) => Promise<void>) {
    if (this.stopping || this.clipTaskRunners.has(taskId) || this.clipTaskPromises.has(taskId)) return false
    this.clipTaskRunners.set(taskId, runner)
    this.clipTaskQueue.push(taskId)
    this.scheduleClipTasks()
    return true
  }

  public cancelClipTask(taskId: number) {
    const queuedIndex = this.clipTaskQueue.indexOf(taskId)
    if (queuedIndex >= 0) {
      this.clipTaskQueue.splice(queuedIndex, 1)
      this.clipTaskRunners.delete(taskId)
      this.db.updateClipTask(taskId, { status: 'error', message: 'Cancelled', file_path: '' })
      this.emitClipTaskUpdate(taskId)
      return true
    }

    const controller = this.clipTasksAbort.get(taskId)
    if (controller) {
      controller.abort()
      this.db.updateClipTask(taskId, { status: 'error', message: 'Cancelled', file_path: '' })
      this.emitClipTaskUpdate(taskId)
      return true
    }
    const task = this.db.getClipTasks().find(candidate => candidate.id === taskId)
    return task?.status === 'error' && task.message === 'Cancelled'
  }

  private scheduleClipTasks() {
    const limit = Math.max(1, this.config.download.max_concurrent_tasks)
    while (
      !this.stopping
      && this.runningTasks + this.clipTaskPromises.size < limit
      && this.clipTaskQueue.length > 0
    ) {
      const taskId = this.clipTaskQueue.shift()!
      const runner = this.clipTaskRunners.get(taskId)
      this.clipTaskRunners.delete(taskId)
      if (!runner) continue

      const controller = new AbortController()
      this.clipTasksAbort.set(taskId, controller)
      this.db.updateClipTask(taskId, { status: 'processing', message: 'Starting...' })
      this.emitClipTaskUpdate(taskId)
      let execution!: Promise<void>
      execution = Promise.resolve()
        .then(() => runner(controller))
        .finally(() => {
          if (this.clipTasksAbort.get(taskId) === controller) this.clipTasksAbort.delete(taskId)
          if (this.clipTaskPromises.get(taskId) === execution) this.clipTaskPromises.delete(taskId)
          // Replay and clip work share the configured global task budget. Give
          // the opposite queue first chance at the newly released slot.
          this.scheduleQueue()
          this.scheduleClipTasks()
        })
      this.clipTaskPromises.set(taskId, execution)
    }
  }

  public emitReplayUpdate(liveKey: string, extras?: Partial<ProgressUpdate>) {
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay) return
    this.emitProgress({ ...extras, live_key: liveKey, status: replay.status })
  }

  public updateReplayState(
    liveKey: string,
    patch: ReplayPatch,
    allowedStatuses?: readonly string[],
    extras?: Partial<ProgressUpdate>,
  ) {
    const changed = allowedStatuses
      ? this.db.patchReplayIfStatus(liveKey, allowedStatuses, patch)
      : this.db.patchReplay(liveKey, patch)
    if (!changed) return null
    this.emitReplayUpdate(liveKey, extras)
    return this.db.getReplayByLiveKey(this.baseDir, liveKey)
  }

  public enqueueReplay(liveKey: string, options?: { resetProgress?: boolean; message?: string }) {
    if (this.stopping || this.deletingReplays.has(liveKey)) return false
    this.db.healDeletedReplays(this.baseDir)
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay) return false
    const active = this.activeTasks.get(liveKey)
    if (active && !active.controller.signal.aborted) return true
    const queueableStatuses = ['not_downloaded', 'failed', 'deleted', 'paused', ...ACTIVE_REPLAY_STATUSES]
    if (!queueableStatuses.includes(replay.status)) return false
    if (!this.queue.includes(liveKey)) {
      this.queue.push(liveKey)
    }
    const nextProgress = options?.resetProgress ? 0 : replay.progress
    const resetArtifact = replay.status === 'deleted' || replay.status === 'failed'
    const updated = this.updateReplayState(liveKey, {
      status: 'pending',
      message: options?.message || 'Queued',
      progress: nextProgress,
      speed: '',
      elapsed: options?.resetProgress ? '' : replay.elapsed,
      eta: '',
      ...(resetArtifact ? {
        file_path: '',
        file_size: 0,
        resolution: '',
        bitrate: '',
        verify_ok: false,
        actual_duration: 0,
      } : {}),
    })
    if (!updated) {
      this.removeFromQueue(liveKey)
      return false
    }
    this.scheduleQueue()
    return true
  }

  public scheduleQueue() {
    while (
      !this.stopping
      && !this.runtimePaused
      && this.runningTasks + this.clipTaskPromises.size < this.config.download.max_concurrent_tasks
      && this.queue.length > 0
    ) {
      let foundIndex = -1
      let targetKey: string | null = null

      for (let i = 0; i < this.queue.length; i++) {
        const key = this.queue[i]
        if (this.pausedTasks.has(key)) {
          this.queue.splice(i, 1)
          i--
          continue
        }
        if (this.activeTasks.has(key)) {
          continue // Winding down, leave in queue for later
        }
        foundIndex = i
        targetKey = key
        break
      }

      if (foundIndex !== -1 && targetKey) {
        this.queue.splice(foundIndex, 1)
        const liveKey = targetKey
        
        const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
        if (!replay) continue
        const controller = new AbortController()
        const generation = (this.replayTaskGenerations.get(liveKey) || 0) + 1
        this.replayTaskGenerations.set(liveKey, generation)
        const handle: TaskHandle = { controller, generation, promise: Promise.resolve() }
        const isSameExecution = () => {
          const current = this.activeTasks.get(liveKey)
          return current?.generation === generation && current.controller === controller
        }
        this.activeTasks.set(liveKey, handle)
        this.runningTasks += 1
        const promise = this.downloaderService.processReplayTask(
          liveKey,
          controller.signal,
          this.baseDir,
          () => isSameExecution() && !controller.signal.aborted,
        )
          .catch(error => {
            if (controller.signal.aborted || !isSameExecution()) return
            const message = error instanceof Error ? error.message : 'Unknown error'
            this.updateReplayState(
              liveKey,
              { status: 'failed', message, speed: '', eta: '' },
              ACTIVE_REPLAY_STATUSES,
            )
          })
          .finally(() => {
            if (isSameExecution()) {
              this.runningTasks = Math.max(0, this.runningTasks - 1)
              this.activeTasks.delete(liveKey)
            }
            // See scheduleClipTasks: both task kinds consume the same global
            // concurrency budget, with the opposite queue getting first turn.
            this.scheduleClipTasks()
            this.scheduleQueue()
          })
        handle.promise = promise
      } else {
        break
      }
    }
  }

  public pauseReplay(liveKey: string) {
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay) return false
    if (replay.status === 'paused') {
      this.pausedTasks.add(liveKey)
      this.removeFromQueue(liveKey)
      this.activeTasks.get(liveKey)?.controller.abort()
      return true
    }
    if (!ACTIVE_REPLAY_STATUSES.includes(replay.status as typeof ACTIVE_REPLAY_STATUSES[number])) return false
    this.pausedTasks.add(liveKey)
    this.removeFromQueue(liveKey)
    const updated = this.updateReplayState(liveKey, {
      status: 'paused',
      message: 'Paused',
      speed: '',
      eta: '',
    }, ACTIVE_REPLAY_STATUSES)
    if (!updated) {
      this.pausedTasks.delete(liveKey)
      return false
    }
    const active = this.activeTasks.get(liveKey)
    if (active) {
      active.controller.abort()
    }
    return true
  }

  public resumeReplay(liveKey: string) {
    if (this.stopping || this.deletingReplays.has(liveKey)) return false
    const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
    if (!replay || replay.status !== 'paused') return false
    this.runtimePausedTasks.delete(liveKey)
    this.pausedTasks.delete(liveKey)
    return this.enqueueReplay(liveKey, { resetProgress: false, message: 'Resumed' })
  }

  public pauseAll() {
    this.runtimePaused = true
    let count = 0
    for (const replay of this.db.getReplays(this.baseDir)) {
      if (replay.status === 'paused') {
        this.pauseReplay(replay.live_key)
        continue
      }
      if (ACTIVE_REPLAY_STATUSES.includes(replay.status as typeof ACTIVE_REPLAY_STATUSES[number])) {
        if (this.pauseReplay(replay.live_key)) {
          this.runtimePausedTasks.add(replay.live_key)
          count += 1
        }
      }
    }
    return count
  }

  public resumeAll() {
    if (this.stopping) return 0
    this.runtimePaused = false
    let count = 0
    const pausedByRuntime = [...this.runtimePausedTasks]
    for (const liveKey of pausedByRuntime) {
      this.runtimePausedTasks.delete(liveKey)
      const replay = this.db.getReplayByLiveKey(this.baseDir, liveKey)
      if (replay?.status === 'paused' && this.resumeReplay(liveKey)) {
        count += 1
      }
    }
    this.scheduleQueue()
    return count
  }

  public async cleanupStaleReplayTasks() {
    const promises = new Set<Promise<void>>()
    let count = 0
    for (const replay of this.db.getReplays(this.baseDir)) {
      if (!ACTIVE_REPLAY_STATUSES.includes(replay.status as typeof ACTIVE_REPLAY_STATUSES[number])) continue
      this.pausedTasks.add(replay.live_key)
      this.removeFromQueue(replay.live_key)
      const updated = this.updateReplayState(
        replay.live_key,
        {
          status: 'paused',
          message: 'Reset by cleanup-stale',
          progress: 0,
          speed: '',
          elapsed: '',
          eta: '',
        },
        ACTIVE_REPLAY_STATUSES,
      )
      if (!updated) continue
      count += 1
      const active = this.activeTasks.get(replay.live_key)
      if (active) {
        active.controller.abort()
        promises.add(active.promise)
      }
    }
    for (const active of this.activeTasks.values()) {
      active.controller.abort()
      promises.add(active.promise)
    }
    await Promise.allSettled([...promises])
    return count
  }

  public retryFailed() {
    if (this.stopping) return 0
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

  public downloadUnfinished() {
    if (this.stopping) return 0
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

  public syncAllPending() {
    if (this.stopping) return 0
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

  public removeFromQueue(liveKey: string) {
    let idx = this.queue.indexOf(liveKey)
    while (idx >= 0) {
      this.queue.splice(idx, 1)
      idx = this.queue.indexOf(liveKey)
    }
  }

  // ──────────────────────── Scan / Covers ────────────────────────

  public async scanReplays(signal?: AbortSignal): Promise<ScanSummary> {
    signal?.throwIfAborted()
    if (!this.config.bilibili.anchor_id) {
      throw new Error('请先在设置中填写 Bilibili 主播 UID')
    }

    const markedDeleted = this.db.healDeletedReplays(this.baseDir)

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
    }>(
      `https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetOtherSliceList?${params.toString()}`,
      signal ? { signal } : undefined,
    )
    signal?.throwIfAborted()
    if (payload.code !== 0) {
      throw new Error(payload.message || 'Scan failed')
    }

    const rows = payload.data?.replay_info ?? []
    let newRecords = 0
    let updatedRecords = 0
    let coversUpdated = 0
    let alreadyUpToDate = 0

    await this.db.withBatch(async () => {
      for (const r of rows) {
        signal?.throwIfAborted()
        const existing = this.db.getReplayByLiveKey(this.baseDir, r.live_key)
        const title = r.live_info?.title || ''
        const coverUrl = r.live_info?.cover || ''
        const duration = r.video_info?.duration ?? 0
        if (!existing) {
          const localCover = await this.downloadCover(r.live_key, coverUrl, false, signal)
          this.db.insertReplay({
            replay_id: r.replay_id,
            live_key: r.live_key,
            room_id: r.room_id,
            title,
            start_time: r.start_time,
            end_time: r.end_time,
            duration,
            cover_url: coverUrl,
            local_cover: localCover,
            status: 'not_downloaded',
            message: '',
          })
          newRecords += 1
        } else {
          const coverPath = existing.local_cover
            ? path.join(this.config.download.output_dir, 'covers', existing.local_cover)
            : ''
          const coverNeedsRefresh = Boolean(coverUrl) && (
            coverUrl !== existing.cover_url
            || !existing.local_cover
            || !fs.existsSync(coverPath)
          )
          const downloadedCover = coverNeedsRefresh
            ? await this.downloadCover(r.live_key, coverUrl, true, signal)
            : ''
          const localCover = downloadedCover || (coverUrl === existing.cover_url ? existing.local_cover : '')
          const metadataChanged = existing.replay_id !== r.replay_id
            || existing.room_id !== r.room_id
            || existing.title !== title
            || existing.start_time !== r.start_time
            || existing.end_time !== r.end_time
            || existing.duration !== duration
            || existing.cover_url !== coverUrl
            || existing.local_cover !== localCover

          if (downloadedCover && (downloadedCover !== existing.local_cover || coverNeedsRefresh)) {
            coversUpdated += 1
          }

          if (!metadataChanged) {
            if (!coverNeedsRefresh) alreadyUpToDate += 1
            continue
          }

          this.db.patchReplay(r.live_key, {
            replay_id: r.replay_id,
            room_id: r.room_id,
            title,
            start_time: r.start_time,
            end_time: r.end_time,
            duration,
            cover_url: coverUrl,
            local_cover: localCover,
          })
          updatedRecords += 1
        }
      }
    })

    return {
      fetched: rows.length,
      new_records: newRecords,
      updated_records: updatedRecords,
      covers_updated: coversUpdated,
      marked_deleted: markedDeleted,
      already_up_to_date: alreadyUpToDate,
    }
  }

  public async downloadCover(liveKey: string, coverUrl: string, force = false, signal?: AbortSignal) {
    if (!coverUrl) return ''
    try {
      signal?.throwIfAborted()
      const ext = path.extname(new URL(coverUrl).pathname) || '.jpg'
      const filename = `${liveKey}${ext}`
      const fullPath = path.join(this.config.download.output_dir, 'covers', filename)
      if (force || !fs.existsSync(fullPath)) {
        const response = await this.bilibiliClient.fetchWithCookies(coverUrl, signal ? { signal } : undefined)
        if (!response.ok) return ''
        const buffer = Buffer.from(await response.arrayBuffer())
        signal?.throwIfAborted()
        await fsp.writeFile(fullPath, buffer)
      }
      return filename
    } catch (error) {
      if (signal?.aborted) throw error
      return ''
    }
  }

  // ──────────────────────── Disk / FS ────────────────────────

  public async getDiskStats() {
    const now = Date.now()
    if (this.diskStatsCache && this.diskStatsCache.expiresAt > now) {
      return this.diskStatsCache.value
    }
    if (this.diskStatsPromise) {
      return await this.diskStatsPromise
    }
    const generation = this.diskStatsGeneration
    const target = this.config.download.output_dir || this.baseDir
    const outputDir = this.config.download.output_dir
    const tempDir = this.config.download.temp_dir
    const pending = (async () => {
      const stat = await fsp.statfs(target)
      const usedByService = (await this.getDirSize(outputDir)) + (await this.getDirSize(tempDir))
      const value = {
        path: target,
        total_bytes: stat.bsize * stat.blocks,
        free_bytes: stat.bsize * stat.bfree,
        used_by_service_bytes: usedByService,
      }
      if (this.diskStatsGeneration === generation) {
        this.diskStatsCache = {
          value,
          expiresAt: Date.now() + 60_000,
        }
      }
      return value
    })()
    this.diskStatsPromise = pending
    try {
      return await pending
    } finally {
      if (this.diskStatsPromise === pending) this.diskStatsPromise = null
    }
  }

  public async getDirSize(target: string): Promise<number> {
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

  public async listDirectories(current: string) {
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

  public sendError(res: Response, error: unknown) {
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
