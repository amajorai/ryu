//! Blessed-file guard for the checked-in host-API contract JSON.
//!
//! Mirrors `schema_snapshot.rs`: the crate stays pure data (no I/O — the runtime
//! charter); this integration test is where `schemas/host-api.json` lives its
//! lifecycle. That file is the artifact the TS app host imports
//! (`packages/app-host/src/rpc.ts` derives `METHOD_CAPABILITY` / `GRANT_CAPABILITY`
//! / `STREAMING_METHODS` from it), so it must never drift from the Rust table.
//!
//! - Normal run: regenerate in-memory and compare against the checked-in file;
//!   fail with a regen instruction on mismatch.
//! - `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts`: rewrite the
//!   checked-in file (bless), then pass. The SAME env var re-blesses the manifest
//!   schema, so one command regenerates both.

mod support;

use ryu_kernel_contracts::host_api::{HOST_API_METHODS, HOST_API_VERSION};

const CONTRACT_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/schemas/host-api.json");

/// The contract exactly as it must appear on disk (sorted keys, pretty JSON +
/// trailing newline; see `support`).
fn generated_contract() -> String {
    support::blessed_json(serde_json::json!({
        "version": HOST_API_VERSION,
        "methods": HOST_API_METHODS,
    }))
}

/// The rendering is the same whichever serde_json map order the build unified
/// (`preserve_order` keeps insertion order; the blessed files sort).
#[test]
fn blessed_rendering_sorts_keys_at_every_depth() {
    let value = serde_json::json!({
        "zeta": [{ "b": 1, "a": 2 }],
        "alpha": { "y": true, "x": null },
    });
    assert_eq!(
        support::blessed_json(value),
        "{\n  \"alpha\": {\n    \"x\": null,\n    \"y\": true\n  },\n  \"zeta\": [\n    {\n      \"a\": 2,\n      \"b\": 1\n    }\n  ]\n}\n"
    );
}

#[test]
fn checked_in_host_api_contract_is_current() {
    let generated = generated_contract();

    if std::env::var("RYU_REGEN_SCHEMAS").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/schemas"))
            .expect("create schemas/ dir");
        std::fs::write(CONTRACT_PATH, &generated).expect("write blessed contract file");
        return;
    }

    let on_disk = std::fs::read_to_string(CONTRACT_PATH).unwrap_or_else(|e| {
        panic!(
            "cannot read {CONTRACT_PATH}: {e}\n\
             Generate it with: RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts"
        )
    });

    assert_eq!(
        on_disk, generated,
        "schemas/host-api.json is stale — the Rust HOST_API_METHODS table changed. \
         Re-bless with: RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts \
         (then re-run `bun test` in packages/app-host + packages/sdk and commit the JSON)"
    );
}
