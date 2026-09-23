//! Measures Soroban's metered CPU-instruction cost (the resource a
//! transaction is limited on) for BN254 host functions, via the SDK's
//! test budget. Output feeds scripts/spikes/zk_verifier_gas.js.
#![cfg(test)]
use soroban_sdk::{
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    Bytes, BytesN, Env, U256, Vec,
};

/// Published per-transaction CPU instruction limit (network-configurable).
const TX_INSTRUCTION_LIMIT: u64 = 100_000_000;

fn g1(env: &Env) -> Bn254G1Affine {
    let mut b = [0u8; 64];
    b[31] = 1; // generator (1, 2)
    b[63] = 2;
    Bn254G1Affine::from_bytes(BytesN::from_array(env, &b))
}

fn g2(env: &Env) -> Bn254G2Affine {
    // G2 generator: be(X.c1) || be(X.c0) || be(Y.c1) || be(Y.c0)
    const H: &str = "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa";
    let mut b = [0u8; 128];
    for (i, byte) in b.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&H[2 * i..2 * i + 2], 16).unwrap();
    }
    Bn254G2Affine::from_bytes(BytesN::from_array(env, &b))
}

fn fr(env: &Env, v: u128) -> Bn254Fr {
    Bn254Fr::from_u256(U256::from_u128(env, v))
}

/// Average metered instructions of `f` over `reps` calls on a fresh Env.
fn cost<F: FnMut(&Env)>(reps: u64, mut f: F) -> u64 {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let before = env.cost_estimate().budget().cpu_instruction_cost();
    for _ in 0..reps {
        f(&env);
    }
    (env.cost_estimate().budget().cpu_instruction_cost() - before) / reps
}

fn msm(n: u32) -> u64 {
    cost(3, |e| {
        let (mut ps, mut ss) = (Vec::new(e), Vec::new(e));
        for i in 0..n {
            ps.push_back(g1(e));
            ss.push_back(fr(e, u128::MAX - i as u128));
        }
        let _ = e.crypto().bn254().g1_msm(ps, ss);
    })
}

fn keccak(n: usize) -> u64 {
    cost(5, |e| {
        let _ = e.crypto().keccak256(&Bytes::from_slice(e, &vec![7u8; n]));
    })
}

#[test]
fn bn254_costs() {
    // Operand construction is paid once per value in a real verifier, so it
    // is measured separately and subtracted from the arithmetic ops.
    let construct2 = cost(200, |e| {
        let _ = fr(e, 7);
        let _ = fr(e, 11);
    });
    let fr_mul = cost(200, |e| {
        let _ = e.crypto().bn254().fr_mul(&fr(e, 7), &fr(e, 11));
    }) - construct2;
    let fr_add = cost(200, |e| {
        let _ = e.crypto().bn254().fr_add(&fr(e, 7), &fr(e, 11));
    }) - construct2;
    let fr_inv = cost(50, |e| {
        let _ = e.crypto().bn254().fr_inv(&fr(e, 7));
    }) - construct2 / 2;
    let g1_add = cost(50, |e| {
        let p = g1(e);
        let _ = e.crypto().bn254().g1_add(&p, &p);
    });
    let g1_mul = cost(20, |e| {
        let _ = e.crypto().bn254().g1_mul(&g1(e), &fr(e, u128::MAX - 12345));
    });
    let (msm1, msm64) = (msm(1), msm(64));
    let pairing_check_2 = cost(3, |e| {
        let (mut a, mut b) = (Vec::new(e), Vec::new(e));
        for _ in 0..2 {
            a.push_back(g1(e));
            b.push_back(g2(e));
        }
        let _ = e.crypto().bn254().pairing_check(a, b);
    });
    let (k1k, k16k) = (keccak(1024), keccak(16384));
    let keccak_per_byte = (k16k - k1k) as f64 / (16384.0 - 1024.0);
    let keccak_base = k1k as f64 - 1024.0 * keccak_per_byte;

    let json = format!(
        r##"{{
  "spike": "#605",
  "sdk": "soroban-sdk 27.0.6 (testutils budget)",
  "unit": "metered CPU instructions",
  "txInstructionLimit": {TX_INSTRUCTION_LIMIT},
  "perOp": {{
    "fr_mul": {fr_mul},
    "fr_add": {fr_add},
    "fr_inv": {fr_inv},
    "g1_add": {g1_add},
    "g1_mul": {g1_mul},
    "g1_msm_1": {msm1},
    "g1_msm_64": {msm64},
    "g1_msm_per_point": {per_point},
    "pairing_check_2": {pairing_check_2},
    "keccak_base": {keccak_base:.0},
    "keccak_per_byte": {keccak_per_byte:.2}
  }}
}}
"##,
        per_point = (msm64 - msm1) / 63,
    );
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../docs/spikes/results/soroban-bn254-cost.json");
    std::fs::write(out, &json).unwrap();
    println!("{json}");
}
