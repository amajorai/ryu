use crate::server::*;

/// A firewall write must persist desktop-authored `custom_patterns` +
/// `redact_pii`, preserve a pre-existing nested `[firewall.inspector]` table
/// (the shape the gateway itself writes) without tripping toml's
/// `ValueAfterTable`, and treat an empty array as a full clear. Single test
/// so the process-global `GATEWAY_CONFIG` env var is never mutated
/// concurrently by a sibling test.
#[test]
fn firewall_custom_patterns_round_trip_through_config_write() {
    let dir = std::env::temp_dir().join(format!(
        "ryu-gw-cfg-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg_path = dir.join("gateway.toml");

    // Seed an existing config whose [firewall] mixes scalars with a nested
    // table — the case that trips toml if a scalar is appended after a table.
    std::fs::write(
        &cfg_path,
        "[firewall]\nenabled = true\npolicy = \"warn_and_continue\"\n\n[firewall.inspector]\nenabled = false\n",
    )
    .unwrap();
    std::env::set_var("GATEWAY_CONFIG", &cfg_path);

    // Phase 1: add custom patterns + flip redact_pii.
    let patch: GatewayConfigPatch = serde_json::from_value(serde_json::json!({
        "firewall": {
            "enabled": true,
            "policy": "sanitize",
            "redact_pii": false,
            "custom_patterns": [
                { "name": "internal_id", "regex": "ID-\\d+", "kind": "pii" }
            ]
        }
    }))
    .unwrap();
    let res = write_gateway_toml(&patch);
    assert!(res.is_ok(), "phase-1 write failed: {:?}", res.err());

    let parsed: toml::Value = toml::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    let fw = parsed.get("firewall").and_then(|v| v.as_table()).unwrap();
    assert_eq!(fw.get("redact_pii").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(fw.get("policy").and_then(|v| v.as_str()), Some("sanitize"));
    // Pre-existing inspector table survived the merge + re-serialize.
    assert!(fw.get("inspector").and_then(|v| v.as_table()).is_some());
    let pats = fw
        .get("custom_patterns")
        .and_then(|v| v.as_array())
        .unwrap();
    assert_eq!(pats.len(), 1);
    let p0 = pats[0].as_table().unwrap();
    assert_eq!(p0.get("name").and_then(|v| v.as_str()), Some("internal_id"));
    assert_eq!(p0.get("kind").and_then(|v| v.as_str()), Some("pii"));

    // Phase 2: an empty array clears the persisted set (None would keep it,
    // Some([]) replaces — matches the editor's read-modify-write semantics).
    let clear: GatewayConfigPatch = serde_json::from_value(serde_json::json!({
        "firewall": { "enabled": true, "custom_patterns": [] }
    }))
    .unwrap();
    let res2 = write_gateway_toml(&clear);
    assert!(res2.is_ok(), "phase-2 write failed: {:?}", res2.err());
    let parsed2: toml::Value =
        toml::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    let cleared = parsed2
        .get("firewall")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("custom_patterns"))
        .and_then(|v| v.as_array())
        .unwrap();
    assert!(cleared.is_empty(), "empty array should clear the set");

    // Phase 3: client API keys are sealed on disk, opened for editors, and
    // never echoed back to the HTTP caller as `effective_config`.
    crate::server::gateway_seal_test_key();
    let auth: GatewayConfigPatch = serde_json::from_value(serde_json::json!({
        "auth": { "api_keys": [{ "key": "gw_client_secret_123", "name": "laptop" }] }
    }))
    .unwrap();
    let echoed = write_gateway_toml(&auth).expect("auth write");
    let echoed = toml::to_string(&echoed).unwrap();
    assert!(!echoed.contains("gw_client_secret_123"), "echo redacted");
    assert!(echoed.contains("laptop"));
    let on_disk = std::fs::read_to_string(&cfg_path).unwrap();
    assert!(!on_disk.contains("gw_client_secret_123"), "sealed on disk");
    assert!(on_disk.contains("encc:v1:"));
    let transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(&cfg_path).unwrap();
    let opened = gateway_config_document(&transaction).unwrap();
    assert_eq!(
        opened["auth"]["api_keys"][0]["key"].as_str(),
        Some("gw_client_secret_123")
    );
    drop(transaction);
    // A client echoing the redacted placeholder keeps the stored key.
    for placeholder in ["***", "••••••"] {
        let echo: GatewayConfigPatch = serde_json::from_value(serde_json::json!({
            "auth": { "api_keys": [{ "key": placeholder, "name": "laptop" }] }
        }))
        .unwrap();
        write_gateway_toml(&echo).expect("placeholder write");
        let transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(&cfg_path).unwrap();
        assert_eq!(
            gateway_config_document(&transaction).unwrap()["auth"]["api_keys"][0]["key"].as_str(),
            Some("gw_client_secret_123")
        );
    }
    let unknown: GatewayConfigPatch = serde_json::from_value(serde_json::json!({
        "auth": { "api_keys": [{ "key": "***", "name": "never-saved" }] }
    }))
    .unwrap();
    assert!(write_gateway_toml(&unknown).is_err());
    // A later unrelated write keeps the sealed key readable.
    let res3 = write_gateway_toml(&clear);
    assert!(res3.is_ok(), "phase-3 write failed: {:?}", res3.err());
    let transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(&cfg_path).unwrap();
    assert_eq!(
        gateway_config_document(&transaction).unwrap()["auth"]["api_keys"][0]["key"].as_str(),
        Some("gw_client_secret_123")
    );
    drop(transaction);

    std::env::remove_var("GATEWAY_CONFIG");
    let _ = std::fs::remove_dir_all(&dir);
}
