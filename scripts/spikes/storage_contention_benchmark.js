#!/usr/bin/env node
/**
 * Spike #607 — IndexedDB vs OPFS SQLite WASM lock contention (ADR-007).
 *
 * Serves the repo through Vite (with COOP/COEP so SharedArrayBuffer and the
 * `opfs` VFS are available), opens scripts/spikes/storage-bench/ in
 * Playwright Chromium and runs each scenario via `window.runBench()`:
 *
 *   contention  4 workers × 125 Hz = 500 writes/s for DURATION ms, with a
 *               main-thread reader polling the newest 50 rows every 100 ms
 *   saturation  4 workers writing as fast as possible (throughput ceiling)
 *   quota       DevTools-overridden origin quota; one writer logs until
 *               QuotaExceeded, then deletes the oldest 10 % and probes writes;
 *               the evict-80 variants evict at a soft watermark instead
 *
 * Usage:
 *   node scripts/spikes/storage_contention_benchmark.js
 *     [--duration 15000] [--only <substr>[,<substr>...]] [--headed]
 *     [--cpu-stress N]   run N busy-loop processes alongside, to emulate a
 *                        CPU-starved (low-end or thermally throttled) device
 *     [--executable /path/to/chrome]   (or CHROMIUM_PATH env)
 *     [--out docs/spikes/results/storage-contention.json]
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const DURATION = Number(arg("duration", 15000));
const SATURATE_MS = 6000;
const ONLY = arg("only", null)?.split(",") ?? null;
const CPU_STRESS = Number(arg("cpu-stress", 0));
const OUT = arg("out", null);
const log = (...a) => console.log("[storage]", ...a);

const batched = { maxBatch: 128, flushMs: 50 };
const wal = { journalMode: "wal", exclusive: true };

const SCENARIOS = [
  // ── 500 writes/s across 4 workers ──
  { name: "idb/per-write/default", backend: "indexeddb", buffer: false },
  { name: "idb/per-write/strict", backend: "indexeddb", backendOptions: { durability: "strict" }, buffer: false },
  { name: "idb/batched/relaxed", backend: "indexeddb", backendOptions: { durability: "relaxed" }, buffer: batched },
  { name: "idb/batched/strict", backend: "indexeddb", backendOptions: { durability: "strict" }, buffer: batched },
  // Direct multi-connection SQLite collapses (see ADR-007); cap each writer's
  // backlog so a run finishes, and report the shed writes.
  { name: "sqlite-opfs/direct/per-write", backend: "opfs-sqlite", backendOptions: { vfs: "opfs", journalMode: "wal", exclusive: false }, buffer: false, maxPending: 64 },
  { name: "sqlite-opfs-wl/direct/per-write", backend: "opfs-sqlite", backendOptions: { vfs: "opfs-wl", journalMode: "wal", exclusive: false }, buffer: false, maxPending: 64 },
  { name: "sqlite-opfs-wl/direct/batched", backend: "opfs-sqlite", backendOptions: { vfs: "opfs-wl", journalMode: "wal", exclusive: false }, buffer: batched, maxPending: 64 },
  { name: "sqlite-sahpool/owner/batched/wal", backend: "opfs-sqlite", topology: "owner", backendOptions: { vfs: "opfs-sahpool", ...wal }, buffer: batched },
  { name: "sqlite-sahpool/owner/batched/delete", backend: "opfs-sqlite", topology: "owner", backendOptions: { vfs: "opfs-sahpool", journalMode: "delete", exclusive: true }, buffer: batched },
  { name: "sqlite-opfs/owner/batched/wal", backend: "opfs-sqlite", topology: "owner", backendOptions: { vfs: "opfs", ...wal }, buffer: batched },
  // ── throughput ceiling ──
  { name: "saturate/idb/per-write", backend: "indexeddb", buffer: false, saturate: true, durationMs: SATURATE_MS },
  { name: "saturate/idb/batched", backend: "indexeddb", backendOptions: { durability: "relaxed" }, buffer: batched, saturate: true, durationMs: SATURATE_MS },
  { name: "saturate/sqlite-sahpool/owner/wal", backend: "opfs-sqlite", topology: "owner", backendOptions: { vfs: "opfs-sahpool", ...wal }, buffer: batched, saturate: true, durationMs: SATURATE_MS },
  // ── quota exhaustion & recovery (quota forced to 40 MB) ──
  { name: "quota/idb/batched", quotaMB: 40, workers: 1, backend: "indexeddb", buffer: batched, saturate: true, durationMs: 120000, payloadBytes: 2048, recoverAfterQuota: true },
  { name: "quota/sqlite-sahpool/wal", quotaMB: 40, workers: 1, backend: "opfs-sqlite", topology: "owner", backendOptions: { vfs: "opfs-sahpool", ...wal }, buffer: batched, saturate: true, durationMs: 120000, payloadBytes: 2048, recoverAfterQuota: true },
  // Soft watermark: evict the oldest 20 % once usage passes 80 % of quota.
  { name: "quota/idb/batched/evict-80", quotaMB: 40, workers: 1, backend: "indexeddb", buffer: batched, saturate: true, durationMs: 60000, payloadBytes: 2048, recoverAfterQuota: true, evictAtRatio: 0.8 },
  { name: "quota/sqlite-sahpool/wal/evict-80", quotaMB: 40, workers: 1, backend: "opfs-sqlite", topology: "owner", backendOptions: { vfs: "opfs-sahpool", ...wal }, buffer: batched, saturate: true, durationMs: 60000, payloadBytes: 2048, recoverAfterQuota: true, evictAtRatio: 0.8 },
];

async function main() {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "warn",
    server: {
      port: 5199,
      strictPort: false,
      // node_modules may be a symlink (e.g. in a git worktree).
      fs: { allow: [ROOT, realpathSync(resolve(ROOT, "node_modules"))] },
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    optimizeDeps: { noDiscovery: true, include: [], exclude: ["@sqlite.org/sqlite-wasm"] },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
  const executablePath = arg("executable", process.env.CHROMIUM_PATH) || undefined;
  const browser = await chromium.launch({ headless: !arg("headed", false), executablePath });
  const hogs = Array.from({ length: CPU_STRESS }, () =>
    spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
  );
  const results = {
    spike: "#607",
    generatedAt: new Date().toISOString(),
    environment: {
      browser: `chromium ${browser.version()}`,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      platform: `${os.platform()} ${os.release()}`,
    },
    params: { durationMs: DURATION, saturateMs: SATURATE_MS, cpuStressProcesses: CPU_STRESS },
    scenarios: [],
  };

  try {
    for (const base of SCENARIOS) {
      if (ONLY && !ONLY.some((o) => base.name.includes(o))) continue;
      const scenario = { durationMs: DURATION, workers: 4, rateHz: 125, ...base };
      // Fresh context per scenario: clean origin storage and quota.
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("console", (m) => m.type() === "error" && log("  console:", m.text()));
      page.on("pageerror", (e) => log("  pageerror:", e.message));
      await page.goto(`${origin}/scripts/spikes/storage-bench/index.html`);
      await page.waitForFunction(() => window.benchReady === true, null, { timeout: 60000 });
      const env = await page.evaluate(() => ({ crossOriginIsolated, sab: typeof SharedArrayBuffer !== "undefined" }));
      if (scenario.quotaMB) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: scenario.quotaMB * 1024 * 1024 });
      }
      log(`▶ ${scenario.name}`);
      try {
        const r = await page.evaluate((s) => window.runBench(s), scenario);
        r.crossOriginIsolated = env.crossOriginIsolated;
        if (scenario.quotaMB) r.quotaMB = scenario.quotaMB;
        results.scenarios.push(r);
        log(
          `  committed=${r.totalCommitted} shed=${r.totalShed} errors=${r.totalErrors} thrpt=${r.throughputPerSec}/s ` +
            `writeP95=${pick(r, "p95")}ms readP95=${r.reader.readLatencyMs.p95}ms reads=${r.reader.reads} ` +
            `journal=${r.owner?.engine?.journalMode ?? r.writers[0]?.engine?.journalMode ?? "-"}`,
        );
      } catch (err) {
        log(`  FAILED: ${err.message.split("\n")[0]}`);
        results.scenarios.push({ name: scenario.name, error: err.message.split("\n")[0] });
      }
      await context.close();
    }
  } finally {
    hogs.forEach((h) => h.kill());
    await browser.close();
    await server.close();
  }

  if (OUT) {
    mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, OUT), JSON.stringify(results, null, 2) + "\n");
    log(`wrote ${OUT}`);
  }
}

function pick(r, q) {
  const vals = r.writers.map((w) => w.writeLatencyMs?.[q]).filter((v) => v !== undefined);
  return vals.length ? Math.max(...vals) : "-";
}

await main();
