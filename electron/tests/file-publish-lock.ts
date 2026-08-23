import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  parseOwnedDeleteEntryName,
  publishFileWithRetry,
  REPLAY_TEMP_SENTINEL,
  replayTempSentinelContent,
  removeFileWithRetry,
  removePathWithRetry,
  tryReadDirectoryIdentity,
  tryReadFileIdentity,
} from '../src/utils'

type LockSession = { closed: Promise<void> }

function cleanupQuarantinePath(filePath: string, identity: string) {
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.arc-delete-${suffix}`)
}

async function holdExclusiveWindowsLock(filePath: string, durationMs: number): Promise<LockSession> {
  if (process.platform !== 'win32') {
    return { closed: Promise.resolve() }
  }

  const script = [
    '$stream = [System.IO.File]::Open(',
    '  $env:REPLAY_TEST_LOCK_PATH,',
    '  [System.IO.FileMode]::Open,',
    '  [System.IO.FileAccess]::ReadWrite,',
    '  [System.IO.FileShare]::None',
    ')',
    '[Console]::Out.WriteLine("LOCKED")',
    '[Console]::Out.Flush()',
    'Start-Sleep -Milliseconds ([int]$env:REPLAY_TEST_LOCK_MS)',
    '$stream.Dispose()',
  ].join('\n')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: {
        ...process.env,
        REPLAY_TEST_LOCK_PATH: filePath,
        REPLAY_TEST_LOCK_MS: String(durationMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`exclusive-lock helper exited ${code}: ${stderr}`))
    })
  })

  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error('exclusive-lock helper did not become ready')), 5_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (!stdout.includes('LOCKED')) return
      clearTimeout(timer)
      resolve()
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      if (stdout.includes('LOCKED')) return
      clearTimeout(timer)
      reject(new Error(`exclusive-lock helper closed before ready (${code}): ${stderr}`))
    })
  })

  return { closed }
}

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-publish-lock-'))
  try {
    const occupiedSource = path.join(baseDir, 'occupied.part.mp4')
    const occupiedFinal = path.join(baseDir, 'occupied.mp4')
    fs.writeFileSync(occupiedSource, 'new data')
    fs.writeFileSync(occupiedFinal, 'existing data')
    await assert.rejects(
      publishFileWithRetry(occupiedSource, occupiedFinal),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
      'publication must never overwrite a destination that appeared after reservation',
    )
    assert.equal(fs.readFileSync(occupiedSource, 'utf8'), 'new data')
    assert.equal(fs.readFileSync(occupiedFinal, 'utf8'), 'existing data')

    const raceSourceA = path.join(baseDir, 'race-a.part.mp4')
    const raceSourceB = path.join(baseDir, 'race-b.part.mp4')
    const raceFinal = path.join(baseDir, 'race.mp4')
    fs.writeFileSync(raceSourceA, 'race A')
    fs.writeFileSync(raceSourceB, 'race B')
    const raceResults = await Promise.allSettled([
      publishFileWithRetry(raceSourceA, raceFinal, { requireAtomicNoClobber: true }),
      publishFileWithRetry(raceSourceB, raceFinal, { requireAtomicNoClobber: true }),
    ])
    assert.equal(raceResults.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(raceResults.filter(result => result.status === 'rejected').length, 1)
    assert.ok(['race A', 'race B'].includes(fs.readFileSync(raceFinal, 'utf8')))
    const losingSources = [raceSourceA, raceSourceB].filter(candidate => fs.existsSync(candidate))
    assert.equal(losingSources.length, 1, 'the losing publication must retain its verified source')

    const linkedSource = path.join(baseDir, 'linked.part.mp4')
    const linkedFinal = path.join(baseDir, 'linked.mp4')
    fs.writeFileSync(linkedSource, Buffer.alloc(4_096, 7))
    const linkedLock = await holdExclusiveWindowsLock(linkedSource, 800)
    await publishFileWithRetry(linkedSource, linkedFinal)
    await linkedLock.closed
    assert.equal(fs.existsSync(linkedSource), false)
    assert.equal(fs.statSync(linkedFinal).size, 4_096)

    const cleanupDebtSource = path.join(baseDir, 'cleanup-debt.part.mp4')
    const cleanupDebtFinal = path.join(baseDir, 'cleanup-debt.mp4')
    fs.writeFileSync(cleanupDebtSource, Buffer.alloc(2_048, 5))
    const cleanupDebtLock = await holdExclusiveWindowsLock(cleanupDebtSource, 800)
    const cleanupDebtResult = await publishFileWithRetry(cleanupDebtSource, cleanupDebtFinal, {
      requireAtomicNoClobber: true,
      cleanupRetryDelaysMs: [10],
    })
    assert.equal(cleanupDebtResult.method, 'link')
    assert.equal(cleanupDebtResult.sourceRemoved, process.platform !== 'win32')
    assert.equal(fs.existsSync(cleanupDebtFinal), true)
    if (process.platform === 'win32') {
      assert.equal(fs.existsSync(cleanupDebtSource), true, 'a locked working link must be reported instead of hidden')
    }
    await cleanupDebtLock.closed
    fs.rmSync(cleanupDebtSource, { force: true })

    const replacedPublishSource = path.join(baseDir, 'publish-source-race.part.mp4')
    const replacedPublishFinal = path.join(baseDir, 'publish-source-race.mp4')
    fs.writeFileSync(replacedPublishSource, 'owned publish source')
    const replacedPublishIdentity = tryReadFileIdentity(replacedPublishSource)
    const originalLink = fs.promises.link
    let interceptedLink = false
    ;(fs.promises as any).link = async (source: string, destination: string) => {
      if (!interceptedLink && path.resolve(source) === path.resolve(replacedPublishSource)) {
        interceptedLink = true
        fs.rmSync(source, { force: true })
        fs.writeFileSync(source, 'foreign publish replacement')
      }
      return originalLink(source, destination)
    }
    try {
      await assert.rejects(
        publishFileWithRetry(replacedPublishSource, replacedPublishFinal, {
          requireAtomicNoClobber: true,
          deferSourceCleanup: true,
          expectedSourceIdentity: replacedPublishIdentity,
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
        'a source replacement at the link boundary must never be published as owned output',
      )
    } finally {
      ;(fs.promises as any).link = originalLink
    }
    assert.equal(fs.readFileSync(replacedPublishSource, 'utf8'), 'foreign publish replacement')
    assert.equal(fs.readFileSync(replacedPublishFinal, 'utf8'), 'foreign publish replacement')

    const swappedDestinationSource = path.join(baseDir, 'publish-destination-swap.part.mp4')
    const swappedDestinationFinal = path.join(baseDir, 'publish-destination-swap.mp4')
    fs.writeFileSync(swappedDestinationSource, 'owned destination-swap source')
    const swappedDestinationIdentity = tryReadFileIdentity(swappedDestinationSource)
    let interceptedDestinationLink = false
    ;(fs.promises as any).link = async (source: string, destination: string) => {
      await originalLink(source, destination)
      if (!interceptedDestinationLink && path.resolve(destination) === path.resolve(swappedDestinationFinal)) {
        interceptedDestinationLink = true
        fs.rmSync(destination, { force: true })
        fs.writeFileSync(destination, 'foreign destination replacement')
      }
    }
    try {
      await assert.rejects(
        publishFileWithRetry(swappedDestinationSource, swappedDestinationFinal, {
          requireAtomicNoClobber: true,
          deferSourceCleanup: true,
          expectedSourceIdentity: swappedDestinationIdentity,
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
        'a destination replacement after link must not be adopted or deleted',
      )
    } finally {
      ;(fs.promises as any).link = originalLink
    }
    assert.equal(tryReadFileIdentity(swappedDestinationSource), swappedDestinationIdentity)
    assert.equal(fs.readFileSync(swappedDestinationFinal, 'utf8'), 'foreign destination replacement')

    const replacedDuringRetry = path.join(baseDir, 'replaced-during-retry.part.mp4')
    fs.writeFileSync(replacedDuringRetry, 'owned original')
    const ownedIdentity = tryReadFileIdentity(replacedDuringRetry)
    const originalRm = fs.promises.rm
    const originalRename = fs.promises.rename
    let interceptedRename = false
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (!interceptedRename && path.resolve(source) === path.resolve(replacedDuringRetry)) {
        interceptedRename = true
        await originalRm(source, { force: true })
        fs.writeFileSync(replacedDuringRetry, 'foreign replacement')
      }
      return originalRename(source, destination)
    }
    try {
      await assert.rejects(
        removeFileWithRetry(replacedDuringRetry, {
          expectedIdentity: ownedIdentity,
          retryDelaysMs: [1],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
        'every retry must re-check identity before removing a path that was replaced while waiting',
      )
    } finally {
      ;(fs.promises as any).rename = originalRename
    }
    assert.equal(fs.readFileSync(replacedDuringRetry, 'utf8'), 'foreign replacement')

    const replacedDirectory = path.join(baseDir, 'clip-Ab12Z9')
    fs.mkdirSync(replacedDirectory)
    fs.writeFileSync(path.join(replacedDirectory, 'owned.txt'), 'owned directory')
    const ownedDirectoryIdentity = tryReadDirectoryIdentity(replacedDirectory)
    let interceptedDirectoryRename = false
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (!interceptedDirectoryRename && path.resolve(source) === path.resolve(replacedDirectory)) {
        interceptedDirectoryRename = true
        await originalRm(source, { recursive: true, force: true })
        fs.mkdirSync(replacedDirectory)
        fs.writeFileSync(path.join(replacedDirectory, 'foreign.txt'), 'foreign directory')
      }
      return originalRename(source, destination)
    }
    try {
      await assert.rejects(
        removePathWithRetry(replacedDirectory, {
          recursive: true,
          expectedDirectoryIdentity: ownedDirectoryIdentity,
          retryDelaysMs: [1],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
        'recursive cleanup must re-check directory identity before every retry',
      )
    } finally {
      ;(fs.promises as any).rename = originalRename
    }
    assert.equal(fs.readFileSync(path.join(replacedDirectory, 'foreign.txt'), 'utf8'), 'foreign directory')

    const quarantineSwapSource = path.join(baseDir, 'quarantine-swap.part.mp4')
    fs.writeFileSync(quarantineSwapSource, 'owned quarantine source')
    const quarantineSwapIdentity = tryReadFileIdentity(quarantineSwapSource)
    let interceptedQuarantineRotation = false
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (
        !interceptedQuarantineRotation
        && path.resolve(source) === path.resolve(cleanupQuarantinePath(quarantineSwapSource, quarantineSwapIdentity))
        && path.basename(destination).includes('.tomb-')
      ) {
        interceptedQuarantineRotation = true
        await originalRm(source, { force: true })
        fs.writeFileSync(source, 'foreign quarantine replacement')
      }
      return originalRename(source, destination)
    }
    try {
      await assert.rejects(
        removeFileWithRetry(quarantineSwapSource, {
          expectedIdentity: quarantineSwapIdentity,
          retryDelaysMs: [],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
        'a quarantine replacement at the rotate-to-tombstone boundary must never be deleted',
      )
    } finally {
      ;(fs.promises as any).rename = originalRename
    }
    assert.equal(
      fs.readFileSync(quarantineSwapSource, 'utf8'),
      'foreign quarantine replacement',
      'the foreign entry moved by quarantine rotation must be restored or otherwise preserved',
    )

    const restartTombstoneSource = path.join(baseDir, 'restart-tombstone.part.mp4')
    fs.writeFileSync(restartTombstoneSource, 'owned restart tombstone')
    const restartTombstoneIdentity = tryReadFileIdentity(restartTombstoneSource)
    const restartTombstonePrefix = `${path.basename(cleanupQuarantinePath(restartTombstoneSource, restartTombstoneIdentity))}.tomb-`
    ;(fs.promises as any).rm = async (...args: Parameters<typeof fs.promises.rm>) => {
      if (path.basename(String(args[0])).startsWith(restartTombstonePrefix)) {
        throw Object.assign(new Error('simulated persistent tombstone lock'), { code: 'EBUSY' })
      }
      return originalRm(...args)
    }
    ;(fs.promises as any).link = async (source: string, destination: string) => {
      if (
        path.basename(source).startsWith(restartTombstonePrefix)
        && path.resolve(destination) === path.resolve(restartTombstoneSource)
      ) {
        throw Object.assign(new Error('simulated restore failure'), { code: 'EBUSY' })
      }
      return originalLink(source, destination)
    }
    try {
      await assert.rejects(
        removeFileWithRetry(restartTombstoneSource, {
          expectedIdentity: restartTombstoneIdentity,
          retryDelaysMs: [],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY',
      )
    } finally {
      ;(fs.promises as any).rm = originalRm
      ;(fs.promises as any).link = originalLink
    }
    assert.equal(fs.existsSync(restartTombstoneSource), false)
    const restartTombstones = fs.readdirSync(baseDir).filter(name => name.startsWith(restartTombstonePrefix))
    assert.equal(restartTombstones.length, 1, 'a failed restore must leave one restart-discoverable random tombstone')
    assert.equal(
      await removeFileWithRetry(restartTombstoneSource, { expectedIdentity: restartTombstoneIdentity }),
      'removed',
      'a new helper instance must clean the random tombstone using only original path + identity',
    )
    assert.equal(fs.readdirSync(baseDir).some(name => name.startsWith(restartTombstonePrefix)), false)

    const recursiveRestartSource = path.join(baseDir, 'replay-Rs91Qx')
    fs.mkdirSync(recursiveRestartSource)
    fs.writeFileSync(
      path.join(recursiveRestartSource, REPLAY_TEMP_SENTINEL),
      replayTempSentinelContent('restart-live', 1),
    )
    fs.writeFileSync(path.join(recursiveRestartSource, 'segment.ts'), 'owned segment')
    const recursiveRestartIdentity = tryReadDirectoryIdentity(recursiveRestartSource)
    const recursiveRestartPrefix = `${path.basename(cleanupQuarantinePath(recursiveRestartSource, recursiveRestartIdentity))}.tomb-`
    let recursiveRemovalBlocked = false
    let recursiveRestoreAttempted = false
    ;(fs.promises as any).rm = async (...args: Parameters<typeof fs.promises.rm>) => {
      const candidate = String(args[0])
      if (!recursiveRemovalBlocked && path.basename(candidate).startsWith(recursiveRestartPrefix)) {
        recursiveRemovalBlocked = true
        fs.rmSync(path.join(candidate, REPLAY_TEMP_SENTINEL), { force: true })
        throw Object.assign(new Error('simulated recursive cleanup lock after sentinel removal'), { code: 'EBUSY' })
      }
      return originalRm(...args)
    }
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (
        path.basename(source).startsWith(recursiveRestartPrefix)
        && path.resolve(destination) === path.resolve(recursiveRestartSource)
      ) {
        recursiveRestoreAttempted = true
      }
      return originalRename(source, destination)
    }
    try {
      await assert.rejects(
        removePathWithRetry(recursiveRestartSource, {
          recursive: true,
          expectedDirectoryIdentity: recursiveRestartIdentity,
          retryDelaysMs: [],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY',
      )
    } finally {
      ;(fs.promises as any).rm = originalRm
      ;(fs.promises as any).rename = originalRename
    }
    assert.equal(
      recursiveRestoreAttempted,
      false,
      'a partially removed directory must retain its identity-hashed tombstone instead of restoring an unverifiable plain name',
    )
    assert.equal(fs.existsSync(recursiveRestartSource), false)
    const recursiveTombstones = fs.readdirSync(baseDir).filter(name => name.startsWith(recursiveRestartPrefix))
    assert.equal(recursiveTombstones.length, 1)
    assert.equal(
      parseOwnedDeleteEntryName(recursiveTombstones[0], recursiveRestartIdentity)?.originalName,
      path.basename(recursiveRestartSource),
      'startup sweep must recover the original tracked name from the identity-bound tombstone',
    )
    assert.equal(
      fs.existsSync(path.join(baseDir, recursiveTombstones[0], REPLAY_TEMP_SENTINEL)),
      false,
      'identity recovery must not depend on a sentinel that recursive cleanup already removed',
    )
    assert.equal(
      await removePathWithRetry(recursiveRestartSource, {
        recursive: true,
        expectedDirectoryIdentity: recursiveRestartIdentity,
      }),
      'removed',
    )
    assert.equal(fs.readdirSync(baseDir).some(name => name.startsWith(recursiveRestartPrefix)), false)

    const ambiguousSource = path.join(baseDir, 'ambiguous-restart.part.mp4')
    fs.writeFileSync(ambiguousSource, 'owned ambiguous cleanup')
    const ambiguousIdentity = tryReadFileIdentity(ambiguousSource)
    const ambiguousQuarantine = cleanupQuarantinePath(ambiguousSource, ambiguousIdentity)
    const ambiguousTombstone = `${ambiguousQuarantine}.tomb-${'a'.repeat(32)}`
    fs.renameSync(ambiguousSource, ambiguousQuarantine)
    fs.linkSync(ambiguousQuarantine, ambiguousTombstone)
    await assert.rejects(
      removeFileWithRetry(ambiguousSource, { expectedIdentity: ambiguousIdentity }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
      'multiple quarantine candidates must be rejected as ambiguous even if their identities match',
    )
    assert.equal(tryReadFileIdentity(ambiguousQuarantine), ambiguousIdentity)
    assert.equal(tryReadFileIdentity(ambiguousTombstone), ambiguousIdentity)

    const foreignRestartSource = path.join(baseDir, 'foreign-restart.part.mp4')
    fs.writeFileSync(foreignRestartSource, 'owned foreign-restart source')
    const foreignRestartIdentity = tryReadFileIdentity(foreignRestartSource)
    const foreignRestartBackup = path.join(baseDir, 'foreign-restart-owned-backup.mp4')
    const foreignRestartTombstone = `${cleanupQuarantinePath(foreignRestartSource, foreignRestartIdentity)}.tomb-${'b'.repeat(32)}`
    fs.renameSync(foreignRestartSource, foreignRestartBackup)
    fs.writeFileSync(foreignRestartTombstone, 'foreign restart tombstone')
    await assert.rejects(
      removeFileWithRetry(foreignRestartSource, { expectedIdentity: foreignRestartIdentity }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EOWNERSHIP',
      'restart discovery must reject a protocol-shaped tombstone with foreign identity',
    )
    assert.equal(tryReadFileIdentity(foreignRestartBackup), foreignRestartIdentity)
    assert.equal(fs.readFileSync(foreignRestartTombstone, 'utf8'), 'foreign restart tombstone')

    const blockedRotationSource = path.join(baseDir, 'blocked-rotation.part.mp4')
    fs.writeFileSync(blockedRotationSource, 'owned blocked rotation')
    const blockedRotationIdentity = tryReadFileIdentity(blockedRotationSource)
    const blockedRotationQuarantine = cleanupQuarantinePath(blockedRotationSource, blockedRotationIdentity)
    let deterministicQuarantineRmCalled = false
    ;(fs.promises as any).rename = async (source: string, destination: string) => {
      if (
        path.resolve(source) === path.resolve(blockedRotationQuarantine)
        && path.basename(destination).includes('.tomb-')
      ) {
        throw Object.assign(new Error('simulated blocked quarantine rotation'), { code: 'EBUSY' })
      }
      return originalRename(source, destination)
    }
    ;(fs.promises as any).rm = async (...args: Parameters<typeof fs.promises.rm>) => {
      if (path.resolve(String(args[0])) === path.resolve(blockedRotationQuarantine)) {
        deterministicQuarantineRmCalled = true
      }
      return originalRm(...args)
    }
    try {
      await assert.rejects(
        removeFileWithRetry(blockedRotationSource, {
          expectedIdentity: blockedRotationIdentity,
          retryDelaysMs: [],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY',
      )
    } finally {
      ;(fs.promises as any).rename = originalRename
      ;(fs.promises as any).rm = originalRm
    }
    assert.equal(deterministicQuarantineRmCalled, false, 'the deterministic quarantine name must never be passed to rm')
    assert.equal(tryReadFileIdentity(blockedRotationSource), blockedRotationIdentity)
    assert.equal(tryReadFileIdentity(blockedRotationQuarantine), blockedRotationIdentity)
    assert.equal(
      await removeFileWithRetry(blockedRotationSource, { expectedIdentity: blockedRotationIdentity }),
      'removed',
    )

    const reachableMissing = path.join(baseDir, 'already-absent.part.mp4')
    assert.equal(
      await removeFileWithRetry(reachableMissing, { expectedIdentity: 'v1:missing:test' }),
      'absent',
    )
    await assert.rejects(
      removeFileWithRetry(path.join(baseDir, 'missing-parent', 'offline.part.mp4'), {
        expectedIdentity: 'v1:missing:test',
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EUNAVAILABLE',
      'absence is not conclusive when the durable parent cannot be reached',
    )

    const lockedQuarantineSource = path.join(baseDir, 'locked-quarantine.part.mp4')
    fs.writeFileSync(lockedQuarantineSource, 'owned cleanup debt')
    const lockedQuarantineIdentity = tryReadFileIdentity(lockedQuarantineSource)
    ;(fs.promises as any).rm = async (...args: Parameters<typeof fs.promises.rm>) => {
      if (String(args[0]).includes('.arc-delete-')) {
        throw Object.assign(new Error('simulated persistent quarantine lock'), { code: 'EBUSY' })
      }
      return originalRm(...args)
    }
    try {
      await assert.rejects(
        removeFileWithRetry(lockedQuarantineSource, {
          expectedIdentity: lockedQuarantineIdentity,
          retryDelaysMs: [],
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY',
      )
    } finally {
      ;(fs.promises as any).rm = originalRm
    }
    assert.equal(
      tryReadFileIdentity(lockedQuarantineSource),
      lockedQuarantineIdentity,
      'a failed quarantine unlink must restore the durable original path',
    )
    await removeFileWithRetry(lockedQuarantineSource, { expectedIdentity: lockedQuarantineIdentity })
    assert.equal(fs.existsSync(lockedQuarantineSource), false)
    assert.equal(fs.readdirSync(baseDir).some(name => name.includes('locked-quarantine.part.mp4.arc-delete-')), false)

    if (process.platform === 'win32') {
      const retrySource = path.join(baseDir, 'retry.part.mp4')
      const retryFinal = path.join(baseDir, 'retry.mp4')
      fs.writeFileSync(retrySource, Buffer.alloc(8_192, 9))
      const retryLock = await holdExclusiveWindowsLock(retrySource, 800)
      let retries = 0
      await publishFileWithRetry(retrySource, retryFinal, {
        useHardLink: false,
        retryDelaysMs: [50, 100, 200, 300, 400, 500, 750],
        onRetry: () => { retries += 1 },
      })
      await retryLock.closed
      assert.ok(retries >= 1, 'the original Windows EBUSY rename scenario must be exercised')
      assert.equal(fs.existsSync(retrySource), false)
      assert.equal(fs.statSync(retryFinal).size, 8_192)

      const abortSource = path.join(baseDir, 'abort.part.mp4')
      const abortFinal = path.join(baseDir, 'abort.mp4')
      fs.writeFileSync(abortSource, Buffer.alloc(1_024, 3))
      const abortLock = await holdExclusiveWindowsLock(abortSource, 800)
      const controller = new AbortController()
      await assert.rejects(
        publishFileWithRetry(abortSource, abortFinal, {
          signal: controller.signal,
          useHardLink: false,
          retryDelaysMs: [1_000],
          onRetry: () => controller.abort(),
        }),
        (error: unknown) => error instanceof Error && error.name === 'AbortError',
      )
      await abortLock.closed
      assert.equal(fs.existsSync(abortSource), true, 'an aborted publication must retain its source')
      assert.equal(fs.existsSync(abortFinal), false)
    }

    console.log('Windows file publication lock regression test passed')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
