use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use dashmap::DashMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

pub mod violation;
pub use violation::{
    dedupe_key, ActorKind, DetectorKind, DetectorRef, EnforcementAction, EnforcementMode, FailMode,
    OutboxRow, PolicyLayer, PolicyRef, RecordOutcome, Severity, SpendOwner, ViolationDirection,
    ViolationEvent, ViolationOutbox, WindowMaintenance, WindowRecord, WindowRow,
    DEFAULT_MAX_WINDOW_ROWS, USAGE_WINDOW_REPORT_CURSOR,
};

// ─── Audit config (moved verbatim from gateway `config.rs`) ──────────────────
//
// The serde-shaped config the logger consumes. It lives here (not in gateway
// `config.rs`) so this stage crate is self-contained; gateway `config.rs`
// re-exports it so `crate::config::AuditConfig` paths are unchanged and
// `GatewayConfig` still embeds `audit`.

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuditConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Path to the SQLite database file. Defaults to `$RYU_DIR/db/audit.db` when
    /// `RYU_DIR` is set, otherwise the profile's `$XDG_DATA_HOME/ryu<sfx>/audit.db`
    /// (or `~/.local/share/ryu<sfx>/audit.db`). A runtime `RYU_AUDIT_DB_PATH` override
    /// may replace an inherited configured path for a profile-isolated child.
    #[serde(default = "default_audit_db_path")]
    pub db_path: String,
}

/// Runtime override used by Core when it spawns a profile-isolated Gateway.
/// The child may inherit an older `gateway.toml` whose absolute `db_path` points
/// at another profile; this override keeps audit records beside the active Core
/// data without rewriting the operator's file.
pub const AUDIT_DB_PATH_ENV: &str = "RYU_AUDIT_DB_PATH";

/// The local retention policy applied when an audit database opens. A value of
/// `None` means that limit is disabled. The policy is intentionally environment
/// based so existing `AuditConfig` literals and gateway TOML remain backward
/// compatible while operators can bound local storage on self-hosted nodes.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct AuditRetentionPolicy {
    pub retention_days: Option<u64>,
    pub max_rows: Option<u64>,
}

/// Result of one local retention pass.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct AuditPruneSummary {
    pub deleted_rows: u64,
    pub retention_days: Option<u64>,
    pub max_rows: Option<u64>,
}

const DEFAULT_RETENTION_DAYS: u64 = 90;
const DEFAULT_MAX_ROWS: u64 = 1_000_000;

fn audit_retention_policy() -> AuditRetentionPolicy {
    let parse = |name: &str, fallback: u64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|value| if value == 0 { None } else { Some(value) })
            .unwrap_or(Some(fallback))
    };
    AuditRetentionPolicy {
        retention_days: parse("RYU_AUDIT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
        max_rows: parse("RYU_AUDIT_MAX_ROWS", DEFAULT_MAX_ROWS),
    }
}

fn default_true() -> bool {
    true
}

fn default_audit_db_path() -> String {
    let ryu_dir = std::env::var_os("RYU_DIR")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    let data_local_dir = dirs::data_local_dir();
    let profile = std::env::var("RYU_PROFILE").ok();
    default_audit_db_path_for(
        ryu_dir.as_deref(),
        data_local_dir.as_deref(),
        &profile_dir_suffix(profile.as_deref()),
    )
}

/// The data-dir suffix for a `RYU_PROFILE` value: `""` for release (unset,
/// empty, or `release`), `-<profile>` otherwise. Mirrors the Gateway's
/// `profile::suffix()` (which also rejects unknown names at startup), so a
/// standalone dev Gateway keeps its audit log and the `spend.db` budget
/// counters beside it apart from a release Gateway on the same machine.
fn profile_dir_suffix(profile: Option<&str>) -> String {
    let name = profile
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ryu_sidecar_runtime::RELEASE_PROFILE.to_owned());
    ryu_sidecar_runtime::profile_suffix_for(&name)
}

/// Resolve the default audit path. Under Core (`RYU_DIR` set) it is the data
/// dir's `db/audit.db`; a standalone gateway uses its profile's own
/// `<data_local>/ryu<sfx>/audit.db`, so a dev gateway never shares the release
/// audit log. Pure so the profile boundary is testable without mutating
/// process-global environment during parallel tests.
fn default_audit_db_path_for(
    ryu_dir: Option<&Path>,
    data_local_dir: Option<&Path>,
    profile_suffix: &str,
) -> String {
    let path = ryu_dir
        .map(|dir| ryu_sidecar_runtime::layout::db_file(dir, "audit.db"))
        .or_else(|| {
            data_local_dir.map(|dir| dir.join(format!("ryu{profile_suffix}")).join("audit.db"))
        });
    path.and_then(|value| value.to_str().map(str::to_owned))
        .unwrap_or_else(|| "audit.db".to_owned())
}

fn audit_db_path_for(configured: &str, override_path: Option<&str>) -> String {
    override_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or(configured)
        .to_owned()
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            db_path: default_audit_db_path(),
        }
    }
}

/// Discriminator that tells the audit store which kind of event this row represents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    /// A model/LLM completion request (the original event shape).
    ModelCall,
    /// A non-model sandbox or MCP tool execution.
    ExecCall,
    /// A sealed identity-vault credential read (#523). Distinct from `ExecCall`
    /// so identity reads are filterable and never drain the sandbox exec budget.
    CredentialRead,
    /// A widget-initiated `sendFollowUpMessage` injected as a user turn (Ryu
    /// Apps, §4.4). Distinct from `ExecCall` so widget follow-ups are filterable
    /// on their own and never look like a sandbox/tool execution.
    WidgetFollowUp,
    /// An administrative gateway control change (config, policy, key, or
    /// similar control-plane mutation). It carries no model token usage.
    ControlChange,
    /// Direct Gateway web service work; neither model nor sandbox execution.
    ServiceCall,
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ModelCall => "model_call",
            Self::ExecCall => "exec_call",
            Self::CredentialRead => "credential_read",
            Self::WidgetFollowUp => "widget_follow_up",
            Self::ControlChange => "control_change",
            Self::ServiceCall => "service_call",
        }
    }
}

impl Default for EventType {
    fn default() -> Self {
        Self::ModelCall
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditServiceCostSource {
    ProviderReported,
    ConfiguredEstimate,
    Unpriced,
    Unsettled,
}

impl AuditServiceCostSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderReported => "provider_reported",
            Self::ConfiguredEstimate => "configured_estimate",
            Self::Unpriced => "unpriced",
            Self::Unsettled => "unsettled",
        }
    }
    fn from_storage(value: &str) -> Option<Self> {
        match value {
            "provider_reported" => Some(Self::ProviderReported),
            "configured_estimate" => Some(Self::ConfiguredEstimate),
            "unpriced" => Some(Self::Unpriced),
            "unsettled" => Some(Self::Unsettled),
            _ => None,
        }
    }
}

/// Safe service units and monetary provenance. Contains no request payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditServiceUsage {
    pub requests: u64,
    pub documents: u64,
    pub provider_credits: Option<u64>,
    pub cost_source: AuditServiceCostSource,
    pub cost_is_estimate: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAuditError {
    InvalidOperation,
    InvalidProvider,
    InvalidUsage,
    UnsupportedBackend,
    QueueUnavailable,
}
impl std::fmt::Display for ServiceAuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidOperation => "service audit operation is invalid",
            Self::InvalidProvider => "service audit provider is invalid",
            Self::InvalidUsage => "service audit usage is invalid",
            Self::UnsupportedBackend => "audit backend does not support service usage",
            Self::QueueUnavailable => "service audit queue is unavailable",
        })
    }
}
impl std::error::Error for ServiceAuditError {}

/// One row for the writer thread. Only the row travels through the bounded
/// channel and stays best-effort; its lifetime counter increments are merged
/// into [`PendingCounters`] before it is queued, so a full queue or a failed
/// write drops the row but never the counters.
struct QueuedAudit {
    record: AuditRecord,
    service_usage: Option<AuditServiceUsage>,
}

/// Lifetime counter increments carried by audit rows: the per-key token totals
/// that back `token_budget_total` (reloaded on start) and the `audit_summary`
/// figures that shared-budget reconciliation reports as lifetime spend.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct CounterDeltas {
    /// Tokens per API-key storage key (see [`api_key_storage_key`]).
    key_tokens: HashMap<String, u64>,
    request_count: u64,
    error_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    reported_cost_micro_usd: u64,
    unpriced_input_tokens: u64,
    unpriced_output_tokens: u64,
}

impl CounterDeltas {
    /// The increments one audit row contributes to the lifetime counters.
    fn from_record(record: &AuditRecord) -> Self {
        let is_summary_row = !matches!(
            record.event_type,
            EventType::ControlChange | EventType::ServiceCall
        );
        let is_managed_model_call =
            record.event_type == EventType::ModelCall && record.managed_inference;
        let is_unpriced_managed = is_managed_model_call && record.provider_cost_micro_usd.is_none();
        let row_tokens = record.input_tokens.saturating_add(record.output_tokens);
        let mut key_tokens = HashMap::new();
        if row_tokens > 0 {
            key_tokens.insert(api_key_storage_key(&record.api_key), row_tokens);
        }
        let summary_only = |value: u64| if is_summary_row { value } else { 0 };
        let unpriced_only = |value: u64| if is_unpriced_managed { value } else { 0 };
        Self {
            key_tokens,
            request_count: u64::from(is_summary_row),
            error_count: u64::from(is_summary_row && record.error.is_some()),
            input_tokens: summary_only(record.input_tokens),
            output_tokens: summary_only(record.output_tokens),
            reported_cost_micro_usd: if is_managed_model_call {
                record.provider_cost_micro_usd.unwrap_or(0)
            } else {
                0
            },
            unpriced_input_tokens: unpriced_only(record.input_tokens),
            unpriced_output_tokens: unpriced_only(record.output_tokens),
        }
    }

    fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn merge(&mut self, other: Self) {
        for (key, tokens) in other.key_tokens {
            let total = self.key_tokens.entry(key).or_insert(0);
            *total = total.saturating_add(tokens);
        }
        self.request_count = self.request_count.saturating_add(other.request_count);
        self.error_count = self.error_count.saturating_add(other.error_count);
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reported_cost_micro_usd = self
            .reported_cost_micro_usd
            .saturating_add(other.reported_cost_micro_usd);
        self.unpriced_input_tokens = self
            .unpriced_input_tokens
            .saturating_add(other.unpriced_input_tokens);
        self.unpriced_output_tokens = self
            .unpriced_output_tokens
            .saturating_add(other.unpriced_output_tokens);
    }

    /// Add these increments to `key_token_totals` and `audit_summary` inside
    /// the caller's transaction.
    fn apply(&self, tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
        let sql = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
        {
            let mut upsert = tx.prepare_cached(
                "INSERT INTO key_token_totals (api_key, tokens) VALUES (?1, ?2)
                 ON CONFLICT (api_key) DO UPDATE SET tokens = tokens + excluded.tokens",
            )?;
            for (api_key, tokens) in &self.key_tokens {
                upsert.execute(params![api_key, sql(*tokens)])?;
            }
        }
        tx.execute(
            "UPDATE audit_summary SET
                 request_count = request_count + ?1,
                 error_count = error_count + ?2,
                 input_tokens = input_tokens + ?3,
                 output_tokens = output_tokens + ?4,
                 reported_cost_micro_usd = reported_cost_micro_usd + ?5,
                 unpriced_input_tokens = unpriced_input_tokens + ?6,
                 unpriced_output_tokens = unpriced_output_tokens + ?7
             WHERE singleton = 1",
            params![
                sql(self.request_count),
                sql(self.error_count),
                sql(self.input_tokens),
                sql(self.output_tokens),
                sql(self.reported_cost_micro_usd),
                sql(self.unpriced_input_tokens),
                sql(self.unpriced_output_tokens),
            ],
        )?;
        Ok(())
    }
}

/// Counter increments not yet written, coalesced across rows. Bounded by the
/// number of distinct API keys seen between two writes, not by request count.
type PendingCounters = Arc<Mutex<CounterDeltas>>;

/// Merge `deltas` into the pending set (new rows, or a failed write being
/// retried).
fn merge_pending(pending: &PendingCounters, deltas: CounterDeltas) {
    if deltas.is_empty() {
        return;
    }
    pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .merge(deltas);
}

fn take_pending(pending: &PendingCounters) -> CounterDeltas {
    std::mem::take(&mut *pending.lock().unwrap_or_else(PoisonError::into_inner))
}

/// First retry delay after a failed counter write; doubles up to [`RETRY_MAX`].
const RETRY_MIN: Duration = Duration::from_millis(50);
const RETRY_MAX: Duration = Duration::from_secs(5);

/// Prepare safe fields before audit or live-traffic projection. The caller key
/// stays private for canonical storage hashing; never serialize this record.
pub fn normalize_service_audit_record(
    mut record: AuditRecord,
    usage: &AuditServiceUsage,
) -> Result<AuditRecord, ServiceAuditError> {
    // Reporter JSON is consumed by JavaScript. Do not persist metadata which
    // would silently change integer value at that cross-surface boundary.
    const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
    if !matches!(record.command.as_deref(), Some("web.search" | "web.fetch")) {
        return Err(ServiceAuditError::InvalidOperation);
    }
    let descriptor = ryu_gw_credentials::web::web_provider_by_id(&record.provider)
        .ok_or(ServiceAuditError::InvalidProvider)?;
    let operation = if record.command.as_deref() == Some("web.search") {
        ryu_gw_credentials::web::WebOperation::Search
    } else {
        ryu_gw_credentials::web::WebOperation::Fetch
    };
    if !descriptor.operations.contains(&operation) {
        return Err(ServiceAuditError::InvalidOperation);
    }
    if [
        Some(usage.requests),
        Some(usage.documents),
        usage.provider_credits,
        record.provider_cost_micro_usd,
    ]
    .into_iter()
    .flatten()
    .any(|value| value > MAX_SAFE_JSON_INTEGER)
    {
        return Err(ServiceAuditError::InvalidUsage);
    }
    if usage.cost_source != AuditServiceCostSource::ProviderReported && !usage.cost_is_estimate {
        return Err(ServiceAuditError::InvalidUsage);
    }
    record.event_type = EventType::ServiceCall;
    record.model.clear();
    record.input_tokens = 0;
    record.output_tokens = 0;
    record.cache_read_tokens = None;
    record.cache_write_tokens = None;
    record.cache_write_1h_tokens = None;
    record.prompt_cache_outcome = None;
    record.prompt_cache_read_tokens = None;
    record.prompt_cache_write_tokens = None;
    record.cache_hit = false;
    record.eval_score = None;
    record.backend = None;
    record.duration_ms = None;
    record.exit_code = None;
    record.widget_instance_id = None;
    record.skill_ids = None;
    if usage.cost_source != AuditServiceCostSource::ProviderReported {
        record.provider_cost_micro_usd = None;
    }
    record.error = record.error.map(|error| match error.as_str() {
        "operation_denied"
        | "provider_denied"
        | "region_denied"
        | "budget_denied"
        | "rate_limited"
        | "payment_required"
        | "credential_rejected"
        | "transport_unavailable"
        | "delivery_uncertain"
        | "invalid_response"
        | "upstream_unavailable"
        | "service_unavailable"
        | "accounting_unavailable"
        | "unknown_cost" => error,
        _ => "service_request_failed".to_owned(),
    });
    record.feature = record.feature.filter(|feature| {
        matches!(
            feature.as_str(),
            "chat" | "island" | "predict" | "agent" | "web" | "service"
        )
    });
    Ok(record)
}

/// Longest accepted `x-ryu-purpose` value, in characters.
pub const MAX_PURPOSE_LEN: usize = 64;

/// Validate an `x-ryu-purpose` value against the shared Core/Gateway contract:
/// 1..=64 characters drawn from `[a-z0-9_:.@/-]`. The value is a closed
/// snake_case name (`compaction`, `auto_title`, ...) or `plugin:<plugin id>`,
/// so anything outside that alphabet is caller noise or an attempt to smuggle
/// free text into a low-cardinality rollup key; it is dropped, not repaired.
pub fn valid_purpose(value: &str) -> Option<&str> {
    let ok = !value.is_empty()
        && value.len() <= MAX_PURPOSE_LEN
        && value.bytes().all(|byte| {
            matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b':' | b'.' | b'@' | b'/' | b'-')
        });
    ok.then_some(value)
}

/// A single request record persisted in the audit log.
#[derive(Debug, Clone)]
pub struct AuditRecord {
    pub request_id: String,
    pub api_key: String,
    pub user_name: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Provider-reported tokens read from the prompt cache. `None` when the
    /// upstream response did not include cache usage details.
    pub cache_read_tokens: Option<u64>,
    /// Provider-reported tokens written to the prompt cache.
    pub cache_write_tokens: Option<u64>,
    /// The part of `cache_write_tokens` written with a one-hour TTL (billed
    /// above the five-minute rate). `None` when no split was reported.
    pub cache_write_1h_tokens: Option<u64>,
    pub cache_hit: bool,
    /// Gateway's provider prompt-cache policy result (`auto`, `injected`, etc.).
    pub prompt_cache_outcome: Option<String>,
    /// Provider-reported prompt tokens read from cache; `None` means unreported.
    pub prompt_cache_read_tokens: Option<u64>,
    /// Provider-reported prompt tokens written to cache; `None` means unreported.
    pub prompt_cache_write_tokens: Option<u64>,
    pub latency_ms: u64,
    pub eval_score: Option<f32>,
    pub error: Option<String>,
    /// Comma-separated skill ids active for this request (M3 / #145 AC3).
    /// `None` when no skills were applied; populated from the `x-ryu-skill-ids` header.
    pub skill_ids: Option<String>,
    /// Core conversation/session id forwarded via `x-ryu-session-id` (M4 / #176).
    /// Enables per-run/per-session audit queries without a separate session store.
    pub session_id: Option<String>,
    // ── Exec-event fields (M6 / #192) ────────────────────────────────────────
    /// Event discriminator: `model_call` (default) or `exec_call`.
    pub event_type: EventType,
    /// Sandbox backend name (e.g. `"wasmtime"`, `"docker"`). `None` for model calls.
    pub backend: Option<String>,
    /// Command or tool name executed. `None` for model calls.
    pub command: Option<String>,
    /// Wall-clock duration of the execution in milliseconds. `None` for model calls.
    pub duration_ms: Option<u64>,
    /// Exit code returned by the sandbox process. `None` for model calls.
    pub exit_code: Option<i32>,
    // ── Control-plane attribution (profiles / usage-points) ──────────────────
    /// Better Auth end-user id forwarded via `x-ryu-user-id`. `None` on
    /// self-hosted / anonymous traffic. Drives per-user daily rollups pushed to
    /// the control plane by the reporter.
    pub user_id: Option<String>,
    /// Selected agent id forwarded via `x-ryu-agent-id`. `None` on
    /// self-hosted / untagged traffic. Drives per-agent daily rollups pushed to
    /// the control plane by the reporter.
    pub agent_id: Option<String>,
    /// Product surface that originated this request, from `x-ryu-feature`
    /// (`chat` | `island` | `predict` | `agent`). `None` when untagged. Powers
    /// the per-feature usage breakdown in the daily rollup.
    pub feature: Option<String>,
    /// Background feature that issued this call, from `x-ryu-purpose`
    /// (`compaction`, `auto_title`, `plugin:<id>`, ...). Orthogonal to
    /// `feature`: it names *why* Core spent the tokens, not which surface the
    /// user was on. Values failing [`valid_purpose`] are stored as NULL.
    pub purpose: Option<String>,
    /// True when this request was billed through the managed inference wallet.
    /// This stays separate from `provider`: managed and BYOK OpenRouter calls
    /// share the provider name but have different Ryu billing semantics.
    pub managed_inference: bool,
    /// Provider-reported transaction cost in micro-USD, before any Ryu deposit
    /// markup. OpenRouter's `usage.cost` is the discounted final transaction
    /// price, so zero is a valid value and must not be treated as missing.
    pub provider_cost_micro_usd: Option<u64>,
    // ── Widget (Ryu Apps) attribution (§4.4) ─────────────────────────────────
    /// Opaque per-render widget instance id (`widget: { instance_id }` on the
    /// exec envelope). Set on widget `callTool` (`ExecCall`) and follow-up
    /// (`WidgetFollowUp`) rows so a governance viewer can trace every
    /// round-trip a single rendered widget made; `None` for all other traffic.
    pub widget_instance_id: Option<String>,
    /// Control-plane id of the hosted `rgw_` credential that authorized this
    /// request. Keys the reporter's per-key rollup; `None` for static keys.
    pub key_id: Option<String>,
    /// Comma-separated ids of EVERY team the verified caller belongs to in
    /// `org_id` (`team_id` holds only the first). The gateway charges all of
    /// them, so the reporter's `teamDaily` rollup attributes the row to each.
    /// `None` when the caller has no team attribution.
    pub team_ids: Option<String>,
}

/// Filters for querying the local audit store. All fields are optional; a
/// `None` field matches any value. `limit` is clamped to [`MAX_QUERY_LIMIT`].
#[derive(Debug, Clone, Default)]
pub struct AuditQuery {
    pub api_key: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Only return entries that recorded an error.
    pub errors_only: bool,
    pub limit: Option<u32>,
    /// Inclusive lower bound for the ISO/UTC timestamp range.
    pub timestamp_from: Option<String>,
    /// Exclusive upper bound for the ISO/UTC timestamp range.
    pub timestamp_until: Option<String>,
    /// Filter by gateway-internal request id (M4 / #176).
    pub request_id: Option<String>,
    /// Filter by Core session/conversation id (M4 / #176).
    /// When set, returns only the audit rows that belong to the given session.
    pub session_id: Option<String>,
    /// Filter by the selected agent id. This is the stable agent identity
    /// forwarded by Core, not a display name and not a client-auth claim.
    pub agent_id: Option<String>,
    /// Filter by widget instance id (Ryu Apps, §4.4). When set, returns only the
    /// `callTool` / follow-up rows that belong to the given rendered widget.
    pub widget_instance_id: Option<String>,
    /// Filter by the event discriminator (`model_call`, `exec_call`,
    /// `credential_read`, `widget_follow_up`, or `control_change`).
    pub event_type: Option<String>,
    /// Filter by the verified user id Core forwarded for the call. Core's
    /// member "my usage" route pins this to the caller so members only ever
    /// read their own rows.
    pub user_id: Option<String>,
    /// Only return rows with an id greater than this cursor. Cursor queries are
    /// oldest-first so callers can advance exactly once after a successful
    /// batch delivery; ordinary queries remain newest-first.
    pub id_after: Option<i64>,
}

/// Lifetime rolled-up totals for the local audit store. Retention pruning of
/// old audit rows never lowers them. Used by the control-plane reporter to push
/// a single aggregate snapshot (including shared-budget spend) up the hierarchy.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AuditSummary {
    pub request_count: u64,
    pub error_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Sum of provider-reported transaction costs for managed model calls.
    pub reported_cost_micro_usd: u64,
    /// Managed model-call tokens whose provider returned no transaction cost;
    /// reporters use the configured estimate for this fallback portion only.
    pub unpriced_input_tokens: u64,
    pub unpriced_output_tokens: u64,
}

/// Filters for the canonical 15-minute usage rollup. The range is half-open:
/// `timestamp_from <= timestamp < timestamp_until`.
#[derive(Debug, Clone)]
pub struct AuditUsageQuery {
    pub timestamp_from: String,
    pub timestamp_until: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Restrict the rollup to one `x-ryu-purpose` value.
    pub purpose: Option<String>,
}

/// One canonical 15-minute usage bucket returned to analytics consumers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditUsageEvent {
    pub timestamp: String,
    pub provider: String,
    pub model: String,
    pub member_id: Option<String>,
    pub node_id: Option<String>,
    pub feature: Option<String>,
    /// Background feature (`x-ryu-purpose`) behind the bucket; `None` for
    /// foreground and untagged traffic. Defaulted so pre-purpose payloads
    /// still parse.
    #[serde(default)]
    pub purpose: Option<String>,
    pub source: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Provider-reported prompt-cache read and write tokens summed over the
    /// bucket's model calls; unreported rows count as zero.
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    pub request_count: u64,
    pub error_count: u64,
    pub latency_total_ms: u64,
    pub latency_samples: u64,
    pub agent_seconds: f64,
    pub cost_micro_usd: Option<u64>,
    /// Used by the gateway API to price managed calls for which the provider did
    /// not report a transaction cost. These fields are never serialized.
    #[serde(skip)]
    pub unpriced_input_tokens: u64,
    #[serde(skip)]
    pub unpriced_output_tokens: u64,
    /// Preserves the billing attribution needed to classify a managed-node row.
    #[serde(skip)]
    pub managed_inference: bool,
}

/// A persisted audit entry as returned by [`AuditLogger::query`].
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub timestamp: String,
    pub request_id: String,
    /// API key is redacted to a short prefix; raw keys are never returned.
    pub api_key: String,
    pub user_name: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    /// One-hour-TTL part of `cache_write_tokens` (see [`AuditRecord`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_1h_tokens: Option<u64>,
    pub cache_hit: bool,
    pub prompt_cache_outcome: Option<String>,
    pub prompt_cache_read_tokens: Option<u64>,
    pub prompt_cache_write_tokens: Option<u64>,
    pub latency_ms: u64,
    pub eval_score: Option<f32>,
    pub error: Option<String>,
    /// Comma-separated skill ids active for this request (M3 / #145 AC3).
    pub skill_ids: Option<String>,
    /// Core conversation/session id (M4 / #176).
    pub session_id: Option<String>,
    // ── Exec-event fields (M6 / #192) ────────────────────────────────────────
    pub event_type: String,
    pub backend: Option<String>,
    pub command: Option<String>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<i32>,
    /// Better Auth end-user id (`x-ryu-user-id`); `None` when self-hosted.
    pub user_id: Option<String>,
    /// Selected agent id (`x-ryu-agent-id`); `None` when untagged.
    pub agent_id: Option<String>,
    /// Product surface (`x-ryu-feature`): `chat` | `island` | `predict` | `agent`.
    pub feature: Option<String>,
    /// True when this request was billed through the managed inference wallet.
    pub managed_inference: bool,
    /// Provider-reported transaction cost in micro-USD, before any Ryu deposit
    /// markup. `Some(0)` is a valid free/promotional transaction.
    pub provider_cost_micro_usd: Option<u64>,
    /// Widget instance id (Ryu Apps, §4.4); `None` for non-widget rows.
    pub widget_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_usage: Option<AuditServiceUsage>,
    /// Hosted `rgw_` credential id; `None` for static keys and older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// Comma-separated ids of every team the row is attributed to (see
    /// [`AuditRecord::team_ids`]); `None` for older and team-less rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_ids: Option<String>,
    /// Background feature behind the row (`x-ryu-purpose`); `null` for
    /// foreground, untagged and older rows. Always serialized (never omitted),
    /// so a client can tell a Gateway that records purposes (`null` means
    /// foreground) from an older one that does not (key absent).
    pub purpose: Option<String>,
}

/// Default number of rows returned by a query when no limit is given.
const DEFAULT_QUERY_LIMIT: u32 = 100;
/// Hard ceiling on rows returned by a single query, to keep responses bounded.
const MAX_QUERY_LIMIT: u32 = 1_000;

mod migrate;
mod writer;

pub use migrate::credential_log_id;
use migrate::*;
use writer::*;

/// SQLite-backed audit logger.
///
/// Writes are dispatched to a background OS thread via a bounded channel so
/// the async request path is never blocked on disk I/O.  The in-memory
/// `token_totals` map is used for real-time budget enforcement without
/// needing to query SQLite on the hot path.
pub struct AuditLogger {
    sender: mpsc::SyncSender<QueuedAudit>,
    /// Read-only connection for local queries. Separate from the writer thread's
    /// connection; safe under WAL, serialised behind a mutex.
    reader: Option<Mutex<Connection>>,
    /// Per API-key lifetime token totals (input + output).
    token_totals: DashMap<String, u64>,
    /// Lifetime counter increments the writer has not persisted yet.
    pending: PendingCounters,
    /// Fault injection for tests: while non-zero, each writer transaction
    /// fails (and decrements it) before touching SQLite.
    #[cfg_attr(not(test), allow(dead_code))]
    injected_failures: Arc<AtomicU64>,
    enabled: bool,
    db_path: Option<String>,
    /// State of the one-time raw-key rebuild (`RawKeyScrub` as `u8`).
    #[cfg_attr(not(test), allow(dead_code))]
    raw_key_scrub: Arc<AtomicU8>,
}

impl AuditLogger {
    pub fn new(config: &AuditConfig) -> anyhow::Result<Self> {
        if !config.enabled {
            return Ok(Self::disabled());
        }

        let db_path = audit_db_path_for(
            &config.db_path,
            std::env::var(AUDIT_DB_PATH_ENV).ok().as_deref(),
        );

        // Ensure parent directories exist.
        if let Some(parent) = std::path::Path::new(&db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        restrict_db_file(Path::new(&db_path))?;
        let mut conn = Connection::open(&db_path)?;
        // Zero freed pages so a migrated raw key or a pruned row does not linger
        // in the file's free list.
        conn.execute_batch("PRAGMA secure_delete=ON;")?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS audit_log (
                 id            INTEGER PRIMARY KEY AUTOINCREMENT,
                 timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
                 request_id    TEXT    NOT NULL,
                 api_key       TEXT    NOT NULL,
                 api_key_prefix TEXT,
                 user_name     TEXT,
                 org_id        TEXT,
                 team_id       TEXT,
                 project_id    TEXT,
                 provider      TEXT    NOT NULL,
                 model         TEXT    NOT NULL,
                 input_tokens  INTEGER NOT NULL DEFAULT 0,
                 output_tokens INTEGER NOT NULL DEFAULT 0,
                 cache_read_tokens INTEGER,
                 cache_write_tokens INTEGER,
                 cache_write_1h_tokens INTEGER,
                 cache_hit     INTEGER NOT NULL DEFAULT 0,
                 prompt_cache_outcome TEXT,
                 prompt_cache_read_tokens INTEGER,
                 prompt_cache_write_tokens INTEGER,
                 latency_ms    INTEGER NOT NULL DEFAULT 0,
                 eval_score    REAL,
                 error         TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_audit_api_key   ON audit_log(api_key);
             CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
             -- Migration: add skill_ids column for Agent Skill attribution (M3 / #145).
             -- SQLite ignores ADD COLUMN on existing tables only when using
             -- CREATE TABLE IF NOT EXISTS; we handle existing DBs via a separate
             -- ALTER TABLE that is swallowed if the column already exists.
             ",
        )?;

        // Older versions stored the raw API key and only redacted it on read.
        // Add a non-secret display prefix, then replace every legacy value with
        // its SHA-256 lookup key before this logger accepts new records.
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN api_key_prefix TEXT;");
        let mut raw_keys_migrated = migrate_api_key_storage(&conn)?;
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_audit_api_key_prefix ON audit_log(api_key_prefix);",
        );
        // Add skill_ids column for existing audit_log tables that predate M3.
        // SQLite does not support ADD COLUMN IF NOT EXISTS; we catch the
        // "duplicate column name" error and treat it as a no-op.
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN skill_ids TEXT;");
        // Add session_id column for existing audit_log tables that predate M4 / #176.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN session_id TEXT; \
             CREATE INDEX IF NOT EXISTS idx_audit_session_id ON audit_log(session_id);",
        );
        // Add exec-event columns for M6 / #192. Each is a separate ALTER TABLE so
        // a partial prior migration doesn't block all columns.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN event_type TEXT NOT NULL DEFAULT 'model_call';",
        );
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN backend TEXT;");
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN command TEXT;");
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN duration_ms INTEGER;");
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN exit_code INTEGER;");
        // Index on event_type so exec-only queries are efficient.
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);",
        );
        // Add control-plane attribution columns (profiles / usage-points). Each is
        // a separate ALTER TABLE so a partial prior migration doesn't block both.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN user_id TEXT; \
             CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN agent_id TEXT; \
             CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_log(agent_id);",
        );
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN feature TEXT;");
        // Background-feature attribution (`x-ryu-purpose`); NULL on older rows.
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN purpose TEXT;");
        // Add managed billing attribution and provider-reported cost. Both are
        // safe for existing audit databases and default old rows to unmanaged
        // with no provider-reported cost.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN managed_inference INTEGER NOT NULL DEFAULT 0;",
        );
        let _ =
            conn.execute_batch("ALTER TABLE audit_log ADD COLUMN provider_cost_micro_usd INTEGER;");
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN cache_read_tokens INTEGER;");
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN cache_write_tokens INTEGER;");
        // One-hour-TTL part of the cache writes, so the usage rollup prices
        // them as the wallet debit did. NULL on rows that predate it.
        let _ =
            conn.execute_batch("ALTER TABLE audit_log ADD COLUMN cache_write_1h_tokens INTEGER;");
        // Add the widget instance id column (Ryu Apps, §4.4) for existing tables.
        // Indexed so per-widget governance queries are efficient.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN widget_instance_id TEXT; \
             CREATE INDEX IF NOT EXISTS idx_audit_widget_instance_id ON audit_log(widget_instance_id);",
        );
        // Provider prompt-cache activity is separate from `cache_hit`, which
        // records Gateway exact/semantic response-cache hits. NULL preserves
        // the distinction between no usage report and a reported zero.
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN prompt_cache_outcome TEXT;");
        // Hosted credential id for per-key rollups; NULL on static-key rows.
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN key_id TEXT;");
        // Every team of a multi-team caller (teamDaily attribution).
        let _ = conn.execute_batch("ALTER TABLE audit_log ADD COLUMN team_ids TEXT;");
        let _ = conn
            .execute_batch("ALTER TABLE audit_log ADD COLUMN prompt_cache_read_tokens INTEGER;");
        let _ = conn
            .execute_batch("ALTER TABLE audit_log ADD COLUMN prompt_cache_write_tokens INTEGER;");

        // Nullable columns preserve existing rows and do not rewrite AuditRecord.
        for (name, kind) in [
            ("service_requests", "INTEGER"),
            ("service_documents", "INTEGER"),
            ("service_provider_credits", "INTEGER"),
            ("service_cost_source", "TEXT"),
            ("service_cost_is_estimate", "INTEGER"),
        ] {
            let present = {
                let mut statement = conn.prepare("PRAGMA table_info(audit_log)")?;
                let names = statement
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                names.iter().any(|column| column == name)
            };
            if !present {
                conn.execute_batch(&format!("ALTER TABLE audit_log ADD COLUMN {name} {kind};"))?;
            }
        }

        // Keep the lifetime summary in a singleton row. New writes update this
        // row in the same transaction as the append-only audit row, so reads stay
        // O(1) and retention pruning of old rows never lowers it: shared-budget
        // reconciliation reports this figure as lifetime spend. Backfilled once
        // from the rows still present when the row is first created (databases
        // from versions that predate the summary table).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS audit_summary (
                 singleton                    INTEGER PRIMARY KEY CHECK (singleton = 1),
                 request_count                INTEGER NOT NULL DEFAULT 0,
                 error_count                  INTEGER NOT NULL DEFAULT 0,
                 input_tokens                 INTEGER NOT NULL DEFAULT 0,
                 output_tokens                INTEGER NOT NULL DEFAULT 0,
                 reported_cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
                 unpriced_input_tokens        INTEGER NOT NULL DEFAULT 0,
                 unpriced_output_tokens       INTEGER NOT NULL DEFAULT 0
             );",
        )?;
        let summary_created = conn.execute(
            "INSERT OR IGNORE INTO audit_summary (singleton) VALUES (1)",
            [],
        )? == 1;
        if summary_created {
            conn.execute_batch(BACKFILL_AUDIT_SUMMARY)?;
        }

        // Per-key lifetime token totals live in their own table, updated in the
        // same transaction as each audit row, so retention pruning of old rows
        // never lowers a key's lifetime token budget usage. Backfilled once from
        // the rows still present when the table is first created.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS key_token_totals (
                 api_key TEXT PRIMARY KEY,
                 tokens  INTEGER NOT NULL DEFAULT 0
             );",
        )?;
        let totals_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM key_token_totals", [], |row| {
                row.get(0)
            })?;
        if totals_rows == 0 {
            conn.execute_batch(
                "INSERT INTO key_token_totals (api_key, tokens)
                 SELECT api_key, SUM(input_tokens + output_tokens)
                 FROM audit_log GROUP BY api_key;",
            )?;
        }
        raw_keys_migrated += migrate_key_token_totals(&mut conn)?;
        // Builds before `secure_delete` hashed raw keys with an in-place UPDATE,
        // so a database they migrated has no raw rows left for the pass above to
        // count, yet the raw bytes can still sit in freed cell space, free-list
        // pages or the WAL. Every database is rebuilt once (tracked by a marker
        // row) and again whenever this open replaced a raw key. The rebuild is a
        // full VACUUM, so it never runs here: it runs best-effort on the writer
        // thread after the logger is up (see `run_raw_key_scrub`).
        if raw_keys_migrated > 0 {
            clear_raw_key_scrub_marker(&conn)?;
            info!(
                rows = raw_keys_migrated,
                "audit: hashed raw client keys; the store is rebuilt in the background"
            );
        }

        // Delivery cursors (the control-plane reporter's last acknowledged row).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS report_cursors (
                 name    TEXT PRIMARY KEY,
                 last_id INTEGER NOT NULL
             );",
        )?;

        let retention = audit_retention_policy();
        let pruned = prune_database(&conn, retention)?;
        if pruned.deleted_rows > 0 {
            info!(
                deleted_rows = pruned.deleted_rows,
                "audit retention pass removed old rows"
            );
        }

        // Load existing per-key token totals so budget enforcement survives restarts.
        let token_totals: DashMap<String, u64> = DashMap::new();
        {
            let mut stmt = conn.prepare("SELECT api_key, tokens FROM key_token_totals")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows.flatten() {
                token_totals.insert(row.0, row.1 as u64);
            }
        }

        info!(db = %db_path, "audit store opened");

        // Dedicated read-only connection for local audit queries. WAL mode lets
        // this read concurrently with the background writer.
        let reader = Connection::open(&db_path)?;
        reader.execute_batch("PRAGMA query_only=ON;")?;

        let (sender, receiver) = mpsc::sync_channel::<QueuedAudit>(1_000);

        let pending = PendingCounters::default();
        let writer_pending = Arc::clone(&pending);
        let injected_failures = Arc::new(AtomicU64::new(0));
        let writer_failures = Arc::clone(&injected_failures);
        let raw_key_scrub = Arc::new(AtomicU8::new(RawKeyScrub::Pending as u8));
        let writer_scrub = Arc::clone(&raw_key_scrub);
        let scrub_db_path = db_path.clone();
        thread::spawn(move || {
            // The one-time rebuild runs on the writer's own connection before it
            // drains the queue, so it never holds up startup and never contends
            // with the writer for the write lock. A VACUUM of a large store can
            // take minutes, longer than the bounded queue absorbs, so a drain
            // buffers the rows logged meanwhile and they are persisted, in order,
            // as soon as the rebuild ends. Lifetime counters are persisted
            // regardless.
            let mut receiver = receiver;
            let (outcome, backlog) = buffer_while(&mut receiver, SCRUB_BACKLOG_MAX, || {
                run_raw_key_scrub(&conn, Path::new(&scrub_db_path), &fs_available_space)
            });
            writer_scrub.store(outcome as u8, Ordering::Release);
            audit_write_loop(
                &mut conn,
                &receiver,
                backlog,
                &writer_pending,
                &writer_failures,
            );
        });

        Ok(Self {
            sender,
            reader: Some(Mutex::new(reader)),
            token_totals,
            pending,
            injected_failures,
            enabled: true,
            db_path: Some(db_path),
            raw_key_scrub,
        })
    }

    fn disabled() -> Self {
        // Channel is created but nothing reads it — that's fine for a no-op logger.
        let (sender, _) = mpsc::sync_channel(1);
        Self {
            sender,
            reader: None,
            token_totals: DashMap::new(),
            pending: PendingCounters::default(),
            injected_failures: Arc::new(AtomicU64::new(0)),
            enabled: false,
            db_path: None,
            raw_key_scrub: Arc::new(AtomicU8::new(RawKeyScrub::Skipped as u8)),
        }
    }

    /// Block until the background raw-key scrub has finished or been deferred.
    #[cfg(test)]
    fn wait_for_raw_key_scrub(&self) -> RawKeyScrub {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let state = RawKeyScrub::from_u8(self.raw_key_scrub.load(Ordering::Acquire));
            if state != RawKeyScrub::Pending || std::time::Instant::now() > deadline {
                return state;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Enqueue a record for async persistence. Never blocks: when disabled the
    /// record is ignored, and when the queue is full the row is dropped but its
    /// lifetime counters (per-key tokens, summary spend) are still persisted.
    pub fn log(&self, record: AuditRecord) {
        if !self.enabled {
            return;
        }
        if record.event_type == EventType::ServiceCall {
            warn!("service audit requires the safe usage logging path");
            return;
        }
        // Merge the counters BEFORE queueing the row. When the queue is full,
        // every row already in it is received after this merge, so the writer
        // persists these increments with one of them and nothing is stranded.
        merge_pending(&self.pending, CounterDeltas::from_record(&record));
        if let Err(error) = self.sender.try_send(QueuedAudit {
            record,
            service_usage: None,
        }) {
            warn!("audit row dropped ({error}); usage totals are kept");
        }
    }

    pub fn log_service(
        &self,
        record: AuditRecord,
        usage: AuditServiceUsage,
    ) -> Result<(), ServiceAuditError> {
        let record = normalize_service_audit_record(record, &usage)?;
        if !self.enabled {
            return Ok(());
        }
        self.sender
            .try_send(QueuedAudit {
                record,
                service_usage: Some(usage),
            })
            .map_err(|_| ServiceAuditError::QueueUnavailable)
    }

    /// Convenience constructor for an exec-event record.
    ///
    /// Sets `event_type = ExecCall` and fills the exec-specific fields. The
    /// `provider` sentinel is `"sandbox"` so the NOT-NULL constraint is met;
    /// `model` is the `backend` name. Caller supplies `request_id` (a fresh
    /// `uuid::Uuid::new_v4().to_string()` is idiomatic).
    pub fn make_exec_record(
        request_id: String,
        api_key: String,
        backend: String,
        command: String,
        duration_ms: u64,
        exit_code: i32,
        session_id: Option<String>,
        error: Option<String>,
    ) -> AuditRecord {
        AuditRecord {
            key_id: None,
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "sandbox".to_string(),
            model: backend.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            latency_ms: duration_ms,
            eval_score: None,
            error,
            skill_ids: None,
            session_id,
            event_type: EventType::ExecCall,
            backend: Some(backend),
            command: Some(command),
            duration_ms: Some(duration_ms),
            exit_code: Some(exit_code),
            user_id: None,
            agent_id: None,
            feature: None,
            purpose: None,
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: None,
        }
    }

    /// Convenience constructor for a widget `callTool` exec event (Ryu Apps,
    /// §4.4). It is an [`EventType::ExecCall`] (drains the sandbox exec budget
    /// like any tool run) tagged `feature = "widget"`, with `backend` = the
    /// widget's `origin_server`, `command` = the executed `tool_id`, and the
    /// per-render `widget_instance_id` so a governance viewer can trace every
    /// call one rendered widget made. `error` is `Some(reason)` on any denial.
    #[allow(clippy::too_many_arguments)]
    pub fn make_widget_call_record(
        request_id: String,
        api_key: String,
        origin_server: String,
        tool_id: String,
        agent_id: Option<String>,
        session_id: Option<String>,
        widget_instance_id: String,
        duration_ms: u64,
        error: Option<String>,
    ) -> AuditRecord {
        AuditRecord {
            key_id: None,
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "widget".to_string(),
            model: origin_server.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            latency_ms: duration_ms,
            eval_score: None,
            error,
            skill_ids: None,
            session_id,
            event_type: EventType::ExecCall,
            backend: Some(origin_server),
            command: Some(tool_id),
            duration_ms: Some(duration_ms),
            exit_code: None,
            user_id: None,
            agent_id,
            feature: Some("widget".to_string()),
            purpose: None,
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: Some(widget_instance_id),
        }
    }

    /// Convenience constructor for a widget `sendFollowUpMessage` event (Ryu
    /// Apps, §4.4). Its own [`EventType::WidgetFollowUp`] discriminator (not an
    /// exec) tagged `feature = "widget"`, `backend` = `origin_server`,
    /// `command = "follow_up"`, `session_id` = the target conversation id, and
    /// the `widget_instance_id`. Only the prompt length/hash is ever carried by
    /// the caller — never the prompt text. `error` is `Some(reason)` on denial.
    ///
    /// `dead_code`-allowed: the follow-up ingest that logs these rows lives on
    /// the Core → gateway path (§4.2) outside this unit; the constructor is the
    /// single owner of the `WidgetFollowUp` row shape and is covered by a test.
    #[allow(dead_code)]
    pub fn make_widget_followup_record(
        request_id: String,
        api_key: String,
        origin_server: String,
        conversation_id: Option<String>,
        widget_instance_id: String,
        error: Option<String>,
    ) -> AuditRecord {
        AuditRecord {
            key_id: None,
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "widget".to_string(),
            model: origin_server.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            latency_ms: 0,
            eval_score: None,
            error,
            skill_ids: None,
            session_id: conversation_id,
            event_type: EventType::WidgetFollowUp,
            backend: Some(origin_server),
            command: Some("follow_up".to_string()),
            duration_ms: None,
            exit_code: None,
            user_id: None,
            agent_id: None,
            feature: Some("widget".to_string()),
            purpose: None,
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: Some(widget_instance_id),
        }
    }

    /// Convenience constructor for an identity-vault credential-read event (#523).
    ///
    /// A credential read is not a sandbox exec, so it gets its own
    /// [`EventType::CredentialRead`] discriminator and does **not** drain the
    /// exec budget. The `domain` (never the secret itself) is recorded in the
    /// `command` slot so reads are attributable per service; `backend` carries
    /// the `CredentialSource` id (`manual` / `composio` / `browser-tool`).
    /// `session_id` makes the read queryable per session, like exec events.
    pub fn make_credential_read_record(
        request_id: String,
        api_key: String,
        source: String,
        domain: String,
        session_id: Option<String>,
        error: Option<String>,
    ) -> AuditRecord {
        AuditRecord {
            key_id: None,
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "identity".to_string(),
            model: source.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            latency_ms: 0,
            eval_score: None,
            error,
            skill_ids: None,
            session_id,
            event_type: EventType::CredentialRead,
            backend: Some(source),
            command: Some(domain),
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

    /// Convenience constructor for an administrative gateway control change.
    ///
    /// The actor is stored in the existing `user_name` slot, the target in
    /// `model`, and a bounded action/summary in `command` so the row remains
    /// compatible with the existing SQLite/reporting shape. No request payload
    /// or secret is accepted here.
    pub fn make_control_record(
        request_id: String,
        api_key: String,
        actor: String,
        actor_id: Option<String>,
        action: String,
        target: String,
        summary: Option<String>,
    ) -> AuditRecord {
        Self::make_control_record_with_agent(
            request_id, api_key, actor, actor_id, None, action, target, summary,
        )
    }

    /// Convenience constructor for a control change that belongs to one agent.
    /// The agent id is a stable correlation key; the action summary remains
    /// bounded and payload-free just like the legacy constructor.
    pub fn make_control_record_with_agent(
        request_id: String,
        api_key: String,
        actor: String,
        actor_id: Option<String>,
        agent_id: Option<String>,
        action: String,
        target: String,
        summary: Option<String>,
    ) -> AuditRecord {
        let command = summary
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("{action}: {value}"))
            .unwrap_or(action);
        AuditRecord {
            key_id: None,
            request_id,
            api_key,
            user_name: Some(actor),
            org_id: None,
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "gateway_control".to_string(),
            model: target,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            latency_ms: 0,
            eval_score: None,
            error: None,
            skill_ids: None,
            session_id: None,
            event_type: EventType::ControlChange,
            backend: Some("gateway_admin".to_string()),
            command: Some(command),
            duration_ms: None,
            exit_code: None,
            user_id: actor_id,
            agent_id,
            feature: Some("control".to_string()),
            purpose: None,
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: None,
        }
    }

    /// The SQLite file backing this logger, or `None` when auditing is disabled.
    pub fn db_path(&self) -> Option<&str> {
        self.db_path.as_deref()
    }

    /// Return the total lifetime tokens used by `api_key`.
    pub fn token_usage(&self, api_key: &str) -> u64 {
        self.token_totals
            .get(&api_key_storage_key(api_key))
            .map(|v| *v)
            .unwrap_or(0)
    }

    /// Increment the in-memory token total for `api_key`.
    pub fn add_tokens(&self, api_key: &str, n: u64) {
        *self
            .token_totals
            .entry(api_key_storage_key(api_key))
            .or_insert(0) += n;
    }

    /// Whether the audit store is enabled (persisting and queryable).
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Apply the configured local retention policy immediately. This is useful
    /// for an operator-triggered maintenance pass; normal startup also runs the
    /// same pass before loading token totals.
    pub fn prune(&self) -> anyhow::Result<AuditPruneSummary> {
        let Some(path) = &self.db_path else {
            return Ok(AuditPruneSummary::default());
        };
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        prune_database(&conn, audit_retention_policy())
    }

    /// Query the local audit store. Returns entries newest-first, with the raw
    /// `api_key` redacted to a short prefix so secrets never leave the store.
    pub fn query(&self, query: &AuditQuery) -> anyhow::Result<Vec<AuditEntry>> {
        let Some(reader) = &self.reader else {
            return Ok(Vec::new());
        };

        // Build a parameterised WHERE clause so filters can never inject SQL.
        let mut clauses: Vec<&str> = Vec::new();
        let mut binds: Vec<String> = Vec::new();
        if let Some(timestamp_from) = &query.timestamp_from {
            clauses.push("timestamp >= datetime(?)");
            binds.push(timestamp_from.clone());
        }
        if let Some(timestamp_until) = &query.timestamp_until {
            clauses.push("timestamp < datetime(?)");
            binds.push(timestamp_until.clone());
        }
        if let Some(api_key) = &query.api_key {
            clauses.push("api_key = ?");
            binds.push(api_key_storage_key(api_key));
        }
        let mut push = |col: &'static str, val: &Option<String>| {
            if let Some(v) = val {
                clauses.push(col);
                binds.push(v.clone());
            }
        };
        push("org_id = ?", &query.org_id);
        push("team_id = ?", &query.team_id);
        push("project_id = ?", &query.project_id);
        push("provider = ?", &query.provider);
        push("model = ?", &query.model);
        push("request_id = ?", &query.request_id);
        push("session_id = ?", &query.session_id);
        push("agent_id = ?", &query.agent_id);
        push("widget_instance_id = ?", &query.widget_instance_id);
        push("event_type = ?", &query.event_type);
        push("user_id = ?", &query.user_id);
        if query.errors_only {
            clauses.push("error IS NOT NULL");
        }
        if let Some(id_after) = query.id_after {
            clauses.push("id > ?");
            binds.push(id_after.to_string());
        }

        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };

        let limit = query
            .limit
            .unwrap_or(DEFAULT_QUERY_LIMIT)
            .clamp(1, MAX_QUERY_LIMIT);

        let order = if query.id_after.is_some() {
            "ORDER BY id ASC"
        } else {
            "ORDER BY id DESC"
        };
        let sql = format!(
            "SELECT id, timestamp, request_id, api_key, api_key_prefix, user_name, org_id, team_id, \
             project_id, provider, model, input_tokens, output_tokens, cache_hit, \
             latency_ms, eval_score, error, skill_ids, session_id, \
             event_type, backend, command, duration_ms, exit_code, \
             user_id, agent_id, feature, widget_instance_id, managed_inference, provider_cost_micro_usd, \
             service_requests, service_documents, service_provider_credits, service_cost_source, service_cost_is_estimate, \
             cache_read_tokens, cache_write_tokens, \
             prompt_cache_outcome, prompt_cache_read_tokens, prompt_cache_write_tokens, key_id, team_ids, \
             cache_write_1h_tokens, purpose \
             FROM audit_log {where_sql} {order} LIMIT {limit}"
        );

        let conn = reader
            .lock()
            .map_err(|_| anyhow::anyhow!("audit reader mutex poisoned"))?;
        let mut stmt = conn.prepare(&sql)?;
        let params = rusqlite::params_from_iter(binds.iter());
        let rows = stmt.query_map(params, |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                request_id: row.get(2)?,
                api_key: row
                    .get::<_, Option<String>>(4)?
                    .unwrap_or_else(|| "unknown…".to_owned()),
                user_name: row.get(5)?,
                org_id: row.get(6)?,
                team_id: row.get(7)?,
                project_id: row.get(8)?,
                provider: row.get(9)?,
                model: row.get(10)?,
                input_tokens: row.get::<_, i64>(11)? as u64,
                output_tokens: row.get::<_, i64>(12)? as u64,
                cache_read_tokens: row.get::<_, Option<i64>>(35)?.map(|value| value as u64),
                cache_write_tokens: row.get::<_, Option<i64>>(36)?.map(|value| value as u64),
                cache_write_1h_tokens: row
                    .get::<_, Option<i64>>(42)
                    .unwrap_or(None)
                    .map(|v| v as u64),
                cache_hit: row.get::<_, i64>(13)? != 0,
                latency_ms: row.get::<_, i64>(14)? as u64,
                eval_score: row.get(15)?,
                error: row.get(16)?,
                skill_ids: row.get(17).unwrap_or(None),
                session_id: row.get(18).unwrap_or(None),
                event_type: row
                    .get::<_, Option<String>>(19)
                    .unwrap_or(None)
                    .unwrap_or_else(|| "model_call".to_owned()),
                backend: row.get(20).unwrap_or(None),
                command: row.get(21).unwrap_or(None),
                duration_ms: row
                    .get::<_, Option<i64>>(22)
                    .unwrap_or(None)
                    .map(|v| v as u64),
                exit_code: row.get(23).unwrap_or(None),
                user_id: row.get(24).unwrap_or(None),
                agent_id: row.get(25).unwrap_or(None),
                feature: row.get(26).unwrap_or(None),
                widget_instance_id: row.get(27).unwrap_or(None),
                service_usage: read_service_usage(row)?,
                managed_inference: row.get::<_, i64>(28).unwrap_or(0) != 0,
                provider_cost_micro_usd: row
                    .get::<_, Option<i64>>(29)
                    .unwrap_or(None)
                    .map(|v| v as u64),
                prompt_cache_outcome: row.get(37).unwrap_or(None),
                prompt_cache_read_tokens: row
                    .get::<_, Option<i64>>(38)
                    .unwrap_or(None)
                    .map(|v| v as u64),
                prompt_cache_write_tokens: row
                    .get::<_, Option<i64>>(39)
                    .unwrap_or(None)
                    .map(|v| v as u64),
                key_id: row.get(40).unwrap_or(None),
                team_ids: row.get(41).unwrap_or(None),
                purpose: row.get(43).unwrap_or(None),
            })
        })?;

        let mut out = Vec::new();
        for entry in rows {
            out.push(entry?);
        }
        Ok(out)
    }

    /// Roll up the entire local store into aggregate totals. Returns a zeroed
    /// summary when the store is disabled.
    /// Last acknowledged row id of the named delivery cursor.
    pub fn report_cursor(&self, name: &str) -> anyhow::Result<Option<i64>> {
        let Some(reader) = &self.reader else {
            return Ok(None);
        };
        let conn = reader
            .lock()
            .map_err(|_| anyhow::anyhow!("audit reader mutex poisoned"))?;
        let cursor = conn
            .query_row(
                "SELECT last_id FROM report_cursors WHERE name = ?1",
                params![name],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(cursor)
    }

    /// Persist the named delivery cursor. Runs on its own short-lived writer
    /// connection (once per report interval); WAL lets it coexist with the
    /// background audit writer, and the busy timeout rides out its commits.
    /// The cursor never moves backwards.
    pub fn set_report_cursor(&self, name: &str, last_id: i64) -> anyhow::Result<()> {
        let Some(db_path) = self.db_path.as_deref() else {
            return Ok(());
        };
        let conn = Connection::open(db_path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute(
            "INSERT INTO report_cursors (name, last_id) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)",
            params![name, last_id],
        )?;
        Ok(())
    }

    pub fn summary(&self) -> anyhow::Result<AuditSummary> {
        let Some(reader) = &self.reader else {
            return Ok(AuditSummary::default());
        };

        let conn = reader
            .lock()
            .map_err(|_| anyhow::anyhow!("audit reader mutex poisoned"))?;
        let row = conn.query_row(
            "SELECT request_count, error_count, input_tokens, output_tokens,
                    reported_cost_micro_usd, unpriced_input_tokens, unpriced_output_tokens
             FROM audit_summary WHERE singleton = 1",
            [],
            |row| {
                Ok(AuditSummary {
                    request_count: row.get::<_, i64>(0)? as u64,
                    error_count: row.get::<_, i64>(1)? as u64,
                    input_tokens: row.get::<_, i64>(2)? as u64,
                    output_tokens: row.get::<_, i64>(3)? as u64,
                    reported_cost_micro_usd: row.get::<_, i64>(4)? as u64,
                    unpriced_input_tokens: row.get::<_, i64>(5)? as u64,
                    unpriced_output_tokens: row.get::<_, i64>(6)? as u64,
                })
            },
        )?;
        Ok(row)
    }

    /// Return canonical 15-minute usage buckets for the requested half-open
    /// range. This query aggregates in SQLite and is not subject to the raw audit
    /// endpoint's row limit.
    pub fn usage_rollup(&self, query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>> {
        let Some(reader) = &self.reader else {
            return Ok(Vec::new());
        };
        let conn = reader
            .lock()
            .map_err(|_| anyhow::anyhow!("audit reader mutex poisoned"))?;

        let mut clauses = vec![
            "timestamp >= datetime(?)",
            "timestamp < datetime(?)",
            "event_type IN ('model_call', 'exec_call')",
        ];
        let mut binds = vec![query.timestamp_from.clone(), query.timestamp_until.clone()];
        if let Some(provider) = &query.provider {
            clauses.push("provider = ?");
            binds.push(provider.clone());
        }
        if let Some(model) = &query.model {
            clauses.push("model = ?");
            binds.push(model.clone());
        }
        if let Some(purpose) = &query.purpose {
            clauses.push("purpose = ?");
            binds.push(purpose.clone());
        }

        let sql = format!(
            "SELECT
                 strftime('%Y-%m-%dT%H:%M:%SZ',
                          (CAST(strftime('%s', timestamp) AS INTEGER) / 900) * 900,
                          'unixepoch') AS bucket,
                 provider,
                 model,
                 user_id,
                 feature,
                 managed_inference,
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' THEN input_tokens ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' THEN output_tokens ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' AND error IS NOT NULL THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' THEN latency_ms ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'exec_call' THEN duration_ms ELSE 0 END), 0),
                 CASE WHEN SUM(CASE WHEN event_type = 'model_call'
                                         AND managed_inference != 0
                                         AND provider_cost_micro_usd IS NOT NULL
                                    THEN 1 ELSE 0 END) > 0
                      THEN SUM(CASE WHEN event_type = 'model_call' AND managed_inference != 0
                                    THEN COALESCE(provider_cost_micro_usd, 0) ELSE 0 END)
                      ELSE NULL END,
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' AND managed_inference != 0
                                        AND provider_cost_micro_usd IS NULL
                                   THEN input_tokens ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call' AND managed_inference != 0
                                        AND provider_cost_micro_usd IS NULL
                                   THEN output_tokens ELSE 0 END), 0),
                 purpose,
                 COALESCE(SUM(CASE WHEN event_type = 'model_call'
                                   THEN COALESCE(cache_read_tokens, 0) ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_type = 'model_call'
                                   THEN COALESCE(cache_write_tokens, 0) ELSE 0 END), 0)
             FROM audit_log
             WHERE {}
             GROUP BY bucket, provider, model, user_id, feature, purpose, managed_inference
             ORDER BY bucket ASC, provider ASC, model ASC",
            clauses.join(" AND ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), |row| {
            let provider: String = row.get(1)?;
            let managed_inference = row.get::<_, i64>(5)? != 0;
            Ok(AuditUsageEvent {
                timestamp: row.get(0)?,
                source: local_usage_source(&provider, managed_inference).to_owned(),
                provider,
                model: row.get(2)?,
                member_id: row.get(3)?,
                node_id: None,
                feature: row.get(4)?,
                managed_inference,
                input_tokens: row.get::<_, i64>(6)? as u64,
                output_tokens: row.get::<_, i64>(7)? as u64,
                request_count: row.get::<_, i64>(8)? as u64,
                error_count: row.get::<_, i64>(9)? as u64,
                latency_total_ms: row.get::<_, i64>(10)? as u64,
                latency_samples: row.get::<_, i64>(11)? as u64,
                agent_seconds: row.get::<_, i64>(12)? as f64 / 1000.0,
                cost_micro_usd: row.get::<_, Option<i64>>(13)?.map(|value| value as u64),
                unpriced_input_tokens: row.get::<_, i64>(14)? as u64,
                unpriced_output_tokens: row.get::<_, i64>(15)? as u64,
                purpose: row.get(16)?,
                cache_read_tokens: row.get::<_, i64>(17)? as u64,
                cache_write_tokens: row.get::<_, i64>(18)? as u64,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }
}

fn read_service_usage(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<AuditServiceUsage>> {
    let Some(source) = row.get::<_, Option<String>>(33)? else {
        return Ok(None);
    };
    let source =
        AuditServiceCostSource::from_storage(&source).ok_or(rusqlite::Error::InvalidColumnType(
            33,
            "service_cost_source".into(),
            rusqlite::types::Type::Text,
        ))?;
    fn nonnegative(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
        let value: i64 = row.get(index)?;
        u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
    }
    let credits = row
        .get::<_, Option<i64>>(32)?
        .map(|value| {
            u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(32, value))
        })
        .transpose()?;
    Ok(Some(AuditServiceUsage {
        requests: nonnegative(row, 30)?,
        documents: nonnegative(row, 31)?,
        provider_credits: credits,
        cost_source: source,
        cost_is_estimate: row.get::<_, i64>(34)? != 0,
    }))
}

fn local_usage_source(provider: &str, managed_inference: bool) -> &'static str {
    if let Some(descriptor) = ryu_gw_credentials::sdk_provider_by_id(provider) {
        return if descriptor.auth_kind == ryu_gw_credentials::SdkAuthKind::NoAuth {
            "self_hosted"
        } else {
            "byok"
        };
    }
    match provider.split(':').next().unwrap_or(provider) {
        "local" | "ollama" | "llamacpp" | "lmstudio" | "vllm" => "local",
        "openrouter" if managed_inference => "managed",
        "openrouter" | "openai" | "anthropic" | "genai" => "byok",
        _ if managed_inference => "managed",
        _ => "self_hosted",
    }
}

/// Redact an API key to a short, non-reversible prefix for query responses.
fn redact_key(key: &str) -> String {
    if key == "anonymous" || key == "master" {
        return key.to_string();
    }
    let prefix: String = key.chars().take(6).collect();
    format!("{prefix}…")
}

impl Default for AuditLogger {
    fn default() -> Self {
        Self::disabled()
    }
}

/// One-time backfill of the lifetime `audit_summary` row from the rows still
/// present. Runs only when the singleton row is first created; retention never
/// recomputes it, because that would shrink lifetime spend to the retained
/// window and reopen a reached shared-budget hard cap.
const BACKFILL_AUDIT_SUMMARY: &str = "UPDATE audit_summary SET
     request_count = (SELECT COUNT(*) FROM audit_log WHERE event_type NOT IN ('control_change', 'service_call')),
     error_count = (SELECT COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0)
                    FROM audit_log WHERE event_type NOT IN ('control_change', 'service_call')),
     input_tokens = (SELECT COALESCE(SUM(input_tokens), 0)
                     FROM audit_log WHERE event_type NOT IN ('control_change', 'service_call')),
     output_tokens = (SELECT COALESCE(SUM(output_tokens), 0)
                      FROM audit_log WHERE event_type NOT IN ('control_change', 'service_call')),
     reported_cost_micro_usd = (SELECT COALESCE(SUM(CASE
         WHEN event_type = 'model_call' AND managed_inference != 0
              AND provider_cost_micro_usd IS NOT NULL
         THEN provider_cost_micro_usd ELSE 0 END), 0) FROM audit_log),
     unpriced_input_tokens = (SELECT COALESCE(SUM(CASE
         WHEN event_type = 'model_call' AND managed_inference != 0
              AND provider_cost_micro_usd IS NULL
         THEN input_tokens ELSE 0 END), 0) FROM audit_log),
     unpriced_output_tokens = (SELECT COALESCE(SUM(CASE
         WHEN event_type = 'model_call' AND managed_inference != 0
              AND provider_cost_micro_usd IS NULL
         THEN output_tokens ELSE 0 END), 0) FROM audit_log)
 WHERE singleton = 1;";

fn prune_database(
    conn: &Connection,
    policy: AuditRetentionPolicy,
) -> anyhow::Result<AuditPruneSummary> {
    let mut deleted_rows = 0_u64;
    if let Some(days) = policy.retention_days {
        let modifier = format!("-{days} days");
        deleted_rows = deleted_rows.saturating_add(conn.execute(
            "DELETE FROM audit_log WHERE timestamp < datetime('now', ?1)",
            params![modifier],
        )? as u64);
    }
    if let Some(max_rows) = policy.max_rows {
        let max_rows = max_rows.min(i64::MAX as u64) as i64;
        deleted_rows = deleted_rows.saturating_add(conn.execute(
            "DELETE FROM audit_log
                 WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?1)",
            params![max_rows],
        )? as u64);
    }
    Ok(AuditPruneSummary {
        deleted_rows,
        retention_days: policy.retention_days,
        max_rows: policy.max_rows,
    })
}

// ─── Swappable audit sink (Lg decomposition) ─────────────────────────────────

/// The audit sink (append-only record log + lifetime token totals + query /
/// summary) as a swappable capability. The built-in [`AuditLogger`] (local
/// SQLite + in-memory totals) is the default; an alternative sink (e.g. one
/// shipping records to a central store) can register without touching the
/// pipeline, mirroring the [`crate::providers::ProviderRegistry`] inversion. The
/// pure record constructors (`make_exec_record`, `make_widget_call_record`, …)
/// stay concrete associated functions — their call sites name the type.
pub trait AuditBackend: Send + Sync {
    /// Append a record to the audit log.
    fn log(&self, record: AuditRecord);
    fn log_service(
        &self,
        _record: AuditRecord,
        _usage: AuditServiceUsage,
    ) -> Result<(), ServiceAuditError> {
        Err(ServiceAuditError::UnsupportedBackend)
    }
    /// Whether the store is enabled (persisting and queryable).
    fn is_enabled(&self) -> bool;
    /// Total lifetime tokens used by `api_key`.
    fn token_usage(&self, api_key: &str) -> u64;
    /// Increment the in-memory token total for `api_key`.
    fn add_tokens(&self, api_key: &str, n: u64);
    /// Query the store, newest-first, api_key redacted.
    fn query(&self, query: &AuditQuery) -> anyhow::Result<Vec<AuditEntry>>;
    /// Lifetime aggregate summary. Retention pruning must not lower it, because
    /// shared-budget reconciliation reports it as lifetime spend.
    fn summary(&self) -> anyhow::Result<AuditSummary>;
    /// Canonical 15-minute usage buckets for analytics surfaces.
    fn usage_rollup(&self, query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>>;
    /// Apply the backend's local retention policy. Non-persistent backends may
    /// return a zero-deletion summary.
    fn prune(&self) -> anyhow::Result<AuditPruneSummary> {
        Ok(AuditPruneSummary::default())
    }
    /// Last acknowledged row id of the named delivery cursor (e.g. the
    /// control-plane reporter), so a restart resumes instead of replaying.
    /// Non-persistent backends remember nothing.
    fn report_cursor(&self, _name: &str) -> anyhow::Result<Option<i64>> {
        Ok(None)
    }
    /// Persist the named delivery cursor after its slice was acknowledged.
    fn set_report_cursor(&self, _name: &str, _last_id: i64) -> anyhow::Result<()> {
        Ok(())
    }
}

impl AuditBackend for AuditLogger {
    fn log(&self, record: AuditRecord) {
        AuditLogger::log(self, record);
    }
    fn log_service(
        &self,
        record: AuditRecord,
        usage: AuditServiceUsage,
    ) -> Result<(), ServiceAuditError> {
        AuditLogger::log_service(self, record, usage)
    }
    fn is_enabled(&self) -> bool {
        AuditLogger::is_enabled(self)
    }
    fn token_usage(&self, api_key: &str) -> u64 {
        AuditLogger::token_usage(self, api_key)
    }
    fn add_tokens(&self, api_key: &str, n: u64) {
        AuditLogger::add_tokens(self, api_key, n);
    }
    fn query(&self, query: &AuditQuery) -> anyhow::Result<Vec<AuditEntry>> {
        AuditLogger::query(self, query)
    }
    fn summary(&self) -> anyhow::Result<AuditSummary> {
        AuditLogger::summary(self)
    }
    fn report_cursor(&self, name: &str) -> anyhow::Result<Option<i64>> {
        AuditLogger::report_cursor(self, name)
    }
    fn set_report_cursor(&self, name: &str, last_id: i64) -> anyhow::Result<()> {
        AuditLogger::set_report_cursor(self, name, last_id)
    }
    fn usage_rollup(&self, query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>> {
        AuditLogger::usage_rollup(self, query)
    }
    fn prune(&self) -> anyhow::Result<AuditPruneSummary> {
        AuditLogger::prune(self)
    }
}

/// Id-keyed registry over [`AuditBackend`] implementations. The built-in
/// [`AuditLogger`] is registered first under [`AuditRegistry::BUILTIN`] and
/// active by default, so behavior is byte-identical with no config change.
/// Delegating verbs forward to the active backend, keeping every call site
/// unchanged.
pub struct AuditRegistry {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn AuditBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn AuditBackend>,
}

impl AuditRegistry {
    /// Stable id of the built-in audit logger.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry around an already-constructed [`AuditLogger`],
    /// registering it as the built-in active backend.
    pub fn from_logger(logger: AuditLogger) -> Self {
        let builtin: std::sync::Arc<dyn AuditBackend> = std::sync::Arc::new(logger);
        let mut registry = Self {
            backends: std::collections::HashMap::new(),
            order: Vec::new(),
            active_id: Self::BUILTIN.to_string(),
            active: std::sync::Arc::clone(&builtin),
        };
        registry.register(Self::BUILTIN, builtin);
        registry
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    pub fn register(&mut self, id: impl Into<String>, backend: std::sync::Arc<dyn AuditBackend>) {
        let id = id.into();
        if !self.backends.contains_key(&id) {
            self.order.push(id.clone());
        }
        let is_active = id == self.active_id;
        self.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            self.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.

    pub fn set_active(&mut self, id: &str) -> bool {
        match self.backends.get(id) {
            Some(backend) => {
                self.active = std::sync::Arc::clone(backend);
                self.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.

    #[allow(dead_code)]
    pub fn active_id(&self) -> &str {
        &self.active_id
    }

    /// The registered backend ids in registration order.

    pub fn available(&self) -> Vec<String> {
        self.order.clone()
    }

    // ─── Delegating verbs (byte-identical call sites) ────────────────────────

    /// See [`AuditBackend::log`].
    pub fn log(&self, record: AuditRecord) {
        self.active.log(record);
    }

    pub fn log_service(
        &self,
        record: AuditRecord,
        usage: AuditServiceUsage,
    ) -> Result<(), ServiceAuditError> {
        let record = normalize_service_audit_record(record, &usage)?;
        self.active.log_service(record, usage)
    }

    /// See [`AuditBackend::is_enabled`].
    pub fn is_enabled(&self) -> bool {
        self.active.is_enabled()
    }

    /// See [`AuditBackend::token_usage`].
    pub fn token_usage(&self, api_key: &str) -> u64 {
        self.active.token_usage(api_key)
    }

    /// See [`AuditBackend::add_tokens`].
    pub fn add_tokens(&self, api_key: &str, n: u64) {
        self.active.add_tokens(api_key, n);
    }

    /// See [`AuditBackend::query`].
    pub fn query(&self, query: &AuditQuery) -> anyhow::Result<Vec<AuditEntry>> {
        self.active.query(query)
    }

    /// See [`AuditBackend::summary`].
    pub fn summary(&self) -> anyhow::Result<AuditSummary> {
        self.active.summary()
    }

    /// See [`AuditBackend::usage_rollup`].
    pub fn usage_rollup(&self, query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>> {
        self.active.usage_rollup(query)
    }

    /// Apply the active backend's retention policy immediately.
    pub fn prune(&self) -> anyhow::Result<AuditPruneSummary> {
        self.active.prune()
    }

    /// See [`AuditBackend::report_cursor`].
    pub fn report_cursor(&self, name: &str) -> anyhow::Result<Option<i64>> {
        self.active.report_cursor(name)
    }

    /// See [`AuditBackend::set_report_cursor`].
    pub fn set_report_cursor(&self, name: &str, last_id: i64) -> anyhow::Result<()> {
        self.active.set_report_cursor(name, last_id)
    }
}

#[cfg(test)]
mod tests;
