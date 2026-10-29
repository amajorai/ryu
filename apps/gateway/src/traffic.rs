//! Live traffic bus: the in-memory broadcast seam behind `GET /v1/traffic`.
//!
//! Every request that reaches the audit sink is published here as a small
//! redacted JSON event, so the desktop's live-traffic dashboard can render
//! requests as they complete without re-querying the SQLite audit store. The
//! bus is deliberately thin:
//!
//! * **Not a backend**: it does not persist anything. The audit store remains
//!   the system of record; this is a live-only overlay for observability.
//! * **Redacted at the source**: the API key is truncated to its prefix here,
//!   never broadcast in full, mirroring the `/v1/audit` query path. Verdicts
//!   name layers, detectors and catalogue codes, never prompt text.
//! * **Best-effort**: a slow subscriber is dropped (broadcast semantics); the
//!   ring buffer only serves late joiners a bounded tail of history.
//! * **Ordered**: every event carries a strictly increasing `seq`, so a
//!   subscriber deduplicates its ring snapshot against the live channel by
//!   sequence, and one request may publish several rows (a guardrail verdict,
//!   then its completion or failure) without any being dropped.
//!
//! The pipeline funnels through [`AppState::log_audit`] (the gateway's single
//! audit chokepoint), which logs to the active audit backend and broadcasts to
//! this bus, so no call site that records an audit row can forget the live
//! feed. Guardrail rows go through `AppState::log_audit_with`, which also
//! says what the row decided.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::audit::AuditRecord;
use crate::custody::GatewayCustody;
use crate::error::GatewayError;

/// How many recent events a late subscriber receives on connect. Bounded so a
/// reconnect never floods the client with the whole history.
const RING_CAPACITY: usize = 200;

/// Broadcast capacity. A subscriber that falls this far behind is lagged and
/// dropped; the next reconnect re-seeds from the ring.
const CHANNEL_CAPACITY: usize = 1024;

/// How many requests may hold a pending note at once (spec 07.2). A request
/// that never writes an audit row is evicted oldest first, so notes never
/// grow without bound.
const NOTE_CAPACITY: usize = 4096;

/// Visible characters of a hosted credential id. The id is not a secret, but
/// the feed only needs enough of it to tell keys apart.
const CREDENTIAL_ID_PREFIX: usize = 8;

/// Most detector ids one event carries.
const MAX_DETECTOR_IDS: usize = 8;

/// Audit `provider` tags written by guardrail rows rather than a real upstream.
const MARKER_PROVIDERS: &[&str] = &[
    "none",
    "credits-debit",
    "evaluator",
    "inspector",
    "firewall",
    "companion-dlp",
    "gateway",
];

/// Providers that run on the node itself and spend no upstream credential.
const LOCAL_PROVIDERS: &[&str] = &["local", "ollama", "llamacpp", "lmstudio", "mlx"];

tokio::task_local! {
    /// The matched route template of the request being served, set by
    /// [`scope_route`] for every route.
    static ROUTE: Option<String>;
}

/// Router middleware: serve the request with its route template in scope, so
/// [`crate::state::AppState::log_audit`] can stamp it on the traffic event.
/// The template, never the raw path: some paths carry a proof segment.
pub async fn scope_route(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|path| path.as_str().to_owned());
    ROUTE.scope(route, next.run(request)).await
}

/// The route template of the request in scope, when there is one. A stream
/// that finishes after its handler returned reads the template from the note
/// the pipeline left instead.
pub fn current_route() -> Option<String> {
    ROUTE.try_with(Clone::clone).ok().flatten()
}

/// `work` with the route template of the request in scope, for a task the
/// request spawns: a task-local does not cross `tokio::spawn`, so a detached
/// pipeline run would otherwise stamp no route on its rows.
pub fn carry_route<F: std::future::Future>(
    work: F,
) -> impl std::future::Future<Output = F::Output> {
    ROUTE.scope(current_route(), work)
}

/// The traffic action a firewall policy takes on a match.
pub(crate) const fn firewall_action(policy: &crate::config::FirewallPolicy) -> VerdictAction {
    match policy {
        crate::config::FirewallPolicy::Block => VerdictAction::Block,
        crate::config::FirewallPolicy::Sanitize => VerdictAction::Sanitize,
        crate::config::FirewallPolicy::WarnAndContinue => VerdictAction::Warn,
    }
}

/// Which row of a request an event is. One request can publish several: a
/// guardrail verdict and then its completion or failure.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrafficKind {
    #[default]
    Completion,
    Verdict,
    CacheHit,
    Failure,
}

/// The layer whose decision the event reports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    PlatformFloor,
    Node,
    Org,
    Agent,
    Evaluator,
    Inspector,
    RateLimit,
    Budget,
    Standing,
    /// A model provider refused a request that spent a Ryu-held credential
    /// for a safety reason (spec 03.5).
    Upstream,
    #[default]
    None,
}

impl DecidedBy {
    /// Layers whose free-text reason may hold model output or a floor
    /// pattern name, so the event's `error` is replaced by a fixed summary.
    const fn withholds_reason(self) -> bool {
        matches!(
            self,
            Self::PlatformFloor | Self::Inspector | Self::Evaluator | Self::Upstream
        )
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::PlatformFloor => "platform_floor",
            Self::Node => "node",
            Self::Org => "org",
            Self::Agent => "agent",
            Self::Evaluator => "evaluator",
            Self::Inspector => "inspector",
            Self::RateLimit => "rate_limit",
            Self::Budget => "budget",
            Self::Standing => "standing",
            Self::Upstream => "upstream",
            Self::None => "none",
        }
    }
}

/// What the deciding layer did. Ordered weakest first, so a stronger action
/// noted later replaces a weaker one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictAction {
    #[default]
    Allow,
    Warn,
    Sanitize,
    Block,
}

impl VerdictAction {
    const fn past_tense(self) -> &'static str {
        match self {
            Self::Allow => "allowed",
            Self::Warn => "flagged",
            Self::Sanitize => "sanitized",
            Self::Block => "blocked",
        }
    }
}

/// The redacted verdict summary on a traffic event. It names layers,
/// detectors and catalogue codes only, never matched text, segment paths,
/// scores or the end-user hash.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrafficVerdict {
    pub decided_by: DecidedBy,
    pub action: VerdictAction,
    /// Detection kinds, tenant pattern names or inspector categories. A
    /// platform floor decision names the detection kind, never its pattern.
    pub detector_ids: Vec<String>,
    pub evaluator_ids: Vec<String>,
    /// Short S-codes (or taxonomy ids without one) a hazard screener
    /// flagged or blocked. Never a score or a threshold.
    pub categories: Vec<&'static str>,
    /// Why the screener ran in a reduced mode for this request
    /// (`t2`, `vision`, `deadline`), when it did.
    pub degraded: Option<&'static str>,
    /// The catalogue `code` the client received, when the request failed.
    pub code: Option<&'static str>,
    /// The violation event that decided this verdict (spec 00.6), the key
    /// the feed row joins the outbox on. The first blocking event, else the
    /// first flag; `None` when the decision recorded no event.
    pub event_id: Option<String>,
}

impl TrafficVerdict {
    pub fn new(decided_by: DecidedBy, action: VerdictAction) -> Self {
        Self {
            decided_by,
            action,
            ..Self::default()
        }
    }

    /// Add a detector id when it is a plain identifier. Anything else (free
    /// text a classifier returned, say) is dropped rather than broadcast.
    pub fn with_detector(mut self, id: &str) -> Self {
        if is_plain_id(id) && self.detector_ids.len() < MAX_DETECTOR_IDS {
            self.detector_ids.push(id.to_owned());
        }
        self
    }

    /// Add a screener category (a short S-code or a taxonomy id).
    pub fn with_category(mut self, category: &'static str) -> Self {
        if !self.categories.contains(&category) {
            self.categories.push(category);
        }
        self
    }

    /// Name the violation event behind this verdict, when one was recorded.
    pub fn with_event(mut self, event_id: Option<String>) -> Self {
        if event_id.is_some() {
            self.event_id = event_id;
        }
        self
    }

    pub fn with_evaluator(mut self, id: &str) -> Self {
        if is_plain_id(id) {
            self.evaluator_ids.push(id.to_owned());
        }
        self
    }

    /// The verdict a refused request carries, from the error it was refused
    /// with. A firewall block is attributed to the node here; the block site
    /// notes the real layer first ([`TrafficBus::note_verdict`]).
    pub fn for_error(error: &GatewayError) -> Self {
        let (decided_by, action) = match error {
            GatewayError::RateLimited
            | GatewayError::RateLimitedBy(_)
            | GatewayError::NewKeyRateLimited { .. } => {
                (DecidedBy::RateLimit, VerdictAction::Block)
            }
            GatewayError::BudgetExceeded(_)
            | GatewayError::BudgetStoreUnavailable(_)
            | GatewayError::InsufficientCredits
            | GatewayError::AccountingUnavailable
            | GatewayError::ToolUnpriced(_)
            | GatewayError::ToolPaymentRequired(_) => (DecidedBy::Budget, VerdictAction::Block),
            GatewayError::StandingRefused(_)
            | GatewayError::StandingUnavailable
            | GatewayError::AbuseThrottled(_)
            | GatewayError::AccountRestricted(_) => (DecidedBy::Standing, VerdictAction::Block),
            GatewayError::PlatformRefused { .. }
            | GatewayError::ScreeningUnavailable { .. }
            | GatewayError::ScreeningDegradedThrottle { .. }
            | GatewayError::ScreeningCapacityExceeded => {
                (DecidedBy::PlatformFloor, VerdictAction::Block)
            }
            GatewayError::ContentBlocked(block) => {
                let decided_by = match block.layer {
                    crate::error::ContentBlockLayer::Platform => DecidedBy::PlatformFloor,
                    crate::error::ContentBlockLayer::Node => DecidedBy::Node,
                };
                let mut verdict = Self::new(decided_by, VerdictAction::Block);
                for category in &block.categories {
                    verdict = verdict.with_category(category);
                }
                verdict.code = Some(block.code());
                return verdict;
            }
            GatewayError::UpstreamSafetyRefused(refusal) => {
                let mut verdict = Self::new(DecidedBy::Upstream, VerdictAction::Block)
                    .with_detector(refusal.signal.row)
                    .with_category(refusal.signal.category().as_str());
                verdict.code = Some(refusal.code());
                return verdict;
            }
            GatewayError::PolicyViolation(_) => (DecidedBy::Org, VerdictAction::Block),
            GatewayError::FirewallBlocked(..) => (DecidedBy::Node, VerdictAction::Block),
            GatewayError::Unauthorized(_)
            | GatewayError::BadRequest(_)
            | GatewayError::ToolNotServable(_)
            | GatewayError::InvalidRequest { .. } => (DecidedBy::None, VerdictAction::Block),
            GatewayError::ConfigConflict(_)
            | GatewayError::NoProvider(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_)
            | GatewayError::ProviderDeliveryUncertain(_)
            | GatewayError::ProviderPaymentRequired { .. }
            | GatewayError::ProviderRateLimited { .. }
            | GatewayError::CircuitOpen(_)
            | GatewayError::Overloaded(_)
            | GatewayError::ProviderResponseTooLarge { .. }
            | GatewayError::ProviderBodyUnreadable { .. }
            | GatewayError::AllProvidersUnavailable(_)
            | GatewayError::Internal(_) => (DecidedBy::None, VerdictAction::Allow),
        };
        let mut verdict = Self::new(decided_by, action);
        verdict.code = Some(error.wire_status_and_code().1);
        verdict
    }

    /// Whether a noted verdict may replace this one: only the defaults that
    /// say nothing about which layer decided.
    fn is_refinable(&self) -> bool {
        matches!(self.decided_by, DecidedBy::None | DecidedBy::Node)
    }
}

/// Identifiers safe to broadcast: short, and made only of the characters
/// detector, pattern and evaluator ids use.
fn is_plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}

/// How one audit row ended, as the traffic event reports it.
#[derive(Debug, Clone, Default)]
pub struct TrafficOutcome {
    pub kind: TrafficKind,
    pub verdict: TrafficVerdict,
    pub status: Option<u16>,
    /// The request whose note this row reads, when its own request id is a
    /// derived ref (a failed tool-loop attempt settles under
    /// `{request_id}:attempt-{n}`). Named explicitly, never parsed from the
    /// id, which a caller may choose.
    pub note_request_id: Option<String>,
}

impl TrafficOutcome {
    /// The outcome of a row written without one: a cache hit, a completion,
    /// or a failure whose layer is not known.
    pub fn inferred(record: &AuditRecord) -> Self {
        let (kind, status) = if record.cache_hit {
            (TrafficKind::CacheHit, Some(200))
        } else if record.error.is_some() {
            (TrafficKind::Failure, None)
        } else {
            (TrafficKind::Completion, Some(200))
        };
        Self {
            kind,
            verdict: TrafficVerdict::default(),
            status,
            note_request_id: None,
        }
    }

    /// A guardrail decision row.
    pub fn verdict(verdict: TrafficVerdict) -> Self {
        Self {
            kind: TrafficKind::Verdict,
            verdict,
            status: None,
            note_request_id: None,
        }
    }

    /// A refused or failed request, with the status and code it returned.
    pub fn failure(error: &GatewayError) -> Self {
        Self {
            kind: TrafficKind::Failure,
            verdict: TrafficVerdict::for_error(error),
            status: Some(error.wire_status_and_code().0.as_u16()),
            note_request_id: None,
        }
    }

    /// Read the note of `request_id` instead of the row's own.
    pub fn joining_note_of(mut self, request_id: &str) -> Self {
        self.note_request_id = Some(request_id.to_owned());
        self
    }
}

/// What the pipeline learned about a request before its audit row: the route
/// (a stream ends outside its handler), the screening time, and a guardrail
/// verdict that wrote no row of its own (a firewall sanitize or warn).
#[derive(Debug, Clone, Default)]
struct TrafficNote {
    route: Option<String>,
    screen_ms: Option<u64>,
    verdict: Option<TrafficVerdict>,
}

impl TrafficNote {
    /// Keep the stronger verdict; on a tie the first decider stays, and
    /// takes the event id of the later one when it named none.
    fn merge_verdict(&mut self, mut verdict: TrafficVerdict) {
        // A reduced-mode screen stays on the request whichever verdict wins:
        // an allowing deadline-bound screen noted before or after a stronger
        // verdict is still a degraded request.
        match self.verdict.as_mut() {
            Some(current) if verdict.action <= current.action => {
                if current.event_id.is_none() && verdict.action == current.action {
                    current.event_id = verdict.event_id;
                }
                current.degraded = current.degraded.or(verdict.degraded);
            }
            current => {
                verdict.degraded = verdict
                    .degraded
                    .or_else(|| current.and_then(|c| c.degraded));
                self.verdict = Some(verdict);
            }
        }
    }
}

/// Notes by request id, evicted oldest first past [`NOTE_CAPACITY`].
#[derive(Default)]
struct NoteMap {
    entries: HashMap<String, TrafficNote>,
    order: VecDeque<String>,
}

impl NoteMap {
    fn entry(&mut self, request_id: &str) -> &mut TrafficNote {
        if !self.entries.contains_key(request_id) {
            while self.order.len() >= NOTE_CAPACITY {
                if let Some(oldest) = self.order.pop_front() {
                    self.entries.remove(&oldest);
                }
            }
            self.order.push_back(request_id.to_owned());
        }
        self.entries.entry(request_id.to_owned()).or_default()
    }
}

/// The ring and the sequence counter, under one lock so sequence order is
/// ring order is broadcast order.
struct Ring {
    events: VecDeque<Value>,
    last_seq: u64,
}

/// Broadcast channel for live request traffic. Subscribers receive via the
/// channel; the ring is only touched on publish (append) and snapshot
/// (`recent`).
pub struct TrafficBus {
    sender: broadcast::Sender<Value>,
    /// Bounded tail of recent events, newest last, for late-joining subscribers.
    ring: Mutex<Ring>,
    notes: Mutex<NoteMap>,
}

impl Default for TrafficBus {
    fn default() -> Self {
        Self::new()
    }
}

impl TrafficBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            sender,
            ring: Mutex::new(Ring {
                events: VecDeque::with_capacity(RING_CAPACITY),
                last_seq: 0,
            }),
            notes: Mutex::new(NoteMap::default()),
        }
    }

    /// Publish a redacted request event, stamping its `seq`. Returns the
    /// number of subscribers that received it (0 when none are connected).
    ///
    /// The sequence number is assigned, the ring appended and the event sent
    /// under one lock, so `seq` is strictly increasing in both the ring and
    /// the live channel. A subscriber can then drop any live event whose
    /// `seq` its ring snapshot already covered.
    pub fn publish(&self, mut event: Value) -> usize {
        let mut ring = self.ring.lock().unwrap_or_else(PoisonError::into_inner);
        ring.last_seq += 1;
        if let Some(object) = event.as_object_mut() {
            object.insert("seq".to_owned(), json!(ring.last_seq));
        }
        if ring.events.len() >= RING_CAPACITY {
            ring.events.pop_front();
        }
        ring.events.push_back(event.clone());
        self.sender.send(event).unwrap_or(0)
    }

    /// Subscribe to the live broadcast channel. Does NOT seed history: the
    /// caller subscribes first, then snapshots [`Self::recent`], and skips
    /// live events whose `seq` the snapshot covered.
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.sender.subscribe()
    }

    /// Snapshot the ring buffer (newest last).
    pub fn recent(&self) -> Vec<Value> {
        self.ring
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .events
            .iter()
            .cloned()
            .collect()
    }

    /// Record that a request finished screening: its route and how long the
    /// pre-dispatch stages took.
    pub fn note_screen(&self, request_id: &str, route: Option<String>, screen_ms: u64) {
        if request_id.is_empty() {
            return;
        }
        let mut notes = self.notes.lock().unwrap_or_else(PoisonError::into_inner);
        let note = notes.entry(request_id);
        if route.is_some() {
            note.route = route;
        }
        note.screen_ms = Some(screen_ms);
    }

    /// The route template a request noted while its handler was in scope,
    /// for a record made after it returned (a stream cut). Read only: it
    /// never creates a note.
    pub fn noted_route(&self, request_id: &str) -> Option<String> {
        self.notes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entries
            .get(request_id)
            .and_then(|note| note.route.clone())
    }

    /// Record a guardrail verdict that the request's later rows should carry.
    pub fn note_verdict(&self, request_id: &str, verdict: TrafficVerdict) {
        if request_id.is_empty() {
            return;
        }
        let mut notes = self.notes.lock().unwrap_or_else(PoisonError::into_inner);
        notes.entry(request_id).merge_verdict(verdict);
    }

    /// The note for a row. A verdict row folds its verdict in first. No row
    /// removes the note: one request also writes rows for the auxiliary
    /// calls it makes (an inspector model call, a tool round) under the same
    /// request id, and none of them may take the note from the request's
    /// own completion. Notes leave by age, bounded at [`NOTE_CAPACITY`].
    fn note_for(&self, request_id: &str, outcome: &TrafficOutcome) -> TrafficNote {
        if request_id.is_empty() {
            return TrafficNote::default();
        }
        let mut notes = self.notes.lock().unwrap_or_else(PoisonError::into_inner);
        if outcome.kind == TrafficKind::Verdict && outcome.verdict.action > VerdictAction::Allow {
            notes
                .entry(request_id)
                .merge_verdict(outcome.verdict.clone());
        }
        notes.entries.get(request_id).cloned().unwrap_or_default()
    }

    /// Add the verdict fields to a redacted base event built from `record`.
    pub fn enrich(
        &self,
        mut event: Value,
        record: &AuditRecord,
        outcome: TrafficOutcome,
        custody: GatewayCustody,
    ) -> Value {
        let note_id = outcome
            .note_request_id
            .as_deref()
            .unwrap_or(&record.request_id);
        let note = self.note_for(note_id, &outcome);
        let noted_event = note.verdict.as_ref().and_then(|v| v.event_id.clone());
        // An allowing note is never adopted below, but its reduced-mode
        // reason still describes this request (a deadline-bound screen that
        // let the request through).
        let noted_degraded = note.verdict.as_ref().and_then(|v| v.degraded);
        let mut verdict = match (outcome.kind, note.verdict) {
            (TrafficKind::Verdict, _) => outcome.verdict,
            (_, Some(noted))
                if outcome.verdict.is_refinable()
                    && noted.action > VerdictAction::Allow
                    && noted.action >= outcome.verdict.action =>
            {
                TrafficVerdict {
                    code: outcome.verdict.code.or(noted.code),
                    ..noted
                }
            }
            _ => outcome.verdict,
        };
        // A block the error decided (`for_error`) keeps its own verdict, but
        // still joins on the event the detection site recorded.
        if verdict.event_id.is_none() && verdict.action > VerdictAction::Allow {
            verdict.event_id = noted_event;
        }
        verdict.degraded = verdict.degraded.or(noted_degraded);
        let route = current_route().or(note.route);
        let latency = record.latency_ms;
        let (screen_ms, upstream_ms) = match (outcome.kind, note.screen_ms) {
            (TrafficKind::Verdict, _) => (None, None),
            (TrafficKind::CacheHit, screen) => (screen, None),
            (_, Some(screen)) => (Some(screen), Some(latency.saturating_sub(screen))),
            (TrafficKind::Failure, None) if verdict.decided_by != DecidedBy::None => {
                (Some(latency), None)
            }
            _ => (None, None),
        };
        let origin = credential_origin(custody, &record.provider, route.as_deref(), outcome.kind);
        let Some(object) = event.as_object_mut() else {
            return event;
        };
        // On the fleet any content block or rewrite gets the fixed summary,
        // even when its layer could not be attributed: the block message names
        // the matched pattern, which may be the platform floor's.
        let withholds = verdict.decided_by.withholds_reason()
            || (custody.is_fleet()
                && verdict.action > VerdictAction::Allow
                && matches!(
                    verdict.decided_by,
                    DecidedBy::Node | DecidedBy::Org | DecidedBy::Agent
                ));
        if withholds && record.error.is_some() {
            object.insert(
                "error".to_owned(),
                json!(format!(
                    "{} by {}",
                    verdict.action.past_tense(),
                    verdict.decided_by.as_str()
                )),
            );
        }
        object.insert("kind".to_owned(), json!(outcome.kind));
        object.insert("route".to_owned(), json!(route));
        object.insert("custody".to_owned(), json!(custody));
        object.insert("credential_origin".to_owned(), json!(origin));
        object.insert("status".to_owned(), json!(outcome.status));
        object.insert("verdict".to_owned(), json!(verdict));
        object.insert(
            "stage_latency_ms".to_owned(),
            json!({ "screen": screen_ms, "upstream": upstream_ms }),
        );
        event
    }
}

/// Whose credential the row spent, as a wire string of the spec's
/// `CredentialOrigin` (section 00.3). Attempts do not carry an origin yet, so
/// this is derived from custody and the provider tag, failing toward Ryu's
/// own credentials on the fleet: `unknown` before any upstream was bound,
/// `local` for a node engine or a cache hit, `caller_subscription` on the
/// passthrough routes, `ryu_fallback` for the Ryu-held aggregator,
/// `ryu_vault` for any other fleet attempt, and `node_operator` elsewhere.
fn credential_origin(
    custody: GatewayCustody,
    provider: &str,
    route: Option<&str>,
    kind: TrafficKind,
) -> &'static str {
    match kind {
        TrafficKind::Verdict => return "unknown",
        TrafficKind::CacheHit => return "local",
        TrafficKind::Completion | TrafficKind::Failure => {}
    }
    if provider.is_empty() || MARKER_PROVIDERS.contains(&provider) {
        return "unknown";
    }
    if route.is_some_and(|route| route.starts_with("/passthrough/")) {
        return "caller_subscription";
    }
    if LOCAL_PROVIDERS.contains(&provider) {
        return "local";
    }
    match custody {
        GatewayCustody::Fleet if provider == "vercel" => "ryu_fallback",
        GatewayCustody::Fleet => "ryu_vault",
        GatewayCustody::ManagedNode | GatewayCustody::SelfHosted => "node_operator",
    }
}

/// The custom pattern names each firewall layer contributes to a request,
/// and whether a binding platform floor turns inbound scanning on.
#[derive(Debug, Default)]
pub(crate) struct FirewallLayers {
    pub floor_scans_inbound: bool,
    pub floor_patterns: Vec<String>,
    /// Org and team overlays: both are the tenant's org policy.
    pub org_patterns: Vec<String>,
    pub agent_patterns: Vec<String>,
    /// The node base and the node's own per-request rules.
    pub node_patterns: Vec<String>,
}

/// Which layer owns a firewall match, broadest first. A custom pattern
/// belongs to the layer that declared it. A curated pattern (PII, secrets and
/// the like) is the platform floor's when a binding floor scans inbound,
/// because the floor locks those dials on; otherwise it is the node's.
pub(crate) fn firewall_layer(pattern_name: &str, layers: &FirewallLayers) -> DecidedBy {
    let declares = |names: &[String]| names.iter().any(|name| name == pattern_name);
    if declares(&layers.floor_patterns) {
        DecidedBy::PlatformFloor
    } else if declares(&layers.org_patterns) {
        DecidedBy::Org
    } else if declares(&layers.agent_patterns) {
        DecidedBy::Agent
    } else if declares(&layers.node_patterns) || !layers.floor_scans_inbound {
        DecidedBy::Node
    } else {
        DecidedBy::PlatformFloor
    }
}

/// The verdict for one firewall match. A floor decision names the detection
/// kind only: floor pattern names never reach a tenant (spec 00.7).
pub(crate) fn firewall_verdict(
    pattern_name: &str,
    kind: &crate::firewall::DetectionKind,
    layers: &FirewallLayers,
    action: VerdictAction,
) -> TrafficVerdict {
    let decided_by = firewall_layer(pattern_name, layers);
    let detector = if decided_by == DecidedBy::PlatformFloor {
        kind.as_str()
    } else {
        pattern_name
    };
    TrafficVerdict::new(decided_by, action).with_detector(detector)
}

/// Who may read which events from `GET /v1/traffic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrafficScope {
    /// Every event: the master key, or the local operator.
    All,
    /// Only events whose `org_id` is this org. Events with no org never match.
    Org(String),
}

impl TrafficScope {
    /// Resolve the scope for a caller. The master key sees every org and may
    /// narrow to one with `?org=`. Any other caller bound to an org is pinned
    /// to it, and asking for another org is refused. A caller with no org (the
    /// local operator on a node without one) sees everything, as before, and
    /// may narrow the same way.
    pub fn for_caller(
        is_master_key: bool,
        caller_org: Option<&str>,
        requested_org: Option<&str>,
    ) -> Result<Self, GatewayError> {
        let requested = match requested_org {
            None => None,
            Some(org) if is_plain_org_id(org) => Some(org),
            Some(_) => {
                return Err(GatewayError::BadRequest(
                    "org must be an organization id of 1 to 256 printable characters.".to_owned(),
                ))
            }
        };
        match (is_master_key, caller_org, requested) {
            (true, _, Some(org)) | (false, None, Some(org)) => Ok(Self::Org(org.to_owned())),
            (true, _, None) | (false, None, None) => Ok(Self::All),
            (false, Some(own), None) => Ok(Self::Org(own.to_owned())),
            (false, Some(own), Some(org)) if own == org => Ok(Self::Org(own.to_owned())),
            (false, Some(_), Some(_)) => Err(GatewayError::PolicyViolation(
                "Live traffic for another organization is not visible to this credential."
                    .to_owned(),
            )),
        }
    }

    pub fn admits(&self, event: &Value) -> bool {
        match self {
            Self::All => true,
            Self::Org(org) => event.get("org_id").and_then(Value::as_str) == Some(org.as_str()),
        }
    }
}

fn is_plain_org_id(org: &str) -> bool {
    !org.is_empty() && org.len() <= 256 && org.trim() == org && !org.chars().any(char::is_control)
}

/// Build the redacted live-traffic event for an audit record. The API key is
/// truncated to its leading characters (mirroring the audit query path); the
/// raw key never leaves the process. [`TrafficBus::enrich`] adds the verdict
/// fields and [`TrafficBus::publish`] the sequence number.
pub fn traffic_event(record: &AuditRecord) -> Value {
    let team_ids: Option<Vec<&str>> = record.team_ids.as_deref().map(|teams| {
        teams
            .split(',')
            .map(str::trim)
            .filter(|team| !team.is_empty())
            .collect()
    });
    json!({
        "request_id": record.request_id,
        "api_key": if record.event_type == crate::audit::EventType::ServiceCall {
            crate::audit::credential_log_id(&record.api_key)
        } else { redact_key(&record.api_key) },
        "provider": record.provider,
        "model": (record.event_type != crate::audit::EventType::ServiceCall).then_some(record.model.as_str()),
        "input_tokens": record.input_tokens,
        "output_tokens": record.output_tokens,
        "cache_hit": record.cache_hit,
        "latency_ms": record.latency_ms,
        "error": record.error,
        "event_type": record.event_type.as_str(),
        "session_id": record.session_id,
        "user_id": record.user_id,
        "agent_id": record.agent_id,
        "managed_inference": record.managed_inference,
        "provider_cost_micro_usd": record.provider_cost_micro_usd,
        "org_id": record.org_id,
        "team_ids": team_ids,
        "credential_id_prefix": record.key_id.as_deref().map(redact_credential_id),
        "ts": chrono::Utc::now().to_rfc3339(),
    })
}

/// Safe service projection; callers may supply a raw record, but it is always
/// normalized before building the broadcast payload. No source request data is
/// copied into this envelope, and the private key is hashed exactly once here.
pub fn service_traffic_event(
    record: &AuditRecord,
    usage: &crate::audit::AuditServiceUsage,
) -> Result<Value, crate::audit::ServiceAuditError> {
    let safe = crate::audit::normalize_service_audit_record(record.clone(), usage)?;
    let mut event = traffic_event(&safe);
    if let Some(object) = event.as_object_mut() {
        object.insert("command".to_owned(), json!(safe.command));
        object.insert("service_usage".to_owned(), json!(usage));
    }
    Ok(event)
}

/// Truncate a key to its visible prefix, mirroring the audit query path. Keys
/// shorter than the prefix are fully masked.
fn redact_key(key: &str) -> String {
    const PREFIX: usize = 6;
    match key.get(..PREFIX) {
        Some(prefix) if key.len() > PREFIX => format!("{prefix}***"),
        _ => "***".to_string(),
    }
}

/// Truncate a hosted credential id to its visible prefix.
fn redact_credential_id(id: &str) -> String {
    match id.get(..CREDENTIAL_ID_PREFIX) {
        Some(prefix) if id.len() > CREDENTIAL_ID_PREFIX => format!("{prefix}***"),
        _ => "***".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::EventType;

    #[test]
    fn service_broadcast_has_usage_but_never_query_model_error_or_credential_prefix() {
        let mut record = sample_record("service-live", Some("https://private.example/?key=secret"));
        record.provider = "tavily".into();
        record.command = Some("web.search".into());
        record.model = "private-query".into();
        let usage = crate::audit::AuditServiceUsage {
            requests: 1,
            documents: 0,
            provider_credits: Some(0),
            cost_source: crate::audit::AuditServiceCostSource::Unpriced,
            cost_is_estimate: true,
        };
        let event = service_traffic_event(&record, &usage).unwrap();
        assert_eq!(event["event_type"], "service_call");
        assert!(event["model"].is_null());
        assert_eq!(event["input_tokens"], 0);
        assert_eq!(event["output_tokens"], 0);
        assert_eq!(event["service_usage"]["provider_credits"], 0);
        assert_eq!(event["error"], "service_request_failed");
        let serialized = event.to_string();
        for private in ["private-query", "https://private.example", "sk-secret"] {
            assert!(!serialized.contains(private));
        }
        assert_eq!(
            event["api_key"],
            crate::audit::credential_log_id(&record.api_key)
        );
        assert_eq!(record.api_key, "sk-secret-1234567890");
    }

    fn sample_record(request_id: &str, error: Option<&str>) -> AuditRecord {
        AuditRecord {
            key_id: None,
            request_id: request_id.to_string(),
            api_key: "sk-secret-1234567890".to_string(),
            user_name: Some("alice".to_string()),
            org_id: Some("org-1".to_string()),
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "openai".to_string(),
            model: "gpt-4o".to_string(),
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            latency_ms: 42,
            eval_score: None,
            error: error.map(|e| e.to_string()),
            skill_ids: None,
            session_id: Some("sess-1".to_string()),
            event_type: EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            user_id: None,
            agent_id: None,
            feature: None,
            purpose: None,
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: None,
        }
    }

    #[test]
    fn live_subscriber_receives_published_events() {
        let bus = TrafficBus::new();
        let mut rx = bus.subscribe();
        bus.publish(json!({ "request_id": "r1", "model": "gpt-4o" }));
        let got = rx.blocking_recv().unwrap();
        assert_eq!(got["request_id"], "r1");
        assert_eq!(got["model"], "gpt-4o");
    }

    #[test]
    fn ring_is_bounded() {
        let bus = TrafficBus::new();
        for i in 0..(RING_CAPACITY + 50) {
            bus.publish(json!({ "i": i }));
        }
        let recent = bus.recent();
        assert_eq!(recent.len(), RING_CAPACITY);
        assert_eq!(recent[0]["i"], 50);
        assert_eq!(recent.last().unwrap()["i"], RING_CAPACITY + 49);
    }

    #[test]
    fn recent_snapshot_matches_publish_order() {
        let bus = TrafficBus::new();
        bus.publish(json!({ "request_id": "r1" }));
        bus.publish(json!({ "request_id": "r2" }));
        let recent = bus.recent();
        assert_eq!(recent[0]["request_id"], "r1");
        assert_eq!(recent[1]["request_id"], "r2");
    }

    #[test]
    fn event_redacts_key() {
        let e = traffic_event(&sample_record("req-1", None));
        assert_eq!(e["api_key"], "sk-sec***");
        assert_eq!(e["model"], "gpt-4o");
        assert_eq!(e["event_type"], "model_call");
        assert!(e["ts"].is_string());
        assert!(e.get("api_key").unwrap().as_str().unwrap().contains("***"));
    }
}

#[cfg(test)]
#[path = "traffic_tests.rs"]
mod verdict_tests;

#[cfg(test)]
#[path = "traffic_probe_tests.rs"]
mod probe_tests;
