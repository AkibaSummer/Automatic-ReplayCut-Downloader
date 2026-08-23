import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import YAML from 'yaml'

import { DEFAULT_CONFIG, loadConfigFile, normalizeConfigWithBase, recoverPortableConfigPaths, saveConfigFile } from '../src/config'
import { SqliteStore } from '../src/db'

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'replaycut-config-paths-'))
  const configPath = path.join(baseDir, 'config.yaml')

  try {
    const normalized = normalizeConfigWithBase(baseDir, structuredClone(DEFAULT_CONFIG))
    assert.equal(normalized.download.output_dir, path.join(baseDir, 'downloads'))
    assert.equal(normalized.download.temp_dir, path.join(baseDir, 'temp'))
    assert.equal(normalized.download.clip_output_dir, path.join(baseDir, 'clips'))
    assert.equal(normalized.database.dsn, path.join(baseDir, 'replays.db'))

    const invalidConcurrency = structuredClone(DEFAULT_CONFIG)
    invalidConcurrency.download.max_concurrent_tasks = -1
    invalidConcurrency.download.concurrent_segments = Number.POSITIVE_INFINITY
    const safeConcurrency = normalizeConfigWithBase(baseDir, invalidConcurrency)
    assert.equal(safeConcurrency.download.max_concurrent_tasks, DEFAULT_CONFIG.download.max_concurrent_tasks)
    assert.equal(safeConcurrency.download.concurrent_segments, DEFAULT_CONFIG.download.concurrent_segments)

    await saveConfigFile(baseDir, configPath, normalized)
    const saved = YAML.parse(await readFile(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    assert.equal(saved.download.output_dir, 'downloads')
    assert.equal(saved.download.temp_dir, 'temp')
    assert.equal(saved.download.clip_output_dir, 'clips')
    assert.equal(saved.database.dsn, 'replays.db')

    const first = structuredClone(normalized)
    first.download.max_concurrent_tasks = 3
    const second = structuredClone(normalized)
    second.download.max_concurrent_tasks = 7
    await Promise.all([
      saveConfigFile(baseDir, configPath, first),
      saveConfigFile(baseDir, configPath, second),
    ])
    const latest = YAML.parse(await readFile(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    assert.equal(latest.download.max_concurrent_tasks, 7, 'serialized saves must preserve call order')
    assert.ok((await readdir(baseDir)).every(name => !name.endsWith('.tmp') && !name.endsWith('.old')))

    await writeFile(configPath, 'download: [invalid yaml', 'utf8')
    const recovered = loadConfigFile(baseDir, configPath)
    assert.equal(recovered.download.max_concurrent_tasks, 3, 'corrupt primary config should recover from backup')

    const oldBase = path.join(baseDir, 'old-portable')
    const copiedBase = path.join(baseDir, 'copied-portable')
    await mkdir(oldBase, { recursive: true })
    await mkdir(copiedBase, { recursive: true })
    const oldDbPath = path.join(oldBase, 'replays.db')
    const copiedDbPath = path.join(copiedBase, 'replays.db')
    const oldDb = await SqliteStore.open(oldDbPath)
    oldDb.ensureSchema(oldBase)
    oldDb.insertReplay({ replay_id: 99, live_key: 'portable-db-proof', title: 'portable', status: 'not_downloaded' })
    await oldDb.close()
    await copyFile(oldDbPath, copiedDbPath)
    const copiedConfigPath = path.join(copiedBase, 'config.yaml')
    const legacyAbsoluteConfig = normalizeConfigWithBase(oldBase, structuredClone(DEFAULT_CONFIG))
    await writeFile(copiedConfigPath, YAML.stringify(legacyAbsoluteConfig), 'utf8')

    const relocated = await recoverPortableConfigPaths(
      copiedBase,
      copiedConfigPath,
      loadConfigFile(copiedBase, copiedConfigPath),
    )
    assert.equal(relocated.database.dsn, copiedDbPath, 'a copied package must use its copied database, not the old absolute DSN')
    assert.equal(relocated.download.output_dir, path.join(copiedBase, 'downloads'))
    assert.equal(relocated.download.temp_dir, path.join(copiedBase, 'temp'))
    assert.equal(relocated.download.clip_output_dir, path.join(copiedBase, 'clips'))
    const portableSaved = YAML.parse(await readFile(copiedConfigPath, 'utf8')) as typeof DEFAULT_CONFIG
    assert.equal(portableSaved.database.dsn, 'replays.db')
    assert.equal(portableSaved.download.output_dir, 'downloads')
    const copiedDb = await SqliteStore.open(relocated.database.dsn)
    copiedDb.ensureSchema(copiedBase)
    assert.equal(copiedDb.getReplaySummaryByLiveKey(copiedBase, 'portable-db-proof')?.title, 'portable')
    await copiedDb.close()

    console.log('config path and copied-portable database relocation regression tests passed')
  } finally {
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
