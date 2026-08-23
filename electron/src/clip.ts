import fs from 'node:fs'

import path from 'node:path'
import { spawn } from 'node:child_process'
import { AppConfig } from './types'
import { BilibiliClient, USER_AGENT } from './bilibili'
import {
  CLIP_TEMP_SENTINEL,
  CLIP_TEMP_SENTINEL_CONTENT,
  ensureDir,
  fileMatchesIdentity,
  formatSeconds,
  publishFileWithRetry,
  removeFileWithRetry,
  removePathWithRetry,
  sanitizeFilename,
  tryReadDirectoryIdentity,
  tryReadFileIdentity,
  uniquePath,
} from './utils'
import { resolveAppPathWithBase } from './config'
import _ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import { parseFile } from 'music-metadata'

function resolveFFmpegPath(): string | null {
  if (!_ffmpegPath) return null
  return _ffmpegPath.replace('app.asar', 'app.asar.unpacked')
}

const ffmpegResolved = resolveFFmpegPath()
if (ffmpegResolved) {
  ffmpeg.setFfmpegPath(ffmpegResolved)
}

export type ClipMode = 'copy' | 'reencode' | 'smart'
export type ClipProgressCallback = (progress: number, message?: string) => void
export type ClipQualitySelection = {
  audioId?: number
  audioCodec?: string
  videoId?: number
  videoCodec?: string
}

export type ClipOutputLifecycle = {
  onReserved?: (paths: { outPath: string; partPath: string; identity?: string }) => void | Promise<void>
  onBuilt?: (paths: { outPath: string; partPath: string; identity?: string }) => void | Promise<void>
  onVerified?: (paths: { outPath: string; partPath: string; identity?: string }) => void | Promise<void>
  onPublished?: (paths: { outPath: string; partPath: string; sourceRemoved: boolean; identity?: string }) => void | Promise<void>
}

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

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
    clipMode: ClipMode = 'copy', signal?: AbortSignal,
    qualitySelection?: ClipQualitySelection,
    outputLifecycle?: ClipOutputLifecycle,
  ) {
    throwIfAborted(signal)
    if (startTime < 0) startTime = 0
    if (endTime <= startTime) throw new Error('结束时间必须大于开始时间')

    onProgress?.(0, '获取视频信息...')
    const info = await this.bilibiliClient.getBilibiliVideoInfo(rawUrl, signal)
    throwIfAborted(signal)
    if (endTime > info.duration) endTime = info.duration
    if (endTime <= startTime) throw new Error(`结束时间(${endTime})必须大于开始时间(${startTime})，视频总时长仅 ${info.duration}s`)

    // Use the exact, already-normalized quality list returned to the UI. A
    // second playurl request can be downgraded or ordered differently, making
    // the submitted indexes select another stream (or no stream at all).
    const audioQualities = info.qualities?.audio || []
    const videoQualities = info.qualities?.video || []
    const selectedAudio = qualitySelection?.audioId !== undefined
      ? audioQualities.find(quality => quality.id === qualitySelection.audioId
          && (!qualitySelection.audioCodec || quality.codecs === qualitySelection.audioCodec))
      : (audioQualities[audioQualityIndex] || audioQualities[0])
    const selectedVideo = qualitySelection?.videoId !== undefined
      ? videoQualities.find(quality => quality.id === qualitySelection.videoId
          && (!qualitySelection.videoCodec || quality.codecs === qualitySelection.videoCodec))
      : (videoQualities[videoQualityIndex] || videoQualities[0])
    if (qualitySelection?.audioId !== undefined && !selectedAudio) {
      throw new Error('所选音频质量已不可用，请刷新视频信息后重试')
    }
    if (qualitySelection?.videoId !== undefined && !selectedVideo) {
      throw new Error('所选视频质量已不可用，请刷新视频信息后重试')
    }
    const audioUrl = selectedAudio?.baseUrl || info.audioUrl
    const videoUrl = selectedVideo?.baseUrl || ''
    const videoCodec = selectedVideo?.codecs || ''
    if (!videoUrl) throw new Error('此视频没有提供可用的 DASH 视频流')

    const clipDir = resolveAppPathWithBase(this.baseDir, this.config.download.clip_output_dir || path.join(this.config.download.output_dir, 'clips'))
    ensureDir(clipDir)
    let fileName = title || info.title || 'clip'
    const ts = `${formatSeconds(startTime)}-${formatSeconds(endTime)}`.replace(/:/g, '-')
    if (prefixCut) fileName = `[cut] ${fileName}`
    if (suffixTime) fileName = `${fileName} (${ts})`
    fileName = sanitizeFilename(fileName)
    const desiredPath = path.join(clipDir, `${fileName}.mp4`)

    const cookie = this.bilibiliClient.cookieHeader()
    const headers = `Referer: https://live.bilibili.com/\r\nUser-Agent: ${USER_AGENT}\r\nCookie: ${cookie}\r\n`

    const totalDuration = endTime - startTime
    const effectiveMode = this.resolveClipMode(clipMode, videoCodec)
    const smartFallbackMessage = clipMode === 'smart' && effectiveMode === 'reencode'
      ? `智能无损不支持所选视频编码 ${videoCodec}，已自动使用完整重编码`
      : ''
    console.log(`[clip] Mode: ${clipMode}${effectiveMode !== clipMode ? ` -> ${effectiveMode} (${videoCodec})` : ''}, Range: ${startTime}→${endTime} (${totalDuration.toFixed(1)}s)`)

    let result: { size: number; message?: string }

    // Both modes download locally first for stability, then process from local file
    const tempRoot = resolveAppPathWithBase(this.baseDir, this.config.download.temp_dir)
    ensureDir(tempRoot)
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'clip-'))
    fs.writeFileSync(
      path.join(tempDir, CLIP_TEMP_SENTINEL),
      CLIP_TEMP_SENTINEL_CONTENT,
      { flag: 'wx' },
    )
    const tempDirIdentity = tryReadDirectoryIdentity(tempDir)
    let outPath = ''
    let partPath = ''
    let partIdentity = ''
    let outputBuilt = false
    let outputVerified = false
    let outputPublished = false
    let retainedPartPath = ''
    try {
      ;({ outPath, partPath } = this.reserveOutputPath(desiredPath))
      partIdentity = tryReadFileIdentity(partPath)
      if (!partIdentity) throw new Error(`Cannot verify reserved clip output ownership: ${partPath}`)
      await outputLifecycle?.onReserved?.({ outPath, partPath, identity: partIdentity })
      if (effectiveMode === 'smart') {
        result = await this.localSmartCut(videoUrl, audioUrl, headers, startTime, endTime, partPath, tempDir, onProgress, signal)
      } else if (effectiveMode === 'copy') {
        result = await this.localCopyCut(videoUrl, audioUrl, headers, startTime, endTime, partPath, tempDir, onProgress, signal)
      } else {
        result = await this.localReencode(videoUrl, audioUrl, headers, startTime, endTime, partPath, tempDir, onProgress, signal)
      }
      if (smartFallbackMessage) {
        result.message = result.message ? `${smartFallbackMessage}；${result.message}` : smartFallbackMessage
      }
      throwIfAborted(signal)
      if (!fs.existsSync(partPath) || fs.statSync(partPath).size === 0) {
        throw new Error('Clip failed: output file is empty')
      }
      if (!fileMatchesIdentity(partPath, partIdentity)) {
        throw Object.assign(
          new Error(`Reserved clip output path was replaced; the foreign file was preserved: ${partPath}`),
          { code: 'EOWNERSHIP' },
        )
      }
      outputBuilt = true
      await outputLifecycle?.onBuilt?.({ outPath, partPath, identity: partIdentity })
      onProgress?.(99, '校验切片输出...')
      await this.verifyClipOutput(partPath, totalDuration, effectiveMode, signal)
      throwIfAborted(signal)
      outputVerified = true
      await outputLifecycle?.onVerified?.({ outPath, partPath, identity: partIdentity })
      const outputSize = fs.statSync(partPath).size
      const publishResult = await publishFileWithRetry(partPath, outPath, {
        signal,
        requireAtomicNoClobber: true,
        deferSourceCleanup: true,
        expectedSourceIdentity: partIdentity,
        onRetry: ({ retry, maxRetries }) => {
          if (retry === 1 || retry === maxRetries || retry % 3 === 0) {
            onProgress?.(99, `输出文件暂时被占用，正在重试保存（${retry}/${maxRetries}）...`)
          }
        },
      })
      outputPublished = true
      await outputLifecycle?.onPublished?.({
        outPath,
        partPath,
        sourceRemoved: false,
        identity: partIdentity,
      })
      let sourceRemoved = publishResult.sourceRemoved
      if (publishResult.cleanupDeferred) {
        try {
          await removeFileWithRetry(partPath, { expectedIdentity: partIdentity })
          sourceRemoved = true
        } catch (cleanupError) {
          console.error(`[clip] Published output retained a locked working link ${partPath}:`, cleanupError)
        }
      }
      retainedPartPath = sourceRemoved ? '' : partPath
      partPath = ''
      result.size = outputSize
    } catch (err) {
      if (partPath) {
        if (outputVerified || outputBuilt) {
          const error = err instanceof Error ? err : new Error(String(err))
          throw Object.assign(error, {
            recoverablePath: fs.existsSync(partPath) ? partPath : '',
            publishedPath: outputPublished && outPath && fs.existsSync(outPath) ? outPath : '',
          })
        } else {
          try {
            await removeFileWithRetry(partPath, { expectedIdentity: partIdentity })
          } catch (cleanupError) {
            console.error(`[clip] Failed to remove working file ${partPath}:`, cleanupError)
            const error = err instanceof Error ? err : new Error(String(err))
            throw Object.assign(error, { cleanupPath: partPath })
          }
        }
      }
      throw err
    } finally {
      try {
        await removePathWithRetry(tempDir, {
          recursive: true,
          expectedDirectoryIdentity: tempDirIdentity,
        })
      } catch (cleanupError) {
        console.error(`[clip] Failed to remove temporary working directory ${tempDir}:`, cleanupError)
      }
    }

    return {
      path: outPath, fileName: path.basename(outPath), size: result.size,
      workingPath: retainedPartPath,
      identity: partIdentity,
      title: info.title, duration: info.duration, startTime, endTime,
      message: result.message,
    }
  }

  private resolveClipMode(requestedMode: ClipMode, videoCodec: string): ClipMode {
    if (requestedMode !== 'smart') return requestedMode
    const normalizedCodec = videoCodec.trim().toLowerCase()
    if (!normalizedCodec) return requestedMode
    return normalizedCodec.includes('avc1')
      || normalizedCodec.includes('avc3')
      || normalizedCodec.includes('h264')
      ? requestedMode
      : 'reencode'
  }

  private reserveOutputPath(desiredPath: string): { outPath: string; partPath: string } {
    let outPath = uniquePath(desiredPath)
    for (let suffix = 1; ; suffix += 1) {
      if (fs.existsSync(outPath)) {
        const ext = path.extname(desiredPath)
        const stem = desiredPath.slice(0, -ext.length)
        outPath = `${stem} (${suffix})${ext}`
        continue
      }
      const outputExt = path.extname(outPath)
      const partPath = `${outPath.slice(0, -outputExt.length)}.part${outputExt}`
      try {
        const fd = fs.openSync(partPath, 'wx')
        fs.closeSync(fd)
        return { outPath, partPath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const ext = path.extname(desiredPath)
        const stem = desiredPath.slice(0, -ext.length)
        outPath = `${stem} (${suffix})${ext}`
      }
    }
  }

  private async verifyClipOutput(
    filePath: string,
    expectedDuration: number,
    mode: ClipMode,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal)
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('Clip output verification failed: output is not a non-empty file')
    }

    let metadata: Awaited<ReturnType<typeof parseFile>>
    try {
      metadata = await parseFile(filePath)
    } catch (error) {
      throw new Error(
        `Clip output verification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    throwIfAborted(signal)

    const tracks = metadata.format.trackInfo || []
    const hasVideo = metadata.format.hasVideo === true || tracks.some(track => Boolean(track.video))
    const hasAudio = metadata.format.hasAudio === true || tracks.some(track => Boolean(track.audio))
    if (!hasVideo || !hasAudio) {
      throw new Error(
        `Clip output verification failed: missing ${!hasVideo && !hasAudio ? 'video and audio' : !hasVideo ? 'video' : 'audio'} stream`,
      )
    }

    const actualDuration = Number(metadata.format.duration || 0)
    if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
      throw new Error('Clip output verification failed: duration is unavailable')
    }
    const durationMargin = mode === 'copy'
      ? Math.max(5, Math.min(15, expectedDuration * 0.02))
      : Math.max(1, Math.min(5, expectedDuration * 0.02))
    if (Math.abs(actualDuration - expectedDuration) > durationMargin) {
      throw new Error(
        `Clip output verification failed: expected ${expectedDuration.toFixed(1)}s, got ${actualDuration.toFixed(1)}s`,
      )
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
    tempDir: string, onProgress?: ClipProgressCallback, signal?: AbortSignal
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
      signal,
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
    const keyframes = await this.findKeyframes(paddedPath, signal)
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
    ], signal)

    const actualDuration = await this.probeFileDuration(outPath, signal)
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
    tempDir: string, onProgress?: ClipProgressCallback, signal?: AbortSignal
  ): Promise<{ size: number; message?: string }> {
    const totalDuration = endTime - startTime
    const PADDING = 15

    // ── Step 1: Download raw clip (with padding for seek accuracy) ──
    const paddedStart = Math.max(0, startTime - PADDING)
    const paddedDuration = totalDuration + PADDING + 10
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
      signal,
    )

    if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
      throw new Error('下载失败：临时文件为空')
    }
    onProgress?.(30, '下载完成，分析关键帧...')

    // ── Step 2: Compute seek offset from GOP ──
    // Measure where the requested seek point landed on the shared local A/V
    // clock. A GOP modulo estimate is invalid for phased or variable GOPs.
    const keyframes = await this.findKeyframes(rawPath, signal)
    const gop = keyframes.length >= 2 ? keyframes[1] - keyframes[0] : 5
    const audioTimelineStart = audioUrl
      ? await this.probeFirstAudioPacketTimestamp(rawPath, signal)
      : null
    const seekOffset = audioTimelineStart ?? (gop > 0 ? (paddedStart % gop) : 0)
    const relStart = (startTime - paddedStart) + seekOffset

    console.log(`[reencode] GOP=${gop.toFixed(2)}s, seekOffset=${seekOffset.toFixed(2)}s, relStart=${relStart.toFixed(2)}s`)

    // ── Step 3: Re-encode from local file ──
    // Use -ss AFTER -i (output seeking) for frame-accurate start position.
    onProgress?.(35, '重编码中...')
    console.log(`[reencode] Step 3: Re-encode, relStart=${relStart.toFixed(2)}s, duration=${totalDuration.toFixed(1)}s`)
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
      (pct, msg) => onProgress?.(35 + pct * 63, `重编码: ${msg}`),
      signal,
    )

    onProgress?.(100, '重编码完成')
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
    return { size, message: '重编码完成（帧精确）' }
  }


  // ═══════════════════════════════════════════════════════════════
  // Mode 3: Smart Cut — Frame-accurate cuts with no re-encoding of body
  // ═══════════════════════════════════════════════════════════════

  private async localSmartCut(
    videoUrl: string, audioUrl: string, headers: string,
    startTime: number, endTime: number, outPath: string,
    tempDir: string, onProgress?: ClipProgressCallback, signal?: AbortSignal
  ): Promise<{ size: number; message?: string }> {
    const totalDuration = endTime - startTime
    const PADDING = 15

    // ── Step 1: Download raw clip ──
    const paddedStart = Math.max(0, startTime - PADDING)
    const paddedDuration = totalDuration + PADDING + 10
    const rawVideoPath = path.join(tempDir, 'raw.mp4')
    
    onProgress?.(1, '下载中...')
    console.log(`[smart] Step 1: Download raw A/V clip [${paddedStart}s, +${paddedDuration}s]`)
    await this.runFfmpegWithFileProgress(
      [
        ...(videoUrl ? ['-ss', `${paddedStart}`, '-headers', headers, '-i', videoUrl] : []),
        ...(audioUrl ? ['-ss', `${paddedStart}`, '-headers', headers, '-i', audioUrl] : []),
        '-t', `${paddedDuration}`,
        '-map', '0:v:0',
        '-map', audioUrl ? '1:a:0' : '0:a:0?',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y', rawVideoPath,
      ],
      rawVideoPath,
      (sizeMB) => onProgress?.(Math.min(29, 1 + sizeMB * 0.3), `下载视频... ${sizeMB.toFixed(1)} MB`),
      signal
    )

    if (!fs.existsSync(rawVideoPath) || fs.statSync(rawVideoPath).size === 0) {
      throw new Error('下载失败：视频临时文件为空')
    }

    // ── Step 2: Extract Keyframes ──
    onProgress?.(30, '分析关键帧...')
    const keyframes = await this.findKeyframes(rawVideoPath, signal)
    const gop = keyframes.length >= 2 ? keyframes[1] - keyframes[0] : 5
    const audioTimelineStart = audioUrl
      ? await this.probeFirstAudioPacketTimestamp(rawVideoPath, signal)
      : null
    const seekOffset = audioTimelineStart ?? (gop > 0 ? (paddedStart % gop) : 0)
    
    // Convert absolute user time to relative time in our padded raw file
    const relStart = (startTime - paddedStart) + seekOffset
    const relEnd = (endTime - paddedStart) + seekOffset

    // Find bounding keyframes for the body
    const KF_TOLERANCE = 0.05
    let k1 = keyframes.find(kf => kf >= relStart - KF_TOLERANCE)
    let k2 = [...keyframes].reverse().find(kf => kf <= relEnd + KF_TOLERANCE)
    
    if (k1 === undefined) k1 = relEnd
    if (k2 === undefined) k2 = relStart

    console.log(`[smart] relStart=${relStart.toFixed(2)}, k1=${k1.toFixed(2)}, k2=${k2.toFixed(2)}, relEnd=${relEnd.toFixed(2)}`)

    const tsFiles: string[] = []
    
    // We will use standard H.264 matching parameters for re-encoding head and tail
    const reencodeFlags = [
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
      '-vsync', '1', '-async', '1',
      // Very important to make the TS files concatenable without glitches
      '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts'
    ]
    
    // Is the clip too short to have a body?
    if (k2 <= k1) {
      console.log(`[smart] Clip too short or no keyframes inside, full re-encode used.`)
      const headTs = path.join(tempDir, 'head.ts')
      onProgress?.(40, '重编码纯视频...')
      await this.runFfmpegWithEncodingProgress(
        ['-i', rawVideoPath, '-ss', `${relStart}`, '-t', `${totalDuration}`, '-an', ...reencodeFlags, '-y', headTs],
        totalDuration,
        (pct, msg) => onProgress?.(40 + pct * 20, `重编码: ${msg}`),
        signal
      )
      tsFiles.push(headTs)
    } else {
      // ── Head ──
      if (k1 > relStart + 0.1) {
        const headDur = k1 - relStart
        const headTs = path.join(tempDir, 'head.ts')
        console.log(`[smart] Head: ${relStart.toFixed(2)} -> ${k1.toFixed(2)} (${headDur.toFixed(2)}s)`)
        onProgress?.(40, '重编码头部视频...')
        await this.runFfmpegWithEncodingProgress(
          ['-i', rawVideoPath, '-ss', `${relStart}`, '-t', `${headDur}`, '-an', ...reencodeFlags, '-y', headTs],
          headDur,
          (pct, msg) => onProgress?.(40 + pct * 5, `重编码头: ${msg}`),
          signal
        )
        tsFiles.push(headTs)
      }

      // ── Body ──
      const bodyDur = k2 - k1
      if (bodyDur > 0) {
        const bodyTs = path.join(tempDir, 'body.ts')
        const segPattern = path.join(tempDir, 'seg_body_%03d.ts')
        console.log(`[smart] Body: ${k1.toFixed(2)} -> ${k2.toFixed(2)} (${bodyDur.toFixed(2)}s)`)
        onProgress?.(50, '流复制中间视频...')
        const safeBodyDur = Math.max(0.1, bodyDur - 0.05).toFixed(4)
        await this.runFfmpegCommand(
          [
            '-y',
            '-ss', `${k1}`,
            '-i', rawVideoPath,
            '-f', 'segment',
            '-segment_times', safeBodyDur,
            '-an',
            '-c:v', 'copy',
            '-bsf:v', 'h264_mp4toannexb',
            '-reset_timestamps', '1',
            segPattern
          ],
          signal
        )
        // Rename the first segment to bodyTs
        await publishFileWithRetry(
          path.join(tempDir, 'seg_body_000.ts'),
          bodyTs,
          { signal, useHardLink: false },
        )
        tsFiles.push(bodyTs)
      }

      // ── Tail ──
      if (relEnd > k2 + 0.1) {
        const tailDur = relEnd - k2
        const tailTs = path.join(tempDir, 'tail.ts')
        console.log(`[smart] Tail: ${k2.toFixed(2)} -> ${relEnd.toFixed(2)} (${tailDur.toFixed(2)}s)`)
        onProgress?.(60, '重编码尾部视频...')
        await this.runFfmpegWithEncodingProgress(
          ['-ss', `${k2}`, '-i', rawVideoPath, '-t', `${tailDur}`, '-an', ...reencodeFlags, '-y', tailTs],
          tailDur,
          (pct, msg) => onProgress?.(60 + pct * 5, `重编码尾: ${msg}`),
          signal
        )
        tsFiles.push(tailTs)
      }
    }

    // ── Step 3: Concat Video ──
    onProgress?.(70, '合并视频段...')
    const concatVideoPath = path.join(tempDir, 'concat_video.mp4')
    const tsList = tsFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n')
    const listPath = path.join(tempDir, 'list.txt')
    fs.writeFileSync(listPath, tsList)
    
    await this.runFfmpegCommand([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-y', concatVideoPath
    ], signal)

    // ── Step 4: Extract Audio Global ──
    onProgress?.(80, '提取原始音频轨...')
    // Keep audio on the exact local timeline used to build the video. Cutting
    // the remote audio independently loses the video keyframe seek pre-roll.
    const audioPath = path.join(tempDir, 'audio.m4a')
    await this.runFfmpegWithFileProgress(
      [
        '-i', rawVideoPath,
        '-ss', `${relStart}`,
        '-t', `${totalDuration}`,
        '-map', '0:a:0',
        '-c:a', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y', audioPath
      ],
      audioPath,
      (sizeMB) => onProgress?.(Math.min(94, 80 + sizeMB * 5), `提取音频: ${sizeMB.toFixed(1)} MB`),
      signal
    )

    // ── Step 5: Final Mux ──
    onProgress?.(95, '最终合成混流...')
    await this.runFfmpegCommand([
      '-i', concatVideoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c', 'copy',
      '-shortest',
      '-movflags', '+faststart',
      '-y', outPath
    ], signal)

    onProgress?.(100, '智能无损切片完成')
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
    return { size, message: '智能极速完成（帧精确+原画质）' }
  }


  // ═══════════════════════════════════════════════════════════════
  // FFmpeg Helpers
  // ═══════════════════════════════════════════════════════════════


  private findKeyframes(filePath: string, signal?: AbortSignal): Promise<number[]> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise<number[]>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const proc = spawn(ffmpegBin, [
        '-i', filePath,
        '-vf', 'select=eq(pict_type\\,I),showinfo',
        '-vsync', 'vfr', '-an', '-f', 'null', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

      let stderr = ''
      let settled = false
      const finish = (error?: Error, keyframes?: number[]) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(keyframes || [])
      }
      const onAbort = () => {
        proc.kill('SIGTERM')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', () => {
        if (signal?.aborted) {
          finish(abortError())
          return
        }
        const kfs: number[] = []
        const re = /pts_time:\s*([\d.]+)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(stderr)) !== null) {
          const t = parseFloat(m[1])
          if (Number.isFinite(t)) kfs.push(t)
        }
        kfs.sort((a, b) => a - b)
        finish(undefined, kfs.filter((v, i, a) => i === 0 || Math.abs(v - a[i - 1]) > 0.001))
      })
      proc.on('error', (e) => finish(new Error(`关键帧检测失败: ${e.message}`)))
    })
  }

  /**
   * Return the first audio packet PTS without letting FFmpeg normalize the
   * input timestamps. During a fast input seek the video begins at an earlier
   * keyframe, while this audio packet stays close to the requested seek time;
   * its local PTS is therefore the measured pre-roll on the shared A/V clock.
   */
  private probeFirstAudioPacketTimestamp(filePath: string, signal?: AbortSignal): Promise<number | null> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise<number | null>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const proc = spawn(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-copyts',
        '-i', filePath,
        '-map', '0:a:0', '-frames:a', '1', '-c:a', 'copy',
        '-f', 'framehash', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

      let stdout = ''
      let settled = false
      const finish = (value: number | null, error?: Error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = () => {
        proc.kill('SIGTERM')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.on('close', (code) => {
        if (signal?.aborted) {
          finish(null, abortError())
          return
        }
        if (code !== 0) {
          finish(null)
          return
        }

        const timeBase = stdout.match(/^#tb\s+0:\s*(-?\d+)\/(\d+)\s*$/m)
        const packet = stdout.match(/^\s*\d+\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,/m)
        if (!timeBase || !packet) {
          finish(null)
          return
        }

        const numerator = Number(timeBase[1])
        const denominator = Number(timeBase[2])
        const pts = Number(packet[2])
        const seconds = pts * numerator / denominator
        finish(Number.isFinite(seconds) ? seconds : null)
      })
      proc.on('error', () => finish(null))
    })
  }

  /** Probe actual duration of a file via ffmpeg stderr metadata */
  private probeFileDuration(filePath: string, signal?: AbortSignal): Promise<number> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise<number>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const proc = spawn(ffmpegBin, ['-i', filePath, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      let settled = false
      const finish = (value: number, error?: Error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = () => {
        proc.kill('SIGTERM')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', () => {
        if (signal?.aborted) {
          finish(0, abortError())
          return
        }
        // Parse "Duration: HH:MM:SS.ms" from metadata
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        if (m) {
          finish(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100)
        } else {
          finish(0)
        }
      })
      proc.on('error', () => finish(0))
    })
  }

  private runFfmpegCommand(args: string[], signal?: AbortSignal): Promise<void> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    
    const run = (extraArgs: string[]) => {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        let finalArgs = [...args]
        if (extraArgs.length > 0) {
          const outPath = finalArgs.pop()!
          const dashY = finalArgs.pop()!
          if (dashY === '-y') {
            finalArgs = [...finalArgs, ...extraArgs, '-y', outPath]
          } else {
            finalArgs = [...finalArgs, dashY, ...extraArgs, outPath]
          }
        }
        
        console.log(`[ffmpeg] ${finalArgs.slice(0, 6).join(' ')} ...`)
        const proc = spawn(ffmpegBin, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stderr = ''
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve()
        }
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })

        const onAbort = () => {
          proc.kill('SIGTERM')
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        proc.on('close', (code) => {
          if (signal?.aborted) {
            finish(abortError())
            return
          }
          if (code !== 0) {
            console.error(`[ffmpeg] Exit ${code}:\n${stderr.slice(-500)}`)
            finish(new Error(`FFmpeg 失败 (code ${code}): ${stderr.slice(-300)}`))
          } else finish()
        })
        proc.on('error', (e) => {
          finish(new Error(`FFmpeg 启动失败: ${e.message}`))
        })
      })
    }

    return run([]).catch(err => {
      if (!signal?.aborted && err instanceof Error && err.message.includes('tag for codec hevc')) {
        return run(['-tag:v', 'hvc1'])
      }
      throw err
    })
  }

  /** Run ffmpeg with file-size-based progress polling (for copy-mode ops) */
  private runFfmpegWithFileProgress(
    args: string[], outputPath: string, onSize: (sizeMB: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    
    const run = (extraArgs: string[]) => {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        let finalArgs = [...args]
        if (extraArgs.length > 0) {
          const outPath = finalArgs.pop()!
          const dashY = finalArgs.pop()!
          if (dashY === '-y') {
            finalArgs = [...finalArgs, ...extraArgs, '-y', outPath]
          } else {
            finalArgs = [...finalArgs, dashY, ...extraArgs, outPath]
          }
        }

        console.log(`[ffmpeg] ${finalArgs.slice(0, 6).join(' ')} ...`)
        const proc = spawn(ffmpegBin, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stderr = ''
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearInterval(timer)
          signal?.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve()
        }
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })

        const timer = setInterval(() => {
          if (signal?.aborted || settled) return
          try {
            if (fs.existsSync(outputPath)) onSize(fs.statSync(outputPath).size / 1024 / 1024)
          } catch {}
        }, 1000)

        const onAbort = () => {
          proc.kill('SIGTERM')
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        proc.on('close', (code) => {
          if (signal?.aborted) {
            finish(abortError())
            return
          }
          if (code !== 0) {
            console.error(`[ffmpeg] Exit ${code}:\n${stderr.slice(-500)}`)
            finish(new Error(`FFmpeg 失败 (code ${code}): ${stderr.slice(-300)}`))
          } else finish()
        })
        proc.on('error', (e) => { 
          finish(new Error(`FFmpeg 启动失败: ${e.message}`))
        })
      })
    }

    return run([]).catch(err => {
      if (!signal?.aborted && err instanceof Error && err.message.includes('tag for codec hevc')) {
        return run(['-tag:v', 'hvc1'])
      }
      throw err
    })
  }

  /** Run ffmpeg with encoding progress parsed from -progress pipe:1 */
  private runFfmpegWithEncodingProgress(
    args: string[], expectedDuration: number,
    onProgress: (pct: number, message: string) => void, signal?: AbortSignal
  ): Promise<void> {
    const ffmpegBin = ffmpegResolved || 'ffmpeg'
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      console.log(`[ffmpeg] ${args.slice(0, 6).join(' ')} ...`)
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      let buf = ''
      let lastUpdate = 0
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        if (signal?.aborted || settled) return
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

      const onAbort = () => {
        proc.kill('SIGTERM')
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('close', (code) => {
        if (signal?.aborted) {
          finish(abortError())
          return
        }
        if (code !== 0) {
          console.error(`[ffmpeg] Exit ${code}:\n${stderr.slice(-500)}`)
          finish(new Error(`FFmpeg 编码失败 (code ${code}): ${stderr.slice(-300)}`))
        } else finish()
      })
      proc.on('error', (e) => {
        finish(new Error(`FFmpeg 启动失败: ${e.message}`))
      })
    })
  }
}
