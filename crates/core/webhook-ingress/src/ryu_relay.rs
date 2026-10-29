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
//! parses `webhook.inbound` frames, re-verifies each one's signature, and
//! dispatches it **in-process** — no loopback POST back to
//! `POST /api/composio/webhook`. The legacy unsigned `composio.webhook` frame is
//! dropped: Core cannot verify it, and the relay stream is untrusted input.
//!
//! Token rotation (`POST /api/composio-relay/rotate`) revokes the old relay token
//! at once and closes its stream. `/subscribe` is scoped to the account and node,
//! not the token, so a plain reconnect would quietly stream from the new token
//! while Core kept advertising the dead URL. The loop therefore re-runs
//! `/register` before it resubscribes whenever the relay ended or dropped an
//! open stream, or refused the subscription with `409` (the lookup raced a
//! rotation) or `404` (the node is no longer registered). A changed
//! registration is persisted to `relay.json`, replaces the advertised public URL,
//! and is handed to the host so Core can re-point the destinations it manages.
//! Other refusals (`401`, `429`, `5xx`) and network failures only back off.
//! The loop also re-reads the signed-in bearer before every attempt and on each
//! ping, so a sign-out pauses it and a re-login or account switch registers
//! again under the current account.
//!
//! Placement (CLAUDE.md §1): opening an outbound subscription + dispatching a
//! received event is *what runs* → Core. The fan-out/auth/HMAC policy lives in
//! `apps/server` (packages/api), the control plane.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use reqwest::StatusCode;
use serde::Deserialize;
use tokio::sync::Semaphore;

use super::host::{host, host_opt};

/// Process-global "the relay subscription is live" guard. Claimed once (via
/// `compare_exchange`) before register so the boot start and any later on-save
/// re-start converge on a single outbound subscription — never a double-register
/// or a second SSE loop. Reset to `false` if register fails, so a later save can
/// retry (the node was not actually started).
static RELAY_STARTED: AtomicBool = AtomicBool::new(false);

/// Whether the RyuRelay outbound subscription should open, given the two
/// explicit-use signals. Pure so the gate is unit-testable without network.
///
/// P6b privacy posture: the relay routes third-party webhook payloads through
/// Ryu infra, so it stays **opt-in by use** — it opens when the user actually
/// uses Composio (a key is configured) OR has created a workflow `Webhook`
/// trigger (which is unreachable on a laptop until Core registers with the
/// relay). It is never "always on when logged in".
pub fn relay_gate_open(composio_configured: bool, has_webhook_trigger: bool) -> bool {
    composio_configured || has_webhook_trigger
}

/// The env var naming the relay server base (the `apps/server` control plane).
///
/// There is deliberately no implicit default. Core sends the signed-in account
/// bearer to this base and trusts the registration it returns, so an implicit
/// `http://localhost:3000` would hand the session token to whatever local
/// process holds that port. The relay starts only when this is set explicitly or
/// the host reports the backend the account signed in to
/// ([`WebhookIngressHost::backend_url`]).
const RELAY_BASE_ENV: &str = "RYU_BACKEND_URL";

/// Reconnect backoff bounds for the SSE client loop.
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

/// An open subscription counts as healthy once it carried an event or stayed open
/// this long. The relay pings every ~20 s, so a working stream proves itself
/// sooner; a stream the relay closes at once is a failed attempt and backs off.
const STABLE_STREAM_AFTER: Duration = Duration::from_secs(30);

/// Retry timing for the subscription loop. A struct (not bare constants) so the
/// loop tests run with millisecond delays against a mock relay.
#[derive(Debug, Clone, Copy)]
struct RetryTiming {
    start: Duration,
    max: Duration,
    stable_after: Duration,
}

impl RetryTiming {
    const DEFAULT: RetryTiming = RetryTiming {
        start: BACKOFF_START,
        max: BACKOFF_MAX,
        stable_after: STABLE_STREAM_AFTER,
    };
}

/// Capped exponential backoff shared by registration and subscription attempts.
/// Every attempt that does not end in a healthy stream doubles the next delay; a
/// healthy stream resets it. Re-registration therefore never runs faster than
/// the reconnects it precedes, even when the relay keeps refusing or closing.
#[derive(Debug)]
struct Backoff {
    timing: RetryTiming,
    next: Duration,
}

impl Backoff {
    fn new(timing: RetryTiming) -> Self {
        Self {
            timing,
            next: timing.start,
        }
    }

    /// The delay after a healthy stream ended: back to the starting delay.
    fn after_healthy_stream(&mut self) -> Duration {
        self.next = self.timing.start;
        self.next
    }

    /// The delay after a failed attempt. Doubles the following delay, up to the cap.
    fn after_failure(&mut self) -> Duration {
        let delay = self.next;
        self.next = (self.next * 2).min(self.timing.max);
        delay
    }
}

/// The relay sends a `ping` frame every 20 s. With no bytes for this long the
/// connection is presumed half-open (sleep/wake, NAT rebinding, silent proxy
/// drop) and is torn down so the loop reconnects; otherwise `stream.next()`
/// would wait forever and webhooks would silently stop arriving.
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(75);
/// Bound on TCP/TLS connect for register + subscribe.
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Bound on the in-memory dedup set of recently-dispatched `delivery_id`s. A
/// reconnect resumes from the last cursor; if the cursor is stale (or the relay
/// is at-least-once) the server may replay an already-dispatched delivery, and
/// `composio_triggers::handle_webhook` has no dedup — every call fires a fresh
/// agent run with real side effects. This set is the idempotency backstop.
const SEEN_DELIVERY_CAPACITY: usize = 512;

/// Max relay frames delivered at once. A frame can await a whole workflow or
/// agent run, so delivery runs off the SSE read loop: one slow run must not stop
/// the loop from reading every other webhook on the node (or from noticing a
/// dead connection through [`RELAY_IDLE_TIMEOUT`]).
const RELAY_DISPATCH_CONCURRENCY: usize = 4;
/// Max frames handed off but not yet finished (running plus waiting for a
/// slot). Past this the read loop waits for one to finish, so a backlog of slow
/// runs applies backpressure instead of holding webhook bodies without bound.
const RELAY_MAX_PENDING: usize = 64;

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

    pub fn remove(&mut self, id: &str) -> bool {
        if id.is_empty() || !self.set.remove(id) {
            return false;
        }
        self.order.retain(|existing| existing != id);
        true
    }
}

/// The persisted-state file `<data dir>/state/relay.json` (relay token + node name). `None` when
/// no host is installed (the data dir comes from the host), so the file ops
/// degrade to best-effort no-ops rather than panicking.
fn relay_state_path() -> Option<std::path::PathBuf> {
    Some(ryu_sidecar_runtime::layout::state_path(
        &host_opt()?.data_dir(),
        "relay.json",
    ))
}

/// A parsed SSE frame from the relay subscribe stream (Contract 5).
#[derive(Debug, Clone, PartialEq)]
pub enum RelayFrame {
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
        webhook_id: Option<String>,
        webhook_timestamp: Option<String>,
        body: String,
    },
    /// A keep-alive ping — ignored.
    Ping,
}

/// The on-the-wire JSON shape of a relay frame's `data:` payload.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WireFrame {
    /// The legacy `composio.webhook` frame. It carried an already-parsed payload
    /// and no signature, so Core cannot verify it came from Composio. It is
    /// recognised only so [`parse_frame`] can drop it with a warning; its fields
    /// are ignored and never reach a handler.
    #[serde(rename = "composio.webhook")]
    LegacyComposioWebhook {},
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
        webhook_id: Option<String>,
        #[serde(default)]
        webhook_timestamp: Option<String>,
        #[serde(default)]
        body: String,
    },
    #[serde(rename = "ping")]
    Ping,
}

/// Parse one SSE `data:` line's JSON into a [`RelayFrame`]. Returns `None` for
/// unrecognized shapes and for the unsigned legacy `composio.webhook` frame (an
/// inbound frame yields the struct; a ping is kept so the caller can ignore it
/// explicitly — distinct from an unparseable frame).
pub fn parse_frame(data: &str) -> Option<RelayFrame> {
    let wire: WireFrame = serde_json::from_str(data.trim()).ok()?;
    Some(match wire {
        WireFrame::LegacyComposioWebhook {} => {
            tracing::warn!(
                "ryu-relay: dropping an unsigned legacy composio.webhook frame; only signed webhook.inbound frames are delivered"
            );
            return None;
        }
        WireFrame::Inbound {
            delivery_id,
            path,
            signature,
            webhook_id,
            webhook_timestamp,
            body,
        } => RelayFrame::Inbound {
            delivery_id,
            path,
            signature,
            webhook_id,
            webhook_timestamp,
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

/// The relay server base URL (no trailing slash): [`RELAY_BASE_ENV`] when set,
/// else the backend the host reports (the one this account signed in to). `None`
/// when neither names one.
fn relay_base() -> Option<String> {
    let host_url = host_opt().and_then(|host| host.backend_url());
    resolve_relay_base(
        std::env::var(RELAY_BASE_ENV).ok().as_deref(),
        host_url.as_deref(),
    )
}

/// The relay server this node would register with, or `None` when no relay base
/// is configured. Lets Core refuse the managed-relay selection (and say why)
/// instead of reporting a relay that can never start.
pub fn relay_server_base() -> Option<String> {
    relay_base()
}

/// The environment value wins; the host's backend is the fallback.
fn resolve_relay_base(env: Option<&str>, host_backend: Option<&str>) -> Option<String> {
    relay_base_from(env).or_else(|| relay_base_from(host_backend))
}

/// Resolve the relay base from the raw [`RELAY_BASE_ENV`] value: trimmed, without
/// a trailing slash, and `None` when unset or blank. It never falls back to a
/// local listener, so the account bearer only goes to a relay the operator named.
fn relay_base_from(raw: Option<&str>) -> Option<String> {
    raw.map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

/// Persist the relay token (alongside the node name) in `<data dir>/state/relay.json`.
/// The whole JSON body is sealed with the master key (`enc:v1:`) and written
/// atomically, owner-only. Best-effort: a write failure (including no key, in
/// which case nothing is written rather than plaintext) is logged, never fatal;
/// the token is also held server-side and re-minted/reused on the next register.
fn persist_relay_token(relay_token: &str, node: &str) {
    let Some(path) = relay_state_path() else {
        tracing::warn!("ryu-relay: no host/data-dir; could not persist relay token");
        return;
    };
    let persisted = ryu_crypto::global_cipher()
        .and_then(|cipher| persist_relay_token_at(&path, relay_token, node, &cipher));
    if let Err(e) = persisted {
        tracing::warn!("ryu-relay: could not persist relay token ({e:#})");
    }
}

fn persist_relay_token_at(
    path: &Path,
    relay_token: &str,
    node: &str,
    sealer: &dyn ryu_crypto::SecretSealer,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::json!({ "relay_token": relay_token, "node_name": node });
    ryu_crypto::write_secret_file(path, &data.to_string(), sealer)
}

/// This node's registration with the relay — the register response (Contract 5):
/// `{relay_token, public_url}`. `Debug` redacts both fields because the token is a
/// routing secret and the public URL embeds it.
#[derive(Clone, PartialEq, Eq, Deserialize)]
struct Registration {
    relay_token: String,
    public_url: String,
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("relay_token", &"<redacted>")
            .field("public_url", &"<redacted>")
            .finish()
    }
}

/// Read this node's persisted relay token (`<data dir>/state/relay.json`), if it
/// has registered with the relay at least once. A file an older build wrote in
/// plaintext is read and sealed in place.
fn persisted_relay_token() -> Option<String> {
    let path = relay_state_path()?;
    let cipher = ryu_crypto::global_cipher()
        .map_err(|e| tracing::warn!("ryu-relay: no key to open relay.json ({e:#})"))
        .ok();
    persisted_relay_token_at(
        &path,
        cipher.as_ref().map(|c| c as &dyn ryu_crypto::SecretSealer),
    )
}

fn persisted_relay_token_at(
    path: &Path,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> Option<String> {
    let opened = match ryu_crypto::read_secret_file(path, sealer) {
        Ok(opened) => opened?,
        Err(e) => {
            tracing::warn!("ryu-relay: cannot read relay.json ({e:#})");
            return None;
        }
    };
    if opened.needs_reseal {
        if let Some(sealer) = sealer {
            if let Err(e) = ryu_crypto::write_secret_file(path, &opened.value, sealer) {
                tracing::warn!("ryu-relay: could not seal relay.json in place ({e:#})");
            }
        }
    }
    let v: serde_json::Value = serde_json::from_str(&opened.value).ok()?;
    v.get("relay_token")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .filter(|t| !t.trim().is_empty())
}

/// The reachable public URL a third party POSTs to so an inbound webhook at
/// `path` reaches THIS node over the RyuRelay ingress:
/// `<relay_base>/api/composio-relay/inbound/<relay_token>/<path>`. `None` until
/// the node has registered with the relay (no persisted token yet), or while no
/// relay base is configured (see [`relay_base`]). This is how a
/// per-workflow webhook becomes discoverable under the default (RyuRelay) ingress,
/// where there is no path-forwarding origin base.
pub fn relay_inbound_url(path: &str) -> Option<String> {
    let token = persisted_relay_token()?;
    let base = relay_base()?;
    let trimmed = path.trim_start_matches('/');
    Some(format!(
        "{base}/api/composio-relay/inbound/{token}/{trimmed}"
    ))
}

/// The relay control-plane endpoints and the credentials Core uses with them.
/// `/register` and `/subscribe` are scoped to the authenticated account and the
/// node name, never to the relay token, so a rotation needs no new credential:
/// registering again simply returns the node's current token.
struct RelayEndpoint {
    http: reqwest::Client,
    base: String,
    /// The bearer the current registration was made under.
    auth_token: String,
    node: String,
    /// Reads the bearer the node is signed in with now (`None` when signed
    /// out); [`current_auth_token`] outside tests.
    current_auth: fn() -> Option<String>,
}

/// How one subscription attempt ended. Decides whether the next attempt
/// re-registers first and how long the loop waits before it.
#[derive(Debug)]
enum SubscriptionEnd {
    /// The stream opened and later ended: the relay closed it (a clean EOF, which
    /// is how a rotation ends the old token's stream) or the connection dropped
    /// mid-stream (`error`). `healthy` is true when the stream carried an event
    /// or stayed open for the `stable_after` retry timing.
    Ended {
        healthy: bool,
        error: Option<anyhow::Error>,
    },
    /// The relay refused the subscription for this node's token: `409` (the
    /// token was rotated while the relay looked it up) or `404` (the node is no
    /// longer registered).
    TokenRefused(StatusCode),
    /// Any other refusal (`401`, `429`, `5xx`, …) or an unreachable relay. Not
    /// about the token, so the loop backs off without re-registering.
    Failed(anyhow::Error),
}

impl SubscriptionEnd {
    /// Whether the next attempt must re-register first. An ended stream may have
    /// been closed by a rotation, and a reconnect after any drop could land on a
    /// token rotated meanwhile, so both re-validate the registration. Unrelated
    /// failures never do: they cannot have changed the token.
    fn needs_registration(&self) -> bool {
        matches!(
            self,
            SubscriptionEnd::Ended { .. } | SubscriptionEnd::TokenRefused(_)
        )
    }
}

/// The `/subscribe` statuses that mean "this node's relay token is gone":
/// `409 relay token was rotated; reconnect` and `404 relay node not registered`.
fn subscription_refused_for_token(status: StatusCode) -> bool {
    status == StatusCode::CONFLICT || status == StatusCode::NOT_FOUND
}

impl RelayEndpoint {
    /// Register this node with the relay server (the same call Core makes at
    /// startup). Returns the node's current token and public ingress URL.
    async fn register(&self) -> Result<Registration> {
        let url = format!("{}/api/composio-relay/register", self.base);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.auth_token)
            .json(&serde_json::json!({ "node_name": self.node }))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| anyhow!("relay register request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            bail!("relay register {status}");
        }
        resp.json()
            .await
            .map_err(|e| anyhow!("relay register: bad response ({e})"))
    }

    /// Open one SSE subscription and pump frames until the stream ends or errors.
    /// Advances `last_event_id` in place after each handed-off frame so the
    /// cursor is preserved even when the stream ends via error (not just clean
    /// EOF).
    async fn subscribe_once(
        &self,
        last_event_id: &mut Option<String>,
        dispatcher: &RelayDispatcher,
        stable_after: Duration,
    ) -> SubscriptionEnd {
        let url = format!(
            "{}/api/composio-relay/subscribe?node_name={}",
            self.base, self.node
        );
        let mut req = self
            .http
            .get(&url)
            .bearer_auth(&self.auth_token)
            .header("accept", "text/event-stream");
        if let Some(id) = last_event_id.as_deref() {
            req = req.header("last-event-id", id);
        }
        let resp = match tokio::time::timeout(RELAY_IDLE_TIMEOUT, req.send()).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(e)) => {
                return SubscriptionEnd::Failed(anyhow!("relay subscribe connect failed: {e}"))
            }
            Err(_) => {
                return SubscriptionEnd::Failed(anyhow!(
                    "relay subscribe timed out waiting for response headers"
                ))
            }
        };
        let status = resp.status();
        if subscription_refused_for_token(status) {
            return SubscriptionEnd::TokenRefused(status);
        }
        if !status.is_success() {
            return SubscriptionEnd::Failed(anyhow!("relay subscribe {status}"));
        }

        let opened = Instant::now();
        let mut events = 0_usize;
        let error = pump_events(
            resp,
            last_event_id,
            dispatcher,
            &mut events,
            &self.auth_token,
            self.current_auth,
        )
        .await
        .err();
        SubscriptionEnd::Ended {
            healthy: events > 0 || opened.elapsed() >= stable_after,
            error,
        }
    }
}

/// Start the RyuRelay managed-push backend.
///
/// Resolves auth + base, registers (publishing the public URL), and spawns the
/// background SSE-client loop. Returns `Err` when not logged in or when no relay
/// server is configured ([`RELAY_BASE_ENV`] unset), so `main.rs` logs a clear
/// "not active" and never spawns a network task without auth or a named relay —
/// also keeps `cargo test` network-free since it never calls this.
pub async fn start() -> Result<()> {
    // Opt-in by use (P6b): open the outbound subscription only when the user
    // actually uses Composio (a key is configured) OR has a workflow `Webhook`
    // trigger (unreachable on a laptop until Core registers with the relay). The
    // gate stays explicit-use, never default-on for every install (security MED).
    let host = host()?;
    if !relay_gate_open(host.composio_is_configured(), host.has_webhook_trigger()) {
        bail!(
            "ryu-relay ingress: no Composio key and no workflow webhook trigger — \
             relay not started (opt-in by use)"
        );
    }
    // Resolve the relay server before the bearer is read or anything is sent:
    // the token goes only to a relay the operator named, never an implicit default.
    let base = relay_base().ok_or_else(|| {
        anyhow!(
            "ryu-relay ingress: no Ryu server URL is known; relay not started \
             (sign in, or set {RELAY_BASE_ENV} to the Ryu server URL)"
        )
    })?;
    let token = host
        .auth_token()
        .ok_or_else(|| anyhow!("ryu-relay ingress: not logged in (no ~/.ryu/auth.json token)"))?;

    // Claim the single-subscription slot before any network work. If it is
    // already claimed (boot start, or a prior on-save start), this call is a
    // no-op — the live subscription already serves every workflow webhook.
    if RELAY_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let http = match reqwest::Client::builder()
        .connect_timeout(RELAY_CONNECT_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            RELAY_STARTED.store(false, Ordering::SeqCst);
            return Err(anyhow!("ryu-relay: could not build HTTP client: {e}"));
        }
    };
    let endpoint = RelayEndpoint {
        http,
        base,
        auth_token: token,
        node: node_name(),
        current_auth: current_auth_token,
    };
    let registration = match endpoint.register().await {
        Ok(registration) => registration,
        Err(e) => {
            // Register failed → the node is not started; release the slot so a
            // later save (or retry) can attempt the subscription again.
            RELAY_STARTED.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    persist_relay_token(&registration.relay_token, &endpoint.node);
    super::set_public_url(Some(registration.public_url.clone()));

    tokio::spawn(async move {
        let node = endpoint.node.clone();
        subscribe_loop(
            endpoint,
            registration,
            RetryTiming::DEFAULT,
            move |previous, current| publish_registration(&node, previous, current),
        )
        .await;
    });
    Ok(())
}

/// Idempotently ensure the RyuRelay subscription is live (register + SSE loop).
///
/// Called from the workflow save path when a saved workflow declares a `Webhook`
/// trigger, so `relay_inbound_url()` resolves and the subscription opens **without
/// a Core restart** for a trigger created after boot. A no-op when the
/// subscription is already live (the [`RELAY_STARTED`] guard inside [`start`]).
pub async fn ensure_relay_started() -> Result<()> {
    start().await
}

/// Publish a registration that changed after startup (the relay token was
/// rotated): persist the token so [`relay_inbound_url`] composes the live URL,
/// swap the advertised public URL, and let the host re-point what it registered
/// with the old one. The advertised URL is replaced only while it is still the
/// relay's previous URL, so the loop never overwrites a URL another backend
/// published.
fn publish_registration(node: &str, previous: &Registration, current: &Registration) {
    persist_relay_token(&current.relay_token, node);
    if !super::replace_public_url(&previous.public_url, &current.public_url) {
        tracing::info!(
            "ryu-relay: relay token changed, but another ingress URL is advertised; leaving it"
        );
        return;
    }
    tracing::info!("ryu-relay: relay token changed; advertising the new public URL");
    if let Some(host) = host_opt() {
        let public_url = current.public_url.clone();
        tokio::spawn(async move {
            host.relay_public_url_changed(&public_url).await;
        });
    }
}

/// Whether the loop must register again before subscribing: the signed-in
/// bearer is not the one the current registration was made under (sign-out and
/// back in, or an account switch), or the last attempt asked for it (see
/// [`SubscriptionEnd::needs_registration`]).
fn should_reregister(current: &str, registered: &str, refused: bool) -> bool {
    refused || current != registered
}

/// The bearer the node is signed in with right now (`None` when signed out).
fn current_auth_token() -> Option<String> {
    host_opt().and_then(|host| host.auth_token())
}

/// The resilient outbound SSE-client loop: connect, stream frames, dispatch
/// webhooks in-process, and reconnect with capped exponential backoff. Resumes
/// via `Last-Event-ID` so a reconnect replays only un-delivered events.
///
/// Before resubscribing after an ended stream or a token refusal (see
/// [`SubscriptionEnd::needs_registration`]) the loop registers again and hands a
/// changed registration to `on_change(previous, current)`. A failed
/// re-registration backs off and retries the registration, not the subscription.
///
/// The bearer is re-read before every attempt rather than frozen at start, so
/// a sign-out, re-login, or account switch re-registers under the current
/// account instead of retrying a stale credential until Core restarts. While
/// signed out the loop sends nothing and waits for a sign-in.
async fn subscribe_loop<F>(
    mut relay: RelayEndpoint,
    mut registration: Registration,
    timing: RetryTiming,
    mut on_change: F,
) where
    F: FnMut(&Registration, &Registration),
{
    let mut backoff = Backoff::new(timing);
    // Cursor + dispatcher are owned by the loop so they persist across reconnects
    // and re-registrations: a rotated token continues the old event-id sequence,
    // so the cursor stays valid on the new token. The cursor is advanced *in
    // place* per handed-off frame (see `subscribe_once`), so it survives a
    // mid-stream error too — otherwise a dropped connection (the common
    // end-of-stream case) would discard all progress and the server's replay
    // guard would skip un-delivered events, silently losing webhooks (HIGH).
    let mut last_event_id: Option<String> = None;
    let dispatcher = RelayDispatcher::new();
    let mut must_register = false;
    let mut account_changed = false;
    let mut signed_out = false;

    loop {
        let Some(bearer) = (relay.current_auth)() else {
            if !signed_out {
                tracing::info!("ryu-relay: signed out; relay subscription paused until sign-in");
                signed_out = true;
            }
            tokio::time::sleep(backoff.after_failure()).await;
            continue;
        };
        signed_out = false;
        if bearer != relay.auth_token {
            account_changed = true;
        }
        must_register = should_reregister(&bearer, &relay.auth_token, must_register);
        relay.auth_token = bearer;

        // A failed registration `continue`s with the flag still set, so the
        // subscription below only opens on a registration that was confirmed.
        if must_register {
            match relay.register().await {
                Ok(current) => {
                    if current != registration {
                        if account_changed && current.relay_token != registration.relay_token {
                            // Another account's relay token is another channel;
                            // a cursor from this one would skip its events.
                            last_event_id = None;
                        }
                        on_change(&registration, &current);
                        registration = current;
                    }
                    account_changed = false;
                }
                Err(e) => {
                    let delay = backoff.after_failure();
                    tracing::warn!(
                        "ryu-relay: re-registration failed ({e}); retrying in {delay:?}"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }
        }

        let end = relay
            .subscribe_once(&mut last_event_id, &dispatcher, timing.stable_after)
            .await;
        must_register = end.needs_registration();
        let delay = match &end {
            SubscriptionEnd::Ended { healthy: true, .. } => backoff.after_healthy_stream(),
            _ => backoff.after_failure(),
        };
        match end {
            SubscriptionEnd::Ended { error: None, .. } => tracing::info!(
                "ryu-relay: relay closed the subscription; registering again in {delay:?}"
            ),
            SubscriptionEnd::Ended { error: Some(e), .. } => tracing::warn!(
                "ryu-relay: subscription dropped ({e}); registering again in {delay:?}"
            ),
            SubscriptionEnd::TokenRefused(status) => tracing::info!(
                "ryu-relay: relay refused the subscription ({status}); registering again in {delay:?}"
            ),
            SubscriptionEnd::Failed(e) => {
                tracing::warn!("ryu-relay: subscription failed ({e}); retrying in {delay:?}");
            }
        }
        tokio::time::sleep(delay).await;
    }
}

/// Pump an open SSE response: drain complete events, hand each frame to the
/// [`RelayDispatcher`] rather than awaiting it here (so a long workflow or
/// agent run never stops this loop from reading), and advance `last_event_id`
/// once the frame is handed off. `events` counts parsed events so the caller
/// can tell a working stream from one the relay closed at once. Returns early,
/// as a closed stream, when a ping shows the signed-in bearer is no longer
/// `bearer`.
async fn pump_events(
    resp: reqwest::Response,
    last_event_id: &mut Option<String>,
    dispatcher: &RelayDispatcher,
    events: &mut usize,
    bearer: &str,
    current_auth: fn() -> Option<String>,
) -> Result<()> {
    use futures_util::StreamExt;

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = tokio::time::timeout(RELAY_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| anyhow!("relay subscribe idle for {RELAY_IDLE_TIMEOUT:?} (missed pings)"))?
    {
        let chunk = chunk.map_err(|e| anyhow!("relay subscribe stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE events are separated by a blank line. Drain complete events.
        while let Some(idx) = buf.find("\n\n") {
            let raw_event: String = buf.drain(..idx + 2).collect();
            let Some((id, data)) = parse_sse_event(&raw_event) else {
                continue;
            };
            *events += 1;
            match parse_frame(&data) {
                Some(RelayFrame::Ping) => {
                    // The relay pings every 20 s. Use it to notice a sign-out or
                    // account switch without waiting for this stream to drop, so
                    // the node never keeps consuming the previous account's relay.
                    if current_auth().as_deref() != Some(bearer) {
                        tracing::info!("ryu-relay: signed-in account changed; resubscribing");
                        return Ok(());
                    }
                }
                Some(frame) => {
                    let _ = dispatcher.spawn(frame).await;
                }
                None => {}
            }
            // Advance the cursor once the frame is handed off. Delivery tasks
            // outlive this stream, the dedup claim skips a replay that races an
            // in-flight copy, and a signed workflow or Composio delivery is also
            // durably reserved by its delivery id.
            if let Some(id) = id {
                *last_event_id = Some(id);
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

/// Lock the dedup set, recovering from a poisoned lock (the set stays usable).
fn lock_seen(seen: &Mutex<SeenDeliveries>) -> MutexGuard<'_, SeenDeliveries> {
    seen.lock().unwrap_or_else(|error| error.into_inner())
}

/// Delivers relay frames on background tasks so the SSE read loop never waits
/// on a run. Owned by [`subscribe_loop`], so the dedup set and both bounds
/// survive reconnects, and an in-flight delivery keeps its claim across one.
#[derive(Clone)]
struct RelayDispatcher {
    seen: Arc<Mutex<SeenDeliveries>>,
    /// Delivery slots ([`RELAY_DISPATCH_CONCURRENCY`]).
    running: Arc<Semaphore>,
    /// Handed-off frames not yet finished ([`RELAY_MAX_PENDING`]).
    pending: Arc<Semaphore>,
}

impl RelayDispatcher {
    fn new() -> Self {
        Self {
            seen: Arc::new(Mutex::new(SeenDeliveries::new())),
            running: Arc::new(Semaphore::new(RELAY_DISPATCH_CONCURRENCY)),
            pending: Arc::new(Semaphore::new(RELAY_MAX_PENDING)),
        }
    }

    /// Hand one frame to a background delivery task. Waits only while
    /// [`RELAY_MAX_PENDING`] frames are already outstanding; the delivery slot
    /// is taken inside the task, so long runs never block the caller.
    async fn spawn(&self, frame: RelayFrame) -> Option<tokio::task::JoinHandle<()>> {
        if matches!(frame, RelayFrame::Ping) {
            return None;
        }
        let queued = Arc::clone(&self.pending).acquire_owned().await.ok()?;
        let running = Arc::clone(&self.running);
        let seen = Arc::clone(&self.seen);
        Some(tokio::spawn(async move {
            let _queued = queued;
            let Ok(_slot) = running.acquire_owned().await else {
                return;
            };
            process_frame(frame, &seen).await;
        }))
    }
}

/// Deliver one frame, deduplicating by `delivery_id` so a replayed delivery
/// (after a reconnect / at-least-once relay) never fires the same agent run
/// twice — the composio handler itself has no idempotency.
///
/// The id is claimed before delivery, so a replay that arrives while the first
/// copy is still running is skipped, and released again unless a handler
/// accepted the frame, so a forged, rejected, or failed attempt never suppresses
/// a later legitimate retry. The claim is taken only once a delivery slot is
/// held, which limits how long an unverified frame can hold an id to the
/// signature check itself.
async fn process_frame(frame: RelayFrame, seen: &Mutex<SeenDeliveries>) {
    let delivery_id = match &frame {
        RelayFrame::Inbound { delivery_id, .. } => delivery_id.clone(),
        RelayFrame::Ping => return,
    };
    let claimed = lock_seen(seen).insert(&delivery_id);
    if !claimed {
        tracing::debug!("ryu-relay: skipping duplicate delivery {delivery_id}");
        return;
    }
    if !deliver_frame(frame).await {
        lock_seen(seen).remove(&delivery_id);
    }
}

/// Deliver one frame in-process. Returns `true` only when a handler accepted
/// it; every other path (host missing, accounting unavailable, store not
/// initialised, rejected or unhandled inbound) returns `false`.
async fn deliver_frame(frame: RelayFrame) -> bool {
    match frame {
        // The generic path-routed frame (webhook-unify): re-verify + dispatch by
        // path so a per-workflow webhook is reachable over the default relay, not
        // just composio.
        RelayFrame::Inbound {
            path,
            signature,
            webhook_id,
            webhook_timestamp,
            body,
            ..
        } => {
            let outcome = super::deliver_inbound(
                &path,
                body.as_bytes(),
                crate::InboundWebhookHeaders {
                    signature: signature.as_deref(),
                    webhook_id: webhook_id.as_deref(),
                    webhook_timestamp: webhook_timestamp.as_deref(),
                },
            )
            .await;
            match outcome {
                super::InboundOutcome::Delivered { detail } => {
                    tracing::info!("ryu-relay: delivered inbound to {path}: {detail}");
                    true
                }
                super::InboundOutcome::Rejected(reason) => {
                    tracing::warn!("ryu-relay: rejected inbound to {path}: {reason}");
                    false
                }
                super::InboundOutcome::Unhandled => {
                    tracing::warn!("ryu-relay: no handler for inbound path {path}; dropping");
                    false
                }
            }
        }
        RelayFrame::Ping => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The legacy `composio.webhook` frame carries an already-parsed payload and
    /// no signature, so Core cannot tell it came from Composio. It is dropped,
    /// so whoever serves the relay stream cannot use it to fire triggers.
    #[test]
    fn parse_frame_drops_unsigned_legacy_composio_frame() {
        let data = r#"{"type":"composio.webhook","delivery_id":"dlv-1","payload":{"trigger_slug":"SLACK_MESSAGE"}}"#;
        assert_eq!(parse_frame(data), None);
        assert_eq!(
            parse_frame(r#"{"type":"composio.webhook"}"#),
            None,
            "a legacy frame without a payload is dropped too"
        );
    }

    /// Through the relay read path (`parse_frame`, then the dispatcher, as
    /// `pump_events` does): an unsigned legacy frame never reaches the Composio
    /// fan-out, while the same payload in a signed `webhook.inbound` frame does.
    #[tokio::test]
    async fn unsigned_legacy_composio_frame_never_fires_triggers() {
        use crate::dispatch::tests::{composio_fanouts, ensure_mock_host};
        ensure_mock_host();
        let dispatcher = RelayDispatcher::new();
        let marker = format!("legacy-{}", uuid::Uuid::new_v4().simple());
        let payload = serde_json::json!({ "trigger_slug": "SLACK_MESSAGE", "marker": marker });

        let legacy = serde_json::json!({
            "type": "composio.webhook",
            "delivery_id": format!("dlv-{marker}"),
            "payload": payload,
        });
        if let Some(frame) = parse_frame(&legacy.to_string()) {
            if let Some(task) = dispatcher.spawn(frame).await {
                task.await.expect("legacy delivery task");
            }
        }
        assert_eq!(
            composio_fanouts(&marker),
            0,
            "an unsigned legacy frame must not fire Composio triggers"
        );

        // The mock host accepts signature `good` with a `msg-good…` id.
        let delivery_id = format!("msg-good-{}", uuid::Uuid::new_v4().simple());
        let signed = RelayFrame::Inbound {
            delivery_id: delivery_id.clone(),
            path: crate::WEBHOOK_PATH.to_owned(),
            signature: Some("good".to_owned()),
            webhook_id: Some(delivery_id),
            webhook_timestamp: Some("1735689600".to_owned()),
            body: payload.to_string(),
        };
        dispatcher
            .spawn(signed)
            .await
            .expect("signed frame dispatched")
            .await
            .expect("signed delivery task");
        assert_eq!(
            composio_fanouts(&marker),
            1,
            "a signed inbound frame still reaches the Composio fan-out"
        );
    }

    #[test]
    fn parse_frame_preserves_composio_signed_headers() {
        let data = r#"{"type":"webhook.inbound","delivery_id":"msg_1","path":"/api/composio/webhook","signature":"v1,signed","webhook_id":"msg_1","webhook_timestamp":"1735689600","body":"{}"}"#;
        match parse_frame(data) {
            Some(RelayFrame::Inbound {
                delivery_id,
                path,
                signature,
                webhook_id,
                webhook_timestamp,
                body,
            }) => {
                assert_eq!(delivery_id, "msg_1");
                assert_eq!(path, "/api/composio/webhook");
                assert_eq!(signature.as_deref(), Some("v1,signed"));
                assert_eq!(webhook_id.as_deref(), Some("msg_1"));
                assert_eq!(webhook_timestamp.as_deref(), Some("1735689600"));
                assert_eq!(body, "{}");
            }
            other => panic!("expected inbound frame, got {other:?}"),
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
    fn seen_deliveries_can_release_a_failed_attempt() {
        let mut seen = SeenDeliveries::new();
        assert!(seen.insert("dlv-retry"));
        assert!(seen.remove("dlv-retry"));
        assert!(seen.insert("dlv-retry"), "released delivery can retry");
    }

    #[tokio::test]
    async fn rejected_inbound_does_not_poison_delivery_dedup() {
        let delivery_id = format!("forged-{}", uuid::Uuid::new_v4().simple());
        let frame = serde_json::json!({
            "type": "webhook.inbound",
            "delivery_id": delivery_id,
            "path": "/api/not-a-webhook",
            "signature": "forged",
            "body": "{}"
        });
        let seen = Mutex::new(SeenDeliveries::new());

        process_frame(
            parse_frame(&frame.to_string()).expect("inbound frame"),
            &seen,
        )
        .await;

        assert!(
            !lock_seen(&seen).set.contains(&delivery_id),
            "an unauthenticated or unhandled frame must not reserve its delivery id"
        );
    }

    /// A signed `webhook.inbound` frame for a workflow webhook (the shared mock
    /// host in `dispatch::tests` accepts signature `good`).
    fn workflow_frame(workflow_id: &str, delivery_id: &str) -> RelayFrame {
        RelayFrame::Inbound {
            delivery_id: delivery_id.to_owned(),
            path: crate::workflow_webhook_path(workflow_id),
            signature: Some("good".to_owned()),
            webhook_id: Some(delivery_id.to_owned()),
            webhook_timestamp: Some("1735689600".to_owned()),
            body: "{}".to_owned(),
        }
    }

    /// A slow run must not stall the relay: delivery happens off the read loop,
    /// so a frame for another workflow completes while the first run is still in
    /// flight, and a replay of the in-flight delivery is skipped without reaching
    /// the host. The claim is kept once the slow delivery finally succeeds.
    #[tokio::test]
    async fn slow_run_does_not_stall_other_frames_and_inflight_replay_is_skipped() {
        use crate::dispatch::tests::{block_gate, block_started, ensure_mock_host, secret_lookups};
        ensure_mock_host();
        let wait = Duration::from_secs(2);
        let dispatcher = RelayDispatcher::new();

        let slow_workflow = format!("wf-block-{}", uuid::Uuid::new_v4().simple());
        let slow_delivery = format!("dlv-slow-{}", uuid::Uuid::new_v4().simple());
        let slow = workflow_frame(&slow_workflow, &slow_delivery);
        let slow_task = dispatcher
            .spawn(slow.clone())
            .await
            .expect("slow frame dispatched");
        tokio::time::timeout(wait, block_started().notified())
            .await
            .expect("the slow run starts and parks in the host");

        let fast_workflow = format!("wf-fast-{}", uuid::Uuid::new_v4().simple());
        let fast_delivery = format!("dlv-fast-{}", uuid::Uuid::new_v4().simple());
        let fast_task = dispatcher
            .spawn(workflow_frame(&fast_workflow, &fast_delivery))
            .await
            .expect("fast frame dispatched");
        tokio::time::timeout(wait, fast_task)
            .await
            .expect("another webhook is not blocked behind the slow run")
            .expect("fast delivery task");
        assert!(lock_seen(&dispatcher.seen).set.contains(&fast_delivery));

        let replay_task = dispatcher.spawn(slow).await.expect("replay dispatched");
        tokio::time::timeout(wait, replay_task)
            .await
            .expect("an in-flight replay is skipped, not queued behind the run")
            .expect("replay task");
        assert_eq!(
            secret_lookups(&slow_workflow),
            1,
            "the replayed delivery must not reach the host while the first copy runs"
        );

        block_gate().add_permits(1);
        tokio::time::timeout(wait, slow_task)
            .await
            .expect("the slow run finishes once released")
            .expect("slow delivery task");
        assert!(
            lock_seen(&dispatcher.seen).set.contains(&slow_delivery),
            "a delivered frame keeps its claim so later replays stay deduplicated"
        );
    }

    #[test]
    fn reregisters_after_an_account_change_or_a_refusal() {
        // Same bearer, accepted last time: keep the current registration.
        assert!(!should_reregister("tok-a", "tok-a", false));
        // Signed out and back in, or switched accounts: a new bearer.
        assert!(should_reregister("tok-b", "tok-a", false));
        // The last attempt asked for it (a token refusal or an ended stream).
        assert!(should_reregister("tok-a", "tok-a", true));
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
    fn relay_gate_opens_for_webhook_trigger_only() {
        // Composio-less node with a workflow webhook trigger: the gate opens (the
        // fix for a laptop webhook that was previously unreachable under RyuRelay).
        assert!(relay_gate_open(false, true));
        // Composio-only still opens (the legacy path).
        assert!(relay_gate_open(true, false));
        assert!(relay_gate_open(true, true));
        // Neither signal → stays closed (opt-in by use, never default-on).
        assert!(!relay_gate_open(false, false));
    }

    #[test]
    fn relay_base_has_no_implicit_default() {
        // Unset or blank never resolves to a local listener: the old
        // `http://localhost:3000` default sent the account bearer to whatever
        // process held that port.
        for raw in [None, Some(""), Some("   "), Some("/")] {
            assert_eq!(relay_base_from(raw), None, "{raw:?}");
        }
        if std::env::var_os(RELAY_BASE_ENV).is_none() {
            assert_eq!(relay_base(), None);
        }
    }

    #[test]
    fn relay_base_prefers_the_environment_then_the_signed_in_backend() {
        assert_eq!(
            resolve_relay_base(Some("https://env.example/"), Some("https://host.example")),
            Some("https://env.example".to_owned())
        );
        assert_eq!(
            resolve_relay_base(None, Some(" https://host.example/ ")),
            Some("https://host.example".to_owned())
        );
        assert_eq!(
            resolve_relay_base(Some("  "), Some("https://host.example")),
            Some("https://host.example".to_owned())
        );
        // Neither names a server: still no implicit default.
        assert_eq!(resolve_relay_base(None, None), None);
        assert_eq!(resolve_relay_base(Some(""), Some("/")), None);
    }

    #[test]
    fn relay_base_keeps_an_explicit_value_without_trailing_slash() {
        for (raw, want) in [
            (" https://api.example.com/ ", "https://api.example.com"),
            (
                "https://api.example.com/ryu/",
                "https://api.example.com/ryu",
            ),
            ("http://localhost:3000/", "http://localhost:3000"),
            ("http://server:3000", "http://server:3000"),
        ] {
            assert_eq!(relay_base_from(Some(raw)).as_deref(), Some(want), "{raw}");
        }
    }

    // ── Re-registration after token rotation (mock relay) ────────────────────
    //
    // A loopback mock answers a scripted sequence of raw HTTP responses, one per
    // connection, and records every request. The loop runs with millisecond
    // backoff on a spawned task that each test aborts once the script is served.

    use std::io::{Read as _, Write as _};
    use std::sync::{Arc, Mutex, PoisonError};

    const TEST_TIMING: RetryTiming = RetryTiming {
        start: Duration::from_millis(5),
        max: Duration::from_millis(40),
        stable_after: Duration::from_secs(30),
    };

    type Recorded = Arc<Mutex<Vec<String>>>;
    type Changes = Arc<Mutex<Vec<(Registration, Registration)>>>;

    fn spawn_relay_mock(responses: Vec<String>) -> (String, Recorded) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base = format!("http://{}", listener.local_addr().expect("mock address"));
        let requests: Recorded = Arc::default();
        let recorded = Arc::clone(&requests);
        std::thread::spawn(move || {
            for (response, stream) in responses.into_iter().zip(listener.incoming()) {
                let Ok(mut stream) = stream else { break };
                let request = read_request(&mut stream);
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(request);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (base, requests)
    }

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut request = Vec::new();
        let mut chunk = [0_u8; 2048];
        while !request_complete(&request) {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => request.extend_from_slice(&chunk[..read]),
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn request_complete(request: &[u8]) -> bool {
        let text = String::from_utf8_lossy(request);
        let Some(header_end) = text.find("\r\n\r\n") else {
            return false;
        };
        let body_length = text[..header_end]
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        request.len() >= header_end + 4 + body_length
    }

    fn json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn registered(token: &str) -> String {
        json_response(
            "200 OK",
            &format!(
                r#"{{"relay_token":"{token}","public_url":"{}"}}"#,
                url_for(token)
            ),
        )
    }

    /// An SSE stream the relay ends cleanly after `events` — how a rotation
    /// closes the old token's stream.
    fn closed_stream(events: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{events}",
            events.len()
        )
    }

    /// An SSE stream whose connection drops mid-message (a chunked body with no
    /// terminating chunk), as a network failure would.
    fn dropped_stream(events: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{events}\r\n",
            events.len()
        )
    }

    fn url_for(token: &str) -> String {
        format!("https://relay.example/api/composio-relay/inbound/{token}/api/composio/webhook")
    }

    fn registration(token: &str) -> Registration {
        Registration {
            relay_token: token.to_owned(),
            public_url: url_for(token),
        }
    }

    fn endpoint(base: String) -> RelayEndpoint {
        RelayEndpoint {
            http: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("test client"),
            base,
            auth_token: "session-token".to_owned(),
            node: "laptop".to_owned(),
            current_auth: || Some("session-token".to_owned()),
        }
    }

    /// Run the loop from `initial` until the mock has recorded `count` requests,
    /// then stop it. Returns the recorded requests and registration changes.
    async fn run_loop_until(
        responses: Vec<String>,
        initial: &str,
        count: usize,
    ) -> (Vec<String>, Vec<(Registration, Registration)>) {
        let (base, requests) = spawn_relay_mock(responses);
        let changes: Changes = Arc::default();
        let sink = Arc::clone(&changes);
        let task = tokio::spawn(subscribe_loop(
            endpoint(base),
            registration(initial),
            TEST_TIMING,
            move |previous, current| {
                sink.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push((previous.clone(), current.clone()));
            },
        ));
        let deadline = Instant::now() + Duration::from_secs(10);
        while requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
            < count
        {
            assert!(
                Instant::now() < deadline,
                "the loop did not make {count} requests in time"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        task.abort();
        let requests = requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let changes = changes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        (requests, changes)
    }

    fn is_subscribe(request: &str) -> bool {
        request.starts_with("GET /api/composio-relay/subscribe?node_name=laptop ")
    }

    fn is_register(request: &str) -> bool {
        request.starts_with("POST /api/composio-relay/register ")
    }

    fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
        request.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    #[tokio::test]
    async fn rotation_close_re_registers_then_resumes_from_the_cursor() {
        let (requests, changes) = run_loop_until(
            vec![
                // Stream on the old token: one event, then the relay closes it.
                closed_stream("id: 7\ndata: {\"type\":\"ping\"}\n\n"),
                registered("tok-new"),
                closed_stream(""),
            ],
            "tok-old",
            3,
        )
        .await;

        assert!(is_subscribe(&requests[0]));
        assert!(header(&requests[0], "last-event-id").is_none());
        assert!(
            is_register(&requests[1]),
            "re-registers before resubscribing"
        );
        assert_eq!(
            header(&requests[1], "authorization"),
            Some("Bearer session-token")
        );
        assert!(requests[1].ends_with(r#"{"node_name":"laptop"}"#));
        assert!(is_subscribe(&requests[2]));
        assert_eq!(
            header(&requests[2], "last-event-id"),
            Some("7"),
            "the cursor carries over to the new token"
        );

        assert_eq!(changes.len(), 1, "the new registration is published once");
        let (previous, current) = &changes[0];
        assert_eq!(previous.relay_token, "tok-old");
        assert_eq!(current.relay_token, "tok-new");
        assert_eq!(current.public_url, url_for("tok-new"));
    }

    #[tokio::test]
    async fn token_refusals_re_register_before_resubscribing() {
        for (status, body) in [
            (
                "409 Conflict",
                r#"{"message":"relay token was rotated; reconnect"}"#,
            ),
            (
                "404 Not Found",
                r#"{"message":"relay node not registered (call /register first)"}"#,
            ),
        ] {
            let (requests, changes) = run_loop_until(
                vec![
                    json_response(status, body),
                    registered("tok-new"),
                    closed_stream(""),
                ],
                "tok-old",
                3,
            )
            .await;

            assert!(is_subscribe(&requests[0]), "{status}");
            assert!(is_register(&requests[1]), "{status} re-registers");
            assert!(is_subscribe(&requests[2]), "{status}");
            assert_eq!(changes.len(), 1, "{status}");
            assert_eq!(changes[0].1.relay_token, "tok-new", "{status}");
        }
    }

    #[tokio::test]
    async fn dropped_stream_re_validates_without_republishing_an_unchanged_token() {
        let (requests, changes) = run_loop_until(
            vec![
                dropped_stream("id: 3\ndata: {\"type\":\"ping\"}\n\n"),
                // The token was not rotated while the stream was down.
                registered("tok-same"),
                closed_stream(""),
            ],
            "tok-same",
            3,
        )
        .await;

        assert!(is_subscribe(&requests[0]));
        assert!(is_register(&requests[1]), "a dropped stream re-validates");
        assert!(is_subscribe(&requests[2]));
        assert_eq!(header(&requests[2], "last-event-id"), Some("3"));
        assert!(
            changes.is_empty(),
            "an unchanged registration is not republished"
        );
    }

    #[tokio::test]
    async fn unrelated_refusals_back_off_without_re_registering() {
        let (requests, changes) = run_loop_until(
            vec![
                json_response("503 Service Unavailable", "{}"),
                json_response("401 Unauthorized", r#"{"message":"Unauthorized"}"#),
                json_response("429 Too Many Requests", "{}"),
                json_response("500 Internal Server Error", "{}"),
            ],
            "tok-old",
            4,
        )
        .await;

        assert!(
            requests.iter().all(|request| is_subscribe(request)),
            "401/429/5xx only retry the subscription: {requests:?}"
        );
        assert!(changes.is_empty());
    }

    #[tokio::test]
    async fn failed_re_registration_retries_registration_before_subscribing() {
        let (requests, changes) = run_loop_until(
            vec![
                closed_stream("data: {\"type\":\"ping\"}\n\n"),
                json_response("502 Bad Gateway", "{}"),
                registered("tok-new"),
                closed_stream(""),
            ],
            "tok-old",
            4,
        )
        .await;

        assert!(is_subscribe(&requests[0]));
        assert!(is_register(&requests[1]));
        assert!(
            is_register(&requests[2]),
            "a failed registration is retried before resubscribing"
        );
        assert!(is_subscribe(&requests[3]));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].1.relay_token, "tok-new");
    }

    #[test]
    fn only_token_refusals_and_ended_streams_need_registration() {
        for status in [StatusCode::CONFLICT, StatusCode::NOT_FOUND] {
            assert!(subscription_refused_for_token(status), "{status}");
            assert!(SubscriptionEnd::TokenRefused(status).needs_registration());
        }
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert!(!subscription_refused_for_token(status), "{status}");
        }
        assert!(!SubscriptionEnd::Failed(anyhow!("relay subscribe 503")).needs_registration());
        assert!(SubscriptionEnd::Ended {
            healthy: true,
            error: None
        }
        .needs_registration());
        assert!(SubscriptionEnd::Ended {
            healthy: false,
            error: Some(anyhow!("stream error"))
        }
        .needs_registration());
    }

    #[test]
    fn backoff_doubles_on_failure_and_resets_after_a_healthy_stream() {
        let mut backoff = Backoff::new(RetryTiming {
            start: Duration::from_secs(1),
            max: Duration::from_secs(8),
            stable_after: STABLE_STREAM_AFTER,
        });
        let delays: Vec<u64> = (0..5).map(|_| backoff.after_failure().as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 8, 8], "capped exponential");
        assert_eq!(backoff.after_healthy_stream(), Duration::from_secs(1));
        assert_eq!(
            backoff.after_failure(),
            Duration::from_secs(1),
            "a healthy stream restarts the backoff"
        );
    }

    #[test]
    fn registration_debug_redacts_the_token_and_url() {
        let rendered = format!("{:?}", registration("tok-secret"));
        assert!(!rendered.contains("tok-secret"), "{rendered}");
    }

    fn relay_test_cipher() -> ryu_crypto::FieldCipher {
        ryu_crypto::FieldCipher::new(&[0x2d; 32])
    }

    #[test]
    fn persisted_token_round_trips_sealed_and_is_replaced() {
        let dir = std::env::temp_dir().join(format!("ryu-relay-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("relay.json");
        let cipher = relay_test_cipher();
        persist_relay_token_at(&path, "tok-old-5b1f", "laptop", &cipher).expect("persist");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.starts_with("enc:v1:") && !raw.contains("tok-old-5b1f"),
            "{raw}"
        );
        assert_eq!(
            persisted_relay_token_at(&path, Some(&cipher)).as_deref(),
            Some("tok-old-5b1f")
        );
        persist_relay_token_at(&path, "tok-new", "laptop", &cipher).expect("persist rotated");
        assert_eq!(
            persisted_relay_token_at(&path, Some(&cipher)).as_deref(),
            Some("tok-new")
        );
        // A sealed file never reads without the key (and never as plaintext).
        assert_eq!(persisted_relay_token_at(&path, None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_plaintext_relay_file_is_read_and_sealed_in_place() {
        let dir = std::env::temp_dir().join(format!("ryu-relay-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("relay.json");
        std::fs::write(
            &path,
            r#"{"relay_token":"tok-legacy-9c2e","node_name":"laptop"}"#,
        )
        .unwrap();
        let cipher = relay_test_cipher();
        assert_eq!(
            persisted_relay_token_at(&path, Some(&cipher)).as_deref(),
            Some("tok-legacy-9c2e")
        );
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.starts_with("enc:v1:") && !raw.contains("tok-legacy-9c2e"),
            "{raw}"
        );
        assert_eq!(
            persisted_relay_token_at(&path, Some(&cipher)).as_deref(),
            Some("tok-legacy-9c2e")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
