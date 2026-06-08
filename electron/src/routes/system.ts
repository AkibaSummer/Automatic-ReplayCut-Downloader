import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { deepMerge, normalizeConfigWithBase, saveConfigFile } from '../config'
import { AppConfig } from '../types'
import { ensureDir } from '../utils'

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
    try {
      const previous = backend.config
      const incoming = req.body as Partial<AppConfig>
      const next = deepMerge(backend.config, incoming)
      next.server = previous.server
      next.database = previous.database
      const normalized = normalizeConfigWithBase(backend.baseDir, next)
      for (const key of Object.keys(backend.config)) delete (backend.config as any)[key]
      Object.assign(backend.config, normalized)
      ensureDir(backend.config.download.output_dir)
      ensureDir(backend.config.download.temp_dir)
      ensureDir(path.join(backend.config.download.output_dir, 'covers'))
      await saveConfigFile(backend.baseDir, backend.configPath, backend.config)
      res.setHeader('x-migrated-files', '0')
      res.setHeader('x-renamed-files', '0')
      res.json(backend.config)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/cleanup-stale', (_req: Request, res: Response) => {
    const result = backend.db
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

  backend.app.post('/api/cleanup-streams', (_req: Request, res: Response) => {
    const result = backend.db.prepare('DELETE FROM stream_slices WHERE replay_id NOT IN (SELECT replay_id FROM bilibili_replays)').run()
    res.json({ count: result.changes })
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
