import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { Muxer, StreamTarget } from 'mp4-muxer'
import { parseFile } from 'music-metadata'

import { AppConfig, ReplayRecord, M3U8Segment, FileInfo } from './types'
import { SqliteStore } from './db'
import { BilibiliClient } from './bilibili'
import { formatSeconds, uniquePath, renderFilenameTemplate } from './utils'

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

    await this.runFfmpegMerge(replay.live_key, localM3U8Path, finalPath, expectedDuration, signal)

    await fsp.rm(localM3U8Path, { force: true })
    for (const dir of streamDirs) {
      await fsp.rm(dir, { recursive: true, force: true })
    }
    return finalPath
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

  private async runFfmpegMerge(liveKey: string, inputM3U8: string, outputPath: string, expectedSeconds: number, signal: AbortSignal) {
    const segments = await this.parseM3U8(inputM3U8)
    let totalBytes = 0
    for (const seg of segments) {
      const localPath = decodeURI(new URL(seg.url).pathname).replace(/\//g, path.sep)
      const fullPath = path.join(path.dirname(inputM3U8), path.basename(localPath))
      if (fs.existsSync(fullPath)) {
        totalBytes += fs.statSync(fullPath).size
      }
    }

    const tempPath = `${outputPath}.ts.tmp`
    const outStream = createWriteStream(tempPath)
    let written = 0

    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => { outStream.close(); reject(new Error('aborted')) }, { once: true })
      outStream.on('error', reject)

      const appendNext = (idx: number) => {
        if (signal.aborted) return
        if (idx >= segments.length) {
          outStream.end(() => resolve())
          return
        }
        const seg = segments[idx]
        const localPath = decodeURI(new URL(seg.url).pathname).replace(/\//g, path.sep)
        const fullPath = path.join(path.dirname(inputM3U8), path.basename(localPath))
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

    if (signal.aborted) { await fsp.rm(tempPath, { force: true }); return }

    try {
      await this.remuxTsToMp4(tempPath, outputPath, signal)
    } finally {
      await fsp.rm(tempPath, { force: true })
    }
  }

  private async remuxTsToMp4(tsPath: string, mp4Path: string, signal: AbortSignal) {
    const buffer = fs.readFileSync(tsPath)
    if (signal.aborted) return
    const data = new Uint8Array(buffer)

    const patPid = 0x00
    let pmtPid = -1
    let videoPid = -1; let videoCodec = ''
    let audioPid = -1; let audioCodec = ''
    let width = 1920; let height = 1080; let sampleRate = 48000; let channels = 2

    for (let i = 0; i + 188 <= data.length && (videoPid < 0 || audioPid < 0); i += 188) {
      if (data[i] !== 0x47) continue
      const pid = ((data[i + 1] & 0x1F) << 8) | data[i + 2]
      if (pid === patPid && pmtPid < 0) pmtPid = this.parsePatPmtPid(data, i)
      if (pmtPid >= 0 && pid === pmtPid) {
        const info = this.parsePmtInfo(data, i)
        if (info.videoPid >= 0) { videoPid = info.videoPid; videoCodec = info.videoCodec; width = info.width; height = info.height }
        if (info.audioPid >= 0) { audioPid = info.audioPid; audioCodec = info.audioCodec; sampleRate = info.sampleRate; channels = info.channels }
      }
    }
    if (videoPid < 0 && audioPid < 0) { fs.writeFileSync(mp4Path, buffer); return }

    const outStream = createWriteStream(mp4Path)
    
    // FIX: Replaced ArrayBufferTarget with StreamTarget to fix OOM issue.
    const muxer = new Muxer({
      target: new StreamTarget({
        onData: (chunk, position) => {
          outStream.write(chunk)
        }
      }),
      video: videoPid >= 0 ? { codec: (videoCodec || 'avc') as 'avc' | 'hevc', width, height } : undefined,
      audio: audioPid >= 0 ? { codec: (audioCodec || 'aac') as 'aac' | 'opus', numberOfChannels: channels, sampleRate } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    })

    const accumVideo = new Uint8Array(4 * 1024 * 1024)
    const accumAudio = new Uint8Array(512 * 1024)
    let accumVideoLen = 0; let accumAudioLen = 0
    let videoPts = 0; let audioPts = 0
    let hasKeyFrame = false

    const processVideoPes = (payload: Uint8Array) => {
      let idx = 0
      const buf = payload
      const end = buf.length
      while (idx + 4 < end) {
        let start = -1
        if (buf[idx] === 0 && buf[idx + 1] === 0 && buf[idx + 2] === 1) { start = idx; idx += 3 }
        else if (buf[idx] === 0 && buf[idx + 1] === 0 && buf[idx + 2] === 0 && buf[idx + 3] === 1) { start = idx; idx += 4 }
        else { idx++; continue }
        let nalEnd = end
        for (let j = idx; j + 2 < end; j++) {
          if (buf[j] === 0 && buf[j + 1] === 0 && (buf[j + 2] === 1 || (buf[j + 2] === 0 && buf[j + 3] === 1))) { nalEnd = j; break }
        }
        const nalType = buf[idx] & 0x1F
        if (nalType === 5) hasKeyFrame = true
        if (hasKeyFrame) {
          const body = buf.subarray(idx, nalEnd)
          const avcc = new Uint8Array(4 + body.length)
          const sz = body.length
          avcc[0] = (sz >> 24) & 0xFF; avcc[1] = (sz >> 16) & 0xFF
          avcc[2] = (sz >> 8) & 0xFF; avcc[3] = sz & 0xFF
          avcc.set(body, 4)
          muxer.addVideoChunkRaw(avcc, nalType === 5 ? 'key' : 'delta', videoPts, 0)
        }
        idx = nalEnd
      }
    }

    const sampleRateTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    const processAudioPes = (payload: Uint8Array) => {
      let idx = 0
      const buf = payload
      const end = buf.length
      while (idx + 2 < end) {
        if (buf[idx] === 0xFF && (buf[idx + 1] & 0xF6) === 0xF0) {
          const prot = (buf[idx + 1] & 0x01) !== 0
          const srIdx = (buf[idx + 1] & 0x3C) >> 2
          const headerLen = prot ? 7 : 9
          const rawLen = (((buf[idx + 3] & 0x03) << 11) | ((buf[idx + 4] & 0xFF) << 3) | ((buf[idx + 5] & 0xE0) >> 5)) - headerLen
          if (rawLen > 0 && idx + headerLen + rawLen <= end) {
            muxer.addAudioChunkRaw(buf.subarray(idx + headerLen, idx + headerLen + rawLen), 'key', audioPts, (1024 * 1000000) / (sampleRateTable[srIdx] || 48000))
            audioPts += (1024 * 1000000) / (sampleRateTable[srIdx] || 48000)
          }
          idx += headerLen + Math.max(0, rawLen)
        } else { idx++ }
      }
    }

    for (let i = 0; i + 188 <= data.length; i += 188) {
      if (signal.aborted) return
      if (data[i] !== 0x47) continue
      const pid = ((data[i + 1] & 0x1F) << 8) | data[i + 2]
      const isPusi = (data[i + 1] & 0x40) !== 0
      const afc = (data[i + 3] & 0x30) >> 4
      let pStart = 4
      if (afc === 3) pStart = 5 + data[i + 4]
      const payload = data.subarray(i + pStart, i + 188)

      if (pid === videoPid) {
        if (isPusi) {
          if (accumVideoLen > 0) processVideoPes(accumVideo.subarray(0, accumVideoLen))
          accumVideoLen = 0
          if (payload[0] < payload.length && payload.length >= 10) {
            const pesStart = 1 + payload[0]
            if (pesStart + 5 < payload.length && (payload[pesStart + 7] & 0x80)) {
              videoPts = Number((BigInt(payload[pesStart + 9] & 0x0E) << 29n) | (BigInt(payload[pesStart + 10]) << 22n) | (BigInt(payload[pesStart + 11] & 0xFE) << 14n) | (BigInt(payload[pesStart + 12]) << 7n) | (BigInt(payload[pesStart + 13] & 0xFE) >> 1n))
            }
            if (pesStart < payload.length) { accumVideo.set(payload.subarray(pesStart), 0); accumVideoLen = payload.length - pesStart }
          }
        } else if (accumVideoLen + payload.length <= accumVideo.length) {
          accumVideo.set(payload, accumVideoLen); accumVideoLen += payload.length
        }
      } else if (pid === audioPid) {
        if (isPusi) {
          if (accumAudioLen > 0) processAudioPes(accumAudio.subarray(0, accumAudioLen))
          accumAudioLen = 0
          if (payload[0] < payload.length && payload.length >= 10) {
            const pesStart = 1 + payload[0]
            if (pesStart + 5 < payload.length && (payload[pesStart + 7] & 0x80)) {
              audioPts = Number((BigInt(payload[pesStart + 9] & 0x0E) << 29n) | (BigInt(payload[pesStart + 10]) << 22n) | (BigInt(payload[pesStart + 11] & 0xFE) << 14n) | (BigInt(payload[pesStart + 12]) << 7n) | (BigInt(payload[pesStart + 13] & 0xFE) >> 1n))
            }
            if (pesStart < payload.length) { accumAudio.set(payload.subarray(pesStart), 0); accumAudioLen = payload.length - pesStart }
          }
        } else if (accumAudioLen + payload.length <= accumAudio.length) {
          accumAudio.set(payload, accumAudioLen); accumAudioLen += payload.length
        }
      }
    }
    if (accumVideoLen > 0) processVideoPes(accumVideo.subarray(0, accumVideoLen))
    if (accumAudioLen > 0) processAudioPes(accumAudio.subarray(0, accumAudioLen))

    muxer.finalize()
    outStream.end()
  }

  private parsePatPmtPid(data: Uint8Array, offset: number): number {
    for (let i = offset + 4; i + 4 <= offset + 188; i += 4) {
      if (((data[i] << 8) | data[i + 1]) === 0) continue
      return ((data[i + 2] & 0x1F) << 8) | (data[i + 3] & 0xFF)
    }
    return -1
  }

  private parsePmtInfo(data: Uint8Array, offset: number) {
    const result = { videoPid: -1, videoCodec: '', width: 1920, height: 1080, audioPid: -1, audioCodec: '', sampleRate: 48000, channels: 2 }
    const ptr = data[offset + 4] & 0xFF
    const sectionEnd = offset + 4 + (((data[offset + 1] & 0x0F) << 8) | data[offset + 2])
    let i = offset + 4 + 1 + ptr + 4
    i += ((data[offset + 8 + ptr] & 0x0F) << 8) | data[offset + 9 + ptr]
    while (i + 5 <= Math.min(offset + 188, sectionEnd)) {
      const st = data[i] & 0xFF
      const esPid = ((data[i + 1] & 0x1F) << 8) | data[i + 2]
      const esLen = ((data[i + 3] & 0x0F) << 8) | data[i + 4]
      i += 5
      const esEnd = i + esLen
      if ((st === 0x1B || st === 0x24) && result.videoPid < 0) {
        result.videoPid = esPid; result.videoCodec = st === 0x24 ? 'hevc' : 'avc'
        for (let j = esEnd - 1; j - 8 >= i; j--) {
          if (data[j - 8] === 0x28 && data[j - 7] === 0x00 && data[j - 6] === 0x00 && data[j - 5] === 0x1E) {
            result.width = ((data[j - 2] & 0xFF) << 8) | (data[j - 1] & 0xFF)
            result.height = ((data[j] & 0xFF) << 8) | (data[j + 1] & 0xFF)
            break
          }
        }
      } else if ((st === 0x0F || st === 0x11) && result.audioPid < 0) {
        result.audioPid = esPid; result.audioCodec = 'aac'
        const srTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
        for (let j = i; j + 3 <= esEnd; j++) {
          if (data[j] === 0xFF && (data[j + 1] & 0xF6) === 0xF0) {
            result.sampleRate = srTable[(data[j + 1] & 0x3C) >> 2] || 48000
            result.channels = Math.max(1, ((data[j + 1] & 0x01) << 2) | ((data[j + 2] & 0xC0) >> 6))
            break
          }
        }
      }
      i = esEnd
    }
    return result
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
