import assert from 'node:assert/strict'

import { WaveformRequestRegistry } from '../src/utils/waveformRequests'
import {
  initialWaveformViewport,
  waveformRequestErrorMessage,
} from '../src/utils/waveform'

const registry = new WaveformRequestRegistry()
const firstGeneration = registry.beginSession()
const oldRequest = registry.create(0)
assert.ok(oldRequest)
assert.equal(registry.isCurrent(oldRequest), true)

const secondGeneration = registry.beginSession()
assert.notEqual(secondGeneration, firstGeneration)
assert.equal(oldRequest.controller.signal.aborted, true, 'switching video must abort old waveform requests')
assert.equal(registry.isCurrent(oldRequest), false, 'an old response must not belong to the new video')

const newRequest = registry.create(0)
assert.ok(newRequest, 'the new video must be able to request the same chunk index immediately')
registry.finish(oldRequest)
assert.equal(
  registry.isCurrent(newRequest),
  true,
  'late cleanup from an old response must not remove the new request with the same index',
)

registry.finish(newRequest)
assert.equal(registry.size, 0)

assert.deepEqual(
  initialWaveformViewport(3 * 60 * 60),
  { zoomWindow: 120, scrollOffset: 60 },
  'a long recording must load only the initial viewport instead of every chunk',
)
assert.deepEqual(initialWaveformViewport(45), { zoomWindow: 45, scrollOffset: 22.5 })

const encodedError = new TextEncoder().encode(JSON.stringify({ error: 'upstream denied the segment' })).buffer
assert.equal(
  waveformRequestErrorMessage({ response: { status: 502, data: encodedError } }),
  'upstream denied the segment',
  'arraybuffer API errors must remain visible to the user',
)

console.log('waveform request registry: ok')
