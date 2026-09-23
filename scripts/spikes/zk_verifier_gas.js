#!/usr/bin/env node
/**
 * Spike #605 — on-chain verification cost of UltraHonk proofs (ADR-005).
 *
 * For the inner responder_credential circuit (log n = 12) and the N=1
 * recursive_verifier (log n = 20), this:
 *   1. makes a keccak-flavour UltraHonk proof with bb.js,
 *   2. compiles bb's generated Solidity HonkVerifier with solc,
 *   3. deploys it on an in-process EVM (@ethereumjs/evm, Prague rules) and
 *      measures the gas of verify(proof, publicInputs),
 *   4. counts the verifier's field / curve operations from the EVM trace
 *      (MULMOD, ADDMOD, ecAdd/ecMul/pairing/modexp precompiles, keccak bytes),
 *   5. prices those counts with Soroban's metered BN254 host-function costs
 *      (measured by scripts/spikes/soroban-bn254-cost) to estimate CPU
 *      instructions for a Soroban verifier.
 *
 * The EVM gas schedule is the one every Ethereum testnet uses, so no
 * testnet deployment is needed for the gas figure. Soroban is an estimate:
 * no UltraHonk verifier for the BN254 host functions exists yet.
 *
 * Extra dependencies (kept out of package.json):
 *   npm i --prefix /tmp/evm-deps solc@0.8.30 @ethereumjs/evm@10 @ethereumjs/common@10 @ethereumjs/util@10
 *   EVM_DEPS_DIR=/tmp/evm-deps/node_modules node scripts/spikes/zk_verifier_gas.js \
 *     [--skip-outer] [--soroban-costs docs/spikes/results/soroban-bn254-cost.json] \
 *     [--out docs/spikes/results/zk-verifier-gas.json]
 *
 * The outer (log n = 20) proof needs ~2.6 GB; run it in a memory-capped
 * scope so it cannot push the rest of the machine into the OOM killer:
 *   systemd-run --user --scope -p MemoryMax=3200M node scripts/spikes/zk_verifier_gas.js
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAggregationProver } from "../../src/utils/zkProver.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const log = (...a) => console.error("[gas]", ...a);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const INNER = join(ROOT, "circuits/responder_credential/target/responder_credential.json");
const OUTER_N1 = join(ROOT, "circuits/recursive_verifier/target/recursive_verifier_n1.json");

const req = createRequire(process.env.EVM_DEPS_DIR ? join(resolve(process.env.EVM_DEPS_DIR), "..", "x.js") : import.meta.url);
const load = (m) => {
  try {
    return req(m);
  } catch {
    throw new Error(`Missing ${m}. Install the extra deps (see header) and set EVM_DEPS_DIR.`);
  }
};

// Precompiles an UltraHonk verifier calls.
const PRECOMPILES = { 5: "modexp", 6: "ecAdd", 7: "ecMul", 8: "pairing" };
// Prague calldata pricing incl. the EIP-7623 floor.
function intrinsicGas(data) {
  let zero = 0;
  for (const b of data) if (b === 0) zero++;
  const nonzero = data.length - zero;
  return { standard: 21000 + 4 * zero + 16 * nonzero, floor: 21000 + 10 * (zero + 4 * nonzero) };
}

function compile(source) {
  const solc = load("solc");
  // bb documents `solc --optimize --optimize-runs 1`; via-IR is the fallback.
  let out;
  let errors = [];
  for (const viaIR of [false, true]) {
    const input = {
      language: "Solidity",
      sources: { "HonkVerifier.sol": { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 1 },
        viaIR,
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"] } },
      },
    };
    out = JSON.parse(solc.compile(JSON.stringify(input)));
    errors = (out.errors || []).filter((e) => e.severity === "error");
    if (!errors.length) break;
  }
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contracts = out.contracts["HonkVerifier.sol"];
  // Skip the IVerifier interface / abstract base: take the deployable one.
  const [name, c] = Object.entries(contracts)
    .filter(([, c]) => c.evm.methodIdentifiers?.["verify(bytes,bytes32[])"] && c.evm.bytecode.object.length)
    .sort(([, a], [, b]) => b.evm.bytecode.object.length - a.evm.bytecode.object.length)[0];
  return {
    name,
    solc: solc.version(),
    creation: Buffer.from(c.evm.bytecode.object, "hex"),
    runtimeBytes: c.evm.deployedBytecode.object.length / 2,
    selector: c.evm.methodIdentifiers["verify(bytes,bytes32[])"],
  };
}

const word = (n) => {
  const b = Buffer.alloc(32);
  b.writeBigUInt64BE(BigInt(n), 24);
  return b;
};
const pad32 = (b) => Buffer.concat([b, Buffer.alloc((32 - (b.length % 32)) % 32)]);

/** ABI-encodes verify(bytes proof, bytes32[] publicInputs). */
function encodeVerify(selector, proof, publicInputs) {
  const proofPart = Buffer.concat([word(proof.length), pad32(Buffer.from(proof))]);
  const piPart = Buffer.concat([word(publicInputs.length), ...publicInputs.map((f) => Buffer.from(BigInt(f).toString(16).padStart(64, "0"), "hex"))]);
  return Buffer.concat([Buffer.from(selector, "hex"), word(64), word(64 + proofPart.length), proofPart, piPart]);
}

async function measureOnEvm(compiled, proof, publicInputs) {
  const { createEVM } = load("@ethereumjs/evm");
  const { Common, Mainnet, Hardfork } = load("@ethereumjs/common");
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Prague });
  const evm = await createEVM({ common, allowUnlimitedContractSize: true });
  const deployed = await evm.runCall({ data: compiled.creation, gasLimit: 200_000_000n });
  if (deployed.execResult.exceptionError) throw new Error(`deploy failed: ${deployed.execResult.exceptionError.error}`);
  const to = deployed.createdAddress;

  const ops = { MULMOD: 0, ADDMOD: 0, keccakCalls: 0, keccakBytes: 0, ecAdd: 0, ecMul: 0, pairing: 0, pairingPairs: 0, modexp: 0 };
  const onStep = (s) => {
    const name = s.opcode.name;
    if (name === "MULMOD" || name === "ADDMOD") ops[name]++;
    else if (name === "KECCAK256") {
      ops.keccakCalls++;
      ops.keccakBytes += Number(s.stack[s.stack.length - 2]);
    } else if (name === "STATICCALL" || name === "CALL") {
      const addr = Number(s.stack[s.stack.length - 2]);
      const p = PRECOMPILES[addr];
      if (!p) return;
      ops[p]++;
      if (p === "pairing") ops.pairingPairs += Number(s.stack[s.stack.length - (name === "CALL" ? 5 : 4)]) / 192;
    }
  };
  const data = encodeVerify(compiled.selector, proof, publicInputs);
  evm.events.on("step", onStep);
  const r = await evm.runCall({ to, data, gasLimit: 100_000_000n });
  evm.events.off("step", onStep);
  const ret = r.execResult.returnValue;
  const verified = !r.execResult.exceptionError && ret.length === 32 && ret[31] === 1;
  const execGas = Number(r.execResult.executionGasUsed);
  const { standard, floor } = intrinsicGas(data);
  // Tampered public input must be rejected (guards against a no-op verifier).
  const bad = [...publicInputs];
  bad[0] = "0x" + (BigInt(bad[0]) ^ 1n).toString(16);
  const r2 = await evm.runCall({ to, data: encodeVerify(compiled.selector, proof, bad), gasLimit: 100_000_000n });
  const rejectsTampered = Boolean(r2.execResult.exceptionError) || r2.execResult.returnValue[31] !== 1;
  return {
    verified,
    rejectsTampered,
    calldataBytes: data.length,
    executionGas: execGas,
    txGas: Math.max(standard + execGas, floor),
    runtimeBytecodeBytes: compiled.runtimeBytes,
    exceedsEip170: compiled.runtimeBytes > 24576,
    ops,
  };
}

/** Soroban CPU-instruction estimate from EVM op counts × metered host-fn costs. */
function sorobanEstimate(ops, costs) {
  const c = costs.perOp;
  const parts = {
    frMul: ops.MULMOD * c.fr_mul,
    frAdd: ops.ADDMOD * c.fr_add,
    frInv: ops.modexp * c.fr_inv, // the EVM verifier inverts via modexp
    g1Msm: ops.ecMul * c.g1_msm_per_point, // ecMul+ecAdd chains become one MSM
    pairing: ops.pairing * c.pairing_check_2,
    keccak: ops.keccakCalls * c.keccak_base + ops.keccakBytes * c.keccak_per_byte,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    hostInstructions: Math.round(total),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    txLimit: costs.txInstructionLimit,
    fractionOfTxLimit: +(total / costs.txInstructionLimit).toFixed(2),
    note: "Host-function cost only (lower bound): excludes guest WASM for control flow, calldata parsing and Val conversions.",
  };
}

async function proveKeccak(circuit, witnessInputs, prover, { outer, innerProofs } = {}) {
  const { Noir } = await import("@noir-lang/noir_js");
  const { UltraHonkBackend } = await import("@aztec/bb.js");
  const backend = new UltraHonkBackend(circuit.bytecode, { threads: 4 }, { recursive: false });
  let witness;
  if (outer) {
    const { buildAggregationInputs } = await import("../../src/utils/zkProver.js");
    const { fields, hash } = await prover.innerVk();
    ({ witness } = await new Noir(circuit).execute(buildAggregationInputs({ vkFields: fields, vkHash: hash, innerProofs })));
  } else {
    ({ witness } = await new Noir(circuit).execute(witnessInputs));
  }
  const t0 = performance.now();
  const proof = await backend.generateProof(witness, { keccak: true });
  const provingMs = Math.round(performance.now() - t0);
  const vk = await backend.getVerificationKey({ keccak: true });
  const sol = await backend.getSolidityVerifier(vk);
  await backend.destroy();
  return { proof, sol, provingMs };
}

async function main() {
  const costsPath = resolve(ROOT, arg("soroban-costs", "docs/spikes/results/soroban-bn254-cost.json"));
  const costs = existsSync(costsPath) ? readJson(costsPath) : null;
  const results = { spike: "#605", generatedAt: new Date().toISOString(), hardfork: "prague", circuits: {} };

  const prover = createAggregationProver({ innerCircuit: readJson(INNER), outerCircuit: readJson(OUTER_N1), threads: 4 });
  const cred = { secret: 1000n, level: 3, expiresAt: 2000000000, salt: 0xabcn };
  const incident = { min_level: 2, now_epoch: 1900000000, incident_id: 604605 };
  const innerInputs = {
    responder_secret: cred.secret.toString(),
    cert_level: cred.level,
    expires_at: cred.expiresAt,
    authority_salt: cred.salt.toString(),
    credential_commitment: await prover.credentialCommitment(cred),
    ...incident,
  };

  const run = async (label, logN, made) => {
    const compiled = compile(made.sol);
    const evm = await measureOnEvm(compiled, made.proof.proof, made.proof.publicInputs);
    const row = { logN, proofBytes: made.proof.proof.length, publicInputs: made.proof.publicInputs.length, keccakProvingMs: made.provingMs, solc: compiled.solc, evm };
    if (costs) row.sorobanEstimate = sorobanEstimate(evm.ops, costs);
    results.circuits[label] = row;
    log(label, JSON.stringify(row));
  };

  await run("responder_credential", 12, await proveKeccak(readJson(INNER), innerInputs));

  if (!arg("skip-outer", false)) {
    const innerProof = await prover.proveInner(innerInputs); // poseidon flavour, to be folded
    await run("recursive_verifier_n1", 20, await proveKeccak(readJson(OUTER_N1), null, prover, { outer: true, innerProofs: [innerProof] }));
  }
  await prover.destroy();

  // Per-round cost: UltraHonk verification grows with log n (sumcheck rounds,
  // Gemini folds); extrapolate the aggregated N=5 proof (log n = 22).
  const a = results.circuits.responder_credential;
  const b = results.circuits.recursive_verifier_n1;
  if (a && b) {
    const perRound = (b.evm.txGas - a.evm.txGas) / (b.logN - a.logN);
    results.extrapolation = {
      gasPerLogNRound: Math.round(perRound),
      aggregatedN5TxGasEst: Math.round(b.evm.txGas + perRound * 2),
      fiveInnerProofsTxGas: 5 * a.evm.txGas,
      note: "N=5 aggregate cannot be proven in WASM (4 GiB limit); its verifier differs from N=1 only by 2 more rounds (log n 22).",
    };
  }

  const out = arg("out", null);
  if (out) {
    const p = resolve(ROOT, out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(results, null, 2) + "\n");
    log(`wrote ${out}`);
  }
}

await main();
