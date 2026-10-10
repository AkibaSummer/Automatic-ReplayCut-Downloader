import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BilibiliClient } from '../src/bilibili'
import { DEFAULT_CONFIG, normalizeConfigWithBase, saveConfigFile, loadConfigFile } from '../src/config'
import { SqliteStore } from '../src/db'

async function main() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bilibili-cookies-'))
  const config = normalizeConfigWithBase(base, structuredClone(DEFAULT_CONFIG))
  const db = await SqliteStore.open(config.database.dsn)
  try {
    config.bilibili.cookies = { fallback: 'configured' }
    const client = new BilibiliClient(config, db)
    await writeFile(config.bilibili.cookie_file, JSON.stringify({ SESSDATA: 'synthetic=token' }))
    await client.loadCookies()
    assert.match(client.cookieHeader(), /SESSDATA=synthetic=token/)
    await client.saveCookies()
    assert.equal(JSON.parse(await readFile(config.bilibili.cookie_file, 'utf8')).SESSDATA, 'synthetic=token')

    config.bilibili.cookie_file_readonly = true
    const header = '\uFEFFCookie: SESSDATA=synthetic=new; bili_jct=synthetic-csrf; DedeUserID=123;'
    await writeFile(config.bilibili.cookie_file, header)
    await client.loadCookies()
    assert.match(client.cookieHeader(), /SESSDATA=synthetic=new/)
    assert.equal(client.cookieHeader().includes('fallback'), false)
    await assert.rejects(client.saveCookies(), /read-only/)
    assert.equal(await readFile(config.bilibili.cookie_file, 'utf8'), header)

    await writeFile(config.bilibili.cookie_file, 'SESSDATA=changed')
    await client.loadCookies()
    assert.equal(client.cookieHeader().includes('bili_jct'), false)
    await writeFile(config.bilibili.cookie_file, '{"SESSDATA":"json-readonly"}')
    await client.loadCookies()
    assert.match(client.cookieHeader(), /SESSDATA=json-readonly/)

    for (const invalid of ['', 'not-a-cookie', 'SESSDATA=value\nAuthorization: private', '{"SESSDATA":123}', '[]']) {
      await writeFile(config.bilibili.cookie_file, invalid)
      await assert.rejects(client.loadCookies(), error => {
        assert.equal((error as Error).message, 'Cannot load read-only Bilibili credentials')
        return true
      })
    }
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(client.loadCookies(aborted.signal), { name: 'AbortError' })
    await saveConfigFile(base, path.join(base, 'config.yaml'), config)
    assert.equal(loadConfigFile(base, path.join(base, 'config.yaml')).bilibili.cookie_file_readonly, true)
    config.bilibili.cookie_file_readonly = false
    await client.loadCookies()
    assert.equal(client.cookieHeader(), 'fallback=configured')
    console.log('Bilibili writable JSON and read-only shared credential tests passed')
  } finally {
    await db.close()
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
