import fs from 'node:fs'
import path from 'node:path'
import type { DesktopBackend } from '../backend'
import type { Request, Response } from 'express'
import { resolveAppPathWithBase } from '../config'
import { isUsableClipOutput } from '../db'
import { fileMatchesIdentity, removeFileWithRetry, tryReadFileIdentity } from '../utils'
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
  const resolveTrackedPath = (value: string) => path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(backend.baseDir, value)
  const sameTrackedPath = (left: string, right: string) => process.platform === 'win32'
    ? resolveTrackedPath(left).toLocaleLowerCase() === resolveTrackedPath(right).toLocaleLowerCase()
    : resolveTrackedPath(left) === resolveTrackedPath(right)
  const trackedArtifactIdentities = (requestedPath: string) => {
    const identities = new Set<string>()
    let tracked = false
    for (const replay of backend.db.getReplays(backend.baseDir)) {
      const candidates = [
        [replay.file_path, replay.output_identity],
        [replay.recoverable_part_path, replay.output_identity],
        [replay.cleanup_part_path, replay.cleanup_part_identity],
      ] as const
      for (const [candidatePath, identity] of candidates) {
        if (!candidatePath || !sameTrackedPath(candidatePath, requestedPath)) continue
        tracked = true
        if (identity) identities.add(identity)
      }
    }
    for (const task of backend.db.getClipTasks()) {
      for (const [candidatePath, identity] of [
        [task.file_path, task.artifact_identity],
        [task.part_path, task.part_identity || task.artifact_identity],
      ] as const) {
        if (!candidatePath || !sameTrackedPath(candidatePath, requestedPath)) continue
        tracked = true
        if (identity) identities.add(identity)
      }
    }
    return { tracked, identities }
  }

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
    // Keep the hot poll metadata-only. At most once per minute start an async
    // reconciliation; updates arrive over the existing websocket without
    // making an offline/network drive block this request or the whole backend.
    backend.scheduleClipOutputReconciliation()
    const tasks = backend.db.getClipTasks(500)
    res.json(backend.databaseMaintenance
      ? tasks.map(task => task.status === 'done'
        ? { ...task, output_state: 'unknown' as const }
        : task)
      : tasks)
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
        const cancellationRequested = () => (
          controller.signal.aborted
          || backend.clipTasksAbort.get(taskId) !== controller
          || backend.db.getClipTaskById(taskId)?.status === 'cancelling'
        )
        const persistArtifact = async (patch: Parameters<typeof backend.db.updateClipTask>[1]) => {
          if (backend.clipTasksAbort.get(taskId) !== controller) return
          backend.db.updateClipTask(taskId, patch)
          await backend.db.checkpoint()
          backend.emitClipTaskUpdate(taskId)
        }
        const commitTerminalTask = async (patch: Parameters<typeof backend.db.updateClipTask>[1]) => {
          if (cancellationRequested()) return false
          // The state write and removal from the cancellable map are both
          // synchronous, so a cancel request can observe either "still
          // cancellable" or the terminal row, never an in-between promise.
          backend.db.updateClipTask(taskId, patch)
          if (backend.clipTasksAbort.get(taskId) === controller) backend.clipTasksAbort.delete(taskId)
          try {
            await backend.db.checkpoint()
          } catch (checkpointError) {
            // The published/verified artifact checkpoint already makes the
            // output recoverable. Keep the terminal in-memory state while the
            // store's dirty retry/close path persists it again.
            console.error(`[clip] Failed to checkpoint terminal task ${taskId}:`, checkpointError)
          }
          backend.emitClipTaskUpdate(taskId)
          return true
        }
        const cleanupCancelledArtifacts = async (extra?: { finalPath?: string; partPath?: string }) => {
          const snapshot = backend.db.getClipTaskById(taskId)
          const trackedFinal = extra?.finalPath
            || (['built', 'verified', 'published_cleanup', 'cleanup_pending'].includes(snapshot?.artifact_state || '')
              ? snapshot?.file_path || ''
              : '')
          const trackedPart = extra?.partPath || snapshot?.part_path || ''
          const artifactIdentity = snapshot?.artifact_identity || ''
          const partIdentity = snapshot?.part_identity || artifactIdentity
          backend.db.updateClipTask(taskId, {
            status: 'cancelling',
            message: 'Cancelling; cleaning output...',
            file_path: trackedFinal,
            part_path: trackedPart,
            artifact_state: 'cleanup_pending',
            artifact_identity: artifactIdentity,
            part_identity: partIdentity,
          })
          await backend.db.checkpoint()

          const cleanupResults = new Map<string, 'removed' | 'blocked' | 'foreign'>()
          for (const candidate of new Set([trackedFinal, trackedPart])) {
            if (!candidate) continue
            const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(backend.baseDir, candidate)
            if (!artifactIdentity) {
              cleanupResults.set(resolved, 'foreign')
              continue
            }
            try {
              const expectedIdentity = sameTrackedPath(candidate, trackedPart) ? partIdentity : artifactIdentity
              await removeFileWithRetry(resolved, { expectedIdentity })
              cleanupResults.set(resolved, 'removed')
            } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code === 'EOWNERSHIP') {
                cleanupResults.set(resolved, 'foreign')
                continue
              }
              console.error(`[clip] Failed to remove cancelled artifact ${resolved}:`, cleanupError)
              cleanupResults.set(resolved, 'blocked')
            }
          }

          const cleanupResultFor = (candidate: string) => {
            if (!candidate) return 'removed' as const
            const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(backend.baseDir, candidate)
            return cleanupResults.get(resolved) || 'blocked'
          }
          const finalResult = cleanupResultFor(trackedFinal)
          const partResult = cleanupResultFor(trackedPart)
          const finalRemaining = finalResult === 'removed' ? '' : trackedFinal
          const partRemaining = partResult === 'removed' ? '' : trackedPart
          const ownershipConflicts = [
            finalResult === 'foreign' ? finalRemaining : '',
            partResult === 'foreign' ? partRemaining : '',
          ].filter(Boolean)
          const terminalPatch: Parameters<typeof backend.db.updateClipTask>[1] = !finalRemaining && !partRemaining ? {
            status: 'error',
            message: 'Cancelled',
            file_path: '',
            part_path: '',
            artifact_state: '',
            artifact_identity: '',
            part_identity: '',
          } : {
            status: 'error',
            message: ownershipConflicts.length > 0
              ? `Cancelled; a tracked path now belongs to another file and was preserved: ${ownershipConflicts.join('；')}`
              : `Cancelled; output cleanup is blocked and will retry on next start: ${[finalRemaining, partRemaining].filter(Boolean).join('；')}`,
            file_path: finalRemaining,
            part_path: partRemaining,
            artifact_state: 'cleanup_pending',
            artifact_identity: artifactIdentity,
            part_identity: partRemaining ? partIdentity : '',
          }
          // Cleanup is now settled (successfully or as durable debt). Commit
          // the terminal row and remove the cancellation handle in the same
          // synchronous turn so a repeated request cannot regress `error`
          // back to `cancelling` while the final checkpoint is in flight.
          backend.db.updateClipTask(taskId, terminalPatch)
          if (backend.clipTasksAbort.get(taskId) === controller) backend.clipTasksAbort.delete(taskId)
          try {
            await backend.db.checkpoint()
          } catch (checkpointError) {
            console.error(`[clip] Failed to checkpoint cancelled task ${taskId}:`, checkpointError)
          }
          backend.emitClipTaskUpdate(taskId)
        }
        try {
          const result = await backend.clipService.executeClip(
            url, title, Number(startTime) || 0, Number(endTime) || 0, Number(audioQualityIndex) || 0, Number(videoQualityIndex) || 0,
            (progress, message) => {
              if (cancellationRequested()) return
              const processingProgress = Math.max(0, Math.min(99, Number(progress) || 0))
              backend.db.updateClipTask(taskId, { progress: processingProgress, status: 'processing', message: message || '' })
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
            {
              onReserved: async ({ outPath, partPath, identity }) => persistArtifact({
                file_path: outPath,
                part_path: partPath,
                artifact_state: 'building',
                artifact_identity: identity || tryReadFileIdentity(partPath),
                part_identity: identity || tryReadFileIdentity(partPath),
              }),
              onBuilt: async ({ outPath, partPath, identity }) => persistArtifact({
                file_path: outPath,
                part_path: partPath,
                artifact_state: 'built',
                artifact_identity: identity || tryReadFileIdentity(partPath),
                part_identity: identity || tryReadFileIdentity(partPath),
              }),
              onVerified: async ({ outPath, partPath, identity }) => persistArtifact({
                file_path: outPath,
                part_path: partPath,
                artifact_state: 'verified',
                artifact_identity: identity || tryReadFileIdentity(partPath),
                part_identity: identity || tryReadFileIdentity(partPath),
              }),
              onPublished: async ({ outPath, partPath, identity }) => persistArtifact({
                file_path: outPath,
                part_path: partPath,
                artifact_state: 'published_cleanup',
                artifact_identity: identity || tryReadFileIdentity(outPath),
                part_identity: identity || tryReadFileIdentity(partPath),
              }),
            },
          )
          const resultInfo = result as { path: string; workingPath?: string; message?: string; identity?: string }
          if (cancellationRequested()) {
            if (backend.isStopping()) return
            await cleanupCancelledArtifacts({ finalPath: resultInfo.path, partPath: resultInfo.workingPath })
            return
          }
          if (!isUsableClipOutput(resultInfo.path, backend.baseDir)) {
            throw new Error('Clip output file is missing or empty')
          }
          // The current ClipService always returns the identity captured at
          // publication, but derive it here as a compatibility boundary for a
          // previously queued/injected service result that predates that
          // protocol field.  It is captured and checked before any durable
          // completion state is written.
          const resultIdentity = resultInfo.identity || tryReadFileIdentity(resultInfo.path)
          if (!resultIdentity || !fileMatchesIdentity(resultInfo.path, resultIdentity)) {
            throw Object.assign(
              new Error('Clip output ownership changed before completion; the path was preserved for safety'),
              { code: 'EOWNERSHIP', publishedPath: resultInfo.path },
            )
          }
          let retainedWorkingPath = resultInfo.workingPath || ''
          if (retainedWorkingPath) {
            const resolvedWorkingPath = path.isAbsolute(retainedWorkingPath)
              ? retainedWorkingPath
              : path.resolve(backend.baseDir, retainedWorkingPath)
            try {
              await removeFileWithRetry(resolvedWorkingPath, {
                expectedIdentity: resultIdentity,
              })
              retainedWorkingPath = ''
            } catch (cleanupError) {
              console.error(`[clip] Published output retained a locked working file ${resolvedWorkingPath}:`, cleanupError)
            }
          }
          if (cancellationRequested()) {
            if (backend.isStopping()) return
            await cleanupCancelledArtifacts({ finalPath: resultInfo.path, partPath: retainedWorkingPath })
            return
          }
          const completed = await commitTerminalTask({
            progress: 100,
            status: 'done',
            file_path: resultInfo.path,
            part_path: retainedWorkingPath,
            artifact_state: retainedWorkingPath ? 'published_cleanup' : '',
            artifact_identity: resultIdentity,
            part_identity: retainedWorkingPath ? resultIdentity : '',
            message: retainedWorkingPath
              ? `${resultInfo.message ? `${resultInfo.message}；` : ''}切片已安全保存；临时文件仍被占用，将在下次启动继续清理：${retainedWorkingPath}`
              : (resultInfo.message || ''),
          })
          if (!completed && !backend.isStopping()) {
            await cleanupCancelledArtifacts({ finalPath: resultInfo.path, partPath: retainedWorkingPath })
          }
        } catch (error) {
          const fileError = error as { recoverablePath?: unknown; publishedPath?: unknown; cleanupPath?: unknown }
          const snapshot = backend.db.getClipTaskById(taskId)
          const durableRetained = snapshot?.artifact_state === 'built'
            || snapshot?.artifact_state === 'verified'
            || snapshot?.artifact_state === 'published_cleanup'
          const recoverablePath = typeof fileError.recoverablePath === 'string' && fileError.recoverablePath
            ? fileError.recoverablePath
            : (durableRetained ? snapshot?.part_path || '' : '')
          const publishedPath = typeof fileError.publishedPath === 'string' && fileError.publishedPath
            ? fileError.publishedPath
            : (snapshot?.artifact_state === 'published_cleanup' ? snapshot.file_path : '')
          const cleanupPath = typeof fileError.cleanupPath === 'string' && fileError.cleanupPath
            ? fileError.cleanupPath
            : (snapshot?.artifact_state === 'cleanup_pending' ? snapshot.part_path : '')
          if (cancellationRequested()) {
            if (backend.isStopping()) return
            await cleanupCancelledArtifacts({ finalPath: publishedPath, partPath: recoverablePath || cleanupPath })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const terminalPatch: Parameters<typeof backend.db.updateClipTask>[1] = recoverablePath || publishedPath ? {
            status: 'error',
            progress: 99,
            message: `${message}；完整切片已保留：${recoverablePath || publishedPath}`,
            // Keep the reserved final path for built/verified debt. link() may
            // already have succeeded before a transient post-link identity
            // stat failed; restart recovery can then prove final+part are the
            // same object and complete the checkpoint without orphaning it.
            file_path: publishedPath || snapshot?.file_path || '',
            part_path: recoverablePath,
            artifact_state: publishedPath
              ? 'published_cleanup'
              : snapshot?.artifact_state === 'built' ? 'built' : 'verified',
            artifact_identity: snapshot?.artifact_identity || '',
            part_identity: snapshot?.part_identity || snapshot?.artifact_identity || '',
          } : cleanupPath ? {
            status: 'error',
            message: `${message}；临时文件清理将在下次启动重试：${cleanupPath}`,
            file_path: '',
            part_path: cleanupPath,
            artifact_state: 'cleanup_pending',
            artifact_identity: snapshot?.artifact_identity || '',
            part_identity: snapshot?.part_identity || snapshot?.artifact_identity || '',
          } : {
            status: 'error',
            message,
            file_path: '',
            part_path: '',
            artifact_state: '',
            artifact_identity: '',
            part_identity: '',
          }
          const committed = await commitTerminalTask(terminalPatch)
          if (!committed && !backend.isStopping()) {
            await cleanupCancelledArtifacts({ finalPath: publishedPath, partPath: recoverablePath || cleanupPath })
          }
        }
      })
      if (!queued) {
        backend.db.updateClipTask(taskId, { status: 'error', message: 'Backend is shutting down' })
        backend.emitClipTaskUpdate(taskId)
        res.status(503).json({ error: 'Backend is shutting down', taskId })
        return
      }
      const currentTask = backend.db.getClipTaskById(taskId)
      res.json({ taskId, status: currentTask?.status || 'pending' })

    } catch (error) {
      backend.sendError(res, error)
    }
  })

  backend.app.post('/api/clip/cancel/:taskId', async (req: Request, res: Response) => {
    try {
      const taskId = Number(req.params.taskId)
      if (await backend.cancelClipTask(taskId)) {
        const task = backend.db.getClipTaskById(taskId)
        res.json({ ok: true, status: task?.status || 'error', message: task?.message || 'Cancelled', task })
      } else {
        res.status(404).json({ error: 'Task not found or already finished' })
      }
    } catch (error) {
      backend.sendError(res, error)
    }
  })

  // Open a file with system default app
  backend.app.post('/api/clip/open-file', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body
      if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        res.status(400).json({ ok: false, message: 'A tracked absolute filePath is required' })
        return
      }
      const resolvedFilePath = path.resolve(filePath)
      const ownership = trackedArtifactIdentities(resolvedFilePath)
      if (!ownership.tracked) {
        res.status(403).json({ ok: false, message: 'The requested path is not tracked by this application' })
        return
      }
      if (!fs.existsSync(resolvedFilePath)) {
        res.status(404).json({ ok: false, message: 'File not found' })
        return
      }
      if (ownership.identities.size === 0) {
        res.status(409).json({ ok: false, message: 'File ownership has not been verified yet' })
        return
      }
      if (![...ownership.identities].some(identity => fileMatchesIdentity(resolvedFilePath, identity))) {
        res.status(409).json({ ok: false, message: 'File ownership changed; refusing to open a replacement file' })
        return
      }
      try {
        const { shell } = require('electron')
        const errorMessage = await shell.openPath(resolvedFilePath)
        if (errorMessage) throw new Error(errorMessage)
      } catch {
        await spawnSystemOpener(resolvedFilePath)
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
      if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        res.status(400).json({ ok: false, message: 'A tracked absolute filePath is required' })
        return
      }
      const resolvedFilePath = path.resolve(filePath)
      if (!trackedArtifactIdentities(resolvedFilePath).tracked) {
        res.status(403).json({ ok: false, message: 'The requested path is not tracked by this application' })
        return
      }
      try {
        const { shell } = require('electron')
        if (fs.existsSync(resolvedFilePath) && fs.statSync(resolvedFilePath).isFile()) {
          shell.showItemInFolder(resolvedFilePath)
        } else {
          const dir = fs.existsSync(resolvedFilePath) ? resolvedFilePath : path.dirname(resolvedFilePath)
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            res.status(404).json({ ok: false, message: 'Folder not found' })
            return
          }
          const errorMessage = await shell.openPath(dir)
          if (errorMessage) throw new Error(errorMessage)
        }
      } catch {
        const dir = fs.existsSync(resolvedFilePath) ? resolvedFilePath : path.dirname(resolvedFilePath)
        if (fs.existsSync(resolvedFilePath) && fs.statSync(resolvedFilePath).isFile()) {
          await spawnSystemOpener(resolvedFilePath, true)
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
