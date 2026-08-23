import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'
import {
  CLIP_TEMP_SENTINEL,
  CLIP_TEMP_SENTINEL_CONTENT,
  REPLAY_TEMP_SENTINEL,
  replayTempSentinelContent,
  tryReadDirectoryIdentity,
  tryReadFileIdentity,
} from '../src/utils'

function quarantineTombstone(originalPath: string, identity: string) {
  const ownershipHash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(
    path.dirname(originalPath),
    `.${path.basename(originalPath)}.arc-delete-${ownershipHash}.tomb-${randomBytes(16).toString('hex')}`,
  )
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'temp-directory-recovery-'))
  let backend: DesktopBackend | undefined
  try {
    const tempRoot = path.join(baseDir, 'temp')
    await mkdir(tempRoot, { recursive: true })

    const replayOriginal = path.join(tempRoot, 'replay-Ab12Cd')
    await mkdir(replayOriginal)
    await writeFile(
      path.join(replayOriginal, REPLAY_TEMP_SENTINEL),
      replayTempSentinelContent('owned-replay', 0),
    )
    await writeFile(path.join(replayOriginal, 'locked.ts'), 'owned partial directory')
    const replayIdentity = tryReadDirectoryIdentity(replayOriginal)
    assert.ok(replayIdentity)
    const replayTombstone = quarantineTombstone(replayOriginal, replayIdentity)
    await fs.promises.rename(replayOriginal, replayTombstone)
    // Model recursive rm having removed the sentinel before Windows reported a
    // locked child. The tombstone name is now the only durable ownership proof.
    await rm(path.join(replayTombstone, REPLAY_TEMP_SENTINEL), { force: true })

    // A foreign object may claim the old plain name before restart. Recovery
    // must remove only the identity-matched tombstone and preserve this one.
    await mkdir(replayOriginal)
    await writeFile(path.join(replayOriginal, 'foreign.txt'), 'foreign directory')
    const foreignIdentity = tryReadDirectoryIdentity(replayOriginal)
    assert.ok(foreignIdentity && foreignIdentity !== replayIdentity)

    const clipPlain = path.join(tempRoot, 'clip-Xy91Qz')
    await mkdir(clipPlain)
    await writeFile(path.join(clipPlain, CLIP_TEMP_SENTINEL), CLIP_TEMP_SENTINEL_CONTENT)
    await writeFile(path.join(clipPlain, 'segment.mp4'), 'owned clip temp')

    const nestedOriginal = path.join(tempRoot, 'clip-Ns82Lm')
    await mkdir(nestedOriginal)
    await writeFile(path.join(nestedOriginal, CLIP_TEMP_SENTINEL), CLIP_TEMP_SENTINEL_CONTENT)
    await writeFile(path.join(nestedOriginal, 'locked.mp4'), 'old nested cleanup debt')
    const nestedIdentity = tryReadDirectoryIdentity(nestedOriginal)
    assert.ok(nestedIdentity)
    const nestedHash = createHash('sha256').update(nestedIdentity).digest('hex').slice(0, 16)
    const nestedTombstone = path.join(
      tempRoot,
      `..${path.basename(nestedOriginal)}.arc-delete-${nestedHash}.arc-delete-${nestedHash}.tomb-${randomBytes(16).toString('hex')}`,
    )
    await fs.promises.rename(nestedOriginal, nestedTombstone)
    await rm(path.join(nestedTombstone, CLIP_TEMP_SENTINEL), { force: true })

    // A quarantine directory copied to another volume has a new inode while
    // its old identity hash remains in the name. Its intact sentinel is the
    // proof that permits adopting and cleaning the copied directory.
    const copiedQuarantine = path.join(tempRoot, '.replay-Cp91Xz.arc-delete-0000000000000000')
    await mkdir(copiedQuarantine)
    await writeFile(
      path.join(copiedQuarantine, REPLAY_TEMP_SENTINEL),
      replayTempSentinelContent('copied-quarantine', 2),
    )
    await writeFile(path.join(copiedQuarantine, 'copied.ts'), 'copied cleanup debt')

    const mixedOriginal = path.join(tempRoot, 'replay-Mx71Qa')
    await mkdir(mixedOriginal)
    await writeFile(
      path.join(mixedOriginal, REPLAY_TEMP_SENTINEL),
      replayTempSentinelContent('mixed-quarantine', 3),
    )
    await writeFile(path.join(mixedOriginal, 'locked.ts'), 'mixed old/new cleanup debt')
    const mixedIdentity = tryReadDirectoryIdentity(mixedOriginal)
    assert.ok(mixedIdentity)
    const mixedCurrentHash = createHash('sha256').update(mixedIdentity).digest('hex').slice(0, 16)
    const mixedTombstone = path.join(
      tempRoot,
      `..${path.basename(mixedOriginal)}.arc-delete-0000000000000000.arc-delete-${mixedCurrentHash}.tomb-${randomBytes(16).toString('hex')}`,
    )
    await fs.promises.rename(mixedOriginal, mixedTombstone)
    await rm(path.join(mixedTombstone, REPLAY_TEMP_SENTINEL), { force: true })

    backend = await DesktopBackend.create(baseDir)
    backend.config.server.port = 0
    backend.config.download.temp_dir = tempRoot

    const verifiedPart = path.join(baseDir, 'verified-before-start.part.mp4')
    const verifiedFinal = path.join(baseDir, 'verified-before-start.mp4')
    await writeFile(verifiedPart, 'durable verified clip')
    const verifiedFileIdentity = tryReadFileIdentity(verifiedPart)
    assert.ok(verifiedFileIdentity)
    const clipTaskId = backend.db.createClipTask({
      url: 'fixture:startup-stage',
      title: 'startup-stage',
      start_time: 0,
      end_time: 1,
    })
    backend.db.updateClipTask(clipTaskId, {
      status: 'processing',
      progress: 99,
      file_path: verifiedFinal,
      part_path: verifiedPart,
      artifact_state: 'verified',
      artifact_identity: verifiedFileIdentity,
      part_identity: verifiedFileIdentity,
    })
    const now = new Date().toISOString()
    backend.db.prepare(
      `INSERT INTO bilibili_replays
       (created_at, updated_at, replay_id, live_key, title, duration, status, file_path, output_identity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, now, 99881, 'startup-stage-replay', 'startup-stage-replay', 1, 'completed', 'missing-output.mp4', 'v1:missing:test')
    ;(backend as any).recoverPortableOutputPaths = async () => {
      throw new Error('simulated portable stage failure')
    }
    await backend.listen()
    await backend.waitForStartupReconciliation()

    assert.equal(fs.existsSync(replayTombstone), false, 'sentinel-lost tombstone must be reclaimed on restart')
    assert.equal(fs.readFileSync(path.join(replayOriginal, 'foreign.txt'), 'utf8'), 'foreign directory')
    assert.equal(
      tryReadDirectoryIdentity(replayOriginal),
      foreignIdentity,
      'a replacement at the original name must never be removed',
    )
    assert.equal(fs.existsSync(clipPlain), false, 'plain app-owned temp directory must still be reclaimed')
    assert.equal(fs.existsSync(nestedTombstone), false, 'nested quarantine debt from an older release must be reclaimed')
    assert.equal(fs.existsSync(copiedQuarantine), false, 'copied quarantine with a valid sentinel must be reclaimed')
    assert.equal(fs.existsSync(mixedTombstone), false, 'mixed old/new hash tombstone must remain restart-recoverable')
    const recoveredClip = backend.db.getClipTaskById(clipTaskId)
    assert.equal(recoveredClip?.status, 'done')
    assert.equal(recoveredClip?.artifact_state, '')
    assert.equal(recoveredClip?.part_path, '')
    assert.equal(recoveredClip?.file_path, verifiedFinal)
    assert.equal(fs.existsSync(verifiedFinal), true)
    assert.equal(fs.existsSync(verifiedPart), false)
    assert.equal(
      backend.db.getReplaySummaryByLiveKey(baseDir, 'startup-stage-replay')?.output_state,
      'unavailable',
      'a portable-stage failure must not skip later replay availability healing',
    )

    console.log('sentinel-lost temp directory restart recovery tests passed')
  } finally {
    await backend?.stop().catch(() => undefined)
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
