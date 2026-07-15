//! RyuRelay managed-push backend (epic #473, P6b / #480).
//!
//! Composio triggers are webhook-delivered, so a Core bound to `127.0.0.1` never
//! receives them. The managed RyuRelay tier bridges that gap with an **outbound**
//! connection (no inbound port needed):
//!
//! ```text
//! Composio ──POST──▶ apps/server  /api/composio-relay/ingress/:token  (public, HMAC)
//!                         │ in-memory fan-out
//!                         ▼
//!     Core ◀──SSE──── apps/server  /api/composio-relay/subscribe  (this loop)
//!       │ in-process
//!       ▼
//!     composio_triggers::global().handle_webhook(&payload)
//! ```
//!
//! On `start()` Core: (1) resolves its auth token + the relay server base, (2)
//! POSTs `/register` to mint/reuse a relay token and learn its public ingress
//! URL (published via [`super::set_public_url`]), then (3) spawns a resilient
//! SSE-client loop (reconnect with capped backoff, `Last-Event-ID` resume) that
//! parses `composio.webhook` frames and dispatches them **in-process** — no
//! loopback POST back to `POST /api/composio/webhook`.
//!
//! Placement (CLAUDE.md §1): opening an outbound subscription + dispatching a
//! received event is *what runs* → Core. The fan-out/auth/HMAC policy lives in
//! `apps/server` (packages/api), the control plane.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::sidecar::download_manager::ryu_dir;

/// Default relay server base (the `apps/server` control plane). Overridable via
/// `RYU_BACKEND_URL` so nothing is hardcoded (CLAUDE.md §1).
const DEFAULT_RELAY_BASE_ENV: &str = "RYU_BACKEND_URL";
const DEFAULT_RELAY_BASE: &str = "http://localhost:3000";

/// Reconnect backoff bounds for the SSE client loop.
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

/// Bound on the in-memory dedup set of recently-dispatched `delivery_id`s. A
/// reconnect resumes from the last cursor; if the cursor is stale (or the relay
/// is at-least-once) the server may replay an already-dispatched delivery, and
/// `composio_triggers::handle_webhook` has no dedup — every call fires a fresh
/// agent run with real side effects. This set is the idempotency backstop.
const SEEN_DELIVERY_CAPACITY: usize = 512;

/// A bounded FIFO set of recently-seen `delivery_id`s. `insert` returns `true`
/// when the id is new (caller should dispatch) and `false` when it has already
/// been seen (caller should skip). Eviction is oldest-first once capacity is hit.
#[derive(Debug, Default)]
pub struct SeenDeliveries {
    order: std::collections::VecDeque<String>,
    set: std::collections::HashSet<String>,
}

impl SeenDeliveries {
    fn new() -> Self {
        Self::default()
    }

    /// Record an id. Returns `true` if it was newly inserted (not seen before).
    /// An empty id is always treated as new (no id to dedup on).
    pub fn insert(&mut self, id: &str) -> bool {
        if id.is_empty() {
            return true;
        }
        if self.set.contains(id) {
            return false;
        }
        self.set.insert(id.to_owned());
        self.order.push_back(id.to_owned());
        while self.order.len() > SEEN_DELIVERY_CAPACITY {
            if let Some(evicted) = self.order.pop_front() {
                self.set.remove(&evicted);
            }
        }
        true
    }
}

/// The persisted-state file under `~/.ryu` (relay token + node name).
fn relay_state_path() -> std::path::PathBuf {
    ryu_dir().join("relay.json")
}

/// A parsed SSE frame from the relay subscribe stream (Contract 5).
#[derive(Debug, Clone, PartialEq)]
pub enum RelayFrame {
    /// A **composio** webhook delivery, already parsed + verified server-side
    /// (trust-relay). Dispatched straight to the composio store, unchanged.
    Webhook { delivery_id: String, payload: Value },
    /// A **generic** inbound delivery to route by `path` (webhook-unify): the
    /// server forwards the original request path, the pre-extracted signature
    /// header, and the *raw* body so Core can re-verify the per-target HMAC and
    /// dispatch to the matching handler (workflow webhook, composio, or a future
    /// channel). This is what makes a per-workflow webhook reachable over the
    /// default RyuRelay ingress, not just composio.
    Inbound {
        delivery_id: String,
        path: String,
        signature: Option<String>,
        body: String,
    },
    /// A keep-alive ping — ignored.
    Ping,
}

/// The on-the-wire JSON shape of a relay frame's `data:` payload.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WireFrame {
    #[serde(rename = "composio.webhook")]
    Webhook {
        #[serde(default)]
        delivery_id: String,
        #[serde(default)]
        payload: Value,
    },
    /// The generic path-routed frame (webhook-unify). `path` is the inbound
    /// request path (e.g. `/api/workflows/<id>/webhook`), `signature` the
    /// pre-extracted signature-header value, `body` the raw request body.
    #[serde(rename = "webhook.inbound")]
    Inbound {
        #[serde(default)]
        delivery_id: String,
        path: String,
        #[serde(default)]
        signature: Option<String>,
        #[serde(default)]
        body: String,
    },
    #[serde(rename = "ping")]
    Ping,
}

/// Parse one SSE `data:` line's JSON into a [`RelayFrame`]. Returns `None` for
/// unrecognized shapes (a webhook frame yields the struct; a ping is kept so the
/// caller can ignore it explicitly — distinct from an unparseable frame).
pub fn parse_frame(data: &str) -> Option<RelayFrame> {
    let wire: WireFrame = serde_json::from_str(data.trim()).ok()?;
    Some(match wire {
        WireFrame::Webhook {
            delivery_id,
            payload,
        } => RelayFrame::Webhook {
            delivery_id,
            payload,
        },
        WireFrame::Inbound {
            delivery_id,
            path,
            signature,
            body,
        } => RelayFrame::Inbound {
            delivery_id,
            path,
            signature,
            body,
        },
        WireFrame::Ping => RelayFrame::Ping,
    })
}

/// The node's stable name: `RYU_NODE_NAME` → hostname → `"default"`.
fn node_name() -> String {
    if let Ok(name) = std::env::var("RYU_NODE_NAME") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    hostname_or_default()
}

fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "default".to_owned())
}

/// The relay server base URL (no trailing slash).
fn relay_base() -> String {
    std::env::var(DEFAULT_RELAY_BASE_ENV)
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_RELAY_BASE.to_owned())
}

/// Persist the relay token (alongside the node name) under `~/.ryu/relay.json`.
/// Best-effort: a write failure is logged, never fatal — the token is also held
/// server-side and re-minted/reused on the next register.
fn persist_relay_token(relay_token: &str, node: &str) {
    let path = relay_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = serde_json::json!({ "relay_token": relay_token, "node_name": node });
    if let Err(e) = std::fs::write(&path, data.to_string()) {
        tracing::warn!("ryu-relay: could not persist relay token ({e})");
    }
}

/// The register response (Contract 5): `{relay_token, public_url}`.
#[derive(Debug, Deserialize)]
struct RegisterResponse {
    relay_token: String,
    public_url: String,
}

/// Read this node's persisted relay token (`~/.ryu/relay.json`), if it has
/// registered with the relay at least once.
fn persisted_relay_token() -> Option<String> {
    let raw = std::fs::read_to_string(relay_state_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("relay_token")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .filter(|t| !t.trim().is_empty())
}

/// The reachable public URL a third party POSTs to so an inbound webhook at
/// `path` reaches THIS node over the RyuRelay ingress:
/// `<relay_base>/api/composio-relay/inbound/<relay_token>/<path>`. `None` until
/// the node has registered with the relay (no persisted token yet). This is how a
/// per-workflow webhook becomes discoverable under the default (RyuRelay) ingress,
/// where there is no path-forwarding origin base.
pub fn relay_inbound_url(path: &str) -> Option<String> {
    let token = persisted_relay_token()?;
    let base = relay_base();
    let trimmed = path.trim_start_matches('/');
    Some(format!("{base}/api/composio-relay/inbound/{token}/{trimmed}"))
}

/// Register this node with the relay server, returning `(relay_token, public_url)`.
async fn register(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    node: &str,
) -> Result<(String, String)> {
    let url = format!("{base}/api/composio-relay/register");
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "node_name": node }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| anyhow!("relay register request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        bail!("relay register {status}");
    }
    let body: RegisterResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("relay register: bad response ({e})"))?;
    Ok((body.relay_token, body.public_url))
}

/// Start the RyuRelay managed-push backend.
///
/// Resolves auth + base, registers (publishing the public URL), and spawns the
/// background SSE-client loop. Returns `Err` when not logged in (so `main.rs`
/// logs a clear "not active" and never spawns a network task without auth — also
/// keeps `cargo test` network-free since it never calls this).
pub async fn start() -> Result<()> {
    // Opt-in by use: RyuRelay is the default ingress, but only actually open the
    // outbound subscription (which routes third-party webhook payloads through
    // Ryu infra) when the user actually uses Composio — i.e. a Composio key is
    // configured. This keeps the data flow effectively opt-in rather than
    // default-on for every install (security MED, P6b).
    if !crate::composio_auth::is_configured() {
        bail!("ryu-relay ingress: no Composio key configured — relay not started (opt-in by use)");
    }
    let token = crate::auth::load_token()
        .ok_or_else(|| anyhow!("ryu-relay ingress: not logged in (no ~/.ryu/auth.json token)"))?;
    let base = relay_base();
    let node = node_name();
    let client = reqwest::Client::new();

    let (relay_token, public_url) = register(&client, &base, &token, &node).await?;
    persist_relay_token(&relay_token, &node);
    super::set_public_url(Some(public_url));

    tokio::spawn(async move {
        subscribe_loop(client, base, token, node).await;
    });
    Ok(())
}

/// The resilient outbound SSE-client loop: connect, stream frames, dispatch
/// webhooks in-process, and reconnect with capped exponential backoff. Resumes
/// via `Last-Event-ID` so a reconnect replays only un-delivered events.
async fn subscribe_loop(client: reqwest::Client, base: String, token: String, node: String) {
    let mut backoff = BACKOFF_START;
    // Cursor + dedup set are owned by the loop so they persist across reconnects.
    // The cursor is advanced *in place* per dispatched frame (see
    // `run_subscription`), so it survives a mid-stream error too — otherwise a
    // dropped connection (the common end-of-stream case) would discard all
    // progress and the server's replay guard would skip un-delivered events,
    // silently losing webhooks (HIGH).
    let mut last_event_id: Option<String> = None;
    let mut seen = SeenDeliveries::new();

    loop {
        if let Err(e) =
            run_subscription(&client, &base, &token, &node, &mut last_event_id, &mut seen).await
        {
            tracing::warn!("ryu-relay: subscription dropped ({e}); retrying in {backoff:?}");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
            continue;
        }
        // Clean EOF (server closed) → reset backoff, keep the (already-advanced)
        // cursor, and reconnect after the base delay.
        backoff = BACKOFF_START;
        tokio::time::sleep(backoff).await;
    }
}

/// Open one SSE subscription and pump frames until the stream ends or errors.
/// Advances `last_event_id` in place after each dispatched frame so the cursor
/// is preserved even when the stream ends via error (not just clean EOF).
async fn run_subscription(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    node: &str,
    last_event_id: &mut Option<String>,
    seen: &mut SeenDeliveries,
) -> Result<()> {
    use futures_util::StreamExt;

    let url = format!("{base}/api/composio-relay/subscribe?node_name={node}");
    let mut req = client
        .get(&url)
        .bearer_auth(token)
        .header("accept", "text/event-stream");
    if let Some(id) = last_event_id.as_deref() {
        req = req.header("last-event-id", id);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("relay subscribe connect failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        bail!("relay subscribe {status}");
    }

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("relay subscribe stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE events are separated by a blank line. Drain complete events.
        while let Some(idx) = buf.find("\n\n") {
            let raw_event: String = buf.drain(..idx + 2).collect();
            if let Some((id, data)) = parse_sse_event(&raw_event) {
                dispatch_frame(&data, seen).await;
                // Advance the cursor AFTER dispatch so a crash mid-dispatch
                // re-delivers (at-least-once); dedup guards the duplicate.
                if let Some(id) = id {
                    *last_event_id = Some(id);
                }
            }
        }
    }
    Ok(())
}

/// Extract `(id, data)` from one raw SSE event block. Concatenates multiple
/// `data:` lines per the SSE spec; ignores comment lines and `event:`.
fn parse_sse_event(raw: &str) -> Option<(Option<String>, String)> {
    let mut id: Option<String> = None;
    let mut data = String::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("id:") {
            id = Some(rest.trim().to_owned());
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if data.is_empty() {
        return None;
    }
    Some((id, data))
}

/// Parse a frame's data and, if it is a webhook, dispatch it in-process to the
/// composio-triggers handler. Pings and unparseable frames are ignored.
/// Deduplicates by `delivery_id` against `seen` so a replayed delivery (after a
/// reconnect / at-least-once relay) never fires the same agent run twice — the
/// handler itself has no idempotency.
async fn dispatch_frame(data: &str, seen: &mut SeenDeliveries) {
    match parse_frame(data) {
        Some(RelayFrame::Webhook {
            delivery_id,
            payload,
        }) => {
            if !seen.insert(&delivery_id) {
                tracing::debug!("ryu-relay: skipping duplicate delivery {delivery_id}");
                return;
            }
            match crate::composio_triggers::global() {
                Some(store) => {
                    let fired = store.handle_webhook(&payload).await;
                    tracing::info!("ryu-relay: dispatched webhook, fired {fired} agent run(s)");
                    // Reflect the relay-delivered firing in the webhook registry.
                    super::record_delivery(super::WEBHOOK_PATH);
                }
                None => tracing::warn!(
                    "ryu-relay: composio-triggers store not initialised; dropping webhook"
                ),
            }
        }
        // The generic path-routed frame (webhook-unify): re-verify + dispatch by
        // path so a per-workflow webhook is reachable over the default relay, not
        // just composio. Dedup by delivery_id first (the relay is at-least-once and
        // the handlers have no idempotency — same HIGH concern as the composio arm).
        Some(RelayFrame::Inbound {
            delivery_id,
            path,
            signature,
            body,
        }) => {
            if !seen.insert(&delivery_id) {
                tracing::debug!("ryu-relay: skipping duplicate delivery {delivery_id}");
                return;
            }
            let outcome =
                super::deliver_inbound(&path, body.as_bytes(), signature.as_deref()).await;
            match outcome {
                super::InboundOutcome::Delivered { detail } => {
                    tracing::info!("ryu-relay: delivered inbound to {path}: {detail}");
                }
                super::InboundOutcome::Rejected(reason) => {
                    tracing::warn!("ryu-relay: rejected inbound to {path}: {reason}");
                }
                super::InboundOutcome::Unhandled => {
                    tracing::warn!("ryu-relay: no handler for inbound path {path}; dropping");
                }
            }
        }
        Some(RelayFrame::Ping) | None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frame_yields_webhook_struct() {
        let data = r#"{"type":"composio.webhook","delivery_id":"dlv-1","payload":{"trigger_slug":"SLACK_MESSAGE"}}"#;
        match parse_frame(data) {
            Some(RelayFrame::Webhook {
                delivery_id,
                payload,
            }) => {
                assert_eq!(delivery_id, "dlv-1");
                assert_eq!(payload["trigger_slug"], "SLACK_MESSAGE");
            }
            other => panic!("expected webhook frame, got {other:?}"),
        }
    }

    #[test]
    fn parse_frame_ignores_ping() {
        assert_eq!(parse_frame(r#"{"type":"ping"}"#), Some(RelayFrame::Ping));
    }

    #[test]
    fn parse_frame_rejects_unknown() {
        assert_eq!(parse_frame(r#"{"type":"other"}"#), None);
        assert_eq!(parse_frame("not json"), None);
    }

    #[test]
    fn parse_sse_event_extracts_id_and_data() {
        let raw = "id: 7\ndata: {\"type\":\"ping\"}\n\n";
        let (id, data) = parse_sse_event(raw).unwrap();
        assert_eq!(id.as_deref(), Some("7"));
        assert_eq!(data, "{\"type\":\"ping\"}");
    }

    #[test]
    fn parse_sse_event_concatenates_multiline_data() {
        let raw = "data: line1\ndata: line2\n\n";
        let (_, data) = parse_sse_event(raw).unwrap();
        assert_eq!(data, "line1\nline2");
    }

    #[test]
    fn parse_sse_event_none_without_data() {
        assert!(parse_sse_event(": comment\n\n").is_none());
    }

    #[test]
    fn node_name_resolves_a_nonempty_string() {
        // Whatever the resolution path, never empty.
        assert!(!node_name().is_empty());
    }

    #[test]
    fn seen_deliveries_dedups_repeats() {
        let mut seen = SeenDeliveries::new();
        assert!(seen.insert("dlv-1"), "first sight is new");
        assert!(!seen.insert("dlv-1"), "second sight is a duplicate");
        assert!(seen.insert("dlv-2"), "a different id is new");
    }

    #[test]
    fn seen_deliveries_empty_id_always_new() {
        // No id to dedup on → never suppress dispatch.
        let mut seen = SeenDeliveries::new();
        assert!(seen.insert(""));
        assert!(seen.insert(""));
    }

    #[test]
    fn seen_deliveries_evicts_oldest_when_full() {
        let mut seen = SeenDeliveries::new();
        for i in 0..SEEN_DELIVERY_CAPACITY {
            assert!(seen.insert(&format!("dlv-{i}")));
        }
        // One more evicts the oldest ("dlv-0").
        assert!(seen.insert("overflow"));
        // The evicted id is now treated as new again.
        assert!(
            seen.insert("dlv-0"),
            "oldest was evicted, so it is new again"
        );
        // A recent id is still deduped.
        assert!(!seen.insert("overflow"));
    }

    #[test]
    fn relay_base_strips_trailing_slash() {
        // Default path (env unset) returns the constant without a trailing slash.
        if std::env::var(DEFAULT_RELAY_BASE_ENV).is_err() {
            assert_eq!(relay_base(), DEFAULT_RELAY_BASE);
            assert!(!relay_base().ends_with('/'));
        }
    }
}
