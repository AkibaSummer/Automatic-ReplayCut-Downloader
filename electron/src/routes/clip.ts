import fs from 'node:fs'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { resolveAppPathWithBase } from '../config'
import { ensureDir } from '../utils'

export function registerClipRoutes(backend: DesktopBackend) {
  // Cover image proxy — fetches external B站 cover images to avoid mixed-content blocks
  backend.app.get('/api/clip/cover-proxy', async (req: Request, res: Response) => {
    try {
      const url = req.query.url as string
      if (!url) throw new Error('Missing cover URL')
      // Validate URL domain to prevent SSRF
      try {
        const parsed = new URL(url)
        const allowed = ['hdslb.com', 'bilibili.com', 'bilivideo.com', 'biliimg.com', 'akamaized.net']
        if (!allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
          res.status(400).json({ error: 'Domain not allowed' })
          return
        }
      } catch { res.status(400).json({ error: 'Invalid URL' }); return }
      const response = await fetch(url, { headers: { 'Referer': 'https://www.bilibili.com/' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const contentType = response.headers.get('content-type') || 'image/jpeg'
      res.setHeader('content-type', contentType)
      res.setHeader('cache-control', 'public, max-age=86400')
      const buffer = Buffer.from(await response.arrayBuffer())
      res.send(buffer)
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  // Clip output directory config
  backend.app.get('/api/clip/output-dir', (req: Request, res: Response) => {
    const clipDir = resolveAppPathWithBase(backend.baseDir, backend.config.download.clip_output_dir || path.join(backend.config.download.output_dir, 'clips'))
    res.json({ path: clipDir })
  })

  backend.app.post('/api/clip/output-dir', (req: Request, res: Response) => {
    try {
      const newDir = req.body.path as string
      if (!newDir) throw new Error('Missing path')
      backend.config.download.clip_output_dir = newDir
      ensureDir(resolveAppPathWithBase(backend.baseDir, newDir))
      res.json({ ok: true, path: resolveAppPathWithBase(backend.baseDir, newDir) })
    } catch (error) {
      backend.sendError(res, error)
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
    try {
      const url = req.query.url as string
      const start = Number(req.query.start) || 0
      const duration = Number(req.query.duration) || 0
      if (!url) throw new Error('Missing audio URL')
      
      if (duration > 0) {
        res.setHeader('content-type', 'audio/mpeg')
        // Use child_process.spawn directly because fluent-ffmpeg doesn't properly quote -headers
        const cookie = backend.bilibiliClient.cookieHeader()
        const headers = `Referer: https://www.bilibili.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\nCookie: ${cookie}\\r\\n`
        const ffmpegPath = (require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked')
        const { spawn } = require('node:child_process')
        const args = [
          '-ss', `${start}`,
          '-headers', headers,
          '-i', url,
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
        proc.on('close', (code: number | null) => {
          if (code !== 0 && code !== null) console.error('[audio-proxy] ffmpeg exited with code', code)
          res.end()
        })
        req.on('close', () => {
          proc.kill()
        })
        return
      }

      // For non-duration requests, stream directly via authenticated fetch
      const response = await backend.bilibiliClient.fetchWithCookies(url)
      res.setHeader('content-type', response.headers.get('content-type') || 'audio/mp4')
      res.setHeader('content-length', response.headers.get('content-length') || '')
      res.setHeader('accept-ranges', 'bytes')
      if (response.body) {
        const { Readable } = require('node:stream')
        Readable.fromWeb(response.body).pipe(res)
      } else {
        const buffer = Buffer.from(await response.arrayBuffer())
        res.send(buffer)
      }
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.get('/api/clip/tasks', (req: Request, res: Response) => {
    res.json(backend.db.getClipTasks())
  })

  backend.app.post('/api/clip/execute', async (req: Request, res: Response) => {
    try {
      const { url, title, startTime, endTime, audioQualityIndex, videoQualityIndex, prefixCut, suffixTime, clipMode } = req.body
      const taskId = backend.db.createClipTask({
        url,
        title: title || 'Clip',
        start_time: Number(startTime) || 0,
        end_time: Number(endTime) || 0
      })

      res.json({ taskId, status: 'pending' })

      const controller = new AbortController()
      backend.clipTasksAbort.set(taskId, controller)

      // Execute in background
      backend.clipService.executeClip(
        url, title, Number(startTime) || 0, Number(endTime) || 0, Number(audioQualityIndex) || 0, Number(videoQualityIndex) || 0,
        (progress, message) => {
          backend.db.updateClipTask(taskId, { progress, status: 'processing', message: message || '' })
          backend.emitClipTaskUpdate(taskId)
        },
        prefixCut !== false,
        suffixTime !== false,
        clipMode || 'copy',
        controller.signal
      ).then(result => {
        backend.clipTasksAbort.delete(taskId)
        const r = result as { path: string; message?: string }
        backend.db.updateClipTask(taskId, { progress: 100, status: 'done', file_path: r.path, message: r.message || '' })
        backend.emitClipTaskUpdate(taskId)
      }).catch(error => {
        backend.clipTasksAbort.delete(taskId)
        backend.db.updateClipTask(taskId, { status: 'error', message: error.message })
        backend.emitClipTaskUpdate(taskId)
      })

    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/clip/cancel/:taskId', (req: Request, res: Response) => {
    const taskId = Number(req.params.taskId)
    const controller = backend.clipTasksAbort.get(taskId)
    if (controller) {
      controller.abort()
      res.json({ ok: true })
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
        await shell.openPath(filePath)
      } catch {
        const { exec } = await import('node:child_process')
        exec(`start "" "${filePath.replace(/"/g, '')}"`)  
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
          await shell.openPath(dir)
        }
      } catch {
        const dir = fs.existsSync(filePath) ? filePath : path.dirname(filePath)
        const { exec } = await import('node:child_process')
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          exec(`explorer /select,"${filePath.replace(/"/g, '')}"`)  
        } else {
          exec(`explorer "${dir.replace(/"/g, '')}"`)  
        }
      }
      res.json({ ok: true })
    } catch (error) {
      backend.sendError(res, error)
    }
  })
}
