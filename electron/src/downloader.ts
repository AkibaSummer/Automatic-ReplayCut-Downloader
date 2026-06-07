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

    if (replay.streams.length === 0) {
      this.db.patchReplay(liveKey, { status: 'pending', message: 'Fetching stream list...' })
      this.emitProgress({ live_key: liveKey, status: 'pending', progress: replay.progress, message: 'Fetching stream list...' })
      await this.bilibiliClient.cacheReplayM3U8(replay)
      replay = this.db.getReplayByLiveKey(baseDir, liveKey)
      if (!replay || replay.streams.length === 0) {
        throw new Error('No streams found for replay')
      }
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
    fs.writeFileSync(finalPath, '')

    try {
      const startAt = Date.now()
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

      for (let i = 0; i < segments.length; i += 1) {
        if (signal.aborted) throw new Error('aborted')
        const seg = segments[i]
        const segPath = path.join(streamDir, `seg_${String(i).padStart(5, '0')}.ts`)
        if (!fs.existsSync(segPath) || fs.statSync(segPath).size === 0) {
          const bytes = await this.downloadSegment(seg.url, segPath, signal)
          downloadedBytes += bytes
        } else {
          downloadedBytes += fs.statSync(segPath).size
        }
        doneSegments += 1
        allSegmentFiles.push(segPath)
        allSegmentDurations.push(seg.duration)
        const elapsedSeconds = Math.max(1, (Date.now() - startAt) / 1000)
        const speedMb = downloadedBytes / elapsedSeconds / 1024 / 1024
        speedHistory.push(speedMb)
        if (speedHistory.length > 30) speedHistory.shift()
        const progress = Math.min(98, (doneSegments / Math.max(1, totalSegments)) * 100)
        const elapsed = this.formatElapsed(elapsedSeconds)
        const etaSeconds = speedMb <= 0 ? 0 : ((totalSegments - doneSegments) * elapsedSeconds) / Math.max(1, doneSegments)
        this.db.patchReplay(replay.live_key, {
          progress,
          speed: `${speedMb.toFixed(2)} MB/s`,
          elapsed,
          eta: etaSeconds > 0 ? this.formatElapsed(etaSeconds) : '',
          status: 'downloading',
          message: `Stream ${streamIdx + 1}/${streams.length}, Segment ${i + 1}/${segments.length}`,
        })
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
      }
    }

    const localM3U8Path = path.join(this.config.download.temp_dir, `${replay.live_key}_local.m3u8`)
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0']
    for (let i = 0; i < allSegmentFiles.length; i += 1) {
      playlist.push(`#EXTINF:${(allSegmentDurations[i] || 10).toFixed(6)},`)
      playlist.push(allSegmentFiles[i].replaceAll('\\', '/'))
    }
    playlist.push('#EXT-X-ENDLIST')
    await fsp.writeFile(localM3U8Path, playlist.join('\n'), 'utf8')

    this.db.patchReplay(replay.live_key, { status: 'merging', message: 'Merging all segments...', progress: 99 })
    this.emitProgress({ live_key: replay.live_key, status: 'merging', progress: 99, merge_progress: 0, message: 'Merging all segments...' })

    await this.runFfmpegMerge(replay.live_key, allSegmentFiles, finalPath, expectedDuration, signal)

      await fsp.rm(localM3U8Path, { force: true })
      for (const dir of streamDirs) {
        await fsp.rm(dir, { recursive: true, force: true })
      }
      return finalPath
    } catch (err) {
      if (fs.existsSync(finalPath) && fs.statSync(finalPath).size === 0) {
        fs.unlinkSync(finalPath)
      }
      throw err
    }
  }

  private async downloadSegment(url: string, targetPath: string, signal: AbortSignal) {
    const tmpPath = `${targetPath}.tmp`
    const response = await this.bilibiliClient.fetchWithCookies(url, { signal })
    if (!response.ok) {
      throw new Error(`segment download failed: ${response.status} ${response.statusText}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await fsp.writeFile(tmpPath, buffer)
    await fsp.rename(tmpPath, targetPath)
    return buffer.byteLength
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
          proc.kill()
          reject(new Error('aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })

        proc.on('close', (code) => {
          signal.removeEventListener('abort', onAbort)
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg remux failed: ${stderr.slice(-500)}`))
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
