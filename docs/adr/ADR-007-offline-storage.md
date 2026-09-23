# ADR-007: High-Throughput Offline Client Storage: IndexedDB vs OPFS SQLite WASM

- **Status:** Proposed (spike #607 complete)
- **Date:** 2026-09-23
- **Evidence:** [Spike report](../spikes/607-storage-lock-contention-report.md) · raw results: [contention](../spikes/results/storage-contention.json), [quota and eviction](../spikes/results/storage-quota.json) · `scripts/spikes/storage_contention_benchmark.js`
- **Prototype:** `src/services/storageEngine.js`, `src/workers/telemetryWorker.js`

## Context

During incident peaks, GPS telemetry, broadcast messages and cached render frames all write concurrently from several workers and tabs. The concern was that IndexedDB transaction locking would starve reads and freeze tabs.

The spike ran 4 Web Workers writing 500 records/s in total in real Chromium 147, while the main thread read the newest 50 rows every 100 ms. It compared native IndexedDB with SQLite WASM on the Origin Private File System (OPFS), with and without write batching, and with WAL and rollback journals.

## Findings that drive the decision

| Configuration (4 workers, 500 writes/s) | Achieved | Write p95 | Read p95 | Notes |
|---|---|---|---|---|
| IndexedDB, 1 transaction per write | 497/s | 4.1 ms | 1.4 ms | 1,875 transactions |
| IndexedDB, batched (group commit every 50 ms) | 498/s | 60 ms* | 2.6 ms | 230 transactions |
| SQLite OPFS, **4 direct connections** (`opfs`) | **37/s** | 1.6 s | **18 s** | 2,449 writes shed; WAL refused |
| SQLite OPFS, 4 direct connections (`opfs-wl`, batched) | **66/s** | 2.8 s | 1.3 s | 5,117 writes shed, 955 errors. Per-write variant crashed the page. |
| **SQLite OPFS, single owner worker, WAL** (`opfs-sahpool`) | 497/s | 77 ms* | 15 ms | 241 transactions, no lock waits |

\* Batched write latency is dominated by the 50 ms flush window, by design.

Throughput ceilings (4 workers writing as fast as possible):

| Configuration | Ceiling |
|---|---|
| IndexedDB, per-write | 1,479/s |
| IndexedDB, batched | 2,999/s |
| **SQLite single owner, WAL** | **4,721/s** |

No configuration dropped main-thread frames. Storage work stays off the UI thread in every option.

Quota and eviction (origin quota forced to 40 MB, incompressible 2 KB records):

| | Write until the quota error | Evict at 80 % down to 60 % |
|---|---|---|
| IndexedDB | Error at 19k records; **recovery by delete fails** (the delete also throws `QuotaExceededError`) | Still hit the quota once, because `estimate()` lags compaction, but stayed recoverable; each eviction took 136 ms |
| SQLite owner (`opfs-sahpool`, WAL) | Error surfaces only as `SQLITE_IOERR`; **recovery by delete fails** | **Zero errors** over 60 s; usage flat at about 33 MB |

`navigator.storage.persist()` was refused in every run.

## Decision

1. **Keep IndexedDB as the storage engine for now, and put every high-frequency writer behind the group-commit `WriteAheadBuffer`.** At the target load of 500/s, native IndexedDB was not the bottleneck on this machine, even with one transaction per write. Batching cuts transactions 8×, doubles the throughput ceiling and needs no new dependency.
2. **Do not open SQLite/OPFS from several workers or tabs.** An OPFS file allows one sync access handle at a time. Multiple connections spend their time fighting for it: 37–66 writes/s, reads stalled for up to 18 s, the VFS blocks worker event loops synchronously, and one run crashed the page. WAL is refused in this mode anyway, because it needs `locking_mode=EXCLUSIVE`.
3. **If SQLite is adopted later** (for SQL queries, or throughput beyond about 3k/s), use exactly one **owner worker** per origin. It holds the only connection (`opfs-sahpool` VFS, `PRAGMA locking_mode=EXCLUSIVE; journal_mode=WAL`), and other workers and tabs forward writes to it over `MessagePort`. Owner election across tabs needs Web Locks or a SharedWorker. This topology gave the highest ceiling (4,721/s) with no lock waits. WAL and rollback journal differed little at 500/s (write p95 77 vs 90 ms).
4. **Shed load when storage stalls.** Producers get a bounded backlog (`maxPending`) and drop the oldest telemetry fixes. Unbounded queues turned a slow disk into minutes of backlog in the direct-SQLite runs. Broadcast messages must not be shed: give them their own store with `overflow: "reject"`, and surface the error.
5. **Evict before the quota, never after it.** A full origin cannot delete its way out, in either engine.
   - Run a retention job that checks `navigator.storage.estimate()` and deletes the oldest telemetry once usage passes a soft watermark. For IndexedDB use about 70 %, since its estimate lags compaction.
   - Use `deleteOldest`, which is a single key-range delete.
   - Request `navigator.storage.persist()` on first incident join, and plan for it being refused.
   - Treat `SQLITE_IOERR` at full quota as a quota error (`classifySqliteError()`); otherwise writers retry forever.

## Consequences

- **Positive:** No new runtime dependency. The buffer is backend-agnostic, so moving to the SQLite owner later is a backend swap behind `createStorageEngine()`.
- **Negative:** Group commit trades durability for throughput. A crash loses up to one flush window (50 ms) of buffered telemetry, which is acceptable for GPS fixes. Messages should use a zero-delay flush.
- **Outstanding (not measured):** a controlled **CPU-starved device** run. An uncontrolled early run under heavy background CPU load showed per-write IndexedDB falling to 264–287/s with write p95 above 10 s, while batching held about 490/s. `--cpu-stress` exists to measure this properly. Until it is measured, batching is also the safe default for low-end phones.
- **Follow-up:** wire the watermark retention job and the `persist()` request into the app, and run the outstanding CPU-starved measurement above.
