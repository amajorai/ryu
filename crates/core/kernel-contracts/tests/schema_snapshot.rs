//! Blessed-file guard for the checked-in `plugin.json` JSON Schema.
//!
//! The crate itself stays pure data (no I/O — the runtime charter); tests are
//! allowed I/O, so this integration test is where the schema file lives its
//! lifecycle. `schemas/plugin-manifest.schema.json` is the artifact downstream
//! tooling consumes (the TS SDK's `generate:contracts` codegen reads it), so it
//! must never drift from what `schemars` derives from the Rust types.
//!
//! - Normal run: regenerate in-memory and compare against the checked-in file;
//!   fail with a regen instruction on mismatch.
//! - `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts`: rewrite the
//!   checked-in file (bless), then pass.

use ryu_kernel_contracts::PluginManifest;

const SCHEMA_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schemas/plugin-manifest.schema.json"
);

/// The schema exactly as it must appear on disk (pretty JSON + trailing newline).
fn generated_schema() -> String {
    let schema = serde_json::to_value(schemars::schema_for!(PluginManifest))
        .expect("PluginManifest JsonSchema serialises to a JSON value");
    let mut pretty =
        serde_json::to_string_pretty(&schema).expect("schema value serialises to pretty JSON");
    pretty.push('\n');
    pretty
}

#[test]
fn checked_in_plugin_manifest_schema_is_current() {
    let generated = generated_schema();

    if std::env::var("RYU_REGEN_SCHEMAS").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/schemas"))
            .expect("create schemas/ dir");
        std::fs::write(SCHEMA_PATH, &generated).expect("write blessed schema file");
        return;
    }

    let on_disk = std::fs::read_to_string(SCHEMA_PATH).unwrap_or_else(|e| {
        panic!(
            "cannot read {SCHEMA_PATH}: {e}\n\
             Generate it with: RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts"
        )
    });

    assert_eq!(
        on_disk, generated,
        "schemas/plugin-manifest.schema.json is stale — the Rust manifest types \
         changed. Re-bless with: RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts \
         (then re-run `bun run generate:contracts` in packages/sdk and commit both)"
    );
}
