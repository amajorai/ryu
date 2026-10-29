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
//! effects. Current Composio relay deliveries use this same raw path so Core can
//! verify the project-specific ID/timestamp/body signature. The legacy parsed
//! `composio.webhook` frame is dropped: it carried no signature Core could
//! verify. The fail-closed ladder stays in this crate; the host
//! only performs the leaf secret lookup + crypto + run.
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
pub(crate) const WORKFLOW_WEBHOOK_PREFIX: &str = "/api/workflows/";
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
static HTTP_DELIVERIES: OnceLock<Mutex<SeenDeliveries>> = OnceLock::new();

fn http_deliveries() -> &'static Mutex<SeenDeliveries> {
    HTTP_DELIVERIES.get_or_init(|| Mutex::new(SeenDeliveries::default()))
}

pub fn first_http_delivery(id: &str) -> bool {
    let mut guard = http_deliveries()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.insert(id)
}

pub fn forget_http_delivery(id: &str) -> bool {
    let mut guard = http_deliveries()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.remove(id)
}

// ── Durable Composio delivery reservation ─────────────────────────────────────

/// How long a verified Composio delivery id stays claimed, counted from receipt.
/// Composio (Svix) re-signs every retry with a fresh `webhook-timestamp` and the
/// same `webhook-id` over a schedule of about 28 hours, so the claim must outlive
/// that schedule, not the 300 s signature window.
pub const COMPOSIO_DELIVERY_RETENTION_SECS: u64 = 72 * 60 * 60;

/// The scope Composio claims use in the host's durable delivery ledger. It
/// contains `/`, which no workflow id can (see [`parse_workflow_webhook_path`]),
/// so it never collides with a workflow reservation.
const COMPOSIO_DELIVERY_SCOPE: &str = WEBHOOK_PATH;

/// Durably claim a verified Composio delivery id, so a sender retry after a
/// Core restart cannot fire its agent and workflow runs a second time.
/// `Ok(false)` means this id was already claimed. Call only after the signature
/// verified, so an unauthenticated id can never poison the ledger.
pub fn reserve_composio_delivery(delivery_id: &str) -> anyhow::Result<bool> {
    let delivery_id = delivery_id.trim();
    anyhow::ensure!(!delivery_id.is_empty(), "composio delivery id is empty");
    let expires_at = u64::try_from(now_unix())
        .unwrap_or(0)
        .saturating_add(COMPOSIO_DELIVERY_RETENTION_SECS);
    host()?.reserve_workflow_delivery(COMPOSIO_DELIVERY_SCOPE, delivery_id, expires_at)
}

/// Drop a Composio claim whose delivery never reached the triggers store, so
/// the sender's retry is dispatched instead of treated as a duplicate.
pub fn release_composio_delivery(delivery_id: &str) -> anyhow::Result<()> {
    host()?.release_workflow_delivery(COMPOSIO_DELIVERY_SCOPE, delivery_id.trim())
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
/// The signed timestamp and delivery id are verified before a durable replay
/// reservation. A run that could not start releases that reservation for a
/// legitimate retry; once the run is seeded the reservation is kept, and a
/// later failure surfaces on the run record instead of re-running side effects.
///
/// On success it records the delivery against [`workflow_webhook_path`] so the
/// registry reflects relay-delivered firings too.
pub async fn deliver_workflow_webhook(
    id: &str,
    raw_body: &[u8],
    headers: crate::InboundWebhookHeaders<'_>,
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
    if !host.verify_workflow_webhook_signature(id, &secret, raw_body, headers) {
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
    let (Some(delivery_id), Some(timestamp)) = (headers.webhook_id, headers.webhook_timestamp)
    else {
        return WorkflowWebhookOutcome::BadSignature;
    };
    let Ok(timestamp) = timestamp.parse::<u64>() else {
        return WorkflowWebhookOutcome::BadSignature;
    };
    match host.reserve_workflow_delivery(id, delivery_id, timestamp.saturating_add(300)) {
        Ok(true) => {}
        Ok(false) => return WorkflowWebhookOutcome::Duplicate,
        Err(error) => return WorkflowWebhookOutcome::RunError(error.to_string()),
    }
    match host.run_workflow_for_trigger(id, body_str).await {
        Ok(run_id) => {
            record_delivery(&workflow_webhook_path(id));
            WorkflowWebhookOutcome::Ran(run_id)
        }
        Err(e) => {
            if let Err(error) = host.release_workflow_delivery(id, delivery_id) {
                tracing::error!(%error, "failed to release workflow webhook retry reservation");
            }
            WorkflowWebhookOutcome::RunError(e.to_string())
        }
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
    headers: crate::InboundWebhookHeaders<'_>,
) -> InboundOutcome {
    if path == WEBHOOK_PATH {
        let Ok(host) = host() else {
            return InboundOutcome::Rejected("webhook-ingress host unavailable".to_owned());
        };
        // Composio: verify the project secret and all signed headers, then hand
        // the parsed body to the composio store.
        if !host.verify_webhook_signature(raw_body, headers) {
            return InboundOutcome::Rejected(
                "composio webhook: invalid or missing signature".to_owned(),
            );
        }
        let Ok(payload) = serde_json::from_slice::<Value>(raw_body) else {
            return InboundOutcome::Rejected("composio webhook: invalid JSON body".to_owned());
        };
        // A verified signature requires the delivery id.
        let Some(delivery_id) = headers.webhook_id else {
            return InboundOutcome::Rejected("composio webhook: missing webhook-id".to_owned());
        };
        // Accounting is idempotent by delivery id, so it precedes the claim.
        if host
            .record_composio_trigger_delivery(delivery_id)
            .await
            .is_err()
        {
            return InboundOutcome::Rejected("composio trigger accounting unavailable".to_owned());
        }
        match reserve_composio_delivery(delivery_id) {
            Ok(true) => {}
            Ok(false) => {
                return InboundOutcome::Delivered {
                    detail: "composio webhook duplicate delivery (already fired)".to_owned(),
                }
            }
            Err(error) => {
                return InboundOutcome::Rejected(format!(
                    "composio delivery reservation unavailable: {error}"
                ))
            }
        }
        return match host.composio_handle_webhook(&payload).await {
            Some(fired) => {
                record_delivery(path);
                InboundOutcome::Delivered {
                    detail: format!("composio webhook fired {fired} run(s)"),
                }
            }
            None => {
                if let Err(error) = release_composio_delivery(delivery_id) {
                    tracing::error!(%error, "failed to release composio delivery reservation");
                }
                InboundOutcome::Rejected("composio triggers store unavailable".to_owned())
            }
        };
    }

    if let Some(id) = parse_workflow_webhook_path(path) {
        return match deliver_workflow_webhook(&id, raw_body, headers).await {
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
            // The signed id already started a run: acknowledge it so a relay
            // replay is not retried.
            WorkflowWebhookOutcome::Duplicate => InboundOutcome::Delivered {
                detail: format!("workflow '{id}': duplicate delivery (already started)"),
            },
        };
    }

    InboundOutcome::Unhandled
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::host::{set_global_host, WebhookIngressHost};
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex, OnceLock};

    fn mock_deliveries() -> &'static Mutex<HashSet<(String, String)>> {
        static DELIVERIES: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
        DELIVERIES.get_or_init(|| Mutex::new(HashSet::new()))
    }

    /// Runs for a workflow id containing `-block` park in the mock's
    /// `run_workflow_for_trigger` until a test adds a permit here, so a test can
    /// hold a run in flight.
    pub(crate) fn block_gate() -> &'static tokio::sync::Semaphore {
        static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
        GATE.get_or_init(|| tokio::sync::Semaphore::new(0))
    }

    /// Notified once per `-block` run as it parks on [`block_gate`].
    pub(crate) fn block_started() -> &'static tokio::sync::Notify {
        static STARTED: OnceLock<tokio::sync::Notify> = OnceLock::new();
        STARTED.get_or_init(tokio::sync::Notify::new)
    }

    fn secret_lookup_counts() -> &'static Mutex<HashMap<String, usize>> {
        static LOOKUPS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
        LOOKUPS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// How many deliveries for `workflow_id` reached the mock host (each one
    /// starts with the secret lookup).
    pub(crate) fn secret_lookups(workflow_id: &str) -> usize {
        secret_lookup_counts()
            .lock()
            .expect("secret lookups")
            .get(workflow_id)
            .copied()
            .unwrap_or(0)
    }

    fn composio_fanout_counts() -> &'static Mutex<HashMap<String, usize>> {
        static FANOUTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
        FANOUTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// How many payloads whose `marker` field is `marker` reached the mock's
    /// Composio fan-out.
    pub(crate) fn composio_fanouts(marker: &str) -> usize {
        composio_fanout_counts()
            .lock()
            .expect("composio fan-outs")
            .get(marker)
            .copied()
            .unwrap_or(0)
    }

    /// A single deterministic mock host installed for the crate test process
    /// (`set_global_host` is a `OnceLock` → one host per process, so behaviour is
    /// keyed purely on inputs). Drives the router's branches without any kernel:
    /// - `workflow_webhook_secret`: keyed on an `-notfound` / `-notrigger` /
    ///   `-nosecret` marker in the id, else a real secret.
    /// - `verify_webhook_signature` (Composio): signature `"good"`, a
    ///   `msg-good…` id, and the fixed timestamp.
    /// - `verify_workflow_webhook_signature`: true iff the signature is `"good"`.
    /// - `composio_handle_webhook`: `None` for a `store_unavailable` payload;
    ///   counts each payload by its `marker` field (see [`composio_fanouts`]).
    /// - `run_workflow_for_trigger`: succeeds with a synthetic run id; an id
    ///   with a `-block` marker first parks on [`block_gate`], and an id with a
    ///   `-startfail` marker fails as if no run could be seeded.
    struct MockHost;

    #[async_trait::async_trait]
    impl WebhookIngressHost for MockHost {
        fn composio_is_configured(&self) -> bool {
            true
        }
        fn has_webhook_trigger(&self) -> bool {
            false
        }
        fn verify_webhook_signature(
            &self,
            _raw_body: &[u8],
            headers: crate::InboundWebhookHeaders<'_>,
        ) -> bool {
            headers.signature == Some("good")
                && headers
                    .webhook_id
                    .is_some_and(|id| id.starts_with("msg-good"))
                && headers.webhook_timestamp == Some("1735689600")
        }
        fn verify_workflow_webhook_signature(
            &self,
            workflow_id: &str,
            _secret: &str,
            _raw_body: &[u8],
            headers: crate::InboundWebhookHeaders<'_>,
        ) -> bool {
            !workflow_id.is_empty()
                && headers.signature == Some("good")
                && headers.webhook_id.is_some()
                && headers.webhook_timestamp.is_some()
        }
        fn reserve_workflow_delivery(
            &self,
            workflow_id: &str,
            delivery_id: &str,
            _expires_at: u64,
        ) -> anyhow::Result<bool> {
            Ok(mock_deliveries()
                .lock()
                .expect("mock deliveries")
                .insert((workflow_id.to_owned(), delivery_id.to_owned())))
        }
        fn release_workflow_delivery(
            &self,
            workflow_id: &str,
            delivery_id: &str,
        ) -> anyhow::Result<()> {
            mock_deliveries()
                .lock()
                .expect("mock deliveries")
                .remove(&(workflow_id.to_owned(), delivery_id.to_owned()));
            Ok(())
        }
        async fn composio_handle_webhook(&self, payload: &Value) -> Option<usize> {
            if let Some(marker) = payload.get("marker").and_then(Value::as_str) {
                *composio_fanout_counts()
                    .lock()
                    .expect("composio fan-outs")
                    .entry(marker.to_owned())
                    .or_default() += 1;
            }
            // A `store_unavailable` payload stands in for an uninitialised store.
            payload.get("store_unavailable").is_none().then_some(1)
        }
        async fn run_workflow_for_trigger(
            &self,
            workflow_id: &str,
            _payload_json: &str,
        ) -> anyhow::Result<String> {
            if workflow_id.contains("-startfail") {
                anyhow::bail!("mock: workflow '{workflow_id}' could not be seeded");
            }
            if workflow_id.contains("-block") {
                block_started().notify_one();
                block_gate().acquire().await?.forget();
            }
            Ok(format!("trigrun_{workflow_id}"))
        }
        fn workflow_webhook_secret(&self, workflow_id: &str) -> WorkflowWebhookSecret {
            *secret_lookup_counts()
                .lock()
                .expect("secret lookups")
                .entry(workflow_id.to_owned())
                .or_default() += 1;
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
    pub(crate) fn ensure_mock_host() {
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
        let outcome = deliver_inbound(
            "/api/does/not/exist",
            b"{}",
            crate::InboundWebhookHeaders::default(),
        )
        .await;
        assert!(matches!(outcome, InboundOutcome::Unhandled));
    }

    #[tokio::test]
    async fn composio_path_requires_all_current_signed_headers() {
        ensure_mock_host();
        let delivery_id = format!("msg-good-{}", uuid::Uuid::new_v4().simple());
        let valid = crate::InboundWebhookHeaders {
            signature: Some("good"),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some("1735689600"),
        };
        let outcome = deliver_inbound(WEBHOOK_PATH, b"{}", valid).await;
        assert!(matches!(outcome, InboundOutcome::Delivered { .. }));

        let missing_id = crate::InboundWebhookHeaders {
            webhook_id: None,
            ..valid
        };
        let outcome = deliver_inbound(WEBHOOK_PATH, b"{}", missing_id).await;
        assert!(matches!(outcome, InboundOutcome::Rejected(_)));
    }

    /// A Composio retry of an id that already fired is acknowledged without a
    /// second fan-out, through the durable host ledger rather than process
    /// memory, so a Core restart cannot re-fire it.
    #[tokio::test]
    async fn composio_duplicate_delivery_is_not_refired() {
        ensure_mock_host();
        let delivery_id = format!("msg-good-{}", uuid::Uuid::new_v4().simple());
        let headers = crate::InboundWebhookHeaders {
            signature: Some("good"),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some("1735689600"),
        };
        match deliver_inbound(WEBHOOK_PATH, b"{}", headers).await {
            InboundOutcome::Delivered { detail } => assert!(detail.contains("fired"), "{detail}"),
            other => panic!("expected the first delivery to fire, got {other:?}"),
        }
        assert!(mock_deliveries()
            .lock()
            .expect("mock deliveries")
            .contains(&(WEBHOOK_PATH.to_owned(), delivery_id.clone())));
        match deliver_inbound(WEBHOOK_PATH, b"{}", headers).await {
            InboundOutcome::Delivered { detail } => {
                assert!(detail.contains("duplicate"), "{detail}");
            }
            other => panic!("expected the retry to be acknowledged as a duplicate, got {other:?}"),
        }
    }

    /// A delivery that never reached the triggers store releases its claim, so
    /// the sender's retry is dispatched rather than swallowed as a duplicate.
    #[tokio::test]
    async fn composio_delivery_without_a_store_releases_its_claim() {
        ensure_mock_host();
        let delivery_id = format!("msg-good-{}", uuid::Uuid::new_v4().simple());
        let headers = crate::InboundWebhookHeaders {
            signature: Some("good"),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some("1735689600"),
        };
        let outcome =
            deliver_inbound(WEBHOOK_PATH, br#"{"store_unavailable":true}"#, headers).await;
        assert!(
            matches!(outcome, InboundOutcome::Rejected(_)),
            "{outcome:?}"
        );
        assert!(!mock_deliveries()
            .lock()
            .expect("mock deliveries")
            .contains(&(WEBHOOK_PATH.to_owned(), delivery_id.clone())));
        let retried = deliver_inbound(WEBHOOK_PATH, b"{}", headers).await;
        assert!(
            matches!(&retried, InboundOutcome::Delivered { detail } if detail.contains("fired")),
            "{retried:?}"
        );
    }

    #[tokio::test]
    async fn workflow_path_with_bad_signature_is_rejected_not_composio() {
        // A workflow path routes to the WORKFLOW arm, not composio: a bad/missing
        // signature yields a workflow-scoped rejection (or NotFound), never the
        // composio "invalid signature" message. This proves the router split.
        ensure_mock_host();
        let id = format!("wf-{}", uuid::Uuid::new_v4().simple());
        let path = workflow_webhook_path(&id);
        let outcome = deliver_inbound(
            &path,
            b"{}",
            crate::InboundWebhookHeaders::signature(Some("deadbeef")),
        )
        .await;
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
        let outcome = deliver_inbound(
            &path,
            body,
            crate::InboundWebhookHeaders {
                signature: Some("good"),
                webhook_id: Some("relay-workflow-1"),
                webhook_timestamp: Some("1735689600"),
            },
        )
        .await;
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
        let rejected = deliver_inbound(
            &path,
            br#"{"event":"tampered"}"#,
            crate::InboundWebhookHeaders::signature(Some("bad")),
        )
        .await;
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
    fn failed_http_delivery_can_be_retried() {
        let id = format!("retry-{}", uuid::Uuid::new_v4().simple());
        assert!(first_http_delivery(&id));
        assert!(forget_http_delivery(&id));
        assert!(first_http_delivery(&id));
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
        let headers = crate::InboundWebhookHeaders {
            signature: Some("good"),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some("1735689600"),
        };
        let first = deliver_workflow_webhook(&id, body, headers).await;
        assert!(matches!(first, WorkflowWebhookOutcome::Ran(_)));

        // Retried delivery: same id → duplicate, no second run.
        let retried = deliver_workflow_webhook(&id, body, headers).await;
        assert!(matches!(retried, WorkflowWebhookOutcome::Duplicate));

        // An unauthenticated forged id never reaches (and so never poisons) the
        // seen-set: a fresh id with a bad signature is rejected, not deduped —
        // and that same id is still usable afterwards for a real delivery.
        let forged_id = format!("dlv-forged-{}", uuid::Uuid::new_v4().simple());
        let forged_headers = crate::InboundWebhookHeaders {
            signature: Some("bad"),
            webhook_id: Some(&forged_id),
            webhook_timestamp: Some("1735689600"),
        };
        let bad = deliver_workflow_webhook(&id, body, forged_headers).await;
        assert!(matches!(bad, WorkflowWebhookOutcome::BadSignature));
        let now_valid = deliver_workflow_webhook(
            &id,
            body,
            crate::InboundWebhookHeaders {
                signature: Some("good"),
                ..forged_headers
            },
        )
        .await;
        assert!(
            matches!(now_valid, WorkflowWebhookOutcome::Ran(_)),
            "a forged-signature attempt must not poison the seen-set for the real id"
        );
    }

    /// A run that could not start (the host's `Err`: no run was seeded) releases
    /// its durable reservation, so the sender's retry of the same id is reserved
    /// again rather than acknowledged as a duplicate and lost. The converse, a
    /// seeded run that later fails keeping its reservation, is covered against
    /// the real host in `apps/core/src/webhook_ingress.rs`.
    #[tokio::test]
    async fn workflow_run_that_cannot_start_releases_its_reservation() {
        ensure_mock_host();

        let id = format!("wf-startfail-{}", uuid::Uuid::new_v4().simple());
        let delivery_id = format!("dlv-{}", uuid::Uuid::new_v4().simple());
        let headers = crate::InboundWebhookHeaders {
            signature: Some("good"),
            webhook_id: Some(&delivery_id),
            webhook_timestamp: Some("1735689600"),
        };
        let reserved = || {
            mock_deliveries()
                .lock()
                .expect("mock deliveries")
                .contains(&(id.clone(), delivery_id.clone()))
        };

        for attempt in ["first delivery", "sender retry"] {
            let outcome = deliver_workflow_webhook(&id, br#"{"event":"x"}"#, headers).await;
            assert!(
                matches!(&outcome, WorkflowWebhookOutcome::RunError(_)),
                "{attempt}: expected RunError, got {outcome:?}"
            );
            assert!(!reserved(), "{attempt}: the reservation must be released");
        }
        assert!(
            last_delivery(&workflow_webhook_path(&id)).is_none(),
            "a run that never started is not recorded as delivered"
        );
    }
}
