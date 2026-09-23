/**
 * High-throughput offline client storage (spike #607, ADR-007).
 *
 * Three pieces, usable from the main thread or a Web Worker:
 *
 *  - `WriteAheadBuffer` — a backend-agnostic in-memory write-ahead buffer
 *    that group-commits queued records into ONE transaction per flush
 *    (size- or time-triggered). This is what removes IndexedDB lock
 *    contention: 500 writes/s become ~20 transactions/s.
 *  - `IndexedDbBackend` — native IndexedDB with explicit durability hints.
 *  - `SqliteOpfsBackend` — SQLite WASM on the Origin Private File System
 *    (`opfs`, `opfs-wl` or `opfs-sahpool` VFS) with optional WAL journal.
 *
 * `createStorageEngine()` wires a backend behind a buffer and exposes
 * append/flush/read/stats. Nothing in the app imports this yet; the
 * contention benchmark (scripts/spikes/storage_contention_benchmark.js)
 * drives it through src/workers/telemetryWorker.js.
 */

export const STORES = ["telemetry", "messages", "frames"];

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Compact latency summary; `samples` is left untouched. */
export function summarize(samples) {
  if (!samples.length) return { n: 0 };
  const s = Float64Array.from(samples).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  let sum = 0;
  for (const v of s) sum += v;
  const r = (v) => Math.round(v * 100) / 100;
  return { n: s.length, mean: r(sum / s.length), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

/** True for IndexedDB/OPFS/SQLite "disk full" style failures. */
export function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || "";
  const msg = String(err.message || err);
  return (
    name === "QuotaExceededError" ||
    /quota|SQLITE_FULL|database or disk is full|no space/i.test(msg)
  );
}

// ── Write-ahead buffer (group commit) ───────────────────────────────────────

export class WriteAheadBuffer {
  /**
   * @param {(store: string, records: object[]) => Promise<unknown>} sink
   *   commits one batch atomically (one transaction).
   * @param {object} [options]
   * @param {number} [options.maxBatch=128] flush as soon as this many are queued
   * @param {number} [options.flushMs=50] otherwise flush this long after the first enqueue
   * @param {number} [options.maxBuffered=20000] backpressure threshold
   * @param {"drop-oldest"|"reject"} [options.overflow="drop-oldest"]
   *   telemetry prefers losing stale fixes to blocking producers.
   */
  constructor(sink, { maxBatch = 128, flushMs = 50, maxBuffered = 20000, overflow = "drop-oldest" } = {}) {
    this.sink = sink;
    this.maxBatch = maxBatch;
    this.flushMs = flushMs;
    this.maxBuffered = maxBuffered;
    this.overflow = overflow;
    this.queue = [];
    this.timer = null;
    this.inflight = null;
    this.metrics = { enqueued: 0, committed: 0, dropped: 0, failed: 0, batches: 0, queueWaitMs: [], commitMs: [], batchSizes: [] };
  }

  get size() {
    return this.queue.length;
  }

  /** Resolves once the record is durably committed (or rejects). */
  enqueue(store, record) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxBuffered) {
        if (this.overflow === "reject") {
          this.metrics.dropped++;
          reject(new Error("WriteAheadBuffer full"));
          return;
        }
        const dropped = this.queue.shift();
        this.metrics.dropped++;
        dropped.reject(new Error("Dropped by WriteAheadBuffer (overflow)"));
      }
      this.queue.push({ store, record, t: now(), resolve, reject });
      this.metrics.enqueued++;
      if (this.queue.length >= this.maxBatch) this.#schedule(0);
      else this.#schedule(this.flushMs);
    });
  }

  #schedule(delay) {
    if (this.timer !== null) {
      if (delay > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delay);
  }

  /** Commits everything queued so far. Only one flush runs at a time. */
  async flush() {
    while (this.inflight) await this.inflight.catch(() => {});
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.inflight = this.#commit(batch);
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
      if (this.queue.length) this.#schedule(this.queue.length >= this.maxBatch ? 0 : this.flushMs);
    }
  }

  async #commit(batch) {
    const byStore = new Map();
    for (const item of batch) {
      let list = byStore.get(item.store);
      if (!list) byStore.set(item.store, (list = []));
      list.push(item);
    }
    const start = now();
    const m = this.metrics;
    let firstError = null;
    for (const [store, items] of byStore) {
      try {
        await this.sink(store, items.map((i) => i.record));
        const done = now();
        m.batches++;
        m.batchSizes.push(items.length);
        m.commitMs.push(done - start);
        for (const i of items) {
          m.queueWaitMs.push(start - i.t);
          m.committed++;
          i.resolve(done - i.t);
        }
      } catch (err) {
        m.failed += items.length;
        for (const i of items) i.reject(err);
        firstError = firstError || err;
      }
    }
    if (firstError) throw firstError;
  }

  async close() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  stats() {
    const m = this.metrics;
    return {
      enqueued: m.enqueued,
      committed: m.committed,
      dropped: m.dropped,
      failed: m.failed,
      batches: m.batches,
      avgBatch: m.batches ? Math.round((m.committed / m.batches) * 10) / 10 : 0,
      queueWaitMs: summarize(m.queueWaitMs),
      commitMs: summarize(m.commitMs),
    };
  }
}

// ── IndexedDB backend ───────────────────────────────────────────────────────

export class IndexedDbBackend {
  constructor({ dbName = "helphone-offline", durability = "default", idb, keyRange } = {}) {
    this.dbName = dbName;
    this.durability = durability;
    this.idb = idb || (typeof indexedDB !== "undefined" ? indexedDB : null);
    this.keyRange = keyRange || (typeof IDBKeyRange !== "undefined" ? IDBKeyRange : null);
    this.db = null;
    this.kind = "indexeddb";
  }

  open() {
    if (!this.idb) return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES)
          if (!db.objectStoreNames.contains(name)) {
            const os = db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
            os.createIndex("ts", "ts");
          }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  }

  #tx(store, mode) {
    return this.durability === "default"
      ? this.db.transaction(store, mode)
      : this.db.transaction(store, mode, { durability: this.durability });
  }

  /**
   * One readwrite transaction for the whole batch. Resolves with
   * `lockWaitMs` (transaction created → first request served, i.e. the
   * time spent queued behind overlapping transactions) and `commitMs`.
   */
  writeBatch(store, records) {
    return new Promise((resolve, reject) => {
      const t0 = now();
      let firstAt = 0;
      const tx = this.#tx(store, "readwrite");
      const os = tx.objectStore(store);
      records.forEach((r, i) => {
        const req = os.add(r);
        if (i === 0) req.onsuccess = () => (firstAt = now());
      });
      tx.oncomplete = () => resolve({ lockWaitMs: (firstAt || now()) - t0, commitMs: now() - t0 });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  /** Newest `limit` records (reverse primary-key cursor). */
  readLatest(store, limit = 50) {
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = this.#tx(store, "readonly");
      const req = tx.objectStore(store).openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value);
          cursor.continue();
        } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  count(store) {
    return new Promise((resolve, reject) => {
      const req = this.#tx(store, "readonly").objectStore(store).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Deletes the oldest `n` records (eviction / quota recovery). Finds the
   * n-th oldest key, then drops the whole key range in one request: a
   * per-row cursor delete took ~2 s per 3k rows in Chromium.
   */
  deleteOldest(store, n) {
    return new Promise((resolve, reject) => {
      let deleted = 0;
      const tx = this.#tx(store, "readwrite");
      const os = tx.objectStore(store);
      const counted = os.count();
      counted.onsuccess = () => {
        deleted = Math.min(n, counted.result);
        if (!deleted) return;
        const req = os.openKeyCursor();
        let skipped = false;
        let removed = 0;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (!this.keyRange) {
            // No IDBKeyRange available: per-row fallback.
            os.delete(cursor.primaryKey);
            if (++removed < deleted) cursor.continue();
            return;
          }
          if (!skipped && deleted > 1) {
            skipped = true;
            cursor.advance(deleted - 1);
            return;
          }
          os.delete(this.keyRange.upperBound(cursor.primaryKey));
        };
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}

// ── SQLite WASM on OPFS ─────────────────────────────────────────────────────

const TELEMETRY_COLUMNS = ["ts", "worker", "seq", "lat", "lng", "acc", "payload"];

export class SqliteOpfsBackend {
  /**
   * @param {object} [options]
   * @param {"opfs"|"opfs-wl"|"opfs-sahpool"|"memory"} [options.vfs="opfs-sahpool"]
   * @param {string} [options.filename="/helphone-offline.sqlite3"]
   * @param {"wal"|"delete"|"truncate"|"persist"|"memory"} [options.journalMode="wal"]
   * @param {boolean} [options.exclusive] `locking_mode=EXCLUSIVE`; required for
   *   WAL on the OPFS VFSes (no shared-memory wal-index in WASM).
   * @param {Function} [options.sqlite3InitModule] injectable for tests.
   */
  constructor({ vfs = "opfs-sahpool", filename = "/helphone-offline.sqlite3", journalMode = "wal", exclusive, synchronous = "normal", sqlite3InitModule } = {}) {
    this.vfs = vfs;
    this.filename = filename;
    this.journalMode = journalMode;
    this.exclusive = exclusive ?? journalMode === "wal";
    this.synchronous = synchronous;
    this.init = sqlite3InitModule;
    this.kind = `sqlite-${vfs}`;
    this.db = null;
    this.sqlite3 = null;
    this.pool = null;
    this.effectiveJournalMode = null;
    this.busyRetries = 0;
  }

  async open() {
    const init = this.init || (await import("@sqlite.org/sqlite-wasm")).default;
    const sqlite3 = await init();
    this.sqlite3 = sqlite3;
    const { oo1 } = sqlite3;
    if (this.vfs === "opfs-sahpool") {
      this.pool = await sqlite3.installOpfsSAHPoolVfs({ name: "helphone-sahpool", directory: "/helphone-sahpool", initialCapacity: 6 });
      this.db = new this.pool.OpfsSAHPoolDb(this.filename);
    } else if (this.vfs === "opfs") {
      if (!oo1.OpfsDb) throw new Error("opfs VFS unavailable (needs COOP/COEP + SharedArrayBuffer)");
      this.db = new oo1.OpfsDb(this.filename, "c");
    } else if (this.vfs === "opfs-wl") {
      if (!oo1.OpfsWlDb) throw new Error("opfs-wl VFS unavailable");
      this.db = new oo1.OpfsWlDb(this.filename, "c");
    } else {
      this.db = new oo1.DB(":memory:", "c");
    }
    // Pragmas that must precede the first read/write of the connection.
    if (this.exclusive) this.db.exec("PRAGMA locking_mode=EXCLUSIVE");
    this.effectiveJournalMode = String(this.db.selectValue(`PRAGMA journal_mode=${this.journalMode}`)).toLowerCase();
    this.db.exec(`PRAGMA synchronous=${this.synchronous}`);
    this.#withBusyRetrySync(() => {
      for (const store of STORES)
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS ${store} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${TELEMETRY_COLUMNS.map((c) => `${c} ${c === "payload" ? "TEXT" : "REAL"}`).join(", ")})`,
        );
    });
    return this;
  }

  #isBusy(err) {
    const rc = err && (err.resultCode ?? err.rc);
    return rc === 5 || rc === 6 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(err && err.message));
  }

  #withBusyRetrySync(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (!this.#isBusy(err) || attempt > 200) throw err;
        this.busyRetries++;
      }
    }
  }

  /**
   * One IMMEDIATE transaction per batch. SQLITE_BUSY (another connection
   * holds the write lock) is retried with backoff; the time spent retrying
   * is reported as `lockWaitMs`.
   */
  async writeBatch(store, records) {
    const t0 = now();
    let lockWaitMs = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        break;
      } catch (err) {
        if (!this.#isBusy(err) || attempt > 400) throw err;
        this.busyRetries++;
        const w0 = now();
        await new Promise((r) => setTimeout(r, Math.min(50, 1 + attempt)));
        lockWaitMs += now() - w0;
      }
    }
    try {
      const stmt = this.db.prepare(`INSERT INTO ${store} (${TELEMETRY_COLUMNS.join(",")}) VALUES (${TELEMETRY_COLUMNS.map(() => "?").join(",")})`);
      try {
        for (const r of records)
          stmt.bind(TELEMETRY_COLUMNS.map((c) => (c === "payload" ? JSON.stringify(r.payload ?? null) : r[c] ?? null))).stepReset();
      } finally {
        stmt.finalize();
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw await classifySqliteError(err);
    }
    return { lockWaitMs, commitMs: now() - t0 };
  }

  async readLatest(store, limit = 50) {
    return this.#withBusyRetrySync(() => this.db.selectObjects(`SELECT * FROM ${store} ORDER BY id DESC LIMIT ?`, [limit]));
  }

  async count(store) {
    return this.#withBusyRetrySync(() => Number(this.db.selectValue(`SELECT count(*) FROM ${store}`)));
  }

  async deleteOldest(store, n) {
    this.db.exec({ sql: `DELETE FROM ${store} WHERE id IN (SELECT id FROM ${store} ORDER BY id LIMIT ?)`, bind: [n] });
    return this.db.changes();
  }

  /** Folds the WAL back into the main db file (bounded WAL growth). */
  checkpoint(mode = "TRUNCATE") {
    if (this.effectiveJournalMode !== "wal") return null;
    return this.db.selectArray(`PRAGMA wal_checkpoint(${mode})`);
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
    if (this.pool && this.pool.pauseVfs) {
      try {
        this.pool.pauseVfs();
      } catch {
        // other handles still open
      }
    }
  }
}

/**
 * `opfs-sahpool` reports a full origin as a generic I/O error (the VFS logs
 * "Unknown write() failure"), never SQLITE_FULL, so writers would retry
 * forever. Treat an I/O error at (nearly) full quota as a quota error.
 */
export async function classifySqliteError(err, estimate = estimateStorage) {
  if (isQuotaError(err) || !/SQLITE_IOERR|disk I\/O error/i.test(String(err && err.message))) return err;
  const est = await estimate().catch(() => null);
  if (!est || !est.quota || est.usage < est.quota * 0.98) return err;
  const quotaErr = new Error(`Storage quota exhausted (${err.message})`);
  quotaErr.name = "QuotaExceededError";
  quotaErr.cause = err;
  return quotaErr;
}

// ── In-memory backend (tests / fallback when no persistent storage) ─────────

export class MemoryBackend {
  constructor({ commitDelayMs = 0 } = {}) {
    this.kind = "memory";
    this.stores = new Map(STORES.map((s) => [s, []]));
    this.nextId = 1;
    this.commitDelayMs = commitDelayMs;
    this.transactions = 0;
  }

  async open() {
    return this;
  }

  async writeBatch(store, records) {
    const t0 = now();
    if (this.commitDelayMs) await new Promise((r) => setTimeout(r, this.commitDelayMs));
    const list = this.stores.get(store);
    for (const r of records) list.push({ ...r, id: this.nextId++ });
    this.transactions++;
    return { lockWaitMs: 0, commitMs: now() - t0 };
  }

  async readLatest(store, limit = 50) {
    return this.stores.get(store).slice(-limit).reverse();
  }

  async count(store) {
    return this.stores.get(store).length;
  }

  async deleteOldest(store, n) {
    return this.stores.get(store).splice(0, n).length;
  }

  close() {}
}

// ── Engine facade ───────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {"indexeddb"|"opfs-sqlite"|"memory"|object} [options.backend="indexeddb"]
 *   a backend name or an already-constructed backend instance.
 * @param {false|object} [options.buffer] WriteAheadBuffer options, or
 *   `false` to commit every write in its own transaction (the naive path).
 */
export async function createStorageEngine({ backend = "indexeddb", backendOptions = {}, buffer = {} } = {}) {
  const impl =
    typeof backend === "object"
      ? backend
      : backend === "opfs-sqlite"
        ? new SqliteOpfsBackend(backendOptions)
        : backend === "memory"
          ? new MemoryBackend(backendOptions)
          : new IndexedDbBackend(backendOptions);
  await impl.open();

  const txn = { lockWaitMs: [], commitMs: [], count: 0 };
  const sink = async (store, records) => {
    const r = await impl.writeBatch(store, records);
    txn.count++;
    txn.lockWaitMs.push(r.lockWaitMs);
    txn.commitMs.push(r.commitMs);
    return r;
  };
  const wab = buffer === false ? null : new WriteAheadBuffer(sink, buffer);
  const direct = { committed: 0, failed: 0, latencyMs: [] };

  return {
    backend: impl,
    /** Queue (buffered) or write (unbuffered) one record; resolves on commit. */
    async append(store, record) {
      if (wab) return wab.enqueue(store, record);
      const t0 = now();
      try {
        await sink(store, [record]);
        direct.committed++;
        const ms = now() - t0;
        direct.latencyMs.push(ms);
        return ms;
      } catch (err) {
        direct.failed++;
        throw err;
      }
    },
    flush: () => (wab ? wab.flush() : Promise.resolve()),
    readLatest: (store, limit) => impl.readLatest(store, limit),
    count: (store) => impl.count(store),
    deleteOldest: (store, n) => impl.deleteOldest(store, n),
    stats() {
      return {
        backend: impl.kind,
        journalMode: impl.effectiveJournalMode ?? null,
        busyRetries: impl.busyRetries ?? 0,
        transactions: txn.count,
        txnLockWaitMs: summarize(txn.lockWaitMs),
        txnCommitMs: summarize(txn.commitMs),
        buffer: wab ? wab.stats() : null,
        direct: wab ? null : { committed: direct.committed, failed: direct.failed, latencyMs: summarize(direct.latencyMs) },
      };
    },
    async close() {
      if (wab) await wab.close();
      impl.close();
    },
  };
}

/** navigator.storage quota/usage/persistence snapshot (null outside browsers). */
export async function estimateStorage() {
  const storage = typeof navigator !== "undefined" ? navigator.storage : null;
  if (!storage || !storage.estimate) return null;
  const { quota = 0, usage = 0, usageDetails } = await storage.estimate();
  const persisted = storage.persisted ? await storage.persisted() : null;
  return { quota, usage, usageDetails: usageDetails || null, persisted };
}
