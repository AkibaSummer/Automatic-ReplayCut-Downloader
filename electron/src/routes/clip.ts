import fs from 'node:fs'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { resolveAppPathWithBase } from '../config'
import { isUsableClipOutput } from '../db'
import { fetchImageResource, ImageProxyError } from './bilibili'
import { registerAudioProxyRoutes } from './audioProxy'

const BILIBILI_MEDIA_HOSTS = ['hdslb.com', 'bilibili.com', 'bilivideo.com', 'biliimg.com', 'akamaized.net']

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
  registerAudioProxyRoutes(backend)

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
          if (!isUsableClipOutput(resultInfo.path, backend.baseDir)) {
            throw new Error('Clip output file is missing or empty')
          }
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
      const task = backend.db.getClipTasks().find(candidate => candidate.id === taskId)
      res.json({ ok: true, status: task?.status || 'error', message: task?.message || 'Cancelled', task })
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
