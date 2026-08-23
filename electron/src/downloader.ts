import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { AppConfig, ReplayRecord, ReplayPatch, M3U8Segment, FileInfo } from './types'
import { SqliteStore } from './db'
import { BilibiliClient } from './bilibili'
import {
  fileMatchesIdentity,
  formatSeconds,
  publishFileWithRetry,
  removeFileWithRetry,
  removePathWithRetry,
  REPLAY_TEMP_SENTINEL,
  renderFilenameTemplate,
  replayTempSentinelContent,
  tryReadDirectoryIdentity,
  tryReadFileIdentity,
} from './utils'
import { spawn } from 'node:child_process'
import _ffmpegPath from 'ffmpeg-static'
import { parseFile } from 'music-metadata'

const PROGRESS_UPDATE_INTERVAL_MS = 250
const RECOVERABLE_PART_MIN_AGE_MS = 30_000
const MERGE_IN_PROGRESS_RECOVERY_MESSAGE = 'Merging all segments (recovery protected)...'
const TRANSIENT_VALIDATION_CODES = new Set(['EBUSY', 'EACCES', 'EPERM'])

function recoverablePartError(
  message: string,
  sourcePath: string,
  destinationPath: string,
  code = 'ERECOVERABLE',
) {
  return Object.assign(
    new Error(`${message}；${code} rename '${sourcePath}' -> '${destinationPath}'`),
    { code, sourcePath, destinationPath },
  )
}

function workingLinkCleanupError(
  sourcePath: string,
  destinationPath: string,
  cleanupError?: NodeJS.ErrnoException,
) {
  return recoverablePartError(
    '最终文件已经安全发布，但临时文件名仍被占用；请稍后重试，程序会继续清理而不会重新下载',
    sourcePath,
    destinationPath,
    cleanupError?.code || 'EBUSY',
  )
}

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
    recoverablePartPath?: string,
  ) {
    let finalPath = ''
    let partPath = ''
    let renamed = false
    let committed = false
    let freshCacheCreated = false
    let recoverableOutputTracked = Boolean(recoverablePartPath)
    let publishedOutputTracked = false
    let workingPartIdentity = ''
    try {
      let replay = this.db.getReplaySummaryByLiveKey(baseDir, liveKey)
      if (!replay) return

      this.patchActiveReplay(liveKey, ['pending'], { status: 'pending', message: 'Checking completed working files...' }, signal, isCurrent)
      this.emitProgress({ live_key: liveKey, status: 'pending' })
      await this.cleanupTrackedPartialReplay(replay, baseDir, signal, isCurrent)
      replay = this.db.getReplaySummaryByLiveKey(baseDir, liveKey) || replay
      const recovered = await this.tryRecoverCompletedPart(
        replay,
        replay.recoverable_part_path || recoverablePartPath,
        baseDir,
        signal,
        isCurrent,
      )
      if (recovered) {
        finalPath = recovered.finalPath
        renamed = true
        publishedOutputTracked = true
        this.db.deleteReplayStreamCache(liveKey, true)
        if (recovered.completedWithCleanupDebt) {
          committed = true
          this.emitProgress({ live_key: liveKey, status: 'completed' })
          return
        }
        this.patchActiveReplay(liveKey, ['pending'], {
          file_path: recovered.finalPath,
          recoverable_part_path: '',
          recoverable_state: '',
          cleanup_part_path: '',
          cleanup_part_identity: '',
          file_size: recovered.fileInfo.size,
          resolution: recovered.fileInfo.resolution,
          bitrate: recovered.fileInfo.bitrate,
          progress: 100,
          speed: '',
          elapsed: replay.elapsed,
          eta: '',
          status: 'completed',
          message: 'Recovered completed download without downloading again',
          verify_ok: true,
          actual_duration: recovered.actualDuration,
        }, signal, isCurrent)
        committed = true
        this.emitProgress({ live_key: liveKey, status: 'completed' })
        return
      }

      this.patchActiveReplay(liveKey, ['pending'], {
        file_path: '',
        recoverable_part_path: '',
        recoverable_state: '',
        cleanup_part_path: '',
        output_identity: '',
        cleanup_part_identity: '',
        file_size: 0,
        resolution: '',
        bitrate: '',
        verify_ok: false,
        actual_duration: 0,
        message: 'Fetching stream list...',
      }, signal, isCurrent)
      recoverableOutputTracked = false
      this.emitProgress({ live_key: liveKey, status: 'pending' })
      await this.bilibiliClient.cacheReplayM3U8(replay, signal)
      freshCacheCreated = true
      this.assertActive(signal, isCurrent)

      replay = this.db.getReplayByLiveKey(baseDir, liveKey)
      if (!replay || replay.streams.length === 0) {
        throw new Error('No streams found for replay')
      }

      // The complete slice set is now held by this task. Keeping the (often
      // multi-megabyte) playlists in SQLite for the whole download makes every
      // sql.js snapshot unnecessarily large. Resume/retry always fetches a
      // fresh set, so the persistent cache can be released immediately.
      this.db.deleteReplayStreamCache(liveKey, true)
      freshCacheCreated = false

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
      workingPartIdentity = output.partIdentity
      recoverableOutputTracked = true
      if (!workingPartIdentity || !fileMatchesIdentity(partPath, workingPartIdentity)) {
        throw Object.assign(
          new Error(`Completed replay output ownership changed; the replacement was preserved: ${partPath}`),
          { code: 'EOWNERSHIP' },
        )
      }
      this.assertActive(signal, isCurrent)
      const targetReplay = this.db.getReplaySummaryByLiveKey(baseDir, liveKey) || replay

      this.patchActiveReplay(liveKey, ['merging'], { message: 'Verifying duration...' }, signal, isCurrent)
      this.emitProgress({ live_key: liveKey, status: 'merging' })
      let actualDuration = 0
      try {
        const verified = await this.verifyDuration(partPath, targetReplay.duration)
        actualDuration = verified.duration
        if (!verified.ok) {
          throw new Error(
            `Replay duration verification failed: expected ${targetReplay.duration}s, got ${actualDuration.toFixed(1)}s`,
          )
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Replay duration verification failed:')) {
          throw error
        }
        throw new Error(
          `Replay duration verification failed: ${error instanceof Error ? error.message : String(error)}`,
        )
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

      // Claim the verified working file before publication. This closes the
      // pause/delete/restart window between publishing the final directory
      // entry and committing the completed row.
      this.patchActiveReplay(liveKey, ['merging'], {
        recoverable_part_path: partPath,
        recoverable_state: 'verified',
        cleanup_part_path: '',
        output_identity: workingPartIdentity,
        cleanup_part_identity: '',
        message: 'Publishing verified output...',
      }, signal, isCurrent)
      recoverableOutputTracked = true
      await this.db.checkpoint()

      const publishResult = await publishFileWithRetry(partPath, finalPath, {
        signal,
        requireAtomicNoClobber: true,
        deferSourceCleanup: true,
        expectedSourceIdentity: workingPartIdentity,
        onRetry: ({ retry, maxRetries }) => {
          if (retry !== 1 && retry !== maxRetries && retry % 3 !== 0) return
          const message = `输出文件暂时被占用，正在重试保存（${retry}/${maxRetries}）...`
          this.patchActiveReplay(liveKey, ['merging'], { message }, signal, isCurrent)
          this.emitProgress({ live_key: liveKey, status: 'merging', message })
        },
      })
      publishedOutputTracked = await this.trackPublishedReplayOutput(
        liveKey,
        partPath,
        finalPath,
        workingPartIdentity,
        fileInfo,
        actualDuration,
        isCurrent,
      )
      if (!publishedOutputTracked) throw this.abortError()
      if (publishResult.cleanupDeferred) {
        try {
          await removeFileWithRetry(partPath, { expectedIdentity: workingPartIdentity })
        } catch (cleanupError) {
          if (
            !signal.aborted
            && await this.trackCompletedReplayCleanupDebt(
              liveKey,
              partPath,
              finalPath,
              workingPartIdentity,
              fileInfo,
              actualDuration,
              ['merging'],
              isCurrent,
              cleanupError as NodeJS.ErrnoException,
            )
          ) {
            committed = true
            partPath = ''
            this.emitProgress({ live_key: liveKey, status: 'completed' })
            return
          }
          throw workingLinkCleanupError(partPath, finalPath, cleanupError as NodeJS.ErrnoException)
        }
      } else if (!publishResult.sourceRemoved) {
        if (
          !signal.aborted
          && await this.trackCompletedReplayCleanupDebt(
            liveKey,
            partPath,
            finalPath,
            workingPartIdentity,
            fileInfo,
            actualDuration,
            ['merging'],
            isCurrent,
            publishResult.cleanupError,
          )
        ) {
          committed = true
          partPath = ''
          this.emitProgress({ live_key: liveKey, status: 'completed' })
          return
        }
        throw workingLinkCleanupError(partPath, finalPath, publishResult.cleanupError)
      }
      renamed = true
      partPath = ''
      this.assertActive(signal, isCurrent)

      this.patchActiveReplay(liveKey, ['merging'], {
        file_path: finalPath,
        recoverable_part_path: '',
        recoverable_state: '',
        cleanup_part_path: '',
        cleanup_part_identity: '',
        file_size: fileInfo.size,
        resolution: fileInfo.resolution,
        bitrate: fileInfo.bitrate,
        progress: 100,
        speed: '',
        elapsed: targetReplay.elapsed,
        eta: '',
        status: 'completed',
        message: 'Success',
        verify_ok: true,
        actual_duration: actualDuration,
      }, signal, isCurrent)
      committed = true
      this.emitProgress({ live_key: liveKey, status: 'completed' })
    } catch (error) {
      const recoverableSourcePath = typeof (error as { sourcePath?: unknown })?.sourcePath === 'string'
        ? path.resolve((error as { sourcePath: string }).sourcePath)
        : ''
      const preserveCompletedPart = Boolean(partPath)
        && (recoverableOutputTracked || recoverableSourcePath === path.resolve(partPath))
      if (
        preserveCompletedPart
        && error instanceof Error
        && typeof (error as { sourcePath?: unknown }).sourcePath !== 'string'
      ) {
        Object.assign(error, { sourcePath: partPath, destinationPath: finalPath })
      }
      if (partPath && !preserveCompletedPart) {
        try {
          await removeFileWithRetry(partPath, { expectedIdentity: workingPartIdentity })
          if (isCurrent()) {
            this.db.patchReplayIfStatus(liveKey, ['pending', 'downloading', 'merging', 'paused', 'deleting'], {
              cleanup_part_path: '',
              cleanup_part_identity: '',
            })
          }
        } catch (cleanupError) {
          console.error(`[downloader] Failed to remove working file ${partPath}:`, cleanupError)
          if (isCurrent()) {
            this.db.patchReplayIfStatus(liveKey, ['pending', 'downloading', 'merging', 'paused', 'deleting'], {
              cleanup_part_path: partPath,
              cleanup_part_identity: workingPartIdentity,
            })
            await this.db.checkpoint()
          }
        }
      }
      if (finalPath && renamed && !committed && !publishedOutputTracked) {
        try {
          await removeFileWithRetry(finalPath, { expectedIdentity: workingPartIdentity })
        } catch (cleanupError) {
          console.error(`[downloader] Failed to roll back published file ${finalPath}:`, cleanupError)
        }
      }
      throw error
    } finally {
      // Also cover failures while fetching/parsing and pause/delete aborts.
      // A later execution will refresh M3U8 before it starts downloading.
      if (freshCacheCreated) {
        try {
          this.db.deleteReplayStreamCache(liveKey, true)
        } catch (error) {
          console.error(`[downloader] Failed to release stream cache for ${liveKey}:`, error)
        }
      }
    }
  }

  private async downloadReplayWithContext(replay: ReplayRecord, signal: AbortSignal, isCurrent: () => boolean) {
    const streams = [...replay.streams].sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time)
    if (streams.length === 0) {
      throw new Error(`no streams found for replay ${replay.live_key}`)
    }

    const desiredPath = this.getDesiredOutputPath(replay)
    fs.mkdirSync(path.dirname(desiredPath), { recursive: true })
    const { finalPath, partPath } = this.reserveOutputPaths(desiredPath)
    const partIdentity = tryReadFileIdentity(partPath)
    let outputCompleted = false
    const streamPlans: Array<{
      streamIdx: number
      segments: M3U8Segment[]
      streamDir: string
      streamDirIdentity: string
      segmentFiles: string[]
    }> = []

    try {
      if (!partIdentity) throw new Error(`Cannot verify reserved replay output ownership: ${partPath}`)
      this.patchActiveReplay(replay.live_key, ['downloading'], {
        cleanup_part_path: partPath,
        cleanup_part_identity: partIdentity,
      }, signal, isCurrent)
      await this.db.checkpoint()
      const startAt = Date.now()
      const speedHistory: number[] = []
      let lastProgressUpdateAt = 0
      let downloadedBytes = 0
      let doneSegments = 0
      let totalSegments = 0
      let expectedDuration = 0
      const allSegmentFiles: string[] = []
      // Resolve every playlist before downloading so progress always uses the
      // final denominator. Discovering a later stream after an earlier one had
      // reached 98% made the persisted/UI progress jump backwards.
      for (let streamIdx = 0; streamIdx < streams.length; streamIdx += 1) {
        this.assertActive(signal, isCurrent)
        const stream = streams[streamIdx]
        const segments = await this.parseM3U8(stream.stream, stream.m3u8_text, signal)
        this.assertActive(signal, isCurrent)
        totalSegments += segments.length
        expectedDuration += segments.reduce((sum, item) => sum + item.duration, 0)
        const streamDir = await fsp.mkdtemp(path.join(this.config.download.temp_dir, 'replay-'))
        const sentinelContent = replayTempSentinelContent(replay.live_key, streamIdx)
        const streamDirIdentity = tryReadDirectoryIdentity(streamDir)
        if (!streamDirIdentity) throw new Error(`Cannot verify replay temporary directory ownership: ${streamDir}`)
        try {
          await fsp.writeFile(path.join(streamDir, REPLAY_TEMP_SENTINEL), sentinelContent, { flag: 'wx' })
        } catch (sentinelError) {
          try {
            await removePathWithRetry(streamDir, {
              recursive: true,
              expectedDirectoryIdentity: streamDirIdentity,
            })
          } catch {}
          throw sentinelError
        }
        const segmentFiles = segments.map((_segment, index) =>
          path.join(streamDir, `seg_${String(index).padStart(5, '0')}.ts`),
        )
        allSegmentFiles.push(...segmentFiles)
        streamPlans.push({ streamIdx, segments, streamDir, streamDirIdentity, segmentFiles })
      }

      if (totalSegments === 0) {
        throw new Error(`No media segments found for replay ${replay.live_key}`)
      }

      for (const plan of streamPlans) {
        const { streamIdx, segments, segmentFiles } = plan
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
            const segPath = segmentFiles[i]

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

              const now = Date.now()
              if (doneSegments === totalSegments || now - lastProgressUpdateAt >= PROGRESS_UPDATE_INTERVAL_MS) {
                lastProgressUpdateAt = now
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
              }

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

      // From this point FFmpeg can leave a non-empty, potentially complete MP4
      // at any instant. Persist it as recovery-owned before starting the merge;
      // a hard crash during the subsequent full-database checkpoint must never
      // make startup classify a completed multi-GB output as disposable.
      this.patchActiveReplay(replay.live_key, ['merging'], {
        recoverable_part_path: partPath,
        recoverable_state: 'merge_in_progress',
        cleanup_part_path: '',
        output_identity: partIdentity,
        cleanup_part_identity: '',
        message: MERGE_IN_PROGRESS_RECOVERY_MESSAGE,
      }, signal, isCurrent)
      await this.db.checkpoint()

      await this.runFfmpegMerge(
        replay.live_key,
        allSegmentFiles,
        partPath,
        expectedDuration,
        signal,
        streamPlans[0].streamDir,
      )
      outputCompleted = true
      if (!fileMatchesIdentity(partPath, partIdentity)) {
        throw Object.assign(
          new Error(`Reserved replay output path was replaced; the foreign file was preserved: ${partPath}`),
          { code: 'EOWNERSHIP' },
        )
      }

      // The merge has produced the expensive, complete media artifact. Claim
      // it durably before temp cleanup, abort checks, metadata parsing, or any
      // other operation that could fail or be interrupted. Restart recovery
      // must validate this file, never classify it as a disposable partial.
      if (!isCurrent()) throw this.abortError()
      const recoveryClaimed = this.db.patchReplayIfStatus(replay.live_key, ['merging', 'paused', 'pending'], {
        recoverable_part_path: partPath,
        recoverable_state: 'complete_unverified',
        cleanup_part_path: '',
        output_identity: partIdentity,
        cleanup_part_identity: '',
        message: 'Merge complete; verifying output...',
      })
      if (!recoveryClaimed) throw this.abortError()
      await this.db.checkpoint()

      for (const plan of streamPlans) {
        try {
          await removePathWithRetry(plan.streamDir, {
            recursive: true,
            expectedDirectoryIdentity: plan.streamDirIdentity,
          })
        } catch (cleanupError) {
          // Segment caches are disposable cleanup debt.  Once FFmpeg produced
          // the complete media part, a locked temp directory must not make us
          // delete that output and download it again.
          console.error(`[downloader] Failed to remove replay temp directory ${plan.streamDir}:`, cleanupError)
        }
      }
      this.assertActive(signal, isCurrent)
      return { finalPath, partPath, partIdentity }
    } catch (err) {
      for (const plan of streamPlans) {
        try {
          await removePathWithRetry(plan.streamDir, {
            recursive: true,
            expectedDirectoryIdentity: plan.streamDirIdentity,
          })
        } catch (cleanupError) {
          console.error(`[downloader] Failed to remove interrupted replay temp directory ${plan.streamDir}:`, cleanupError)
        }
      }
      if (outputCompleted) {
        if ((err as NodeJS.ErrnoException).code !== 'EOWNERSHIP') {
          const failure = err instanceof Error ? err : new Error(String(err))
          Object.assign(failure, { sourcePath: partPath, destinationPath: finalPath })
        }
        throw err
      }
      try {
        await removeFileWithRetry(partPath, { expectedIdentity: partIdentity })
        if (isCurrent()) {
          this.db.patchReplayIfStatus(replay.live_key, ['pending', 'downloading', 'merging', 'paused', 'deleting'], {
            recoverable_part_path: '',
            recoverable_state: '',
            cleanup_part_path: '',
            output_identity: '',
            cleanup_part_identity: '',
          })
          await this.db.checkpoint()
        }
      } catch (cleanupError) {
        console.error(`[downloader] Failed to remove reserved output ${partPath}:`, cleanupError)
        if (isCurrent()) {
          this.db.patchReplayIfStatus(replay.live_key, ['pending', 'downloading', 'merging', 'paused', 'deleting'], {
            recoverable_part_path: '',
            recoverable_state: '',
            cleanup_part_path: partPath,
            output_identity: '',
            cleanup_part_identity: partIdentity,
          })
          await this.db.checkpoint()
        }
        const failure = err instanceof Error ? err : new Error(String(err))
        throw Object.assign(failure, { cleanupPath: partPath, cause: cleanupError })
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

  private getDesiredOutputPath(replay: ReplayRecord) {
    let finalFilename = renderFilenameTemplate(this.config.download.filename_template, replay)
    if (!finalFilename.toLowerCase().endsWith('.mp4')) {
      finalFilename += '.mp4'
    }
    return path.join(this.config.download.output_dir, finalFilename)
  }

  private getRecoverablePartCandidate(
    recoverablePartPath: string | undefined,
    baseDir: string,
    expectedIdentity = '',
  ) {
    if (!recoverablePartPath) return null
    const partPath = path.resolve(baseDir, recoverablePartPath)
    const directory = path.dirname(partPath)
    const extension = path.extname(partPath)
    const fileName = path.basename(partPath)
    const workingStem = path.basename(partPath, extension)
    if (extension.toLocaleLowerCase() !== '.mp4' || !workingStem.toLocaleLowerCase().endsWith('.part')) return null
    const finalPath = path.join(directory, `${workingStem.slice(0, -'.part'.length)}${extension}`)
    if (!expectedIdentity) {
      throw recoverablePartError(
        '已登记的临时文件缺少可验证的所有权身份；为避免处理其他任务的文件，已停止自动恢复',
        partPath,
        finalPath,
        'EOWNERSHIP',
      )
    }
    const inspect = (candidatePath: string) => {
      try {
        return fs.statSync(candidatePath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw recoverablePartError(
          '已登记的完整临时文件暂时不可访问；所有权记录已保留，请稍后重试',
          partPath,
          finalPath,
          code || 'EBUSY',
        )
      }
    }
    const sourceStat = inspect(partPath)
    const finalStat = inspect(finalPath)
    if (!sourceStat && !finalStat) {
      throw recoverablePartError(
        '已登记的完整临时文件当前不可见；可能是外置盘未连接。所有权路径已保留，请恢复磁盘后重试，或显式删除本地文件记录',
        partPath,
        finalPath,
        'ENOENT',
      )
    }
    const sourceOwned = Boolean(sourceStat && fileMatchesIdentity(partPath, expectedIdentity))
    const finalOwned = Boolean(finalStat && fileMatchesIdentity(finalPath, expectedIdentity))
    if (expectedIdentity) {
      // A completed hard-link publication remains authoritative even when a
      // different process has since reused the old .part name.  Treat that
      // entry as unrelated and preserve it; recovery only validates the final
      // path whose durable identity still matches.
      if (sourceStat && !sourceOwned && !finalOwned) {
        throw recoverablePartError(
          '可恢复临时路径已被另一个文件占用；为避免误处理已保留该路径',
          partPath,
          finalPath,
          'EOWNERSHIP',
        )
      }
      if (finalStat && !finalOwned) {
        throw recoverablePartError(
          '目标路径已被另一个文件占用；为避免覆盖已停止自动恢复',
          partPath,
          finalPath,
          'EEXIST',
        )
      }
    }
    if (sourceStat && finalStat && sourceOwned && finalOwned) {
      const sameFile = sourceStat.dev === finalStat.dev
        && sourceStat.ino !== 0
        && sourceStat.ino === finalStat.ino
      if (!sameFile) {
        throw recoverablePartError(
          '可恢复临时文件与现有目标不是同一个文件，为避免覆盖已停止自动恢复',
          partPath,
          finalPath,
          'EEXIST',
        )
      }
    }
    const validationPath = finalOwned ? finalPath : partPath
    const stat = finalOwned ? finalStat! : sourceStat!
    if (!stat.isFile()) {
      throw recoverablePartError('已登记的恢复路径不是普通文件，已停止自动处理', partPath, finalPath, 'EOWNERSHIP')
    }
    if (stat.size === 0) {
      throw recoverablePartError('可恢复临时文件为空，请删除该任务的本地文件后重试', partPath, finalPath)
    }
    if (Date.now() - stat.mtimeMs < RECOVERABLE_PART_MIN_AGE_MS) {
      throw recoverablePartError('可恢复临时文件仍可能在写入，请等待 30 秒后重试', partPath, finalPath, 'EBUSY')
    }
    return {
      finalPath,
      partPath,
      validationPath,
      alreadyPublished: finalOwned,
      sourceExists: Boolean(sourceStat),
      sourceOwned,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    }
  }

  private async tryRecoverCompletedPart(
    replay: ReplayRecord,
    recoverablePartPath: string | undefined,
    baseDir: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<{
    finalPath: string
    actualDuration: number
    fileInfo: FileInfo
    completedWithCleanupDebt?: boolean
  } | null> {
    if (recoverablePartPath) {
      const resolvedPartPath = path.resolve(baseDir, recoverablePartPath)
      const extension = path.extname(resolvedPartPath)
      const stem = path.basename(resolvedPartPath, extension)
      const possibleFinalPath = stem.toLocaleLowerCase().endsWith('.part')
        ? path.join(path.dirname(resolvedPartPath), `${stem.slice(0, -'.part'.length)}${extension}`)
        : ''
      const expectedIdentity = replay.output_identity
      const partInitiallyOwned = Boolean(expectedIdentity)
        && fileMatchesIdentity(resolvedPartPath, expectedIdentity)
      const finalInitiallyOwned = Boolean(expectedIdentity && possibleFinalPath)
        && fileMatchesIdentity(possibleFinalPath, expectedIdentity)
      let removedQuarantineDebt = false

      if (expectedIdentity && !partInitiallyOwned) {
        try {
          // The identity-aware helper also discovers deterministic quarantine
          // names and random tombstones left by an interrupted Windows unlink.
          // It only removes the owned entry; a replacement at the original
          // .part path is never touched.
          removedQuarantineDebt = await removeFileWithRetry(resolvedPartPath, {
            expectedIdentity,
            signal,
          }) === 'removed'
        } catch (cleanupError) {
          // If the final hard link is still the durably owned output, an
          // EOWNERSHIP result without a quarantine path merely describes an
          // unrelated occupant at the old working name. Preserve it and
          // continue from the final file. Ambiguous/foreign quarantine entries
          // and all other failures retain the durable cleanup state.
          const fileError = cleanupError as NodeJS.ErrnoException & { quarantinePath?: string }
          if (
            !finalInitiallyOwned
            || fileError.code !== 'EOWNERSHIP'
            || Boolean(fileError.quarantinePath)
          ) throw cleanupError
        }
      }

      const partOwned = Boolean(expectedIdentity)
        && fileMatchesIdentity(resolvedPartPath, expectedIdentity)
      const finalOwned = Boolean(expectedIdentity && possibleFinalPath)
        && fileMatchesIdentity(possibleFinalPath, expectedIdentity)
      if (removedQuarantineDebt && !partOwned && !finalOwned) {
        // The only owned filesystem entry was deletion quarantine debt. Once
        // it is safely removed, clear the recovery state in the normal caller
        // path and resume with a fresh download.
        return null
      }
      let settleStat: fs.Stats | undefined
      let settlePath = ''
      for (const candidatePath of [
        finalOwned ? possibleFinalPath : '',
        partOwned ? resolvedPartPath : '',
      ]) {
        if (!candidatePath) continue
        try {
          settleStat = fs.statSync(candidatePath)
          settlePath = candidatePath
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        }
      }
      if (
        settleStat
        && replay.recoverable_state === 'merge_in_progress'
        && settlePath === resolvedPartPath
        && settleStat.size === 0
      ) {
        await removeFileWithRetry(resolvedPartPath, { expectedIdentity: replay.output_identity })
        this.patchActiveReplay(replay.live_key, ['pending'], {
          recoverable_part_path: '',
          recoverable_state: '',
          output_identity: '',
          message: 'Empty interrupted merge reservation removed; downloading again...',
        }, signal, isCurrent)
        await this.db.checkpoint()
        return null
      }
      if (settleStat) {
        const remainingMs = RECOVERABLE_PART_MIN_AGE_MS - (Date.now() - settleStat.mtimeMs)
        if (remainingMs > 0) {
          this.patchActiveReplay(replay.live_key, ['pending'], {
            message: `Waiting ${Math.ceil(remainingMs / 1_000)}s for the recovered media file to settle...`,
          }, signal, isCurrent)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', onAbort)
              resolve()
            }, remainingMs)
            const onAbort = () => {
              clearTimeout(timer)
              reject(this.abortError())
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })
          this.assertActive(signal, isCurrent)
        }
      }
    }
    const candidate = this.getRecoverablePartCandidate(recoverablePartPath, baseDir, replay.output_identity)
    if (!candidate) return null
    this.assertActive(signal, isCurrent)
    const name = path.basename(candidate.partPath)
    this.patchActiveReplay(replay.live_key, ['pending'], {
      message: `Checking existing completed file: ${name}`,
    }, signal, isCurrent)
    this.emitProgress({ live_key: replay.live_key, status: 'pending' })

    let verified: { ok: boolean; duration: number; reason?: string }
    try {
      verified = await this.verifyDuration(candidate.validationPath, replay.duration)
    } catch (validationError) {
      const code = (validationError as NodeJS.ErrnoException).code || 'EBUSY'
      throw recoverablePartError(
        '已有媒体文件暂时无法读取校验；文件已保留，请关闭播放器或稍后重试',
        candidate.partPath,
        candidate.finalPath,
        code,
      )
    }
    this.assertActive(signal, isCurrent)
    if (!verified.ok) {
      if (replay.recoverable_state === 'merge_in_progress') {
        // This state was checkpointed before FFmpeg started. A crash after a
        // successful merge is recovered above because it validates; a stable,
        // invalid file here is an interrupted partial and can be discarded so
        // retry does not livelock forever on the same fragment.
        await removeFileWithRetry(candidate.partPath, { expectedIdentity: replay.output_identity })
        this.patchActiveReplay(replay.live_key, ['pending'], {
          recoverable_part_path: '',
          recoverable_state: '',
          output_identity: '',
          message: 'Interrupted merge fragment removed; downloading again...',
        }, signal, isCurrent)
        await this.db.checkpoint()
        return null
      }
      throw recoverablePartError(
        '已有临时文件暂时无法通过音视频与时长校验；已保留文件，请稍后重试或删除本地文件',
        candidate.partPath,
        candidate.finalPath,
      )
    }
    const fileInfo = await this.getFileInfo(candidate.validationPath)
    this.assertActive(signal, isCurrent)
    if (fileInfo.size <= 0) {
      throw recoverablePartError('已有临时文件大小无效，已保留等待处理', candidate.partPath, candidate.finalPath)
    }
    try {
      const afterValidation = fs.statSync(candidate.validationPath)
      if (
        afterValidation.size !== candidate.size
        || afterValidation.mtimeMs !== candidate.mtimeMs
        || afterValidation.ctimeMs !== candidate.ctimeMs
      ) {
        console.warn(`[downloader] Recoverable working file changed during validation: ${candidate.validationPath}`)
        throw recoverablePartError(
          '可恢复临时文件在校验期间发生变化，已停止恢复；请等待写入结束后重试',
          candidate.partPath,
          candidate.finalPath,
          'EBUSY',
        )
      }
    } catch {
      throw recoverablePartError(
        '可恢复临时文件在校验后不可访问，已保留等待重试',
        candidate.partPath,
        candidate.finalPath,
        'EBUSY',
      )
    }

    if (candidate.alreadyPublished) {
      if (!await this.trackPublishedReplayOutput(
        replay.live_key,
        candidate.partPath,
        candidate.finalPath,
        replay.output_identity,
        fileInfo,
        verified.duration,
        isCurrent,
        !candidate.sourceOwned,
      )) throw this.abortError()
      if (candidate.sourceOwned) {
        try {
          await removeFileWithRetry(candidate.partPath, {
            expectedIdentity: replay.output_identity,
          })
        } catch (cleanupError) {
          if (await this.trackCompletedReplayCleanupDebt(
            replay.live_key,
            candidate.partPath,
            candidate.finalPath,
            replay.output_identity,
            fileInfo,
            verified.duration,
            ['pending'],
            isCurrent,
            cleanupError as NodeJS.ErrnoException,
          )) {
            return {
              finalPath: candidate.finalPath,
              actualDuration: verified.duration,
              fileInfo,
              completedWithCleanupDebt: true,
            }
          }
          throw workingLinkCleanupError(
            candidate.partPath,
            candidate.finalPath,
            cleanupError as NodeJS.ErrnoException,
          )
        }
      }
    } else {
      const publishResult = await publishFileWithRetry(candidate.partPath, candidate.finalPath, {
        signal,
        requireAtomicNoClobber: true,
        deferSourceCleanup: true,
        expectedSourceIdentity: replay.output_identity,
        onRetry: ({ retry, maxRetries }) => {
          if (retry !== 1 && retry !== maxRetries && retry % 3 !== 0) return
          const message = `已有完整文件暂时被占用，正在重试恢复（${retry}/${maxRetries}）...`
          this.patchActiveReplay(replay.live_key, ['pending'], { message }, signal, isCurrent)
          this.emitProgress({ live_key: replay.live_key, status: 'pending', message })
        },
      })
      if (!await this.trackPublishedReplayOutput(
        replay.live_key,
        candidate.partPath,
        candidate.finalPath,
        replay.output_identity,
        fileInfo,
        verified.duration,
        isCurrent,
      )) throw this.abortError()
      if (publishResult.cleanupDeferred) {
        try {
          await removeFileWithRetry(candidate.partPath, {
            expectedIdentity: replay.output_identity,
          })
        } catch (cleanupError) {
          if (await this.trackCompletedReplayCleanupDebt(
            replay.live_key,
            candidate.partPath,
            candidate.finalPath,
            replay.output_identity,
            fileInfo,
            verified.duration,
            ['pending'],
            isCurrent,
            cleanupError as NodeJS.ErrnoException,
          )) {
            return {
              finalPath: candidate.finalPath,
              actualDuration: verified.duration,
              fileInfo,
              completedWithCleanupDebt: true,
            }
          }
          throw workingLinkCleanupError(
            candidate.partPath,
            candidate.finalPath,
            cleanupError as NodeJS.ErrnoException,
          )
        }
      } else if (!publishResult.sourceRemoved) {
        if (await this.trackCompletedReplayCleanupDebt(
          replay.live_key,
          candidate.partPath,
          candidate.finalPath,
          replay.output_identity,
          fileInfo,
          verified.duration,
          ['pending'],
          isCurrent,
          publishResult.cleanupError,
        )) {
          return {
            finalPath: candidate.finalPath,
            actualDuration: verified.duration,
            fileInfo,
            completedWithCleanupDebt: true,
          }
        }
        throw workingLinkCleanupError(candidate.partPath, candidate.finalPath, publishResult.cleanupError)
      }
    }
    console.log(`[downloader] Recovered completed working file without re-downloading: ${candidate.finalPath}`)
    return { finalPath: candidate.finalPath, actualDuration: verified.duration, fileInfo }
  }

  private async cleanupTrackedPartialReplay(
    replay: ReplayRecord,
    baseDir: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) {
    if (!replay.cleanup_part_path) return
    const cleanupPath = path.isAbsolute(replay.cleanup_part_path)
      ? path.resolve(replay.cleanup_part_path)
      : path.resolve(baseDir, replay.cleanup_part_path)
    this.patchActiveReplay(replay.live_key, ['pending'], {
      message: `Cleaning interrupted partial file: ${path.basename(cleanupPath)}`,
    }, signal, isCurrent)
    if (!replay.cleanup_part_identity) {
      const error = new Error(`临时文件路径已被另一个文件占用，为避免误删已停止自动清理：${cleanupPath}`)
      throw Object.assign(error, { cleanupPath, code: 'EOWNERSHIP' })
    }
    try {
      const stat = fs.statSync(cleanupPath)
      if (
        stat.isFile()
        && stat.size > 0
        && fileMatchesIdentity(cleanupPath, replay.cleanup_part_identity)
      ) {
        // Old versions persisted an in-progress merge as disposable cleanup
        // debt. A non-empty MP4 may already be complete, so promote it to the
        // validation/recovery path instead of deleting it on restart.
        this.patchActiveReplay(replay.live_key, ['pending'], {
          recoverable_part_path: cleanupPath,
          recoverable_state: 'merge_in_progress',
          cleanup_part_path: '',
          output_identity: replay.cleanup_part_identity,
          cleanup_part_identity: '',
          message: MERGE_IN_PROGRESS_RECOVERY_MESSAGE,
        }, signal, isCurrent)
        await this.db.checkpoint()
        return
      }
    } catch (inspectError) {
      const code = (inspectError as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        const error = new Error(`上次中断留下的媒体文件暂时不可访问，所有权记录已保留：${cleanupPath}`)
        throw Object.assign(error, { cleanupPath, cause: inspectError })
      }
    }
    try {
      await removeFileWithRetry(cleanupPath, { expectedIdentity: replay.cleanup_part_identity })
    } catch (cleanupError) {
      const error = new Error(`无法清理上次中断留下的临时文件：${cleanupPath}`)
      throw Object.assign(error, { cleanupPath, cause: cleanupError })
    }
    this.patchActiveReplay(replay.live_key, ['pending'], {
      cleanup_part_path: '',
      cleanup_part_identity: '',
    }, signal, isCurrent)
    await this.db.checkpoint()
  }

  private async trackPublishedReplayOutput(
    liveKey: string,
    partPath: string,
    finalPath: string,
    expectedIdentity: string,
    fileInfo: FileInfo,
    actualDuration: number,
    isCurrent: () => boolean,
    allowReplacedPart = false,
  ) {
    if (!isCurrent()) return false
    if (
      !expectedIdentity
      || !fileMatchesIdentity(finalPath, expectedIdentity)
      || (
        !allowReplacedPart
        && fs.existsSync(partPath)
        && !fileMatchesIdentity(partPath, expectedIdentity)
      )
    ) {
      throw Object.assign(
        new Error(`Published replay output ownership changed; all paths were preserved: ${finalPath}`),
        { code: 'EOWNERSHIP', sourcePath: partPath, destinationPath: finalPath },
      )
    }
    const changed = this.db.patchReplayIfStatus(liveKey, ['pending', 'merging', 'paused'], {
      file_path: finalPath,
      recoverable_part_path: partPath,
      recoverable_state: 'published_cleanup',
      output_identity: expectedIdentity,
      file_size: fileInfo.size,
      resolution: fileInfo.resolution,
      bitrate: fileInfo.bitrate,
      verify_ok: true,
      actual_duration: actualDuration,
    })
    if (changed) await this.db.checkpoint()
    return changed
  }

  private async trackCompletedReplayCleanupDebt(
    liveKey: string,
    partPath: string,
    finalPath: string,
    expectedIdentity: string,
    fileInfo: FileInfo,
    actualDuration: number,
    allowedStatuses: readonly string[],
    isCurrent: () => boolean,
    cleanupError?: NodeJS.ErrnoException,
  ) {
    if (
      !isCurrent()
      || !expectedIdentity
      || !fileMatchesIdentity(finalPath, expectedIdentity)
    ) return false
    const changed = this.db.patchReplayIfStatus(liveKey, allowedStatuses, {
      file_path: finalPath,
      recoverable_part_path: '',
      recoverable_state: '',
      cleanup_part_path: partPath,
      output_identity: expectedIdentity,
      cleanup_part_identity: expectedIdentity,
      file_size: fileInfo.size,
      resolution: fileInfo.resolution,
      bitrate: fileInfo.bitrate,
      progress: 100,
      speed: '',
      eta: '',
      status: 'completed',
      message: `Success; working-file cleanup was deferred after ${cleanupError?.code || 'EBUSY'} and will retry on next start`,
      verify_ok: true,
      actual_duration: actualDuration,
    })
    if (changed) await this.db.checkpoint()
    return changed
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

  private async runFfmpegMerge(
    liveKey: string,
    segmentFiles: string[],
    outputPath: string,
    expectedSeconds: number,
    signal: AbortSignal,
    workDir = path.dirname(outputPath),
  ) {
    let totalBytes = 0
    for (const fullPath of segmentFiles) {
      if (fs.existsSync(fullPath)) {
        totalBytes += fs.statSync(fullPath).size
      }
    }

    const tempPath = path.join(workDir, 'concat.ts.tmp')
    let concatTempIdentity = ''
    let written = 0
    let lastMergeProgressEmitAt = 0
    let lastMergeProgressPercent = -1
    const emitMergeProgress = (progress: number, force = false) => {
      const rounded = Math.max(0, Math.min(100, Math.round(progress)))
      if (rounded === lastMergeProgressPercent) return
      const now = Date.now()
      if (!force && now - lastMergeProgressEmitAt < PROGRESS_UPDATE_INTERVAL_MS) return
      lastMergeProgressEmitAt = now
      lastMergeProgressPercent = rounded
      this.emitProgress({
        live_key: liveKey,
        status: 'merging',
        progress: 99,
        merge_progress: rounded,
        message: `合并临时碎片... ${rounded}%`,
      })
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const outStream = createWriteStream(tempPath, { flags: 'wx' })
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
            emitMergeProgress(mergeProgress)
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
        outStream.once('open', () => {
          concatTempIdentity = tryReadFileIdentity(tempPath)
          if (!concatTempIdentity) {
            fail(new Error(`Cannot verify concat temporary-file ownership: ${tempPath}`))
            return
          }
          appendNext(0)
        })
      })

      if (signal.aborted) throw this.abortError()
      emitMergeProgress(100, true)

      this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: 0, message: '转换MP4格式中 (0%)...' })
      let lastRemuxProgressAt = 0
      let lastRemuxProgressPercent = 0
      await this.remuxTsToMp4(tempPath, outputPath, signal, (pct) => {
        if (pct === lastRemuxProgressPercent) return
        const now = Date.now()
        if (pct < 100 && now - lastRemuxProgressAt < PROGRESS_UPDATE_INTERVAL_MS) return
        lastRemuxProgressAt = now
        lastRemuxProgressPercent = pct
        this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: pct, message: `转换MP4格式中 (${pct}%)...` })
      }, expectedSeconds)
      if (lastRemuxProgressPercent < 100) {
        this.emitProgress({ live_key: liveKey, status: 'merging', progress: 99, merge_progress: 100, message: '转换MP4格式中 (100%)...' })
      }
    } finally {
      if (concatTempIdentity) {
        try {
          await removeFileWithRetry(tempPath, { expectedIdentity: concatTempIdentity })
        } catch (cleanupError) {
          console.error(`[downloader] Failed to remove concat temp ${tempPath}:`, cleanupError)
        }
      }
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
      const duration = Number(metadata.format.duration || 0)
      const tracks = metadata.format.trackInfo || []
      const hasVideo = metadata.format.hasVideo === true || tracks.some(track => Boolean(track.video))
      const hasAudio = metadata.format.hasAudio === true || tracks.some(track => Boolean(track.audio))
      if (!Number.isFinite(duration) || duration <= 0 || !hasVideo || !hasAudio) {
        return { ok: false, duration: 0, reason: 'structure' }
      }
      if (expectedSeconds <= 0) return { ok: true, duration }
      const diff = Math.abs(duration - expectedSeconds)
      const margin = Math.min(600, 60 + expectedSeconds * 0.02)
      return { ok: diff <= margin, duration, reason: diff <= margin ? undefined : 'duration' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || ''
      if (TRANSIENT_VALIDATION_CODES.has(code)) throw error
      return { ok: false, duration: 0, reason: 'parse' }
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
