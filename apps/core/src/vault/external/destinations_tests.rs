//! Which values a destination push sends.

use super::*;
use crate::plugin_secrets::kv::ValueType;

fn destination() -> DestinationRecord {
    DestinationRecord {
        id: "dest-1".into(),
        store_id: "store-1".into(),
        environment: "default".into(),
        path: "/out".into(),
        remote_path: "mirror/out".into(),
        scope_id: "node-1".into(),
        interval_secs: 300,
        dirty: true,
        last_push_at: None,
        last_status: None,
        last_error: None,
        last_count: 0,
        failures: 0,
        created_at: 0,
    }
}

async fn write(store: &PluginSecretStore, name: &str, value: &str, value_type: ValueType) {
    store
        .write_secret(WriteRequest {
            coords: SecretCoords {
                scope: SecretScope::Node,
                scope_id: "node-1".into(),
                environment: "default".into(),
                path: "/out".into(),
                binding: None,
                name: name.into(),
            },
            value: Some(value),
            patch: SecretMetadataPatch {
                value_type: Some(value_type),
                ..Default::default()
            },
            actor: &AuditActor::new("operator", None),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_push_never_sends_a_sealed_value() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, "PLAIN", "plain-value", ValueType::Secret).await;
    write(&store, "LEVEL", "debug", ValueType::Config).await;
    write(&store, "SEALED", "sealed-plaintext", ValueType::Sealed).await;
    let values = store.push_values(&destination()).await.unwrap();
    let names: Vec<&str> = values.keys().map(String::as_str).collect();
    assert_eq!(names, ["LEVEL", "PLAIN"]);
    assert!(values.values().all(|value| value != "sealed-plaintext"));
}
