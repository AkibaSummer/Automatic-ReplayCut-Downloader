import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'
import { REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX } from '../src/db'
import { tryReadFileIdentity } from '../src/utils'

async function waitForBackground(backend: DesktopBackend) {
  const promise = (backend as any).clipOutputReconciliationPromise as Promise<void> | null
  if (promise) await promise
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'external-reconciliation-app-'))
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'external-reconciliation-media-'))
  let backend: DesktopBackend | undefined
  try {
    const replayPath = path.join(externalDir, 'legacy-replay.mp4')
    const clipPath = path.join(externalDir, 'legacy-clip.mp4')
    await writeFile(replayPath, 'legacy external replay')
    await writeFile(clipPath, 'legacy external clip')

    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    backend.config.download.output_dir = externalDir
    backend.config.download.clip_output_dir = externalDir
    const now = new Date().toISOString()
    backend.db.prepare(
      `INSERT INTO bilibili_replays
       (created_at, updated_at, replay_id, live_key, title, duration, status, file_path,
        output_identity, legacy_identity_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1)`,
    ).run(now, now, 88771, 'external-legacy-replay', 'external legacy replay', 1, 'completed', replayPath)
    const clipTaskId = backend.db.createClipTask({
      url: 'fixture:external-legacy',
      title: 'external legacy clip',
      start_time: 0,
      end_time: 1,
    })
    backend.db.updateClipTask(clipTaskId, {
      status: 'done',
      progress: 100,
      file_path: clipPath,
      artifact_identity: '',
      legacy_identity_pending: true,
    } as any)

    const baseURL = await backend.listen()
    await backend.waitForStartupReconciliation()
    assert.equal(
      backend.db.getReplaySummaryByLiveKey(baseDir, 'external-legacy-replay')?.output_identity,
      '',
      'first-window reconciliation must not block on external legacy paths',
    )
    assert.equal(
      backend.db.getClipTaskById(clipTaskId)?.output_state,
      'unknown',
      'a legacy clip identity awaiting background adoption must not be reported as playable',
    )
    const replayBeforeBackground = backend.db.prepare(
      'SELECT status, file_path, output_identity, legacy_identity_pending FROM bilibili_replays WHERE live_key = ?',
    ).get<{ status: string; file_path: string; output_identity: string; legacy_identity_pending: number }>('external-legacy-replay')
    assert.deepEqual(replayBeforeBackground, {
      status: 'completed',
      file_path: replayPath,
      output_identity: '',
      legacy_identity_pending: 1,
    })
    assert.ok(fs.statSync(replayPath).isFile() && fs.statSync(replayPath).size > 0)

    const originalAdopt = backend.db.adoptLegacyOutputIdentitiesAsync.bind(backend.db)
    let adoptionCalls = 0
    let adoptionCount = -1
    ;(backend.db as any).adoptLegacyOutputIdentitiesAsync = async (...args: unknown[]) => {
      adoptionCalls += 1
      adoptionCount = await (originalAdopt as any)(...args)
      return adoptionCount
    }
    assert.equal((backend as any).clipOutputReconciliationPromise, null)
    assert.equal((backend as any).lastClipOutputReconciliationAt, 0)
    const response = await fetch(`${baseURL}/api/replays`)
    assert.equal(response.status, 200)
    assert.ok((backend as any).lastClipOutputReconciliationAt > 0, 'GET /api/replays must schedule background reconciliation')
    await waitForBackground(backend)
    assert.equal(adoptionCalls, 1)
    assert.equal(adoptionCount, 2)

    const replayRawAfterAdoption = backend.db.prepare(
      'SELECT output_identity, legacy_identity_pending FROM bilibili_replays WHERE live_key = ?',
    ).get<{ output_identity: string; legacy_identity_pending: number }>('external-legacy-replay')
    assert.equal(replayRawAfterAdoption?.legacy_identity_pending, 0)

    const adoptedReplayIdentity = tryReadFileIdentity(replayPath)
    const adoptedClipIdentity = tryReadFileIdentity(clipPath)
    assert.equal(
      replayRawAfterAdoption?.output_identity,
      adoptedReplayIdentity,
      'background reconciliation must adopt a configured external replay identity',
    )
    assert.equal(backend.db.getClipTaskById(clipTaskId)?.artifact_identity, adoptedClipIdentity)
    assert.equal(backend.db.getClipTaskById(clipTaskId)?.output_state, 'available')

    backend.databaseMaintenance = true
    try {
      const maintenanceTasks = await (await fetch(`${baseURL}/api/clip/tasks`)).json() as Array<Record<string, any>>
      assert.equal(
        maintenanceTasks.find(task => task.id === clipTaskId)?.output_state,
        'unknown',
        'the clip task protocol must suppress green completion while output maintenance is active',
      )
    } finally {
      backend.databaseMaintenance = false
    }
    backend.db.updateClipTask(clipTaskId, { portable_relocation_pending: true })
    assert.equal(
      backend.db.getClipTaskById(clipTaskId)?.output_state,
      'unknown',
      'an unresolved copied-package clip path must remain non-playable until relocation is verified',
    )
    backend.db.updateClipTask(clipTaskId, { portable_relocation_pending: false })
    assert.equal(backend.db.getClipTaskById(clipTaskId)?.output_state, 'available')

    await rename(replayPath, `${replayPath}.old`)
    await rename(clipPath, `${clipPath}.old`)
    await writeFile(replayPath, 'foreign replacement replay')
    await writeFile(clipPath, 'foreign replacement clip')
    assert.notEqual(tryReadFileIdentity(replayPath), adoptedReplayIdentity)
    assert.notEqual(tryReadFileIdentity(clipPath), adoptedClipIdentity)

    ;(backend as any).lastClipOutputReconciliationAt = 0
    backend.scheduleClipOutputReconciliation()
    await waitForBackground(backend)

    const changedReplay = backend.db.getReplaySummaryByLiveKey(baseDir, 'external-legacy-replay')
    assert.equal(changedReplay?.output_state, 'ownership_changed')
    assert.ok(changedReplay?.message.startsWith(REPLAY_OUTPUT_OWNERSHIP_CHANGED_PREFIX))
    const changedClip = backend.db.getClipTaskById(clipTaskId)
    assert.equal(changedClip?.status, 'error')
    assert.equal(changedClip?.output_state, 'ownership_changed')
    assert.match(changedClip?.message || '', /ownership changed/i)
    assert.equal(fs.readFileSync(replayPath, 'utf8'), 'foreign replacement replay')
    assert.equal(fs.readFileSync(clipPath, 'utf8'), 'foreign replacement clip')

    await rm(replayPath, { force: true })
    await rm(clipPath, { force: true })
    await rename(`${replayPath}.old`, replayPath)
    await rename(`${clipPath}.old`, clipPath)
    assert.equal(tryReadFileIdentity(replayPath), adoptedReplayIdentity)
    assert.equal(tryReadFileIdentity(clipPath), adoptedClipIdentity)
    ;(backend as any).lastClipOutputReconciliationAt = 0
    backend.scheduleClipOutputReconciliation()
    await waitForBackground(backend)
    const restoredReplay = backend.db.getReplaySummaryByLiveKey(baseDir, 'external-legacy-replay')
    const restoredClip = backend.db.getClipTaskById(clipTaskId)
    assert.equal(restoredReplay?.output_state, 'available')
    assert.equal(restoredReplay?.message, '')
    assert.equal(restoredClip?.status, 'done')
    assert.equal(restoredClip?.output_state, 'available')
    assert.equal(restoredClip?.message, '')
    assert.equal(restoredClip?.artifact_identity, adoptedClipIdentity)

    const racePath = path.join(externalDir, 'delete-during-background-scan.mp4')
    await writeFile(racePath, 'owned race output')
    const raceIdentity = tryReadFileIdentity(racePath)
    assert.ok(raceIdentity)
    backend.db.insertReplay({
      replay_id: 88_772,
      live_key: 'delete-during-background-scan',
      title: 'delete during background scan',
      duration: 1,
      status: 'completed',
      progress: 100,
      file_path: racePath,
      output_identity: raceIdentity,
      file_size: fs.statSync(racePath).size,
    })
    const originalAsyncStat = fs.promises.stat.bind(fs.promises)
    let releaseScan!: () => void
    let markScanEntered!: () => void
    const scanEntered = new Promise<void>(resolve => { markScanEntered = resolve })
    const scanRelease = new Promise<void>(resolve => { releaseScan = resolve })
    let blockedOnce = false
    ;(fs.promises as any).stat = async (candidate: string, ...args: unknown[]) => {
      if (!blockedOnce && path.resolve(String(candidate)) === path.resolve(racePath)) {
        blockedOnce = true
        markScanEntered()
        await scanRelease
      }
      return (originalAsyncStat as any)(candidate, ...args)
    }
    try {
      ;(backend as any).lastClipOutputReconciliationAt = 0
      backend.scheduleClipOutputReconciliation()
      await scanEntered
      const deleteResponse = await fetch(`${baseURL}/api/replays/delete-during-background-scan/delete-file`, {
        method: 'POST',
      })
      assert.equal(deleteResponse.status, 200)
      releaseScan()
      await waitForBackground(backend)
    } finally {
      releaseScan?.()
      ;(fs.promises as any).stat = originalAsyncStat
    }
    const raceDeleted = backend.db.getReplaySummaryByLiveKey(baseDir, 'delete-during-background-scan')
    assert.equal(raceDeleted?.status, 'deleted')
    assert.equal(raceDeleted?.message, 'Local file deleted')
    assert.equal(raceDeleted?.output_identity, '')
    assert.equal(fs.existsSync(racePath), false)

    console.log('external output background reconciliation tests passed')
  } finally {
    await backend?.stop().catch(() => undefined)
    await rm(baseDir, { recursive: true, force: true })
    await rm(externalDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
