//! Core-side thin shim over the extracted [`ryu_webhook_ingress`] crate.
//!
//! The webhook-ingress *engine* now lives in `crates/ryu-webhook-ingress`
//! (backends, path-routed dispatcher, fail-closed re-verification, dedup, replay
//! window); the kernel couplings are inverted through
//! [`ryu_webhook_ingress::WebhookIngressHost`], implemented in
//! [`crate::webhook_ingress_host`] and installed at boot in `main.rs`.
//!
//! This module (a) re-exports the crate's surface so every existing
//! `crate::webhook_ingress::*` call site keeps compiling, and (b) supplies the two
//! `PreferencesStore`-aware wrappers ([`configured_kind`] / [`from_prefs`]) — the
//! crate is deliberately `PreferencesStore`-free (a primitive must not know Core's
//! store), so Core reads the two prefs here and forwards the values. No ingress
//! business logic lives in Core; the public webhook *routes* stay in
//! `server/mod.rs` (kernel-ingress, program §5) and forward into the crate engine.

pub use ryu_webhook_ingress::*;

use crate::server::preferences::PreferencesStore;

/// The configured backend kind, reading the `webhook.ingress.backend` pref from
/// Core's store then delegating to [`ryu_webhook_ingress::configured_kind`].
pub async fn configured_kind(prefs: &PreferencesStore) -> IngressKind {
    let backend = prefs.get(INGRESS_BACKEND_PREF).await.ok().flatten();
    ryu_webhook_ingress::configured_kind(backend.as_deref())
}

/// Build the configured [`Ingress`], reading the `webhook.ingress.backend` and
/// `webhook.ingress.url` prefs from Core's store then delegating to
/// [`ryu_webhook_ingress::from_prefs`].
pub async fn from_prefs(prefs: &PreferencesStore, server_url: &str) -> Ingress {
    let backend = prefs.get(INGRESS_BACKEND_PREF).await.ok().flatten();
    let url = prefs.get(INGRESS_URL_PREF).await.ok().flatten();
    ryu_webhook_ingress::from_prefs(backend.as_deref(), url.as_deref(), server_url)
}

/// Ensure the ingress subscription is live after a workflow with a `Webhook`
/// trigger is saved, so its per-workflow URL becomes reachable without a Core
/// restart. Scoped to the managed **RyuRelay** backend: only the relay needs a
/// per-node register (to mint the token `relay_inbound_url` composes); the tunnel
/// backends (Cloudflared / Tailscale / OwnRelay) forward every path to Core and
/// already started at boot, so a workflow webhook is reachable through them with
/// no re-registration. Best-effort: a failure just leaves the URL unresolved
/// (the caller can retry on the next save) and never affects the save itself.
pub async fn ensure_relay_started_after_save() {
    let prefs = match PreferencesStore::open_default() {
        Ok(p) => p,
        Err(e) => {
            tracing::debug!("webhook-ingress: prefs unavailable for relay ensure-start ({e})");
            return;
        }
    };
    if configured_kind(&prefs).await != IngressKind::RyuRelay {
        return;
    }
    if let Err(e) = ryu_webhook_ingress::ensure_relay_started().await {
        tracing::info!("webhook-ingress: relay ensure-start after save not active ({e})");
    }
}

#[cfg(test)]
mod tests {
    //! The real-wiring canary for the extraction: exercises the crate's unified
    //! path router against the **real** [`crate::webhook_ingress_host::CoreWebhookIngressHost`]
    //! (real `save_workflow` + `run_workflow_for_trigger`), which can only run in
    //! Core. It is the automated proof that `main.rs` installs a working host — a
    //! missing install would surface here as a `NotFound`/`Rejected` rather than a
    //! `Delivered`. The crate's mock-host variant covers the router branches
    //! in-crate; this covers the kernel wiring.

    use std::sync::Arc;

    use crate::workflow::{Workflow, WorkflowTrigger};

    /// Sign with the same HMAC-SHA256 hex the verifier uses, so a test signature
    /// round-trips against `verify_workflow_webhook_signature`.
    fn sign(secret: &str, body: &[u8]) -> String {
        crate::composio_triggers::hmac_sha256_hex(secret.as_bytes(), body)
    }

    #[tokio::test]
    async fn workflow_webhook_reaches_run_through_unified_ingress() {
        // Install the real host (idempotent; matches main.rs wiring).
        ryu_webhook_ingress::set_global_host(Arc::new(
            crate::webhook_ingress_host::CoreWebhookIngressHost,
        ));

        let secret = "wh-secret-unify";
        let id = format!("wf-unify-{}", uuid::Uuid::new_v4().simple());
        let workflow = Workflow {
            id: id.clone(),
            name: "webhook-unify test".to_owned(),
            description: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            triggers: vec![WorkflowTrigger::Webhook {
                secret: Some(secret.to_owned()),
            }],
            created_at: None,
            updated_at: None,
        };
        crate::workflow::store::save_workflow(&workflow).expect("save workflow");

        let body = br#"{"event":"unify","value":42}"#;
        let sig = sign(secret, body);
        let path = ryu_webhook_ingress::workflow_webhook_path(&id);

        // Deliver through the SAME path router the relay dispatches to, against the
        // real Core host.
        let outcome = ryu_webhook_ingress::deliver_inbound(&path, body, Some(&sig)).await;
        match &outcome {
            ryu_webhook_ingress::InboundOutcome::Delivered { detail } => {
                assert!(
                    detail.contains(&id) && detail.contains("run"),
                    "expected a workflow run delivery, got: {detail}"
                );
            }
            other => panic!("expected Delivered (reaching the workflow run), got {other:?}"),
        }
        assert!(
            ryu_webhook_ingress::last_delivery(&path).is_some(),
            "delivery should be recorded for the registry"
        );

        // A tampered body (signature no longer matches) is rejected fail-closed.
        let rejected =
            ryu_webhook_ingress::deliver_inbound(&path, br#"{"event":"tampered"}"#, Some(&sig))
                .await;
        assert!(matches!(
            rejected,
            ryu_webhook_ingress::InboundOutcome::Rejected(_)
        ));
    }
}
