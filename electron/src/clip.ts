import fs from 'node:fs'
import path from 'node:path'
import { Muxer, StreamTarget } from 'mp4-muxer'
import { AppConfig } from './types'
import { BilibiliClient } from './bilibili'
import { formatSeconds, sanitizeFilename, uniquePath, ensureDir } from './utils'
import { resolveAppPathWithBase } from './config'

export class ClipService {
  constructor(
    private config: AppConfig,
    private bilibiliClient: BilibiliClient,
    private baseDir: string,
  ) {}

  public async executeClip(rawUrl: string, startTime: number, endTime: number, qualityIndex: number = 0) {
    if (startTime < 0) startTime = 0
    if (endTime <= startTime) throw new Error('结束时间必须大于开始时间')
    const info = await this.bilibiliClient.getBilibiliVideoInfo(rawUrl)
    if (endTime > info.duration) endTime = info.duration

    let audioUrl = info.audioUrl
    if (qualityIndex > 0 && qualityIndex < info.qualities.audio.length) {
      const parsed = this.bilibiliClient.parseBilibiliUrl(rawUrl)
      if (parsed) {
        const queryParam = parsed.type === 'bv' ? `bvid=${parsed.id}` : `aid=${parsed.id}`
        const playUrl = await this.bilibiliClient.fetchJSON<{ code: number; data: { dash?: { audio: Array<{ base_url: string }> } } }>(
          `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${info.cid}&fnval=4048`,
        )
        if (playUrl?.data?.dash?.audio && playUrl.data.dash.audio[qualityIndex]) {
          audioUrl = playUrl.data.dash.audio[qualityIndex].base_url
        }
      }
    }

    const clipDir = resolveAppPathWithBase(this.baseDir, this.config.download.clip_output_dir || path.join(this.config.download.output_dir, 'clips'))
    ensureDir(clipDir)
    const safeTitle = sanitizeFilename(info.title || 'clip')
    const ts = `${formatSeconds(startTime)}-${formatSeconds(endTime)}`
    const outPath = uniquePath(path.join(clipDir, `[cut] ${safeTitle} (${ts}).m4a`))

    const response = await this.bilibiliClient.fetchWithCookies(audioUrl)
    if (!response.ok) throw new Error(`音频下载失败: ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())

    const sampleTable = this.parseM4ASampleTable(buffer)
    if (sampleTable) {
      const { frameSizes, frameDurations, timeScale } = sampleTable
      const samplesPerFrame = 1024
      let sampleRate = 48000

      const stsdStart = this.findBox(buffer, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
      if (stsdStart >= 0) {
        for (let i = stsdStart + 12; i + 8 <= stsdStart + this.boxSize(buffer, stsdStart); i++) {
          if (this.read4cc(buffer, i + 4) === 'mp4a') {
            sampleRate = (buffer[i + 16] << 8) | buffer[i + 17]
            break
          }
        }
      }

      const cumOffsets: number[] = [0]
      for (let i = 0; i < frameSizes.length; i++) {
        cumOffsets.push(cumOffsets[i] + frameSizes[i])
      }
      const mdatStart = this.findBox(buffer, ['mdat'])
      if (mdatStart < 0) { 
        fs.writeFileSync(outPath, buffer)
        return { path: outPath, fileName: path.basename(outPath), size: fs.statSync(outPath).size, title: info.title, duration: info.duration, startTime, endTime } 
      }

      const mdatPayload = mdatStart + 8
      let elapsed = 0
      const frames: Uint8Array[] = []
      for (let i = 0; i < frameSizes.length; i++) {
        const frameTime = elapsed / timeScale
        const nextFrameTime = (elapsed + (frameDurations[i] || (samplesPerFrame * timeScale) / sampleRate)) / timeScale
        if (nextFrameTime > startTime && frameTime < endTime) {
          const raw = buffer.subarray(mdatPayload + cumOffsets[i], mdatPayload + cumOffsets[i + 1])
          frames.push(raw)
        }
        elapsed += frameDurations[i] || (samplesPerFrame * timeScale) / sampleRate
      }

      if (frames.length > 0) {
        const outStream = fs.createWriteStream(outPath)
        const muxer = new Muxer({
          target: new StreamTarget({
            onData: (chunk) => outStream.write(chunk)
          }),
          video: undefined,
          audio: { codec: 'aac', numberOfChannels: 2, sampleRate },
          fastStart: 'in-memory',
          firstTimestampBehavior: 'offset',
        })
        let pts = 0
        const frameDurUs = (samplesPerFrame * 1000000) / sampleRate
        for (const frame of frames) {
          muxer.addAudioChunkRaw(frame, 'key', pts, frameDurUs)
          pts += frameDurUs
        }
        muxer.finalize()
        outStream.end()
      } else {
        fs.writeFileSync(outPath, buffer)
      }
    } else {
      fs.writeFileSync(outPath, buffer)
    }

    return { path: outPath, fileName: path.basename(outPath), size: fs.statSync(outPath).size, title: info.title, duration: info.duration, startTime, endTime }
  }

  private read4cc(buf: Buffer, offset: number) {
    return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3])
  }

  private boxSize(buf: Buffer, offset: number): number {
    return buf.readUInt32BE(offset)
  }

  private findBox(buf: Buffer, path: string[]): number {
    let offset = 0
    for (const target of path) {
      let found = false
      while (offset + 8 <= buf.length) {
        const size = this.boxSize(buf, offset)
        if (size < 8 || offset + size > buf.length) break
        if (this.read4cc(buf, offset + 4) === target) {
          offset += 8 // skip size + type, go to content
          found = true
          break
        }
        offset += size
      }
      if (!found) return -1
    }
    return offset - 8 // return to box header
  }

  private parseM4ASampleTable(buf: Buffer): { frameSizes: number[]; frameDurations: number[]; timeScale: number } | null {
    const stblStart = this.findBox(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl'])
    if (stblStart < 0) return null

    const stblSize = this.boxSize(buf, stblStart)
    const stblEnd = stblStart + stblSize
    let offset = stblStart + 8

    const frameSizes: number[] = []
    const frameDurations: number[] = []
    let timeScale = 48000 // default

    while (offset + 8 <= stblEnd) {
      const size = this.boxSize(buf, offset)
      if (size < 8 || offset + size > stblEnd) break
      const type = this.read4cc(buf, offset + 4)
      const body = offset + 8

      if (type === 'stsz') {
        const ver = buf[body]
        const sampleSize = buf.readUInt32BE(body + 4)
        const count = buf.readUInt32BE(body + 8)
        if (sampleSize > 0) {
          for (let i = 0; i < count; i++) frameSizes.push(sampleSize)
        } else {
          for (let i = 0; i < count; i++) {
            frameSizes.push(buf.readUInt32BE(body + 12 + i * 4))
          }
        }
      } else if (type === 'stts') {
        const ver = buf[body]
        const count = buf.readUInt32BE(body + 4)
        for (let i = 0; i < count; i++) {
          const n = buf.readUInt32BE(body + 8 + i * 8)
          const d = buf.readUInt32BE(body + 12 + i * 8)
          for (let j = 0; j < n; j++) frameDurations.push(d)
        }
      } else if (type === 'mdhd') {
        const ver = buf[body]
        if (ver === 0) {
          timeScale = buf.readUInt32BE(body + 12)
        } else {
          timeScale = buf.readUInt32BE(body + 20)
        }
      }

      offset += size
    }

    if (frameSizes.length === 0) return null
    return { frameSizes, frameDurations, timeScale }
  }
}
