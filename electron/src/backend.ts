import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'

import express, { type Response } from 'express'
import { WebSocketServer } from 'ws'
import { parseFile } from 'music-metadata'

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
  recoverPortableConfigPaths,
  detectBaseDir,
  resolveAppPathWithBase,
} from './config'
import {
  CLIP_TEMP_DIR_RE,
  CLIP_TEMP_SENTINEL,
  CLIP_TEMP_SENTINEL_CONTENT,
  parseDeleteEntryName,
  parseOwnedDeleteEntryName,
  parseReplayTempSentinel,
  REPLAY_TEMP_DIR_RE,
  REPLAY_TEMP_SENTINEL,
  fileMatchesIdentity,
  safeNumber,
  ensureDir,
  publishFileWithRetry,
  removeFileWithRetry,
  removePathWithRetry,
  tryReadDirectoryIdentity,
  tryReadFileIdentity,
} from './utils'
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

function recoverablePartPathFromFailure(value: unknown) {
  if (!value) return undefined
  if (typeof value === 'object') {
    const sourcePath = (value as { sourcePath?: unknown }).sourcePath
    if (typeof sourcePath === 'string' && /\.part\.mp4$/i.test(sourcePath)) return sourcePath
  }
  return undefined
}

export function isAllowedLocalOrigin(origin: string | undefined) {
  if (!origin || origin === 'null') return true
  // Electron pages loaded with loadFile() send a file origin. Rejecting it
  // leaves REST requests working but puts packaged realtime state into an
  // endless reconnect loop.
  if (origin === 'file:' || origin === 'file://') return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'file:' && !parsed.hostname) return true
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
  public readonly cachingReplays = new Set<string>()
  public runningTasks = 0
  public readonly queue: string[] = []
  private readonly replayTaskGenerations = new Map<string, number>()
  public readonly clipTaskPromises = new Map<number, Promise<void>>()
  public readonly clipTaskQueue: number[] = []
  private readonly clipTaskRunners = new Map<number, (controller: AbortController) => Promise<void>>()
  public databaseMaintenance = false
  private stopPromise: Promise<void> | null = null
  private startupReconciliationPromise: Promise<void> | null = null
  private startupReconciliationController: AbortController | null = null
  private clipOutputReconciliationPromise: Promise<void> | null = null
  private clipOutputReconciliationController: AbortController | null = null
  private lastClipOutputReconciliationAt = 0
  private configMutationQueue: Promise<void> = Promise.resolve()
  private stopping = false
  private mutationSequence = 0
  private readonly inFlightMutations = new Map<number, { controller: AbortController; promise: Promise<void> }>()
  private readonly portablePreviousBase: string

  public diskStatsCache: {
    value: { path: string; total_bytes: number; free_bytes: number; used_by_service_bytes: number }
    expiresAt: number
  } | null = null
  public diskStatsPromise: Promise<{
    path: string; total_bytes: number; free_bytes: number; used_by_service_bytes: number
  }> | null = null
  public diskStatsGeneration = 0

  private constructor(
    baseDir: string,
    config: AppConfig,
    db: SqliteStore,
    customFetch?: typeof globalThis.fetch,
    portablePreviousBase = '',
  ) {
    this.baseDir = baseDir
    this.configPath = path.join(baseDir, 'config.yaml')
    this.config = config
    this.db = db
    this.portablePreviousBase = portablePreviousBase

    this.bilibiliClient = new BilibiliClient(config, db, customFetch)
    this.downloaderService = new DownloaderService(config, db, this.bilibiliClient, (p) => this.emitProgress(p))
    this.clipService = new ClipService(config, this.bilibiliClient, baseDir)
    this.feishuClient = new FeishuClient(config.feishu)

    const ensureBaseLocalDir = (directory: string) => {
      const relative = path.relative(this.baseDir, path.resolve(directory))
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
      try {
        ensureDir(directory)
      } catch (error) {
        // A bad/readonly package-local directory must not prevent the settings
        // UI from opening. The actual task reports the actionable path error.
        console.warn(`[startup] Unable to prepare directory ${directory}:`, error)
      }
    }
    ensureBaseLocalDir(this.config.download.output_dir)
    ensureBaseLocalDir(this.config.download.temp_dir)
    ensureBaseLocalDir(this.config.download.clip_output_dir)
    ensureBaseLocalDir(path.join(this.config.download.output_dir, 'covers'))
    this.db.ensureSchema(this.baseDir)

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
      const mutatesDuringMaintenance = !['GET', 'HEAD', 'OPTIONS'].includes(_req.method)
        || _req.path === '/api/login/poll'
      if (this.databaseMaintenance && mutatesDuringMaintenance) {
        res.status(409).json({ error: 'Database maintenance is in progress' })
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
    const config = await recoverPortableConfigPaths(
      baseDir,
      configPath,
      loadConfigFile(baseDir, configPath),
    )
    const db = await SqliteStore.open(config.database.dsn)
    return new DesktopBackend(
      baseDir,
      config,
      db,
      customFetch,
      String((config as AppConfig & { __portable_previous_base?: string }).__portable_previous_base || ''),
    )
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
    if (this.databaseMaintenance) {
      throw new Error('Database maintenance is in progress')
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

  public hasInFlightMutations() {
    return this.inFlightMutations.size > 0
  }

  public isStopping() {
    return this.stopping
  }

  async listen() {
    // Bring the loopback server/window up before touching a potentially huge
    // history whose files may live on disconnected network/external drives.
    // Mutations stay gated until responsive, asynchronous reconciliation ends.
    this.databaseMaintenance = true
    const listenOnPort = (port: number) => new Promise<void>((resolve, reject) => {
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
      this.server.listen(port, '127.0.0.1')
    })
    try {
      await listenOnPort(this.config.server.port)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.config.server.port === 0) throw error
      console.warn(`[backend] Port ${this.config.server.port} is already in use; falling back to an available local port`)
      await listenOnPort(0)
    }
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to resolve backend port')
    }
    const startupController = new AbortController()
    this.startupReconciliationController = startupController
    this.startupReconciliationPromise = new Promise<void>(resolve => setImmediate(resolve))
      .then(async () => {
        const runStage = async (name: string, operation: () => void | Promise<void>) => {
          startupController.signal.throwIfAborted()
          try {
            await operation()
          } catch (error) {
            if ((error as Error).name === 'AbortError' || startupController.signal.aborted) throw error
            // One bad cookie file, portable row, or stale directory must not
            // prevent durable replay/clip states later in the pipeline from
            // converging before mutations are enabled.
            console.error(`[backend] Startup reconciliation stage failed (${name}):`, error)
          }
        }
        await runStage('cookies', () => this.bilibiliClient.loadCookies(startupController.signal))
        await runStage('corrupted rows', () => { this.db.cleanupCorruptedReplays() })
        await runStage('portable paths', () => this.recoverPortableOutputPaths(startupController.signal))
        await runStage('legacy identities', () => this.db.adoptLegacyOutputIdentitiesAsync(
          this.baseDir,
          startupController.signal,
          { baseLocalOnly: true },
        ).then(() => undefined))
        await runStage('replay outputs', () => this.db.healDeletedReplaysAsync(
          this.baseDir,
          startupController.signal,
          { baseLocalOnly: true },
        ).then(() => undefined))
        await runStage('stale temp directories', () => this.recoverStaleClipTempDirectories(startupController.signal))
        await runStage('interrupted clip artifacts', () => this.recoverInterruptedClipArtifacts(startupController.signal))
        await runStage('clip outputs', () => this.db.healMissingClipFilesAsync(
          this.baseDir,
          startupController.signal,
          { baseLocalOnly: true },
        ).then(() => undefined))
      })
      .catch(error => {
        if ((error as Error).name !== 'AbortError') {
          console.error('[backend] Startup reconciliation failed:', error)
        }
      })
      .finally(() => {
        this.databaseMaintenance = false
        this.emitStateReconciled()
        if (!this.stopping) this.recoverInterruptedTasks()
        if (this.startupReconciliationController === startupController) {
          this.startupReconciliationController = null
        }
        this.startupReconciliationPromise = null
      })
    return `http://127.0.0.1:${addr.port}`
  }

  public async waitForStartupReconciliation() {
    await this.startupReconciliationPromise
  }

  public scheduleClipOutputReconciliation() {
    if (
      this.stopping
      || this.databaseMaintenance
      || this.clipOutputReconciliationPromise
      || Date.now() - this.lastClipOutputReconciliationAt < 60_000
    ) return
    this.lastClipOutputReconciliationAt = Date.now()
    const controller = new AbortController()
    this.clipOutputReconciliationController = controller
    const promise = (async () => {
      const runStage = async (name: string, operation: () => void | Promise<void>) => {
        controller.signal.throwIfAborted()
        try {
          await operation()
        } catch (error) {
          if ((error as Error).name === 'AbortError' || controller.signal.aborted) throw error
          console.error(`[outputs] Background reconciliation stage failed (${name}):`, error)
        }
      }
      // External/removable paths are deliberately reconciled only here, after
      // the API is responsive. A slow or disconnected drive cannot delay the
      // first window, while legacy identities and availability still converge
      // once a replay/task list is viewed.
      await runStage('legacy identities', () => this.db.adoptLegacyOutputIdentitiesAsync(
        this.baseDir,
        controller.signal,
      ).then(() => undefined))
      await runStage('replay outputs', () => this.db.healDeletedReplaysAsync(
        this.baseDir,
        controller.signal,
      ).then(() => undefined))
      let healedClipIds: number[] = []
      await runStage('clip outputs', async () => {
        healedClipIds = await this.db.healMissingClipFilesAsync(this.baseDir, controller.signal)
      })
      if (controller.signal.aborted || this.stopping) return
      for (const id of healedClipIds) this.emitClipTaskUpdate(id)
      this.emitStateReconciled()
    })()
      .catch(error => {
        if ((error as Error).name !== 'AbortError') {
          console.error('[outputs] Background output reconciliation failed:', error)
        }
      })
      .finally(() => {
        if (this.clipOutputReconciliationController === controller) {
          this.clipOutputReconciliationController = null
        }
        if (this.clipOutputReconciliationPromise === promise) {
          this.clipOutputReconciliationPromise = null
        }
      })
    this.clipOutputReconciliationPromise = promise
  }

  private async recoverPortableOutputPaths(signal?: AbortSignal) {
    const resolveStoredPath = (storedPath: string) => path.isAbsolute(storedPath)
      ? path.resolve(storedPath)
      : path.resolve(this.baseDir, storedPath)
    const isInsideBase = (candidatePath: string) => {
      const relative = path.relative(this.baseDir, resolveStoredPath(candidatePath))
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    }
    const recordedBase = this.db.getAppMetadata('application_base_dir')
    const retainedPreviousBase = this.db.getAppMetadata('portable_previous_base')
    let previousBase = this.portablePreviousBase || retainedPreviousBase || recordedBase
    let baseMoved = Boolean(previousBase) && path.resolve(previousBase) !== path.resolve(this.baseDir)
    const portableCandidate = (storedPath: string, targetDir: string) => {
      if (!storedPath) return ''
      const resolved = resolveStoredPath(storedPath)
      if (isInsideBase(resolved)) return resolved
      if (!isInsideBase(targetDir)) return resolved
      const relativeTargetDir = path.relative(this.baseDir, targetDir)
      const expectedSuffix = path.join(relativeTargetDir, path.basename(resolved)).toLocaleLowerCase()
      const normalizedOld = path.normalize(resolved).toLocaleLowerCase()
      if (!normalizedOld.endsWith(`${path.sep}${expectedSuffix}`)) return resolved
      return path.join(targetDir, path.basename(resolved))
    }
    const previousCopyPath = (storedPath: string) => {
      if (!storedPath) return ''
      if (path.isAbsolute(storedPath)) {
        if (!isInsideBase(storedPath)) return path.resolve(storedPath)
        if (baseMoved) return path.resolve(previousBase, path.relative(this.baseDir, storedPath))
        return ''
      }
      return baseMoved ? path.resolve(previousBase, storedPath) : ''
    }
    const validateCopiedMedia = async (candidatePath: string, expectedBytes: number, expectedSeconds: number) => {
      try {
        const before = await fsp.stat(candidatePath, { bigint: true })
        if (!before.isFile() || before.size <= 0n || before.ino === 0n) return ''
        if (expectedBytes > 0 && before.size !== BigInt(expectedBytes)) return ''
        if (expectedSeconds <= 0) return ''
        const identity = `v1:${before.dev}:${before.ino}:${before.birthtimeNs}`
        const metadata = await parseFile(candidatePath)
        const duration = Number(metadata.format.duration || 0)
        const tracks = metadata.format.trackInfo || []
        const hasVideo = metadata.format.hasVideo === true || tracks.some(track => Boolean(track.video))
        const hasAudio = metadata.format.hasAudio === true || tracks.some(track => Boolean(track.audio))
        const margin = Math.max(2, Math.min(60, expectedSeconds * 0.02))
        if (!hasVideo || !hasAudio || !Number.isFinite(duration) || Math.abs(duration - expectedSeconds) > margin) return ''
        const after = await fsp.stat(candidatePath, { bigint: true })
        if (
          !after.isFile()
          || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs
          || after.ctimeNs !== before.ctimeNs
          || `v1:${after.dev}:${after.ino}:${after.birthtimeNs}` !== identity
        ) return ''
        return identity
      } catch {
        return ''
      }
    }
    const sampledFingerprint = async (candidatePath: string) => {
      let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
      try {
        const before = await fsp.stat(candidatePath, { bigint: true })
        if (!before.isFile() || before.ino === 0n) return { identity: '', fingerprint: '' }
        const identity = `v1:${before.dev}:${before.ino}:${before.birthtimeNs}`
        const size = Number(before.size)
        const sampleBytes = 64 * 1024
        const offsets = [...new Set([0, Math.max(0, Math.floor(size / 2) - sampleBytes / 2), Math.max(0, size - sampleBytes)])]
        handle = await fsp.open(candidatePath, 'r')
        const hash = createHash('sha256').update(String(before.size))
        for (const offset of offsets) {
          const buffer = Buffer.alloc(Math.min(sampleBytes, Math.max(0, size - offset)))
          if (buffer.length === 0) continue
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          hash.update(buffer.subarray(0, bytesRead))
        }
        await handle.close()
        handle = undefined
        const after = await fsp.stat(candidatePath, { bigint: true })
        if (
          !after.isFile()
          || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs
          || after.ctimeNs !== before.ctimeNs
          || `v1:${after.dev}:${after.ino}:${after.birthtimeNs}` !== identity
        ) return { identity: '', fingerprint: '' }
        return { identity, fingerprint: hash.digest('hex') }
      } catch {
        return { identity: '', fingerprint: '' }
      } finally {
        await handle?.close().catch(() => undefined)
      }
    }
    const identityFromMatchingPreviousCopy = async (
      storedPath: string,
      candidatePath: string,
      expectedOldIdentity: string,
    ) => {
      if (!expectedOldIdentity) return ''
      const oldPath = previousCopyPath(storedPath)
      if (!oldPath || path.resolve(oldPath) === path.resolve(candidatePath)) return ''
      const [oldSample, candidateSample] = await Promise.all([
        sampledFingerprint(oldPath),
        sampledFingerprint(candidatePath),
      ])
      return oldSample.identity === expectedOldIdentity
        && oldSample.fingerprint
        && oldSample.fingerprint === candidateSample.fingerprint
        ? candidateSample.identity
        : ''
    }
    const shouldRelocate = (
      storedPath: string,
      candidatePath: string,
      identity: string,
      relocationPending: boolean,
    ) => {
      if (!relocationPending) return false
      if (!storedPath || !candidatePath) return false
      if (resolveStoredPath(storedPath) !== path.resolve(candidatePath)) return true
      return baseMoved && Boolean(identity) && !fileMatchesIdentity(candidatePath, identity)
    }

    let changed = false
    const replayOutputDir = path.resolve(this.config.download.output_dir)
    const clipOutputDir = path.resolve(this.config.download.clip_output_dir)
    const moveTarget = this.db.getAppMetadata('portable_move_target')
    const replaySnapshot = this.db.getReplays(this.baseDir)
    const clipSnapshot = this.db.getClipTasks()
    const structuralPaths = [
      ...replaySnapshot.flatMap(replay => [
        [replay.file_path, replayOutputDir],
        [replay.recoverable_part_path, replayOutputDir],
        [replay.cleanup_part_path, replayOutputDir],
      ] as const),
      ...clipSnapshot.flatMap(task => [
        [task.file_path, clipOutputDir],
        [task.part_path, clipOutputDir],
      ] as const),
    ].filter(([storedPath, targetDir]) => Boolean(
      storedPath && portableCandidate(storedPath, targetDir) !== resolveStoredPath(storedPath),
    ))
    if (!previousBase && structuralPaths.length > 0) {
      const [legacyPath, targetDir] = structuralPaths[0]
      const relativeSuffix = path.relative(this.baseDir, portableCandidate(legacyPath, targetDir))
      const normalizedLegacy = path.normalize(resolveStoredPath(legacyPath))
      if (normalizedLegacy.toLocaleLowerCase().endsWith(`${path.sep}${relativeSuffix.toLocaleLowerCase()}`)) {
        previousBase = normalizedLegacy.slice(0, normalizedLegacy.length - relativeSuffix.length).replace(/[\\/]$/, '')
        baseMoved = Boolean(previousBase) && path.resolve(previousBase) !== path.resolve(this.baseDir)
      }
    }
    const startingNewMove = baseMoved
      && path.resolve(moveTarget || previousBase) !== path.resolve(this.baseDir)
    const initializeMoveDebt = structuralPaths.length > 0 || startingNewMove
    if (initializeMoveDebt) {
      for (const replay of replaySnapshot) {
        const hasPortableOwnedPath = [
          [replay.file_path, replayOutputDir, replay.output_identity],
          [replay.recoverable_part_path, replayOutputDir, replay.output_identity],
          [replay.cleanup_part_path, replayOutputDir, replay.cleanup_part_identity],
        ].some(([storedPath, targetDir, identity]) => Boolean(
          storedPath
          && ((startingNewMove && identity && isInsideBase(resolveStoredPath(storedPath)))
            || portableCandidate(storedPath, targetDir) !== resolveStoredPath(storedPath)),
        ))
        if (hasPortableOwnedPath && this.db.setReplayPortableRelocationPending(replay.live_key, true)) changed = true
      }
      for (const task of clipSnapshot) {
        const hasPortableOwnedPath = [task.file_path, task.part_path].some(storedPath => Boolean(
          storedPath
          && ((startingNewMove && (task.artifact_identity || task.part_identity) && isInsideBase(resolveStoredPath(storedPath)))
            || portableCandidate(storedPath, clipOutputDir) !== resolveStoredPath(storedPath)),
        ))
        if (hasPortableOwnedPath) {
          this.db.updateClipTask(task.id, { portable_relocation_pending: true })
          changed = true
        }
      }
      if (previousBase && this.db.setAppMetadata('portable_previous_base', path.resolve(previousBase))) changed = true
      if (this.db.setAppMetadata('portable_move_target', path.resolve(this.baseDir))) changed = true
      if (changed) await this.db.checkpoint()
    }

    for (const replay of this.db.getReplays(this.baseDir)) {
      signal?.throwIfAborted()
      const expectedSeconds = replay.actual_duration || replay.duration
      const finalCandidate = portableCandidate(replay.file_path, replayOutputDir)
      const partCandidate = portableCandidate(replay.recoverable_part_path, replayOutputDir)

      if (
        replay.status === 'completed'
        && replay.file_path
        && replay.output_identity
        && replay.cleanup_part_path
        && replay.cleanup_part_identity
        && (!replay.portable_relocation_pending || (
          isInsideBase(resolveStoredPath(replay.file_path))
          && isInsideBase(resolveStoredPath(replay.cleanup_part_path))
        ))
        && fileMatchesIdentity(resolveStoredPath(replay.file_path), replay.output_identity)
      ) {
        const cleanupPath = resolveStoredPath(replay.cleanup_part_path)
        try {
          await removeFileWithRetry(cleanupPath, { expectedIdentity: replay.cleanup_part_identity, retryDelaysMs: [] })
          if (!fileMatchesIdentity(resolveStoredPath(replay.file_path), replay.output_identity)) {
            throw Object.assign(new Error('Published replay identity changed during cleanup'), { code: 'EOWNERSHIP' })
          }
          this.db.patchReplay(replay.live_key, {
            cleanup_part_path: '',
            cleanup_part_identity: '',
            message: 'Success; deferred working-file cleanup completed after restart',
          })
          await this.db.checkpoint()
          changed = true
        } catch (error) {
          console.warn(`[portable] Durable replay cleanup remains pending for ${replay.live_key}:`, error)
        }
      }

      if (
        replay.status === 'completed'
        && replay.file_path
        && replay.recoverable_state !== 'published_cleanup'
        && shouldRelocate(replay.file_path, finalCandidate, replay.output_identity, Boolean(replay.portable_relocation_pending))
      ) {
        const identity = await validateCopiedMedia(finalCandidate, replay.file_size, expectedSeconds)
        signal?.throwIfAborted()
        if (identity) {
          this.db.patchReplay(replay.live_key, {
            file_path: finalCandidate,
            output_identity: identity,
            message: 'Portable output path relocated and verified after moving the application folder',
          })
          changed = true
        }
      }

      if (
        replay.recoverable_state === 'published_cleanup'
        && replay.file_path
        && replay.recoverable_part_path
        && (shouldRelocate(replay.file_path, finalCandidate, replay.output_identity, Boolean(replay.portable_relocation_pending))
          || shouldRelocate(replay.recoverable_part_path, partCandidate, replay.output_identity, Boolean(replay.portable_relocation_pending)))
      ) {
        const [finalIdentity, partIdentity] = await Promise.all([
          validateCopiedMedia(finalCandidate, replay.file_size, expectedSeconds),
          validateCopiedMedia(partCandidate, replay.file_size, expectedSeconds),
        ])
        signal?.throwIfAborted()
        const [finalSample, partSample] = finalIdentity && partIdentity
          ? await Promise.all([sampledFingerprint(finalCandidate), sampledFingerprint(partCandidate)])
          : [{ identity: '', fingerprint: '' }, { identity: '', fingerprint: '' }]
        if (
          finalIdentity
          && partIdentity
          && finalSample.identity === finalIdentity
          && partSample.identity === partIdentity
          && finalSample.fingerprint
          && finalSample.fingerprint === partSample.fingerprint
          && fileMatchesIdentity(finalCandidate, finalIdentity)
          && fileMatchesIdentity(partCandidate, partIdentity)
        ) {
          this.db.patchReplay(replay.live_key, {
            file_path: finalCandidate,
            recoverable_part_path: '',
            recoverable_state: '',
            cleanup_part_path: partCandidate,
            cleanup_part_identity: partIdentity,
            output_identity: finalIdentity,
            status: 'completed',
            progress: 100,
            message: 'Portable published output relocated; copied working link cleanup is pending',
          })
          await this.db.checkpoint()
          changed = true
          try {
            await removeFileWithRetry(partCandidate, { expectedIdentity: partIdentity, retryDelaysMs: [] })
            if (!fileMatchesIdentity(finalCandidate, finalIdentity)) {
              throw Object.assign(new Error('Portable final output identity changed during cleanup'), { code: 'EOWNERSHIP' })
            }
            this.db.patchReplay(replay.live_key, {
              cleanup_part_path: '',
              cleanup_part_identity: '',
              message: 'Portable published output relocated; copied working link was safely removed',
            })
            await this.db.checkpoint()
            continue
          } catch (error) {
            console.warn(`[portable] Working-copy cleanup remains blocked for ${replay.live_key}:`, error)
            continue
          }
        }
      }

      if (
        replay.recoverable_part_path
        && replay.recoverable_state
        && replay.recoverable_state !== 'published_cleanup'
        && shouldRelocate(replay.recoverable_part_path, partCandidate, replay.output_identity, Boolean(replay.portable_relocation_pending))
      ) {
        let nextState = replay.recoverable_state
        let identity = ''
        if (['complete_unverified', 'verified'].includes(replay.recoverable_state)) {
          identity = await validateCopiedMedia(partCandidate, 0, expectedSeconds)
        } else if (replay.recoverable_state === 'merge_in_progress') {
          identity = await validateCopiedMedia(partCandidate, 0, expectedSeconds)
          if (identity) nextState = 'complete_unverified'
          else identity = await identityFromMatchingPreviousCopy(
            replay.recoverable_part_path,
            partCandidate,
            replay.output_identity,
          )
        }
        signal?.throwIfAborted()
        if (identity) {
          this.db.patchReplay(replay.live_key, {
            recoverable_part_path: partCandidate,
            recoverable_state: nextState,
            output_identity: identity,
            message: 'Portable recoverable output path relocated and ownership re-verified',
          })
          changed = true
        }
      }

      if (
        replay.cleanup_part_path
        && shouldRelocate(
          replay.cleanup_part_path,
          portableCandidate(replay.cleanup_part_path, replayOutputDir),
          replay.cleanup_part_identity,
          Boolean(replay.portable_relocation_pending),
        )
      ) {
        const cleanupCandidate = portableCandidate(replay.cleanup_part_path, replayOutputDir)
        const identity = await identityFromMatchingPreviousCopy(
          replay.cleanup_part_path,
          cleanupCandidate,
          replay.cleanup_part_identity,
        )
        signal?.throwIfAborted()
        if (identity) {
          this.db.patchReplay(replay.live_key, {
            cleanup_part_path: cleanupCandidate,
            cleanup_part_identity: identity,
            message: 'Portable partial-cleanup path relocated using a matching copied-file fingerprint',
          })
          changed = true
        }
      }
    }

    for (const task of this.db.getClipTasks()) {
      signal?.throwIfAborted()
      const expectedSeconds = task.end_time - task.start_time
      const finalCandidate = portableCandidate(task.file_path, clipOutputDir)
      const partCandidate = portableCandidate(task.part_path, clipOutputDir)
      const finalNeedsRelocation = task.file_path
        && shouldRelocate(task.file_path, finalCandidate, task.artifact_identity, task.portable_relocation_pending)
      const partNeedsRelocation = task.part_path
        && shouldRelocate(task.part_path, partCandidate, task.part_identity || task.artifact_identity, task.portable_relocation_pending)

      if (task.status === 'done' && !task.artifact_state && finalNeedsRelocation) {
        const identity = await validateCopiedMedia(finalCandidate, 0, expectedSeconds)
        signal?.throwIfAborted()
        if (identity) {
          this.db.updateClipTask(task.id, {
            file_path: finalCandidate,
            artifact_identity: identity,
            part_identity: '',
            message: 'Portable clip path relocated and verified after moving the application folder',
          })
          changed = true
        }
        continue
      }

      if (
        ['verified', 'published_cleanup'].includes(task.artifact_state)
        && task.file_path
        && task.part_path
        && (finalNeedsRelocation || partNeedsRelocation)
      ) {
        const [finalIdentity, partIdentity] = await Promise.all([
          validateCopiedMedia(finalCandidate, 0, expectedSeconds),
          validateCopiedMedia(partCandidate, 0, expectedSeconds),
        ])
        signal?.throwIfAborted()
        const [finalSample, partSample] = finalIdentity && partIdentity
          ? await Promise.all([sampledFingerprint(finalCandidate), sampledFingerprint(partCandidate)])
          : [{ identity: '', fingerprint: '' }, { identity: '', fingerprint: '' }]
        if (
          finalIdentity
          && partIdentity
          && finalSample.identity === finalIdentity
          && partSample.identity === partIdentity
          && finalSample.fingerprint
          && finalSample.fingerprint === partSample.fingerprint
          && fileMatchesIdentity(finalCandidate, finalIdentity)
          && fileMatchesIdentity(partCandidate, partIdentity)
        ) {
          this.db.updateClipTask(task.id, {
            status: 'done',
            progress: 100,
            file_path: finalCandidate,
            part_path: partCandidate,
            artifact_state: 'published_cleanup',
            artifact_identity: finalIdentity,
            part_identity: partIdentity,
            message: 'Portable published clip relocated; copied working link cleanup is pending',
          })
          await this.db.checkpoint()
          changed = true
          try {
            await removeFileWithRetry(partCandidate, { expectedIdentity: partIdentity, retryDelaysMs: [] })
            if (!fileMatchesIdentity(finalCandidate, finalIdentity)) {
              throw Object.assign(new Error('Portable final clip identity changed during cleanup'), { code: 'EOWNERSHIP' })
            }
            this.db.updateClipTask(task.id, {
              part_path: '',
              artifact_state: '',
              part_identity: '',
              message: 'Portable published clip relocated; copied working link was safely removed',
            })
            await this.db.checkpoint()
            continue
          } catch (error) {
            console.warn(`[portable] Clip working-copy cleanup remains blocked for task ${task.id}:`, error)
            continue
          }
        }
      }

      if (partNeedsRelocation && ['built', 'verified', 'published_cleanup'].includes(task.artifact_state)) {
        const identity = await validateCopiedMedia(partCandidate, 0, expectedSeconds)
        signal?.throwIfAborted()
        if (identity) {
          this.db.updateClipTask(task.id, {
            file_path: task.file_path ? finalCandidate : '',
            part_path: partCandidate,
            artifact_identity: identity,
            part_identity: identity,
            message: 'Portable recoverable clip path relocated and ownership re-verified',
          })
          changed = true
        }
      } else if (partNeedsRelocation && task.artifact_state === 'building') {
        // file_path is only a reserved final name while building; part_path is
        // the sole existing artifact and can be rebound independently.
        const identity = await identityFromMatchingPreviousCopy(
          task.part_path,
          partCandidate,
          task.part_identity || task.artifact_identity,
        )
        signal?.throwIfAborted()
        if (identity) {
          this.db.updateClipTask(task.id, {
            file_path: task.file_path ? finalCandidate : '',
            part_path: partCandidate,
            artifact_identity: identity,
            part_identity: identity,
            message: 'Portable in-progress clip path relocated using the original copied-file identity',
          })
          changed = true
        }
      } else if ((finalNeedsRelocation || partNeedsRelocation) && task.artifact_state === 'cleanup_pending') {
        // Cancellation debt may contain two independently copied names.  The
        // v5 schema persists a distinct identity for each, so validate both
        // against their old owned objects and checkpoint the pair atomically.
        const [relocatedFinalIdentity, relocatedPartIdentity] = await Promise.all([
          finalNeedsRelocation
            ? identityFromMatchingPreviousCopy(task.file_path, finalCandidate, task.artifact_identity)
            : Promise.resolve(task.artifact_identity),
          partNeedsRelocation
            ? identityFromMatchingPreviousCopy(
              task.part_path,
              partCandidate,
              task.part_identity || task.artifact_identity,
            )
            : Promise.resolve(task.part_identity || task.artifact_identity),
        ])
        signal?.throwIfAborted()
        const finalReady = !task.file_path || (!finalNeedsRelocation || Boolean(relocatedFinalIdentity))
        const partReady = !task.part_path || (!partNeedsRelocation || Boolean(relocatedPartIdentity))
        if (finalReady && partReady) {
          this.db.updateClipTask(task.id, {
            file_path: task.file_path ? finalCandidate : '',
            part_path: task.part_path ? partCandidate : '',
            artifact_identity: task.file_path ? relocatedFinalIdentity : '',
            part_identity: task.part_path ? relocatedPartIdentity : '',
            message: 'Portable clip cleanup paths relocated using matching copied-file fingerprints',
          })
          await this.db.checkpoint()
          changed = true
        }
      }
    }
    for (const replay of this.db.getReplays(this.baseDir)) {
      if (!replay.portable_relocation_pending) continue
      const finalResolved = resolveStoredPath(replay.file_path)
      const recoverableResolved = resolveStoredPath(replay.recoverable_part_path)
      const cleanupResolved = resolveStoredPath(replay.cleanup_part_path)
      const finalResolvedOk = replay.status !== 'completed'
        || !replay.file_path
        || (isInsideBase(finalResolved) && fileMatchesIdentity(finalResolved, replay.output_identity))
      const recoverableResolvedOk = !replay.recoverable_part_path
        || (isInsideBase(recoverableResolved) && fileMatchesIdentity(recoverableResolved, replay.output_identity))
      const cleanupResolvedOk = !replay.cleanup_part_path
        || (isInsideBase(cleanupResolved) && fileMatchesIdentity(cleanupResolved, replay.cleanup_part_identity))
      if (finalResolvedOk && recoverableResolvedOk && cleanupResolvedOk) {
        if (this.db.setReplayPortableRelocationPending(replay.live_key, false)) changed = true
      }
    }
    for (const task of this.db.getClipTasks()) {
      if (!task.portable_relocation_pending) continue
      const finalResolved = resolveStoredPath(task.file_path)
      const partResolved = resolveStoredPath(task.part_path)
      const finalMustExist = task.status === 'done'
        || ['published_cleanup', 'cleanup_pending'].includes(task.artifact_state)
      const finalResolvedOk = !task.file_path
        || !finalMustExist
        || (isInsideBase(finalResolved) && fileMatchesIdentity(finalResolved, task.artifact_identity))
      const partResolvedOk = !task.part_path
        || (isInsideBase(partResolved) && fileMatchesIdentity(partResolved, task.part_identity || task.artifact_identity))
      if (finalResolvedOk && partResolvedOk) {
        this.db.updateClipTask(task.id, { portable_relocation_pending: false })
        changed = true
      }
    }
    if (this.db.setAppMetadata('application_base_dir', path.resolve(this.baseDir))) changed = true
    if (changed) await this.db.checkpoint()
  }

  private resolveClipArtifactPath(filePath: string) {
    if (!filePath) return ''
    return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(this.baseDir, filePath)
  }

  private isPathInsideBase(filePath: string) {
    if (!filePath) return true
    const relative = path.relative(this.baseDir, path.resolve(filePath))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  private isPathInsideRoot(filePath: string, rootPath: string) {
    if (!filePath) return true
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  private async inspectClipArtifact(filePath: string) {
    const resolvedPath = this.resolveClipArtifactPath(filePath)
    if (!resolvedPath) return { state: 'missing' as const, resolvedPath, identity: '', usable: false }
    try {
      const stat = await fsp.stat(resolvedPath, { bigint: true })
      return {
        state: 'present' as const,
        resolvedPath,
        identity: stat.isFile() && stat.ino !== 0n
          ? `v1:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
          : '',
        usable: stat.isFile() && stat.size > 0n,
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { state: 'missing' as const, resolvedPath, identity: '', usable: false }
      }
      console.error(`[clip] Failed to inspect tracked artifact ${resolvedPath}:`, error)
      return { state: 'unavailable' as const, resolvedPath, identity: '', usable: false }
    }
  }

  private async removeOwnedClipArtifact(filePath: string, identity: string) {
    const inspected = await this.inspectClipArtifact(filePath)
    if (inspected.state === 'unavailable') return 'blocked' as const
    if (inspected.state === 'missing') {
      try {
        const parent = await fsp.stat(path.dirname(inspected.resolvedPath))
        if (!parent.isDirectory()) return 'blocked' as const
      } catch {
        // A missing drive and a missing file are both surfaced as ENOENT on
        // Windows. Retain the durable path until its parent is reachable, or a
        // copied/offline artifact would become an untracked orphan.
        return 'blocked' as const
      }
    }
    if (!identity) return inspected.state === 'missing' ? 'removed' as const : 'foreign' as const
    try {
      // Startup reconciliation must remain bounded. A locked artifact stays as
      // durable cleanup debt and normal/background paths can retry later.
      await removeFileWithRetry(this.resolveClipArtifactPath(filePath), {
        expectedIdentity: identity,
        retryDelaysMs: [],
      })
      return 'removed' as const
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EOWNERSHIP') return 'foreign' as const
      console.error(`[clip] Failed to recover artifact cleanup ${inspected.resolvedPath}:`, error)
      return 'blocked' as const
    }
  }

  private async recoverStaleClipTempDirectories(signal?: AbortSignal) {
    const tempRoot = path.resolve(this.config.download.temp_dir)
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(tempRoot, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error(`[clip] Failed to inspect temporary directory ${tempRoot}:`, error)
      return
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.isDirectory()) continue
      const stalePath = path.join(tempRoot, entry.name)
      const directoryIdentity = tryReadDirectoryIdentity(stalePath)
      if (!directoryIdentity) continue
      const quarantineShape = parseDeleteEntryName(entry.name)
      const quarantine = parseOwnedDeleteEntryName(entry.name, directoryIdentity)
      const ownedName = (quarantine || quarantineShape)?.originalName || entry.name
      let sentinelOwned = false
      if (CLIP_TEMP_DIR_RE.test(ownedName)) {
        try {
          sentinelOwned = fs.readFileSync(path.join(stalePath, CLIP_TEMP_SENTINEL), 'utf8') === CLIP_TEMP_SENTINEL_CONTENT
        } catch {}
      } else if (REPLAY_TEMP_DIR_RE.test(ownedName)) {
        try {
          sentinelOwned = Boolean(parseReplayTempSentinel(
            fs.readFileSync(path.join(stalePath, REPLAY_TEMP_SENTINEL), 'utf8'),
          ))
        } catch {}
      }
      // A plain name needs its sentinel. A quarantine/tombstone may have lost
      // that sentinel during partial recursive rm, so its identity-bound hash
      // is the durable proof instead.
      if ((!sentinelOwned && !quarantine) || tryReadDirectoryIdentity(stalePath) !== directoryIdentity) continue
      if (!CLIP_TEMP_DIR_RE.test(ownedName) && !REPLAY_TEMP_DIR_RE.test(ownedName)) continue
      // Across a copied package/volume the directory identity changes, so an
      // old quarantine hash no longer matches. A still-valid sentinel lets us
      // safely treat that copied protocol-shaped name as the newly owned path;
      // without the sentinel, only a current identity-bound hash is accepted.
      const trackedOriginalPath = quarantine ? path.join(tempRoot, quarantine.trackedName) : stalePath
      try {
        await removePathWithRetry(trackedOriginalPath, {
          recursive: true,
          expectedDirectoryIdentity: directoryIdentity,
        })
      } catch (error) {
        console.error(`[temp] Failed to remove stale media directory ${stalePath}:`, error)
      }
    }
  }

  private async recoverInterruptedClipArtifacts(signal?: AbortSignal) {
    const activeTasks = this.db.getClipTasks().filter(task => (
      ['pending', 'processing', 'cancelling'].includes(task.status) || Boolean(task.artifact_state)
    ))
    for (const task of activeTasks) {
      signal?.throwIfAborted()
      if (task.portable_relocation_pending) {
        this.db.updateClipTask(task.id, {
          status: 'error',
          message: 'Portable artifact relocation is incomplete; all original paths were retained and no file was modified',
        })
        continue
      }
      // A task owns its persisted artifact paths by filesystem identity, not by
      // the application's *current* output-directory setting.  Users may
      // change that setting while a verified/published cleanup debt still
      // points at the previous directory; rejecting it here would freeze a
      // perfectly verifiable task forever.
      let finalArtifact = await this.inspectClipArtifact(task.file_path)
      let partArtifact = await this.inspectClipArtifact(task.part_path)
      const expectedPartIdentity = task.part_identity || task.artifact_identity

      if (finalArtifact.state === 'unavailable' || partArtifact.state === 'unavailable') {
        this.db.updateClipTask(task.id, {
          status: 'error',
          message: 'A tracked clip artifact is temporarily unavailable; ownership paths were retained for a later retry',
        })
        continue
      }

      if (task.status === 'cancelling' || task.artifact_state === 'cleanup_pending') {
        const finalResult = task.file_path
          ? await this.removeOwnedClipArtifact(task.file_path, task.artifact_identity)
          : 'removed'
        const partResult = task.part_path
          ? await this.removeOwnedClipArtifact(task.part_path, expectedPartIdentity)
          : 'removed'
        const allRemoved = finalResult === 'removed' && partResult === 'removed'
        const ownershipChanged = finalResult === 'foreign' || partResult === 'foreign'
        this.db.updateClipTask(task.id, allRemoved ? {
          status: 'error',
          message: 'Cancelled',
          file_path: '',
          part_path: '',
          artifact_state: '',
          artifact_identity: '',
          part_identity: '',
        } : {
          status: 'error',
          message: ownershipChanged
            ? 'Cancelled; a tracked path now belongs to another file and was preserved'
            : 'Cancelled; output cleanup is still blocked and will be retried on next start',
          file_path: finalResult === 'removed' ? '' : task.file_path,
          part_path: partResult === 'removed' ? '' : task.part_path,
          artifact_state: 'cleanup_pending',
          part_identity: partResult === 'removed' ? '' : expectedPartIdentity,
        })
        continue
      }

      if (task.artifact_state === 'published_cleanup') {
        if (finalArtifact.usable) {
          let artifactIdentity = task.artifact_identity
          const sameFile = partArtifact.state === 'present'
            && Boolean(finalArtifact.identity)
            && finalArtifact.identity === partArtifact.identity
          if (!artifactIdentity && sameFile) {
            artifactIdentity = finalArtifact.identity
            this.db.updateClipTask(task.id, { artifact_identity: artifactIdentity, part_identity: artifactIdentity })
            await this.db.checkpoint()
          }
          if (artifactIdentity && !fileMatchesIdentity(finalArtifact.resolvedPath, artifactIdentity)) {
            this.db.updateClipTask(task.id, {
              status: 'error',
              message: 'Published output identity changed; all paths were preserved for safety',
            })
            continue
          }
          const partResult = task.part_path
            ? await this.removeOwnedClipArtifact(task.part_path, expectedPartIdentity || artifactIdentity)
            : 'removed'
          if (partResult === 'foreign') {
            this.db.updateClipTask(task.id, {
              status: 'error',
              message: 'Published output and working file no longer match; both were preserved for safety',
            })
            continue
          }
          this.db.updateClipTask(task.id, {
            status: 'done',
            progress: 100,
            message: partResult === 'removed' ? 'Recovered published output after restart' : 'Output is complete; working-file cleanup will retry on next start',
            part_path: partResult === 'removed' ? '' : task.part_path,
            artifact_state: partResult === 'removed' ? '' : 'published_cleanup',
            artifact_identity: artifactIdentity,
            part_identity: partResult === 'removed' ? '' : (expectedPartIdentity || artifactIdentity),
          })
          continue
        }
        if (partArtifact.usable) {
          if (expectedPartIdentity && partArtifact.identity !== expectedPartIdentity) {
            this.db.updateClipTask(task.id, {
              status: 'error',
              message: 'Tracked working-file identity changed; the path was preserved for safety',
            })
            continue
          }
          this.db.updateClipTask(task.id, {
            status: 'error',
            progress: 99,
            artifact_state: 'verified',
            part_identity: expectedPartIdentity || partArtifact.identity,
            message: `完整切片已保留，最终发布尚未完成：${task.part_path}`,
          })
          continue
        }
        this.db.updateClipTask(task.id, {
          status: 'error',
          message: 'Published clip artifact is currently unavailable; ownership paths were retained',
        })
        continue
      }

      if (
        task.artifact_state === 'verified'
        && finalArtifact.usable
        && partArtifact.usable
        && Boolean(finalArtifact.identity)
        && finalArtifact.identity === partArtifact.identity
      ) {
        const artifactIdentity = task.artifact_identity || finalArtifact.identity
        if (task.artifact_identity && finalArtifact.identity !== task.artifact_identity) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            message: 'Atomically published output identity changed; both paths were preserved for safety',
          })
          continue
        }
        // The hard link may already exist after a crash.  Persist publication
        // ownership before unlinking the only path currently recorded as the
        // verified recovery source.
        this.db.updateClipTask(task.id, {
          file_path: task.file_path,
          part_path: task.part_path,
          artifact_state: 'published_cleanup',
          artifact_identity: artifactIdentity,
          part_identity: expectedPartIdentity || artifactIdentity,
        })
        await this.db.checkpoint()
        const partResult = await this.removeOwnedClipArtifact(task.part_path, expectedPartIdentity || artifactIdentity)
        this.db.updateClipTask(task.id, {
          status: 'done',
          progress: 100,
          message: partResult === 'removed' ? 'Recovered atomically published output after restart' : 'Output is complete; working-file cleanup will retry on next start',
          part_path: partResult === 'removed' ? '' : task.part_path,
          artifact_state: partResult === 'removed' ? '' : 'published_cleanup',
          artifact_identity: artifactIdentity,
          part_identity: partResult === 'removed' ? '' : (expectedPartIdentity || artifactIdentity),
        })
        continue
      }

      if (task.artifact_state === 'verified' && finalArtifact.usable && partArtifact.state === 'missing') {
        if (!task.artifact_identity || finalArtifact.identity !== task.artifact_identity) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            message: 'Published-looking output could not be matched to the verified artifact; its path was preserved',
          })
        } else {
          this.db.updateClipTask(task.id, {
            status: 'done',
            progress: 100,
            message: 'Recovered published output after its working link was already removed',
            part_path: '',
            artifact_state: '',
            part_identity: '',
          })
        }
        continue
      }

      if (task.artifact_state === 'verified' && finalArtifact.state === 'present') {
        this.db.updateClipTask(task.id, {
          status: 'error',
          message: 'Verified output paths no longer describe the same owned file; all paths were preserved',
        })
        continue
      }

      if (task.artifact_state === 'verified' && partArtifact.usable) {
        if (expectedPartIdentity && partArtifact.identity !== expectedPartIdentity) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            message: 'Tracked verified-file identity changed; the path was preserved for safety',
          })
          continue
        }
        if (!task.file_path || !expectedPartIdentity) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            progress: 99,
            message: `完整切片已保留，但缺少可验证的最终发布路径或身份：${task.part_path}`,
          })
          continue
        }
        try {
          await publishFileWithRetry(partArtifact.resolvedPath, finalArtifact.resolvedPath, {
            signal,
            requireAtomicNoClobber: true,
            deferSourceCleanup: true,
            expectedSourceIdentity: expectedPartIdentity,
            retryDelaysMs: [100, 250, 500, 1_000],
          })
          const publishedIdentity = tryReadFileIdentity(finalArtifact.resolvedPath)
          if (!publishedIdentity || publishedIdentity !== expectedPartIdentity) {
            throw Object.assign(new Error('Recovered clip publication identity changed'), { code: 'EOWNERSHIP' })
          }
          this.db.updateClipTask(task.id, {
            status: 'processing',
            file_path: task.file_path,
            part_path: task.part_path,
            artifact_state: 'published_cleanup',
            artifact_identity: publishedIdentity,
            part_identity: expectedPartIdentity,
            message: 'Recovered verified clip publication; working-file cleanup is pending',
          })
          await this.db.checkpoint()
          const partResult = await this.removeOwnedClipArtifact(task.part_path, expectedPartIdentity)
          this.db.updateClipTask(task.id, {
            status: 'done',
            progress: 100,
            message: partResult === 'removed'
              ? 'Recovered verified clip and safely completed publication after restart'
              : 'Recovered verified clip; working-file cleanup will retry on next start',
            part_path: partResult === 'removed' ? '' : task.part_path,
            artifact_state: partResult === 'removed' ? '' : 'published_cleanup',
            artifact_identity: publishedIdentity,
            part_identity: partResult === 'removed' ? '' : expectedPartIdentity,
          })
        } catch (error) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            progress: 99,
            message: `完整切片已保留，最终发布仍被占用或冲突，将在下次启动重试：${task.part_path}；${error instanceof Error ? error.message : String(error)}`,
          })
        }
        continue
      }

      if (task.artifact_state === 'verified') {
        this.db.updateClipTask(task.id, {
          status: 'error',
          message: 'Verified clip artifact is currently unavailable; ownership paths were retained',
        })
        continue
      }

      if (task.artifact_state === 'built') {
        if (partArtifact.usable && expectedPartIdentity && partArtifact.identity === expectedPartIdentity) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            progress: 99,
            message: `切片媒体已完整生成，但尚未通过校验；文件已保留，请重试校验或手动检查：${task.part_path}`,
          })
        } else {
          this.db.updateClipTask(task.id, {
            status: 'error',
            message: partArtifact.state === 'present'
              ? 'Completed-but-unverified clip identity changed; the path was preserved for safety'
              : 'Completed-but-unverified clip is currently unavailable; ownership path was retained',
          })
        }
        continue
      }

      if (task.artifact_state === 'building') {
        if (
          partArtifact.usable
          && expectedPartIdentity
          && partArtifact.identity === expectedPartIdentity
        ) {
          this.db.updateClipTask(task.id, {
            status: 'error',
            progress: 99,
            artifact_state: 'built',
            message: `应用在切片校验前退出；非空媒体已保留，避免误删可能完整的产物：${task.part_path}`,
          })
          continue
        }
        const partResult = await this.removeOwnedClipArtifact(task.part_path, expectedPartIdentity)
        this.db.updateClipTask(task.id, {
          status: 'error',
          message: partResult === 'removed'
            ? 'App closed during processing'
            : partResult === 'foreign'
              ? 'App closed during processing; tracked partial path now belongs to another file and was preserved'
              : 'App closed during processing; partial-file cleanup will retry on next start',
          file_path: '',
          part_path: partResult === 'removed' ? '' : task.part_path,
          artifact_state: partResult === 'removed' ? '' : 'cleanup_pending',
          artifact_identity: partResult === 'removed' ? '' : task.artifact_identity,
          part_identity: partResult === 'removed' ? '' : expectedPartIdentity,
        })
        continue
      }

      this.db.updateClipTask(task.id, {
        status: 'error',
        message: 'App closed during processing',
        file_path: '',
        part_path: '',
        artifact_state: '',
        artifact_identity: '',
        part_identity: '',
      })
    }
    if (activeTasks.length > 0) await this.db.checkpoint()
  }

  async stop() {
    if (!this.stopPromise) this.stopPromise = this.stopInternal()
    try {
      await this.stopPromise
    } catch (error) {
      // SqliteStore deliberately stays open when its final checkpoint fails.
      // Allow a later quit attempt to retry durable persistence.
      this.stopPromise = null
      throw error
    }
  }

  private async stopInternal() {
    this.stopping = true
    const startupReconciliation = this.startupReconciliationPromise
    const clipOutputReconciliation = this.clipOutputReconciliationPromise
    this.startupReconciliationController?.abort()
    this.clipOutputReconciliationController?.abort()
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

    await Promise.allSettled([
      ...replayPromises,
      ...clipPromises,
      ...mutationPromises,
      this.configMutationQueue,
      ...(startupReconciliation ? [startupReconciliation] : []),
      ...(clipOutputReconciliation ? [clipOutputReconciliation] : []),
    ])
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
    const task = this.db.getClipTaskById(taskId)
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
      if (replay.portable_relocation_pending) {
        if (['pending', 'downloading', 'merging', 'deleting'].includes(replay.status)) {
          this.pausedTasks.add(replay.live_key)
          this.updateReplayState(replay.live_key, {
            status: 'paused',
            message: 'Portable artifact relocation is incomplete; original paths were retained and the task was not resumed',
            speed: '',
            eta: '',
          }, ['pending', 'downloading', 'merging', 'deleting'])
        }
        continue
      }
      if (replay.status === 'deleting') {
        this.pausedTasks.add(replay.live_key)
        this.updateReplayState(replay.live_key, {
          status: 'paused',
          message: 'Local-file deletion was interrupted; retry deletion to finish cleanup',
          speed: '',
          eta: '',
        }, ['deleting'])
        continue
      }
      if (['pending', 'downloading', 'merging'].includes(replay.status)) {
        this.enqueueReplay(replay.live_key, { resetProgress: false, message: 'Recovered pending task' })
      }
    }
  }

  public emitProgress(update: Partial<ProgressUpdate> & Pick<ProgressUpdate, 'live_key' | 'status'>) {
    const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, update.live_key)
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
    if (this.stopping || this.databaseMaintenance || this.clipTaskRunners.has(taskId) || this.clipTaskPromises.has(taskId)) return false
    this.clipTaskRunners.set(taskId, runner)
    this.clipTaskQueue.push(taskId)
    this.scheduleClipTasks()
    return true
  }

  public async cancelClipTask(taskId: number) {
    const queuedIndex = this.clipTaskQueue.indexOf(taskId)
    if (queuedIndex >= 0) {
      this.clipTaskQueue.splice(queuedIndex, 1)
      this.clipTaskRunners.delete(taskId)
      this.db.updateClipTask(taskId, { status: 'error', message: 'Cancelled', file_path: '' })
      // A successful cancellation response is a durability boundary. Without
      // this checkpoint sql.js can still contain `pending` on disk for several
      // seconds and a crash may resurrect the queued task on restart.
      await this.db.checkpoint()
      this.emitClipTaskUpdate(taskId)
      return true
    }

    const controller = this.clipTasksAbort.get(taskId)
    if (controller) {
      // Keep tracked artifact paths until the runner confirms that cleanup
      // succeeded. Clearing them here creates an orphan if Windows still holds
      // the file when the abort settles.
      const task = this.db.getClipTaskById(taskId)
      if (task?.status !== 'cancelling') {
        this.db.updateClipTask(taskId, { status: 'cancelling', message: 'Cancelling; waiting for worker cleanup...' })
      }
      // Claim cancellation synchronously before yielding to checkpoint I/O, so
      // a worker already at its terminal boundary cannot overwrite the intent
      // with `done` while this request is waiting. The HTTP success response is
      // still withheld until that intent is durable on disk.
      if (this.clipTasksAbort.get(taskId) === controller) controller.abort()
      await this.db.checkpoint()
      this.emitClipTaskUpdate(taskId)
      return true
    }
    const task = this.db.getClipTaskById(taskId)
    return Boolean(task?.status === 'error' && task.message.startsWith('Cancelled'))
  }

  private scheduleClipTasks() {
    const limit = Math.max(1, this.config.download.max_concurrent_tasks)
    while (
      !this.stopping
      && !this.databaseMaintenance
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
    const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
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
    return this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
  }

  public enqueueReplay(liveKey: string, options?: { resetProgress?: boolean; message?: string }) {
    if (this.stopping || this.databaseMaintenance || this.deletingReplays.has(liveKey) || this.cachingReplays.has(liveKey)) return false
    const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
    if (!replay) return false
    if (replay.portable_relocation_pending) return false
    const active = this.activeTasks.get(liveKey)
    if (active && !active.controller.signal.aborted) return true
    const queueableStatuses = ['not_downloaded', 'failed', 'deleted', 'paused', ...ACTIVE_REPLAY_STATUSES]
    if (!queueableStatuses.includes(replay.status)) return false
    const recoverablePartPath = replay.recoverable_part_path || undefined
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
        file_path: recoverablePartPath ? replay.file_path : '',
        recoverable_part_path: replay.status === 'deleted' ? '' : (recoverablePartPath || ''),
        recoverable_state: recoverablePartPath ? replay.recoverable_state : '',
        output_identity: recoverablePartPath ? replay.output_identity : '',
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
      && !this.databaseMaintenance
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
        
        const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
        if (!replay) continue
        const controller = new AbortController()
        const generation = (this.replayTaskGenerations.get(liveKey) || 0) + 1
        this.replayTaskGenerations.set(liveKey, generation)
        const handle: TaskHandle = { controller, generation, promise: Promise.resolve() }
        const recoverablePartPath = replay.recoverable_part_path || undefined
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
          () => isSameExecution(),
          recoverablePartPath,
        )
          .catch(error => {
            if (controller.signal.aborted || !isSameExecution()) return
            const nextRecoverablePartPath = recoverablePartPathFromFailure(error)
            const persistedRecoverablePartPath = this.db
              .getReplaySummaryByLiveKey(this.baseDir, liveKey)
              ?.recoverable_part_path
            const message = error instanceof Error ? error.message : 'Unknown error'
            this.updateReplayState(
              liveKey,
              {
                status: 'failed',
                message,
                speed: '',
                eta: '',
                // Never erase an exact, pre-publication ownership checkpoint
                // merely because a later error (for example EEXIST) lacks a
                // sourcePath property.
                recoverable_part_path: nextRecoverablePartPath || persistedRecoverablePartPath || '',
              },
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
    const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
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
    if (this.stopping || this.databaseMaintenance || this.deletingReplays.has(liveKey) || this.cachingReplays.has(liveKey)) return false
    const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
    if (!replay || replay.status !== 'paused') return false
    const wasRuntimePaused = this.runtimePausedTasks.has(liveKey)
    this.runtimePausedTasks.delete(liveKey)
    this.pausedTasks.delete(liveKey)
    const resumed = this.enqueueReplay(liveKey, { resetProgress: false, message: 'Resumed' })
    if (!resumed) {
      // enqueueReplay can reject a paused row while portable relocation or
      // another backend gate is active. Keep the durable paused row and its
      // in-memory scheduling barrier in agreement when that happens.
      this.pausedTasks.add(liveKey)
      if (wasRuntimePaused) this.runtimePausedTasks.add(liveKey)
    }
    return resumed
  }

  public emitStateReconciled() {
    if (this.stopping) return
    const raw = JSON.stringify({ type: 'state_reconciled' })
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(raw)
    }
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
    if (this.stopping || this.databaseMaintenance) return 0
    this.runtimePaused = false
    let count = 0
    const pausedByRuntime = [...this.runtimePausedTasks]
    for (const liveKey of pausedByRuntime) {
      const replay = this.db.getReplaySummaryByLiveKey(this.baseDir, liveKey)
      if (replay?.status !== 'paused') {
        this.runtimePausedTasks.delete(liveKey)
        continue
      }
      if (this.resumeReplay(liveKey)) {
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
    if (this.stopping || this.databaseMaintenance) return 0
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
    if (this.stopping || this.databaseMaintenance) return 0
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
    if (this.stopping || this.databaseMaintenance) return 0
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

    await this.db.adoptLegacyOutputIdentitiesAsync(this.baseDir, signal)
    const unavailableOutputs = await this.db.healDeletedReplaysAsync(this.baseDir, signal)

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
        const existing = this.db.getReplaySummaryByLiveKey(this.baseDir, r.live_key)
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
    this.db.flushSoon()

    return {
      fetched: rows.length,
      new_records: newRecords,
      updated_records: updatedRecords,
      covers_updated: coversUpdated,
      marked_deleted: 0,
      unavailable_outputs: unavailableOutputs,
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
    const pending = (async () => {
      const stat = await fsp.statfs(target)
      const usedByService = await this.getKnownServiceStorageBytes()
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

  public async getKnownServiceStorageBytes(): Promise<number> {
    // Disk stats are polled while downloads are active. Walking output/temp
    // trees here used to serialize a stat for every segment and could stall the
    // backend for minutes on large or temporarily unavailable disks. Replay
    // outputs already have a durable size in SQLite, so expose that safe lower
    // bound without touching any media directory. Clip and temporary artifacts
    // do not yet have persisted sizes and are deliberately omitted rather than
    // reintroducing an unbounded filesystem scan.
    return this.db.getKnownReplayStorageBytes()
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
