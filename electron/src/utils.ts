import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ReplayRecord } from './types'

export const START_LAYOUT_RE = /\{start:([^}]+)\}/g
export const END_LAYOUT_RE = /\{end:([^}]+)\}/g
export const CLIP_TEMP_DIR_RE = /^clip-[A-Za-z0-9]{6}$/
export const CLIP_TEMP_SENTINEL = '.replay-manager-clip-temp'
export const CLIP_TEMP_SENTINEL_CONTENT = 'replay-manager-clip-temp:v1\n'
export const REPLAY_TEMP_SENTINEL = '.replay-manager-replay-temp'
export const REPLAY_TEMP_DIR_RE = /^replay-[A-Za-z0-9]{6}$/

/**
 * Decode an app deletion quarantine only when its embedded ownership hash
 * matches the directory/file identity currently observed at that name.
 * Random tombstones remain recognizable after a partial recursive rm has
 * already removed the in-directory sentinel.
 */
export function parseDeleteEntryName(entryName: string) {
  if (!entryName) return null
  let originalName = entryName
  let layers = 0
  let trackedName = ''
  const ownershipHashes: string[] = []
  for (;;) {
    const match = /^\.(.+)\.arc-delete-([0-9a-f]{16})(?:\.tomb-([0-9a-f]{32}))?$/.exec(originalName)
    if (!match) break
    if (layers === 0) trackedName = match[1]
    ownershipHashes.push(match[2])
    originalName = match[1]
    layers += 1
  }
  // `trackedName` strips exactly the outermost protocol layer. Passing that
  // name back to removePathWithRetry lets it discover both current one-layer
  // tombstones and nested quarantines produced by older releases.
  return layers > 0 ? { originalName, trackedName, layers, ownershipHashes } : null
}

export function parseOwnedDeleteEntryName(entryName: string, expectedIdentity: string) {
  if (!expectedIdentity) return null
  const parsed = parseDeleteEntryName(entryName)
  if (!parsed) return null
  const expectedHash = createHash('sha256').update(expectedIdentity).digest('hex').slice(0, 16)
  // The outermost layer is the most recent cleanup attempt. A package copied
  // across volumes can legitimately retain older inner hashes from the source
  // filesystem; once this version wraps it with the current identity hash and
  // recursive rm removes the sentinel, that outer layer is the durable proof.
  return parsed.ownershipHashes[0] === expectedHash ? parsed : null
}

export function replayTempSentinelContent(liveKey: string, streamIndex: number) {
  return `${JSON.stringify({ kind: 'replay-manager-replay-temp', version: 1, liveKey, streamIndex })}\n`
}

export function parseReplayTempSentinel(content: string) {
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    if (
      value.kind !== 'replay-manager-replay-temp'
      || value.version !== 1
      || typeof value.liveKey !== 'string'
      || !Number.isSafeInteger(value.streamIndex)
      || Number(value.streamIndex) < 0
    ) return null
    return { liveKey: value.liveKey, streamIndex: Number(value.streamIndex) }
  } catch {
    return null
  }
}

const TRANSIENT_FILE_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const HARD_LINK_FALLBACK_CODES = new Set([
  'EACCES', 'EBUSY', 'EINVAL', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV',
])
const DEFAULT_PUBLISH_RETRY_DELAYS_MS = [
  100, 200, 400, 800, 1_500, 2_000,
  2_500, 2_500, 2_500, 2_500, 2_500,
  2_500, 2_500, 2_500, 2_500, 2_500,
] as const
const DEFAULT_REMOVE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_500, 2_000] as const

export type FileRetryInfo = {
  retry: number
  maxRetries: number
  delayMs: number
  code: string
}

export type FilePublishResult = {
  method: 'link' | 'rename'
  sourceRemoved: boolean
  cleanupDeferred?: boolean
  cleanupError?: NodeJS.ErrnoException
}

/**
 * Stable identity of an app-owned directory entry.  Size is intentionally not
 * included because FFmpeg truncates and fills the file after we reserve it;
 * the inode and birth time remain stable for that owned entry and its hard
 * link.  A missing/zero inode is treated as unverifiable so cleanup fails safe.
 */
export function readFileIdentity(filePath: string) {
  const stat = fs.statSync(filePath, { bigint: true })
  if (!stat.isFile() || stat.ino === 0n) return ''
  return `v1:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

export function tryReadFileIdentity(filePath: string) {
  try {
    return readFileIdentity(filePath)
  } catch {
    return ''
  }
}

export function readDirectoryIdentity(directoryPath: string) {
  const stat = fs.statSync(directoryPath, { bigint: true })
  if (!stat.isDirectory() || stat.ino === 0n) return ''
  return `v1:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

export function tryReadDirectoryIdentity(directoryPath: string) {
  try {
    return readDirectoryIdentity(directoryPath)
  } catch {
    return ''
  }
}

export function fileMatchesIdentity(filePath: string, identity: string) {
  return Boolean(identity) && tryReadFileIdentity(filePath) === identity
}

type FileRetryOptions = {
  signal?: AbortSignal
  retryDelaysMs?: readonly number[]
  onRetry?: (info: FileRetryInfo) => void
}

type RemovePathOptions = FileRetryOptions & {
  recursive?: boolean
  /** Re-check durable ownership immediately before every removal retry. */
  expectedIdentity?: string
  /** Directory counterpart used by recursive cleanup. */
  expectedDirectoryIdentity?: string
}

type PublishFileOptions = FileRetryOptions & {
  /** Test/compatibility escape hatch for filesystems where hard links are unavailable. */
  useHardLink?: boolean
  /** Refuse the overwrite-capable rename fallback if atomic no-clobber publication is unavailable. */
  requireAtomicNoClobber?: boolean
  /** Let the caller persist ownership of both names before removing the source link. */
  deferSourceCleanup?: boolean
  /** Durable identity captured when the app exclusively reserved the source path. */
  expectedSourceIdentity?: string
  cleanupRetryDelaysMs?: readonly number[]
}

function fileAbortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function throwIfFileOperationAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw fileAbortError()
}

function waitForFileRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(fileAbortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(fileAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function outputPathOccupiedError(destinationPath: string) {
  return Object.assign(
    new Error(`Output path became occupied: ${destinationPath}`),
    { code: 'EEXIST' },
  )
}

function recoverableAtomicPublishError(
  sourcePath: string,
  destinationPath: string,
  originalError: NodeJS.ErrnoException,
) {
  return Object.assign(
    new Error(
      `当前文件系统无法安全发布且不覆盖已有文件（${originalError.code || 'UNKNOWN'}）。`
      + `已保留完整临时文件，请改用 NTFS 本地目录后重试；publish '${sourcePath}' -> '${destinationPath}'`,
    ),
    {
      code: originalError.code || 'EATOMICUNSUPPORTED',
      cause: originalError,
      sourcePath,
      destinationPath,
    },
  )
}

function persistentFileLockError(
  operation: 'publish' | 'remove',
  sourcePath: string,
  destinationPath: string | undefined,
  originalError: NodeJS.ErrnoException,
  waitedMs: number,
) {
  const action = operation === 'publish' ? '保存' : '清理'
  const target = destinationPath ? `${sourcePath} -> ${destinationPath}` : sourcePath
  const waitedSeconds = Math.max(1, Math.round(waitedMs / 1_000))
  const recoverableDetails = operation === 'publish' && destinationPath
    ? `；rename '${sourcePath}' -> '${destinationPath}'`
    : ''
  return Object.assign(
    new Error(
      `文件被其他程序持续占用或目录权限不足（${originalError.code || 'UNKNOWN'}），等待 ${waitedSeconds} 秒后仍无法${action}。`
      + `请关闭播放器和资源管理器预览窗格，并检查安全软件后重试：${target}${recoverableDetails}`,
    ),
    { code: originalError.code, cause: originalError, sourcePath, destinationPath },
  )
}

/**
 * Publish a completed working file without overwriting an output that appeared
 * after reservation. Windows scanners and preview handlers can briefly deny
 * delete sharing on a newly-created media file, so retry only lock-like errors.
 */
export async function publishFileWithRetry(
  sourcePath: string,
  destinationPath: string,
  options: PublishFileOptions = {},
) {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_PUBLISH_RETRY_DELAYS_MS
  const waitedMs = retryDelays.reduce((total, delay) => total + delay, 0)

  throwIfFileOperationAborted(options.signal)
  if (fs.existsSync(destinationPath)) {
    throw outputPathOccupiedError(destinationPath)
  }

  // link() gives us atomic no-clobber publication. On NTFS it also succeeds
  // while a scanner holds the source without delete sharing, whereas rename()
  // returns EBUSY. Removing the old directory entry afterwards does not affect
  // the now-published file because both names reference the same file data.
  if (options.useHardLink !== false) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (
          options.expectedSourceIdentity !== undefined
          && !fileMatchesIdentity(sourcePath, options.expectedSourceIdentity)
        ) {
          throw Object.assign(
            new Error(`Publish source ownership changed; refusing replacement: ${sourcePath}`),
            { code: 'EOWNERSHIP', sourcePath, destinationPath },
          )
        }
        await fs.promises.link(sourcePath, destinationPath)
        const linkedIdentity = tryReadFileIdentity(destinationPath)
        if (
          options.expectedSourceIdentity !== undefined
          && linkedIdentity !== options.expectedSourceIdentity
        ) {
          // Never adopt the identity observed *after* link() as permission to
          // delete. A racing process may have replaced destinationPath between
          // link completion and this stat; deleting that newly-observed identity
          // would remove foreign data. Preserve both names for safe inspection.
          throw Object.assign(
            new Error(`Publish source was replaced during atomic link; foreign data was not accepted: ${sourcePath}`),
            { code: 'EOWNERSHIP', sourcePath, destinationPath },
          )
        }
        if (options.deferSourceCleanup) {
          return {
            method: 'link',
            sourceRemoved: false,
            cleanupDeferred: true,
          } satisfies FilePublishResult
        }
        try {
          await removeFileWithRetry(sourcePath, {
            retryDelaysMs: options.cleanupRetryDelaysMs,
            expectedIdentity: options.expectedSourceIdentity || linkedIdentity,
          })
          return { method: 'link', sourceRemoved: true } satisfies FilePublishResult
        } catch (cleanupError) {
          console.error(
            `[files] Published ${destinationPath}, but could not remove working link ${sourcePath}:`,
            cleanupError,
          )
          return {
            method: 'link',
            sourceRemoved: false,
            cleanupError: cleanupError as NodeJS.ErrnoException,
          } satisfies FilePublishResult
        }
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException
        if (fileError.code === 'EOWNERSHIP') throw error
        if (fs.existsSync(destinationPath)) {
          throw outputPathOccupiedError(destinationPath)
        }
        const delayMs = retryDelays[attempt]
        if (TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '') && delayMs !== undefined) {
          const info: FileRetryInfo = {
            retry: attempt + 1,
            maxRetries: retryDelays.length,
            delayMs,
            code: fileError.code || 'UNKNOWN',
          }
          console.warn(
            `[files] Atomic publish blocked by ${info.code}; retry ${info.retry}/${info.maxRetries} in ${delayMs}ms: ${sourcePath}`,
          )
          options.onRetry?.(info)
          await waitForFileRetry(delayMs, options.signal)
          continue
        }
        if (!HARD_LINK_FALLBACK_CODES.has(fileError.code || '')) throw error
        if (options.requireAtomicNoClobber) {
          throw recoverableAtomicPublishError(sourcePath, destinationPath, fileError)
        }
        break
      }
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    throwIfFileOperationAborted(options.signal)
    if (fs.existsSync(destinationPath)) {
      throw outputPathOccupiedError(destinationPath)
    }
    try {
      if (
        options.expectedSourceIdentity !== undefined
        && !fileMatchesIdentity(sourcePath, options.expectedSourceIdentity)
      ) {
        throw Object.assign(
          new Error(`Publish source ownership changed; refusing replacement: ${sourcePath}`),
          { code: 'EOWNERSHIP', sourcePath, destinationPath },
        )
      }
      await fs.promises.rename(sourcePath, destinationPath)
      if (
        options.expectedSourceIdentity !== undefined
        && !fileMatchesIdentity(destinationPath, options.expectedSourceIdentity)
      ) {
        throw Object.assign(
          new Error(`Publish source ownership changed during rename: ${destinationPath}`),
          { code: 'EOWNERSHIP', sourcePath, destinationPath },
        )
      }
      return { method: 'rename', sourceRemoved: true } satisfies FilePublishResult
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException
      if (fs.existsSync(destinationPath)) {
        throw outputPathOccupiedError(destinationPath)
      }
      const delayMs = retryDelays[attempt]
      if (!TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '') || delayMs === undefined) {
        if (TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '')) {
          throw persistentFileLockError('publish', sourcePath, destinationPath, fileError, waitedMs)
        }
        throw error
      }
      const info: FileRetryInfo = {
        retry: attempt + 1,
        maxRetries: retryDelays.length,
        delayMs,
        code: fileError.code || 'UNKNOWN',
      }
      console.warn(
        `[files] Publish blocked by ${info.code}; retry ${info.retry}/${info.maxRetries} in ${delayMs}ms: ${sourcePath}`,
      )
      options.onRetry?.(info)
      await waitForFileRetry(delayMs, options.signal)
    }
  }
}

/** Remove a failed working file after transient Windows locks have cleared. */
export async function removeFileWithRetry(
  filePath: string,
  options: RemovePathOptions = {},
) {
  return removePathWithRetry(filePath, options)
}

/** Remove a file or app-owned directory after transient Windows locks clear. */
export async function removePathWithRetry(
  filePath: string,
  options: RemovePathOptions = {},
) {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_REMOVE_RETRY_DELAYS_MS
  const waitedMs = retryDelays.reduce((total, delay) => total + delay, 0)
  const hasExpectedIdentity = options.expectedIdentity !== undefined
    || options.expectedDirectoryIdentity !== undefined

  if (!hasExpectedIdentity) {
    try {
      await fs.promises.lstat(filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent' as const
      throw error
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        throwIfFileOperationAborted(options.signal)
        await fs.promises.rm(filePath, { force: true, recursive: options.recursive === true })
        return 'removed' as const
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException
        const delayMs = retryDelays[attempt]
        if (!TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '') || delayMs === undefined) {
          if (TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '')) {
            throw persistentFileLockError('remove', filePath, undefined, fileError, waitedMs)
          }
          throw error
        }
        const info: FileRetryInfo = {
          retry: attempt + 1,
          maxRetries: retryDelays.length,
          delayMs,
          code: fileError.code || 'UNKNOWN',
        }
        console.warn(
          `[files] Remove blocked by ${info.code}; retry ${info.retry}/${info.maxRetries} in ${delayMs}ms: ${filePath}`,
        )
        options.onRetry?.(info)
        await waitForFileRetry(delayMs, options.signal)
      }
    }
  }

  const expectedIdentity = options.expectedDirectoryIdentity ?? options.expectedIdentity ?? ''
  const readExpectedIdentity = options.expectedDirectoryIdentity !== undefined
    ? readDirectoryIdentity
    : readFileIdentity
  let removalPath = ''
  let cleanupOnlyQuarantine = false
  let removedAny = false
  let retryIndex = 0
  let recursiveRemovalStarted = false

  const parentPath = path.dirname(filePath)
  const quarantineName = `.${path.basename(filePath)}.arc-delete-${createHash('sha256').update(expectedIdentity).digest('hex').slice(0, 16)}`
  const quarantinePath = path.join(parentPath, quarantineName)
  const tombstonePrefix = `${quarantineName}.tomb-`

  const ownershipError = (message: string, quarantinePath?: string) => Object.assign(
    new Error(message),
    { code: 'EOWNERSHIP', sourcePath: filePath, quarantinePath },
  )

  const confirmedAbsent = async () => {
    // Windows reports ENOENT both for a missing file and for a detached drive.
    // Durable callers nearly always provide an expected identity; in that case
    // absence is conclusive only while the parent directory is reachable.
    if (hasExpectedIdentity) {
      try {
        const parent = await fs.promises.stat(path.dirname(filePath))
        if (!parent.isDirectory()) throw Object.assign(new Error('Tracked parent is not a directory'), { code: 'ENOTDIR' })
      } catch (error) {
        throw Object.assign(
          new Error(`Tracked path is unavailable because its parent cannot be reached: ${filePath}`),
          { code: 'EUNAVAILABLE', cause: error, sourcePath: filePath },
        )
      }
    }
    return 'absent' as const
  }

  const inspectPath = (candidatePath: string) => {
    try {
      return { exists: true, identity: readExpectedIdentity(candidatePath) }
    } catch (inspectError) {
      const code = (inspectError as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, identity: '' }
      throw inspectError
    }
  }

  const verifyOwnedPath = (candidatePath: string) => {
    const inspected = inspectPath(candidatePath)
    if (!inspected.exists) return false
    if (!expectedIdentity || inspected.identity !== expectedIdentity) {
      throw ownershipError(
        `Filesystem ownership changed; refusing to remove replacement: ${candidatePath}`,
        candidatePath === filePath ? undefined : candidatePath,
      )
    }
    return true
  }

  const listRecoveryEntries = async () => {
    let names: string[]
    try {
      names = await fs.promises.readdir(parentPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }

    const matches = names.filter(name => (
      name === quarantineName
      || (
        name.startsWith(tombstonePrefix)
        && /^[0-9a-f]{32}$/.test(name.slice(tombstonePrefix.length))
      )
    ))
    if (matches.length > 1) {
      throw ownershipError(
        `Cleanup state is ambiguous; refusing to choose between quarantine entries for: ${filePath}`,
        matches.map(name => path.join(parentPath, name)).join(';'),
      )
    }
    return matches.map(name => path.join(parentPath, name))
  }

  const discoverRecoveryEntry = async () => {
    const [candidatePath] = await listRecoveryEntries()
    if (!candidatePath) return ''
    const inspected = inspectPath(candidatePath)
    if (!inspected.exists) return ''
    if (!expectedIdentity || inspected.identity !== expectedIdentity) {
      throw ownershipError(
        `Cleanup quarantine belongs to another filesystem object; refusing removal: ${candidatePath}`,
        candidatePath,
      )
    }
    return candidatePath
  }

  const randomTombstonePath = () => path.join(
    parentPath,
    `${tombstonePrefix}${randomBytes(16).toString('hex')}`,
  )

  const preserveForeignMovedEntry = async (candidatePath: string) => {
    const candidate = inspectPath(candidatePath)
    if (!candidate.exists || candidate.identity === expectedIdentity) return
    const original = inspectPath(filePath)
    const deterministic = inspectPath(quarantinePath)
    const restorePath = !original.exists
      ? filePath
      : (!deterministic.exists ? quarantinePath : '')
    if (!restorePath) return
    try {
      await fs.promises.rename(candidatePath, restorePath)
      if (removalPath === candidatePath) removalPath = ''
    } catch {}
  }

  const restoreTrackedName = async () => {
    if (!removalPath) return
    const tracked = inspectPath(removalPath)
    if (!tracked.exists || tracked.identity !== expectedIdentity) return
    const original = inspectPath(filePath)

    if (options.expectedDirectoryIdentity !== undefined) {
      // Once recursive rm has started, its sentinel may already be gone. Keep
      // the identity-hashed tombstone name as durable ownership proof instead
      // of restoring an unverifiable plain directory name.
      if (recursiveRemovalStarted) return
      if (!original.exists) {
        try {
          await fs.promises.rename(removalPath, filePath)
          if (inspectPath(filePath).identity === expectedIdentity) removalPath = ''
        } catch {}
      }
      return
    }

    // Hard-link restoration is atomic no-clobber. Even if unlinking the
    // quarantine name remains locked, the durable DB path points at the same
    // owned file and a later retry can finish the deterministic cleanup debt.
    if (!original.exists) {
      try {
        await fs.promises.link(removalPath, filePath)
      } catch {}
    }
    if (inspectPath(filePath).identity === expectedIdentity) {
      // If rotation itself was blocked, removalPath is still the predictable
      // quarantine name. Never unlink that name directly during restoration;
      // leave it as discoverable cleanup debt for the next helper call.
      if (removalPath !== quarantinePath) {
        try {
          await fs.promises.rm(removalPath, { force: true })
        } catch {}
        if (!inspectPath(removalPath).exists) removalPath = ''
      }
    }
  }

  for (;;) {
    try {
      throwIfFileOperationAborted(options.signal)
      if (!removalPath) {
        const recoveredPath = await discoverRecoveryEntry()
        if (recoveredPath) {
          cleanupOnlyQuarantine = inspectPath(filePath).identity === expectedIdentity
          removalPath = recoveredPath
        } else {
          cleanupOnlyQuarantine = false
          if (!verifyOwnedPath(filePath)) {
            return removedAny ? 'removed' as const : await confirmedAbsent()
          }
          // The deterministic quarantine makes a crash between rename and
          // deletion discoverable from only the durable original path and its
          // identity. It is never passed directly to rm.
          await fs.promises.rename(filePath, quarantinePath)
          removalPath = quarantinePath
        }
        try {
          if (!verifyOwnedPath(removalPath)) {
            throw ownershipError(
              `Quarantined entry became unverifiable; refusing removal: ${removalPath}`,
              removalPath,
            )
          }
        } catch (error) {
          await preserveForeignMovedEntry(removalPath)
          throw error
        }
      }

      if (!verifyOwnedPath(removalPath)) {
        removalPath = ''
        continue
      }

      // Never delete the stable, deterministic quarantine name. Rotate the
      // entry to a fresh random tombstone before *every* rm attempt, then
      // verify the object that rename actually moved. This closes the useful
      // stat(quarantine) -> rm(quarantine) replacement window and also makes
      // retries after a lock safe: the known tombstone is randomized again.
      const tombstonePath = randomTombstonePath()
      const previousRemovalPath = removalPath
      await fs.promises.rename(previousRemovalPath, tombstonePath)
      removalPath = tombstonePath
      try {
        if (!verifyOwnedPath(removalPath)) {
          throw ownershipError(
            `Tombstone entry became unverifiable; refusing removal: ${removalPath}`,
            removalPath,
          )
        }
      } catch (error) {
        await preserveForeignMovedEntry(removalPath)
        throw error
      }

      if (options.expectedDirectoryIdentity !== undefined && options.recursive === true) {
        recursiveRemovalStarted = true
      }
      await fs.promises.rm(removalPath, { force: true, recursive: options.recursive === true })
      removedAny = true
      removalPath = ''
      if (cleanupOnlyQuarantine) {
        cleanupOnlyQuarantine = false
        retryIndex = 0
        continue
      }
      return 'removed' as const
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException
      if (fileError.code === 'EOWNERSHIP') throw error
      if (fileError.code === 'ENOENT' || fileError.code === 'ENOTDIR') {
        removalPath = ''
        retryIndex = 0
        continue
      }
      const delayMs = retryDelays[retryIndex]
      if (!TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '') || delayMs === undefined) {
        const blockedPath = removalPath || filePath
        const blockedQuarantinePath = removalPath || undefined
        await restoreTrackedName()
        if (TRANSIENT_FILE_LOCK_CODES.has(fileError.code || '')) {
          const persistentError = persistentFileLockError('remove', blockedPath, undefined, fileError, waitedMs)
          Object.assign(persistentError, { quarantinePath: blockedQuarantinePath })
          throw persistentError
        }
        throw error
      }
      retryIndex += 1
      const info: FileRetryInfo = {
        retry: retryIndex,
        maxRetries: retryDelays.length,
        delayMs,
        code: fileError.code || 'UNKNOWN',
      }
      console.warn(
        `[files] Remove blocked by ${info.code}; retry ${info.retry}/${info.maxRetries} in ${delayMs}ms: ${removalPath || filePath}`,
      )
      options.onRetry?.(info)
      try {
        await waitForFileRetry(delayMs, options.signal)
      } catch (waitError) {
        await restoreTrackedName()
        throw waitError
      }
    }
  }
}

export function formatSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function sanitizeFilename(name: string) {
  return name
    .replace(/[\x00-\x1f\x7f]/g, '')           // Remove control characters
    .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '') // Remove zero-width / invisible Unicode chars
    .replace(/[\\/:*?"<>|]/g, '_')              // Replace Windows-illegal chars
    .replace(/\s+/g, ' ')                       // Collapse whitespace (incl. newlines)
    .replace(/_+/g, '_')                        // Collapse multiple underscores
    .trim()
}

export function formatDate(date: Date, layout: string) {
  const tokens: Record<string, string> = {
    '2006': `${date.getFullYear()}`,
    '06': `${date.getFullYear()}`.slice(-2),
    '01': `${date.getMonth() + 1}`.padStart(2, '0'),
    '02': `${date.getDate()}`.padStart(2, '0'),
    '15': `${date.getHours()}`.padStart(2, '0'),
    '04': `${date.getMinutes()}`.padStart(2, '0'),
    '05': `${date.getSeconds()}`.padStart(2, '0'),
  }
  let out = layout
  for (const [token, value] of Object.entries(tokens)) {
    out = out.replaceAll(token, value)
  }
  return out
}

export function renderFilenameTemplate(template: string, replay: ReplayRecord) {
  const start = new Date(replay.start_time * 1000)
  const end = new Date(replay.end_time * 1000)
  let out = template

  out = out.replace(START_LAYOUT_RE, (_, layout: string) => formatDate(start, layout))
  out = out.replace(END_LAYOUT_RE, (_, layout: string) => formatDate(end, layout))
  out = out
    .replaceAll('{title}', replay.title)
    .replaceAll('{live_key}', replay.live_key)
    .replaceAll('{yyyy}', `${start.getFullYear()}`)
    .replaceAll('{yy}', formatDate(start, '06'))
    .replaceAll('{MM}', formatDate(start, '01'))
    .replaceAll('{dd}', formatDate(start, '02'))
    .replaceAll('{start}', formatDate(start, '2006-01-02 15-04-05'))
    .replaceAll('{end}', formatDate(end, '2006-01-02 15-04-05'))
    .replaceAll('{start_unix}', `${replay.start_time}`)
    .replaceAll('{end_unix}', `${replay.end_time}`)

  return sanitizeFilename(out || replay.live_key)
}

export function uniquePath(targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    return targetPath
  }
  const ext = path.extname(targetPath)
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath, ext)
  for (let i = 1; i < 10000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) {
      return candidate
    }
  }
  return targetPath
}

export function safeNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export function boolFromDb(value: unknown) {
  return value === 1 || value === '1' || value === true
}

export function ensureDir(dir: string) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
