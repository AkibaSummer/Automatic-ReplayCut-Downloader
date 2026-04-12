# Automatic ReplayCut Downloader - Functional Requirements

## Overview
Bilibili Replay Manager is a fully responsive, local-first web service capable of proactively scanning Bilibili for complete replay streams and managing their automated retrieval. The core objective is to ensure robust, fault-tolerant network execution that never accidentally loses stream segments, while preserving UI clarity above all else.

## Scanning & Discovery
- **Passive Defaults**: All newly discovered livestream archives retrieved during the routine system ticker sync MUST default strictly to the `not_downloaded` status. 
- **Bandwidth Preservation**: The backend daemon is forbidden from automatically starting unexpected or unbounded network executions for newly scraped nodes.
- **Poll Cadence**: Stream availability polls intelligently filter duplicate keys or duplicate chunk boundaries to prevent parallel overwrite collisions.

## User Lifecycle State Boundaries
The user operates upon 6 fundamental logical boundaries bounding every physical video:
1. **`not_downloaded`**: Staging area. Untouched by automation. Completely immune to global state manipulators like `Pause All` or `Resume All`.
2. **`pending`**: Active queue. Registered and battling for processing limits inside the worker thread semaphore.
3. **`downloading` / `merging`**: Context-bound execution layer. Holding an exclusive system mutex, acquiring M3U8 arrays or streaming bits directly to disk, compiling TS segments to MP4 via `ffmpeg`.
4. **`paused`**: Intentionally suspended tasks. Resumable via `Resume All`. Retains all previously saved physical segmented items within the `tempDir`.
5. **`failed`**: Sandboxed halt state. Drops here only if the 3-attempt backoff exhausts completely. Completely immune to `Resume All` to prevent catastrophic API/ban spiral loops absent of user action.
6. **`completed`**: Safely written and exported to final directories.
7. **`deleted`**: Physically purged from disk but persisted in SQLite memory to ignore future crawler sweeps. 

## Tolerances & Error Management 
- **Resilient Retry Block**: Immediate network disconnects must initiate sequential, locally trapped internal retries (3 max, exponentiated limitse.g., 5s, 10s wait intervals) before abandoning the mutex lock.
- **Micro-Cancellation**: Exigent stops issued from the UX/UI (e.g. "Pause") absolutely must permeate underlying sleep-cycle retries or executing command processes via bounded Context cancellation (`context.Canceled`).

## Frontend Requirements
- Must provide real-time progression mapping over raw WebSocket conduits to avoid HTTP polling jitter. 
- All labels and status variables must cleanly switch through comprehensive i18n variables (`zh.json`, `en.json`).
