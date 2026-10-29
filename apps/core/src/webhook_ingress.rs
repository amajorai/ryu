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
    match ryu_webhook_ingress::from_prefs(backend.as_deref(), url.as_deref(), server_url) {
        Ingress::Cloudflared(source) => {
            let source =
                source.with_env_scrubber(crate::sidecar::cloudflared::scrub_cloudflared_env);
            match crate::sidecar::cloudflared::resolve_binary() {
                Ok(binary) => Ingress::Cloudflared(source.with_binary(binary)),
                Err(_) => Ingress::Cloudflared(source),
            }
        }
        ingress => ingress,
    }
}

/// The effective **own-relay** public base, mirroring `OwnRelaySource::new`'s
/// precedence exactly: the `RYU_WEBHOOK_INGRESS_URL` env override first, then the
/// `webhook.ingress.url` pref. Both inputs are trimmed and an empty string counts
/// as absent, because `OwnRelaySource::new` filters empties out of the env value
/// and `OwnRelaySource::{start,public_url}` treat a whitespace-only `base_url` as
/// unset. `None` means own-relay has nothing to publish.
///
/// Pure — the env value is an argument rather than a read, so this is testable
/// without touching a process-global that the crate's own tests already contend
/// for (`crates/core/webhook-ingress/src/lib.rs` serializes on it by hand).
pub fn resolve_own_relay_base(env_url: Option<&str>, url_pref: Option<&str>) -> Option<String> {
    [env_url, url_pref]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Why selecting the `own-relay` backend would not produce a reachable webhook
/// URL, or `None` when it will. The string is the 400 body, so it names the two
/// places the operator can fix it.
///
/// ## Why this is checked at *selection* time
///
/// `OwnRelaySource` only errors when something asks it for a URL — at Core start
/// (`start()`) or when a sender needs the address (`public_url()`). Until then the
/// selection is persisted and reported back as the live backend, so the picker
/// reads as configured while nothing can actually deliver a webhook. Refusing the
/// selection is what turns that into an answer the operator sees at the moment
/// they can act on it.
///
/// ## The scheme check
///
/// `join_webhook` (`crates/core/webhook-ingress/src/tunnels.rs`) is
/// `format!("{}{}", base.trim_end_matches('/'), WEBHOOK_PATH)`. The only thing it
/// normalises is a trailing slash — it neither validates the base nor prefixes a
/// scheme onto it. So a base of `example.com` yields
/// `example.com/api/composio/webhook`, which is not an absolute URL and which no
/// sender can POST to. `http`/`https` are the only schemes that can be: the value
/// is handed to remote webhook producers, not dialled by Core.
///
/// The trailing-slash trim is orthogonal to this check and neither weakens nor
/// substitutes for it: `https://x.com/` and `https://x.com` both pass the scheme
/// gate and both join to the same absolute URL.
///
/// Deliberately NOT applied retroactively: nothing re-validates an
/// already-persisted `webhook.ingress.url`, and nothing re-checks a backend
/// selected before this existed. This gate runs on the POST that *sets* the
/// backend and nowhere else, so an operator with a running configuration is never
/// broken by it.
pub fn own_relay_rejection(base: Option<&str>) -> Option<String> {
    let Some(base) = base else {
        return Some(format!(
            "own-relay ingress needs a public base URL: set the `{INGRESS_URL_PREF}` \
             preference (or the {OWN_RELAY_URL_ENV} environment variable) to the \
             address this node is publicly reachable at, then select this backend again."
        ));
    };
    let lower = base.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Some(format!(
            "own-relay public base URL '{base}' has no http:// or https:// scheme, so the \
             webhook address derived from it is not one a sender can POST to. Set \
             `{INGRESS_URL_PREF}` (or {OWN_RELAY_URL_ENV}) to a full absolute URL."
        ));
    }
    None
}

/// The [`IngressKind`] the environment **pins**, if any — the kind
/// [`ryu_webhook_ingress::configured_kind`] will return no matter what the
/// `webhook.ingress.backend` pref says.
///
/// There is exactly one such pin today and this mirrors it rather than restating
/// it: `configured_kind` returns [`IngressKind::OwnRelay`] whenever
/// `RYU_WEBHOOK_INGRESS_URL` holds a non-empty value, *before* it looks at the
/// pref (`crates/core/webhook-ingress/src/lib.rs:169-176` — read, not assumed).
///
/// Without this, picking Cloudflared on a node with that variable set persisted a
/// pref, answered `ok: true`, and then kept reporting `own-relay` forever: a
/// settable value that cannot take effect. The setter refuses instead.
///
/// Pure for the same reason [`resolve_own_relay_base`] is; the caller supplies the
/// env value.
pub fn env_pinned_kind(env_url: Option<&str>) -> Option<IngressKind> {
    let pinned = env_url.map(str::trim).is_some_and(|v| !v.is_empty());
    pinned.then_some(IngressKind::OwnRelay)
}

/// Read [`OWN_RELAY_URL_ENV`] the way `OwnRelaySource::new` does: trimmed, with an
/// empty value treated as unset. The single env read behind the two pure helpers
/// above, so the handler does not scatter `std::env::var` calls.
pub fn own_relay_url_env() -> Option<String> {
    std::env::var(OWN_RELAY_URL_ENV)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod selection_gate_tests {
    //! The `POST /api/webhook-ingress/backend` gates, exercised as pure functions.
    //!
    //! Kept out of the module's other test mod on purpose: that one is the
    //! real-wiring canary for the crate extraction and its doc comment says so.
    //! All but one take the env value as an argument rather than setting
    //! `RYU_WEBHOOK_INGRESS_URL`, which is process-global. Nothing else in
    //! `apps/core` reads that variable today (grepped: only these helpers and the
    //! handler's message text), so the one test that must set it is not racing
    //! anything at present — [`ENV_LOCK`] is there so that stays true if a second
    //! writer appears, not because one exists.

    use super::{env_pinned_kind, own_relay_rejection, resolve_own_relay_base, IngressKind};

    #[test]
    fn own_relay_base_prefers_the_env_override_and_treats_blank_as_absent() {
        // Precedence mirrors `OwnRelaySource::new`: env first, pref second.
        assert_eq!(
            resolve_own_relay_base(Some("https://env.example"), Some("https://pref.example")),
            Some("https://env.example".to_owned())
        );
        assert_eq!(
            resolve_own_relay_base(None, Some("https://pref.example")),
            Some("https://pref.example".to_owned())
        );
        // Whitespace-only is absent at BOTH positions, not just the env one:
        // `OwnRelaySource::{start,public_url}` trim before the emptiness check, so
        // a pref of "  " is a base that errors at start — exactly what this gate
        // is here to refuse up front.
        assert_eq!(resolve_own_relay_base(Some("   "), Some("  ")), None);
        assert_eq!(
            resolve_own_relay_base(Some("  "), Some(" https://pref.example ")),
            Some("https://pref.example".to_owned()),
            "a blank env value falls through to the pref, and the result is trimmed"
        );
        assert_eq!(resolve_own_relay_base(None, None), None);
    }

    #[test]
    fn own_relay_is_refused_without_a_usable_absolute_url() {
        // No base at all: the case that used to answer `ok: true`.
        let why = own_relay_rejection(None).expect("no base must be refused");
        assert!(why.contains(super::INGRESS_URL_PREF), "{why}");
        assert!(why.contains(super::OWN_RELAY_URL_ENV), "{why}");

        // Schemeless: `join_webhook` would emit `example.com/api/composio/webhook`.
        let why = own_relay_rejection(Some("example.com")).expect("schemeless must be refused");
        assert!(why.contains("example.com"), "{why}");
        assert!(why.contains("scheme"), "{why}");

        // A scheme Core cannot hand to a remote sender.
        assert!(own_relay_rejection(Some("ftp://relay.example")).is_some());

        // Accepted, including an uppercase scheme (URL schemes are
        // case-insensitive, so rejecting HTTPS:// would be a false refusal).
        assert!(own_relay_rejection(Some("https://relay.example")).is_none());
        assert!(own_relay_rejection(Some("http://relay.example:8443")).is_none());
        assert!(own_relay_rejection(Some("HTTPS://relay.example")).is_none());
    }

    #[test]
    fn the_env_url_pins_own_relay_and_nothing_else_pins_anything() {
        assert_eq!(
            env_pinned_kind(Some("https://relay.example")),
            Some(IngressKind::OwnRelay)
        );
        assert_eq!(env_pinned_kind(None), None);
        assert_eq!(
            env_pinned_kind(Some("   ")),
            None,
            "a blank value is not a pin — `configured_kind` filters empties out too"
        );
    }

    #[test]
    fn the_pin_agrees_with_the_resolver_it_mirrors() {
        // The claim `env_pinned_kind` encodes is about a function in another
        // crate. Assert it against that function rather than restating it, so a
        // change to `configured_kind`'s precedence fails here instead of leaving
        // the gate quietly describing behavior that no longer exists.
        //
        // Driven through the real resolver with the pref set to a DIFFERENT kind,
        // which is the whole scenario: `cloudflared` is asked for, `own-relay` is
        // what the node will use.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = std::env::var(super::OWN_RELAY_URL_ENV).ok();
        // SAFETY-adjacent: serialized by ENV_LOCK; restored below on every path
        // because the assertions come after the read.
        std::env::set_var(super::OWN_RELAY_URL_ENV, "https://pinned.example");
        let resolved = ryu_webhook_ingress::configured_kind(Some("cloudflared"));
        match restore {
            Some(v) => std::env::set_var(super::OWN_RELAY_URL_ENV, v),
            None => std::env::remove_var(super::OWN_RELAY_URL_ENV),
        }
        assert_eq!(
            resolved,
            IngressKind::OwnRelay,
            "the env override still wins over the backend pref; if this fails, \
             `env_pinned_kind` and the 409 it drives are describing a pin that is gone"
        );
        assert_eq!(
            env_pinned_kind(Some("https://pinned.example")),
            Some(resolved)
        );
    }

    /// Serializes the one test that must touch the process-global env var.
    /// `crates/core/webhook-ingress` guards the same variable with a lock of its
    /// own, but that lock is private to that crate and its tests run in a separate
    /// binary — the two processes cannot contend, and this lock cannot borrow it.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
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

/// Ensure Composio can deliver trigger events to this node, then persist the
/// project subscription's signing secret in Core's encrypted plugin-secret
/// store. This runs before any trigger-instance upsert so a successful local
/// subscription is never paired with a missing remote delivery destination.
pub async fn reconcile_composio_subscription(
    store: &crate::composio_triggers::ComposioTriggerStore,
) -> anyhow::Result<()> {
    let preferences = PreferencesStore::open_default()
        .map_err(|error| anyhow::anyhow!("opening webhook ingress preferences: {error}"))?;
    if configured_kind(&preferences).await == IngressKind::RyuRelay {
        ryu_webhook_ingress::ensure_relay_started()
            .await
            .map_err(|error| anyhow::anyhow!("starting managed webhook relay: {error}"))?;
    }
    let public_url = ryu_webhook_ingress::public_url().ok_or_else(|| {
        anyhow::anyhow!(
            "webhook ingress has no public URL; configure or restart the selected ingress backend"
        )
    })?;
    let secret = store.reconcile_webhook_subscription(&public_url).await?;

    // Persist the provider-owned value before checking an environment override.
    // If Composio created or rotated the project secret, this preserves the only
    // copy returned by the API and prevents a stale env value from being trusted
    // on the next reconcile.
    let secret_store = crate::plugin_secrets::global()
        .ok_or_else(|| anyhow::anyhow!("encrypted plugin-secret store unavailable"))?;
    secret_store
        .set(
            crate::composio_triggers::WEBHOOK_SECRET_STORE_OWNER,
            crate::composio_triggers::WEBHOOK_SECRET_STORE_KEY,
            &secret,
        )
        .await
        .map_err(|error| anyhow::anyhow!("persisting Composio webhook secret: {error}"))?;
    crate::composio_triggers::set_stored_webhook_secret(Some(secret.clone()));

    if let Some(environment_secret) = crate::composio_triggers::env_webhook_secret() {
        if environment_secret != secret {
            anyhow::bail!(
                "Composio returned a different webhook signing secret; the current value was saved securely, so remove the stale COMPOSIO_WEBHOOK_SECRET override before subscribing"
            );
        }
        return Ok(());
    }
    Ok(())
}

/// Re-point the Composio project webhook subscription after the managed relay
/// registered this node again under a new public URL (its relay token was
/// rotated). Composio would otherwise keep posting to the revoked URL, which the
/// relay answers with `404`.
///
/// Only a destination Core manages is touched: the legacy (non-Connect) mode
/// with a Composio key and at least one trigger subscription, which are the
/// conditions under which [`reconcile_composio_subscription`] created it. The
/// reconcile patches the subscription only when its URL drifted. Best-effort: a
/// failure is logged, and the next trigger subscribe or workflow save
/// reconciles again.
pub async fn repoint_composio_subscription_after_relay_change() {
    if ryu_composio::service::is_configured() || !crate::composio_auth::is_configured() {
        return;
    }
    let Some(store) = crate::composio_triggers::global() else {
        return;
    };
    match store.list().await {
        Ok(subscriptions) if !subscriptions.is_empty() => {}
        Ok(_) => return,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "webhook-ingress: could not list Composio subscriptions after relay token rotation"
            );
            return;
        }
    }
    match reconcile_composio_subscription(store).await {
        Ok(()) => tracing::info!(
            "webhook-ingress: Composio webhook subscription follows the rotated relay URL"
        ),
        Err(error) => tracing::warn!(
            error = %error,
            "webhook-ingress: could not re-point the Composio webhook subscription after relay token rotation"
        ),
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
    fn sign(
        secret: &str,
        workflow_id: &str,
        body: &[u8],
        timestamp: &str,
        delivery_id: &str,
    ) -> String {
        let mut signed =
            format!("ryu-workflow-webhook-v3\n{workflow_id}\n{timestamp}\n{delivery_id}\n")
                .into_bytes();
        signed.extend_from_slice(body);
        format!(
            "v3,{}",
            crate::composio_triggers::hmac_sha256_hex(secret.as_bytes(), &signed)
        )
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
            max_concurrency: None,
            created_at: None,
            updated_at: None,
        };
        crate::workflow::store::save_workflow(&workflow).expect("save workflow");

        let body = br#"{"event":"unify","value":42}"#;
        let timestamp = crate::pairing::now_secs().to_string();
        let delivery_id = format!("delivery-{}", uuid::Uuid::new_v4().simple());
        let sig = sign(secret, &id, body, &timestamp, &delivery_id);
        let headers = ryu_webhook_ingress::InboundWebhookHeaders {
            signature: Some(&sig),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some(&timestamp),
        };
        let path = ryu_webhook_ingress::workflow_webhook_path(&id);

        // Deliver through the SAME path router the relay dispatches to, against the
        // real Core host.
        let outcome = ryu_webhook_ingress::deliver_inbound(&path, body, headers).await;
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
            ryu_webhook_ingress::deliver_inbound(&path, br#"{"event":"tampered"}"#, headers).await;
        assert!(matches!(
            rejected,
            ryu_webhook_ingress::InboundOutcome::Rejected(_)
        ));
    }

    /// Two workflows that intentionally share one signing secret: a fresh, valid
    /// delivery signed for A must not start B, on either the relay path router or
    /// the direct per-workflow entry point, and must still run A afterwards (the
    /// refusal at B reserves nothing).
    #[tokio::test]
    async fn a_signature_for_one_workflow_never_fires_another_with_the_same_secret() {
        use ryu_webhook_ingress::WorkflowWebhookOutcome;

        ryu_webhook_ingress::set_global_host(Arc::new(
            crate::webhook_ingress_host::CoreWebhookIngressHost,
        ));
        let shared_secret = "wh-secret-shared-between-workflows";
        let workflow = |id: &str| Workflow {
            id: id.to_owned(),
            name: format!("shared secret {id}"),
            description: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            triggers: vec![WorkflowTrigger::Webhook {
                secret: Some(shared_secret.to_owned()),
            }],
            created_at: None,
            updated_at: None,
            max_concurrency: None,
        };
        let suffix = uuid::Uuid::new_v4().simple();
        let id_a = format!("wf-shared-a-{suffix}");
        let id_b = format!("wf-shared-b-{suffix}");
        crate::workflow::store::save_workflow(&workflow(&id_a)).expect("save A");
        crate::workflow::store::save_workflow(&workflow(&id_b)).expect("save B");

        let body = br#"{"event":"for-a-only"}"#;
        let timestamp = crate::pairing::now_secs().to_string();
        let delivery_id = format!("delivery-{suffix}");
        let sig = sign(shared_secret, &id_a, body, &timestamp, &delivery_id);
        let headers = ryu_webhook_ingress::InboundWebhookHeaders {
            signature: Some(&sig),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some(&timestamp),
        };

        let path_b = ryu_webhook_ingress::workflow_webhook_path(&id_b);
        let relayed = ryu_webhook_ingress::deliver_inbound(&path_b, body, headers).await;
        assert!(
            matches!(relayed, ryu_webhook_ingress::InboundOutcome::Rejected(_)),
            "A's signature must not be accepted at B over the relay: {relayed:?}"
        );
        let direct = ryu_webhook_ingress::deliver_workflow_webhook(&id_b, body, headers).await;
        assert!(
            matches!(direct, WorkflowWebhookOutcome::BadSignature),
            "A's signature must not be accepted at B directly: {direct:?}"
        );
        assert!(ryu_webhook_ingress::last_delivery(&path_b).is_none());

        assert!(matches!(
            ryu_webhook_ingress::deliver_workflow_webhook(&id_a, body, headers).await,
            WorkflowWebhookOutcome::Ran(_)
        ));
    }

    /// A webhook run that fails after it started keeps its delivery reservation:
    /// the sender gets the run id at once, and a redelivery of the same id is a
    /// duplicate even after the failure, so side effects of nodes that already
    /// ran are never repeated.
    #[tokio::test]
    async fn failed_webhook_run_keeps_its_delivery_reservation() {
        use crate::workflow::store::RunStatus;
        use crate::workflow::{NodeKind, WorkflowEdge, WorkflowNode};
        use ryu_webhook_ingress::WorkflowWebhookOutcome;

        ryu_webhook_ingress::set_global_host(Arc::new(
            crate::webhook_ingress_host::CoreWebhookIngressHost,
        ));
        let secret = "wh-secret-failing";
        let id = format!("wf-failing-{}", uuid::Uuid::new_v4().simple());
        let node = |id: &str, kind: NodeKind| WorkflowNode {
            id: id.to_owned(),
            kind,
            retry: None,
            timeout_ms: None,
            repeat: None,
        };
        let edge = |from: &str, to: &str| WorkflowEdge {
            from: from.to_owned(),
            to: to.to_owned(),
            branch: None,
        };
        let workflow = Workflow {
            id: id.clone(),
            name: "failing webhook test".to_owned(),
            description: None,
            nodes: vec![
                node("in", NodeKind::Input { key: None }),
                // Always errors: no MCP registry in tests, and an unknown tool.
                node(
                    "tool",
                    NodeKind::Tool {
                        name: "nope.nope".to_owned(),
                        args: serde_json::json!({}),
                    },
                ),
                node("out", NodeKind::Output { key: None }),
            ],
            edges: vec![edge("in", "tool"), edge("tool", "out")],
            triggers: vec![WorkflowTrigger::Webhook {
                secret: Some(secret.to_owned()),
            }],
            max_concurrency: None,
            created_at: None,
            updated_at: None,
        };
        crate::workflow::store::save_workflow(&workflow).expect("save workflow");

        let body = br#"{"event":"fails"}"#;
        let timestamp = crate::pairing::now_secs().to_string();
        let delivery_id = format!("delivery-{}", uuid::Uuid::new_v4().simple());
        let sig = sign(secret, &id, body, &timestamp, &delivery_id);
        let headers = ryu_webhook_ingress::InboundWebhookHeaders {
            signature: Some(&sig),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some(&timestamp),
        };

        let run_id = match ryu_webhook_ingress::deliver_workflow_webhook(&id, body, headers).await {
            WorkflowWebhookOutcome::Ran(run_id) => run_id,
            other => panic!("expected the run to start, got {other:?}"),
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let status = crate::workflow::store::load_run(&run_id).map(|run| run.status);
            if matches!(status, Ok(RunStatus::Failed)) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the background run should fail, got {status:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(matches!(
            ryu_webhook_ingress::deliver_workflow_webhook(&id, body, headers).await,
            WorkflowWebhookOutcome::Duplicate
        ));
    }

    /// Composio delivery claims reach the real host's durable SQLite ledger (one
    /// fresh connection per call, so a claim outlives the process that took it),
    /// and a released claim can be taken again by the sender's retry.
    #[test]
    fn composio_delivery_claims_use_the_real_durable_ledger() {
        ryu_webhook_ingress::set_global_host(Arc::new(
            crate::webhook_ingress_host::CoreWebhookIngressHost,
        ));
        let delivery_id = format!("msg_{}", uuid::Uuid::new_v4().simple());

        assert!(ryu_webhook_ingress::reserve_composio_delivery(&delivery_id).expect("claim"));
        assert!(
            !ryu_webhook_ingress::reserve_composio_delivery(&delivery_id).expect("retry"),
            "a retry of a claimed id is a duplicate"
        );
        ryu_webhook_ingress::release_composio_delivery(&delivery_id).expect("release");
        assert!(
            ryu_webhook_ingress::reserve_composio_delivery(&delivery_id).expect("re-claim"),
            "a released id is dispatched again"
        );
        ryu_webhook_ingress::release_composio_delivery(&delivery_id).expect("cleanup");
        assert!(ryu_webhook_ingress::reserve_composio_delivery("  ").is_err());
    }
}
