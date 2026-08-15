import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'
import { loadConfigFile } from '../src/config'

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'config-transaction-'))
  const backend = await DesktopBackend.create(baseDir)
  try {
    const originalFeishuClient = backend.feishuClient
    const clipDir = path.join(baseDir, 'canonical-clips')
    await Promise.all([
      backend.updateConfig(draft => {
        draft.download.clip_output_dir = clipDir
      }),
      backend.updateConfig(draft => {
        draft.download.max_concurrent_tasks = 4
      }),
      backend.updateConfig(draft => {
        draft.feishu.app_id = 'new-app-id'
        draft.feishu.app_secret = 'new-secret'
      }),
    ])

    assert.equal(backend.config.download.clip_output_dir, clipDir)
    assert.equal(backend.config.download.max_concurrent_tasks, 4)
    assert.equal(backend.config.feishu.app_id, 'new-app-id')
    assert.notEqual(backend.feishuClient, originalFeishuClient, 'credential changes must refresh the Feishu client')

    const persisted = loadConfigFile(baseDir, backend.configPath)
    assert.equal(persisted.download.clip_output_dir, clipDir)
    assert.equal(persisted.download.max_concurrent_tasks, 4)
    assert.equal(persisted.feishu.app_id, 'new-app-id')

    backend.config.server.port = 0
    const baseURL = await backend.listen()
    const staleSettingsSnapshot = structuredClone(backend.config)
    staleSettingsSnapshot.feishu.app_id = ''
    staleSettingsSnapshot.feishu.app_secret = ''
    staleSettingsSnapshot.download.max_concurrent_tasks = 6

    const feishuPrototype = Object.getPrototypeOf(backend.feishuClient) as {
      checkStatus: () => Promise<Record<string, unknown>>
    }
    const originalCheckStatus = feishuPrototype.checkStatus
    let verificationStarted!: () => void
    let finishVerification!: () => void
    const started = new Promise<void>(resolve => { verificationStarted = resolve })
    const finish = new Promise<void>(resolve => { finishVerification = resolve })
    feishuPrototype.checkStatus = async () => {
      verificationStarted()
      await finish
      return { ok: true, stage: 'ready', message: 'ready' }
    }
    try {
      const feishuSave = fetch(`${baseURL}/api/feishu/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: 'race-app-id', app_secret: 'race-secret' }),
      })
      await started
      const settingsResponse = await fetch(`${baseURL}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(staleSettingsSnapshot),
      })
      assert.equal(settingsResponse.status, 200)
      finishVerification()
      const feishuResponse = await feishuSave
      assert.equal(feishuResponse.status, 200)
      const feishuBody = await feishuResponse.json() as { config: typeof backend.config }
      assert.equal(backend.config.feishu.app_id, 'race-app-id', 'a stale Settings save must not roll back Feishu credentials')
      assert.equal(backend.config.download.max_concurrent_tasks, 6)
      assert.equal(feishuBody.config.feishu.app_id, 'race-app-id')
      assert.equal(feishuBody.config.download.max_concurrent_tasks, 6, 'Feishu response must return the latest canonical config')
    } finally {
      finishVerification()
      feishuPrototype.checkStatus = originalCheckStatus
    }
    console.log('serialized config transaction regression test passed')
  } finally {
    await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
