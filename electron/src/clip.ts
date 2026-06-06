import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AppConfig } from './types'
import { BilibiliClient, USER_AGENT } from './bilibili'
import { formatSeconds, sanitizeFilename, uniquePath, ensureDir } from './utils'
import { resolveAppPathWithBase } from './config'
import _ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'

function resolveFFmpegPath(): string | null {
  if (!_ffmpegPath) return null
  return _ffmpegPath.replace('app.asar', 'app.asar.unpacked')
}

const ffmpegResolved = resolveFFmpegPath()
if (ffmpegResolved) {
  ffmpeg.setFfmpegPath(ffmpegResolved)
}

export type ClipMode = 'copy' | 'reencode'
export type ClipProgressCallback = (progress: number, message?: string) => void

export class ClipService {
  constructor(
    private config: AppConfig,
    private bilibiliClient: BilibiliClient,
    private baseDir: string,
  ) {}

  public async executeClip(
    rawUrl: string, title: string, startTime: number, endTime: number,
    audioQualityIndex: number = 0, videoQualityIndex: number = 0,
    onProgress?: ClipProgressCallback,
    prefixCut: boolean = true, suffixTime: boolean = true,
    clipMode: ClipMode = 'copy',
  ) {
    if (startTime < 0) startTime = 0
    if (endTime <= startTime) throw new Error('结束时间必须大于开始时间')

    onProgress?.(0, '获取视频信息...')
    const info = await this.bilibiliClient.getBilibiliVideoInfo(rawUrl)
    if (endTime > info.duration) endTime = info.duration
    if (endTime <= startTime) throw new Error(`结束时间(${endTime})必须大于开始时间(${startTime})，视频总时长仅 ${info.duration}s`)

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
    let fileName = safeTitle
    if (prefixCut) fileName = `[cut] ${fileName}`
    if (suffixTime) fileName = `${fileName} (${ts})`
    const outPath = uniquePath(path.join(clipDir, `${fileName}.mp4`))

    const cookie = this.bilibiliClient.cookieHeader()
    const headers = `Referer: https://live.bilibili.com/\r\nUser-Agent: ${USER_AGENT}\r\nCookie: ${cookie}\r\n`

    const totalDuration = endTime - startTime
    console.log(`[clip] Mode: ${clipMode}, Range: ${startTime}→${endTime} (${totalDuration.toFixed(1)}s)`)

    let result: { size: number; message?: string }

    // Both modes download locally first for stability, then process from local file
    const tempDir = path.join(this.config.download.temp_dir, `clip_${Date.now()}`)
    ensureDir(tempDir)
    try {
      if (clipMode === 'copy') {
        result = await this.localCopyCut(videoUrl, audioUrl, headers, startTime, endTime, outPath, tempDir, onProgress)
      } else {
        result = await this.localReencode(videoUrl, audioUrl, headers, startTime, endTime, outPath, tempDir, onProgress)
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }

    return {
      path: outPath, fileName: path.basename(outPath), size: result.size,
      title: info.title, duration: info.duration, startTime, endTime,
      message: result.message,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Mode 1: Copy — download locally then keyframe-aligned copy
  //   Head: aligns to nearest keyframe (may include up to ~5s extra)
  //   Tail: precise (copy can end at any frame)
  // ═══════════════════════════════════════════════════════════════

  private async localCopyCut(
    videoUrl: string, audioUrl: string, headers: string,
    startTime: number, endTime: number, outPath: string,
    tempDir: string, onProgress?: ClipProgressCallback,
  ): Promise<{ size: number; message?: string }> {
    const totalDuration = endTime - startTime
    const PADDING = 15 // seconds before startTime to ensure we capture the keyframe

    // ── Step 1: Download padded clip ──
    const paddedStart = Math.max(0, startTime - PADDING)
    const paddedDuration = totalDuration + PADDING + 15
    const paddedPath = path.join(tempDir, 'padded.mp4')

    onProgress?.(1, '下载中...')
    console.log(`[copy-cut] Step 1: Download padded clip [${paddedStart}s, +${paddedDuration}s]`)
    await this.runFfmpegWithFileProgress(
      [
        ...(videoUrl ? ['-ss', `${paddedStart}`, '-headers', headers, '-i', videoUrl] : []),
        ...(audioUrl ? ['-ss', `${paddedStart}`, '-headers', headers, '-i', audioUrl] : []),
        '-t', `${paddedDuration}`,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y', paddedPath,
      ],
      paddedPath,
      (sizeMB) => onProgress?.(Math.min(49, 1 + sizeMB * 0.3), `下载中... ${sizeMB.toFixed(1)} MB`),
    )

    if (!fs.existsSync(paddedPath) || fs.statSync(paddedPath).size === 0) {
      throw new Error('下载失败：临时文件为空')
    }
    onProgress?.(50, '下载完成，分析关键帧...')

    // ── Step 2: Detect keyframes & compute seek offset ──
    // When ffmpeg uses `-ss` before `-i` with `-c copy`, it seeks to the
    // nearest keyframe BEFORE paddedStart. This means PTS 0 in the file
    // may correspond to a stream time earlier than paddedStart.
    // We compute this offset from the GOP interval so that relStart/relEnd
    // correctly map to the user's selected times.
    const keyframes = await this.findKeyframes(paddedPath)
    const gop = keyframes.length >= 2 ? keyframes[1] - keyframes[0] : 5
    const seekOffset = gop > 0 ? (paddedStart % gop) : 0
    const relStart = (startTime - paddedStart) + seekOffset
    const relEnd = (endTime - paddedStart) + seekOffset

    console.log(`[copy-cut] Keyframes: ${keyframes.length}, GOP=${gop.toFixed(2)}s, seekOffset=${seekOffset.toFixed(2)}s`)
    console.log(`[copy-cut] relStart=${relStart.toFixed(2)}, relEnd=${relEnd.toFixed(2)}`)

    // Find the nearest keyframe at or before relStart
    const KF_TOLERANCE = 0.05
    const kfStart = [...keyframes].reverse().find(kf => kf <= relStart + KF_TOLERANCE) ?? 0
    const startDiff = relStart - kfStart
    // Duration from kfStart to relEnd (tail is precise, head aligns to keyframe)
    const copyDuration = relEnd - kfStart

    console.log(`[copy-cut] kfStart=${kfStart.toFixed(2)}s (${startDiff > 0.1 ? `${startDiff.toFixed(1)}s early` : 'exact'}), copyDuration=${copyDuration.toFixed(1)}s`)

    // ── Step 3: Copy from local file ──
    onProgress?.(55, '流复制中...')
    await this.runFfmpegCommand([
      '-ss', `${kfStart}`,
      '-i', paddedPath,
      '-t', `${copyDuration}`,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', outPath,
    ])

    const actualDuration = await this.probeFileDuration(outPath)
    const msg = startDiff > 0.5
      ? `流复制完成（开头早 ${startDiff.toFixed(1)}s，对齐到关键帧）`
      : '流复制完成'
    console.log(`[copy-cut] Done: actualDuration=${actualDuration.toFixed(1)}s, startDiff=${startDiff.toFixed(1)}s`)
    onProgress?.(100, msg)
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
    return { size, message: msg }
  }

  // ═══════════════════════════════════════════════════════════════
  // Mode 2: Full Re-encode — download locally then re-encode
  //   Frame-accurate start and end, CRF 18 + AAC 512k
  // ═══════════════════════════════════════════════════════════════

  private async localReencode(
    videoUrl: string, audioUrl: string, headers: string,
    startTime: number, endTime: number, outPath: string,
    tempDir: string, onProgress?: ClipProgressCallback,
  ): Promise<{ size: number; message?: string }> {
    const totalDuration = endTime - startTime

    // ── Step 1: Download raw clip (with small padding for seek accuracy) ──
    const paddedStart = Math.max(0, startTime - 5)
    const paddedDuration = totalDuration + 10
    const rawPath = path.join(tempDir, 'raw.mp4')

    onProgress?.(1, '下载中...')
    console.log(`[reencode] Step 1: Download raw clip [${paddedStart}s, +${paddedDuration}s]`)
    await this.runFfmpegWithFileProgress(
      [
        ...(videoUrl ? ['-ss', `${paddedStart}`, '-headers', headers, '-i', videoUrl] : []),
        ...(audioUrl ? ['-ss', `${paddedStart}`, '-headers', headers, '-i', audioUrl] : []),
        '-t', `${paddedDuration}`,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y', rawPath,
      ],
      rawPath,
      (sizeMB) => onProgress?.(Math.min(29, 1 + sizeMB * 0.3), `下载中... ${sizeMB.toFixed(1)} MB`),
    )

    if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
      throw new Error('下载失败：临时文件为空')
    }
    onProgress?.(30, '下载完成，开始编码...')

    // ── Step 2: Re-encode from local file (much faster than from remote) ──
    // Use -ss AFTER -i (output seeking) for frame-accurate start position.
    // Input seeking (-ss before -i) snaps to the nearest keyframe, causing
    // the same PTS offset issue as copy mode.
    const relStart = startTime - paddedStart
    console.log(`[reencode] Step 2: Re-encode from local file, relStart=${relStart.toFixed(2)}s, duration=${totalDuration.toFixed(1)}s`)
    await this.runFfmpegWithEncodingProgress(
      [
        '-i', rawPath,
        '-ss', `${relStart}`,
        '-t', `${totalDuration}`,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
        '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '512k',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-y', outPath,
      ],
      totalDuration,
      (pct, msg) => onProgress?.(30 + pct * 68, `重编码: ${msg}`),
    )

    onProgress?.(100, '重编码完成')
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
    return { size, message: '重编码完成（帧精确）' }
  }


  // ═══════════════════════════════════════════════════════════════
  // FFmpeg Helpers
  // ═══════════════════════════════════════════════════════════════


  private findKeyframes(filePath: string): Promise<number[]> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise<number[]>((resolve, reject) => {
      const proc = spawn(ffmpegBin, [
        '-i', filePath,
        '-vf', 'select=eq(pict_type\\,I),showinfo',
        '-vsync', 'vfr', '-an', '-f', 'null', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      let stderr = ''
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', () => {
        const kfs: number[] = []
        const re = /pts_time:\s*([\d.]+)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(stderr)) !== null) {
          const t = parseFloat(m[1])
          if (Number.isFinite(t)) kfs.push(t)
        }
        kfs.sort((a, b) => a - b)
        resolve(kfs.filter((v, i, a) => i === 0 || Math.abs(v - a[i - 1]) > 0.001))
      })
      proc.on('error', (e) => reject(new Error(`关键帧检测失败: ${e.message}`)))
    })
  }

  /** Probe actual duration of a file via ffmpeg stderr metadata */
  private probeFileDuration(filePath: string): Promise<number> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise<number>((resolve) => {
      const proc = spawn(ffmpegBin, ['-i', filePath, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', () => {
        // Parse "Duration: HH:MM:SS.ms" from metadata
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        if (m) {
          resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100)
        } else {
          resolve(0)
        }
      })
      proc.on('error', () => resolve(0))
    })
  }

  private runFfmpegCommand(args: string[]): Promise<void> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise((resolve, reject) => {
      console.log(`[ffmpeg] ${args.slice(0, 6).join(' ')} ...`)
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[ffmpeg] Exit ${code}:\n${stderr.slice(-500)}`)
          reject(new Error(`FFmpeg 失败 (code ${code}): ${stderr.slice(-300)}`))
        } else resolve()
      })
      proc.on('error', (e) => reject(new Error(`FFmpeg 启动失败: ${e.message}`)))
    })
  }

  /** Run ffmpeg with file-size-based progress polling (for copy-mode ops) */
  private runFfmpegWithFileProgress(
    args: string[], outputPath: string, onSize: (sizeMB: number) => void,
  ): Promise<void> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise((resolve, reject) => {
      console.log(`[ffmpeg] ${args.slice(0, 6).join(' ')} ...`)
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })

      const timer = setInterval(() => {
        try {
          if (fs.existsSync(outputPath)) onSize(fs.statSync(outputPath).size / 1024 / 1024)
        } catch {}
      }, 1000)

      proc.on('close', (code) => {
        clearInterval(timer)
        if (code !== 0) {
          console.error(`[ffmpeg] Exit ${code}:\n${stderr.slice(-500)}`)
          reject(new Error(`FFmpeg 失败 (code ${code}): ${stderr.slice(-300)}`))
        } else resolve()
      })
      proc.on('error', (e) => { clearInterval(timer); reject(new Error(`FFmpeg 启动失败: ${e.message}`)) })
    })
  }

  /** Run ffmpeg with encoding progress parsed from -progress pipe:1 */
  private runFfmpegWithEncodingProgress(
    args: string[], expectedDuration: number,
    onProgress: (pct: number, message: string) => void,
  ): Promise<void> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise((resolve, reject) => {
      console.log(`[ffmpeg] ${args.slice(0, 6).join(' ')} ...`)
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      let buf = ''
      let lastUpdate = 0

      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (t.startsWith('out_time_us=')) {
            const us = parseInt(t.split('=')[1], 10)
            if (Number.isFinite(us) && us > 0 && expectedDuration > 0) {
              const sec = us / 1_000_000
              const pct = Math.min(0.99, sec / expectedDuration)
              const now = Date.now()
              if (now - lastUpdate >= 500) {
                lastUpdate = now
                onProgress(pct, `${sec.toFixed(1)}s / ${expectedDuration.toFixed(1)}s`)
              }
            }
          }
        }
      })

      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[ffmpeg] Exit ${code}:\n${stderr.slice(-500)}`)
          reject(new Error(`FFmpeg 编码失败 (code ${code}): ${stderr.slice(-300)}`))
        } else resolve()
      })
      proc.on('error', (e) => reject(new Error(`FFmpeg 启动失败: ${e.message}`)))
    })
  }
}
