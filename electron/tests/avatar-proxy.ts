import assert from 'node:assert/strict'

import { fetchAvatarResource } from '../src/routes/bilibili'

async function expectProxyError(action: () => Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(action, error => {
    const candidate = error as Error & { status?: number }
    assert.equal(candidate.status, status)
    assert.match(candidate.message, pattern)
    return true
  })
}

async function main() {
  await expectProxyError(() => fetchAvatarResource('not a URL'), 400, /invalid image URL/)
  await expectProxyError(() => fetchAvatarResource('https://not-hdslb.com/avatar.png'), 400, /not allowed/)

  const imageFetch: typeof globalThis.fetch = async () => new Response(Buffer.from('png'), {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': '3' },
  })
  const image = await fetchAvatarResource('https://i0.hdslb.com/avatar.png', imageFetch)
  assert.equal(image.status, 200)
  assert.equal(image.contentType, 'image/png')
  assert.equal(image.body.toString(), 'png')

  let redirectFetches = 0
  const redirectFetch: typeof globalThis.fetch = async () => {
    redirectFetches += 1
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
  }
  await expectProxyError(
    () => fetchAvatarResource('https://i0.hdslb.com/avatar.png', redirectFetch),
    400,
    /not allowed/,
  )
  assert.equal(redirectFetches, 1, 'an untrusted redirect target must never be fetched')

  const largeFetch: typeof globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) },
  })
  await expectProxyError(
    () => fetchAvatarResource('https://i0.hdslb.com/avatar.png', largeFetch),
    413,
    /too large/,
  )

  const htmlFetch: typeof globalThis.fetch = async () => new Response('<html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  await expectProxyError(
    () => fetchAvatarResource('https://i0.hdslb.com/avatar.png', htmlFetch),
    502,
    /not an image/,
  )

  console.log('avatar proxy regression test passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
