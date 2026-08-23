import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'disk-stats-performance-'))
  const backend = await DesktopBackend.create(baseDir)
  const outputDir = path.join(baseDir, 'large-output-tree')
  const tempDir = path.join(baseDir, 'inaccessible-temp-tree')
  const clipDir = path.join(baseDir, 'large-clip-tree')

  try {
    await Promise.all([
      mkdir(path.join(outputDir, 'nested', 'many', 'levels'), { recursive: true }),
      mkdir(path.join(tempDir, 'must-not-be-opened'), { recursive: true }),
      mkdir(path.join(clipDir, 'nested'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(outputDir, 'nested', 'many', 'levels', 'large.mp4'), 'not scanned'),
      writeFile(path.join(tempDir, 'must-not-be-opened', 'segment.ts'), 'not scanned'),
      writeFile(path.join(clipDir, 'nested', 'clip.mp4'), 'not scanned'),
    ])

    backend.config.download.output_dir = outputDir
    backend.config.download.temp_dir = tempDir
    backend.config.download.clip_output_dir = clipDir

    backend.db.insertReplay({
      replay_id: 1,
      live_key: 'known-output-a',
      file_path: path.join(outputDir, 'known-a.mp4'),
      file_size: 4_096,
      status: 'completed',
    })
    backend.db.insertReplay({
      replay_id: 2,
      live_key: 'known-output-b',
      file_path: path.join(outputDir, 'known-b.mp4'),
      file_size: 8_192,
      status: 'completed',
    })
    backend.db.insertReplay({
      replay_id: 3,
      live_key: 'no-owned-path',
      file_path: '',
      file_size: 16_384,
      status: 'completed',
    })
    backend.db.insertReplay({
      replay_id: 4,
      live_key: 'soft-deleted',
      file_path: path.join(outputDir, 'deleted.mp4'),
      file_size: 32_768,
      status: 'deleted',
    })
    backend.db.prepare('UPDATE bilibili_replays SET deleted_at = ? WHERE live_key = ?')
      .run(new Date().toISOString(), 'soft-deleted')

    const originalReaddir = fsp.readdir
    const originalOpendir = fsp.opendir
    const originalStat = fsp.stat
    const originalReaddirSync = fs.readdirSync
    const originalStatSync = fs.statSync
    const forbiddenCalls: string[] = []
    const rejectTreeAccess = (operation: string, target: unknown): never => {
      const rendered = String(target)
      forbiddenCalls.push(`${operation}:${rendered}`)
      throw Object.assign(new Error(`fixture directory is inaccessible: ${rendered}`), { code: 'EACCES' })
    }

    ;(fsp as any).readdir = async (target: unknown) => rejectTreeAccess('readdir', target)
    ;(fsp as any).opendir = async (target: unknown) => rejectTreeAccess('opendir', target)
    ;(fsp as any).stat = async (target: unknown) => rejectTreeAccess('stat', target)
    ;(fs as any).readdirSync = (target: unknown) => rejectTreeAccess('readdirSync', target)
    ;(fs as any).statSync = (target: unknown) => rejectTreeAccess('statSync', target)

    let stats: Awaited<ReturnType<DesktopBackend['getDiskStats']>>
    try {
      stats = await backend.getDiskStats()
    } finally {
      ;(fsp as any).readdir = originalReaddir
      ;(fsp as any).opendir = originalOpendir
      ;(fsp as any).stat = originalStat
      ;(fs as any).readdirSync = originalReaddirSync
      ;(fs as any).statSync = originalStatSync
    }

    assert.deepEqual(Object.keys(stats).sort(), [
      'free_bytes',
      'path',
      'total_bytes',
      'used_by_service_bytes',
    ])
    assert.equal(stats.path, outputDir)
    assert.ok(stats.total_bytes > 0)
    assert.ok(stats.free_bytes >= 0)
    assert.equal(stats.used_by_service_bytes, 12_288)
    assert.deepEqual(
      forbiddenCalls,
      [],
      'periodic disk stats must not traverse or stat output, clip, or temporary media trees',
    )

    console.log('bounded database-backed disk stats regression test passed')
  } finally {
    await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
