import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Request, Response } from 'express'

import type { DesktopBackend } from '../backend'

const BILIBILI_MEDIA_HOSTS = ['hdslb.com', 'bilibili.com', 'bilivideo.com', 'biliimg.com', 'akamaized.net']
const MAX_SEGMENT_DURATION_SECONDS = 10 * 60
const MAX_TRANSCODE_OUTPUT_BYTES = 16 * 1024 * 1024
const PROXY_SESSION_TTL_MS = 15 * 60 * 1000

type AudioSourceSession = {
  upstreamUrl: string
  expiresAt: number
  signal: AbortSignal
}

class AudioProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
  }
}

function validateBilibiliMediaUrl(rawUrl: string) {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new AudioProxyError('Invalid audio URL', 400)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AudioProxyError('URL protocol not allowed', 400)
  }
  if (!BILIBILI_MEDIA_HOSTS.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
    throw new AudioProxyError('Domain not allowed', 400)
  }
  return parsed.toString()
}

async function fetchValidatedBilibiliMedia(
  backend: DesktopBackend,
  rawUrl: string,
  signal: AbortSignal,
  headers?: HeadersInit,
) {
  let currentUrl = validateBilibiliMediaUrl(rawUrl)
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await backend.bilibiliClient.fetchWithCookies(currentUrl, {
      redirect: 'manual',
      signal,
      headers,
    })
    if (response.status < 300 || response.status >= 400) {
      return response
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new AudioProxyError('Media redirect is missing a location', 502)
    if (redirects === 3) throw new AudioProxyError('Too many media redirects', 502)
    currentUrl = validateBilibiliMediaUrl(new URL(location, currentUrl).toString())
  }
  throw new AudioProxyError('Too many media redirects', 502)
}

function copyMediaHeaders(response: globalThis.Response, res: Response) {
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(name)
    if (value) res.setHeader(name, value)
  }
}

function abortError() {
  return Object.assign(new Error('Audio proxy request aborted'), { name: 'AbortError' })
}

function transcodeAudioSegment(
  inputUrl: string,
  start: number,
  duration: number,
  signal: AbortSignal,
) {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }

    const ffmpegPath = String(require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked')
    if (!ffmpegPath) {
      reject(new AudioProxyError('FFmpeg is not available', 500))
      return
    }

    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', `${start}`,
      '-i', inputUrl,
      '-t', `${duration}`,
      '-vn',
      '-f', 'mp3',
      '-c:a', 'libmp3lame',
      '-b:a', '32k',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1',
    ]
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let outputBytes = 0
    let stderr = ''
    let terminalError: Error | null = null
    let settled = false

    const cleanup = () => signal.removeEventListener('abort', stopChild)
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(output || Buffer.alloc(0))
    }
    const stopChild = () => {
      if (child.exitCode === null) child.kill()
    }

    signal.addEventListener('abort', stopChild, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminalError) return
      outputBytes += chunk.length
      if (outputBytes > MAX_TRANSCODE_OUTPUT_BYTES) {
        terminalError = new AudioProxyError('Audio segment is too large', 413)
        stopChild()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8192)
    })
    child.once('error', error => finish(new AudioProxyError(`Failed to start FFmpeg: ${error.message}`, 500)))
    child.once('close', code => {
      if (settled) return
      if (signal.aborted) {
        finish(abortError())
        return
      }
      if (terminalError) {
        finish(terminalError)
        return
      }
      if (code !== 0 || outputBytes === 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' ')
        finish(new AudioProxyError(
          `Unable to process the audio segment${detail ? `: ${detail}` : ''}`,
          502,
        ))
        return
      }
      finish(undefined, Buffer.concat(chunks, outputBytes))
    })
  })
}

function isLoopbackRequest(req: Request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
}

function parseSegmentRequest(req: Request) {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : ''
  if (!rawUrl) throw new AudioProxyError('Missing audio URL', 400)
  const start = req.query.start === undefined ? 0 : Number(req.query.start)
  const duration = req.query.duration === undefined ? 0 : Number(req.query.duration)
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 0) {
    throw new AudioProxyError('start and duration must be finite non-negative numbers', 400)
  }
  if (duration > MAX_SEGMENT_DURATION_SECONDS) {
    throw new AudioProxyError(`duration must not exceed ${MAX_SEGMENT_DURATION_SECONDS} seconds`, 400)
  }
  return { upstreamUrl: validateBilibiliMediaUrl(rawUrl), start, duration }
}

export function registerAudioProxyRoutes(backend: DesktopBackend) {
  const sourceSessions = new Map<string, AudioSourceSession>()

  // FFmpeg reads a loopback URL so that all CDN requests (including byte-range
  // seeks) still use BilibiliClient's authenticated Chromium/Node fetch stack.
  // Passing the signed CDN URL directly to FFmpeg caused a second request with
  // different networking and headers, which Bilibili frequently rejected.
  backend.app.get('/api/clip/audio-source/:token', async (req: Request, res: Response) => {
    const token = typeof req.params.token === 'string' ? req.params.token : ''
    const session = sourceSessions.get(token)
    if (!isLoopbackRequest(req) || !session || session.expiresAt < Date.now()) {
      if (session) sourceSessions.delete(token)
      res.status(404).end()
      return
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    session.signal.addEventListener('abort', abort, { once: true })
    try {
      const headers = new Headers()
      if (typeof req.headers.range === 'string') headers.set('range', req.headers.range)
      const upstream = await fetchValidatedBilibiliMedia(backend, session.upstreamUrl, controller.signal, headers)
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined)
        res.status(upstream.status).end()
        return
      }

      res.status(upstream.status)
      copyMediaHeaders(upstream, res)
      res.setHeader('cache-control', 'no-store')
      if (!upstream.body) {
        res.end()
        return
      }
      const readable = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
      await pipeline(readable, res)
    } catch (error) {
      if (!res.headersSent && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Upstream media request failed'
        res.status(error instanceof AudioProxyError ? error.status : 502).json({ error: message })
      }
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
      session.signal.removeEventListener('abort', abort)
    }
  })

  backend.app.get('/api/clip/audio-proxy', async (req: Request, res: Response) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const { upstreamUrl, start, duration } = parseSegmentRequest(req)

      if (duration > 0) {
        const address = backend.server.address() as AddressInfo | null
        if (!address) throw new AudioProxyError('Backend is not listening', 503)
        const token = randomBytes(24).toString('hex')
        sourceSessions.set(token, {
          upstreamUrl,
          expiresAt: Date.now() + PROXY_SESSION_TTL_MS,
          signal: controller.signal,
        })
        try {
          const inputUrl = `http://127.0.0.1:${address.port}/api/clip/audio-source/${token}`
          const output = await transcodeAudioSegment(inputUrl, start, duration, controller.signal)
          if (controller.signal.aborted) return
          res.setHeader('content-type', 'audio/mpeg')
          res.setHeader('content-length', output.length)
          res.setHeader('cache-control', 'no-store')
          res.send(output)
        } finally {
          sourceSessions.delete(token)
        }
        return
      }

      let upstream: globalThis.Response
      try {
        const headers = new Headers()
        if (typeof req.headers.range === 'string') headers.set('range', req.headers.range)
        upstream = await fetchValidatedBilibiliMedia(backend, upstreamUrl, controller.signal, headers)
      } catch (error) {
        if (error instanceof AudioProxyError) throw error
        throw new AudioProxyError(
          `Upstream media request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          502,
        )
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined)
        throw new AudioProxyError(`Upstream media request failed: HTTP ${upstream.status}`, upstream.status)
      }
      res.status(upstream.status)
      copyMediaHeaders(upstream, res)
      res.setHeader('cache-control', 'no-store')
      if (!upstream.body) {
        res.end()
        return
      }
      const readable = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
      await pipeline(readable, res)
    } catch (error) {
      if (!res.headersSent && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Audio proxy failed'
        res.status(error instanceof AudioProxyError ? error.status : 500).json({ error: message })
      }
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
  })
}
