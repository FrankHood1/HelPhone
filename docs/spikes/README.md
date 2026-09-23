# Feasibility Spikes #604–#607

These four time-boxed spikes each produce an ADR (in [`docs/adr/`](../adr/README.md)), a report with the measured evidence, a working prototype under `src/`, unit tests under `test/`, and a reproducible benchmark under `scripts/spikes/`. The prototypes are **not wired into the app UI**; the ADRs list the integration follow-ups.

| Spike | ADR | Report | Prototype | Benchmark | Raw data |
|---|---|---|---|---|---|
| #604 CRDT vs OT memory | [ADR-004](../adr/ADR-004-offgrid-map-sync.md) | [604 report](604-crdt-memory-analysis.md) | `src/services/crdtSync.js` | `scripts/spikes/crdt_memory_profile.js` | [json](results/crdt-memory-profile.json) |
| #605 Noir recursive aggregation | [ADR-005](../adr/ADR-005-zk-proof-aggregation.md) | [605 report](605-zk-circuit-complexity-benchmark.md) | `circuits/responder_credential`, `circuits/recursive_verifier`, `src/utils/zkProver.js` | `scripts/spikes/zk_aggregation_benchmark.js`, `scripts/spikes/zk_verifier_gas.js`, `scripts/spikes/soroban-bn254-cost/` | [proving](results/zk-aggregation.json), [EVM gas](results/zk-verifier-gas.json), [Soroban costs](results/soroban-bn254-cost.json) |
| #606 Offline routing | [ADR-006](../adr/ADR-006-offline-routing.md) | [606 report](606-routing-benchmark-report.md) | `src/utils/graphTraversal.js`, `src/workers/routingWorker.js` | `scripts/spikes/routing_benchmark.js` | [json](results/routing-benchmark.json) |
| #607 Storage lock contention | [ADR-007](../adr/ADR-007-offline-storage.md) | [607 report](607-storage-lock-contention-report.md) | `src/services/storageEngine.js`, `src/workers/telemetryWorker.js` | `scripts/spikes/storage_contention_benchmark.js` | [contention](results/storage-contention.json), [quota](results/storage-quota.json) |

## Measurement environment

All numbers come from one machine, a deliberately modest one: **Intel Core i5-4300U** (2014, 2 cores / 4 threads, 1.9 GHz), 11.6 GB RAM, Linux, Node 22.22, Chromium 147.0.7727.15 (Playwright build 1217). **No phone was measured.** Where a report extrapolates to mobile, it says so and names the assumption.

## Reproducing

```bash
npm ci --legacy-peer-deps           # adds yjs, @sqlite.org/sqlite-wasm, fake-indexeddb (dev only)

npm run spike:routing               # ~15 min (13 of them CH preprocessing; add --skip-ch to skip)
npm run spike:crdt                  # ~2 min
CHROMIUM_PATH=/path/to/chrome npm run spike:storage   # ~12 min, drives Chromium via Playwright
CHROMIUM_PATH=/path/to/chrome npm run spike:storage:quota   # ~3 min, quota exhaustion + eviction
# optional, not yet run: emulate a CPU-starved device
node scripts/spikes/storage_contention_benchmark.js --cpu-stress 4 --only idb/,sqlite-sahpool/owner

# ZK: nargo 1.0.0-beta.9 is required to (re)build circuits; bb.js runs the prover
NARGO=/path/to/nargo npm run spike:zk:build
npm run spike:zk                    # tens of minutes (N=5 single-threaded proving)
# on-chain cost: Soroban primitive costs (Rust), then EVM gas + Soroban estimate
(cd scripts/spikes/soroban-bn254-cost && cargo test --release)
npm i --prefix /tmp/evm-deps solc@0.8.30 @ethereumjs/evm@10 @ethereumjs/common@10 @ethereumjs/util@10
EVM_DEPS_DIR=/tmp/evm-deps/node_modules npm run spike:zk:gas   # ~2 min; the N=1 proof peaks at 2.6 GB
```

Proving jobs are memory-hungry. On a shared machine, run them under a cap, for example `systemd-run --user --scope -p MemoryMax=3200M …`. An uncapped N=5 run pushed this laptop into the kernel OOM killer.

The unit tests (`npm test`) cover the prototype logic without WASM proving or a browser.
