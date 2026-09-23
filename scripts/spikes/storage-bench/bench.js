/**
 * Spike #607 — in-browser storage contention harness.
 *
 * `window.runBench(scenario)` spins up N telemetry workers (each writing at
 * `rateHz`), a main-thread reader polling the newest rows every
 * `readerIntervalMs`, and a frame monitor, then reports write latency,
 * transaction lock waits, read latency (starvation), dropped frames and
 * storage usage. Scenarios are described in storage_contention_benchmark.js.
 */

import { IndexedDbBackend, estimateStorage, summarize } from "/src/services/storageEngine.js";

const WORKER_URL = new URL("/src/workers/telemetryWorker.js", location.origin);
const log = (line) => {
  document.getElementById("log").textContent += "\n" + line;
};

function spawn() {
  return new Worker(WORKER_URL, { type: "module" });
}

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (e) => {
      if (e.data.type === type) {
        worker.removeEventListener("message", onMessage);
        resolve(e.data);
      } else if (e.data.type === "error") {
        worker.removeEventListener("message", onMessage);
        reject(new Error(e.data.message));
      }
    };
    worker.addEventListener("message", onMessage);
  });
}

async function resetStorage(dbName) {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
  } catch (err) {
    log("OPFS reset failed: " + err.message);
  }
}

function startFrameMonitor() {
  const gaps = [];
  let last = performance.now();
  let running = true;
  const frame = (t) => {
    gaps.push(t - last);
    last = t;
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const longTasks = [];
  let obs = null;
  try {
    obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask unsupported
  }
  return () => {
    running = false;
    if (obs) obs.disconnect();
    return {
      frames: gaps.length,
      frameGapMs: summarize(gaps),
      framesOver50ms: gaps.filter((g) => g > 50).length,
      longTasks: longTasks.length,
      longestTaskMs: Math.round(Math.max(0, ...longTasks)),
    };
  };
}

function startReader(readOnce, intervalMs) {
  const latencies = [];
  let errors = 0;
  let stopped = false;
  let inflight = null;
  const loop = async () => {
    while (!stopped) {
      const t0 = performance.now();
      inflight = readOnce();
      try {
        await inflight;
        latencies.push(performance.now() - t0);
      } catch {
        errors++;
      }
      const spent = performance.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - spent)));
    }
  };
  const done = loop();
  return async () => {
    stopped = true;
    await done;
    return { reads: latencies.length, errors, readLatencyMs: summarize(latencies) };
  };
}

window.runBench = async function runBench(scenario) {
  const {
    name,
    workers = 4,
    rateHz = 125,
    durationMs = 15000,
    backend = "indexeddb",
    backendOptions = {},
    buffer = {},
    topology = "direct",
    saturate = false,
    readerIntervalMs = 100,
    payloadBytes = 96,
    recoverAfterQuota = false,
    evictAtRatio,
    maxPending,
  } = scenario;
  const dbName = backendOptions.dbName || "hp-bench";
  await resetStorage(dbName);
  const before = await estimateStorage();
  log(`▶ ${name}`);

  const all = [];
  let owner = null;
  let readOnce;

  if (topology === "owner") {
    // Single-writer: one owner holds the SQLite connection; writers forward.
    owner = spawn();
    all.push(owner);
    owner.postMessage({ type: "start", config: { role: "owner", backend, backendOptions, buffer } });
    const ready = await waitFor(owner, "ready");
    log(`  owner ready, journal_mode=${ready.journalMode}`);
    let readId = 0;
    const pending = new Map();
    owner.addEventListener("message", (e) => {
      if (e.data.type === "read:ok") {
        pending.get(e.data.id)?.();
        pending.delete(e.data.id);
      }
    });
    readOnce = () =>
      new Promise((resolve) => {
        const id = readId++;
        pending.set(id, resolve);
        owner.postMessage({ type: "read", id, store: "telemetry", limit: 50 });
      });
  } else if (backend === "indexeddb") {
    const reader = await new IndexedDbBackend({ dbName }).open();
    readOnce = () => reader.readLatest("telemetry", 50);
    scenario._closeReader = () => reader.close();
  } else {
    // Direct SQLite: reads use their own connection in a reader worker.
    const reader = spawn();
    all.push(reader);
    reader.postMessage({ type: "start", config: { role: "owner", backend, backendOptions, buffer: false } });
    await waitFor(reader, "ready");
    let readId = 0;
    const pending = new Map();
    reader.addEventListener("message", (e) => {
      if (e.data.type === "read:ok") {
        pending.get(e.data.id)?.();
        pending.delete(e.data.id);
      }
    });
    readOnce = () =>
      new Promise((resolve) => {
        const id = readId++;
        pending.set(id, resolve);
        reader.postMessage({ type: "read", id, store: "telemetry", limit: 50 });
      });
    owner = reader;
  }

  const writers = [];
  for (let i = 0; i < workers; i++) {
    const w = spawn();
    all.push(w);
    writers.push(w);
    if (topology === "owner") {
      const { port1, port2 } = new MessageChannel();
      owner.postMessage({ type: "port", port: port2 }, [port2]);
      w.postMessage({ type: "port", port: port1 }, [port1]);
    }
  }

  const stopFrames = startFrameMonitor();
  const stopReader = startReader(readOnce, readerIntervalMs);
  const t0 = performance.now();
  const results = await Promise.all(
    writers.map((w, i) => {
      const done = waitFor(w, "result");
      w.postMessage({
        type: "start",
        config: {
          role: topology === "owner" ? "forward" : "writer",
          worker: i,
          rateHz,
          durationMs,
          backend,
          backendOptions,
          buffer,
          saturate,
          payloadBytes,
          recoverAfterQuota,
          ...(evictAtRatio ? { evictAtRatio } : {}),
          ...(maxPending ? { maxPending } : {}),
        },
      });
      return done.catch((err) => ({ worker: i, error: err.message }));
    }),
  );
  const wallMs = performance.now() - t0;
  const reader = await stopReader();
  const frames = stopFrames();

  let ownerResult = null;
  if (owner) {
    const done = waitFor(owner, "result");
    owner.postMessage({ type: "stop" });
    ownerResult = await done.catch((err) => ({ error: err.message }));
  }
  if (scenario._closeReader) scenario._closeReader();
  all.forEach((w) => w.terminate());
  const after = await estimateStorage();
  // Eviction exposure: best-effort origins are evicted (whole origin, LRU)
  // under disk pressure; only a granted persist() request exempts them.
  let persistGranted = null;
  if (recoverAfterQuota && navigator.storage?.persist) persistGranted = await navigator.storage.persist().catch(() => null);

  const committed = results.reduce((a, r) => a + (r.committed || 0), 0);
  const usageDelta = after && before ? after.usage - before.usage : null;
  const summary = {
    name,
    config: { workers, rateHz, durationMs, backend, backendOptions, buffer, topology, saturate, payloadBytes, maxPending: maxPending ?? null },
    wallMs: Math.round(wallMs),
    totalCommitted: committed,
    totalErrors: results.reduce((a, r) => a + (r.errors || 0), 0),
    totalUnfinished: results.reduce((a, r) => a + (r.unfinished || 0), 0),
    totalShed: results.reduce((a, r) => a + (r.shed || 0), 0),
    throughputPerSec: Math.round((committed / wallMs) * 1000),
    writers: results,
    owner: ownerResult,
    reader,
    frames,
    storage: {
      before,
      after,
      usageDeltaBytes: usageDelta,
      bytesPerRecord: usageDelta && committed ? Math.round(usageDelta / committed) : null,
      persistGranted,
    },
  };
  log(`  committed=${committed} thrpt=${summary.throughputPerSec}/s readP95=${reader.readLatencyMs.p95}ms`);
  return summary;
};

window.benchReady = true;
