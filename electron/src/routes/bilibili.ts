import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { safeNumber } from '../utils'
import { USER_AGENT } from '../bilibili'

const AVATAR_MAX_BYTES = 10 * 1024 * 1024
const AVATAR_MAX_REDIRECTS = 3

export class ImageProxyError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

function parseImageURL(raw: string, allowedDomains: readonly string[], base?: URL) {
  let target: URL
  try {
    target = base ? new URL(raw, base) : new URL(raw)
  } catch {
    throw new ImageProxyError(400, 'invalid image URL')
  }
  const hostname = target.hostname.toLowerCase()
  const allowedHost = allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
  if (!['http:', 'https:'].includes(target.protocol) || !allowedHost) {
    throw new ImageProxyError(400, 'image host not allowed')
  }
  return target
}

async function readLimitedBody(response: globalThis.Response) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > AVATAR_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new ImageProxyError(413, 'image is too large')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > AVATAR_MAX_BYTES) {
        await reader.cancel()
        throw new ImageProxyError(413, 'image is too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, received)
}

export async function fetchImageResource(
  raw: string,
  allowedDomains: readonly string[],
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
) {
  let target = parseImageURL(raw, allowedDomains)
  for (let redirects = 0; redirects <= AVATAR_MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(target, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        referer: 'https://www.bilibili.com/',
      },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new ImageProxyError(502, 'image redirect is missing a location')
      if (redirects === AVATAR_MAX_REDIRECTS) {
        throw new ImageProxyError(502, 'too many image redirects')
      }
      target = parseImageURL(location, allowedDomains, target)
      continue
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    if (response.ok && !contentType.toLowerCase().startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined)
      throw new ImageProxyError(502, 'response is not an image')
    }
    return {
      status: response.status,
      contentType,
      body: await readLimitedBody(response),
    }
  }
  throw new ImageProxyError(502, 'too many image redirects')
}

export function fetchAvatarResource(
  raw: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
) {
  return fetchImageResource(raw, ['hdslb.com'], fetchImpl, signal)
}

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
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const key = String(req.query.qrcode_key || '')
      if (!key) {
        res.status(400).json({ error: 'missing qrcode_key' })
        return
      }
      const data = await backend.bilibiliClient.fetchJSON<{
        code: number
        message: string
        data?: { code: number }
      }>(
        `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
        { signal: mutation.signal },
      )
      if (data.code !== 0 || !data.data || !Number.isFinite(Number(data.data.code))) {
        throw new Error(data.message || 'Poll QR login failed')
      }
      await backend.bilibiliClient.saveCookies()
      res.json({ code: safeNumber(data.data.code) })
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })

  backend.app.get('/api/avatar', async (req: Request, res: Response) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const raw = String(req.query.url || '')
      const avatar = await fetchAvatarResource(raw, globalThis.fetch, controller.signal)
      res.status(avatar.status)
      res.setHeader('content-type', avatar.contentType)
      res.send(avatar.body)
    } catch (error) {
      if (!res.headersSent) {
        if (error instanceof ImageProxyError) {
          res.status(error.status).json({ error: error.message })
        } else if (controller.signal.aborted) {
          res.status(499).end()
        } else {
          backend.sendError(res, error)
        }
      }
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
  })
}
