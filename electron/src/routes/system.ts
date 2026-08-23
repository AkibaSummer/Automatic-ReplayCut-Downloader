import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { AppConfig } from '../types'

export function registerSystemRoutes(backend: DesktopBackend) {
  backend.app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  backend.app.get('/api/runtime', (_req: Request, res: Response) => {
    res.json(backend.getRuntime())
  })

  backend.app.get('/api/config', (_req: Request, res: Response) => {
    res.json(backend.config)
  })

  backend.app.post('/api/config', async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const incoming = req.body as Partial<AppConfig>
      const canonical = await backend.updateConfig(draft => {
        // This endpoint backs SettingsPage, so only accept fields that page can
        // actually edit. Credentials and internal paths have dedicated routes;
        // accepting a stale full-store snapshot here could roll them back.
        if (incoming.bilibili?.anchor_id !== undefined) {
          draft.bilibili.anchor_id = Number(incoming.bilibili.anchor_id) || 0
        }
        if (incoming.download?.output_dir !== undefined) {
          draft.download.output_dir = String(incoming.download.output_dir)
        }
        if (incoming.download?.clip_output_dir !== undefined) {
          draft.download.clip_output_dir = String(incoming.download.clip_output_dir)
        }
        if (incoming.download?.filename_template !== undefined) {
          draft.download.filename_template = String(incoming.download.filename_template)
        }
        if (incoming.download?.max_concurrent_tasks !== undefined) {
          draft.download.max_concurrent_tasks = Number(incoming.download.max_concurrent_tasks)
        }
        if (incoming.download?.concurrent_segments !== undefined) {
          draft.download.concurrent_segments = Number(incoming.download.concurrent_segments)
        }
      })
      res.setHeader('x-migrated-files', '0')
      res.setHeader('x-renamed-files', '0')
      res.json(canonical)
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })

  backend.app.post('/api/cleanup-stale', async (_req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const count = await backend.cleanupStaleReplayTasks()
      res.json({ count })
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })

  backend.app.post('/api/cleanup-streams', async (_req: Request, res: Response) => {
    if (backend.databaseMaintenance) {
      res.status(409).json({ error: 'Database maintenance is already in progress' })
      return
    }

    const runtime = backend.getRuntime()
    const hasActiveWork = backend.hasInFlightMutations()
      || backend.activeTasks.size > 0
      || backend.queue.length > 0
      || backend.clipTaskPromises.size > 0
      || backend.clipTaskQueue.length > 0
      || backend.deletingReplays.size > 0
      || backend.cachingReplays.size > 0
      || runtime.downloading_tasks > 0
      || runtime.queued_tasks > 0
    if (hasActiveWork) {
      res.status(409).json({ error: 'Please pause or wait for all replay and clip tasks before compacting the database' })
      return
    }

    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      backend.databaseMaintenance = true
      res.json(await backend.db.cleanupStreamCacheAndCompact())
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      backend.databaseMaintenance = false
      mutation?.finish()
    }
  })

  backend.app.get('/api/stats/disk', async (_req: Request, res: Response) => {
    try {
      const stats = await backend.getDiskStats()
      res.json(stats)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/api/fs/list', async (req: Request, res: Response) => {
    try {
      res.json(await backend.listDirectories(String(req.query.path || '')))
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/api/export-tsv', (_req: Request, res: Response) => {
    const rows = backend.db.getReplays(backend.baseDir)
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
}
