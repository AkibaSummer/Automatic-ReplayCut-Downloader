import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'

export function registerReplayRoutes(backend: DesktopBackend) {
  backend.app.get('/api/replays', (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(backend.db.getReplays(backend.baseDir))
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/scan', async (_req: Request, res: Response) => {
    try {
      const summary = await backend.scanReplays()
      res.json(summary)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

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
    backend.enqueueReplay(replay.live_key, { resetProgress: replay.status !== 'paused', message: 'Queued' })
    res.json({ ok: true })
  })

  backend.app.post('/api/replays/:liveKey/pause', (req: Request, res: Response) => {
    const ok = backend.pauseReplay(String(req.params.liveKey))
    res.json({ ok })
  })

  backend.app.post('/api/replays/:liveKey/resume', (req: Request, res: Response) => {
    const ok = backend.resumeReplay(String(req.params.liveKey))
    res.json({ ok })
  })

  backend.app.post('/api/replays/:liveKey/cache-m3u8', async (req: Request, res: Response) => {
    try {
      const liveKey = String(req.params.liveKey)
      const replay = backend.db.getReplayByLiveKey(backend.baseDir, liveKey)
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      await backend.bilibiliClient.cacheReplayM3U8(replay)
      res.json(backend.db.getReplayByLiveKey(backend.baseDir, liveKey))
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/replays/:liveKey/delete-file', async (req: Request, res: Response) => {
    try {
      const replay = backend.db.getReplayByLiveKey(backend.baseDir, String(req.params.liveKey))
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' })
        return
      }
      const target = replay.file_path
      if (target && fs.existsSync(target)) {
        await fsp.unlink(target)
      }
      backend.removeFromQueue(replay.live_key)
      const active = backend.activeTasks.get(replay.live_key)
      if (active) {
        active.controller.abort()
      }
      try {
        const tempDir = backend.config.download.temp_dir
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir)
          const prefix = `${replay.live_key}_stream`
          for (const f of files) {
            if (f.startsWith(prefix)) {
              await fsp.rm(path.join(tempDir, f), { recursive: true, force: true }).catch(() => {})
            }
          }
        }
      } catch {}
      backend.db
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
      res.json(backend.db.getReplayByLiveKey(backend.baseDir, replay.live_key))
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/covers/*', (req: Request, res: Response) => {
    const relative = decodeURIComponent(req.path.replace(/^\/covers\//, ''))
    const fullPath = path.resolve(path.join(backend.config.download.output_dir, 'covers', relative))
    const coverDir = path.resolve(path.join(backend.config.download.output_dir, 'covers'))
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
}
