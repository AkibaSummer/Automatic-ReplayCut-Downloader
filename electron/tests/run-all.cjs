const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const tsxCli = require.resolve('tsx/cli', { paths: [repoRoot] })
const tests = [
  'frontend/tests/protocol-contract.ts',
  'frontend/tests/waveform-request-registry.ts',
  'frontend/tests/task-state-sync.ts',
  'electron/tests/config-paths.ts',
  'electron/tests/config-transaction.ts',
  'electron/tests/avatar-proxy.ts',
  'electron/tests/bilibili-network.ts',
  'electron/tests/audio-proxy-integration.ts',
  'electron/tests/clip-task-store.ts',
  'electron/tests/clip-task-center-integration.ts',
  'electron/tests/clip-task-state-reconciliation.ts',
  'electron/tests/replay-state-machine.ts',
  'electron/tests/replay-protocol-integration.ts',
  'electron/tests/clip-output-lifecycle.ts',
  'electron/tests/clip-av-sync.ts',
]

for (const test of tests) {
  const absolute = path.join(repoRoot, test)
  console.log(`\n=== ${test} ===`)
  const result = spawnSync(process.execPath, [tsxCli, absolute], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log(`\nAll ${tests.length} release tests passed.`)
