//! Path-aware inbound webhook dispatch — the "route ANY inbound path" seam
//! (webhook-unify).
//!
//! # Why this exists
//!
//! Before this module the managed [`super::RyuRelaySource`] fanned out **only**
//! `composio.webhook` frames and dispatched them straight to the composio
//! triggers store. A per-workflow webhook trigger
//! (`POST /api/workflows/<id>/webhook`) was therefore *unreachable* on a default
//! laptop node: the tunnel/relay knew a single hardcoded path
//! ([`super::WEBHOOK_PATH`]) and no other. The tunnel backends
//! (Cloudflared/Funnel/OwnRelay) forward every path to Core's real router, so
//! they already worked — the gap was RyuRelay's in-process dispatch.
//!
//! This module closes it by making dispatch **path-routed**: given
//! `(path, raw_body, signature)` it delivers to the correct handler — the composio
//! webhook receiver, a per-workflow webhook trigger, or (future) a registered
//! channel — instead of composio-only. The concrete handlers are kernel; they are
//! reached through [`super::WebhookIngressHost`].
//!
//! # Auth is re-verified here (the correctness crux)
//!
//! A per-workflow webhook's HMAC secret lives **only** in Core (the workflow's
//! `Webhook` trigger); `apps/server` cannot know it. So a workflow frame that
//! arrives over the relay MUST be re-verified here with the *same*
//! `verify_workflow_webhook_signature` the HTTP handler uses (both go through the
//! host) — dispatching it unverified would be an auth bypass that fires real side
//! effects. Composio, by contrast, is a trust-relay: the server verifies the
//! global secret before fan-out, so the legacy `composio.webhook` frame path stays
//! as-is (see [`super::ryu_relay`]). The fail-closed ladder below stays in this
//! crate; the host only performs the leaf secret lookup + crypto + run.
//!
//! Placement (CLAUDE.md §1): choosing which handler runs for an inbound event is
//! *what runs* → Core. No policy here; the outbound governance the sibling
//! `channel_send` node performs is the Gateway's job and lives there.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock, RwLock};

use serde_json::Value;

use super::host::{host, WorkflowWebhookSecret};
use super::ryu_relay::SeenDeliveries;
use super::WEBHOOK_PATH;

/// The URL-path prefix/suffix bracketing a per-workflow webhook trigger route
/// (`/api/workflows/<id>/webhook`). Kept in lockstep with the axum route in
/// `server/mod.rs` so [`workflow_webhook_path`] and [`parse_workflow_webhook_path`]
/// round-trip.
const WORKFLOW_WEBHOOK_PREFIX: &str = "/api/workflows/";
const WORKFLOW_WEBHOOK_SUFFIX: &str = "/webhook";

/// Replay-staleness window for inbound webhooks that carry a timestamp header
/// (seconds). A delivery whose declared timestamp is more than this far from
/// "now" (either direction — clock skew or a replayed capture) is rejected.
const REPLAY_WINDOW_SECS: i64 = 300;

/// Build the canonical per-workflow webhook path for `id`. The registry
/// (`GET /api/webhooks`) and the delivery recorder use this so the stored
/// last-delivery key and the advertised URL never drift.
pub fn workflow_webhook_path(id: &str) -> String {
    format!("{WORKFLOW_WEBHOOK_PREFIX}{id}{WORKFLOW_WEBHOOK_SUFFIX}")
}

/// Parse a `/api/workflows/<id>/webhook` path back to its `<id>`, or `None` when
/// the path is not a workflow-webhook route. Rejects an empty id and a nested
/// path (an `id` may not itself contain a `/`).
fn parse_workflow_webhook_path(path: &str) -> Option<String> {
    let inner = path
        .strip_prefix(WORKFLOW_WEBHOOK_PREFIX)?
        .strip_suffix(WORKFLOW_WEBHOOK_SUFFIX)?;
    if inner.is_empty() || inner.contains('/') {
        return None;
    }
    Some(inner.to_owned())
}

// ── Last-delivery tracking (the registry's per-endpoint metadata) ─────────────

/// Process-global map of `webhook path → last-delivery unix seconds`. Populated
/// on every successful dispatch (relay *and* direct-HTTP), read by the
/// `GET /api/webhooks` registry so each endpoint can show when it last fired.
static LAST_DELIVERY: RwLock<BTreeMap<String, i64>> = RwLock::new(BTreeMap::new());

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record that `path` just received (and accepted) a delivery, stamping "now".
/// Called from both the relay dispatcher and the direct HTTP handlers so the
/// registry reflects every source.
pub fn record_delivery(path: &str) {
    if let Ok(mut guard) = LAST_DELIVERY.write() {
        guard.insert(path.to_owned(), now_unix());
    }
}

/// The unix-seconds timestamp of the last accepted delivery for `path`, if any.
pub fn last_delivery(path: &str) -> Option<i64> {
    LAST_DELIVERY.read().ok().and_then(|g| g.get(path).copied())
}

// ── Direct-HTTP delivery dedup (relay parity) ─────────────────────────────────

/// Process-global dedup set for DIRECT-HTTP deliveries. The relay transport
/// keeps its own per-subscription set (ryu_relay.rs); this one covers the
/// public HTTP handlers, which face the same at-least-once retry semantics.
/// Returns true when `id` is new (dispatch) — false when already seen (skip).
/// An empty id is always "new": deliveries without a delivery-id header are
/// not dedupable and pass through unchanged.
pub fn first_http_delivery(id: &str) -> bool {
    static SEEN: OnceLock<Mutex<SeenDeliveries>> = OnceLock::new();
    let lock = SEEN.get_or_init(|| Mutex::new(SeenDeliveries::default()));
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(id)
}

// ── Replay window (acceptance #5) ─────────────────────────────────────────────

/// Whether an inbound delivery is fresh enough to accept, given the value of a
/// timestamp header (e.g. Svix/Composio `webhook-timestamp`) if present.
///
/// **Back-compat, low-risk posture**: a delivery with *no* timestamp header, or
/// an unparseable one, is treated as fresh (returns `true`) — many callers
/// (including Core's own tests and simple integrations) do not sign a timestamp,
/// and rejecting them would break existing flows. Only a *present, parseable*
/// timestamp that is outside [`REPLAY_WINDOW_SECS`] of `now_unix` is rejected.
/// This adds replay protection for callers that opt in without a hard cutover.
pub fn timestamp_fresh(ts_header: Option<&str>, now: i64) -> bool {
    let Some(raw) = ts_header.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    // Accept a bare unix-seconds value or an `t=<secs>` (Stripe-style) token.
    let parsed = raw
        .split(',')
        .find_map(|tok| tok.trim().strip_prefix("t=").or(Some(tok.trim())))
        .and_then(|v| v.parse::<i64>().ok());
    match parsed {
        Some(ts) => (now - ts).abs() <= REPLAY_WINDOW_SECS,
        None => true,
    }
}

// ── Shared per-workflow webhook delivery (reused by HTTP + relay) ─────────────

/// The outcome of delivering a per-workflow webhook. Rich enough that both the
/// axum `workflow_webhook` handler (→ HTTP status) and the relay dispatcher
/// (→ log line) map from the *same* decision, so their auth can never drift.
#[derive(Debug)]
pub enum WorkflowWebhookOutcome {
    /// The signature verified and the workflow run started; carries its run id.
    Ran(String),
    /// No workflow with this id exists.
    NotFound,
    /// The workflow exists but declares no `Webhook` trigger.
    NoWebhookTrigger,
    /// The webhook trigger exists but has no (non-empty) secret configured —
    /// fail-closed: an unauthenticated public trigger is a forgery vector.
    NoSecret,
    /// The signature was missing or did not match.
    BadSignature,
    /// The body was not valid UTF-8 / JSON. Carries a human-readable reason.
    BadBody(String),
    /// The signature verified but starting the run failed. Carries the error.
    RunError(String),
    /// The signature verified but `delivery_id` was already seen (at-least-once
    /// retry) — the run already fired on the first delivery, so this one is a
    /// no-op. Relay parity: mirrors `ryu_relay.rs`'s `SeenDeliveries` dedup for
    /// the direct-HTTP path.
    Duplicate,
}

/// Verify and (on success) fire a per-workflow webhook trigger. This is the
/// single source of truth for the workflow-webhook auth + run path — the HTTP
/// handler and the relay dispatcher both call it, guaranteeing identical
/// fail-closed semantics.
///
/// `delivery_id` is checked against the process-global HTTP seen-set
/// ([`first_http_delivery`]) immediately AFTER the signature verifies (never
/// before — an unauthenticated caller must not be able to poison the seen-set
/// with a forged id and suppress a later legitimate delivery) and BEFORE the
/// run fires. An empty `delivery_id` (no id header, or a caller — such as the
/// relay — that already deduped upstream) is always treated as new, so passing
/// `""` is a safe no-op.
///
/// On success it records the delivery against [`workflow_webhook_path`] so the
/// registry reflects relay-delivered firings too.
pub async fn deliver_workflow_webhook(
    id: &str,
    raw_body: &[u8],
    signature: Option<&str>,
    delivery_id: &str,
) -> WorkflowWebhookOutcome {
    let Ok(host) = host() else {
        // No host installed → treat as unresolvable (fail-closed, never fires).
        return WorkflowWebhookOutcome::NotFound;
    };
    // The host does the raw lookup; the empty-secret → NoSecret decision stays
    // here (the crate owns the fail-closed ladder, not the host).
    let secret = match host.workflow_webhook_secret(id) {
        WorkflowWebhookSecret::NotFound => return WorkflowWebhookOutcome::NotFound,
        WorkflowWebhookSecret::NoTrigger => return WorkflowWebhookOutcome::NoWebhookTrigger,
        WorkflowWebhookSecret::Secret(s) => match s.filter(|s| !s.trim().is_empty()) {
            Some(secret) => secret,
            None => return WorkflowWebhookOutcome::NoSecret,
        },
    };
    if !host.verify_workflow_webhook_signature(&secret, raw_body, signature) {
        return WorkflowWebhookOutcome::BadSignature;
    }
    // Dedup AFTER auth so an unauthenticated caller cannot poison the seen-set
    // with a forged id and suppress a legitimate delivery.
    if !first_http_delivery(delivery_id) {
        return WorkflowWebhookOutcome::Duplicate;
    }
    // The raw JSON body becomes the run's trigger payload; validate it parses so
    // a malformed body fails fast rather than seeding unusable trigger state.
    let Ok(body_str) = std::str::from_utf8(raw_body) else {
        return WorkflowWebhookOutcome::BadBody("body is not valid UTF-8".to_owned());
    };
    if serde_json::from_str::<Value>(body_str).is_err() {
        return WorkflowWebhookOutcome::BadBody("body must be valid JSON".to_owned());
    }
    match host.run_workflow_for_trigger(id, body_str).await {
        Ok(run_id) => {
            record_delivery(&workflow_webhook_path(id));
            WorkflowWebhookOutcome::Ran(run_id)
        }
        Err(e) => WorkflowWebhookOutcome::RunError(e.to_string()),
    }
}

// ── The path router (any inbound path) ────────────────────────────────────────

/// The outcome of routing one inbound webhook by path.
#[derive(Debug)]
pub enum InboundOutcome {
    /// Delivered to a handler; `detail` is a short human summary for logs.
    Delivered { detail: String },
    /// Recognised the path but refused the delivery (bad signature, no secret,
    /// store unavailable, …). Carries the reason.
    Rejected(String),
    /// No handler is registered for this path.
    Unhandled,
}

/// Route an inbound webhook to the correct in-process handler by `path`.
///
/// This is the unified replacement for the composio-only relay dispatch: it
/// matches the composio path and every per-workflow webhook path (and is the one
/// place a future registered-channel path would gain an arm). It re-verifies the
/// signature for the workflow arm (the secret lives only in Core) and for the
/// composio arm (defense-in-depth even though the relay server also verifies).
///
/// `signature` is the pre-extracted signature-header value (the relay frame /
/// HTTP handler picks the right header spelling). `raw_body` is the exact bytes
/// the signature was computed over.
pub async fn deliver_inbound(
    path: &str,
    raw_body: &[u8],
    signature: Option<&str>,
) -> InboundOutcome {
    if path == WEBHOOK_PATH {
        let Ok(host) = host() else {
            return InboundOutcome::Rejected("webhook-ingress host unavailable".to_owned());
        };
        // Composio: verify the global secret, then hand to the composio store.
        if !host.verify_webhook_signature(raw_body, signature) {
            return InboundOutcome::Rejected(
                "composio webhook: invalid or missing signature".to_owned(),
            );
        }
        let Ok(payload) = serde_json::from_slice::<Value>(raw_body) else {
            return InboundOutcome::Rejected("composio webhook: invalid JSON body".to_owned());
        };
        return match host.composio_handle_webhook(&payload).await {
            Some(fired) => {
                record_delivery(path);
                InboundOutcome::Delivered {
                    detail: format!("composio webhook fired {fired} run(s)"),
                }
            }
            None => InboundOutcome::Rejected("composio triggers store unavailable".to_owned()),
        };
    }

    if let Some(id) = parse_workflow_webhook_path(path) {
        // "" for `delivery_id`: every `deliver_inbound` caller (the relay's
        // `Inbound` arm, and Core's real-wiring test) already deduped by the
        // frame/delivery id upstream — see `ryu_relay.rs`'s `dispatch_frame` —
        // so a second dedup here would be redundant, and "" keeps it a no-op.
        return match deliver_workflow_webhook(&id, raw_body, signature, "").await {
            WorkflowWebhookOutcome::Ran(run_id) => InboundOutcome::Delivered {
                detail: format!("workflow '{id}' run {run_id}"),
            },
            WorkflowWebhookOutcome::NotFound => {
                InboundOutcome::Rejected(format!("workflow '{id}' not found"))
            }
            WorkflowWebhookOutcome::NoWebhookTrigger => {
                InboundOutcome::Rejected(format!("workflow '{id}' has no webhook trigger"))
            }
            WorkflowWebhookOutcome::NoSecret => InboundOutcome::Rejected(format!(
                "workflow '{id}' webhook has no secret configured"
            )),
            WorkflowWebhookOutcome::BadSignature => {
                InboundOutcome::Rejected(format!("workflow '{id}': invalid or missing signature"))
            }
            WorkflowWebhookOutcome::BadBody(e) => {
                InboundOutcome::Rejected(format!("workflow '{id}': {e}"))
            }
            WorkflowWebhookOutcome::RunError(e) => {
                InboundOutcome::Rejected(format!("workflow '{id}' run failed: {e}"))
            }
            // "" is always treated as new by `first_http_delivery`, so this arm
            // is unreachable from this call site — kept exhaustive for the enum.
            WorkflowWebhookOutcome::Duplicate => {
                InboundOutcome::Rejected(format!("workflow '{id}': duplicate delivery"))
            }
        };
    }

    InboundOutcome::Unhandled
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{set_global_host, WebhookIngressHost};
    use std::sync::Arc;

    /// A single deterministic mock host installed for the crate test process
    /// (`set_global_host` is a `OnceLock` → one host per process, so behaviour is
    /// keyed purely on inputs). Drives the router's branches without any kernel:
    /// - `workflow_webhook_secret`: keyed on an `-notfound` / `-notrigger` /
    ///   `-nosecret` marker in the id, else a real secret.
    /// - `verify_workflow_webhook_signature`: true iff the signature is `"good"`.
    /// - `run_workflow_for_trigger`: succeeds with a synthetic run id.
    struct MockHost;

    #[async_trait::async_trait]
    impl WebhookIngressHost for MockHost {
        fn composio_is_configured(&self) -> bool {
            true
        }
        fn has_webhook_trigger(&self) -> bool {
            false
        }
        fn verify_webhook_signature(&self, _raw_body: &[u8], signature: Option<&str>) -> bool {
            signature == Some("good")
        }
        fn verify_workflow_webhook_signature(
            &self,
            _secret: &str,
            _raw_body: &[u8],
            signature: Option<&str>,
        ) -> bool {
            signature == Some("good")
        }
        async fn composio_handle_webhook(&self, _payload: &Value) -> Option<usize> {
            Some(1)
        }
        async fn run_workflow_for_trigger(
            &self,
            workflow_id: &str,
            _payload_json: &str,
        ) -> anyhow::Result<String> {
            Ok(format!("trigrun_{workflow_id}"))
        }
        fn workflow_webhook_secret(&self, workflow_id: &str) -> WorkflowWebhookSecret {
            if workflow_id.contains("-notfound") {
                WorkflowWebhookSecret::NotFound
            } else if workflow_id.contains("-notrigger") {
                WorkflowWebhookSecret::NoTrigger
            } else if workflow_id.contains("-nosecret") {
                WorkflowWebhookSecret::Secret(None)
            } else {
                WorkflowWebhookSecret::Secret(Some("s3cr3t".to_owned()))
            }
        }
        fn auth_token(&self) -> Option<String> {
            None
        }
        fn data_dir(&self) -> std::path::PathBuf {
            std::env::temp_dir()
        }
        async fn ensure_funnel(&self, _port: u16) -> anyhow::Result<String> {
            anyhow::bail!("mock: no funnel")
        }
        async fn funnel_url(&self, _port: u16) -> Option<String> {
            None
        }
    }

    /// Install the shared mock host (idempotent). Any host-driven test calls this
    /// first, so install order across the parallel test threads is irrelevant.
    fn ensure_mock_host() {
        set_global_host(Arc::new(MockHost));
    }

    #[test]
    fn workflow_path_round_trips() {
        let p = workflow_webhook_path("wf-123");
        assert_eq!(p, "/api/workflows/wf-123/webhook");
        assert_eq!(parse_workflow_webhook_path(&p).as_deref(), Some("wf-123"));
    }

    #[test]
    fn parse_rejects_non_workflow_and_nested_paths() {
        assert_eq!(parse_workflow_webhook_path("/api/composio/webhook"), None);
        assert_eq!(parse_workflow_webhook_path("/api/workflows//webhook"), None);
        assert_eq!(
            parse_workflow_webhook_path("/api/workflows/a/b/webhook"),
            None
        );
        assert_eq!(parse_workflow_webhook_path("/nope"), None);
    }

    #[test]
    fn timestamp_fresh_accepts_absent_and_recent_rejects_stale() {
        let now = 1_000_000i64;
        // Absent / unparseable → fresh (back-compat).
        assert!(timestamp_fresh(None, now));
        assert!(timestamp_fresh(Some("   "), now));
        assert!(timestamp_fresh(Some("not-a-number"), now));
        // Within the window → fresh; the `t=` form is accepted too.
        assert!(timestamp_fresh(Some("1000000"), now));
        assert!(timestamp_fresh(Some(&format!("{}", now - 299)), now));
        assert!(timestamp_fresh(Some("t=1000000"), now));
        // Outside the window (either direction) → stale.
        assert!(!timestamp_fresh(Some(&format!("{}", now - 301)), now));
        assert!(!timestamp_fresh(Some(&format!("{}", now + 301)), now));
    }

    #[tokio::test]
    async fn last_delivery_round_trips() {
        let path = format!(
            "/api/workflows/ld-{}/webhook",
            uuid::Uuid::new_v4().simple()
        );
        assert!(last_delivery(&path).is_none());
        record_delivery(&path);
        assert!(last_delivery(&path).is_some());
    }

    #[tokio::test]
    async fn unknown_path_is_unhandled() {
        let outcome = deliver_inbound("/api/does/not/exist", b"{}", None).await;
        assert!(matches!(outcome, InboundOutcome::Unhandled));
    }

    #[tokio::test]
    async fn workflow_path_with_bad_signature_is_rejected_not_composio() {
        // A workflow path routes to the WORKFLOW arm, not composio: a bad/missing
        // signature yields a workflow-scoped rejection (or NotFound), never the
        // composio "invalid signature" message. This proves the router split.
        ensure_mock_host();
        let id = format!("wf-{}", uuid::Uuid::new_v4().simple());
        let path = workflow_webhook_path(&id);
        let outcome = deliver_inbound(&path, b"{}", Some("deadbeef")).await;
        match outcome {
            InboundOutcome::Rejected(msg) => {
                assert!(
                    msg.contains(&id),
                    "expected a workflow-scoped rejection, got: {msg}"
                );
                assert!(
                    !msg.contains("composio"),
                    "workflow path must not route to composio: {msg}"
                );
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    /// The router acceptance test (crate-side, mock host): a **workflow** webhook
    /// delivered through the unified ingress (`deliver_inbound`, the same entry the
    /// relay uses) routes to the WORKFLOW arm, re-verifies the trigger secret via
    /// the host, and on success reaches `run_workflow_for_trigger` — producing a
    /// run id and recording the delivery. A tampered/bad signature is rejected
    /// fail-closed. The *real-wiring* variant (real `save_workflow` + run against
    /// `CoreWebhookIngressHost`) lives in core (`apps/core/src/webhook_ingress.rs`).
    #[tokio::test]
    async fn workflow_webhook_reaches_run_through_unified_ingress() {
        ensure_mock_host();

        let id = format!("wf-unify-{}", uuid::Uuid::new_v4().simple());
        let body = br#"{"event":"unify","value":42}"#;
        let path = workflow_webhook_path(&id);

        // A valid signature ("good" per the mock) reaches the run.
        let outcome = deliver_inbound(&path, body, Some("good")).await;
        match &outcome {
            InboundOutcome::Delivered { detail } => {
                assert!(
                    detail.contains(&id) && detail.contains("run"),
                    "expected a workflow run delivery, got: {detail}"
                );
            }
            other => panic!("expected Delivered (reaching the workflow run), got {other:?}"),
        }
        // And it is recorded for the registry.
        assert!(
            last_delivery(&path).is_some(),
            "delivery should be recorded for the registry"
        );

        // A bad signature is rejected fail-closed (never fires the run).
        let rejected = deliver_inbound(&path, br#"{"event":"tampered"}"#, Some("bad")).await;
        assert!(matches!(rejected, InboundOutcome::Rejected(_)));
    }

    // ── first_http_delivery (Plan 013) ─────────────────────────────────────────
    //
    // `first_http_delivery` backs a process-global `OnceLock<Mutex<SeenDeliveries>>`
    // shared by every test in this (and any other) process. cargo runs tests as
    // parallel threads in one process, so ids are prefixed per-test to avoid
    // cross-test interference — mirrors `last_delivery_round_trips`'s uuid-suffix
    // pattern above.

    #[test]
    fn first_http_delivery_dedups_repeats() {
        let id = format!("http-dlv-{}", uuid::Uuid::new_v4().simple());
        assert!(first_http_delivery(&id), "first sight is new");
        assert!(!first_http_delivery(&id), "second sight is a duplicate");
    }

    #[test]
    fn first_http_delivery_empty_id_always_new() {
        // No id to dedup on → never suppress dispatch (matches SeenDeliveries).
        assert!(first_http_delivery(""));
        assert!(first_http_delivery(""));
    }

    #[test]
    fn first_http_delivery_distinct_ids_do_not_interfere() {
        let a = format!("http-dlv-a-{}", uuid::Uuid::new_v4().simple());
        let b = format!("http-dlv-b-{}", uuid::Uuid::new_v4().simple());
        assert!(first_http_delivery(&a));
        assert!(
            first_http_delivery(&b),
            "a different id is unaffected by a's insert"
        );
        assert!(!first_http_delivery(&a), "a is still deduped");
        assert!(!first_http_delivery(&b), "b is still deduped");
    }

    /// `deliver_workflow_webhook` acceptance (Plan 013): a valid signature with a
    /// repeated `delivery_id` yields `Ran` on the first call and `Duplicate` on
    /// the second — the dedup sits after auth (a bad-signature call never
    /// consumes the seen-set, proven by the second assertion below) and before
    /// the run.
    #[tokio::test]
    async fn deliver_workflow_webhook_dedups_by_delivery_id() {
        ensure_mock_host();

        let id = format!("wf-dedup-{}", uuid::Uuid::new_v4().simple());
        let delivery_id = format!("dlv-{}", uuid::Uuid::new_v4().simple());
        let body = br#"{"event":"first"}"#;

        // First delivery: valid signature, fresh id → runs.
        let first = deliver_workflow_webhook(&id, body, Some("good"), &delivery_id).await;
        assert!(matches!(first, WorkflowWebhookOutcome::Ran(_)));

        // Retried delivery: same id → duplicate, no second run.
        let retried = deliver_workflow_webhook(&id, body, Some("good"), &delivery_id).await;
        assert!(matches!(retried, WorkflowWebhookOutcome::Duplicate));

        // An unauthenticated forged id never reaches (and so never poisons) the
        // seen-set: a fresh id with a bad signature is rejected, not deduped —
        // and that same id is still usable afterwards for a real delivery.
        let forged_id = format!("dlv-forged-{}", uuid::Uuid::new_v4().simple());
        let bad = deliver_workflow_webhook(&id, body, Some("bad"), &forged_id).await;
        assert!(matches!(bad, WorkflowWebhookOutcome::BadSignature));
        let now_valid = deliver_workflow_webhook(&id, body, Some("good"), &forged_id).await;
        assert!(
            matches!(now_valid, WorkflowWebhookOutcome::Ran(_)),
            "a forged-signature attempt must not poison the seen-set for the real id"
        );
    }
}
