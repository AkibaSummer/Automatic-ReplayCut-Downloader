import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ClipService } from '../src/clip'
import type { AppConfig } from '../src/types'

function configFor(baseDir: string): AppConfig {
  return {
    bilibili: { anchor_id: 0, cookies: {}, cookie_file: path.join(baseDir, 'cookies.json') },
    download: {
      output_dir: path.join(baseDir, 'downloads'),
      temp_dir: path.join(baseDir, 'temp'),
      clip_output_dir: path.join(baseDir, 'clips'),
      filename_template: '{title}.mp4',
      max_concurrent_tasks: 1,
      concurrent_segments: 1,
    },
    database: { dsn: path.join(baseDir, 'test.db') },
    server: { port: 0 },
    feishu: { app_id: '', app_secret: '', base_token: '', table_id: '' },
  }
}

function clientStub() {
  return {
    getBilibiliVideoInfo: async () => ({
      duration: 60,
      title: 'fixture',
      audioUrl: 'https://example.invalid/audio',
      cid: 1,
      qualities: {
        audio: [{ codecs: 'aac', baseUrl: 'https://example.invalid/audio' }],
        video: [{ codecs: 'avc1.640032', baseUrl: 'https://example.invalid/video' }],
      },
    }),
    parseBilibiliUrl: () => null,
    cookieHeader: () => '',
  }
}

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-output-lifecycle-'))
  try {
    const service = new ClipService(configFor(baseDir), clientStub() as never, baseDir) as any

    const validOutput = path.join(baseDir, 'valid-output.mp4')
    await service.runFfmpegCommand([
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      '-y', validOutput,
    ])
    await service.verifyClipOutput(validOutput, 2, 'reencode')
    await assert.rejects(
      service.verifyClipOutput(validOutput, 30, 'reencode'),
      /output verification failed: expected 30\.0s/,
      'a decodable but severely truncated clip must not be published as done',
    )
    const invalidOutput = path.join(baseDir, 'invalid-output.mp4')
    fs.writeFileSync(invalidOutput, Buffer.alloc(1024, 1))
    await assert.rejects(
      service.verifyClipOutput(invalidOutput, 2, 'reencode'),
      /output verification failed/i,
      'a non-empty but undecodable file must not be published as done',
    )

    // The remaining lifecycle cases use lightweight fake MP4 bytes and focus
    // on reservation/cleanup. Output verification itself is covered above.
    service.verifyClipOutput = async () => {}

    assert.equal(service.resolveClipMode('smart', 'avc1.640032'), 'smart')
    assert.equal(service.resolveClipMode('smart', 'h264'), 'smart')
    assert.equal(service.resolveClipMode('smart', 'hev1.1.6.L150.90'), 'reencode')
    assert.equal(service.resolveClipMode('smart', 'hvc1.2.4.L153.B0'), 'reencode')
    assert.equal(service.resolveClipMode('smart', 'av01.0.12M.10'), 'reencode')
    assert.equal(service.resolveClipMode('copy', 'av01.0.12M.10'), 'copy')

    const selectedUrls: string[] = []
    const qualityClient = {
      getBilibiliVideoInfo: async () => ({
        duration: 60,
        title: 'quality fixture',
        audioUrl: 'https://example.invalid/audio-high',
        cid: 1,
        qualities: {
          audio: [
            { id: 30280, codecs: 'aac-high', baseUrl: 'https://example.invalid/audio-high' },
            { id: 30232, codecs: 'aac-low', baseUrl: 'https://example.invalid/audio-low' },
          ],
          video: [
            { id: 120, codecs: 'avc1.640032', baseUrl: 'https://example.invalid/video-high' },
            { id: 80, codecs: 'avc1.4d401f', baseUrl: 'https://example.invalid/video-low' },
          ],
        },
      }),
      cookieHeader: () => '',
    }
    const qualityService = new ClipService(configFor(baseDir), qualityClient as never, baseDir) as any
    qualityService.verifyClipOutput = async () => {}
    qualityService.localCopyCut = async (...args: unknown[]) => {
      selectedUrls.push(String(args[0]), String(args[1]))
      fs.writeFileSync(String(args[5]), Buffer.alloc(512, 5))
      return { size: 512 }
    }
    await qualityService.executeClip(
      'BV1fixture', 'selected-quality', 1, 2, 0, 0, undefined, false, false, 'copy', undefined,
      { audioId: 30232, audioCodec: 'aac-low', videoId: 80, videoCodec: 'avc1.4d401f' },
    )
    assert.deepEqual(selectedUrls, [
      'https://example.invalid/video-low',
      'https://example.invalid/audio-low',
    ], 'execution must select stable quality IDs even if the refreshed list order changed')
    await assert.rejects(
      qualityService.executeClip(
        'BV1fixture', 'missing-quality', 1, 2, 0, 0, undefined, false, false, 'copy', undefined,
        { audioId: 30232, audioCodec: 'aac-low', videoId: 999, videoCodec: 'avc1.unknown' },
      ),
      /所选视频质量已不可用/,
      'a disappeared upstream quality must fail clearly instead of silently selecting index zero',
    )

    const hevcClient = {
      ...clientStub(),
      getBilibiliVideoInfo: async () => ({
        duration: 60,
        title: 'hevc fixture',
        audioUrl: 'https://example.invalid/audio',
        cid: 1,
        qualities: { video: [{ codecs: 'hev1.1.6.L150.90', baseUrl: 'https://example.invalid/hevc' }] },
      }),
    }
    const fallbackService = new ClipService(configFor(baseDir), hevcClient as never, baseDir) as any
    fallbackService.verifyClipOutput = async () => {}
    fallbackService.localSmartCut = async () => { throw new Error('HEVC must not enter Smart Cut') }
    fallbackService.localReencode = async (...args: unknown[]) => {
      fs.writeFileSync(String(args[5]), Buffer.alloc(512, 4))
      return { size: 512, message: 'reencoded' }
    }
    const fallbackResult = await fallbackService.executeClip('fixture', 'hevc-fallback', 1, 2, 0, 0, undefined, false, false, 'smart')
    assert.match(fallbackResult.message, /hev1\.1\.6\.L150\.90/)
    assert.match(fallbackResult.message, /完整重编码/)

    fs.mkdirSync(configFor(baseDir).download.clip_output_dir, { recursive: true })
    const desiredConcurrentPath = path.join(configFor(baseDir).download.clip_output_dir, 'same-name.mp4')
    const firstReservation = service.reserveOutputPath(desiredConcurrentPath) as { outPath: string; partPath: string }
    const secondReservation = service.reserveOutputPath(desiredConcurrentPath) as { outPath: string; partPath: string }
    assert.notEqual(firstReservation.outPath, secondReservation.outPath, 'concurrent same-name tasks need distinct final paths')
    assert.notEqual(firstReservation.partPath, secondReservation.partPath, 'concurrent same-name tasks need distinct part paths')
    fs.rmSync(firstReservation.partPath, { force: true })
    fs.rmSync(secondReservation.partPath, { force: true })

    const occupiedDesiredPath = path.join(configFor(baseDir).download.clip_output_dir, 'occupied.mp4')
    const occupiedBasePart = path.join(configFor(baseDir).download.clip_output_dir, 'occupied.part.mp4')
    const occupiedSuffixFinal = path.join(configFor(baseDir).download.clip_output_dir, 'occupied (1).mp4')
    fs.writeFileSync(occupiedBasePart, 'in progress')
    fs.writeFileSync(occupiedSuffixFinal, 'completed')
    const occupiedReservation = service.reserveOutputPath(occupiedDesiredPath) as { outPath: string; partPath: string }
    assert.equal(occupiedReservation.outPath, path.join(configFor(baseDir).download.clip_output_dir, 'occupied (2).mp4'))
    assert.equal(occupiedReservation.partPath, path.join(configFor(baseDir).download.clip_output_dir, 'occupied (2).part.mp4'))
    assert.equal(fs.readFileSync(occupiedSuffixFinal, 'utf8'), 'completed', 'an existing suffix final must not be selected')
    fs.rmSync(occupiedBasePart, { force: true })
    fs.rmSync(occupiedSuffixFinal, { force: true })
    fs.rmSync(occupiedReservation.partPath, { force: true })

    let workingPath = ''
    service.localSmartCut = async (...args: unknown[]) => {
      workingPath = String(args[5])
      assert.match(workingPath, /\.part\.mp4$/)
      fs.writeFileSync(workingPath, Buffer.alloc(4096, 1))
      return { size: 4096, message: 'ok' }
    }
    const completed = await service.executeClip('fixture', 'atomic', 1, 2, 0, 0, undefined, false, false, 'smart')
    assert.equal(fs.existsSync(workingPath), false, 'the part file must be renamed away')
    assert.equal(fs.existsSync(completed.path), true, 'the final file must appear only after success')
    assert.equal(fs.statSync(completed.path).size, 4096)
    assert.deepEqual(fs.readdirSync(configFor(baseDir).download.temp_dir), [], 'successful temp data must be removed')

    let failedPart = ''
    service.localSmartCut = async (...args: unknown[]) => {
      failedPart = String(args[5])
      fs.writeFileSync(failedPart, Buffer.alloc(2048, 2))
      throw new Error('fixture failure')
    }
    await assert.rejects(
      service.executeClip('fixture', 'failed', 1, 2, 0, 0, undefined, false, false, 'smart'),
      /fixture failure/,
    )
    assert.equal(fs.existsSync(failedPart), false, 'a non-empty failed part must be removed')
    assert.equal(fs.existsSync(path.join(configFor(baseDir).download.clip_output_dir, 'failed.mp4')), false)
    assert.deepEqual(fs.readdirSync(configFor(baseDir).download.temp_dir), [], 'failed temp data must be removed')

    let collisionPart = ''
    let collisionFinal = ''
    service.localSmartCut = async (...args: unknown[]) => {
      collisionPart = String(args[5])
      collisionFinal = collisionPart.replace(/\.part\.mp4$/i, '.mp4')
      fs.writeFileSync(collisionPart, Buffer.alloc(3072, 8))
      fs.writeFileSync(collisionFinal, 'external sentinel')
      return { size: 3072 }
    }
    await assert.rejects(
      service.executeClip('fixture', 'publish-collision', 1, 2, 0, 0, undefined, false, false, 'smart'),
      (error: unknown) => {
        const fileError = error as NodeJS.ErrnoException & { recoverablePath?: string; publishedPath?: string }
        return fileError.code === 'EEXIST'
          && fileError.recoverablePath === collisionPart
          && fileError.publishedPath === ''
      },
      'a destination appearing after reservation must never be overwritten',
    )
    assert.equal(fs.readFileSync(collisionFinal, 'utf8'), 'external sentinel')
    assert.equal(fs.existsSync(collisionPart), true, 'the verified losing output must be preserved for recovery')
    fs.rmSync(collisionPart, { force: true })
    fs.rmSync(collisionFinal, { force: true })

    const controller = new AbortController()
    let abortedPart = ''
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    service.localSmartCut = (...args: unknown[]) => new Promise((_resolve, reject) => {
      abortedPart = String(args[5])
      const signal = args[8] as AbortSignal
      fs.writeFileSync(abortedPart, Buffer.alloc(1024, 3))
      markStarted?.()
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const aborted = service.executeClip('fixture', 'cancelled', 1, 2, 0, 0, undefined, false, false, 'smart', controller.signal)
    await started
    controller.abort()
    await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    assert.equal(fs.existsSync(abortedPart), false, 'a non-empty cancelled part must be removed')
    assert.equal(fs.existsSync(path.join(configFor(baseDir).download.clip_output_dir, 'cancelled.mp4')), false)
    assert.deepEqual(fs.readdirSync(configFor(baseDir).download.temp_dir), [], 'cancelled temp data must be removed')

    // The FFmpeg wrapper must not reject until the killed child has closed;
    // immediate deletion is a practical handle-release check on Windows.
    const ffmpegOutput = path.join(baseDir, 'abort-probe.mp4')
    const ffmpegController = new AbortController()
    const ffmpegRun = service.runFfmpegCommand([
      '-re', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=30',
      '-c:v', 'libx264', '-y', ffmpegOutput,
    ], ffmpegController.signal) as Promise<void>
    await new Promise(resolve => setTimeout(resolve, 250))
    ffmpegController.abort()
    await assert.rejects(ffmpegRun, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    fs.rmSync(ffmpegOutput, { force: true })

    console.log('clip output lifecycle regression test passed')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
