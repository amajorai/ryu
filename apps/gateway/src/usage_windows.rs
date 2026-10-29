//! Per-credential usage windows (managed guardrails spec 04.4).
//!
//! Every model-call audit row a Ryu-operated Gateway (`Fleet` or
//! `ManagedNode` custody) records for a hosted credential is folded into an
//! in-memory window for that credential and the UTC minute the row completed
//! in. Once the minute closes, the reporter (`reporter::windows`) queues the
//! window in the violation outbox and posts it to `POST /api/abuse/ingest`.
//! A `SelfHosted` Gateway never folds a row: Ryu enforcement never binds
//! self-hosted or BYOK nodes, so they report no windows.
//!
//! What a window counts:
//! - `requests`: distinct request ids seen in the minute. Auxiliary rows a
//!   request writes under its own id (an inspector or evaluator call, a
//!   tool round, a guardrail verdict row) fold into that request instead of
//!   adding one. A request whose rows straddle a minute boundary counts once
//!   in each minute.
//! - Each request's outcome is its strongest verdict across its rows, as the
//!   live traffic feed resolved it: `outcomes` counts requests by
//!   `(decidedBy, action)`, with the short S-codes (or taxonomy ids) each
//!   carried. `blocked`, `floorBlocks`, `overCap` and `deadlineDegraded`
//!   derive from the same verdicts.
//! - `floorBlocks` counts only the floor's content decisions (detector D11,
//!   floor probing). A floor refusal for Ryu's own screening health or
//!   capacity (`screening_unavailable`, `screening_degraded_throttle`,
//!   `screening_capacity_exceeded`), for media it cannot screen, or for a
//!   platform lock is never one: a classifier outage must not read as every
//!   credential probing the floor.
//!   Capacity refusals count in `overCap` alone.
//! - `deadlineDegraded` counts every request the screen ran deadline bound
//!   for, the allowed ones included.
//! - Tokens and charged cost sum every row, auxiliary calls included,
//!   because they spent the credential.
//! - `providers`, `models` and `latencyMsBuckets` count each request once, by
//!   its first upstream (non-marker) provider and the longest terminal row.
//!
//! A window carries only what the live traffic event already carries: no
//! prompt text, no raw key, no client address. Fields whose sources are not
//! wired yet (client IP and user agent hashes, end users, system prompt
//! hashes, extraction and rubric hits, max-tokens p95, simhashes) are sent
//! as zero or empty.
//!
//! `outcomes`, `providers` and `latencyMsBuckets` are additive to the
//! committed wire contract (`packages/api/src/lib/abuse/usage-windows.ts`),
//! which strips keys it does not declare: they reach storage only once the
//! control plane adds them.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, PoisonError};

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::audit::{AuditRecord, EventType};
use crate::custody::GatewayCustody;

/// Longest credential id the ingest route accepts.
const MAX_CREDENTIAL_ID_CHARS: usize = 128;
/// Longest model, provider or user agent name the ingest route accepts.
const MAX_NAME_BYTES: usize = 256;
/// Distinct models per window (the ingest route's cap).
pub const MAX_MODELS: usize = 32;
/// Distinct providers per window.
pub const MAX_PROVIDERS: usize = 32;
/// Distinct categories per outcome entry.
pub const MAX_OUTCOME_CATEGORIES: usize = 32;
/// The name every key past a cap is counted under.
pub const OTHER_KEY: &str = "(other)";
/// Requests one window tracks by id. Past this, each new request's rows are
/// counted as they arrive, without folding auxiliary rows into it.
const MAX_TRACKED_REQUESTS: usize = 4096;
/// Open windows held at once (credentials times open minutes). Past this,
/// rows for a new credential are dropped and counted.
const MAX_OPEN_WINDOWS: usize = 20_000;
/// Upper bounds of the latency buckets, in milliseconds. A last bucket with
/// no bound counts everything slower.
pub const LATENCY_BUCKETS_MS: [u64; 9] =
    [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

/// Audit `provider` tags written by guardrail and accounting rows rather
/// than an upstream (the same list the traffic feed uses).
const MARKER_PROVIDERS: &[&str] = &[
    "none",
    "credits-debit",
    "evaluator",
    "inspector",
    "firewall",
    "companion-dlp",
    "gateway",
];

/// The traffic `code` of a request refused for screening capacity (413).
const OVER_CAP_CODE: &str = "screening_capacity_exceeded";
/// The traffic `degraded` reason of a deadline-bound screen.
const DEADLINE_DEGRADED: &str = "deadline";
/// The catalogue codes of a platform floor refusal that is not a content
/// decision: Ryu's own screening health or capacity, media the floor cannot
/// screen, and platform locks. A floor block with one of these never counts
/// in `floorBlocks`. Any other floor block does, a code-less one (a verdict
/// row ahead of its failure row) and a floor firewall match
/// (`policy_violation`) included.
const FLOOR_NON_CONTENT_CODES: &[&str] = &[
    "screening_unavailable",
    "screening_degraded_throttle",
    OVER_CAP_CODE,
    "media_unscreenable",
    "feature_not_permitted",
    "platform_locked",
];

/// One credential's closed minute, the camelCase `UsageWindowWire` of the
/// ingest route plus the additive breakdown fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub credential_id: String,
    /// The closed UTC minute, `YYYY-MM-DDTHH:MM:00Z`.
    pub minute: String,
    pub requests: u32,
    pub blocked: u32,
    pub floor_blocks: u32,
    pub over_cap: u32,
    pub deadline_degraded: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_micro_usd: u64,
    pub models: BTreeMap<String, u32>,
    pub client_ip_hashes: Vec<String>,
    pub user_agent_families: BTreeMap<String, u32>,
    pub end_users_seen: u32,
    pub missing_end_user: u32,
    pub system_prompt_hashes: u32,
    pub extraction_hits: u32,
    pub rubric_hits: u32,
    pub max_tokens_p95: Option<u32>,
    pub simhashes: Vec<(String, u32)>,
    /// Requests by deciding layer and action (additive).
    #[serde(default)]
    pub outcomes: Vec<OutcomeCount>,
    /// Requests by upstream provider (additive).
    #[serde(default)]
    pub providers: BTreeMap<String, u32>,
    /// Requests by latency bucket, only non-empty buckets (additive).
    #[serde(default)]
    pub latency_ms_buckets: Vec<LatencyBucket>,
}

/// Requests one layer decided with one action.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeCount {
    /// The traffic feed's `decided_by` (`none` for an allowed request).
    pub decided_by: String,
    /// `allow`, `warn`, `sanitize` or `block`.
    pub action: String,
    pub requests: u32,
    /// Requests per short S-code or taxonomy id. One request may carry
    /// several, so these can add up to more than `requests`.
    #[serde(default)]
    pub categories: BTreeMap<String, u32>,
}

/// Requests whose latency was at most `le_ms` and above the previous bound.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyBucket {
    /// `None` for the last, unbounded bucket.
    pub le_ms: Option<u64>,
    pub requests: u32,
}

/// The verdict fields of an enriched traffic event.
#[derive(Debug, Clone, Default, Deserialize)]
struct VerdictView {
    #[serde(default)]
    decided_by: String,
    #[serde(default)]
    action: String,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    degraded: Option<String>,
}

fn action_rank(action: &str) -> u8 {
    match action {
        "warn" => 1,
        "sanitize" => 2,
        "block" => 3,
        _ => 0,
    }
}

/// What one request contributed to a window.
#[derive(Debug, Clone, Default)]
struct RequestSlot {
    decided_by: Option<String>,
    action: Option<String>,
    categories: Vec<String>,
    over_cap: bool,
    deadline_degraded: bool,
    /// A platform floor block carried a non-content refusal code
    /// ([`FLOOR_NON_CONTENT_CODES`]).
    floor_non_content: bool,
    /// A completion, cache hit or failure row was seen.
    terminal: bool,
    latency_ms: u64,
    provider: Option<String>,
    model: Option<String>,
}

impl RequestSlot {
    fn merge(&mut self, kind: &str, verdict: &VerdictView, record: &AuditRecord) {
        let rank = action_rank(&verdict.action);
        let current = self.action.as_deref().map_or(0, action_rank);
        if self.action.is_none() || rank > current {
            self.action = Some(if rank == 0 {
                "allow".to_owned()
            } else {
                verdict.action.clone()
            });
            self.decided_by = Some(if rank == 0 {
                "none".to_owned()
            } else {
                verdict.decided_by.clone()
            });
            self.categories = verdict.categories.clone();
        }
        self.over_cap |= verdict.code.as_deref() == Some(OVER_CAP_CODE);
        self.deadline_degraded |= verdict.degraded.as_deref() == Some(DEADLINE_DEGRADED);
        self.floor_non_content |= verdict.decided_by == "platform_floor"
            && verdict.action == "block"
            && verdict
                .code
                .as_deref()
                .is_some_and(|code| FLOOR_NON_CONTENT_CODES.contains(&code));
        if kind != "verdict" {
            self.terminal = true;
            self.latency_ms = self.latency_ms.max(record.latency_ms);
            if self.provider.is_none() && is_upstream_provider(&record.provider) {
                self.provider = Some(display_provider(record));
                self.model = Some(display_model(record));
            }
        }
    }
}

fn is_upstream_provider(provider: &str) -> bool {
    !provider.is_empty() && !MARKER_PROVIDERS.contains(&provider)
}

/// The provider usage analytics may show: a Ryu Router slot is `ryu`.
fn display_provider(record: &AuditRecord) -> String {
    if record.managed_inference && crate::credit_pools::is_ryu_router_slot(&record.provider) {
        "ryu".to_owned()
    } else {
        record.provider.clone()
    }
}

fn display_model(record: &AuditRecord) -> String {
    crate::pipeline::model_alias::display_model(&record.provider, &record.model).into_owned()
}

/// `text` cut to at most [`MAX_NAME_BYTES`] on a character boundary.
fn bounded_name(text: &str) -> String {
    let mut end = text.len().min(MAX_NAME_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// Count `key` in `map`, folding any key past `cap` into [`OTHER_KEY`]. The
/// fold keeps the map within `cap` keys.
fn bump(map: &mut BTreeMap<String, u32>, key: &str, cap: usize) {
    let key = bounded_name(key);
    if key.is_empty() {
        return;
    }
    let slot = if map.contains_key(&key) || map.len() < cap.saturating_sub(1) {
        key
    } else {
        OTHER_KEY.to_owned()
    };
    let count = map.entry(slot).or_insert(0);
    *count = count.saturating_add(1);
}

/// One open window.
#[derive(Debug, Default)]
struct WindowAcc {
    slots: HashMap<String, RequestSlot>,
    /// Requests past [`MAX_TRACKED_REQUESTS`], counted as they arrived.
    untracked: Vec<RequestSlot>,
    input_tokens: u64,
    output_tokens: u64,
    cost_micro_usd: u64,
}

impl WindowAcc {
    fn into_window(self, credential_id: String, minute: String) -> UsageWindow {
        let mut window = UsageWindow {
            credential_id,
            minute,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cost_micro_usd: self.cost_micro_usd,
            ..UsageWindow::default()
        };
        let mut outcomes: BTreeMap<(String, String), OutcomeCount> = BTreeMap::new();
        let mut latency = [0u32; LATENCY_BUCKETS_MS.len() + 1];
        for slot in self.slots.into_values().chain(self.untracked) {
            window.requests = window.requests.saturating_add(1);
            let action = slot.action.unwrap_or_else(|| "allow".to_owned());
            let decided_by = slot.decided_by.unwrap_or_else(|| "none".to_owned());
            if action == "block" {
                window.blocked = window.blocked.saturating_add(1);
                if decided_by == "platform_floor" && !slot.floor_non_content {
                    window.floor_blocks = window.floor_blocks.saturating_add(1);
                }
            }
            window.over_cap = window.over_cap.saturating_add(u32::from(slot.over_cap));
            window.deadline_degraded = window
                .deadline_degraded
                .saturating_add(u32::from(slot.deadline_degraded));
            let entry = outcomes
                .entry((decided_by.clone(), action.clone()))
                .or_insert_with(|| OutcomeCount {
                    decided_by,
                    action,
                    ..OutcomeCount::default()
                });
            entry.requests = entry.requests.saturating_add(1);
            for category in &slot.categories {
                bump(&mut entry.categories, category, MAX_OUTCOME_CATEGORIES);
            }
            if let Some(provider) = slot.provider.as_deref() {
                bump(&mut window.providers, provider, MAX_PROVIDERS);
            }
            if let Some(model) = slot.model.as_deref() {
                bump(&mut window.models, model, MAX_MODELS);
            }
            if slot.terminal {
                let index = LATENCY_BUCKETS_MS
                    .iter()
                    .position(|bound| slot.latency_ms <= *bound)
                    .unwrap_or(LATENCY_BUCKETS_MS.len());
                latency[index] = latency[index].saturating_add(1);
            }
        }
        window.outcomes = outcomes.into_values().collect();
        window.latency_ms_buckets = latency
            .iter()
            .enumerate()
            .filter(|(_, count)| **count > 0)
            .map(|(index, count)| LatencyBucket {
                le_ms: LATENCY_BUCKETS_MS.get(index).copied(),
                requests: *count,
            })
            .collect();
        window
    }
}

#[derive(Debug, Default)]
struct Inner {
    /// Open windows by `(minute start in epoch seconds, credential id)`.
    open: BTreeMap<(i64, String), WindowAcc>,
    /// The latest minute already drained. A row never lands in it or before
    /// it, so a drained window is never reopened with different counts.
    last_drained: Option<i64>,
    /// Rows dropped because [`MAX_OPEN_WINDOWS`] windows were open.
    dropped_rows: u64,
}

/// The open usage windows of this process.
#[derive(Debug, Default)]
pub struct UsageWindows {
    inner: Mutex<Inner>,
}

/// The start of the UTC minute holding `at`, in epoch seconds.
fn minute_of(at: DateTime<Utc>) -> i64 {
    at.timestamp().div_euclid(60) * 60
}

/// The wire form of a minute start: `YYYY-MM-DDTHH:MM:00Z`.
pub fn minute_wire(minute_secs: i64) -> String {
    Utc.timestamp_opt(minute_secs, 0)
        .single()
        .map(|at| at.format("%Y-%m-%dT%H:%M:00Z").to_string())
        .unwrap_or_default()
}

impl UsageWindows {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one audit row and its enriched traffic event into the window of
    /// its credential and the current minute. `cost_micro_usd` is the row's
    /// charged cost, `None` for a row that spent no Ryu balance.
    pub fn observe(
        &self,
        custody: GatewayCustody,
        record: &AuditRecord,
        event: &Value,
        cost_micro_usd: Option<u64>,
    ) {
        self.observe_at(Utc::now(), custody, record, event, cost_micro_usd);
    }

    pub(crate) fn observe_at(
        &self,
        now: DateTime<Utc>,
        custody: GatewayCustody,
        record: &AuditRecord,
        event: &Value,
        cost_micro_usd: Option<u64>,
    ) {
        if !reports_windows(custody) || record.event_type != EventType::ModelCall {
            return;
        }
        let Some(credential_id) = record
            .key_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.chars().count() <= MAX_CREDENTIAL_ID_CHARS)
        else {
            return;
        };
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("completion");
        let verdict: VerdictView = event
            .get("verdict")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        // An allowing verdict row says nothing a later row does not.
        let counts_request = kind != "verdict" || action_rank(&verdict.action) > 0;
        let spends =
            record.input_tokens > 0 || record.output_tokens > 0 || cost_micro_usd.is_some();
        if !counts_request && !spends {
            return;
        }

        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let mut minute = minute_of(now);
        if let Some(drained) = inner.last_drained {
            minute = minute.max(drained + 60);
        }
        let key = (minute, credential_id.to_owned());
        if !inner.open.contains_key(&key) && inner.open.len() >= MAX_OPEN_WINDOWS {
            inner.dropped_rows = inner.dropped_rows.saturating_add(1);
            if inner.dropped_rows.is_power_of_two() {
                tracing::warn!(
                    dropped = inner.dropped_rows,
                    "usage windows: too many open windows, rows dropped"
                );
            }
            return;
        }
        let window = inner.open.entry(key).or_default();
        window.input_tokens = window.input_tokens.saturating_add(record.input_tokens);
        window.output_tokens = window.output_tokens.saturating_add(record.output_tokens);
        window.cost_micro_usd = window
            .cost_micro_usd
            .saturating_add(cost_micro_usd.unwrap_or(0));
        if !counts_request {
            return;
        }
        let request_id = record.request_id.as_str();
        if let Some(slot) = window.slots.get_mut(request_id) {
            slot.merge(kind, &verdict, record);
        } else if window.slots.len() < MAX_TRACKED_REQUESTS && !request_id.is_empty() {
            let mut slot = RequestSlot::default();
            slot.merge(kind, &verdict, record);
            window.slots.insert(request_id.to_owned(), slot);
        } else {
            let mut slot = RequestSlot::default();
            slot.merge(kind, &verdict, record);
            window.untracked.push(slot);
        }
    }

    /// Close and return every window whose minute ended before `now`, oldest
    /// first. A row arriving later for a drained minute lands in the next
    /// open minute instead.
    pub fn drain_closed(&self, now: DateTime<Utc>) -> Vec<UsageWindow> {
        let current = minute_of(now);
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let still_open = inner.open.split_off(&(current, String::new()));
        let closed = std::mem::replace(&mut inner.open, still_open);
        if let Some(((latest, _), _)) = closed.last_key_value() {
            inner.last_drained = Some(inner.last_drained.map_or(*latest, |d| d.max(*latest)));
        }
        closed
            .into_iter()
            .map(|((minute, credential_id), acc)| {
                acc.into_window(credential_id, minute_wire(minute))
            })
            .collect()
    }

    /// Windows still open.
    #[cfg(test)]
    pub(crate) fn open_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .open
            .len()
    }
}

/// Whether a Gateway with this custody reports usage windows: only the
/// Ryu-operated ones. A self-hosted or BYOK node is never bound by Ryu.
pub const fn reports_windows(custody: GatewayCustody) -> bool {
    matches!(custody, GatewayCustody::Fleet | GatewayCustody::ManagedNode)
}

/// Whether this Gateway folds and sends windows at all: a Ryu-operated
/// custody with a control plane and a key to report with. The same gate
/// spawns the window task, so rows are never folded with nothing to drain
/// them.
pub fn window_reporting_active(
    custody: GatewayCustody,
    control_plane: &crate::config::ControlPlaneConfig,
) -> bool {
    reports_windows(custody) && control_plane.enabled && control_plane.gateway_key.is_some()
}

#[cfg(test)]
#[path = "usage_windows_tests.rs"]
mod tests;
