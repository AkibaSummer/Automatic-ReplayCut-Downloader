import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import YAML from 'yaml'

import { DEFAULT_CONFIG, loadConfigFile, normalizeConfigWithBase, saveConfigFile } from '../src/config'

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

    console.log('config path regression test passed')
  } finally {
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
