// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  IndexedDbBackend,
  MemoryBackend,
  SqliteOpfsBackend,
  WriteAheadBuffer,
  createStorageEngine,
  classifySqliteError,
  estimateStorage,
  isQuotaError,
  summarize,
} from "../src/services/storageEngine.js";
import {
  attachOwnerPort,
  createForwardingEngine,
  createTelemetryGenerator,
  runAtRate,
  runWriter,
} from "../src/workers/telemetryWorker.js";

// ---------------------------------------------------------------------------
// High-throughput storage spike (#607): group-commit write-ahead buffer,
// IndexedDB / SQLite WASM backends, and the telemetry worker's writer loop.
// Real OPFS contention is measured in Chromium by
// scripts/spikes/storage_contention_benchmark.js; these tests pin semantics.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});

function recordingSink({ fail } = {}) {
  const calls = [];
  const sink = async (store, records) => {
    calls.push({ store, records: records.slice() });
    if (fail && fail(store)) throw Object.assign(new Error("disk full"), { name: "QuotaExceededError" });
  };
  return { calls, sink };
}

describe("WriteAheadBuffer", () => {
  it("group-commits everything queued within flushMs into one batch", async () => {
    vi.useFakeTimers();
    const { calls, sink } = recordingSink();
    const wab = new WriteAheadBuffer(sink, { flushMs: 50, maxBatch: 1000 });
    const writes = Array.from({ length: 25 }, (_, i) => wab.enqueue("telemetry", { i }));
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(writes);
    expect(calls).toHaveLength(1);
    expect(calls[0].records).toHaveLength(25);
    expect(wab.stats()).toMatchObject({ committed: 25, batches: 1, avgBatch: 25 });
  });

  it("flushes immediately when maxBatch is reached", async () => {
    vi.useFakeTimers();
    const { calls, sink } = recordingSink();
    const wab = new WriteAheadBuffer(sink, { flushMs: 10_000, maxBatch: 10 });
    const writes = Array.from({ length: 10 }, (_, i) => wab.enqueue("telemetry", { i }));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(writes);
    expect(calls).toHaveLength(1);
  });

  it("commits one transaction per store and isolates a failing store", async () => {
    const { calls, sink } = recordingSink({ fail: (s) => s === "frames" });
    const wab = new WriteAheadBuffer(sink, { flushMs: 0 });
    const ok = wab.enqueue("telemetry", { a: 1 });
    const bad = wab.enqueue("frames", { b: 1 });
    const ok2 = wab.enqueue("messages", { c: 1 });
    await expect(ok).resolves.toBeTypeOf("number");
    await expect(bad).rejects.toThrow("disk full");
    await expect(ok2).resolves.toBeTypeOf("number");
    expect(calls.map((c) => c.store)).toEqual(["telemetry", "frames", "messages"]);
    expect(wab.stats()).toMatchObject({ committed: 2, failed: 1 });
  });

  it("never runs two commits at once", async () => {
    let active = 0;
    let maxActive = 0;
    const sink = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    const wab = new WriteAheadBuffer(sink, { flushMs: 0, maxBatch: 2 });
    const writes = [];
    for (let i = 0; i < 20; i++) {
      writes.push(wab.enqueue("telemetry", { i }));
      if (i % 3 === 0) wab.flush();
    }
    await Promise.all(writes);
    expect(maxActive).toBe(1);
  });

  it("drops the oldest record when the buffer overflows", async () => {
    vi.useFakeTimers();
    const { calls, sink } = recordingSink();
    const wab = new WriteAheadBuffer(sink, { flushMs: 100, maxBatch: 100, maxBuffered: 3 });
    const writes = [1, 2, 3, 4].map((i) => wab.enqueue("telemetry", { i }));
    await expect(writes[0]).rejects.toThrow(/overflow/);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(writes.slice(1));
    expect(calls[0].records.map((r) => r.i)).toEqual([2, 3, 4]);
    expect(wab.stats().dropped).toBe(1);
  });

  it("rejects new records instead when overflow is 'reject'", async () => {
    const wab = new WriteAheadBuffer(async () => {}, { flushMs: 1000, maxBatch: 100, maxBuffered: 1, overflow: "reject" });
    const first = wab.enqueue("telemetry", {});
    await expect(wab.enqueue("telemetry", {})).rejects.toThrow(/full/);
    await wab.close();
    await expect(first).resolves.toBeTypeOf("number");
  });
});

describe("createStorageEngine", () => {
  it("batches through the buffer by default", async () => {
    const backend = new MemoryBackend();
    const engine = await createStorageEngine({ backend, buffer: { flushMs: 5 } });
    await Promise.all(Array.from({ length: 40 }, (_, i) => engine.append("telemetry", { ts: i })));
    expect(backend.transactions).toBe(1);
    expect(await engine.count("telemetry")).toBe(40);
    const latest = await engine.readLatest("telemetry", 3);
    expect(latest.map((r) => r.ts)).toEqual([39, 38, 37]);
    expect(engine.stats()).toMatchObject({ backend: "memory", transactions: 1 });
    await engine.close();
  });

  it("uses one transaction per write when buffering is disabled", async () => {
    const backend = new MemoryBackend();
    const engine = await createStorageEngine({ backend, buffer: false });
    for (let i = 0; i < 5; i++) await engine.append("telemetry", { ts: i });
    expect(backend.transactions).toBe(5);
    expect(engine.stats().direct).toMatchObject({ committed: 5, failed: 0 });
  });
});

describe("IndexedDbBackend (fake-indexeddb)", () => {
  it("writes batches atomically and reads newest-first", async () => {
    const idb = new IDBFactory();
    const engine = await createStorageEngine({
      backend: new IndexedDbBackend({ idb, keyRange: IDBKeyRange, dbName: "t1", durability: "relaxed" }),
      buffer: { flushMs: 1 },
    });
    await Promise.all(Array.from({ length: 30 }, (_, i) => engine.append("telemetry", { ts: i, lat: 1, lng: 2 })));
    expect(await engine.count("telemetry")).toBe(30);
    expect((await engine.readLatest("telemetry", 2)).map((r) => r.ts)).toEqual([29, 28]);
    expect(await engine.deleteOldest("telemetry", 10)).toBe(10);
    expect(await engine.count("telemetry")).toBe(20);
    // the oldest were removed, the newest kept
    expect((await engine.readLatest("telemetry", 30)).map((r) => r.ts).sort((a, b) => a - b)[0]).toBe(10);
    expect(await engine.deleteOldest("telemetry", 1)).toBe(1);
    expect(await engine.deleteOldest("telemetry", 100)).toBe(19);
    expect(await engine.count("telemetry")).toBe(0);
    expect(await engine.deleteOldest("telemetry", 5)).toBe(0);
    const stats = engine.stats();
    expect(stats.transactions).toBe(1);
    expect(stats.txnLockWaitMs.n).toBe(1);
    await engine.close();
  });

  it("fails cleanly without IndexedDB", async () => {
    const backend = new IndexedDbBackend({ idb: null });
    backend.idb = null;
    await expect(backend.open()).rejects.toThrow(/unavailable/);
  });
});

describe("SqliteOpfsBackend (sqlite-wasm, in-memory VFS under Node)", () => {
  it("round-trips records through prepared inserts in one transaction", async () => {
    const backend = new SqliteOpfsBackend({ vfs: "memory", sqlite3InitModule, journalMode: "wal" });
    const engine = await createStorageEngine({ backend, buffer: { flushMs: 1 } });
    // :memory: databases cannot use WAL; the effective mode is reported.
    expect(engine.stats().journalMode).toBe("memory");
    const gen = createTelemetryGenerator({ worker: 2 });
    await Promise.all(Array.from({ length: 50 }, () => engine.append("telemetry", gen())));
    expect(await engine.count("telemetry")).toBe(50);
    const [newest] = await engine.readLatest("telemetry", 1);
    expect(newest).toMatchObject({ worker: 2, seq: 49 });
    expect(JSON.parse(newest.payload)).toHaveProperty("heading");
    expect(await engine.deleteOldest("telemetry", 20)).toBe(20);
    expect(backend.checkpoint()).toBeNull();
    await engine.close();
  });

  it("rolls back a failing batch", async () => {
    const backend = await new SqliteOpfsBackend({ vfs: "memory", sqlite3InitModule }).open();
    await expect(backend.writeBatch("no_such_table", [{ ts: 1 }])).rejects.toThrow();
    await backend.writeBatch("telemetry", [{ ts: 1 }]);
    expect(await backend.count("telemetry")).toBe(1);
    backend.close();
  });
});

describe("telemetry worker helpers", () => {
  it("generates deterministic per-worker fixes", () => {
    const a = createTelemetryGenerator({ worker: 1 });
    const b = createTelemetryGenerator({ worker: 1 });
    const fa = a();
    const fb = b();
    expect({ ...fa, ts: 0 }).toEqual({ ...fb, ts: 0 });
    expect(a().seq).toBe(1);
  });

  it("emits the requested number of ticks despite coarse timers", async () => {
    let ticks = 0;
    const n = await runAtRate(500, 100, () => ticks++);
    expect(n).toBe(50);
    expect(ticks).toBe(50);
  });

  it("runWriter reports throughput and latency against a backend", async () => {
    const engine = await createStorageEngine({ backend: new MemoryBackend(), buffer: { flushMs: 5 } });
    const result = await runWriter({ worker: 0, rateHz: 200, durationMs: 100 }, engine);
    expect(result.committed).toBe(20);
    expect(result.unfinished).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.writeLatencyMs.n).toBe(20);
  });

  it("sheds fixes instead of queueing without bound when storage stalls", async () => {
    const engine = await createStorageEngine({ backend: new MemoryBackend({ commitDelayMs: 50 }), buffer: false });
    const result = await runWriter({ rateHz: 500, durationMs: 100, maxPending: 2 }, engine);
    expect(result.shed).toBeGreaterThan(0);
    expect(result.committed + result.shed).toBe(50);
  });

  it("stops at the quota and recovers after deleting the oldest records", async () => {
    let full = false;
    const backend = new MemoryBackend();
    const write = backend.writeBatch.bind(backend);
    backend.writeBatch = async (store, records) => {
      if (full) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      const r = await write(store, records);
      if ((await backend.count(store)) >= 300) full = true;
      return r;
    };
    const deleteOldest = backend.deleteOldest.bind(backend);
    backend.deleteOldest = async (store, n) => {
      full = false;
      return deleteOldest(store, n);
    };
    const engine = await createStorageEngine({ backend, buffer: { flushMs: 1, maxBatch: 50 } });
    const result = await runWriter({ saturate: true, durationMs: 2000, recoverAfterQuota: true }, engine);
    expect(result.quotaError).toMatchObject({ name: "QuotaExceededError" });
    expect(result.recovery).toMatchObject({ probeWrites: 100, probeFailures: 0 });
    expect(result.recovery.deleted).toBeGreaterThanOrEqual(100);
  });

  it("forwards writes to a single owner over a MessageChannel", async () => {
    const backend = new MemoryBackend();
    const owner = await createStorageEngine({ backend, buffer: { flushMs: 2 } });
    const writers = [0, 1, 2].map(() => {
      const { port1, port2 } = new MessageChannel();
      attachOwnerPort(owner, port2);
      return { engine: createForwardingEngine(port1), ports: [port1, port2] };
    });
    await Promise.all(
      writers.map(({ engine }, worker) => runWriter({ worker, rateHz: 100, durationMs: 100 }, engine)),
    );
    await owner.flush();
    expect(await backend.count("telemetry")).toBe(30);
    expect(backend.transactions).toBeLessThan(30);
    writers.forEach(({ ports }) => ports.forEach((p) => p.close()));
  });

  it("evicts the oldest records at a soft watermark before the quota is hit", async () => {
    const backend = new MemoryBackend();
    const quota = 2000;
    const original = globalThis.navigator;
    // usage = 1 unit per stored row, quota = 2,000 rows
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { estimate: async () => ({ quota, usage: await backend.count("telemetry") }) } },
      configurable: true,
    });
    try {
      const engine = await createStorageEngine({ backend, buffer: { flushMs: 1, maxBatch: 64 } });
      const result = await runWriter(
        { saturate: true, durationMs: 1500, inflight: 32, evictAtRatio: 0.8, evictCheckEvery: 100 },
        engine,
      );
      expect(result.quotaError).toBeNull();
      expect(result.eviction.runs).toBeGreaterThan(0);
      expect(result.committed).toBeGreaterThan(quota); // would have overrun without eviction
      // watermark (1,600) + one check interval (100) + in-flight window (32)
      expect(await backend.count("telemetry")).toBeLessThanOrEqual(quota);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  it("runs quota recovery on the owner for forwarding writers", async () => {
    const backend = new MemoryBackend();
    const owner = await createStorageEngine({ backend, buffer: { flushMs: 1 } });
    const { port1, port2 } = new MessageChannel();
    attachOwnerPort(owner, port2);
    const engine = createForwardingEngine(port1);
    await Promise.all(Array.from({ length: 20 }, (_, i) => engine.append("telemetry", { seq: i })));
    expect(await engine.deleteOldest("telemetry", 5)).toBe(5);
    expect(await backend.count("telemetry")).toBe(15);
    port1.close();
    port2.close();
  });
});

describe("helpers", () => {
  it("classifies quota errors across backends", () => {
    expect(isQuotaError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaError(new Error("SQLITE_FULL: database or disk is full"))).toBe(true);
    expect(isQuotaError(new Error("constraint failed"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it("reclassifies SQLite I/O errors as quota errors only when the origin is full", async () => {
    const ioErr = new Error("SQLITE_IOERR_WRITE: sqlite3 result code 778: disk I/O error");
    const full = async () => ({ quota: 100, usage: 99 });
    const roomy = async () => ({ quota: 100, usage: 50 });
    const reclassified = await classifySqliteError(ioErr, full);
    expect(reclassified.name).toBe("QuotaExceededError");
    expect(isQuotaError(reclassified)).toBe(true);
    expect(reclassified.cause).toBe(ioErr);
    expect(await classifySqliteError(ioErr, roomy)).toBe(ioErr);
    const other = new Error("constraint failed");
    expect(await classifySqliteError(other, full)).toBe(other);
  });

  it("summarises latency samples", () => {
    expect(summarize([])).toEqual({ n: 0 });
    const s = summarize([5, 1, 3, 2, 4]);
    expect(s).toMatchObject({ n: 5, mean: 3, p50: 3, max: 5 });
  });

  it("returns null storage estimates outside a browser", async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    try {
      expect(await estimateStorage()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });
});
