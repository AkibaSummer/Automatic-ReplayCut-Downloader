import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { AppConfig, ReplayRecord, ReplayPatch, M3U8Segment, FileInfo } from './types'
import { SqliteStore } from './db'
import { BilibiliClient } from './bilibili'
import { formatSeconds, renderFilenameTemplate } from './utils'
import { spawn } from 'node:child_process'
import _ffmpegPath from 'ffmpeg-static'
import { parseFile } from 'music-metadata'

function resolveFFmpegPath(): string | null {
  if (!_ffmpegPath) return null
  return _ffmpegPath.replace('app.asar', 'app.asar.unpacked')
}

export class DownloaderService {
  constructor(
    private config: AppConfig,
    private db: SqliteStore,
    private bilibiliClient: BilibiliClient,
    private emitProgress: (payload: any) => void,
  ) {}

  public async processReplayTask(
    liveKey: string,
    signal: AbortSignal,
    baseDir: string,
    isCurrent: () => boolean = () => true,
  ) {
    let finalPath = ''
    let partPath = ''
    let renamed = false
    let committed = false
    try {
      let replay = this.db.getReplayByLiveKey(baseDir, liveKey)
      if (!replay) return

      this.patchActiveReplay(liveKey, ['pending'], { status: 'pending', message: 'Fetching stream list...' }, signal, isCurrent)
      this.emitProgress({ live_key: liveKey, status: 'pending' })
      await this.bilibiliClient.cacheReplayM3U8(replay, signal)
      this.assertActive(signal, isCurrent)

      replay = this.db.getReplayByLiveKey(baseDir, liveKey)
      if (!replay || replay.streams.length === 0) {
        throw new Error('No streams found for replay')
      }

      this.patchActiveReplay(liveKey, ['pending'], {
        status: 'downloading',
        message: 'Initializing download...',
        speed: '',
        eta: '',
        elapsed: replay.elapsed || '',
      }, signal, isCurrent)
      this.emitProgress({ live_key: liveKey, status: 'downloading' })

      const output = await this.downloadReplayWithContext(replay, signal, isCurrent)
      finalPath = output.finalPath
      partPath = output.partPath
      this.assertActive(signal, isCurrent)
      const targetReplay = this.db.getReplayByLiveKey(baseDir, liveKey) || replay

      this.patchActiveReplay(liveKey, ['merging'], { message: 'Verifying duration...' }, signal, isCurrent)
      this.emitProgress({ live_key: liveKey, status: 'merging' })
      let verifyOk = true
      let actualDuration = 0
      try {
        const verified = await this.verifyDuration(partPath, targetReplay.duration)
        verifyOk = verified.ok
        actualDuration = verified.duration
      } catch {
        verifyOk = false
      }
      this.assertActive(signal, isCurrent)

      let fileInfo: FileInfo = { size: 0, resolution: '', bitrate: '' }
      try {
        fileInfo = await this.getFileInfo(partPath)
      } catch {
        fileInfo = {
          size: fs.existsSync(partPath) ? fs.statSync(partPath).size : 0,
          resolution: '',
          bitrate: '',
        }
      }
      this.assertActive(signal, isCurrent)

      if (fs.existsSync(finalPath)) {
        throw new Error(`Replay output path became occupied: ${finalPath}`)
      }
      await fsp.rename(partPath, finalPath)
      renamed = true
      partPath = ''
      this.assertActive(signal, isCurrent)

      this.patchActiveReplay(liveKey, ['merging'], {
        file_path: finalPath,
        file_size: fileInfo.size,
        resolution: fileInfo.resolution,
        bitrate: fileInfo.bitrate,
        progress: 100,
        speed: '',
        elapsed: targetReplay.elapsed,
        eta: '',
        status: 'completed',
        message: verifyOk ? 'Success' : `Duration mismatch: expected ${targetReplay.duration}, got ${actualDuration.toFixed(1)}`,
        verify_ok: verifyOk,
        actual_duration: actualDuration,
      }, signal, isCurrent)
      committed = true
      this.emitProgress({ live_key: liveKey, status: 'completed' })
    } catch (error) {
      if (partPath) await fsp.rm(partPath, { force: true }).catch(() => {})
      if (finalPath && renamed && !committed) {
        await fsp.rm(finalPath, { force: true }).catch(() => {})
      }
      throw error
    }
  }

  private async downloadReplayWithContext(replay: ReplayRecord, signal: AbortSignal, isCurrent: () => boolean) {
    const streams = [...replay.streams].sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time)
    if (streams.length === 0) {
      throw new Error(`no streams found for replay ${replay.live_key}`)
    }

    let finalFilename = renderFilenameTemplate(this.config.download.filename_template, replay)
    if (!finalFilename.toLowerCase().endsWith('.mp4')) {
      finalFilename += '.mp4'
    }
    const desiredPath = path.join(this.config.download.output_dir, finalFilename)
    fs.mkdirSync(path.dirname(desiredPath), { recursive: true })
    const { finalPath, partPath } = this.reserveOutputPaths(desiredPath)

    try {
      const startAt = Date.now()
      const speedHistory: number[] = []
      let downloadedBytes = 0
      let doneSegments = 0
      let totalSegments = 0
      let expectedDuration = 0
      const allSegmentFiles: string[] = []
      const streamDirs: string[] = []

      for (let streamIdx = 0; streamIdx < streams.length; streamIdx += 1) {
        this.assertActive(signal, isCurrent)
        const stream = streams[streamIdx]
        const segments = await this.parseM3U8(stream.stream, stream.m3u8_text, signal)
        this.assertActive(signal, isCurrent)
        totalSegments += segments.length
        expectedDuration += segments.reduce((sum, item) => sum + item.duration, 0)
        const streamDir = path.join(this.config.download.temp_dir, `${replay.live_key}_stream${streamIdx}`)
        await fsp.mkdir(streamDir, { recursive: true })
        streamDirs.push(streamDir)

        const streamSegmentOffset = allSegmentFiles.length
        for (let i = 0; i < segments.length; i += 1) {
          const segPath = path.join(streamDir, `seg_${String(i).padStart(5, '0')}.ts`)
          allSegmentFiles.push(segPath)
        }

        const limit = Math.max(1, Math.floor(this.config.download.concurrent_segments || 5))
        let currentIndex = 0
        let firstError: unknown = null

        const downloadWorker = async () => {
          while (!firstError) {
            if (signal.aborted || !isCurrent()) {
              firstError = this.abortError()
              return
            }

            const i = currentIndex++
            if (i >= segments.length) return

            const seg = segments[i]
            const segPath = allSegmentFiles[streamSegmentOffset + i]

            try {
              if (!fs.existsSync(segPath) || fs.statSync(segPath).size === 0) {
                const bytes = await this.downloadSegment(seg.url, segPath, signal)
                downloadedBytes += bytes
              } else {
                downloadedBytes += fs.statSync(segPath).size
              }
              this.assertActive(signal, isCurrent)
              doneSegments += 1

              const elapsedSeconds = Math.max(1, (Date.now() - startAt) / 1000)
              const speedMb = downloadedBytes / elapsedSeconds / 1024 / 1024
              speedHistory.push(speedMb)
              if (speedHistory.length > 30) speedHistory.shift()
              const progress = Math.min(98, (doneSegments / Math.max(1, totalSegments)) * 100)
              const elapsed = this.formatElapsed(elapsedSeconds)
              const etaSeconds = speedMb <= 0 ? 0 : ((totalSegments - doneSegments) * elapsedSeconds) / Math.max(1, doneSegments)

              this.patchActiveReplay(replay.live_key, ['downloading'], {
                progress,
                speed: `${speedMb.toFixed(2)} MB/s`,
                elapsed,
                eta: etaSeconds > 0 ? this.formatElapsed(etaSeconds) : '',
                status: 'downloading',
                message: `Stream ${streamIdx + 1}/${streams.length}, Segment ${i + 1}/${segments.length}`,
              }, signal, isCurrent)

              this.emitProgress({
                live_key: replay.live_key,
                status: 'downloading',
                speed_history: [...speedHistory],
              })

              // Cached segments do not await I/O. Yield periodically so aborts and UI
              // updates are still handled while resuming a large existing download.
              if (doneSegments % 100 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve))
              }
            } catch (err) {
              firstError = err
            }
          }
        }

        const workerCount = Math.min(limit, segments.length)
        await Promise.all(Array.from({ length: workerCount }, () => downloadWorker()))
        if (firstError) throw firstError
      }

      this.patchActiveReplay(replay.live_key, ['downloading'], { status: 'merging', message: 'Merging all segments...', progress: 99 }, signal, isCurrent)
      this.emitProgress({ live_key: replay.live_key, status: 'merging', merge_progress: 0 })

      await this.runFfmpegMerge(replay.live_key, allSegmentFiles, partPath, expectedDuration, signal)
      this.assertActive(signal, isCurrent)

      for (const dir of streamDirs) {
        await fsp.rm(dir, { recursive: true, force: true })
      }
      this.assertActive(signal, isCurrent)
      return { finalPath, partPath }
    } catch (err) {
      if (fs.existsSync(partPath)) {
        try { fs.unlinkSync(partPath) } catch (e) { console.error('Failed to unlink partPath on error', e) }
      }
      throw err
    }
  }

  private abortError() {
    const error = new Error('aborted')
    error.name = 'AbortError'
    return error
  }

  private reserveOutputPaths(desiredPath: string) {
    const extension = path.extname(desiredPath) || '.mp4'
    const directory = path.dirname(desiredPath)
    const base = path.basename(desiredPath, extension)

    for (let index = 0; index < 10_000; index += 1) {
      const suffix = index === 0 ? '' : ` (${index})`
      const finalPath = path.join(directory, `${base}${suffix}${extension}`)
      const partPath = path.join(directory, `${base}${suffix}.part${extension}`)
      if (fs.existsSync(finalPath)) continue
      try {
        const descriptor = fs.openSync(partPath, 'wx')
        fs.closeSync(descriptor)
        return { finalPath, partPath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }

    throw new Error(`Unable to reserve replay output path for ${desiredPath}`)
  }

  private assertActive(signal: AbortSignal, isCurrent: () => boolean) {
    if (signal.aborted || !isCurrent()) throw this.abortError()
  }

  private patchActiveReplay(
    liveKey: string,
    allowedStatuses: readonly string[],
    patch: ReplayPatch,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) {
    this.assertActive(signal, isCurrent)
    if (!this.db.patchReplayIfStatus(liveKey, allowedStatuses, patch)) {
      throw this.abortError()
    }
  }

  private async downloadSegment(url: string, targetPath: string, signal: AbortSignal, retries = 3): Promise<number> {
    const tmpPath = `${targetPath}.tmp`
    try {
      const response = await this.bilibiliClient.fetchWithCookies(url, { signal })
      if (!response.ok) {
        throw new Error(`segment download failed: ${response.status} ${response.statusText}`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      await fsp.writeFile(tmpPath, buffer)
      await fsp.rename(tmpPath, targetPath)
      return buffer.byteLength
    } catch (err) {
      if (signal.aborted) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {})
        throw this.abortError()
      }
      if (retries > 0) {
        console.warn(`[downloader] Segment download failed, retrying... (${retries} left): ${url}`)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          }, 1000)
          const onAbort = () => {
            clearTimeout(timer)
            reject(this.abortError())
          }
          signal.addEventListener('abort', onAbort, { once: true })
        })
        return this.downloadSegment(url, targetPath, signal, retries - 1)
      }
      throw err
    }
  }

  private async parseM3U8(streamUrl: string, existingText: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted()
    const text = existingText || (await (await this.bilibiliClient.fetchWithCookies(streamUrl, { signal })).text())
    signal.throwIfAborted()
    const lines = text.split(/\r?\n/)
    const base = streamUrl.slice(0, streamUrl.lastIndexOf('/') + 1)
    const segments: M3U8Segment[] = []
    let nextDuration = 0
    for (const lineRaw of lines) {
      const line = lineRaw.trim()
      if (!line) continue
      if (line.startsWith('#EXTINF:')) {
        const raw = line.slice('#EXTINF:'.length).split(',')[0]
        nextDuration = Number.parseFloat(raw) || 0
        continue
      }
      if (line.startsWith('#')) continue
      const resolved = /^https?:\/\//i.test(line) ? line : new URL(line, base).toString()
      segments.push({ url: resolved, duration: nextDuration })
      nextDuration = 0
    }
    return segments
  }

  private async runFfmpegMerge(liveKey: string, segmentFiles: string[], outputPath: string, expectedSeconds: number, signal: AbortSignal) {
    let totalBytes = 0
    for (const fullPath of segmentFiles) {
      if (fs.existsSync(fullPath)) {
        totalBytes += fs.statSync(fullPath).size
      }
    }

    const tempPath = `${outputPath}.ts.tmp`
    let written = 0

    try {
      await new Promise<void>((resolve, reject) => {
        const outStream = createWriteStream(tempPath)
        let currentStream: ReturnType<typeof createReadStream> | null = null
        let settled = false

        const cleanup = () => {
          signal.removeEventListener('abort', onAbort)
          outStream.removeListener('error', fail)
        }
        const succeed = () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          currentStream?.destroy()
          const rejectAfterClose = () => reject(error)
          if (outStream.closed) {
            rejectAfterClose()
          } else {
            outStream.once('close', rejectAfterClose)
            outStream.destroy()
          }
        }
        const onAbort = () => fail(this.abortError())

        const appendNext = (idx: number) => {
          if (signal.aborted) {
            onAbort()
            return
          }
          if (idx >= segmentFiles.length) {
            outStream.once('close', succeed)
            outStream.end()
            return
          }
          const fullPath = segmentFiles[idx]
          if (!fs.existsSync(fullPath)) {
            fail(new Error(`Replay segment is missing: ${fullPath}`))
            return
          }
          currentStream = createReadStream(fullPath)
          currentStream.on('data', (chunk: string | Buffer) => {
            written += chunk.length
            const mergeProgress = totalBytes > 0 ? Math.max(0, Math.min(100, (written / totalBytes) * 100)) : 0
            this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: mergeProgress, message: `合并临时碎片... ${Math.round(mergeProgress)}%` })
          })
          currentStream.once('end', () => {
            currentStream = null
            appendNext(idx + 1)
          })
          currentStream.once('error', fail)
          currentStream.pipe(outStream, { end: false })
        }

        signal.addEventListener('abort', onAbort, { once: true })
        outStream.once('error', fail)
        appendNext(0)
      })

      if (signal.aborted) throw this.abortError()

      this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: 0, message: '转换MP4格式中 (0%)...' })
      await this.remuxTsToMp4(tempPath, outputPath, signal, (pct) => {
        this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: pct, message: `转换MP4格式中 (${pct}%)...` })
      }, expectedSeconds)
    } finally {
      await fsp.rm(tempPath, { force: true }).catch(() => {})
    }
  }

  private async remuxTsToMp4(tsPath: string, mp4Path: string, signal: AbortSignal, onProgress?: (pct: number) => void, expectedSeconds?: number) {
    const ffmpegBin = resolveFFmpegPath() || 'ffmpeg'
    
    const runFfmpeg = (extraArgs: string[]) => {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(this.abortError())
          return
        }
        const proc = spawn(ffmpegBin, [
          '-i', tsPath,
          '-c', 'copy',
          '-movflags', '+faststart',
          ...extraArgs,
          '-y', mp4Path
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

        let stderr = ''
        proc.stderr.on('data', (c: Buffer) => { 
          const chunkStr = c.toString()
          stderr += chunkStr
          
          if (onProgress && expectedSeconds && expectedSeconds > 0) {
            const match = stderr.slice(-1000).match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/)
            if (match) {
              const h = parseInt(match[1], 10)
              const m = parseInt(match[2], 10)
              const s = parseFloat(match[3])
              const currentSec = h * 3600 + m * 60 + s
              const pct = Math.min(100, Math.max(0, Math.round((currentSec / expectedSeconds) * 100)))
              onProgress(pct)
            }
          }
        })

        const onAbort = () => {
          proc.kill('SIGTERM')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()

        proc.on('close', (code) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            reject(this.abortError())
          } else if (code === 0) {
            resolve()
          } else {
            reject(new Error(`ffmpeg remux failed: ${stderr.slice(-500)}`))
          }
        })
        proc.on('error', (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        })
      })
    }

    try {
      await runFfmpeg([])
    } catch (err) {
      if (err instanceof Error && err.message.includes('tag for codec hevc')) {
        await runFfmpeg(['-tag:v', 'hvc1'])
      } else {
        throw err
      }
    }
  }



  private async verifyDuration(filePath: string, expectedSeconds: number) {
    if (!fs.existsSync(filePath)) return { ok: false, duration: 0 }
    try {
      const metadata = await parseFile(filePath)
      const duration = metadata.format.duration || 0
      if (expectedSeconds <= 0) return { ok: duration > 0, duration }
      const diff = Math.abs(duration - expectedSeconds)
      const margin = Math.min(600, 60 + expectedSeconds * 0.02)
      return { ok: diff <= margin, duration }
    } catch {
      return { ok: false, duration: 0 }
    }
  }

  private async getFileInfo(filePath: string): Promise<FileInfo> {
    if (!fs.existsSync(filePath)) return { size: 0, resolution: '', bitrate: '' }
    const stat = fs.statSync(filePath)
    try {
      const metadata = await parseFile(filePath)
      const videoTrack = metadata.format.trackInfo.find(t => t.video)?.video
      const bitRate = metadata.format.bitrate || 0
      return {
        size: stat.size,
        resolution: videoTrack ? `${videoTrack.pixelWidth || videoTrack.displayWidth || 0}x${videoTrack.pixelHeight || videoTrack.displayHeight || 0}` : '',
        bitrate: bitRate > 0 ? `${(bitRate / 1000000).toFixed(2)} Mbps` : '',
      }
    } catch {
      return { size: stat.size, resolution: '', bitrate: '' }
    }
  }

  private formatElapsed(totalSeconds: number) {
    const safe = Math.max(0, Math.floor(totalSeconds))
    const h = Math.floor(safe / 3600)
    const m = Math.floor((safe % 3600) / 60)
    const s = safe % 60
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
}
