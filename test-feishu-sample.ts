/**
 * Sample Feishu records and test Smart Cut on them.
 */
import { SqliteStore } from './electron/src/db'
import { BilibiliClient } from './electron/src/bilibili'
import { ClipService } from './electron/src/clip'
import { loadConfigFile } from './electron/src/config'
import { FeishuClient } from './electron/src/feishu'
import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import _ffmpegPath from 'ffmpeg-static'

const ff = _ffmpegPath?.replace('app.asar', 'app.asar.unpacked') || 'ffmpeg'

function parseTime(s: string): number {
  const parts = s.trim().split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

function execSyncSafe(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  } catch (e: any) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

async function main() {
  const baseDir = process.cwd()
  const config = loadConfigFile(baseDir, path.join(baseDir, 'config.yaml'))
  const db = await SqliteStore.open(config.database.dsn)
  
  const client = new BilibiliClient(config, db)
  client.loadCookies()
  const user = await client.getCurrentUser()
  if (!user.logged_in) { console.error('Bilibili not logged in!'); process.exit(1) }

  const feishu = new FeishuClient(config.feishu)
  const status = await feishu.checkStatus()
  if (!status.ok) { console.error('Feishu not configured or no permission:', status); process.exit(1) }

  const clipService = new ClipService(config, client, baseDir)

  // Fetch clippable records from Feishu (max 500)
  console.log('Fetching records from Feishu...')
  const pageResult = await feishu.listClippableRecords(undefined, 500)
  const records = pageResult.records

  if (records.length === 0) {
    console.log('No clippable records found in Feishu.')
    process.exit(0)
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    const testUrl = rec.replay_url
    const startTime = parseTime(rec.start_time)
    const endTime = parseTime(rec.end_time)
    const songName = rec.song_name

    if (!testUrl || !startTime || !endTime || startTime >= endTime) {
      console.log(`Skipping invalid record ${songName} (URL: ${testUrl}, ${rec.start_time}-${rec.end_time})`)
      continue
    }

    console.log(`\n\n${'='.repeat(60)}`)
    console.log(`Test ${i + 1}/${records.length}: ${songName}`)
    console.log(`URL: ${testUrl}`)
    console.log(`Range: ${startTime}s → ${endTime}s (${(endTime - startTime).toFixed(0)}s)`)
    console.log(`${'='.repeat(60)}`)

    const t0 = Date.now()
    let smartPath = ''
    try {
      const result = await clipService.executeClip(
        testUrl, `sample-${i}-${songName}`, startTime, endTime, 0, 0,
        (progress, message) => {
          process.stdout.write(`\r  [smart] ${progress.toFixed(1)}% - ${message || ''}`.padEnd(80))
        },
        true, true, 'smart',
      )
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const r = result as any
      smartPath = r.path
      console.log(`\n  ✅ Smart Cut: ${elapsed}s, ${(r.size / 1024 / 1024).toFixed(2)} MB`)
      console.log(`     ${r.path}`)
    } catch (err: any) {
      console.log(`\n  ❌ Smart Cut failed: ${err.message}`)
      continue
    }

    // ── Jump detection for smart cut ──
    console.log(`\n  Running JUMP DETECTION...`)
    const qcDir = path.join('clips', 'qc-sample', i.toString())
    fs.mkdirSync(qcDir, { recursive: true })

    const kfOutput = execSyncSafe(`"${ff}" -i "${smartPath}" -vf "select=eq(pict_type\\,I),showinfo" -vsync vfr -an -f null - 2>&1`)
    const kfs: number[] = []
    const kfRe = /pts_time:\s*([\d.]+)/g
    let m: RegExpExecArray | null
    while ((m = kfRe.exec(kfOutput)) !== null) kfs.push(parseFloat(m[1]))

    const infoOutput = execSyncSafe(`"${ff}" -i "${smartPath}" 2>&1`)
    const durMatch = infoOutput.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
    const totalDur = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) + Number(durMatch[4]) / 100 : 0
    
    // Test first 2 and last 2 boundaries, plus one in the middle, to keep it fast
    let testPoints = [...kfs]
    if (testPoints.length > 5) {
        testPoints = [
            testPoints[0], testPoints[1],
            testPoints[Math.floor(testPoints.length / 2)],
            testPoints[testPoints.length - 2], testPoints[testPoints.length - 1]
        ]
    }

    let hasJumps = false;
    for (const kf of testPoints) {
      const startSec = Math.max(0, kf - 0.3)
      const frameDir = path.join(qcDir, `at_${kf.toFixed(1).replace('.','_')}`)
      fs.mkdirSync(frameDir, { recursive: true })

      execSyncSafe(`"${ff}" -ss ${startSec} -i "${smartPath}" -vframes 18 -y "${frameDir}/f_%03d.png" 2>nul`)
      const files = fs.readdirSync(frameDir).filter(f => f.endsWith('.png')).sort()
      const ssims: number[] = []

      for (let j = 0; j < files.length - 1; j++) {
        const f1 = path.join(frameDir, files[j])
        const f2 = path.join(frameDir, files[j + 1])
        const out = execSyncSafe(`"${ff}" -i "${f1}" -i "${f2}" -filter_complex "ssim" -f null - 2>&1`)
        const sm = out.match(/All:([\d.]+)/)
        ssims.push(sm ? parseFloat(sm[1]) : 0)
      }

      if (ssims.length === 0) continue;

      const avg = ssims.reduce((s, v) => s + v, 0) / ssims.length
      const min = Math.min(...ssims)
      const minIdx = ssims.indexOf(min)
      const hasJump = min < avg - 0.15

      if (hasJump) hasJumps = true;
      console.log(`    KF @ ${kf.toFixed(2)}s: avg=${avg.toFixed(4)}, min=${min.toFixed(4)} ${hasJump ? '❌ JUMP' : '✅ smooth'}`)
    }

    if (!hasJumps) {
      console.log(`  🎉 Test PASSED: No boundary jumps detected for ${songName}`)
    } else {
      console.log(`  ⚠️ Test WARNING: Boundary jumps detected for ${songName}`)
    }
  }

  await db.close()
  console.log('\nAll sampling tests complete.')
}

main().catch(console.error)
