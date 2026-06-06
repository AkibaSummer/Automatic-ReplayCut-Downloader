import fs from 'node:fs'
import path from 'node:path'
import { AppConfig } from './types'
import { BilibiliClient, USER_AGENT } from './bilibili'
import { formatSeconds, sanitizeFilename, uniquePath, ensureDir } from './utils'
import { resolveAppPathWithBase } from './config'
import _ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'

// In production Electron builds, ffmpeg-static is in app.asar.unpacked
function resolveFFmpegPath(): string | null {
  if (!_ffmpegPath) return null
  return _ffmpegPath.replace('app.asar', 'app.asar.unpacked')
}

const ffmpegResolved = resolveFFmpegPath()
if (ffmpegResolved) {
  ffmpeg.setFfmpegPath(ffmpegResolved)
}

export class ClipService {
  constructor(
    private config: AppConfig,
    private bilibiliClient: BilibiliClient,
    private baseDir: string,
  ) {}

  public async executeClip(rawUrl: string, title: string, startTime: number, endTime: number, audioQualityIndex: number = 0, videoQualityIndex: number = 0, onProgress?: (p: number) => void) {
    if (startTime < 0) startTime = 0
    if (endTime <= startTime) throw new Error('结束时间必须大于开始时间')
    const info = await this.bilibiliClient.getBilibiliVideoInfo(rawUrl)
    if (endTime > info.duration) endTime = info.duration

    let audioUrl = info.audioUrl
    let videoUrl = ''

    const parsed = this.bilibiliClient.parseBilibiliUrl(rawUrl)
    if (parsed) {
      const queryParam = parsed.type === 'bv' ? `bvid=${parsed.id}` : `aid=${parsed.id}`
      const playUrl = await this.bilibiliClient.fetchJSON<{ code: number; data: { dash?: { audio: Array<{ base_url: string }>, video: Array<{ base_url: string }> } } }>(
        `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${info.cid}&qn=127&fourk=1&fnval=4048`,
      )
      if (playUrl?.data?.dash) {
        if (playUrl.data.dash.audio && playUrl.data.dash.audio[audioQualityIndex]) {
          audioUrl = playUrl.data.dash.audio[audioQualityIndex].base_url
        }
        if (playUrl.data.dash.video && playUrl.data.dash.video[videoQualityIndex]) {
          videoUrl = playUrl.data.dash.video[videoQualityIndex].base_url
        } else if (playUrl.data.dash.video && playUrl.data.dash.video[0]) {
          videoUrl = playUrl.data.dash.video[0].base_url
        }
      }
    }

    const clipDir = resolveAppPathWithBase(this.baseDir, this.config.download.clip_output_dir || path.join(this.config.download.output_dir, 'clips'))
    ensureDir(clipDir)
    const safeTitle = sanitizeFilename(title || info.title || 'clip')
    const ts = `${formatSeconds(startTime)}-${formatSeconds(endTime)}`.replace(/:/g, '-')
    // Export to MP4 since we are including video
    const outPath = uniquePath(path.join(clipDir, `[cut] ${safeTitle} (${ts}).mp4`))

    const cookie = this.bilibiliClient.cookieHeader()
    const headers = `Referer: https://live.bilibili.com/\r\nUser-Agent: ${USER_AGENT}\r\nCookie: ${cookie}\r\n`

    return new Promise((resolve, reject) => {
      const totalDuration = endTime - startTime
      const command = ffmpeg()

      if (videoUrl) {
        command
          .addInput(videoUrl)
          .addInputOptions([
            '-ss', `${startTime}`,
            '-headers', headers
          ])
      }

      if (audioUrl) {
        command
          .addInput(audioUrl)
          .addInputOptions([
            '-ss', `${startTime}`,
            '-headers', headers
          ])
      }

      // Track progress via file size growth as a fallback for copy mode
      let expectedSize = 0
      let progressInterval: NodeJS.Timeout | null = null

      command
        .outputOptions([
          '-t', `${totalDuration}`,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-strict', 'experimental',
          '-progress', 'pipe:1',   // Force progress output even in copy mode
        ])
        .on('start', (cmdLine: string) => {
          console.log('[clip] FFmpeg started:', cmdLine)
          // Start file-size-based progress polling as backup
          if (onProgress && totalDuration > 0) {
            progressInterval = setInterval(() => {
              try {
                const stat = fs.statSync(outPath)
                if (stat.size > 0 && expectedSize > 0) {
                  const pct = Math.min(95, (stat.size / expectedSize) * 100)
                  onProgress(pct)
                }
              } catch {}
            }, 1000)
          }
        })
        .on('progress', (progress: { timemark?: string; targetSize?: number; percent?: number }) => {
          if (onProgress) {
            // Try timemark first
            if (progress.timemark) {
              const parts = progress.timemark.split(':')
              if (parts.length === 3) {
                const sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
                if (totalDuration > 0) {
                  const pct = Math.min(99, Math.max(0, (sec / totalDuration) * 100))
                  onProgress(pct)
                }
              }
            }
            // Estimate expected file size from first progress report
            if (progress.targetSize && progress.targetSize > 0) {
              if (progress.timemark) {
                const parts = progress.timemark.split(':')
                if (parts.length === 3) {
                  const sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
                  if (sec > 0) {
                    expectedSize = (progress.targetSize * 1024 * totalDuration) / sec
                  }
                }
              }
            }
          }
        })
        .save(outPath)
        .on('end', () => {
          if (progressInterval) clearInterval(progressInterval)
          if (onProgress) onProgress(100)
          let size = 0
          try { size = fs.statSync(outPath).size } catch {}
          resolve({ path: outPath, fileName: path.basename(outPath), size, title: info.title, duration: info.duration, startTime, endTime })
        })
        .on('error', (err: Error) => {
          if (progressInterval) clearInterval(progressInterval)
          reject(new Error(`FFmpeg error: ${err.message}`))
        })
    })
  }
}
