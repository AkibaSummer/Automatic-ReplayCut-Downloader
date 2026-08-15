import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'

export function registerFeishuRoutes(backend: DesktopBackend) {
  backend.app.get('/api/feishu/status', async (_req: Request, res: Response) => {
    try {
      const status = await backend.feishuClient.checkStatus()
      res.json(status)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/feishu/config', async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const { app_id, app_secret } = req.body
      if (!app_id || !app_secret) {
        res.status(400).json({ error: 'Missing app_id or app_secret' })
        return
      }
      await backend.updateConfig(draft => {
        draft.feishu.app_id = String(app_id).trim()
        draft.feishu.app_secret = String(app_secret).trim()
      })
      // Verify the new config works
      const status = await backend.feishuClient.checkStatus()
      // Other serialized settings may have committed while verification was
      // in flight. Return the current canonical snapshot, not the old one.
      res.json({ ...status, config: structuredClone(backend.config) })
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })

  backend.app.get('/api/feishu/records', async (req: Request, res: Response) => {
    try {
      const pageToken = (req.query.page_token as string) || undefined
      const limit = Math.min(Number(req.query.limit) || 20, 200)
            const keyword = ((req.query.keyword as string) || '').trim().toLowerCase()
      const result = await backend.feishuClient.listClippableRecords(pageToken, limit)

      // Client-side keyword filtering (server filter doesn't support rich-text 'contains')
      if (keyword) {
        result.records = result.records.filter(r =>
          r.song_name.toLowerCase().includes(keyword)
        )
        result.total = result.records.length
      }

      res.json(result)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.put('/api/feishu/records/:recordId', async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const recordId = String(req.params.recordId)
      const { fields } = req.body
      if (!recordId || !fields || typeof fields !== 'object') {
        res.status(400).json({ error: 'Missing recordId or fields' })
        return
      }
      await backend.feishuClient.updateRecord(recordId, fields)
      res.json({ ok: true })
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })
}
