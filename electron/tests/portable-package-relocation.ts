import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import YAML from 'yaml'

import { DesktopBackend } from '../src/backend'
import { DEFAULT_CONFIG, normalizeConfigWithBase, saveConfigFile } from '../src/config'
import { SqliteStore } from '../src/db'
import { fileMatchesIdentity, tryReadFileIdentity } from '../src/utils'

type Failure = { name: string; error: unknown }

const ffmpeg = String(require('ffmpeg-static') || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

async function makeAvFixture(outputPath: string, durationSeconds = 2) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', String(durationSeconds),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    '-y', outputPath,
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || 'failed to create portable AV fixture')
  assert.ok(fs.statSync(outputPath).size > 0)
}

function requireIdentity(filePath: string) {
  const identity = tryReadFileIdentity(filePath)
  assert.ok(identity, `fixture must expose a stable filesystem identity: ${filePath}`)
  return identity
}

function createClipTask(db: SqliteStore, title: string) {
  return db.createClipTask({
    url: `fixture:${title}`,
    title,
    start_time: 0,
    end_time: 2,
  })
}

async function closeUnstartedBackend(backend: DesktopBackend | undefined) {
  if (!backend) return
  await backend.stop()
}

async function capture(failures: Failure[], name: string, assertion: () => void | Promise<void>) {
  try {
    await assertion()
  } catch (error) {
    failures.push({ name, error })
  }
}

async function testCopiedPackageRelocation(failures: Failure[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'replaycut-portable-artifacts-'))
  const oldBase = path.join(root, 'package-a')
  const copiedBase = path.join(root, 'package-b')
  const oldDownloads = path.join(oldBase, 'downloads')
  const oldClips = path.join(oldBase, 'clips')
  const copiedDownloads = path.join(copiedBase, 'downloads')
  const copiedClips = path.join(copiedBase, 'clips')
  let backend: DesktopBackend | undefined
  let restarted: DesktopBackend | undefined

  const paths = {
    replay: 'replay-completed.mp4',
    buildingPart: 'clip-building.part.mp4',
    buildingFinal: 'clip-building.mp4',
    verifiedPart: 'clip-verified.part.mp4',
    verifiedFinal: 'clip-verified.mp4',
    publishedPart: 'clip-published.part.mp4',
    publishedFinal: 'clip-published.mp4',
    cleanupPart: 'clip-cancelled.part.mp4',
    cleanupFinal: 'clip-cancelled.mp4',
  }

  try {
    await mkdir(oldDownloads, { recursive: true })
    await mkdir(oldClips, { recursive: true })
    const master = path.join(root, 'master.mp4')
    await makeAvFixture(master)

    await copyFile(master, path.join(oldDownloads, paths.replay))
    for (const name of [
      paths.buildingPart,
      paths.verifiedPart,
      paths.publishedPart,
      paths.publishedFinal,
      paths.cleanupPart,
      paths.cleanupFinal,
    ]) {
      await copyFile(master, path.join(oldClips, name))
    }

    const oldDbPath = path.join(oldBase, 'replays.db')
    const db = await SqliteStore.open(oldDbPath)
    db.ensureSchema(oldBase)
    const replayPathA = path.join(oldDownloads, paths.replay)
    const replaySize = fs.statSync(replayPathA).size
    const replayIdentityA = requireIdentity(replayPathA)
    db.insertReplay({
      replay_id: 91_001,
      live_key: 'portable-replay-completed',
      title: 'portable completed replay',
      start_time: 1_700_000_000,
      end_time: 1_700_000_002,
      duration: 2,
      actual_duration: 2,
      file_path: replayPathA,
      file_size: replaySize,
      output_identity: replayIdentityA,
      status: 'completed',
      progress: 100,
      verify_ok: true,
    })

    const buildingId = createClipTask(db, 'portable-building')
    const buildingPartA = path.join(oldClips, paths.buildingPart)
    const buildingIdentityA = requireIdentity(buildingPartA)
    db.updateClipTask(buildingId, {
      status: 'processing',
      progress: 85,
      file_path: path.join(oldClips, paths.buildingFinal),
      part_path: buildingPartA,
      artifact_state: 'building',
      artifact_identity: buildingIdentityA,
      part_identity: buildingIdentityA,
    })

    const verifiedId = createClipTask(db, 'portable-verified')
    const verifiedPartA = path.join(oldClips, paths.verifiedPart)
    const verifiedIdentityA = requireIdentity(verifiedPartA)
    db.updateClipTask(verifiedId, {
      status: 'error',
      progress: 99,
      file_path: path.join(oldClips, paths.verifiedFinal),
      part_path: verifiedPartA,
      artifact_state: 'verified',
      artifact_identity: verifiedIdentityA,
      part_identity: verifiedIdentityA,
    })

    const publishedId = createClipTask(db, 'portable-published-cleanup')
    const publishedFinalA = path.join(oldClips, paths.publishedFinal)
    const publishedPartA = path.join(oldClips, paths.publishedPart)
    db.updateClipTask(publishedId, {
      status: 'done',
      progress: 100,
      file_path: publishedFinalA,
      part_path: publishedPartA,
      artifact_state: 'published_cleanup',
      artifact_identity: requireIdentity(publishedFinalA),
      part_identity: requireIdentity(publishedPartA),
    })

    const cleanupId = createClipTask(db, 'portable-cleanup-pending')
    const cleanupFinalA = path.join(oldClips, paths.cleanupFinal)
    const cleanupPartA = path.join(oldClips, paths.cleanupPart)
    db.updateClipTask(cleanupId, {
      status: 'error',
      progress: 50,
      file_path: cleanupFinalA,
      part_path: cleanupPartA,
      artifact_state: 'cleanup_pending',
      artifact_identity: requireIdentity(cleanupFinalA),
      part_identity: requireIdentity(cleanupPartA),
    })
    db.setAppMetadata('application_base_dir', oldBase)
    await db.checkpoint()
    await db.close()

    const absoluteOldConfig = normalizeConfigWithBase(oldBase, structuredClone(DEFAULT_CONFIG))
    absoluteOldConfig.server.port = 0
    await writeFile(path.join(oldBase, 'config.yaml'), YAML.stringify(absoluteOldConfig), 'utf8')

    await mkdir(copiedDownloads, { recursive: true })
    await mkdir(copiedClips, { recursive: true })
    await copyFile(path.join(oldBase, 'replays.db'), path.join(copiedBase, 'replays.db'))
    await copyFile(path.join(oldBase, 'config.yaml'), path.join(copiedBase, 'config.yaml'))
    await copyFile(replayPathA, path.join(copiedDownloads, paths.replay))
    for (const name of [
      paths.buildingPart,
      paths.verifiedPart,
      paths.publishedPart,
      paths.publishedFinal,
      paths.cleanupPart,
      paths.cleanupFinal,
    ]) {
      await copyFile(path.join(oldClips, name), path.join(copiedClips, name))
    }

    backend = await DesktopBackend.create(copiedBase)
    assert.equal(backend.config.database.dsn, path.join(copiedBase, 'replays.db'))
    assert.equal(backend.config.download.output_dir, copiedDownloads)
    assert.equal(backend.config.download.clip_output_dir, copiedClips)
    await (backend as any).recoverPortableOutputPaths()
    await backend.db.checkpoint()

    const replayPathB = path.join(copiedDownloads, paths.replay)
    const replayIdentityB = requireIdentity(replayPathB)
    const replay = backend.db.getReplayByLiveKey(copiedBase, 'portable-replay-completed')
    await capture(failures, 'completed replay is rebound to copied output identity', () => {
      assert.ok(replay)
      assert.equal(replay.file_path, replayPathB)
      assert.equal(replay.output_identity, replayIdentityB)
      assert.notEqual(replay.output_identity, replayIdentityA)
      assert.equal(replay.portable_relocation_pending, false)
      assert.equal(replay.status, 'completed')
    })

    const building = backend.db.getClipTaskById(buildingId)
    const buildingPartB = path.join(copiedClips, paths.buildingPart)
    await capture(failures, 'building clip is rebound without trusting its reserved final path', () => {
      const identity = requireIdentity(buildingPartB)
      assert.ok(building)
      assert.equal(building.file_path, path.join(copiedClips, paths.buildingFinal))
      assert.equal(building.part_path, buildingPartB)
      assert.equal(building.artifact_state, 'building')
      assert.equal(building.artifact_identity, identity)
      assert.equal(building.part_identity, identity)
      assert.notEqual(identity, buildingIdentityA)
      assert.equal(building.portable_relocation_pending, false)
    })

    const verified = backend.db.getClipTaskById(verifiedId)
    const verifiedPartB = path.join(copiedClips, paths.verifiedPart)
    await capture(failures, 'verified clip is rebound to the copied verified part', () => {
      const identity = requireIdentity(verifiedPartB)
      assert.ok(verified)
      assert.equal(verified.file_path, path.join(copiedClips, paths.verifiedFinal))
      assert.equal(verified.part_path, verifiedPartB)
      assert.equal(verified.artifact_state, 'verified')
      assert.equal(verified.artifact_identity, identity)
      assert.equal(verified.part_identity, identity)
      assert.notEqual(identity, verifiedIdentityA)
      assert.equal(verified.portable_relocation_pending, false)
    })

    const publishedFinalB = path.join(copiedClips, paths.publishedFinal)
    const publishedPartB = path.join(copiedClips, paths.publishedPart)
    const published = backend.db.getClipTaskById(publishedId)
    await capture(failures, 'published cleanup keeps the copied final and removes only the proven copied part', () => {
      assert.ok(published)
      assert.equal(published.status, 'done')
      assert.equal(published.file_path, publishedFinalB)
      assert.equal(published.artifact_identity, requireIdentity(publishedFinalB))
      assert.equal(published.part_path, '')
      assert.equal(published.part_identity, '')
      assert.equal(published.artifact_state, '')
      assert.equal(published.portable_relocation_pending, false)
      assert.equal(fs.existsSync(publishedPartB), false)
    })

    const cleanupFinalB = path.join(copiedClips, paths.cleanupFinal)
    const cleanupPartB = path.join(copiedClips, paths.cleanupPart)
    const cleanup = backend.db.getClipTaskById(cleanupId)
    await capture(failures, 'dual-path cleanup debt receives separate copied final and part identities', () => {
      const finalIdentity = requireIdentity(cleanupFinalB)
      const partIdentity = requireIdentity(cleanupPartB)
      assert.notEqual(finalIdentity, partIdentity, 'package copy creates two independently owned directory entries')
      assert.ok(cleanup)
      assert.equal(cleanup.file_path, cleanupFinalB)
      assert.equal(cleanup.part_path, cleanupPartB)
      assert.equal(cleanup.artifact_state, 'cleanup_pending')
      assert.equal(cleanup.artifact_identity, finalIdentity)
      assert.equal(cleanup.part_identity, partIdentity)
      assert.equal(cleanup.portable_relocation_pending, false)
      assert.equal(fs.existsSync(cleanupFinalB), true)
      assert.equal(fs.existsSync(cleanupPartB), true)
    })

    const trustedReplayIdentity = replay?.output_identity || ''
    const trustedPublishedIdentity = published?.artifact_identity || ''
    await closeUnstartedBackend(backend)
    backend = undefined

    await rm(replayPathB, { force: true })
    await copyFile(replayPathA, replayPathB)
    await rm(publishedFinalB, { force: true })
    await copyFile(publishedFinalA, publishedFinalB)
    const replacementReplayIdentity = requireIdentity(replayPathB)
    const replacementPublishedIdentity = requireIdentity(publishedFinalB)
    assert.notEqual(replacementReplayIdentity, trustedReplayIdentity)
    assert.notEqual(replacementPublishedIdentity, trustedPublishedIdentity)

    restarted = await DesktopBackend.create(copiedBase)
    restarted.config.server.port = 0
    await restarted.listen()
    await restarted.waitForStartupReconciliation()
    const replayAfterReplacement = restarted.db.getReplayByLiveKey(copiedBase, 'portable-replay-completed')
    const publishedAfterReplacement = restarted.db.getClipTaskById(publishedId)
    await capture(failures, 'same-path replay replacement is not silently re-adopted on a later restart', () => {
      assert.ok(replayAfterReplacement)
      assert.equal(replayAfterReplacement.output_identity, trustedReplayIdentity)
      assert.equal(replayAfterReplacement.portable_relocation_pending, false)
      assert.equal(fileMatchesIdentity(replayPathB, replayAfterReplacement.output_identity), false)
      assert.equal(replayAfterReplacement.output_state, 'ownership_changed')
    })
    await capture(failures, 'same-path clip replacement is not silently re-adopted on a later restart', () => {
      assert.ok(publishedAfterReplacement)
      assert.equal(publishedAfterReplacement.artifact_identity, trustedPublishedIdentity)
      assert.equal(publishedAfterReplacement.portable_relocation_pending, false)
      assert.equal(fileMatchesIdentity(publishedFinalB, publishedAfterReplacement.artifact_identity), false)
      assert.equal(publishedAfterReplacement.status, 'error')
      assert.match(publishedAfterReplacement.message, /ownership changed/)
    })

    const persistedConfig = YAML.parse(await readFile(path.join(copiedBase, 'config.yaml'), 'utf8')) as typeof DEFAULT_CONFIG
    assert.equal(persistedConfig.database.dsn, 'replays.db')
    assert.equal(persistedConfig.download.output_dir, 'downloads')
    assert.equal(persistedConfig.download.clip_output_dir, 'clips')
  } finally {
    await closeUnstartedBackend(restarted).catch(() => undefined)
    await closeUnstartedBackend(backend).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

async function testChangedClipOutputDirectory(failures: Failure[]) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'replaycut-changed-clip-dir-'))
  const oldClipDir = path.join(baseDir, 'clips-old')
  const newClipDir = path.join(baseDir, 'clips-new')
  const partPath = path.join(oldClipDir, 'durable-verified.part.mp4')
  const finalPath = path.join(oldClipDir, 'durable-verified.mp4')
  let backend: DesktopBackend | undefined

  try {
    await makeAvFixture(partPath)
    await mkdir(newClipDir, { recursive: true })
    const identity = requireIdentity(partPath)
    const db = await SqliteStore.open(path.join(baseDir, 'replays.db'))
    db.ensureSchema(baseDir)
    const taskId = createClipTask(db, 'durable-old-output-directory')
    db.updateClipTask(taskId, {
      status: 'error',
      progress: 99,
      file_path: finalPath,
      part_path: partPath,
      artifact_state: 'verified',
      artifact_identity: identity,
      part_identity: identity,
    })
    db.setAppMetadata('application_base_dir', baseDir)
    await db.checkpoint()
    await db.close()

    const movedConfig = normalizeConfigWithBase(baseDir, structuredClone(DEFAULT_CONFIG))
    movedConfig.server.port = 0
    movedConfig.download.clip_output_dir = newClipDir
    await saveConfigFile(baseDir, path.join(baseDir, 'config.yaml'), movedConfig)

    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    await backend.listen()
    await backend.waitForStartupReconciliation()
    const whileChanged = backend.db.getClipTaskById(taskId)
    await capture(failures, 'changing clip_output_dir still publishes the old durable artifact by identity', () => {
      assert.ok(whileChanged)
      assert.equal(whileChanged.status, 'done')
      assert.equal(whileChanged.file_path, finalPath)
      assert.equal(whileChanged.part_path, '')
      assert.equal(whileChanged.artifact_state, '')
      assert.equal(whileChanged.artifact_identity, identity)
      assert.equal(whileChanged.part_identity, '')
      assert.equal(fileMatchesIdentity(finalPath, identity), true)
      assert.equal(fs.existsSync(partPath), false)
      assert.doesNotMatch(whileChanged.message, /outside the currently configured clip directory/)
      assert.match(whileChanged.message, /completed publication after restart/)
    })
    await backend.stop()
    backend = undefined

    const restoredConfig = normalizeConfigWithBase(baseDir, structuredClone(DEFAULT_CONFIG))
    restoredConfig.server.port = 0
    restoredConfig.download.clip_output_dir = oldClipDir
    await saveConfigFile(baseDir, path.join(baseDir, 'config.yaml'), restoredConfig)
    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    await backend.listen()
    await backend.waitForStartupReconciliation()
    const afterRestore = backend.db.getClipTaskById(taskId)
    await capture(failures, 'restoring clip_output_dir keeps the already-published durable task stable', () => {
      assert.ok(afterRestore)
      assert.equal(afterRestore.status, 'done')
      assert.equal(afterRestore.file_path, finalPath)
      assert.equal(afterRestore.part_path, '')
      assert.equal(afterRestore.artifact_state, '')
      assert.equal(afterRestore.artifact_identity, identity)
      assert.equal(afterRestore.part_identity, '')
      assert.equal(fileMatchesIdentity(finalPath, identity), true)
      assert.equal(fs.existsSync(partPath), false)
      assert.doesNotMatch(afterRestore.message, /outside the currently configured clip directory/)
    })
  } finally {
    await backend?.stop().catch(() => undefined)
    await rm(baseDir, { recursive: true, force: true })
  }
}

async function testUnresolvedCopyNeverMutatesOldPackage(failures: Failure[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'replaycut-unresolved-portable-'))
  const oldBase = path.join(root, 'package-a')
  const copiedBase = path.join(root, 'package-b')
  const oldDownloads = path.join(oldBase, 'downloads')
  const oldClips = path.join(oldBase, 'clips')
  let backend: DesktopBackend | undefined
  try {
    await mkdir(oldDownloads, { recursive: true })
    await mkdir(oldClips, { recursive: true })
    await mkdir(path.join(copiedBase, 'downloads'), { recursive: true })
    await mkdir(path.join(copiedBase, 'clips'), { recursive: true })
    const master = path.join(root, 'master.mp4')
    await makeAvFixture(master)

    const replayFinalA = path.join(oldDownloads, 'cleanup-final.mp4')
    const replayCleanupA = path.join(oldDownloads, 'cleanup-final.part.mp4')
    const replayActiveA = path.join(oldDownloads, 'active.part.mp4')
    const clipFinalA = path.join(oldClips, 'cancelled.mp4')
    const clipPartA = path.join(oldClips, 'cancelled.part.mp4')
    for (const target of [replayFinalA, replayCleanupA, replayActiveA, clipFinalA, clipPartA]) {
      await copyFile(master, target)
    }

    const db = await SqliteStore.open(path.join(oldBase, 'replays.db'))
    db.ensureSchema(oldBase)
    db.insertReplay({
      replay_id: 92_001,
      live_key: 'unresolved-completed-cleanup',
      title: 'unresolved completed cleanup',
      duration: 2,
      actual_duration: 2,
      file_path: replayFinalA,
      cleanup_part_path: replayCleanupA,
      output_identity: requireIdentity(replayFinalA),
      cleanup_part_identity: requireIdentity(replayCleanupA),
      file_size: fs.statSync(replayFinalA).size,
      status: 'completed',
      progress: 100,
      verify_ok: true,
    })
    db.insertReplay({
      replay_id: 92_002,
      live_key: 'unresolved-active-replay',
      title: 'unresolved active replay',
      duration: 2,
      recoverable_part_path: replayActiveA,
      recoverable_state: 'complete_unverified',
      output_identity: requireIdentity(replayActiveA),
      status: 'merging',
      progress: 99,
    })
    const cleanupTaskId = createClipTask(db, 'unresolved-cleanup-pending')
    db.updateClipTask(cleanupTaskId, {
      status: 'processing',
      progress: 50,
      file_path: clipFinalA,
      part_path: clipPartA,
      artifact_state: 'cleanup_pending',
      artifact_identity: requireIdentity(clipFinalA),
      part_identity: requireIdentity(clipPartA),
    })
    db.setAppMetadata('application_base_dir', oldBase)
    await db.checkpoint()
    await db.close()

    const oldConfig = normalizeConfigWithBase(oldBase, structuredClone(DEFAULT_CONFIG))
    oldConfig.server.port = 0
    await writeFile(path.join(oldBase, 'config.yaml'), YAML.stringify(oldConfig), 'utf8')
    await copyFile(path.join(oldBase, 'replays.db'), path.join(copiedBase, 'replays.db'))
    await copyFile(path.join(oldBase, 'config.yaml'), path.join(copiedBase, 'config.yaml'))

    // Deliberately omit every artifact from package B. The old package remains
    // reachable, so this catches accidental cleanup/resume against A.
    backend = await DesktopBackend.create(copiedBase)
    backend.config.server.port = 0
    await backend.listen()
    await backend.waitForStartupReconciliation()

    await capture(failures, 'unresolved portable cleanup debt never deletes the old package', () => {
      for (const oldPath of [replayFinalA, replayCleanupA, replayActiveA, clipFinalA, clipPartA]) {
        assert.equal(fs.existsSync(oldPath), true, `old package artifact was mutated: ${oldPath}`)
      }
      const completed = backend!.db.getReplaySummaryByLiveKey(copiedBase, 'unresolved-completed-cleanup')
      assert.equal(completed?.portable_relocation_pending, true)
      assert.equal(completed?.output_state, 'unknown', 'unresolved copied output must not be exposed as playable')
      assert.equal(completed?.file_path, path.join(copiedBase, 'downloads', path.basename(replayFinalA)))
      assert.equal(completed?.cleanup_part_path, path.join('downloads', path.basename(replayCleanupA)))
      const active = backend!.db.getReplaySummaryByLiveKey(copiedBase, 'unresolved-active-replay')
      assert.equal(active?.portable_relocation_pending, true)
      assert.equal(active?.status, 'paused')
      assert.equal(active?.recoverable_part_path, path.join('downloads', path.basename(replayActiveA)))
      assert.match(active?.message || '', /relocation is incomplete/i)
      const clip = backend!.db.getClipTaskById(cleanupTaskId)
      assert.equal(clip?.portable_relocation_pending, true)
      assert.equal(clip?.artifact_state, 'cleanup_pending')
      assert.equal(clip?.file_path, path.join(copiedBase, 'clips', path.basename(clipFinalA)))
      assert.equal(clip?.part_path, path.join(copiedBase, 'clips', path.basename(clipPartA)))
      assert.match(clip?.message || '', /relocation is incomplete/i)
    })
  } finally {
    await backend?.stop().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

async function main() {
  const failures: Failure[] = []
  await testCopiedPackageRelocation(failures)
  await testChangedClipOutputDirectory(failures)
  await testUnresolvedCopyNeverMutatesOldPackage(failures)
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n[portable relocation failure] ${failure.name}`)
      console.error(failure.error)
    }
    throw new AggregateError(failures.map(failure => failure.error), `${failures.length} portable relocation regression(s) failed`)
  }
  console.log('portable package artifact relocation regression tests passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
