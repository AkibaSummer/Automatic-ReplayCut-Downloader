import assert from 'node:assert/strict'

import { isAllowedLocalOrigin } from '../src/backend'

assert.equal(isAllowedLocalOrigin(undefined), true)
assert.equal(isAllowedLocalOrigin('null'), true)
assert.equal(isAllowedLocalOrigin('file://'), true)
assert.equal(isAllowedLocalOrigin('file:///C:/portable-app/index.html'), true)
assert.equal(isAllowedLocalOrigin('http://127.0.0.1:5173'), true)
assert.equal(isAllowedLocalOrigin('https://localhost:5173'), true)
assert.equal(isAllowedLocalOrigin('https://example.com'), false)
assert.equal(isAllowedLocalOrigin('https://localhost.example.com'), false)

console.log('local origin policy tests passed')
