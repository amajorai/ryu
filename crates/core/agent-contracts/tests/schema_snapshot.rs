//! Blessed-schema guard for the public agent-harness contract.
//!
//! The Rust types are canonical. The checked-in schema is a generated projection
//! consumed by TypeScript codegen and documentation tooling.

use ryu_agent_contracts::{HarnessRun, HarnessSession, RunEventEnvelope, StartRunRequest};

const SCHEMA_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schemas/agent-harness.schema.json"
);

#[test]
fn checked_in_harness_schema_is_current() {
    let schema = serde_json::json!({
        "title": "RyuAgentHarness",
        "type": "object",
        "properties": {
            "session": schemars::schema_for!(HarnessSession),
            "run": schemars::schema_for!(HarnessRun),
            "startRequest": schemars::schema_for!(StartRunRequest),
            "event": schemars::schema_for!(RunEventEnvelope),
        },
        "required": ["session", "run", "startRequest", "event"],
    });
    let mut generated = serde_json::to_string_pretty(&schema).expect("schema serialises");
    generated.push('\n');

    if std::env::var("RYU_REGEN_SCHEMAS").is_ok_and(|value| value == "1") {
        std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/schemas"))
            .expect("create schema dir");
        std::fs::write(SCHEMA_PATH, generated).expect("write schema");
        return;
    }
    let on_disk = std::fs::read_to_string(SCHEMA_PATH).unwrap_or_else(|error| {
        panic!(
            "cannot read {SCHEMA_PATH}: {error}; generate with RYU_REGEN_SCHEMAS=1 cargo test -p ryu-agent-contracts"
        )
    });
    assert_eq!(on_disk, generated, "agent harness schema is stale");
}
