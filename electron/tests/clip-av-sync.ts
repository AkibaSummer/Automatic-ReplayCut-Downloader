import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import ffmpegPath from 'ffmpeg-static'

import { ClipService } from '../src/clip'

const ffmpeg = ffmpegPath?.replace('app.asar', 'app.asar.unpacked') || 'ffmpeg'

// The fixture server is loopback-only. CI/developer proxy variables must not
// send FFmpeg's 127.0.0.1 range requests through an external HTTP proxy.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key]
}
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

function run(args: string[]) {
  const result = spawnSync(ffmpeg, args, {
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr.toString().slice(-2000)}`)
  }
  return result
}

function createRangeServer(root: string): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    const requestPath = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname)
    const filePath = path.join(root, path.basename(requestPath))
    if (!fs.existsSync(filePath)) {
      res.writeHead(404).end()
      return
    }

    const size = fs.statSync(filePath).size
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', requestPath.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4')

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', size)
      res.writeHead(200).end()
      return
    }

    const match = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
    if (!match) {
      res.setHeader('Content-Length', size)
      res.writeHead(200)
      fs.createReadStream(filePath).pipe(res)
      return
    }

    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`)
      res.writeHead(416).end()
      return
    }

    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', end - start + 1)
    res.writeHead(206)
    fs.createReadStream(filePath, { start, end }).pipe(res)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start fixture server'))
        return
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

function firstFlashSeconds(filePath: string): number {
  const output = run([
    '-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-map', '0:v:0', '-vf', 'scale=1:1,format=gray',
    '-f', 'rawvideo', 'pipe:1',
  ]).stdout
  const bytes = output
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 180) return i / 30
  }
  throw new Error(`No video flash found in ${filePath}`)
}

function firstBeepSeconds(filePath: string): number {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-map', '0:a:0', '-ac', '1', '-ar', '1000',
    '-f', 's16le', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`audio decode failed (${result.status}): ${result.stderr.toString().slice(-2000)}`)
  }
  const samples = new Int16Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / Int16Array.BYTES_PER_ELEMENT),
  )
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > 2000) return i / 1000
  }
  throw new Error(`No audio beep found in ${filePath}`)
}

async function main() {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-cut-av-sync-'))
  const keepFixture = process.env.KEEP_SMART_CUT_FIXTURE === '1'
  const sourcePath = path.join(caseDir, 'source.mp4')
  const videoPath = path.join(caseDir, 'video.mp4')
  const audioPath = path.join(caseDir, 'audio.m4a')
  const smartDir = path.join(caseDir, 'smart-temp')
  const reencodeDir = path.join(caseDir, 'reencode-temp')
  const smartPath = path.join(caseDir, 'smart.mp4')
  const reencodePath = path.join(caseDir, 'reencode.mp4')
  fs.mkdirSync(smartDir)
  fs.mkdirSync(reencodeDir)

  // A single simultaneous flash/beep makes the A/V offset directly measurable.
  // Keyframes are deliberately phased at 1 + 5n seconds. Seeking at 5.3s then
  // exposes the old `paddedStart % gop` assumption as a four-second error.
  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "color=c=black:s=320x180:r=30:d=50,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,24.5,24.8)'",
    '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,24.5\\,24.8)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=50',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,1+n_forced*5)',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', sourcePath,
  ])
  run(['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-map', '0:v:0', '-an', '-c', 'copy', videoPath])
  run(['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-map', '0:a:0', '-vn', '-c', 'copy', audioPath])

  const { server, baseUrl } = await createRangeServer(caseDir)
  try {
    const service = new ClipService({} as never, {} as never, caseDir) as unknown as {
      localSmartCut: (...args: unknown[]) => Promise<unknown>
      localReencode: (...args: unknown[]) => Promise<unknown>
    }
    const startTime = 20.3
    const endTime = 34.3
    const videoUrl = `${baseUrl}/video.mp4`
    const audioUrl = `${baseUrl}/audio.m4a`

    await service.localSmartCut(videoUrl, audioUrl, '', startTime, endTime, smartPath, smartDir)
    await service.localReencode(videoUrl, audioUrl, '', startTime, endTime, reencodePath, reencodeDir)

    if (!fs.existsSync(path.join(smartDir, 'body.ts'))) {
      throw new Error('Fixture did not exercise the Smart Cut stream-copy body path')
    }

    const smartVideo = firstFlashSeconds(smartPath)
    const smartAudio = firstBeepSeconds(smartPath)
    const reencodeVideo = firstFlashSeconds(reencodePath)
    const reencodeAudio = firstBeepSeconds(reencodePath)
    const smartOffset = smartAudio - smartVideo
    const reencodeOffset = reencodeAudio - reencodeVideo
    const relativeError = Math.abs(smartOffset - reencodeOffset)
    const expectedEvent = 24.5 - startTime
    const smartSelectionError = Math.max(
      Math.abs(smartVideo - expectedEvent),
      Math.abs(smartAudio - expectedEvent),
    )
    const reencodeSelectionError = Math.max(
      Math.abs(reencodeVideo - expectedEvent),
      Math.abs(reencodeAudio - expectedEvent),
    )

    console.log(JSON.stringify({
      smart: { videoEvent: smartVideo, audioEvent: smartAudio, avOffset: smartOffset },
      reencode: { videoEvent: reencodeVideo, audioEvent: reencodeAudio, avOffset: reencodeOffset },
      relativeError,
      expectedEvent,
      smartSelectionError,
      reencodeSelectionError,
      fixtureDir: keepFixture ? caseDir : '(removed after test)',
    }, null, 2))

    if (relativeError > 0.05) {
      throw new Error(`Smart Cut differs from full re-encode by ${relativeError.toFixed(3)}s (limit: 0.050s)`)
    }
    if (smartSelectionError > 0.1 || reencodeSelectionError > 0.1) {
      throw new Error(`Selected content is shifted by up to ${Math.max(smartSelectionError, reencodeSelectionError).toFixed(3)}s (limit: 0.100s)`)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (!keepFixture) fs.rmSync(caseDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
