//! Path-aware inbound webhook dispatch — the "route ANY inbound path" seam
//! (webhook-unify).
//!
//! # Why this exists
//!
//! Before this module the managed [`super::RyuRelaySource`] fanned out **only**
//! `composio.webhook` frames and dispatched them straight to
//! [`crate::composio_triggers`]. A per-workflow webhook trigger
//! (`POST /api/workflows/<id>/webhook`) was therefore *unreachable* on a default
//! laptop node: the tunnel/relay knew a single hardcoded path
//! ([`super::WEBHOOK_PATH`]) and no other. The tunnel backends
//! (Cloudflared/Funnel/OwnRelay) forward every path to Core's real router, so
//! they already worked — the gap was RyuRelay's in-process dispatch.
//!
//! This module closes it by making dispatch **path-routed**: given
//! `(path, raw_body, signature)` it delivers to the correct in-process handler —
//! the composio webhook receiver, a per-workflow webhook trigger, or (future) a
//! registered channel — instead of composio-only.
//!
//! # Auth is re-verified in Core (the correctness crux)
//!
//! A per-workflow webhook's HMAC secret lives **only** in Core
//! ([`crate::workflow::WorkflowTrigger::Webhook`]); `apps/server` cannot know it.
//! So a workflow frame that arrives over the relay MUST be re-verified here with
//! the *same* [`crate::composio_triggers::verify_workflow_webhook_signature`] the
//! HTTP handler uses — dispatching it unverified would be an auth bypass that
//! fires real side effects. Composio, by contrast, is a trust-relay: the server
//! verifies the global secret before fan-out, so the legacy `composio.webhook`
//! frame path stays as-is (see [`super::ryu_relay`]).
//!
//! Placement (CLAUDE.md §1): choosing which handler runs for an inbound event is
//! *what runs* → Core. No policy here; the outbound governance the sibling
//! `channel_send` node performs is the Gateway's job and lives there.

use std::collections::BTreeMap;
use std::sync::RwLock;

use serde_json::Value;

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
}

/// Verify and (on success) fire a per-workflow webhook trigger. This is the
/// single source of truth for the workflow-webhook auth + run path — the HTTP
/// handler and the relay dispatcher both call it, guaranteeing identical
/// fail-closed semantics.
///
/// On success it records the delivery against [`workflow_webhook_path`] so the
/// registry reflects relay-delivered firings too.
pub async fn deliver_workflow_webhook(
    id: &str,
    raw_body: &[u8],
    signature: Option<&str>,
) -> WorkflowWebhookOutcome {
    let Ok(workflow) = crate::workflow::store::load_workflow(id) else {
        return WorkflowWebhookOutcome::NotFound;
    };
    // Find the workflow's webhook trigger + its per-trigger secret.
    let trigger_secret = workflow.triggers.iter().find_map(|t| match t {
        crate::workflow::WorkflowTrigger::Webhook { secret } => Some(secret.clone()),
        _ => None,
    });
    let Some(trigger_secret) = trigger_secret else {
        return WorkflowWebhookOutcome::NoWebhookTrigger;
    };
    let Some(secret) = trigger_secret.filter(|s| !s.trim().is_empty()) else {
        return WorkflowWebhookOutcome::NoSecret;
    };
    if !crate::composio_triggers::verify_workflow_webhook_signature(&secret, raw_body, signature) {
        return WorkflowWebhookOutcome::BadSignature;
    }
    // The raw JSON body becomes the run's trigger payload; validate it parses so
    // a malformed body fails fast rather than seeding unusable trigger state.
    let Ok(body_str) = std::str::from_utf8(raw_body) else {
        return WorkflowWebhookOutcome::BadBody("body is not valid UTF-8".to_owned());
    };
    if serde_json::from_str::<Value>(body_str).is_err() {
        return WorkflowWebhookOutcome::BadBody("body must be valid JSON".to_owned());
    }
    match crate::composio_triggers::run_workflow_for_trigger(id, body_str).await {
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
pub async fn deliver_inbound(path: &str, raw_body: &[u8], signature: Option<&str>) -> InboundOutcome {
    if path == WEBHOOK_PATH {
        // Composio: verify the global secret, then hand to the composio store.
        if !crate::composio_triggers::verify_webhook_signature(raw_body, signature) {
            return InboundOutcome::Rejected(
                "composio webhook: invalid or missing signature".to_owned(),
            );
        }
        let Ok(payload) = serde_json::from_slice::<Value>(raw_body) else {
            return InboundOutcome::Rejected("composio webhook: invalid JSON body".to_owned());
        };
        return match crate::composio_triggers::global() {
            Some(store) => {
                let fired = store.handle_webhook(&payload).await;
                record_delivery(path);
                InboundOutcome::Delivered {
                    detail: format!("composio webhook fired {fired} run(s)"),
                }
            }
            None => InboundOutcome::Rejected("composio triggers store unavailable".to_owned()),
        };
    }

    if let Some(id) = parse_workflow_webhook_path(path) {
        return match deliver_workflow_webhook(&id, raw_body, signature).await {
            WorkflowWebhookOutcome::Ran(run_id) => InboundOutcome::Delivered {
                detail: format!("workflow '{id}' run {run_id}"),
            },
            WorkflowWebhookOutcome::NotFound => {
                InboundOutcome::Rejected(format!("workflow '{id}' not found"))
            }
            WorkflowWebhookOutcome::NoWebhookTrigger => {
                InboundOutcome::Rejected(format!("workflow '{id}' has no webhook trigger"))
            }
            WorkflowWebhookOutcome::NoSecret => {
                InboundOutcome::Rejected(format!("workflow '{id}' webhook has no secret configured"))
            }
            WorkflowWebhookOutcome::BadSignature => {
                InboundOutcome::Rejected(format!("workflow '{id}': invalid or missing signature"))
            }
            WorkflowWebhookOutcome::BadBody(e) => {
                InboundOutcome::Rejected(format!("workflow '{id}': {e}"))
            }
            WorkflowWebhookOutcome::RunError(e) => {
                InboundOutcome::Rejected(format!("workflow '{id}' run failed: {e}"))
            }
        };
    }

    InboundOutcome::Unhandled
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sign with the same HMAC-SHA256 hex the verifier uses, so a test signature
    /// round-trips against `verify_workflow_webhook_signature`.
    fn sign(secret: &str, body: &[u8]) -> String {
        crate::composio_triggers::hmac_sha256_hex(secret.as_bytes(), body)
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
        let path = format!("/api/workflows/ld-{}/webhook", uuid::Uuid::new_v4().simple());
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

    /// The headline acceptance test: a **workflow** webhook delivered through the
    /// unified ingress (`deliver_inbound`, the same entry the relay uses) reaches
    /// the workflow run — not composio. We save a real workflow with a webhook
    /// trigger + secret, sign the body with that secret, and assert the router
    /// delivers it (which internally calls `run_workflow_for_trigger`, producing a
    /// run id). A zero-node workflow runs to completion with no engine dependency.
    #[tokio::test]
    async fn workflow_webhook_reaches_run_through_unified_ingress() {
        use crate::workflow::{Workflow, WorkflowTrigger};

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
        let path = workflow_webhook_path(&id);

        // Deliver through the SAME path router the relay dispatches to.
        let outcome = deliver_inbound(&path, body, Some(&sig)).await;
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

        // A tampered body (signature no longer matches) is rejected fail-closed.
        let rejected = deliver_inbound(&path, br#"{"event":"tampered"}"#, Some(&sig)).await;
        assert!(matches!(rejected, InboundOutcome::Rejected(_)));
    }
}
