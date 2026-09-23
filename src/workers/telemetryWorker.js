/**
 * High-frequency GPS telemetry writer (spike #607, ADR-007).
 *
 * Each instance produces synthetic GPS fixes at `rateHz` and persists them
 * through `storageEngine`. Several instances running at once reproduce the
 * incident-peak contention pattern (telemetry + broadcasts + frame cache
 * writing concurrently from multiple workers/tabs).
 *
 * Roles:
 *   "writer"  — writes directly to its own backend connection
 *               (IndexedDB, or its own SQLite/OPFS connection).
 *   "forward" — sends fixes over a MessagePort to an "owner" worker instead
 *               of touching storage (single-writer topology).
 *   "owner"   — holds the only SQLite/OPFS connection, group-commits what
 *               forwarders send, and serves reads.
 *
 * Messages in:  { type: "start", config } | { type: "port", port } |
 *               { type: "read", id, store, limit } | { type: "stop" }
 * Messages out: { type: "ready" } | { type: "result", ... } |
 *               { type: "read:ok", id, rows, ms } | { type: "error", message }
 */

import {
  createStorageEngine,
  estimateStorage,
  isQuotaError,
  summarize,
} from "../services/storageEngine.js";

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Deterministic random-walk GPS generator around a start point. */
export function createTelemetryGenerator({ worker = 0, seed = 1, lat = 6.5244, lng = 3.3792, payloadBytes = 96 } = {}) {
  let s = (seed * 2654435761 + worker) >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Random padding: storage engines compress (Chromium's IndexedDB uses
  // Snappy), so repeated characters would understate the bytes on disk.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padLength = Math.max(0, payloadBytes - 40);
  let seq = 0;
  return () => {
    lat += (rand() - 0.5) * 1e-4;
    lng += (rand() - 0.5) * 1e-4;
    return {
      ts: Date.now(),
      worker,
      seq: seq++,
      lat,
      lng,
      acc: 3 + rand() * 12,
      payload: {
        heading: Math.round(rand() * 360),
        speed: Math.round(rand() * 20),
        pad: Array.from({ length: padLength }, () => ALPHABET[(rand() * 64) | 0]).join(""),
      },
    };
  };
}

/**
 * Calls `tick()` at `rateHz` for `durationMs` with drift correction:
 * timers are coarse (≥4 ms clamping, worker throttling), so each wake-up
 * emits however many ticks are due. Resolves with the tick count.
 */
export function runAtRate(rateHz, durationMs, tick, { maxPerWake = 1000 } = {}) {
  return new Promise((resolve) => {
    const start = now();
    const interval = 1000 / rateHz;
    let emitted = 0;
    const wake = () => {
      const elapsed = now() - start;
      const due = Math.min(Math.floor(Math.min(elapsed, durationMs) / interval) + 1, Math.ceil((durationMs / 1000) * rateHz));
      let n = 0;
      while (emitted < due && n++ < maxPerWake) {
        tick(emitted);
        emitted++;
      }
      if (elapsed >= durationMs) resolve(emitted);
      else setTimeout(wake, Math.max(0, Math.min(interval, 10)));
    };
    wake();
  });
}

export async function runWriter(config, sinkOverride) {
  const {
    worker = 0,
    rateHz = 125,
    durationMs = 10000,
    store = "telemetry",
    backend = "indexeddb",
    backendOptions = {},
    buffer = {},
    saturate = false,
    payloadBytes = 96,
    stopOnQuota = true,
    recoverAfterQuota = false,
    drainTimeoutMs = 10000,
    maxPending = Infinity,
    evictAtRatio = null,
    evictFraction = 0.2,
    evictCheckEvery = 1000,
    inflight = buffer === false ? 1 : 512,
  } = config;
  const engine = sinkOverride || (await createStorageEngine({ backend, backendOptions, buffer }));
  const next = createTelemetryGenerator({ worker, payloadBytes });
  const latencies = [];
  const pendingWrites = new Set();
  let errors = 0;
  let quotaError = null;
  let produced = 0;
  let shed = 0;
  const t0 = now();

  // Soft-watermark eviction: at quota, IndexedDB rejects even deletes, so
  // free space BEFORE usage reaches the quota rather than after the error.
  const eviction = evictAtRatio ? { checks: 0, runs: 0, deleted: 0, maxUsageRatio: 0, evictMs: [] } : null;
  let live = 0;
  let nextCheck = evictCheckEvery;
  const maybeEvict = async () => {
    if (!eviction || produced < nextCheck || !engine.deleteOldest) return;
    nextCheck = produced + evictCheckEvery;
    const est = await estimateStorage();
    if (!est || !est.quota) return;
    eviction.checks++;
    const ratio = est.usage / est.quota;
    eviction.maxUsageRatio = Math.max(eviction.maxUsageRatio, Math.round(ratio * 1000) / 1000);
    if (ratio < evictAtRatio) return;
    const e0 = now();
    await engine.flush();
    // Evict down to the low watermark (evictAtRatio - evictFraction), however
    // far usage overshot between checks.
    const share = Math.max(evictFraction, 1 - Math.max(0, evictAtRatio - evictFraction) / ratio);
    const deleted = await engine.deleteOldest(store, Math.max(100, Math.ceil(live * share)));
    live -= deleted;
    eviction.runs++;
    eviction.deleted += deleted;
    eviction.evictMs.push(now() - e0);
  };

  const writeOne = () => {
    produced++;
    const p = engine
      .append(store, next())
      .then((ms) => {
        latencies.push(ms);
        live++;
      })
      .catch((err) => {
        errors++;
        if (!quotaError && isQuotaError(err)) quotaError = { name: err.name, message: String(err.message || err), atRecord: produced, atMs: now() - t0 };
      })
      .finally(() => pendingWrites.delete(p));
    pendingWrites.add(p);
    return p;
  };

  if (saturate) {
    // Throughput ceiling: keep a bounded number of writes in flight.
    while (now() - t0 < durationMs && !(stopOnQuota && quotaError)) {
      while (pendingWrites.size < inflight) writeOne();
      await Promise.race(pendingWrites);
      await maybeEvict().catch((err) => {
        if (!quotaError && isQuotaError(err)) quotaError = { name: err.name, message: String(err.message || err), atRecord: produced, atMs: now() - t0, duringEviction: true };
      });
    }
  } else {
    await runAtRate(rateHz, durationMs, () => {
      if (stopOnQuota && quotaError) return;
      // Backpressure: past maxPending in-flight writes, shed the fix.
      if (pendingWrites.size >= maxPending) shed++;
      else writeOne();
    });
  }
  // Drain the backlog, but give up after drainTimeoutMs: under heavy lock
  // contention the queue can take minutes to clear, which is itself the result.
  let drainTimer;
  await Promise.race([
    engine.flush().catch(() => {}).then(() => Promise.allSettled([...pendingWrites])),
    new Promise((r) => (drainTimer = setTimeout(r, drainTimeoutMs))),
  ]);
  clearTimeout(drainTimer);
  const unfinished = pendingWrites.size;
  const elapsedMs = now() - t0;

  // Eviction/quota recovery: free the oldest 10 % and check writes resume.
  let recovery = null;
  if (quotaError && recoverAfterQuota && engine.deleteOldest) {
    try {
      const deleted = await engine.deleteOldest(store, Math.max(100, Math.ceil(latencies.length * 0.1)));
      const probes = Array.from({ length: 100 }, () => engine.append(store, next()));
      await engine.flush();
      const settled = await Promise.allSettled(probes);
      const failed = settled.filter((r) => r.status === "rejected");
      recovery = { deleted, probeWrites: probes.length, probeFailures: failed.length, error: failed[0] ? String(failed[0].reason?.message || failed[0].reason) : null };
    } catch (err) {
      recovery = { error: String(err.message || err) };
    }
  }
  const stats = engine.stats();
  if (!sinkOverride && !unfinished) await engine.close().catch(() => {});
  return {
    worker,
    produced,
    committed: latencies.length,
    shed,
    unfinished,
    errors,
    quotaError,
    elapsedMs: Math.round(elapsedMs),
    achievedPerSec: Math.round((latencies.length / elapsedMs) * 1000),
    writeLatencyMs: summarize(latencies),
    recovery,
    eviction: eviction && { ...eviction, evictMs: summarize(eviction.evictMs) },
    engine: stats,
  };
}

/**
 * Adapter so a "forward" writer can use the same runWriter loop: every
 * append is posted to the owner, which acks once committed.
 */
export function createForwardingEngine(port) {
  let nextId = 0;
  const waiting = new Map();
  port.onmessage = (e) => {
    const { id, ok, ms, error } = e.data;
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (ok) w.resolve(ms);
    else w.reject(Object.assign(new Error(error.message), { name: error.name }));
  };
  const request = (msg) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      port.postMessage({ id, ...msg });
    });
  return {
    append(store, record) {
      const t0 = now();
      return request({ store, record }).then(() => now() - t0);
    },
    /** Quota recovery runs on the owner, which holds the only connection. */
    deleteOldest: (store, n) => request({ op: "deleteOldest", store, n }),
    flush: async () => {},
    stats: () => ({ backend: "forward", forwarded: nextId }),
    close: async () => port.close(),
  };
}

/** Owner side: accepts forwarded records on any number of ports. */
export function attachOwnerPort(engine, port) {
  port.onmessage = (e) => {
    const { id, op, store, record, n } = e.data;
    const work = op === "deleteOldest" ? engine.flush().then(() => engine.deleteOldest(store, n)) : engine.append(store, record);
    work.then(
      (ms) => port.postMessage({ id, ok: true, ms }),
      (err) => port.postMessage({ id, ok: false, error: { name: err.name, message: String(err.message || err) } }),
    );
  };
}

// ── Worker bootstrap ────────────────────────────────────────────────────────

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  let ownerEngine = null;
  const ports = [];
  const fail = (err) => self.postMessage({ type: "error", message: String((err && err.message) || err), name: err && err.name });

  self.onmessage = async (event) => {
    const msg = event.data || {};
    try {
      if (msg.type === "port") {
        if (ownerEngine) attachOwnerPort(ownerEngine, msg.port);
        else ports.push(msg.port);
        return;
      }
      if (msg.type === "read") {
        const t0 = now();
        const rows = await ownerEngine.readLatest(msg.store || "telemetry", msg.limit || 50);
        self.postMessage({ type: "read:ok", id: msg.id, rows: rows.length, ms: now() - t0 });
        return;
      }
      if (msg.type === "stop") {
        if (ownerEngine) {
          await ownerEngine.flush();
          const stats = ownerEngine.stats();
          const counts = { telemetry: await ownerEngine.count("telemetry") };
          await ownerEngine.close();
          ownerEngine = null;
          self.postMessage({ type: "result", role: "owner", engine: stats, counts, storage: await estimateStorage() });
        }
        return;
      }
      if (msg.type !== "start") return;
      const config = msg.config || {};
      if (config.role === "owner") {
        ownerEngine = await createStorageEngine(config);
        for (const p of ports.splice(0)) attachOwnerPort(ownerEngine, p);
        self.postMessage({ type: "ready", role: "owner", journalMode: ownerEngine.stats().journalMode });
        return;
      }
      const sink = config.role === "forward" ? createForwardingEngine(ports.shift()) : undefined;
      self.postMessage({ type: "ready", role: config.role || "writer" });
      const result = await runWriter(config, sink);
      self.postMessage({ type: "result", role: config.role || "writer", ...result });
    } catch (err) {
      fail(err);
    }
  };
}
