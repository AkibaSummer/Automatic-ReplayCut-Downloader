import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DesktopBackend } from '../src/backend'

const VALID_MEDIA_URL = 'https://waveform-regression.invalid.bilivideo.com/audio.m4a'
const FORBIDDEN_MEDIA_URL = 'https://waveform-forbidden.invalid.bilivideo.com/audio.m4a'
const INVALID_MEDIA_URL = 'https://waveform-invalid.invalid.bilivideo.com/audio.m4a'

function rangeResponse(payload: Buffer, init?: RequestInit) {
  const range = new Headers(init?.headers).get('range')
  if (!range) {
    return new Response(new Uint8Array(payload), {
      status: 200,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': `${payload.length}`,
        'content-type': 'audio/mp4',
      },
    })
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!match) return new Response(null, { status: 416 })
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : payload.length - 1
  if (start >= payload.length) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${payload.length}` },
    })
  }
  const end = Math.min(requestedEnd, payload.length - 1)
  const body = payload.subarray(start, end + 1)
  return new Response(new Uint8Array(body), {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': `${body.length}`,
      'content-range': `bytes ${start}-${end}/${payload.length}`,
      'content-type': 'audio/mp4',
    },
  })
}

async function main() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'audio-proxy-integration-'))
  const sourcePath = path.join(baseDir, 'long-audio.m4a')
  const outputPath = path.join(baseDir, 'waveform.mp3')
  const ffmpegPath = String(require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked')
  let backend: DesktopBackend | undefined

  try {
    const fixture = spawnSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
      '-t', '180',
      '-c:a', 'aac', '-b:a', '32k',
      '-movflags', '+faststart',
      '-y', sourcePath,
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(fixture.status, 0, fixture.stderr || 'failed to create audio fixture')
    const source = await readFile(sourcePath)
    const invalidSource = Buffer.from('this is not a media container')
    const ranges: string[] = []

    const customFetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = String(input)
      if (url === FORBIDDEN_MEDIA_URL) return new Response(null, { status: 403 })
      if (url === INVALID_MEDIA_URL) return rangeResponse(invalidSource, init)
      assert.equal(url, VALID_MEDIA_URL, `unexpected upstream URL: ${new URL(url).hostname}`)
      ranges.push(new Headers(init?.headers).get('range') || '')
      return rangeResponse(source, init)
    }) as typeof globalThis.fetch

    backend = await DesktopBackend.create(baseDir, customFetch)
    backend.config.server.port = 0
    const baseURL = await backend.listen()

    const startedAt = Date.now()
    const response = await fetch(
      `${baseURL}/api/clip/audio-proxy?url=${encodeURIComponent(VALID_MEDIA_URL)}&start=150&duration=2`,
    )
    const output = Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'audio/mpeg')
    assert.ok(output.length > 1_000, 'waveform response must contain a non-empty MP3')
    assert.ok(Date.now() - startedAt < 10_000, 'large-start waveform seek took unexpectedly long')
    assert.ok(ranges.length > 0, 'FFmpeg media reads must be routed through the authenticated fetch proxy')
    assert.ok(ranges.some(range => range.startsWith('bytes=')), 'FFmpeg byte-range requests must be forwarded upstream')

    await writeFile(outputPath, output)
    const decode = spawnSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', outputPath,
      '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(decode.status, 0, decode.stderr || 'returned MP3 is not decodable')

    const forbidden = await fetch(
      `${baseURL}/api/clip/audio-proxy?url=${encodeURIComponent(FORBIDDEN_MEDIA_URL)}&start=1&duration=2`,
    )
    assert.equal(forbidden.status, 502, 'an upstream 403 during FFmpeg input must not become an empty 200')
    assert.match(forbidden.headers.get('content-type') || '', /^application\/json/)
    assert.match((await forbidden.json() as { error: string }).error, /Unable to process the audio segment/)

    const invalid = await fetch(
      `${baseURL}/api/clip/audio-proxy?url=${encodeURIComponent(INVALID_MEDIA_URL)}&start=1&duration=2`,
    )
    assert.equal(invalid.status, 502, 'FFmpeg decode failure must be reported before audio headers are sent')
    assert.match(invalid.headers.get('content-type') || '', /^application\/json/)
    assert.match((await invalid.json() as { error: string }).error, /Unable to process the audio segment/)

    console.log('audio proxy authenticated range-seek and failure semantics integration test passed')
  } finally {
    if (backend) await backend.stop()
    await rm(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
