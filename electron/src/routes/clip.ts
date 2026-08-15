import fs from 'node:fs'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { resolveAppPathWithBase } from '../config'
import { fetchImageResource, ImageProxyError } from './bilibili'

const BILIBILI_MEDIA_HOSTS = ['hdslb.com', 'bilibili.com', 'bilivideo.com', 'biliimg.com', 'akamaized.net']

function validateBilibiliMediaUrl(rawUrl: string) {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('URL protocol not allowed')
  }
  if (!BILIBILI_MEDIA_HOSTS.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
    throw new Error('Domain not allowed')
  }
  return parsed.toString()
}

async function fetchValidatedBilibiliMedia(
  backend: DesktopBackend,
  rawUrl: string,
  signal?: AbortSignal,
) {
  let currentUrl = validateBilibiliMediaUrl(rawUrl)
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await backend.bilibiliClient.fetchWithCookies(currentUrl, {
      redirect: 'manual',
      signal,
    })
    if (response.status < 300 || response.status >= 400) {
      return { url: currentUrl, response }
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new Error('Media redirect is missing a location')
    if (redirects === 3) throw new Error('Too many media redirects')
    currentUrl = validateBilibiliMediaUrl(new URL(location, currentUrl).toString())
  }
  throw new Error('Too many media redirects')
}

async function spawnSystemOpener(target: string, selectFile = false) {
  const { spawn } = await import('node:child_process')
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' && selectFile ? [`/select,${target}`] : [target]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export function registerClipRoutes(backend: DesktopBackend) {
  // Cover image proxy — fetches external B站 cover images to avoid mixed-content blocks
  backend.app.get('/api/clip/cover-proxy', async (req: Request, res: Response) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const url = req.query.url as string
      if (!url) {
        res.status(400).json({ error: 'Missing cover URL' })
        return
      }
      const image = await fetchImageResource(url, BILIBILI_MEDIA_HOSTS, globalThis.fetch, controller.signal)
      res.status(image.status)
      res.setHeader('content-type', image.contentType)
      res.setHeader('cache-control', 'public, max-age=86400')
      res.send(image.body)
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

  // Clip output directory config
  backend.app.get('/api/clip/output-dir', (req: Request, res: Response) => {
    const clipDir = resolveAppPathWithBase(backend.baseDir, backend.config.download.clip_output_dir || path.join(backend.config.download.output_dir, 'clips'))
    res.json({ path: clipDir })
  })

  backend.app.post('/api/clip/output-dir', async (req: Request, res: Response) => {
    let mutation: ReturnType<DesktopBackend['beginMutation']> | undefined
    try {
      mutation = backend.beginMutation()
      const newDir = req.body.path as string
      if (!newDir) throw new Error('Missing path')
      const resolvedDir = resolveAppPathWithBase(backend.baseDir, newDir)
      const canonical = await backend.updateConfig(draft => {
        draft.download.clip_output_dir = resolvedDir
      })
      res.json({ ok: true, path: canonical.download.clip_output_dir, config: canonical })
    } catch (error) {
      backend.sendError(res, error)
    } finally {
      mutation?.finish()
    }
  })

  backend.app.post('/api/clip/info', async (req: Request, res: Response) => {
    try {
      const info = await backend.bilibiliClient.getBilibiliVideoInfo(req.body.url || '')
      const audioProxyPath = `/api/clip/audio-proxy?url=${encodeURIComponent(info.audioUrl)}`
      // Proxy the cover image through our backend to avoid mixed-content blocks
      const coverProxy = info.cover ? `/api/clip/cover-proxy?url=${encodeURIComponent(info.cover)}` : ''
      res.json({ ...info, cover: coverProxy, audioProxyPath })
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/api/clip/audio-proxy', async (req: Request, res: Response) => {
    const controller = new AbortController()
    const stopRequest = () => controller.abort()
    req.once('aborted', stopRequest)
    res.once('close', () => {
      if (!res.writableEnded) stopRequest()
    })
    try {
      const url = req.query.url as string
      const start = req.query.start === undefined ? 0 : Number(req.query.start)
      const duration = req.query.duration === undefined ? 0 : Number(req.query.duration)
      if (!url) throw new Error('Missing audio URL')
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 0) {
        res.status(400).json({ error: 'start and duration must be finite non-negative numbers' })
        return
      }
      let media: Awaited<ReturnType<typeof fetchValidatedBilibiliMedia>>
      try {
        media = await fetchValidatedBilibiliMedia(backend, url, controller.signal)
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid URL' })
        return
      }
      if (!media.response.ok) {
        await media.response.body?.cancel().catch(() => undefined)
        res.status(media.response.status).json({ error: `Upstream media request failed: HTTP ${media.response.status}` })
        return
      }
      const validatedUrl = media.url
      
      if (duration > 0) {
        await media.response.body?.cancel().catch(() => undefined)
        res.setHeader('content-type', 'audio/mpeg')
        // Use child_process.spawn directly because fluent-ffmpeg doesn't properly quote -headers
        const cookie = backend.bilibiliClient.cookieHeader()
        const headers = `Referer: https://www.bilibili.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\nCookie: ${cookie}\\r\\n`
        const ffmpegPath = (require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked')
        const { spawn } = require('node:child_process')
        const args = [
          '-ss', `${start}`,
          '-headers', headers,
          '-i', validatedUrl,
          '-t', `${duration}`,
          '-f', 'mp3',
          '-c:a', 'libmp3lame',
          '-b:a', '32k',
          '-ar', '8000',
          '-ac', '1',
          'pipe:1'
        ]
        console.log('[audio-proxy] spawning ffmpeg')
        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        proc.stdout.pipe(res)
        proc.stderr.on('data', (d: Buffer) => {
          const msg = d.toString()
          if (msg.includes('Error') || msg.includes('error')) console.error('[audio-proxy] ffmpeg stderr:', msg)
        })
        proc.on('error', (err: Error) => {
          console.error('[audio-proxy] spawn error:', err)
          if (!res.headersSent) res.status(500).json({ error: err.message })
        })
        const stopProxyProcess = () => {
          if (proc.exitCode === null) proc.kill()
        }
        proc.on('close', (code: number | null) => {
          req.off('aborted', stopProxyProcess)
          if (code !== 0 && code !== null) console.error('[audio-proxy] ffmpeg exited with code', code)
          if (!res.writableEnded) res.end()
        })
        req.once('aborted', stopProxyProcess)
        res.once('close', () => {
          if (!res.writableEnded) stopProxyProcess()
        })
        return
      }

      // For non-duration requests, stream directly via authenticated fetch
      const response = media.response
      res.setHeader('content-type', response.headers.get('content-type') || 'audio/mp4')
      const contentLength = response.headers.get('content-length')
      if (contentLength) res.setHeader('content-length', contentLength)
      res.setHeader('accept-ranges', 'bytes')
      if (response.body) {
        const { Readable } = require('node:stream')
        Readable.fromWeb(response.body).pipe(res)
      } else {
        const buffer = Buffer.from(await response.arrayBuffer())
        res.send(buffer)
      }
    } catch (error) {
      if (!res.headersSent && !controller.signal.aborted) backend.sendError(res, error)
    } finally {
      req.off('aborted', stopRequest)
    }
  })

  backend.app.get('/api/clip/tasks', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    for (const taskId of backend.db.healMissingClipFiles(backend.baseDir)) {
      backend.emitClipTaskUpdate(taskId)
    }
    res.json(backend.db.getClipTasks())
  })

  backend.app.post('/api/clip/execute', async (req: Request, res: Response) => {
    try {
      const {
        url, title, startTime, endTime, audioQualityIndex, videoQualityIndex,
        audioQualityId, audioQualityCodec, videoQualityId, videoQualityCodec,
        prefixCut, suffixTime, clipMode,
      } = req.body
      const taskId = backend.db.createClipTask({
        url,
        title: title || 'Clip',
        start_time: Number(startTime) || 0,
        end_time: Number(endTime) || 0
      })

      backend.emitClipTaskUpdate(taskId)
      const queued = backend.enqueueClipTask(taskId, async controller => {
        try {
          const result = await backend.clipService.executeClip(
            url, title, Number(startTime) || 0, Number(endTime) || 0, Number(audioQualityIndex) || 0, Number(videoQualityIndex) || 0,
            (progress, message) => {
              if (controller.signal.aborted || backend.clipTasksAbort.get(taskId) !== controller) return
              backend.db.updateClipTask(taskId, { progress, status: 'processing', message: message || '' })
              backend.emitClipTaskUpdate(taskId)
            },
            prefixCut !== false,
            suffixTime !== false,
            clipMode || 'copy',
            controller.signal,
            {
              audioId: Number.isFinite(Number(audioQualityId)) ? Number(audioQualityId) : undefined,
              audioCodec: audioQualityCodec ? String(audioQualityCodec) : undefined,
              videoId: Number.isFinite(Number(videoQualityId)) ? Number(videoQualityId) : undefined,
              videoCodec: videoQualityCodec ? String(videoQualityCodec) : undefined,
            },
          )
          if (controller.signal.aborted || backend.clipTasksAbort.get(taskId) !== controller) return
          const resultInfo = result as { path: string; message?: string }
          backend.db.updateClipTask(taskId, {
            progress: 100,
            status: 'done',
            file_path: resultInfo.path,
            message: resultInfo.message || '',
          })
          backend.emitClipTaskUpdate(taskId)
        } catch (error) {
          if (controller.signal.aborted || backend.clipTasksAbort.get(taskId) !== controller) return
          backend.db.updateClipTask(taskId, { status: 'error', message: error instanceof Error ? error.message : String(error) })
          backend.emitClipTaskUpdate(taskId)
        }
      })
      if (!queued) {
        backend.db.updateClipTask(taskId, { status: 'error', message: 'Backend is shutting down' })
        backend.emitClipTaskUpdate(taskId)
        res.status(503).json({ error: 'Backend is shutting down', taskId })
        return
      }
      const currentTask = backend.db.getClipTasks().find(task => task.id === taskId)
      res.json({ taskId, status: currentTask?.status || 'pending' })

    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/clip/cancel/:taskId', (req: Request, res: Response) => {
    const taskId = Number(req.params.taskId)
    if (backend.cancelClipTask(taskId)) {
      res.json({ ok: true, status: 'error', message: 'Cancelled' })
    } else {
      res.status(404).json({ error: 'Task not found or already finished' })
    }
  })

  // Open a file with system default app
  backend.app.post('/api/clip/open-file', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ ok: false, message: 'File not found' })
        return
      }
      try {
        const { shell } = require('electron')
        const errorMessage = await shell.openPath(filePath)
        if (errorMessage) throw new Error(errorMessage)
      } catch {
        await spawnSystemOpener(filePath)
      }
      res.json({ ok: true })
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  // Open file's parent folder in explorer with the file selected
  backend.app.post('/api/clip/open-folder', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body
      if (!filePath) {
        res.status(400).json({ ok: false, message: 'filePath is required' })
        return
      }
      try {
        const { shell } = require('electron')
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          shell.showItemInFolder(filePath)
        } else {
          const dir = fs.existsSync(filePath) ? filePath : path.dirname(filePath)
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            res.status(404).json({ ok: false, message: 'Folder not found' })
            return
          }
          const errorMessage = await shell.openPath(dir)
          if (errorMessage) throw new Error(errorMessage)
        }
      } catch {
        const dir = fs.existsSync(filePath) ? filePath : path.dirname(filePath)
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          await spawnSystemOpener(filePath, true)
        } else {
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            res.status(404).json({ ok: false, message: 'Folder not found' })
            return
          }
          await spawnSystemOpener(dir)
        }
      }
      res.json({ ok: true })
    } catch (error) {
      backend.sendError(res, error)
    }
  })
}
