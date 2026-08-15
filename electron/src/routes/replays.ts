import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'

export function registerReplayRoutes(backend: DesktopBackend) {
  backend.app.get('/api/replays', (_req: Request, res: Response) => {
    try {
      backend.db.healDeletedReplays(backend.baseDir)
      res.setHeader('Cache-Control', 'no-store')
      res.json(backend.db.getReplays(backend.baseDir))
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
    const replay = backend.db.getReplayByLiveKey(backend.baseDir, String(req.params.liveKey))
    if (!replay) {
      res.status(404).json({ error: 'Replay not found' })
      return
    }
    backend.pausedTasks.delete(replay.live_key)
    const ok = backend.enqueueReplay(replay.live_key, { resetProgress: replay.status !== 'paused', message: 'Queued' })
    if (!ok) {
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
    try {
      mutation = backend.beginMutation()
      const liveKey = String(req.params.liveKey)
      const replay = backend.db.getReplayByLiveKey(backend.baseDir, liveKey)
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      if (
        backend.deletingReplays.has(liveKey)
        || backend.activeTasks.has(liveKey)
        || backend.queue.includes(liveKey)
        || ['pending', 'downloading', 'merging'].includes(replay.status)
      ) {
        res.status(409).json({ error: 'Replay is currently busy' })
        return
      }
      await backend.bilibiliClient.cacheReplayM3U8(replay, mutation.signal)
      res.json(backend.db.getReplayByLiveKey(backend.baseDir, liveKey))
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })

  const deleteReplayFile = async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    const liveKey = String(req.params.liveKey)
    if (backend.deletingReplays.has(liveKey)) {
      res.status(409).json({ error: 'Replay deletion is already in progress' })
      return
    }

    let preservePausedState = false
    let deletionSucceeded = false
    try {
      mutation = backend.beginMutation()
      const replay = backend.db.getReplayByLiveKey(backend.baseDir, liveKey)
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      backend.deletingReplays.add(liveKey)
      preservePausedState = backend.pausedTasks.has(liveKey) || replay.status === 'paused'
      backend.pausedTasks.add(liveKey)
      backend.removeFromQueue(replay.live_key)

      if (['pending', 'downloading', 'merging'].includes(replay.status)) {
        backend.updateReplayState(
          liveKey,
          { status: 'paused', message: 'Stopping before local file deletion', speed: '', eta: '' },
          ['pending', 'downloading', 'merging'],
        )
      }

      const active = backend.activeTasks.get(replay.live_key)
      if (active) {
        active.controller.abort()
        await active.promise.catch(() => {})
      }

      const current = backend.db.getReplayByLiveKey(backend.baseDir, liveKey)
      const target = current?.file_path || replay.file_path
      if (target && fs.existsSync(target)) {
        await fsp.unlink(target)
      }

      try {
        const tempDir = backend.config.download.temp_dir
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir)
          const prefix = `${replay.live_key}_stream`
          for (const f of files) {
            const suffix = f.startsWith(prefix) ? f.slice(prefix.length) : ''
            if (/^\d+$/.test(suffix)) {
              await fsp.rm(path.join(tempDir, f), { recursive: true, force: true }).catch(() => {})
            }
          }
        }
      } catch {}

      const deleted = backend.updateReplayState(liveKey, {
        file_path: '',
        file_size: 0,
        resolution: '',
        bitrate: '',
        progress: 0,
        speed: '',
        elapsed: '',
        eta: '',
        status: 'deleted',
        message: 'Local file deleted',
        verify_ok: false,
        actual_duration: 0,
      })
      deletionSucceeded = true
      res.json(deleted)
    } catch (error) {
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
