# Spike #607: Storage Lock Contention Analysis Report

Feeds [ADR-007](../adr/ADR-007-offline-storage.md). Raw numbers: [`results/storage-contention.json`](results/storage-contention.json) (contention, throughput) and [`results/storage-quota.json`](results/storage-quota.json) (quota and eviction).

## What was built

| File | Purpose |
|---|---|
| `src/services/storageEngine.js` | `WriteAheadBuffer` (group commit, size- and time-triggered, single in-flight flush, overflow policy), `IndexedDbBackend` (durability hints, lock-wait timing, newest-first reads, `deleteOldest`), `SqliteOpfsBackend` (`opfs` / `opfs-wl` / `opfs-sahpool` VFS, WAL + `locking_mode=EXCLUSIVE`, `BEGIN IMMEDIATE` with SQLITE_BUSY backoff timing), `createStorageEngine()`, `estimateStorage()`, `classifySqliteError()` (maps the sahpool VFS's generic I/O error at full quota to `QuotaExceededError`). `deleteOldest` is a single key-range delete in IndexedDB. |
| `src/workers/telemetryWorker.js` | Synthetic GPS producer at a fixed rate with drift correction and backpressure (`maxPending`). Three roles: `writer` (own connection), `forward` (posts to an owner over `MessagePort`) and `owner` (holds the single SQLite connection). Also a quota-recovery probe and soft-watermark eviction (`evictAtRatio`), which forwarding writers run on the owner. |
| `scripts/spikes/storage-bench/` + `storage_contention_benchmark.js` | Serves the repo through Vite with COOP/COEP headers and runs each scenario in a fresh Playwright Chromium context |
| `test/storage-engine.test.js` | 24 tests covering buffer semantics, IndexedDB (fake-indexeddb), real SQLite WASM (in-memory under Node), backpressure, quota recovery, watermark eviction, SQLite quota-error classification and the owner/forward topology |

## Method

- **Browser:** Chromium 147.0.7727.15, headless. The page is cross-origin isolated, so the `opfs` VFS and `SharedArrayBuffer` are available.
- **Contention:** 4 module workers × 125 Hz = **500 writes/s for 15 s** (7,500 records of about 96 bytes). The main thread reads the newest 50 rows every 100 ms: directly from IndexedDB, or through the owner/reader worker for SQLite. A `requestAnimationFrame` monitor and a long-task observer watch the UI thread.
- **Saturation:** the same 4 workers write as fast as possible for 6 s (up to 512 in flight each).
- Each scenario starts from empty IndexedDB and OPFS in a new browser context.

Reproduce: `CHROMIUM_PATH=/path/to/chrome npm run spike:storage`.

## Results: 500 writes/s across 4 workers

| Scenario | Throughput | Write p95 | Read p50 / p95 | Transactions | Lock wait p95 | Journal | Shed / errors |
|---|---|---|---|---|---|---|---|
| IndexedDB, per-write, default durability | 497/s | 4.1 ms | 0.6 / 1.4 ms | 1,875 | 3.1 ms | — | 0 / 0 |
| IndexedDB, per-write, strict | 498/s | 5.1 ms | 0.6 / 2.4 ms | 1,875 | 4.0 ms | — | 0 / 0 |
| IndexedDB, batched, relaxed | 498/s | 60.1 ms | 0.7 / 2.6 ms | 230 | 3.7 ms | — | 0 / 0 |
| IndexedDB, batched, strict | 498/s | 60.6 ms | 0.6 / 1.7 ms | 230 | 5.0 ms | — | 0 / 0 |
| SQLite `opfs`, 4 direct connections, per-write | **37/s** | 1,583 ms | 8.7 / **18,034 ms** | — | — | delete (WAL refused) | **2,449** / 0 |
| SQLite `opfs-wl`, 4 direct connections, per-write | — | — | — | — | — | — | **page crashed** |
| SQLite `opfs-wl`, 4 direct connections, batched | **66/s** | 2,838 ms | 181 / 1,276 ms | — | — | delete (WAL refused) | **5,117 / 955** |
| SQLite `opfs-sahpool`, single owner, batched, **WAL** | 497/s | 77.1 ms | 2.8 / 14.8 ms | 241 | 0 | wal | 0 / 0 |
| SQLite `opfs-sahpool`, single owner, batched, rollback | 496/s | 90.3 ms | 2.5 / 16.9 ms | 216 | 0 | delete | 0 / 0 |
| SQLite `opfs`, single owner, batched, WAL | 496/s | 86.2 ms | 2.4 / 16.3 ms | 222 | 0 | wal | 0 / 0 |

In every scenario: 0 long tasks, and at most 1 frame gap over 50 ms out of about 900 frames.

Notes:

- The write p95 of the batched rows is the 50 ms flush window plus the commit, which is the intended trade.
- The direct-SQLite rows ran with `maxPending: 64` per worker. Without it, the same scenario queued thousands of writes and needed more than 8 minutes to drain.
- The Chromium console showed the cause: `GetSyncHandleError … Access Handles cannot be created if there is another open Access Handle`. The `opfs` VFS retries this inside `xLock()` by blocking the worker with `Atomics.wait`, so even timers in the writer workers stop firing.

## Results: throughput ceiling (4 workers, saturating)

| Scenario | Ceiling | Write p95 | Read p95 during saturation | Transactions |
|---|---|---|---|---|
| IndexedDB, per-write | 1,479/s | 5.4 ms | 2.4 ms | 2,243 |
| IndexedDB, batched | 2,999/s | 1,113 ms | 292 ms | 10 (about 2,100 records each) |
| **SQLite `opfs-sahpool` owner, WAL** | **4,721/s** | 621 ms | 237 ms | 26 |

At saturation, batching lets reads queue behind very large write transactions (read p95 of 292 ms for IndexedDB). A production buffer should cap `maxBatch` (the default is 128) rather than flush everything queued.

## Results: quota exhaustion and eviction

The origin quota is forced to **40 MB** through DevTools (`Storage.overrideQuotaForOrigin`). One writer saturates the store with 2 KB records of random, incompressible padding. The main thread reads the newest 50 rows every 100 ms throughout. Two policies were tested:

- **Hard limit:** write until the quota error, then try to recover by deleting the oldest 10 % and probing with 100 writes.
- **evict-80:** a soft watermark. Every 1,000 records, check `navigator.storage.estimate()`. Once usage passes 80 %, delete the oldest records down to 60 %.

| Scenario | Committed | Quota error | Recovery after the error | Evictions | Read p95 / max |
|---|---|---|---|---|---|
| IndexedDB, hard limit | 18,944 in 15 s | at record 19,456; usage reported 54 MB | **failed: the delete itself threw `QuotaExceededError`** | — | 262 / 302 ms |
| SQLite `opfs-sahpool` owner (WAL), hard limit | 14,578 in 22 s | at record 15,078, as `SQLITE_IOERR` (see below); usage exactly 40 MB | **failed: the delete returned `SQLITE_IOERR`** (WAL frames need space) | — | 494 / 2,029 ms |
| IndexedDB, evict-80 | 26,112 in 23 s | once, at record 26,624 | **succeeded:** 1,327 deleted, 100 of 100 probes written | 12 runs, 24,785 rows, **136 ms** each (p95 167 ms) | 316 / 454 ms |
| SQLite `opfs-sahpool` owner (WAL), evict-80 | 25,000 in 60 s | **none** | not needed | 16 runs, 22,515 rows, p50 1.6 s, max 6.3 s | 1,378 / 6,270 ms |

`navigator.storage.persist()` was **refused** (`false`) in every run, so this origin stays evictable under disk pressure. No run dropped frames or produced long tasks.

What this shows:

1. **At the hard limit, neither engine can dig itself out.** Deleting needs free space: LevelDB writes tombstones, and SQLite WAL writes frames. The hard-limit rows failed the same way in all three IndexedDB runs and both SQLite runs. A full origin stays stuck until the user clears site data. Eviction therefore has to happen **before** the quota is reached.
2. **The watermark keeps both engines usable,** but the details differ:
   - SQLite stayed at about 33 MB with zero errors, because freed pages are reused immediately.
   - IndexedDB still hit the quota once. Its usage estimate reached 106 % of the quota between two checks, because deleted rows are not released until LevelDB compacts. It stayed **recoverable**, though, because the watermark had left headroom.

   IndexedDB needs a lower watermark or an app-side byte counter.
3. **SQLite's quota error is silent without classification.** `opfs-sahpool` logs `Unknown write() failure` and returns a generic `SQLITE_IOERR`, never `SQLITE_FULL`. Before `classifySqliteError()` was added, the writer never recognised the quota: an earlier run produced **123,405 failed writes** over 120 s. The classifier checks `estimate()` when an I/O error occurs and rethrows it as `QuotaExceededError` when usage is at 98 % of the quota or more.
4. **Eviction cost.**
   - In IndexedDB, a per-row cursor delete took 1.8–2.1 s per eviction of about 3,000 rows. The single key-range delete brought that down to **136 ms**.
   - In SQLite, eviction runs on the one owner connection, so reads queue behind it. That produced the 6 s read maximum. Evict in smaller, more frequent chunks there.
5. Chromium enforces the IndexedDB quota loosely: usage reached 54 MB against a 40 MB quota before the error. Treat `estimate()` as approximate.

Reproduce: `CHROMIUM_PATH=/path/to/chrome node scripts/spikes/storage_contention_benchmark.js --only quota/ --out docs/spikes/results/storage-quota.json` (about 3 minutes).

## Findings

1. **At the target of 500/s, IndexedDB's transaction locking was not the bottleneck** on this machine. Reads stayed under 3 ms at p95 even with 1,875 overlapping per-write transactions. The starvation described in the issue did not reproduce on an idle desktop-class CPU.
2. **CPU pressure changes that.** One early run happened by accident while a heavy fuzz job was using the CPU. In that run, per-write IndexedDB fell to 264–287/s with write p95 around 10–11 s, while the batched configuration still held about 490/s. That run was uncontrolled and is not in the JSON. `--cpu-stress N` was added to measure this properly and has not been run yet.
3. **Group commit is the cheap, backend-independent fix.** It cut transactions 8× and doubled the IndexedDB ceiling.
4. **Multi-connection SQLite on OPFS is not viable**, because each OPFS file allows one sync access handle. It was 7–13× slower than IndexedDB at the same load, stalled reads for 18 s, crashed a page, and WAL was refused without exclusive locking.
5. **Single-owner SQLite is the fastest option** at 4,721/s with no lock waits. WAL made only a small difference against rollback at 500/s. Its cost is the owner topology: cross-tab owner election and a message hop that added about 12 ms to read p95.

## Not measured (outstanding)

- Eviction by the browser itself under real disk pressure. A page cannot trigger it, and Chromium applies its best-effort LRU policy to whole origins unless `persist()` is granted. It was refused here.
- Real low-end Android devices.
- Contention across several tabs. This spike used several workers in one tab; each tab would add its own connections.
