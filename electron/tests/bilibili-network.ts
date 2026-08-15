import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BilibiliClient } from '../src/bilibili'
import { DEFAULT_CONFIG, normalizeConfigWithBase } from '../src/config'
import { SqliteStore } from '../src/db'

async function withTimeout<T>(promise: Promise<T>, label: string) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'bilibili-network-'))
  const config = normalizeConfigWithBase(baseDir, structuredClone(DEFAULT_CONFIG))
  config.bilibili.anchor_id = 123
  const db = await SqliteStore.open(config.database.dsn)
  db.ensureSchema()

  try {
    const stalledFetch: typeof globalThis.fetch = async (_url, init) => {
      const signal = init?.signal
      return new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      }), { status: 200 })
    }
    const stalledClient = new BilibiliClient(config, db, stalledFetch)
    const external = new AbortController()
    const stalledResponse = await stalledClient.fetchWithCookies('https://api.bilibili.com/stalled', { signal: external.signal })
    const bodyRead = stalledResponse.text()
    external.abort(new Error('cancelled after headers'))
    await assert.rejects(() => withTimeout(bodyRead, 'body abort'), /cancelled|abort/i)

    db.insertReplay({
      replay_id: 77,
      live_key: 'cache',
      title: 'cache',
      start_time: 1,
      end_time: 2,
      duration: 1,
      status: 'not_downloaded',
    })
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO stream_slices (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, now, 77, 1, 2, 'https://old.example/playlist.m3u8', 0, '#EXTM3U\n#EXTINF:1,\nold.ts')
    const replay = db.getReplayByLiveKey(baseDir, 'cache')!

    let streamResponse = new Response('forbidden', { status: 403 })
    let emptyList = false
    const cacheFetch: typeof globalThis.fetch = async url => {
      if (String(url).includes('GetUserSliceStream')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { list: emptyList ? [] : [{ start_time: 1, end_time: 2, stream: 'https://cdn.hdslb.com/test.m3u8', type: 0 }] },
        }), { status: 200 })
      }
      return streamResponse
    }
    const cacheClient = new BilibiliClient(config, db, cacheFetch)
    await assert.rejects(() => cacheClient.cacheReplayM3U8(replay), /HTTP 403/)
    assert.equal(db.prepare('SELECT m3_u8_text FROM stream_slices WHERE replay_id = ?').get<any>(77)?.m3_u8_text.includes('old.ts'), true)

    emptyList = true
    await assert.rejects(() => cacheClient.cacheReplayM3U8(replay), /No replay streams/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stream_slices WHERE replay_id = ?').get<any>(77)?.count, 1)

    emptyList = false
    streamResponse = new Response('#EXTM3U\n#EXT-X-VERSION:3', { status: 200 })
    await assert.rejects(() => cacheClient.cacheReplayM3U8(replay), /invalid M3U8/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stream_slices WHERE replay_id = ?').get<any>(77)?.count, 1)

    streamResponse = new Response('#EXTM3U\n#EXTINF:1,\nnew.ts', { status: 200 })
    await cacheClient.cacheReplayM3U8(replay)
    const cached = db.prepare('SELECT m3_u8_text FROM stream_slices WHERE replay_id = ?').get<any>(77)
    assert.equal(cached?.m3_u8_text.includes('new.ts'), true)

    console.log('Bilibili body cancellation and M3U8 cache regression tests passed')
  } finally {
    await db.close()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
