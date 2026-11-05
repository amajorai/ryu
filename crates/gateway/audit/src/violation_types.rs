//! The violation outbox's wire and bookkeeping types: the `ViolationEvent`
//! verdict record and its enums, the outbox row and limit types, and the
//! constants the outbox enforces. Re-exported from [`super`] unchanged.

use serde::{Deserialize, Serialize};

/// The taxonomy id whose evidence is a keyed hash only, never text. A
/// compiled invariant (spec 00.4), checked here as well as by the caller.
pub const CHILD_SAFETY_CODE: &str = "hazard.S4";
/// Largest excerpt the control plane accepts, in UTF-8 bytes (spec 03.4.4).
pub const MAX_EXCERPT_BYTES: usize = 2048;
/// Excerpts expire after 72 hours even when never acknowledged.
pub const EXCERPT_TTL_SECS: i64 = 72 * 3600;
/// Default cap on sealed excerpt bytes held in the outbox (64 MiB).
pub const DEFAULT_MAX_EXCERPT_BYTES_TOTAL: u64 = 64 * 1024 * 1024;
/// Default cap on outbox rows. Acknowledged rows go first.
pub const DEFAULT_MAX_ROWS: u64 = 500_000;
/// Acknowledged rows are kept this long for local inspection.
pub const ACKNOWLEDGED_RETENTION_SECS: i64 = 7 * 24 * 3600;
/// Name of the reporter's cursor, separate from the audit `REPORT_CURSOR`.
pub const VIOLATION_REPORT_CURSOR: &str = "violation_ingest";

/// `{requestId}:{attempt}:{detectorId}:{category}` (screener addendum 11.1,
/// which adds the category to spec 00.6 so one detector can report two codes
/// for one attempt).
pub fn dedupe_key(request_id: &str, attempt: u8, detector_id: &str, category: &str) -> String {
    format!("{request_id}:{attempt}:{detector_id}:{category}")
}

/// The internal subject a violation is attributed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    User,
    ForwardedUser,
    EndUser,
    Credential,
    Org,
    Node,
}

/// Whose credential the attempt spent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpendOwner {
    Ryu,
    Tenant,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectorKind {
    Regex,
    Inspector,
    InlineEvaluator,
    Wasm,
    Classifier,
    StreamDlp,
    Velocity,
    Upstream,
    UpstreamManual,
}

/// Which detector raised the verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorRef {
    pub kind: DetectorKind,
    /// A backend id, a detection kind or a tenant pattern name.
    pub id: String,
    /// `model@sha8#t<template>` for a classifier; required for that kind.
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementAction {
    LoggedOnly,
    Redacted,
    Blocked,
    Throttled,
    StreamTerminated,
    RefusedUpstream,
    BlockedUpstream,
    LocalUpstreamBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViolationDirection {
    Inbound,
    Outbound,
    ToolArgs,
    ToolResult,
    MediaInput,
    MediaOutput,
    Upstream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyLayer {
    Platform,
    Org,
    Team,
    Member,
    Key,
    Agent,
    Node,
}

/// The policy whose rule raised the verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRef {
    pub policy_id: Option<String>,
    pub assignment_id: Option<String>,
    pub layer: PolicyLayer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailMode {
    ClassifierOk,
    ClassifierUnavailableRegexFloor,
    Deadline,
    NotApplicable,
}

/// `Shadow` stays on the wire for the control-plane schema; Phase 2 only
/// ever writes `Enforced` (screener addendum section 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementMode {
    Enforced,
    Shadow,
}

/// One verdict (spec 03.4.2). The camelCase wire form is what
/// `POST /api/abuse/ingest` parses; optional fields default so an older
/// reporter's rows still read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViolationEvent {
    /// UUID v7 minted at the detection site, resent verbatim on retry.
    pub event_id: String,
    /// RFC 3339 UTC.
    pub occurred_at: String,
    pub request_id: String,
    pub attempt: u8,
    pub dedupe_key: String,
    /// The TENANT org, never the reporting gateway's.
    pub org_id: Option<String>,
    pub credential_id: Option<String>,
    /// Informational; the control plane recomputes it.
    #[serde(default)]
    pub custodian_user_id: Option<String>,
    /// JWT-verified only.
    #[serde(default)]
    pub actor_user_id: Option<String>,
    #[serde(default)]
    pub forwarded_user_hash: Option<String>,
    #[serde(default)]
    pub end_user_hash: Option<String>,
    #[serde(default)]
    pub previous_end_user_hash: Option<String>,
    pub actor_kind: ActorKind,
    pub actor_ref: String,
    #[serde(default)]
    pub upstream_subject: Option<String>,
    #[serde(default)]
    pub team_ids: Vec<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// The matched route template, for example `/v1/chat/completions`.
    pub route: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub slot_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub upstream_request_id: Option<String>,
    pub spend: SpendOwner,
    /// A `packages/safety-taxonomy` id.
    pub category: String,
    pub detector: DetectorRef,
    pub severity: Severity,
    #[serde(default)]
    pub confidence: Option<f32>,
    pub action: EnforcementAction,
    pub direction: ViolationDirection,
    #[serde(default)]
    pub policy: Option<PolicyRef>,
    pub fail_mode: FailMode,
    pub enforcement: EnforcementMode,
    #[serde(default)]
    pub impersonated_by: Option<String>,
    /// Set when a remote processor saw the content. An id, never a URL.
    #[serde(default)]
    pub processor_id: Option<String>,
    #[serde(default)]
    pub screening_id: Option<String>,
    /// `evd_<eventId>` while an excerpt travels with the event, else null.
    #[serde(default)]
    pub evidence_ref: Option<String>,
    /// Keyed hash of the normalized matched input (spec 00.8). Kept for S4.
    #[serde(default)]
    pub evidence_hmac: Option<String>,
}

impl ViolationEvent {
    /// Whether this event's category may ever carry an excerpt.
    pub fn excerpt_forbidden(&self) -> bool {
        self.category == CHILD_SAFETY_CODE
    }
}

impl EnforcementAction {
    /// How strong an outcome is, for one `dedupeKey` recorded twice: a flag
    /// on admission and a block on output by the same backend share a key.
    pub const fn rank(self) -> u8 {
        match self {
            EnforcementAction::LoggedOnly => 0,
            EnforcementAction::RefusedUpstream => 1,
            EnforcementAction::Redacted => 2,
            EnforcementAction::Throttled => 3,
            EnforcementAction::Blocked
            | EnforcementAction::StreamTerminated
            | EnforcementAction::BlockedUpstream
            | EnforcementAction::LocalUpstreamBlock => 4,
        }
    }
}

/// `Inserted` for a new row. `Upgraded` when an unreported row with the same
/// `dedupeKey` held a weaker action and now carries this one (under its
/// original `eventId`, which was never sent). `Duplicate` otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordOutcome {
    Inserted,
    Upgraded { event_id: String },
    Duplicate,
}

/// An unreported row, with its excerpt unsealed when one is still held.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxRow {
    pub id: i64,
    pub event: ViolationEvent,
    pub excerpt: Option<String>,
}

/// Bounds on what the outbox holds.
#[derive(Debug, Clone, Copy)]
pub struct OutboxLimits {
    pub max_excerpt_bytes_total: u64,
    pub max_rows: u64,
    pub excerpt_ttl_secs: i64,
    pub acknowledged_retention_secs: i64,
}

impl Default for OutboxLimits {
    fn default() -> Self {
        Self {
            max_excerpt_bytes_total: DEFAULT_MAX_EXCERPT_BYTES_TOTAL,
            max_rows: DEFAULT_MAX_ROWS,
            excerpt_ttl_secs: EXCERPT_TTL_SECS,
            acknowledged_retention_secs: ACKNOWLEDGED_RETENTION_SECS,
        }
    }
}

/// What one maintenance pass removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutboxMaintenance {
    pub expired_excerpts: u64,
    pub capped_excerpts: u64,
    pub deleted_rows: u64,
}
