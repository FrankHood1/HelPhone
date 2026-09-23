# Spike #605: Noir Circuit Complexity Analysis & Proving Time vs Memory Matrix

Feeds [ADR-005](../adr/ADR-005-zk-proof-aggregation.md). Raw numbers: [`results/zk-aggregation.json`](results/zk-aggregation.json).

## What was built

| File | Purpose |
|---|---|
| `circuits/responder_credential/src/main.nr` | Inner circuit. A responder proves they hold an authority-issued credential (a Poseidon2 commitment), at or above the required level and not expired, and outputs a per-incident nullifier. 4 Noir tests. |
| `circuits/recursive_verifier/src/main.nr` | Aggregator. Verifies N UltraHonk proofs in-circuit with `std::verify_proof_with_type`, pins the inner VK by a Poseidon2 hash (a public input), forces a shared incident, epoch and minimum level, and rejects duplicate nullifiers. N is a compile-time global. 1 Noir test. |
| `circuits/recursive_verifier/build.sh` | Builds both packages in a staging directory (see the nargo limitation below). Produces `target/recursive_verifier{,_n1,_n2}.json`. |
| `src/utils/zkProver.js` | Host side: proof ↔ field conversion, the VK sponge hash mirroring the circuit, input assembly with the same checks as the circuit (fail before proving), device extrapolation, and a lazily loaded prover with cached-VK verification |
| `scripts/spikes/zk_aggregation_benchmark.js` | This benchmark. Each outer proof runs in a fresh child process, so peak RSS is isolated; WASM memory never shrinks. |
| `test/zk-aggregation.test.js` | 11 unit tests of the host-side logic |

## Circuit complexity

| Circuit | ACIR opcodes | Backend gates | Dyadic size |
|---|---|---|---|
| `responder_credential` | 17 | 3,738 | 2^12 |
| `recursive_verifier`, N=1 | 150 | 664,993 | 2^20 |
| `recursive_verifier`, N=2 | 153 | 1,389,265 | 2^21 |
| `recursive_verifier`, N=5 | 174 | 3,562,082 | 2^22 |

The ACIR opcode count barely moves with N, because each recursive verification is a single black-box call. In the backend, each call expands to **about 710k gates**, roughly 190× the circuit it verifies. The VK hash, the shared-input constraints and the nullifier checks add under 1 %.

## Proving time vs memory

Measured on an i5-4300U (2 cores / 4 threads, 2014), bb.js 0.87.9 WASM, Node 22.

| Proof | Threads | Prove | Peak RSS | Result |
|---|---|---|---|---|
| inner × 5 | 4 | 2.3 s (cold), then 0.61–0.76 s | — | ✔ |
| outer N=1 | 4 | **99.1 s** | **2,597 MB** | ✔ verified |
| outer N=2 | 4 | — | 4,026 MB | ✘ `unreachable` trap: out of memory at the 4 GiB WASM32 limit |
| outer N=5 | 4 | — | — | not completed (stopped); 2^22 is 2× the N=2 circuit, which already ran out of memory |

The benchmark script also covers a single-threaded N=1 run and N=1 under the iOS 1 GiB cap. **These two were not run in this time box.** The keccak/EVM flavour was measured separately by `zk_verifier_gas.js`: N=1 proving took 92.4 s (see On-chain verification cost). The run was stopped after the N=5 job started, and the JSON was transcribed from its log. N=1 already uses 2.6 GB, so it cannot fit under a 1 GiB cap. An earlier run of the same N=1 job measured 93.1 s and 2,625 MB, which is consistent.

### Extrapolation to devices (assumptions, not measurements)

| Device class | WASM ceiling | Realistic tab budget | Aggregate N=1? | Aggregate N=5? |
|---|---|---|---|---|
| High-end desktop | 4 GiB | about 4 GB | yes, but memory-heavy | **no** (above the 4 GiB WASM32 limit) |
| Mid-range Android, 4 GB RAM | 4 GiB | about 1.5 GB | no | no |
| Budget Android, 2–3 GB RAM | 4 GiB | about 0.8 GB | no | no |
| iPhone Safari | **1 GiB** (bb.js caps it) | 1 GiB | no | no |

## Verification latency (target: under 500 ms on the client)

| What | Time |
|---|---|
| Verify one inner proof, VK cached | 39–51 ms |
| **Verify all 5 inner proofs** | **214 ms** |
| Verify the aggregated proof (N=1), VK cached | 39 ms warm, 57 ms first |
| Regenerate the inner VK (what `backend.verifyProof()` does on every call) | 157 ms |
| Regenerate the **outer** VK | **25.8 s** |

The 500 ms target is met **without** aggregation, as long as verifiers ship precomputed VKs. Aggregation would bring 5 verifications (214 ms) down to one (about 40 ms), but only at the proving costs above.

## On-chain verification cost

Raw numbers: [`results/zk-verifier-gas.json`](results/zk-verifier-gas.json) and [`results/soroban-bn254-cost.json`](results/soroban-bn254-cost.json).

### EVM: measured

`scripts/spikes/zk_verifier_gas.js` does four things:

1. Makes keccak-flavour proofs for the inner circuit and for the N=1 aggregator.
2. Compiles bb's generated `HonkVerifier.sol` with solc 0.8.30 (optimizer, runs = 1).
3. Deploys each verifier on an in-process EVM (`@ethereumjs/evm`, Prague rules).
4. Calls `verify(proof, publicInputs)`.

Every Ethereum testnet uses the same gas schedule, so this is the testnet figure. Each verifier also rejects the same proof after one public input is flipped.

| Proof | log n | Proof bytes | Execution gas | **Transaction gas** | Runtime bytecode |
|---|---|---|---|---|---|
| Inner `responder_credential` | 12 | 14,592 | 1,751,852 | **1,908,012** | 21,135 B |
| Aggregate, N=1 | 20 | 14,592 | 1,992,215 | **2,182,403** | 21,136 B |
| Aggregate, N=5 (extrapolated, +2 rounds) | 22 | 14,592 | — | **≈ 2,251,000** | — |
| 5 inner proofs submitted separately | — | 5 × 14,592 | — | **9,540,060** | — |

Both verifiers fit under the EIP-170 24 KB contract limit. bb 0.87 pads proofs to a fixed size, so proof bytes and calldata do not change with the circuit. Only the sumcheck and folding rounds grow, by about **34k gas per doubling** of the circuit.

**Aggregating 5 proofs cuts on-chain verification from about 9.5M to about 2.25M gas (4.2×).** Verifying the N=5 aggregate needs just 2 more rounds than N=1. Its gas is extrapolated because the N=5 proof cannot be produced in WASM (see above).

The trace shows where the gas goes. Per verification, the calls are the same for both proofs:

- 70 `ecMul` and 69 `ecAdd` precompile calls, together about 430k gas.
- One 2-pair pairing check, 113k gas.
- 76 keccak calls over about 17 KB.

The rest is field arithmetic, which is what grows with log n:

| Operation | Inner (log n 12) | Aggregate (log n 20) |
|---|---|---|
| MULMOD | 991 | 1,265 |
| ADDMOD | 860 | 1,120 |
| modexp inversions | 150 | 230 |

### Soroban: estimated from measured primitives

No UltraHonk verifier for Soroban's BN254 host functions exists in this repository. The `noir_verifier` contract referenced in `CLAUDE.md` is not checked in. Instead, `scripts/spikes/soroban-bn254-cost` measures the metered CPU-instruction cost of each primitive with the soroban-sdk 27 test budget:

| Primitive | Instructions |
|---|---|
| `fr_mul` | 7,686 |
| `fr_add` | 7,428 |
| `fr_inv` | 39,017 |
| `g1_mul` | 1,160,037 |
| `g1_msm`, per point (64-point MSM) | 334,999 |
| `pairing_check`, 2 pairs | 14,833,973 |
| keccak256 | 5,883 + 46.9 per byte |

Pricing the EVM trace's operation counts with these costs gives these **host-function costs**:

| Proof | Soroban host instructions | Share of the 100M per-transaction limit |
|---|---|---|
| Inner (log n 12) | 59.4M | 59 % |
| Aggregate, N=1 (log n 20) | 66.6M | 67 % |

The two biggest parts are the commitment MSM (23.4M, with 70 points priced as one MSM) and the pairing (14.8M).

**This is a lower bound.** Guest WASM for control flow, proof parsing and value conversions comes on top, and it could plausibly add tens of millions of instructions. A verifier that folds the field arithmetic into guest code instead of host calls will cost differently. So a single aggregated proof *may* fit in one Soroban transaction, and five separate proofs certainly need five. Confirm by porting a verifier to the SDK 27 BN254 API and reading `env.cost_estimate()`.

Reproduce:

```bash
(cd scripts/spikes/soroban-bn254-cost && cargo test --release)   # writes the Soroban cost JSON
npm i --prefix /tmp/evm-deps solc@0.8.30 @ethereumjs/evm@10 @ethereumjs/common@10 @ethereumjs/util@10
EVM_DEPS_DIR=/tmp/evm-deps/node_modules systemd-run --user --scope -p MemoryMax=3200M \
  node scripts/spikes/zk_verifier_gas.js --out docs/spikes/results/zk-verifier-gas.json
```

The memory cap matters on a shared machine. The N=1 proof peaks at 2.6 GB, and an uncapped run pushed this laptop into the kernel OOM killer.

## Toolchain findings

1. **bb.js 0.87 `generateRecursiveProofArtifacts()` returns misaligned VK fields.** It passes a plain `Uint8Array` to `acirVkAsFieldsUltraHonk`, and serialization adds a second length prefix. Field 0 comes out as `0x6e4 << 32` (0x6e4 is the 1,764-byte VK length) instead of the circuit size, and every in-circuit verification then fails deep in WASM (`Builder failure when we have real witnesses`, then `null function or function signature mismatch`). The same thing happens with 0.87.0. Workaround: `api.acirVkAsFieldsUltraHonk(new RawBuffer(vk))`, which is what bb.js's own `generateProof()` does.
2. **Proof layout.** The proof is 456 fields: 16 pairing-point fields plus 440 core fields, with public inputs held separately. The VK is 112 fields and records 5 + 16 = 21 public inputs.
3. `Poseidon2::hash` is private in Noir 1.0.0-beta.9's stdlib, so the circuit uses an explicit width-4, rate-3 sponge.
4. nargo 1.0.0-beta.9 resolves the outermost `Nargo.toml`, so packages under `circuits/` (the `aegis` package) fail with ``Selected package `aegis` was not found``. `build.sh` works around it.
5. The comments in Noir sources must be ASCII.
