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
    let mut generated =
        serde_json::to_string_pretty(&sorted_keys(schema)).expect("schema serialises");
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

/// `value` with every object's keys in sorted order, recursively.
///
/// serde_json's object order is a Cargo feature: with `preserve_order` (which
/// any crate in the same build can switch on through feature unification) maps
/// keep insertion order, without it they sort. The blessed file must not depend
/// on which other crates were built alongside this one, so it is rendered with
/// sorted keys, the order it already uses.
fn sorted_keys(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(key, child)| (key, sorted_keys(child)))
                    .collect(),
            )
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sorted_keys).collect())
        }
        other => other,
    }
}

#[test]
fn schema_rendering_sorts_keys_at_every_depth() {
    let value = serde_json::json!({
        "zeta": [{ "b": 1, "a": 2 }],
        "alpha": { "y": true, "x": null },
    });
    assert_eq!(
        serde_json::to_string(&sorted_keys(value)).unwrap(),
        r#"{"alpha":{"x":null,"y":true},"zeta":[{"a":2,"b":1}]}"#
    );
}
