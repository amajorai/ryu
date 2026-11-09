//! Fine-tune capability dispatch through the learning host.

use super::*;

use serde_json::json;

use crate::plugin_manifest::{PluginManifestLoader, FINETUNE_PLUGIN_ID};
use crate::plugins::PluginStore;
use crate::sidecar::SidecarManager;

/// A consumer over the REAL compiled fine-tuning manifest, so the test proves the
/// manifest's `provides` rows bind the capabilities Core calls.
async fn finetune_consumer(enabled: bool) -> CapabilityConsumer {
    let manifest = PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|manifest| manifest.id == FINETUNE_PLUGIN_ID)
        .expect("the fine-tuning manifest is compiled into Core");
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(FINETUNE_PLUGIN_ID, "1.0.0").await.unwrap();
    if enabled {
        store.set_enabled(FINETUNE_PLUGIN_ID, &[]).await.unwrap();
    }
    CapabilityConsumer::new(
        SidecarManager::new_noop(),
        Arc::new(tokio::sync::RwLock::new(vec![manifest])),
        store,
    )
}

#[tokio::test]
async fn finetune_dispatch_refuses_cleanly_when_the_app_is_disabled() {
    let capabilities = finetune_consumer(false).await;
    for capability in [CAP_FINETUNE_START, CAP_FINETUNE_MERGE] {
        let error = call_finetune_capability(&capabilities, capability, &json!({}))
            .await
            .unwrap_err();
        assert!(
            error.contains(&format!(
                "no enabled app provides the '{capability}' capability"
            )),
            "{error}"
        );
    }
}

#[tokio::test]
async fn finetune_capabilities_bind_to_the_app_sidecar_when_enabled() {
    // Enabled + bound, but the sidecar is not registered with the (noop) manager:
    // the refusal is "unavailable", proving resolution got past binding and the
    // `provides` route onto the provider's sidecar without dialing anything.
    let capabilities = finetune_consumer(true).await;
    for capability in [CAP_FINETUNE_START, CAP_FINETUNE_MERGE] {
        let error = call_finetune_capability(&capabilities, capability, &json!({}))
            .await
            .unwrap_err();
        assert!(
            error.contains(&format!(
                "capability '{capability}' provider is unavailable"
            )),
            "{error}"
        );
    }
}

#[test]
fn finetune_reply_returns_the_body_on_success() {
    let reply = CapabilityReply {
        status: 200,
        body: json!({ "job_id": "job-1" }),
    };
    assert_eq!(
        finetune_reply(CAP_FINETUNE_START, reply),
        Ok(json!({ "job_id": "job-1" }))
    );
}

#[test]
fn finetune_reply_prefers_the_provider_error_text() {
    let reply = CapabilityReply {
        status: 409,
        body: json!({ "error": "no CUDA device on this node" }),
    };
    assert_eq!(
        finetune_reply(CAP_FINETUNE_START, reply),
        Err("no CUDA device on this node".to_owned())
    );
    let reply = CapabilityReply {
        status: 502,
        body: Value::Null,
    };
    assert_eq!(
        finetune_reply(CAP_FINETUNE_MERGE, reply),
        Err("'finetune.merge' returned HTTP 502".to_owned())
    );
}
