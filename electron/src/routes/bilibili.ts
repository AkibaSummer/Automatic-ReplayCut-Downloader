import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { safeNumber } from '../utils'
import { USER_AGENT } from '../bilibili'

export function registerBilibiliRoutes(backend: DesktopBackend) {
  backend.app.get('/api/me', async (_req: Request, res: Response) => {
    try {
      const me = await backend.bilibiliClient.getCurrentUser()
      res.json(me)
    } catch {
      res.json({ logged_in: false, uname: '', face: '' })
    }
  })

  backend.app.get('/api/login/qr', async (_req: Request, res: Response) => {
    try {
      const data = await backend.bilibiliClient.fetchJSON<{
        code: number
        message: string
        data: { url: string; qrcode_key: string }
      }>('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
      if (data.code !== 0) {
        throw new Error(data.message || 'Generate QR failed')
      }
      res.json(data.data)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/api/login/poll', async (req: Request, res: Response) => {
    try {
      const key = String(req.query.qrcode_key || '')
      if (!key) {
        res.status(400).json({ error: 'missing qrcode_key' })
        return
      }
      const data = await backend.bilibiliClient.fetchJSON<{
        data: { code: number }
      }>(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`)
      await backend.bilibiliClient.saveCookies()
      res.json({ code: safeNumber(data?.data?.code) })
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/api/avatar', async (req: Request, res: Response) => {
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
      backend.sendError(res, error)
    }
  })
}
