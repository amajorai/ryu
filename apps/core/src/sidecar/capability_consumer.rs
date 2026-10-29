//! **Core-as-consumer** capability calls: the generic replacement for per-app
//! loopback client shims (`docs/app-boundary-extraction-plan.md` §3 step 1).
//!
//! A sidecar invokes an app-provided capability through the broker
//! (`POST /api/host/capability/:cap`, [`crate::sidecar::ext_proxy`]). Core sometimes
//! needs the SAME thing from inside the kernel — the `@team` chat path reads a team,
//! `agent_builder.create_agent_team` creates one — and used to do it with a typed
//! client per app that hard-coded the app id, its sidecar name and its route.
//! [`CapabilityConsumer::call_capability`] replaces all of that with one call that
//! names only a capability:
//!
//! 1. resolve the bound provider over the **enabled** manifest set through
//!    [`crate::plugins::binding::BindingRegistry`] (same ladder, same overrides, same
//!    `Unprovided` / `Ambiguous` refusals as the broker);
//! 2. pin the provider's `provides[].sidecar` + `route` with
//!    [`crate::sidecar::ext_proxy::resolve_provider_route`];
//! 3. wake a lazy provider and gate on the manager's live registration
//!    ([`crate::sidecar::ext_proxy::provider_target`]);
//! 4. POST through the ext-proxy's own hop
//!    ([`crate::sidecar::ext_proxy::post_to_provider`]), which stamps the PROVIDER's
//!    minted ext token.
//!
//! Nothing here names an app, a port, or a route: those all come from the bound
//! provider's manifest. Core is the kernel, so it holds no grant and declares no
//! `requires` edge — the broker's caller-side checks (declared edge, held grant)
//! exist to constrain *sidecars*, not the host that enforces them.
//!
//! Three shapes of reply share that one resolution + hop:
//!
//! - [`CapabilityConsumer::call_capability`]: a JSON reply (the common case);
//! - [`CapabilityConsumer::call_capability_raw`]: the reply's status, headers and
//!   raw bytes, for a capability whose contract is a non-JSON body (an image, a file);
//! - [`CapabilityConsumer::subscribe_capability`]: a long-lived Server-Sent Events
//!   reply, parsed into [`CapabilityEvent`]s as frames arrive.
//!
//! A subscription never reconnects by itself. It ends when the provider closes the
//! stream (a restart, a crash, an upgrade) and the CALLER decides whether and when to
//! subscribe again. Each new subscription re-resolves the binding, so a provider that
//! was disabled, swapped, or re-registered on a new port in the meantime is picked up.
//!
//! Failure posture: every refusal is a typed [`CapabilityCallError`] so a hot path
//! (chat, agent building) can fail open with a precise message when the providing
//! app is disabled or not installed.

use std::collections::{HashSet, VecDeque};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Bytes;
use axum::response::Response;
use futures_util::stream::{BoxStream, Stream, StreamExt};
use serde_json::Value;

use crate::plugin_manifest::PluginManifest;
use crate::plugins::PluginStore;
use crate::sidecar::ext_proxy::{
    post_to_provider, provider_target, resolve_provider_route, ProviderRoute,
};
use crate::sidecar::manager::ActivityGuard;
use crate::sidecar::SidecarManager;

/// Upper bound on a provider's buffered reply. Capability replies are small records
/// (or one rendered image); a provider streaming an unbounded body back into the
/// kernel is refused rather than buffered. Streams use
/// [`CapabilityConsumer::subscribe_capability`] instead.
const MAX_REPLY_BYTES: usize = 10 * 1024 * 1024;

/// Upper bound on the error body read from a provider that refused a subscription.
const MAX_REFUSAL_BYTES: usize = 64 * 1024;

/// Upper bound on one buffered, not-yet-terminated event-stream line, so a provider
/// that never sends a newline cannot grow the kernel's buffer without limit.
const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;

/// Why a Core-originated capability call did not produce a provider reply.
#[derive(Debug)]
pub enum CapabilityCallError {
    /// No enabled app is bound to the capability (none provides it, two strict
    /// providers are ambiguous, or an override names a non-provider). `code` is the
    /// [`crate::plugins::binding::BindingError::code`] the broker would also return.
    Unbound {
        capability: String,
        code: &'static str,
        reason: String,
    },
    /// The bound provider serves the capability in-process (no sidecar route), so
    /// there is nothing to POST to.
    NotProxyable { capability: String },
    /// The provider's sidecar is not registered, not running, or failed to wake.
    Unavailable { capability: String, reason: String },
    /// Reading the plugin store or the provider reply failed.
    Failed { capability: String, reason: String },
}

impl std::fmt::Display for CapabilityCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unbound {
                capability, reason, ..
            } => write!(f, "capability '{capability}' is not bound: {reason}"),
            Self::NotProxyable { capability } => {
                write!(
                    f,
                    "capability '{capability}' is not served by a sidecar route"
                )
            }
            Self::Unavailable { capability, reason } => {
                write!(
                    f,
                    "capability '{capability}' provider is unavailable: {reason}"
                )
            }
            Self::Failed { capability, reason } => {
                write!(f, "capability '{capability}' call failed: {reason}")
            }
        }
    }
}

impl std::error::Error for CapabilityCallError {}

/// The provider's reply: its HTTP status and JSON body (`Value::Null` when the body
/// was empty or not JSON). Non-2xx statuses are returned, not raised, because their
/// meaning (a 404 "no such record", a 400 validation error) is the capability's
/// contract, not a transport failure.
#[derive(Debug, Clone)]
pub struct CapabilityReply {
    pub status: u16,
    pub body: Value,
}

impl CapabilityReply {
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The provider's reply with its body left as bytes, for a capability whose contract
/// is not JSON (a rendered image, a file). Same status rule as [`CapabilityReply`].
#[derive(Debug, Clone)]
pub struct CapabilityRawReply {
    pub status: u16,
    pub headers: axum::http::HeaderMap,
    pub body: Bytes,
}

impl CapabilityRawReply {
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// A response header as text, when present and valid UTF-8.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// One Server-Sent Events frame from a streaming capability. `event` and `id` are
/// the frame's `event:` / `id:` fields when the provider sent them; `data` is the
/// frame's `data:` lines joined with `\n`. Comment lines (`:` keep-alives) never
/// produce an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityEvent {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
}

/// A live subscription to a streaming capability: a [`Stream`] of
/// [`CapabilityEvent`]s that ends when the provider closes the stream.
///
/// A transport failure mid-stream (the provider crashed or restarted) yields one
/// `Err(CapabilityCallError::Failed)` and then ends; a clean close just ends. Either
/// way the caller decides whether to call
/// [`CapabilityConsumer::subscribe_capability`] again. Dropping the stream closes
/// the connection to the provider. For a lazily started provider the stream also
/// holds its activity guard, so an idle-stop sidecar is not reaped while subscribed.
pub struct CapabilityEventStream {
    events: BoxStream<'static, Result<CapabilityEvent, CapabilityCallError>>,
    _activity: Option<ActivityGuard>,
}

impl Stream for CapabilityEventStream {
    type Item = Result<CapabilityEvent, CapabilityCallError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.events.poll_next_unpin(cx)
    }
}

impl std::fmt::Debug for CapabilityEventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapabilityEventStream")
            .finish_non_exhaustive()
    }
}

/// Incremental parser for the `text/event-stream` format, following the WHATWG
/// EventSource rules Core needs: `data:` lines accumulate, a blank line dispatches,
/// `event:` / `id:` annotate the frame, `:` comments and unknown fields are ignored,
/// and one leading space after the colon is stripped. Bytes are buffered until a
/// full line arrives, so a frame (or a UTF-8 sequence) split across chunks parses
/// whole.
#[derive(Debug, Default)]
struct SseParser {
    line: Vec<u8>,
    data: String,
    has_data: bool,
    event: Option<String>,
    id: Option<String>,
}

impl SseParser {
    /// Feed one chunk; returns the frames it completed, in order.
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<CapabilityEvent>, String> {
        let mut out = Vec::new();
        for &byte in chunk {
            if byte != b'\n' {
                if self.line.len() >= MAX_SSE_LINE_BYTES {
                    return Err(format!(
                        "an event-stream line exceeded {MAX_SSE_LINE_BYTES} bytes"
                    ));
                }
                self.line.push(byte);
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(event) = self.line_done(&String::from_utf8_lossy(&line)) {
                out.push(event);
            }
        }
        Ok(out)
    }

    fn line_done(&mut self, line: &str) -> Option<CapabilityEvent> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event = Some(value.to_owned()),
            "id" => self.id = Some(value.to_owned()),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<CapabilityEvent> {
        let event = self.event.take();
        if !std::mem::take(&mut self.has_data) {
            return None;
        }
        Some(CapabilityEvent {
            event,
            id: self.id.clone(),
            data: std::mem::take(&mut self.data),
        })
    }
}

/// Unfold state behind [`CapabilityEventStream`].
struct SseState {
    capability: String,
    chunks: axum::body::BodyDataStream,
    parser: SseParser,
    pending: VecDeque<CapabilityEvent>,
    done: bool,
}

/// Parse a provider's streamed body into events: every completed frame in order,
/// then at most one `Err` if the transport broke, then the end of the stream.
fn sse_events(
    capability: String,
    chunks: axum::body::BodyDataStream,
) -> BoxStream<'static, Result<CapabilityEvent, CapabilityCallError>> {
    let state = SseState {
        capability,
        chunks,
        parser: SseParser::default(),
        pending: VecDeque::new(),
        done: false,
    };
    futures_util::stream::unfold(state, |mut st| async move {
        loop {
            if let Some(event) = st.pending.pop_front() {
                return Some((Ok(event), st));
            }
            if st.done {
                return None;
            }
            let failure = match st.chunks.next().await {
                Some(Ok(bytes)) => match st.parser.push(&bytes) {
                    Ok(events) => {
                        st.pending.extend(events);
                        continue;
                    }
                    Err(reason) => reason,
                },
                Some(Err(e)) => format!("provider stream broke: {e}"),
                // A clean close. A trailing frame with no blank line is incomplete
                // and, per the event-stream rules, discarded.
                None => {
                    st.done = true;
                    continue;
                }
            };
            st.done = true;
            let err = CapabilityCallError::Failed {
                capability: st.capability.clone(),
                reason: failure,
            };
            return Some((Err(err), st));
        }
    })
    .boxed()
}

/// The process-global consumer, for Core callers that run without `ServerState`
/// (the state-free scheduler's app-backed job targets and their reconcile loops).
static GLOBAL: std::sync::OnceLock<CapabilityConsumer> = std::sync::OnceLock::new();

/// Publish the process-global consumer. Set once from `main.rs`; first write wins.
pub fn install_global(consumer: CapabilityConsumer) {
    let _ = GLOBAL.set(consumer);
}

/// The process-global consumer, or `None` before `main.rs` has installed it (unit
/// tests, early boot). Callers treat `None` exactly like an unbound capability.
pub fn global() -> Option<&'static CapabilityConsumer> {
    GLOBAL.get()
}

/// Core's handle for invoking app-provided capabilities. Cheap to clone: every field
/// is an `Arc` (or `Arc`-backed) view of state `ServerState` already owns.
#[derive(Clone)]
pub struct CapabilityConsumer {
    manager: Arc<SidecarManager>,
    manifests: Arc<tokio::sync::RwLock<Vec<PluginManifest>>>,
    store: PluginStore,
}

impl CapabilityConsumer {
    #[must_use]
    pub fn new(
        manager: Arc<SidecarManager>,
        manifests: Arc<tokio::sync::RwLock<Vec<PluginManifest>>>,
        store: PluginStore,
    ) -> Self {
        Self {
            manager,
            manifests,
            store,
        }
    }

    /// Build from the server state's own manager, manifest set, and plugin store.
    #[must_use]
    pub fn from_state(state: &crate::server::ServerState) -> Self {
        Self::new(
            Arc::clone(&state.manager),
            Arc::clone(&state.app_manifests),
            state.app_store.clone(),
        )
    }

    /// Invoke `cap` on its bound provider with a JSON `body` and return the reply.
    ///
    /// # Errors
    /// See [`CapabilityCallError`]; every variant is a refusal Core can report or
    /// swallow, never a panic.
    pub async fn call_capability(
        &self,
        cap: &str,
        body: &Value,
    ) -> Result<CapabilityReply, CapabilityCallError> {
        let raw = self.call_capability_raw(cap, body).await?;
        let body = serde_json::from_slice(&raw.body).unwrap_or(Value::Null);
        Ok(CapabilityReply {
            status: raw.status,
            body,
        })
    }

    /// Invoke `cap` and return the reply's status, headers and raw body bytes, for a
    /// capability whose reply is not JSON. Bounded like [`Self::call_capability`].
    ///
    /// # Errors
    /// See [`CapabilityCallError`].
    pub async fn call_capability_raw(
        &self,
        cap: &str,
        body: &Value,
    ) -> Result<CapabilityRawReply, CapabilityCallError> {
        let (response, _activity) = self.open(cap, body).await?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), MAX_REPLY_BYTES)
            .await
            .map_err(|e| CapabilityCallError::Failed {
                capability: cap.to_owned(),
                reason: format!("reading provider reply: {e}"),
            })?;
        Ok(CapabilityRawReply {
            status,
            headers,
            body,
        })
    }

    /// Open a Server-Sent Events subscription to `cap` on its bound provider.
    ///
    /// The request is the same POST (same binding, same registration gate, same
    /// provider token) as [`Self::call_capability`]; the reply is consumed as it
    /// arrives instead of buffered. A non-2xx reply is a
    /// [`CapabilityCallError::Failed`] carrying the provider's status. The returned
    /// stream ends when the provider closes it; reconnecting is the caller's policy.
    ///
    /// # Errors
    /// See [`CapabilityCallError`].
    pub async fn subscribe_capability(
        &self,
        cap: &str,
        body: &Value,
    ) -> Result<CapabilityEventStream, CapabilityCallError> {
        let (response, activity) = self.open(cap, body).await?;
        let status = response.status();
        if !status.is_success() {
            let bytes = axum::body::to_bytes(response.into_body(), MAX_REFUSAL_BYTES)
                .await
                .unwrap_or_default();
            let detail = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_owned))
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_owned());
            return Err(CapabilityCallError::Failed {
                capability: cap.to_owned(),
                reason: format!("provider answered HTTP {}: {detail}", status.as_u16()),
            });
        }
        Ok(CapabilityEventStream {
            events: sse_events(cap.to_owned(), response.into_body().into_data_stream()),
            _activity: activity,
        })
    }

    /// Every ENABLED app that provides `cap`, by plugin id (sorted, deduplicated).
    ///
    /// For a **fan-out** capability
    /// ([`crate::plugins::binding::FANOUT_CAPABILITIES`]): one contract that many
    /// apps serve at once, each for its own data, which Core calls on every provider
    /// instead of binding one. Binding-free on purpose: several providers are the
    /// normal case there, not an ambiguity.
    ///
    /// # Errors
    /// [`CapabilityCallError::Failed`] when the plugin store cannot be read.
    pub async fn providers_of(&self, cap: &str) -> Result<Vec<String>, CapabilityCallError> {
        let mut ids: Vec<String> = self
            .enabled_manifests(cap)
            .await?
            .into_iter()
            .filter(|m| {
                m.provided_capabilities()
                    .iter()
                    .any(|p| p.capability == cap)
            })
            .map(|m| m.id)
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// Every ENABLED, **Core-tier** app that provides EVERY capability in `caps`,
    /// by plugin id (sorted, deduplicated).
    ///
    /// The participant set of a fan-out contract that is first-party only for now
    /// (the scheduler's `jobs.list` / `jobs.run`). Tier is provenance-checked by
    /// [`crate::plugins::builtins::tier_for_manifest`]: the exact compiled manifest
    /// or a digest-bound verified official package, never an id alone.
    ///
    /// # Errors
    /// [`CapabilityCallError::Failed`] when the plugin store cannot be read.
    pub async fn core_tier_providers_of(
        &self,
        caps: &[&str],
    ) -> Result<Vec<String>, CapabilityCallError> {
        let label = caps.join(",");
        let mut ids: Vec<String> = self
            .enabled_manifests(&label)
            .await?
            .into_iter()
            .filter(|m| {
                let provided = m.provided_capabilities();
                caps.iter()
                    .all(|cap| provided.iter().any(|p| p.capability == *cap))
            })
            .filter(|m| {
                crate::plugins::builtins::tier_for_manifest(m)
                    == crate::plugin_manifest::PluginTier::Core
            })
            .map(|m| m.id)
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// Invoke `cap` on ONE named provider instead of the bound one: the per-provider
    /// half of a fan-out capability (see [`Self::providers_of`]).
    ///
    /// The provider must be enabled and must itself declare `cap` in `provides`; the
    /// route, registration gate, and minted token are exactly those of
    /// [`Self::call_capability`].
    ///
    /// # Errors
    /// [`CapabilityCallError::Unbound`] (`capability_unprovided`) when `provider_id`
    /// is not an enabled provider of `cap`; otherwise as [`Self::call_capability`].
    pub async fn call_provider_capability(
        &self,
        provider_id: &str,
        cap: &str,
        body: &Value,
    ) -> Result<CapabilityReply, CapabilityCallError> {
        self.call_provider_capability_limited(provider_id, cap, body, MAX_REPLY_BYTES)
            .await
    }

    /// [`Self::call_provider_capability`] with a caller-chosen reply bound: a reply
    /// body larger than `max_reply_bytes` is [`CapabilityCallError::Failed`].
    ///
    /// # Errors
    /// As [`Self::call_provider_capability`].
    pub async fn call_provider_capability_limited(
        &self,
        provider_id: &str,
        cap: &str,
        body: &Value,
        max_reply_bytes: usize,
    ) -> Result<CapabilityReply, CapabilityCallError> {
        let candidates = self.enabled_manifests(cap).await?;
        let provided = candidates
            .iter()
            .filter(|m| m.id == provider_id)
            .find_map(|m| {
                m.provided_capabilities()
                    .iter()
                    .find(|p| p.capability == cap)
                    .map(|entry| (m, entry))
            });
        let Some((provider, entry)) = provided else {
            return Err(CapabilityCallError::Unbound {
                capability: cap.to_owned(),
                code: "capability_unprovided",
                reason: format!("'{provider_id}' is not an enabled provider of '{cap}'"),
            });
        };
        let route = Self::pin_route(cap, provider, entry)?;
        let (response, _activity) = self.open_route(cap, &route, body).await?;
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), max_reply_bytes)
            .await
            .map_err(|e| CapabilityCallError::Failed {
                capability: cap.to_owned(),
                reason: format!("reading provider reply: {e}"),
            })?;
        Ok(CapabilityReply {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        })
    }

    /// Resolve, wake/gate, and POST: the hop every reply shape shares. The returned
    /// guard must outlive the body read.
    async fn open(
        &self,
        cap: &str,
        body: &Value,
    ) -> Result<(Response, Option<ActivityGuard>), CapabilityCallError> {
        let route = self.resolve(cap).await?;
        self.open_route(cap, &route, body).await
    }

    /// Wake/gate and POST to an already-pinned provider route.
    async fn open_route(
        &self,
        cap: &str,
        route: &ProviderRoute,
        body: &Value,
    ) -> Result<(Response, Option<ActivityGuard>), CapabilityCallError> {
        let (target, activity) = provider_target(&self.manager, route)
            .await
            .map_err(|reason| CapabilityCallError::Unavailable {
                capability: cap.to_owned(),
                reason,
            })?;
        let payload = serde_json::to_vec(body).map_err(|e| CapabilityCallError::Failed {
            capability: cap.to_owned(),
            reason: format!("encoding request body: {e}"),
        })?;
        Ok((post_to_provider(target, route, payload).await, activity))
    }

    /// The manifests of every ENABLED app: the set the broker binds over.
    async fn enabled_manifests(
        &self,
        cap: &str,
    ) -> Result<Vec<PluginManifest>, CapabilityCallError> {
        let records = self
            .store
            .list()
            .await
            .map_err(|e| CapabilityCallError::Failed {
                capability: cap.to_owned(),
                reason: format!("listing plugins: {e}"),
            })?;
        let enabled: HashSet<String> = records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect();
        Ok(self
            .manifests
            .read()
            .await
            .iter()
            .filter(|m| enabled.contains(&m.id))
            .cloned()
            .collect())
    }

    /// Pin one provider's `provides` entry to its sidecar route.
    fn pin_route(
        cap: &str,
        provider: &PluginManifest,
        entry: &crate::plugin_manifest::ProvidesEntry,
    ) -> Result<ProviderRoute, CapabilityCallError> {
        resolve_provider_route(provider, entry, &provider.id).map_err(|response| {
            if response.status() == axum::http::StatusCode::NOT_IMPLEMENTED {
                CapabilityCallError::NotProxyable {
                    capability: cap.to_owned(),
                }
            } else {
                CapabilityCallError::Unavailable {
                    capability: cap.to_owned(),
                    reason: format!("provider route unresolvable ({})", response.status()),
                }
            }
        })
    }

    /// Resolve `cap` to its bound provider's route over the ENABLED manifest set.
    async fn resolve(&self, cap: &str) -> Result<ProviderRoute, CapabilityCallError> {
        let candidates = self.enabled_manifests(cap).await?;
        let cfg = crate::plugins::binding::active_config();
        let registry = crate::plugins::binding::BindingRegistry::new(&cfg, &candidates);
        let (provider, entry) =
            registry
                .resolve_provider(cap)
                .map_err(|e| CapabilityCallError::Unbound {
                    capability: cap.to_owned(),
                    code: e.code(),
                    reason: e.to_string(),
                })?;
        Self::pin_route(cap, provider, entry)
    }
}

/// A fixture provider other modules' tests can reuse: one sidecar on a reserved
/// loopback port, registered with a no-op manager, serving whatever axum router the
/// test hands it, and providing whatever capabilities the test names.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::plugin_manifest::schema::{
        BinarySpec, HttpProxySpec, RouteSpec, SidecarProcess, SidecarSpec,
    };
    use crate::plugin_manifest::ProvidesEntry;
    use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
    use std::sync::atomic::{AtomicBool, Ordering};

    pub(crate) const FIXTURE_ID: &str = "com.example.fixture-provider";
    /// The fixture sidecar's `http.mount`; the router a test serves nests here.
    pub(crate) const FIXTURE_MOUNT: &str = "/api/fixture";

    /// A sidecar the manager can register on a known port without spawning anything.
    pub(crate) struct FixtureSidecar {
        name: String,
        port: u16,
        running: AtomicBool,
    }

    impl FixtureSidecar {
        /// Flip the registration's liveness, as a stop or a restart would.
        pub(crate) fn set_running(&self, running: bool) {
            self.running.store(running, Ordering::SeqCst);
        }
    }

    impl Sidecar for FixtureSidecar {
        fn name(&self) -> &str {
            &self.name
        }
        fn is_required(&self) -> bool {
            false
        }
        fn start(&self) -> BoxFuture<anyhow::Result<()>> {
            self.running.store(true, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
            self.running.store(false, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn health_check(&self) -> BoxFuture<HealthStatus> {
            Box::pin(async { HealthStatus::Healthy })
        }
        fn is_running(&self) -> bool {
            self.running.load(Ordering::SeqCst)
        }
        fn port(&self) -> Option<u16> {
            Some(self.port)
        }
    }

    /// A manifest whose one sidecar declares a POST route for, and `provides`, each
    /// `(capability, route)` pair. A `None` route is an in-process capability.
    pub(crate) fn fixture_manifest(port: u16, provides: &[(&str, Option<&str>)]) -> PluginManifest {
        fixture_manifest_for(FIXTURE_ID, port, provides)
    }

    /// [`fixture_manifest`] under another plugin id, for tests that need two
    /// providers of one capability side by side.
    pub(crate) fn fixture_manifest_for(
        id: &str,
        port: u16,
        provides: &[(&str, Option<&str>)],
    ) -> PluginManifest {
        let routes = provides
            .iter()
            .filter_map(|(_, route)| *route)
            .map(|path| RouteSpec {
                path: path.to_owned(),
                method: Some("POST".to_owned()),
                auth: Default::default(),
                permission: None,
                resource_param: None,
            })
            .collect();
        PluginManifest {
            id: id.to_owned(),
            name: "Fixture provider".to_owned(),
            version: "1.0.0".to_owned(),
            sidecars: vec![SidecarSpec {
                name: "engine".to_owned(),
                process: SidecarProcess::Binary(BinarySpec {
                    url: "https://example.com/engine".to_owned(),
                    version: "1.0.0".to_owned(),
                    sha256: None,
                    archive: None,
                    binary_name: None,
                    args: vec![],
                    env: Default::default(),
                }),
                port,
                health_path: "/health".to_owned(),
                http: Some(HttpProxySpec {
                    mount: Some(FIXTURE_MOUNT.to_owned()),
                    public_mount: None,
                    forward_cookie_names: Vec::new(),
                    forward_caller_email: false,
                    caller_resource_scope: None,
                    forward_caller_rate_subject: false,
                    routes,
                    max_body_bytes: None,
                }),
                host_api: None,
                lazy: false,
                idle_stop_secs: None,
                provides_provider: None,
                sandbox: None,
            }],
            provides: provides
                .iter()
                .map(|(capability, route)| ProvidesEntry {
                    capability: (*capability).to_owned(),
                    version: "1.0.0".to_owned(),
                    sidecar: route.map(|_| "engine".to_owned()),
                    route: route.map(str::to_owned),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    /// A consumer over `manifest`, with the fixture app installed and optionally
    /// enabled.
    pub(crate) async fn consumer_with(
        manifest: PluginManifest,
        enabled: bool,
    ) -> CapabilityConsumer {
        let store = PluginStore::open_in_memory().unwrap();
        store.insert(FIXTURE_ID, "1.0.0").await.unwrap();
        if enabled {
            store.set_enabled(FIXTURE_ID, &[]).await.unwrap();
        }
        CapabilityConsumer::new(
            SidecarManager::new_noop(),
            Arc::new(tokio::sync::RwLock::new(vec![manifest])),
            store,
        )
    }

    /// A consumer with no installed provider at all (the app is not installed).
    pub(crate) fn consumer_without_providers() -> CapabilityConsumer {
        CapabilityConsumer::new(
            SidecarManager::new_noop(),
            Arc::new(tokio::sync::RwLock::new(Vec::new())),
            PluginStore::open_in_memory().unwrap(),
        )
    }

    /// An enabled fixture provider whose sidecar is registered on a reserved port
    /// (nothing listens there yet; see [`serve`]).
    pub(crate) async fn registered(
        provides: &[(&str, Option<&str>)],
    ) -> (CapabilityConsumer, Arc<FixtureSidecar>, u16) {
        // Reserve a free port, let the manager CLAIM it for the fixture sidecar, and
        // only then bind the fixture server there: the manager refuses to claim a
        // port another socket already holds.
        let port = reserve_port();
        let consumer = consumer_with(fixture_manifest(port, provides), true).await;
        let sidecar = Arc::new(FixtureSidecar {
            name: crate::sidecar::manifest_sidecar::namespaced_name(FIXTURE_ID, "engine"),
            port,
            running: AtomicBool::new(false),
        });
        consumer
            .manager
            .register_and_start(sidecar.clone())
            .await
            .unwrap();
        (consumer, sidecar, port)
    }

    /// A free loopback port, released again so the manager can claim it.
    ///
    /// The manager's claim bind-probes the port, so the reservation cannot stay
    /// bound until [`serve`]. What the helper can rule out is the in-process race:
    /// once released, the kernel may hand the same number to another parallel
    /// test's `bind(0)`, and both fixtures would then register (on separate
    /// managers) and race to [`serve`] it. Every port is handed out at most once
    /// per test binary.
    pub(crate) fn reserve_port() -> u16 {
        static ISSUED: std::sync::Mutex<std::collections::BTreeSet<u16>> =
            std::sync::Mutex::new(std::collections::BTreeSet::new());
        loop {
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            if ISSUED
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(port)
            {
                return port;
            }
        }
    }

    /// Register the fixture app's `engine` sidecar on `port` with `manager`, without
    /// spawning anything (see [`serve`] for the listener).
    pub(crate) async fn register_fixture_sidecar(
        manager: &Arc<SidecarManager>,
        port: u16,
    ) -> Arc<FixtureSidecar> {
        register_sidecar_for(manager, FIXTURE_ID, port).await
    }

    /// [`register_fixture_sidecar`] for a fixture provider under another plugin id
    /// (see [`fixture_manifest_for`]).
    pub(crate) async fn register_sidecar_for(
        manager: &Arc<SidecarManager>,
        id: &str,
        port: u16,
    ) -> Arc<FixtureSidecar> {
        try_register_sidecar_for(manager, id, port).await.unwrap()
    }

    /// [`register_sidecar_for`] that reports a refused registration (for example a
    /// reserved port another test claimed first) instead of panicking.
    pub(crate) async fn try_register_sidecar_for(
        manager: &Arc<SidecarManager>,
        id: &str,
        port: u16,
    ) -> anyhow::Result<Arc<FixtureSidecar>> {
        let sidecar = Arc::new(FixtureSidecar {
            name: crate::sidecar::manifest_sidecar::namespaced_name(id, "engine"),
            port,
            running: AtomicBool::new(false),
        });
        manager.register_and_start(sidecar.clone()).await?;
        Ok(sidecar)
    }

    /// Serve `router` (whose routes carry the full `FIXTURE_MOUNT` prefix) on `port`.
    pub(crate) async fn serve(port: u16, router: axum::Router) -> tokio::task::JoinHandle<()> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        })
    }

    /// The bearer the fixture provider must receive on every hop.
    pub(crate) fn expected_bearer() -> String {
        format!(
            "Bearer {}",
            crate::sidecar::ext_proxy::ext_token(None, FIXTURE_ID)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use axum::http::HeaderMap;
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::json;
    use std::time::Duration;

    const FIXTURE_CAP: &str = "fixture.echo";
    const STREAM_CAP: &str = "fixture.changes";

    fn bearer_of(headers: &HeaderMap) -> String {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    }

    /// The fixture provider echoes the body and the bearer it was handed, so the test
    /// proves the hop reached the DECLARED route with the PROVIDER's minted token.
    #[tokio::test]
    async fn posts_to_the_bound_provider_route_with_its_minted_token() {
        let (consumer, sidecar, port) = registered(&[(FIXTURE_CAP, Some("/echo"))]).await;
        let app = Router::new().route(
            "/api/fixture/echo",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                Json(json!({ "echo": body, "bearer": bearer_of(&headers) }))
            }),
        );
        let server = serve(port, app).await;

        let reply = consumer
            .call_capability(FIXTURE_CAP, &json!({ "ping": 1 }))
            .await
            .expect("the bound provider answers");
        assert!(reply.is_success(), "{reply:?}");
        assert_eq!(reply.body["echo"], json!({ "ping": 1 }));
        assert_eq!(reply.body["bearer"], json!(expected_bearer()));

        // A stopped provider is refused at the registration gate, never dialed.
        sidecar.set_running(false);
        let err = consumer
            .call_capability(FIXTURE_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::Unavailable { .. }),
            "{err:?}"
        );
        server.abort();
    }

    /// The raw variant hands back status, headers and bytes untouched, for a
    /// capability whose reply is not JSON.
    #[tokio::test]
    async fn the_raw_variant_returns_status_headers_and_bytes() {
        let (consumer, _sidecar, port) = registered(&[(FIXTURE_CAP, Some("/echo"))]).await;
        let app = Router::new().route(
            "/api/fixture/echo",
            post(|| async {
                (
                    [
                        (axum::http::header::CONTENT_TYPE, "image/png"),
                        (axum::http::header::ETAG, "\"r1\""),
                    ],
                    vec![0_u8, 159, 146, 150],
                )
            }),
        );
        let server = serve(port, app).await;
        let reply = consumer
            .call_capability_raw(FIXTURE_CAP, &json!({}))
            .await
            .unwrap();
        assert!(reply.is_success());
        assert_eq!(reply.header("content-type"), Some("image/png"));
        assert_eq!(reply.header("etag"), Some("\"r1\""));
        assert_eq!(&reply.body[..], &[0_u8, 159, 146, 150]);
        server.abort();
    }

    #[tokio::test]
    async fn a_disabled_provider_is_unbound_and_never_dialed() {
        let consumer =
            consumer_with(fixture_manifest(1, &[(FIXTURE_CAP, Some("/echo"))]), false).await;
        let err = consumer
            .call_capability(FIXTURE_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CapabilityCallError::Unbound {
                    code: "capability_unprovided",
                    ..
                }
            ),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn an_unregistered_provider_sidecar_is_unavailable() {
        let consumer =
            consumer_with(fixture_manifest(1, &[(FIXTURE_CAP, Some("/echo"))]), true).await;
        let err = consumer
            .call_capability(FIXTURE_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::Unavailable { .. }),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn an_in_process_capability_is_not_proxyable() {
        let consumer = consumer_with(fixture_manifest(1, &[(FIXTURE_CAP, None)]), true).await;
        let err = consumer
            .call_capability(FIXTURE_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::NotProxyable { .. }),
            "{err:?}"
        );
    }

    // ── Fan-out (per-provider) calls ─────────────────────────────────────────

    /// A per-provider call reaches the NAMED provider's declared route with its own
    /// minted token, and refuses a provider that does not serve the capability.
    #[tokio::test]
    async fn a_per_provider_call_reaches_the_named_provider_only() {
        let (consumer, _sidecar, port) = registered(&[(FIXTURE_CAP, Some("/echo"))]).await;
        let app = Router::new().route(
            "/api/fixture/echo",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                Json(json!({ "echo": body, "bearer": bearer_of(&headers) }))
            }),
        );
        let server = serve(port, app).await;

        assert_eq!(
            consumer.providers_of(FIXTURE_CAP).await.unwrap(),
            vec![FIXTURE_ID.to_owned()]
        );
        let reply = consumer
            .call_provider_capability(FIXTURE_ID, FIXTURE_CAP, &json!({ "category": "x" }))
            .await
            .expect("the named provider answers");
        assert_eq!(reply.body["echo"], json!({ "category": "x" }));
        assert_eq!(reply.body["bearer"], json!(expected_bearer()));

        let err = consumer
            .call_provider_capability("com.example.other", FIXTURE_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CapabilityCallError::Unbound {
                    code: "capability_unprovided",
                    ..
                }
            ),
            "{err:?}"
        );
        server.abort();
    }

    /// A disabled app is not a provider of anything, and is never dialed.
    #[tokio::test]
    async fn a_disabled_app_is_not_a_fan_out_provider() {
        let consumer =
            consumer_with(fixture_manifest(1, &[(FIXTURE_CAP, Some("/echo"))]), false).await;
        assert!(consumer.providers_of(FIXTURE_CAP).await.unwrap().is_empty());
        let err = consumer
            .call_provider_capability(FIXTURE_ID, FIXTURE_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::Unbound { .. }),
            "{err:?}"
        );
    }

    // ── Streaming ────────────────────────────────────────────────────────────

    /// A subscription POSTs the body with the provider's token, yields each frame
    /// as it is parsed (named events, multi-line data, ids; comments skipped), and
    /// ends when the provider closes the stream.
    #[tokio::test]
    async fn subscribes_to_a_streaming_provider_and_ends_when_it_closes() {
        let (consumer, _sidecar, port) = registered(&[(STREAM_CAP, Some("/changes"))]).await;
        let app = Router::new().route(
            "/api/fixture/changes",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                let first = json!({ "bearer": bearer_of(&headers), "body": body }).to_string();
                let frames: Vec<Result<Event, std::convert::Infallible>> = vec![
                    Ok(Event::default().comment("ready")),
                    Ok(Event::default().data(first)),
                    Ok(Event::default().event("change").id("7").data("a\nb")),
                ];
                Sse::new(futures_util::stream::iter(frames))
            }),
        );
        let server = serve(port, app).await;

        let mut stream = consumer
            .subscribe_capability(STREAM_CAP, &json!({ "since": 3 }))
            .await
            .expect("the bound provider streams");
        let first = stream.next().await.unwrap().unwrap();
        let first: Value = serde_json::from_str(&first.data).unwrap();
        assert_eq!(first["bearer"], json!(expected_bearer()));
        assert_eq!(first["body"], json!({ "since": 3 }));
        let second = stream.next().await.unwrap().unwrap();
        assert_eq!(
            second,
            CapabilityEvent {
                event: Some("change".to_owned()),
                id: Some("7".to_owned()),
                data: "a\nb".to_owned(),
            }
        );
        let end = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("a closed provider stream must end the subscription");
        assert!(end.is_none(), "{end:?}");
        server.abort();
    }

    /// A provider that dies mid-stream (a restart) ends the subscription, so the
    /// caller's reconnect policy can run; it never hangs or panics. A later
    /// subscription reaches the restarted provider.
    #[tokio::test]
    async fn a_provider_restart_ends_the_stream_and_a_resubscribe_reaches_it_again() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (consumer, _sidecar, port) = registered(&[(STREAM_CAP, Some("/changes"))]).await;
        // First incarnation: answer the head and one frame, then drop the socket
        // without terminating the chunked body.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let first = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            let frame = "data: before\n\n";
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Transfer-Encoding: chunked\r\n\r\n{:x}\r\n{frame}\r\n",
                frame.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            // Dropping `socket` and `listener` here is the provider going away.
        });

        let mut stream = consumer
            .subscribe_capability(STREAM_CAP, &json!({}))
            .await
            .unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap().data, "before");
        first.await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            let mut saw_error = false;
            while let Some(item) = stream.next().await {
                assert!(
                    matches!(item, Err(CapabilityCallError::Failed { .. })),
                    "{item:?}"
                );
                saw_error = true;
            }
            saw_error
        })
        .await
        .expect("a dropped provider connection must end the subscription");
        assert!(ended, "a truncated body surfaces one transport error first");

        // Second incarnation on the same registration.
        let app = Router::new().route(
            "/api/fixture/changes",
            post(|| async {
                let frames: Vec<Result<Event, std::convert::Infallible>> =
                    vec![Ok(Event::default().data("after"))];
                Sse::new(futures_util::stream::iter(frames))
            }),
        );
        let server = serve(port, app).await;
        let mut again = consumer
            .subscribe_capability(STREAM_CAP, &json!({}))
            .await
            .unwrap();
        assert_eq!(again.next().await.unwrap().unwrap().data, "after");
        server.abort();
    }

    #[tokio::test]
    async fn subscribing_to_a_disabled_or_missing_provider_is_a_clean_refusal() {
        let disabled = consumer_with(
            fixture_manifest(1, &[(STREAM_CAP, Some("/changes"))]),
            false,
        )
        .await;
        let err = disabled
            .subscribe_capability(STREAM_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::Unbound { .. }),
            "{err:?}"
        );
        let err = consumer_without_providers()
            .subscribe_capability(STREAM_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::Unbound { .. }),
            "{err:?}"
        );
        // Enabled but its sidecar never registered: refused before any dial.
        let unregistered =
            consumer_with(fixture_manifest(1, &[(STREAM_CAP, Some("/changes"))]), true).await;
        let err = unregistered
            .subscribe_capability(STREAM_CAP, &json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CapabilityCallError::Unavailable { .. }),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn a_provider_that_refuses_the_subscription_is_a_failed_call() {
        let (consumer, _sidecar, port) = registered(&[(STREAM_CAP, Some("/changes"))]).await;
        let app = Router::new().route(
            "/api/fixture/changes",
            post(|| async {
                (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "warming up" })),
                )
            }),
        );
        let server = serve(port, app).await;
        let err = consumer
            .subscribe_capability(STREAM_CAP, &json!({}))
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("503") && message.contains("warming up"),
            "{message}"
        );
        server.abort();
    }

    #[test]
    fn the_sse_parser_reassembles_frames_split_across_chunks() {
        let mut parser = SseParser::default();
        let mut events = Vec::new();
        for chunk in [
            &b": keep-alive\r\nda"[..],
            b"ta: {\"a\":",
            b"1}\r\n\r\nevent: x\nid: 9\ndata:no-space\ndata:  two\n",
            b"\nretry: 10\nunknown\n\n",
            b"data: \xE2\x9C",
            b"\x93\n\n",
            b"data: trailing-without-blank-line",
        ] {
            events.extend(parser.push(chunk).unwrap());
        }
        assert_eq!(
            events,
            vec![
                CapabilityEvent {
                    event: None,
                    id: None,
                    data: "{\"a\":1}".to_owned(),
                },
                CapabilityEvent {
                    event: Some("x".to_owned()),
                    id: Some("9".to_owned()),
                    data: "no-space\n two".to_owned(),
                },
                CapabilityEvent {
                    event: None,
                    id: Some("9".to_owned()),
                    data: "\u{2713}".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn the_sse_parser_refuses_an_unbounded_line() {
        let mut parser = SseParser::default();
        let line = vec![b'a'; MAX_SSE_LINE_BYTES + 1];
        assert!(parser.push(&line).is_err());
    }
}
