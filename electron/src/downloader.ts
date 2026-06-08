import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { AppConfig, ReplayRecord, M3U8Segment, FileInfo } from './types'
import { SqliteStore } from './db'
import { BilibiliClient } from './bilibili'
import { formatSeconds, uniquePath, renderFilenameTemplate } from './utils'
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

  public async processReplayTask(liveKey: string, signal: AbortSignal, baseDir: string) {
    let replay = this.db.getReplayByLiveKey(baseDir, liveKey)
    if (!replay) return

    this.db.patchReplay(liveKey, { status: 'pending', message: 'Fetching stream list...' })
    this.emitProgress({ live_key: liveKey, status: 'pending', progress: replay.progress, message: 'Fetching stream list...' })
    await this.bilibiliClient.cacheReplayM3U8(replay)
    replay = this.db.getReplayByLiveKey(baseDir, liveKey)
    if (!replay || replay.streams.length === 0) {
      throw new Error('No streams found for replay')
    }

    this.db.patchReplay(liveKey, {
      status: 'downloading',
      message: 'Initializing download...',
      speed: '',
      eta: '',
      elapsed: replay.elapsed || '',
    })
    this.emitProgress({ live_key: liveKey, status: 'downloading', progress: replay.progress, message: 'Initializing download...' })

    const finalPath = await this.downloadReplayWithContext(replay, signal)
    const targetReplay = this.db.getReplayByLiveKey(baseDir, liveKey) || replay

    this.db.patchReplay(liveKey, { message: 'Verifying duration...' })
    let verifyOk = true
    let actualDuration = 0
    try {
      const verified = await this.verifyDuration(finalPath, targetReplay.duration)
      verifyOk = verified.ok
      actualDuration = verified.duration
    } catch {
      verifyOk = false
    }

    let fileInfo: FileInfo = { size: 0, resolution: '', bitrate: '' }
    try {
      fileInfo = await this.getFileInfo(finalPath)
    } catch {
      fileInfo = {
        size: fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0,
        resolution: '',
        bitrate: '',
      }
    }

    this.db.patchReplay(liveKey, {
      file_path: finalPath,
      file_size: fileInfo.size,
      resolution: fileInfo.resolution,
      bitrate: fileInfo.bitrate,
      progress: 100,
      speed: '',
      eta: '',
      status: 'completed',
      message: verifyOk ? 'Success' : `Duration mismatch: expected ${targetReplay.duration}, got ${actualDuration.toFixed(1)}`,
      verify_ok: verifyOk,
      actual_duration: actualDuration,
    })
    this.emitProgress({ live_key: liveKey, status: 'completed', progress: 100, message: 'Success' })
  }

  private async downloadReplayWithContext(replay: ReplayRecord, signal: AbortSignal) {
    const streams = [...replay.streams].sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time)
    if (streams.length === 0) {
      throw new Error(`no streams found for replay ${replay.live_key}`)
    }

    let finalFilename = renderFilenameTemplate(this.config.download.filename_template, replay)
    if (!finalFilename.toLowerCase().endsWith('.mp4')) {
      finalFilename += '.mp4'
    }
    let finalPath = path.join(this.config.download.output_dir, finalFilename)
    finalPath = uniquePath(finalPath)
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    fs.writeFileSync(finalPath, '')

    try {
      const startAt = Date.now()
      let lastDbPatchAt = 0
      const speedHistory: number[] = []
      let downloadedBytes = 0
      let doneSegments = 0
      let totalSegments = 0
      let expectedDuration = 0
      const allSegmentFiles: string[] = []
      const allSegmentDurations: number[] = []
      const streamDirs: string[] = []

    for (let streamIdx = 0; streamIdx < streams.length; streamIdx += 1) {
      if (signal.aborted) throw new Error('aborted')
      const stream = streams[streamIdx]
      const segments = await this.parseM3U8(stream.stream, stream.m3u8_text)
      totalSegments += segments.length
      expectedDuration += segments.reduce((sum, item) => sum + item.duration, 0)
      const streamDir = path.join(this.config.download.temp_dir, `${replay.live_key}_stream${streamIdx}`)
      await fsp.mkdir(streamDir, { recursive: true })
      streamDirs.push(streamDir)

      const streamSegmentOffset = allSegmentFiles.length
      for (let i = 0; i < segments.length; i += 1) {
        const segPath = path.join(streamDir, `seg_${String(i).padStart(5, '0')}.ts`)
        allSegmentFiles.push(segPath)
        allSegmentDurations.push(segments[i].duration)
      }

      const limit = this.config.download.concurrent_segments || 5
      let active = 0
      let currentIndex = 0
      let hasError = false

      await new Promise<void>((resolve, reject) => {
        const checkDone = () => {
          if (active === 0 && currentIndex >= segments.length && !hasError) resolve()
        }

        const next = () => {
          if (hasError) return
          if (signal.aborted) {
            hasError = true
            reject(new Error('aborted'))
            return
          }
          if (currentIndex >= segments.length) {
            checkDone()
            return
          }

          while (active < limit && currentIndex < segments.length) {
            if (hasError || signal.aborted) break
            const i = currentIndex++
            active++
            const seg = segments[i]
            const segPath = allSegmentFiles[streamSegmentOffset + i]

            ;(async () => {
              try {
                if (!fs.existsSync(segPath) || fs.statSync(segPath).size === 0) {
                  const bytes = await this.downloadSegment(seg.url, segPath, signal)
                  downloadedBytes += bytes
                } else {
                  downloadedBytes += fs.statSync(segPath).size
                }
                doneSegments += 1
                
                const elapsedSeconds = Math.max(1, (Date.now() - startAt) / 1000)
                const speedMb = downloadedBytes / elapsedSeconds / 1024 / 1024
                speedHistory.push(speedMb)
                if (speedHistory.length > 30) speedHistory.shift()
                const progress = Math.min(98, (doneSegments / Math.max(1, totalSegments)) * 100)
                const elapsed = this.formatElapsed(elapsedSeconds)
                const etaSeconds = speedMb <= 0 ? 0 : ((totalSegments - doneSegments) * elapsedSeconds) / Math.max(1, doneSegments)
                
                if (Date.now() - lastDbPatchAt > 10000) {
                  lastDbPatchAt = Date.now()
                  this.db.patchReplay(replay.live_key, {
                    progress,
                    speed: `${speedMb.toFixed(2)} MB/s`,
                    elapsed,
                    eta: etaSeconds > 0 ? this.formatElapsed(etaSeconds) : '',
                    status: 'downloading',
                    message: `Stream ${streamIdx + 1}/${streams.length}, Segment ${i + 1}/${segments.length}`,
                  })
                }

                this.emitProgress({
                  live_key: replay.live_key,
                  status: 'downloading',
                  progress,
                  message: `Stream ${streamIdx + 1}/${streams.length}, Segment ${i + 1}/${segments.length}`,
                  speed: `${speedMb.toFixed(2)} MB/s`,
                  speed_history: [...speedHistory],
                  elapsed,
                  eta: etaSeconds > 0 ? this.formatElapsed(etaSeconds) : '',
                })
              } catch (err) {
                if (!hasError) {
                  hasError = true
                  reject(err)
                }
              } finally {
                active--
                next()
              }
            })()
          }
        }

        const onAbort = () => {
          if (!hasError) {
            hasError = true
            reject(new Error('aborted'))
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        next()
        
        // Remove listener when done to avoid leak
        const originalResolve = resolve
        resolve = () => {
          signal.removeEventListener('abort', onAbort)
          originalResolve()
        }
        const originalReject = reject
        reject = (err) => {
          signal.removeEventListener('abort', onAbort)
          originalReject(err)
        }
      })
    }

      this.db.patchReplay(replay.live_key, { status: 'merging', message: 'Merging all segments...', progress: 99 })
      this.emitProgress({ live_key: replay.live_key, status: 'merging', progress: 99, merge_progress: 0, message: 'Merging all segments...' })

      await this.runFfmpegMerge(replay.live_key, allSegmentFiles, finalPath, expectedDuration, signal)

      for (const dir of streamDirs) {
        await fsp.rm(dir, { recursive: true, force: true })
      }
      return finalPath
    } catch (err) {
      if (fs.existsSync(finalPath)) {
        try { fs.unlinkSync(finalPath) } catch (e) { console.error('Failed to unlink finalPath on error', e) }
      }
      throw err
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
      if (signal.aborted) throw err
      if (retries > 0) {
        console.warn(`[downloader] Segment download failed, retrying... (${retries} left): ${url}`)
        await new Promise(resolve => setTimeout(resolve, 1000))
        return this.downloadSegment(url, targetPath, signal, retries - 1)
      }
      throw err
    }
  }

  private async parseM3U8(streamUrl: string, existingText?: string) {
    const text = existingText || (await (await this.bilibiliClient.fetchWithCookies(streamUrl)).text())
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
    const outStream = createWriteStream(tempPath)
    let written = 0

    try {
      try {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          outStream.on('error', reject)

          const appendNext = (idx: number) => {
            if (signal.aborted) return
            if (idx >= segmentFiles.length) {
              outStream.end(() => resolve())
              return
            }
            const fullPath = segmentFiles[idx]
            if (!fs.existsSync(fullPath)) {
              appendNext(idx + 1)
              return
            }
            const rs = createReadStream(fullPath)
            rs.on('data', (chunk: string | Buffer) => {
              written += chunk.length
              const mergeProgress = totalBytes > 0 ? Math.max(0, Math.min(100, (written / totalBytes) * 100)) : 0
              this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: mergeProgress, message: `Merging... ${Math.round(mergeProgress)}%` })
            })
            rs.on('end', () => appendNext(idx + 1))
            rs.on('error', reject)
            rs.pipe(outStream, { end: false })
          }
          appendNext(0)
        })
      } finally {
        outStream.close()
      }

      if (signal.aborted) return
  
      this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: 100, message: '转换MP4格式中 (大文件可能需要几分钟)...' })
      await this.remuxTsToMp4(tempPath, outputPath, signal)
    } finally {
      await fsp.rm(tempPath, { force: true }).catch(() => {})
    }
  }

  private async remuxTsToMp4(tsPath: string, mp4Path: string, signal: AbortSignal) {
    const ffmpegBin = resolveFFmpegPath() || 'ffmpeg'
    
    const runFfmpeg = (extraArgs: string[]) => {
      return new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegBin, [
          '-i', tsPath,
          '-c', 'copy',
          '-movflags', '+faststart',
          ...extraArgs,
          '-y', mp4Path
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

        let stderr = ''
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })

        const onAbort = () => {
          proc.kill('SIGTERM')
        }
        signal.addEventListener('abort', onAbort, { once: true })

        proc.on('close', (code) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            reject(new Error('aborted'))
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
