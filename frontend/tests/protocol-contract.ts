import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { deleteReplayFile, quitDesktopApp, scanReplays } from '../src/api/contracts'
import { isBackendReachableError, mergeRealtimeProgress, shouldUseRealtimeProgress } from '../src/utils'
import type { Progress, Replay } from '../src/types'

const frontendRoot = fs.existsSync(path.join(process.cwd(), 'src', 'locales'))
  ? process.cwd()
  : path.join(process.cwd(), 'frontend')
const sourceRoot = path.join(frontendRoot, 'src')

function flattenKeys(value: unknown, prefix = '', result: string[] = []) {
  if (!value || typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object') flattenKeys(child, fullKey, result)
    else result.push(fullKey)
  }
  return result
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return /\.(ts|tsx)$/.test(entry.name) ? [target] : []
  })
}

const zh = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'locales', 'zh.json'), 'utf8'))
const en = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'locales', 'en.json'), 'utf8'))
const zhKeys = flattenKeys(zh).sort()
const enKeys = flattenKeys(en).sort()
assert.deepEqual(enKeys, zhKeys, 'zh/en locale keys must stay in parity')

const knownKeys = new Set(zhKeys)
const missingKeys: string[] = []
const frontendSources = sourceFiles(sourceRoot)
for (const filename of frontendSources) {
  const source = fs.readFileSync(filename, 'utf8')
  for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
    if (!knownKeys.has(match[1])) missingKeys.push(`${path.relative(frontendRoot, filename)}: ${match[1]}`)
  }
}
assert.deepEqual(missingKeys, [], 'every statically referenced translation key must exist')

const sourceBundle = frontendSources.map(filename => fs.readFileSync(filename, 'utf8')).join('\n')
assert.doesNotMatch(sourceBundle, /\/api\/replays\/scan/, 'the removed replay scan path must not return')
assert.doesNotMatch(sourceBundle, /\/api\/quit/, 'quit must not be modeled as a backend HTTP endpoint')
assert.doesNotMatch(sourceBundle, /apiClient\.delete\([^\n]*\/api\/replays/, 'replay deletion must use delete-file POST')
assert.match(fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8'), /scanReplays\(apiClient\)/)
assert.match(fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8'), /quitDesktopApp\(window\.desktopAPI\)/)
assert.match(fs.readFileSync(path.join(sourceRoot, 'components', 'ReplayDetailsModal.tsx'), 'utf8'), /deleteReplayFile\(apiClient, liveKey\)/)

const appSource = fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8')
assert.doesNotMatch(appSource, /savingConfig=\{useAppStore\.getState\(\)\.savingConfig\}/)
assert.doesNotMatch(appSource, /paused=\{useAppStore\.getState\(\)\.paused\}/)
const clipPageSource = fs.readFileSync(path.join(sourceRoot, 'ClipPage.tsx'), 'utf8')
assert.match(
  clipPageSource,
  /useAppStore\(state => state\.config\?\.download\.clip_output_dir\)/,
  'the permanently mounted ClipPage must subscribe to the canonical clip output directory',
)
assert.match(clipPageSource, /url:\s*loadedUrl/, 'clip execution must use the URL that produced the loaded metadata')
assert.match(clipPageSource, /task\.url\.trim\(\) === loadedUrl/, 'per-video tasks must use the normalized loaded URL')
assert.match(clipPageSource, /res\.data\.config\) useAppStore\.getState\(\)\.setConfig/, 'config mutation responses must refresh the canonical store')

const requests: Array<{ method: string; path: string }> = []
const apiClient = {
  post: async (requestPath: string) => {
    requests.push({ method: 'POST', path: requestPath })
    return { data: { ok: true } }
  },
}
await scanReplays(apiClient as any)
await deleteReplayFile(apiClient as any, 'live/key with space')
assert.deepEqual(requests, [
  { method: 'POST', path: '/api/scan' },
  { method: 'POST', path: '/api/replays/live%2Fkey%20with%20space/delete-file' },
])

let quitCalls = 0
await quitDesktopApp({ quitApp: async () => { quitCalls += 1 } })
assert.equal(quitCalls, 1, 'quit must use the Electron desktop bridge')
await assert.rejects(() => quitDesktopApp(undefined), /unavailable/)

const replay = { live_key: 'demo', status: 'not_downloaded' } as Replay
const progress = { live_key: 'demo', status: 'downloading', progress: 1 } as Progress
assert.equal(
  shouldUseRealtimeProgress(progress, replay),
  true,
  'a new download must accept realtime progress before the replay GET observes pending',
)

assert.equal(
  shouldUseRealtimeProgress(
    { ...progress, status: 'failed', updated_at: '2026-08-16T00:00:00.000Z' },
    { ...replay, status: 'pending', UpdatedAt: '2026-08-16T00:00:01.000Z' },
  ),
  false,
  'a stale terminal websocket snapshot must not override a newer retry state',
)

const cleared = mergeRealtimeProgress(
  { ...progress, merge_progress: 0, message: 'old', speed: '1 MB/s', speed_history: [], elapsed: '1s', eta: '2s' },
  { message: '', speed: '', elapsed: '', eta: '' },
)
assert.deepEqual(
  { message: cleared.message, speed: cleared.speed, elapsed: cleared.elapsed, eta: cleared.eta },
  { message: '', speed: '', elapsed: '', eta: '' },
  'empty WS fields must clear stale progress text',
)

assert.equal(isBackendReachableError({ response: { status: 500 } }), true, 'HTTP errors still prove the backend is reachable')
assert.equal(isBackendReachableError({ response: { status: 404 } }), true, 'business/route errors must not mark the backend offline')
assert.equal(isBackendReachableError({ request: {} }), false, 'a request without a response is a connectivity failure')
assert.equal(isBackendReachableError(new Error('ECONNREFUSED')), false, 'connection failures must mark the backend offline')

console.log('frontend protocol contract: ok')
