# Application Architecture & Thread Boundaries

## Technical Stack Overview
- **Storage Layer**: Embedded SQLite orchestrating the `model.BilibiliReplay` structures.
- **Backend Service**: Native Golang Gin context engine with completely detached asynchronous `net/http` scrapers and `os/exec` command pipes for FFmpeg merging.
- **Frontend SPA**: React (Vite) utilizing `axios` for standard block I/O, coupled exclusively to a WebSocket line `api/ws` emitting serialized JSON updates.

## Goroutine & Synchronization Model 
Replays orchestrate around an implicit state machine strictly managed through native Go components:

1. **Wait Groups (`wg.Wait()`) & Channels**: Fetching dozens of nested Bilibili `.m3u8` references or extracting array matrices of individual TS stream chunks are uniformly dispatched through worker limits, reporting their parallelized state out to a unified `chan error` loop.
2. **Global Mutex Locks (`sync.Mutex`)**: Safe operational mapping dictates single-access rules to variables. Active tasks are isolated in an `activeTasks[key]bool` cache to fundamentally forbid double-clicking duplication exploits from UI triggers.
3. **Semaphore Yielding (`golang.org/x/sync/semaphore`)**: Limits concurrent thread weight. The `Weighted` configuration enforces network capacity checks, holding back `pending` tasks until slots evacuate from successfully completed routines or forced aborts.

### The Cancel Funnel
Total destruction of underlying network fetches or active FFmpeg merging logic routes entirely through `context.WithCancel`. The underlying worker architecture leverages dictionaries of unique `context.CancelFunc` tied to standard task hashes (`liveKey`). Calling `.Pause()` natively tears down local timeouts, http response writers, and pipeline buffers synchronously.

## Breakpoint Resilience (Breakpoint Resumes)
Large multi-segment merges maintain inherent fault tolerance entirely divorced from SQLite logic via physical file checks.
- When `engine.downloadFile` launches, it writes direct stream byte blocks incrementally to `<target_path>.tmp`.
- Unfinished or severed temporary files are destroyed actively within failure intercept blocks.
- Finished files drop the `.tmp` extension. 
- A resumed iteration intrinsically probes `os.Stat(segPath)`: instantly resuming download states exactly adjacent to the most recent whole byte threshold achieved across multi-thousand chunk boundaries. 

## Memory Hygiene
A recurring problem solved in this domain is "zombie" states (processes claiming active task rights, but dead on the wire). 
`Worker.CleanupStaleDownloadingNow` actively patrols the database cross-referencing global status columns vs locally retained memory keys, aggressively zero-izing isolated, mismatched locks back to stable defaults on backend disconnects.
