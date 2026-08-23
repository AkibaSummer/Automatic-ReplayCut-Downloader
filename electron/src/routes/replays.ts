import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { REPLAY_OUTPUT_UNAVAILABLE_PREFIX } from '../db'
import {
  fileMatchesIdentity,
  parseDeleteEntryName,
  parseOwnedDeleteEntryName,
  parseReplayTempSentinel,
  removeFileWithRetry,
  removePathWithRetry,
  REPLAY_TEMP_DIR_RE,
  REPLAY_TEMP_SENTINEL,
  tryReadDirectoryIdentity,
} from '../utils'

function finalPathFromRecoverablePart(partPath: string) {
  const extension = path.extname(partPath)
  const stem = path.basename(partPath, extension)
  if (!extension || !stem.toLocaleLowerCase().endsWith('.part')) return ''
  return path.join(path.dirname(partPath), `${stem.slice(0, -'.part'.length)}${extension}`)
}

export function registerReplayRoutes(backend: DesktopBackend) {
  backend.app.get('/api/replays', (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      backend.scheduleClipOutputReconciliation()
      const replays = backend.db.getReplays(backend.baseDir)
      res.json(backend.databaseMaintenance
        ? replays.map(replay => replay.status === 'completed'
          ? { ...replay, output_state: 'unknown' as const }
          : replay)
        : replays)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  const scanReplays = async (_req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const summary = await backend.scanReplays(mutation.signal)
      res.json(summary)
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  }
  backend.app.post('/api/scan', scanReplays)
  backend.app.post('/api/replays/scan', scanReplays)

  backend.app.post('/api/pause-all', (_req: Request, res: Response) => {
    const count = backend.pauseAll()
    res.json({ ok: true, count })
  })

  backend.app.post('/api/resume-all', (_req: Request, res: Response) => {
    const count = backend.resumeAll()
    res.json({ ok: true, count })
  })

  backend.app.post('/api/sync-all', (_req: Request, res: Response) => {
    const count = backend.syncAllPending()
    res.json({ ok: true, count })
  })

  backend.app.post('/api/download-unfinished', (_req: Request, res: Response) => {
    const count = backend.downloadUnfinished()
    res.json({ ok: true, count })
  })

  backend.app.post('/api/retry-failed', (_req: Request, res: Response) => {
    const count = backend.retryFailed()
    res.json({ ok: true, count })
  })

  backend.app.post('/api/replays/:liveKey/download', (req: Request, res: Response) => {
    const replay = backend.db.getReplaySummaryByLiveKey(backend.baseDir, String(req.params.liveKey))
    if (!replay) {
      res.status(404).json({ error: 'Replay not found' })
      return
    }
    const wasPaused = backend.pausedTasks.has(replay.live_key)
    backend.pausedTasks.delete(replay.live_key)
    const ok = backend.enqueueReplay(replay.live_key, { resetProgress: replay.status !== 'paused', message: 'Queued' })
    if (!ok) {
      if (wasPaused || replay.status === 'paused') backend.pausedTasks.add(replay.live_key)
      res.status(409).json({ ok: false, error: 'Replay cannot be queued in its current state' })
      return
    }
    res.json({ ok: true })
  })

  backend.app.post('/api/replays/:liveKey/pause', (req: Request, res: Response) => {
    const ok = backend.pauseReplay(String(req.params.liveKey))
    if (!ok) {
      res.status(409).json({ ok: false, error: 'Replay cannot be paused in its current state' })
      return
    }
    res.json({ ok })
  })

  backend.app.post('/api/replays/:liveKey/resume', (req: Request, res: Response) => {
    const ok = backend.resumeReplay(String(req.params.liveKey))
    if (!ok) {
      res.status(409).json({ ok: false, error: 'Replay cannot be resumed in its current state' })
      return
    }
    res.json({ ok })
  })

  backend.app.post('/api/replays/:liveKey/cache-m3u8', async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    const liveKey = String(req.params.liveKey)
    if (backend.cachingReplays.has(liveKey)) {
      res.status(409).json({ error: 'Replay stream cache refresh is already in progress' })
      return
    }
    try {
      mutation = backend.beginMutation()
      const replay = backend.db.getReplaySummaryByLiveKey(backend.baseDir, liveKey)
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      if (
        backend.deletingReplays.has(liveKey)
        || backend.activeTasks.has(liveKey)
        || backend.queue.includes(liveKey)
        || ['pending', 'downloading', 'merging', 'deleting'].includes(replay.status)
      ) {
        res.status(409).json({ error: 'Replay is currently busy' })
        return
      }
      backend.cachingReplays.add(liveKey)
      await backend.bilibiliClient.cacheReplayM3U8(replay, mutation.signal)
      res.json(backend.db.getReplaySummaryByLiveKey(backend.baseDir, liveKey))
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      backend.cachingReplays.delete(liveKey)
      mutation?.finish()
    }
  })

  const deleteReplayFile = async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    const liveKey = String(req.params.liveKey)
    if (backend.cachingReplays.has(liveKey)) {
      res.status(409).json({ error: 'Replay stream cache refresh is in progress' })
      return
    }
    if (backend.deletingReplays.has(liveKey)) {
      res.status(409).json({ error: 'Replay deletion is already in progress' })
      return
    }

    let preservePausedState = false
    let deletionSucceeded = false
    let originalStatus = ''
    const finishedCandidatePaths = new Set<string>()
    const candidatePathKey = (candidatePath: string) => {
      const resolved = path.resolve(candidatePath)
      return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved
    }
    try {
      mutation = backend.beginMutation()
      const replay = backend.db.getReplaySummaryByLiveKey(backend.baseDir, liveKey)
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      originalStatus = replay.status
      backend.deletingReplays.add(liveKey)
      preservePausedState = backend.pausedTasks.has(liveKey) || replay.status === 'paused'
      backend.pausedTasks.add(liveKey)
      backend.removeFromQueue(replay.live_key)

      if (['pending', 'downloading', 'merging'].includes(replay.status)) {
        backend.updateReplayState(
          liveKey,
          {
            status: 'deleting',
            message: 'Stopping active download before deleting local files...',
            speed: '',
            eta: '',
          },
          ['pending', 'downloading', 'merging'],
        )
      }

      const active = backend.activeTasks.get(replay.live_key)
      if (active) {
        active.controller.abort()
        await active.promise.catch(() => {})
      }

      const current = backend.db.getReplaySummaryByLiveKey(backend.baseDir, liveKey)
      const target = current?.file_path ?? replay.file_path
      const recoverablePartPath = current?.recoverable_part_path ?? replay.recoverable_part_path
      const cleanupPartPath = current?.cleanup_part_path ?? replay.cleanup_part_path
      backend.updateReplayState(liveKey, {
        status: 'deleting',
        message: 'Deleting local files...',
        speed: '',
        eta: '',
      })
      await backend.db.checkpoint()
      const resolvedTarget = target ? path.resolve(target) : ''
      const candidates = new Map<string, { identity: string; label: string }>()
      const addCandidate = (candidatePath: string, identity: string, label: string) => {
        if (!candidatePath) return
        const resolved = path.resolve(candidatePath)
        const existing = candidates.get(resolved)
        if (existing && existing.identity !== identity) {
          throw new Error(`Conflicting ownership identities for replay path: ${resolved}`)
        }
        candidates.set(resolved, { identity, label })
      }
      if (resolvedTarget) addCandidate(resolvedTarget, current?.output_identity ?? replay.output_identity, 'published output')
      if (recoverablePartPath) {
        const resolvedRecoverablePath = path.isAbsolute(recoverablePartPath)
          ? recoverablePartPath
          : path.resolve(backend.baseDir, recoverablePartPath)
        const derivedFinalPath = finalPathFromRecoverablePart(resolvedRecoverablePath)
        const resolvedDerivedFinalPath = derivedFinalPath ? path.resolve(derivedFinalPath) : ''
        const outputIdentity = current?.output_identity ?? replay.output_identity
        addCandidate(resolvedRecoverablePath, outputIdentity, 'recoverable output')
        // A crash can happen after link() but before file_path is checkpointed.
        // The derived name is app-owned only if its persisted identity matches.
        if (resolvedDerivedFinalPath) addCandidate(resolvedDerivedFinalPath, outputIdentity, 'published recovery link')
      }
      if (cleanupPartPath) {
        const resolvedCleanupPartPath = path.isAbsolute(cleanupPartPath)
          ? cleanupPartPath
          : path.resolve(backend.baseDir, cleanupPartPath)
        addCandidate(
          resolvedCleanupPartPath,
          current?.cleanup_part_identity ?? replay.cleanup_part_identity,
          'partial working file',
        )
      }

      const ownedPaths: string[] = []
      const replacedPaths: string[] = []
      const unverifiablePaths: string[] = []
      const unavailablePaths: string[] = []
      for (const [candidatePath, ownership] of candidates) {
        try {
          fs.statSync(candidatePath)
        } catch (inspectError) {
          const code = (inspectError as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            // ENOENT alone does not prove a tracked file was deleted: Windows
            // reports the same result for an unmounted drive. Only forget the
            // path when its parent directory is demonstrably reachable. When an
            // identity exists, still pass the missing original to the retry
            // helper so it can discover and finish a deterministic quarantine.
            try {
              const parent = fs.statSync(path.dirname(candidatePath))
              if (!parent.isDirectory()) throw Object.assign(new Error('Tracked parent is not a directory'), { code: 'ENOTDIR' })
              if (ownership.identity) ownedPaths.push(candidatePath)
            } catch {
              unavailablePaths.push(`${ownership.label}: ${candidatePath}`)
            }
            continue
          }
          unavailablePaths.push(`${ownership.label}: ${candidatePath}`)
          continue
        }
        if (!ownership.identity) {
          unverifiablePaths.push(`${ownership.label}: ${candidatePath}`)
        } else if (!fileMatchesIdentity(candidatePath, ownership.identity)) {
          replacedPaths.push(`${ownership.label}: ${candidatePath}`)
          ownedPaths.push(candidatePath)
        } else {
          ownedPaths.push(candidatePath)
        }
      }
      if (unverifiablePaths.length > 0 || unavailablePaths.length > 0) {
        const details = [...unverifiablePaths, ...unavailablePaths].join('；')
        preservePausedState = true
        backend.updateReplayState(liveKey, {
          status: replay.status === 'completed' ? 'completed' : 'paused',
          message: replay.status === 'completed'
            ? `${REPLAY_OUTPUT_UNAVAILABLE_PREFIX} ${details}`
            : `无法安全确认待删除文件的所有权，路径已保留：${details}`,
        }, ['deleting'])
        await backend.db.checkpoint()
        res.status(409).json({ error: `Cannot safely verify replay file ownership: ${details}` })
        return
      }
      for (const ownedPath of ownedPaths) {
        const expectedIdentity = candidates.get(ownedPath)!.identity
        try {
          await removeFileWithRetry(ownedPath, { expectedIdentity })
          finishedCandidatePaths.add(candidatePathKey(ownedPath))
        } catch (cleanupError) {
          const ownershipError = cleanupError as NodeJS.ErrnoException & { quarantinePath?: string }
          if (
            ownershipError.code === 'EOWNERSHIP'
            && !ownershipError.quarantinePath
            && !fileMatchesIdentity(ownedPath, expectedIdentity)
          ) {
            // The app-owned inode is gone and a foreign replacement is being
            // deliberately preserved. Treat our ownership debt for this name
            // as finished without touching the replacement.
            finishedCandidatePaths.add(candidatePathKey(ownedPath))
            continue
          }
          throw cleanupError
        }
      }

      const tempDir = backend.config.download.temp_dir
      let tempEntries: string[] = []
      try {
        tempEntries = await fsp.readdir(tempDir)
      } catch (tempInspectError) {
        const code = (tempInspectError as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw tempInspectError
      }
      for (const entryName of tempEntries) {
        const streamPath = path.join(tempDir, entryName)
        const directoryIdentity = tryReadDirectoryIdentity(streamPath)
        if (!directoryIdentity) continue
        const quarantineShape = parseDeleteEntryName(entryName)
        const quarantine = parseOwnedDeleteEntryName(entryName, directoryIdentity)
        const ownedName = (quarantine || quarantineShape)?.originalName || entryName
        if (!REPLAY_TEMP_DIR_RE.test(ownedName)) continue
        let sentinel = ''
        try {
          sentinel = await fsp.readFile(path.join(streamPath, REPLAY_TEMP_SENTINEL), 'utf8')
        } catch (sentinelError) {
          const code = (sentinelError as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTDIR') throw sentinelError
        }
        const tempOwnership = parseReplayTempSentinel(sentinel)
        if (
          !tempOwnership
          || tempOwnership.liveKey !== replay.live_key
          || tryReadDirectoryIdentity(streamPath) !== directoryIdentity
        ) continue
        await removePathWithRetry(quarantine ? path.join(tempDir, quarantine.trackedName) : streamPath, {
          recursive: true,
          expectedDirectoryIdentity: directoryIdentity,
        })
      }

      const deleted = backend.updateReplayState(liveKey, {
        file_path: '',
        recoverable_part_path: '',
        recoverable_state: '',
        cleanup_part_path: '',
        output_identity: '',
        cleanup_part_identity: '',
        file_size: 0,
        resolution: '',
        bitrate: '',
        progress: 0,
        speed: '',
        elapsed: '',
        eta: '',
        status: 'deleted',
        message: replacedPaths.length > 0
          ? `Local app-owned files deleted; replaced paths were preserved: ${replacedPaths.join('；')}`
          : 'Local file deleted',
        verify_ok: false,
        actual_duration: 0,
      })
      backend.db.deleteReplayStreamCache(liveKey, true)
      await backend.db.checkpoint()
      deletionSucceeded = true
      res.json(deleted)
    } catch (error) {
      const current = backend.db.getReplaySummaryByLiveKey(backend.baseDir, liveKey)
      if (current?.status === 'deleting') {
        preservePausedState = true
        const resolveTrackedPath = (storedPath: string) => !storedPath
          ? ''
          : path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(backend.baseDir, storedPath)
        const retainUnlessFinished = (storedPath: string) => {
          const resolved = resolveTrackedPath(storedPath)
          return resolved && !finishedCandidatePaths.has(candidatePathKey(resolved)) ? storedPath : ''
        }
        const remainingFilePath = retainUnlessFinished(current.file_path)
        const remainingRecoverablePath = retainUnlessFinished(current.recoverable_part_path)
        const remainingCleanupPath = retainUnlessFinished(current.cleanup_part_path)
        const resolvedRemainingFilePath = resolveTrackedPath(remainingFilePath)
        // A durable pathname alone does not mean the published output is still
        // available. removeFileWithRetry may already have moved the owned file
        // into its identity-bound tombstone when both unlink and hard-link
        // restoration are blocked. Keep the original path+identity so a retry
        // can discover that tombstone, but never advertise completed/available
        // unless the original name still resolves to the owned object.
        const publishedOutputRetained = Boolean(
          resolvedRemainingFilePath
          && current.output_identity
          && fileMatchesIdentity(resolvedRemainingFilePath, current.output_identity),
        )
        const outputIdentityRetained = Boolean(remainingFilePath || remainingRecoverablePath)
        backend.updateReplayState(liveKey, {
          status: originalStatus === 'completed' && publishedOutputRetained ? 'completed' : 'paused',
          file_path: remainingFilePath,
          recoverable_part_path: remainingRecoverablePath,
          recoverable_state: remainingRecoverablePath ? current.recoverable_state : '',
          cleanup_part_path: remainingCleanupPath,
          output_identity: outputIdentityRetained ? current.output_identity : '',
          cleanup_part_identity: remainingCleanupPath ? current.cleanup_part_identity : '',
          ...(publishedOutputRetained ? {} : {
            file_size: 0,
            resolution: '',
            bitrate: '',
            verify_ok: false,
            actual_duration: 0,
          }),
          message: publishedOutputRetained
            ? `Local output is intact; deletion of another owned artifact failed and can be retried: ${error instanceof Error ? error.message : String(error)}`
            : `Local-file deletion partially completed; remaining owned paths were retained for retry: ${error instanceof Error ? error.message : String(error)}`,
          speed: '',
          eta: '',
        }, ['deleting'])
        await backend.db.checkpoint().catch(checkpointError => {
          console.error(`[replay] Failed to checkpoint deletion recovery for ${liveKey}:`, checkpointError)
        })
      }
      backend.sendError(res, error)
    } finally {
      backend.deletingReplays.delete(liveKey)
      if (deletionSucceeded || !preservePausedState) backend.pausedTasks.delete(liveKey)
      mutation?.finish()
    }
  }
  backend.app.post('/api/replays/:liveKey/delete-file', deleteReplayFile)
  backend.app.delete('/api/replays/:liveKey', deleteReplayFile)

  backend.app.get('/covers/*', (req: Request, res: Response) => {
    let requestedPath = ''
    try {
      requestedPath = decodeURIComponent(req.path.replace(/^\/covers\//, ''))
    } catch {
      res.status(400).json({ error: 'invalid path' })
      return
    }
    const coverDir = path.resolve(path.join(backend.config.download.output_dir, 'covers'))
    const fullPath = path.resolve(coverDir, requestedPath)
    const relative = path.relative(coverDir, fullPath)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      res.status(400).json({ error: 'invalid path' })
      return
    }
    if (!fs.existsSync(fullPath)) {
      res.status(404).end()
      return
    }
    res.sendFile(fullPath)
  })
}
