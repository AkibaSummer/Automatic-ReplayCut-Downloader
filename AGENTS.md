# Agent Operating Guide

Read `Agent.md`, `CONVENTIONS.md` and `.clinerules` before changing this project.
The active implementation is Electron/Node.js/TypeScript with a React frontend;
old Go architecture notes are historical, not instructions to rewrite the backend.

## Development

- Keep edits scoped to the relevant service, route or frontend component.
- UI strings belong in both frontend locale files, not hardcoded in TSX.
- Stream large media to disk; never buffer full recordings in memory.
- Batch sql.js updates and retain its debounced, atomic checkpoint behavior.
- Preserve task cancellation, restart recovery and file-ownership checks.
- Accept both legacy `name.part.mp4` and current `name.mp4.part` working paths.
- Never overwrite foreign files or silently discard recoverable user media.
- Independent replay slices may reset timestamps; preserve slice boundaries
  when remuxing them into one timeline.

## Verification

Use the lockfiles (`npm ci` and `npm --prefix frontend ci`) on a fresh checkout.
Run `npm run verify` before declaring a change ready. This builds both layers
and runs all release regression suites, including real synthetic FFmpeg media.
Do not start the normal application against production data merely to run tests.

## Accounts and Deployment

- Never commit or print Cookie values, app secrets, OAuth tokens or auth files.
- `config.yaml`, `cookies.json`, databases and downloaded media are private state,
  not source files. Keep them outside a coding workspace on a shared bot host.
- Feishu application credentials for the replay table are distinct from the
  coding-chat bot and from personal Feishu OAuth. Do not replace one with another.
- Do not restart services, install shared runtime upgrades or reload an active
  coding bridge while any task is running or queued. Isolated project tests may run.
- Commit/push/publish only when the current user request authorizes it. Do not
  force-push or discard another developer's uncommitted changes.
- Maintain useful project decisions here or in focused docs, never raw chat logs
  or secret values. Inspect the actual code before relying on old architecture notes.
