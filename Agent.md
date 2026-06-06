# Project AI Instructions

This project is built with:
- **Backend**: Node.js (Electron main process), Express, sql.js, mp4-muxer
- **Frontend**: React, Vite, Tailwind CSS, Lucide Icons

## Backend Architecture

The Electron backend (`electron/src/`) is split into focused modules:

| Module | Responsibility |
|---|---|
| `types.ts` | Shared TypeScript interfaces and types |
| `config.ts` | Config loading, saving, path resolution, `DEFAULT_CONFIG` |
| `utils.ts` | Pure utility functions (filename templates, path helpers, formatters) |
| `db.ts` | `SqliteStore` class — sql.js wrapper with **debounced async flush** to disk |
| `bilibili.ts` | `BilibiliClient` — all Bilibili API interactions and cookie management |
| `downloader.ts` | `DownloaderService` — HLS segment download, TS→MP4 remux (streaming) |
| `clip.ts` | `ClipService` — B站 video audio clipping with M4A sample-table parsing |
| `backend.ts` | `DesktopBackend` — Express routes, WebSocket progress, task queue orchestration |
| `main.ts` | Electron app entry point, BrowserWindow creation |

## Frontend Architecture

The React frontend (`frontend/src/`) is organized as:

| Module | Responsibility |
|---|---|
| `types/index.ts` | All shared TypeScript interfaces (`Replay`, `Config`, `Progress`, `Toast`, etc.) |
| `utils/index.ts` | Pure utility functions (`getErrorMessage`, `formatBytes`, `statusColor`, etc.) |
| `components/index.tsx` | Reusable UI components (`StatusPill`, `Tooltip`, `LoginModal`) |
| `ClipPage.tsx` | Audio clip page with waveform canvas, preview playback, quality selector |
| `SettingsPage.tsx` | Settings/config form page |
| `App.tsx` | Main layout, sidebar, downloads page, toast system, API/WS orchestration |
| `i18n.ts` | Internationalization configuration |

## Key Architectural Principles

1. **Separation of Concerns**: The frontend and backend communicate via REST API and WebSockets. Do not couple them together.
2. **Streaming for Media**: Since this application downloads large video files from Bilibili, media multiplexing MUST be streamed to disk using `StreamTarget` from mp4-muxer. **Never** use `ArrayBufferTarget` for full video streams — it causes OOM.
3. **Debounced Database Writes**: The `SqliteStore` in `db.ts` uses debounced async flushing (500ms) instead of synchronous `writeFileSync` on every transaction. Use `withBatch()` for bulk operations.
4. **Responsive UI**: The frontend should remain responsive regardless of what the backend is doing. WebSockets provide real-time updates for downloading/merging tasks.
5. **Code Generation**: Please read the `.clinerules` file for exact guidelines on creating new components or routes. Never output a single 1000+ line file.

When adding new features or fixing bugs, always write your changes in the smallest, most relevant module. If a module becomes too large, refactor it into sub-modules.

## Build Commands

```bash
npm run build:electron   # Compiles electron/src → electron-dist/
npm run build:renderer   # Compiles frontend → frontend/dist/
npm run build            # Both
npm run dev              # Dev mode with hot-reload
```
