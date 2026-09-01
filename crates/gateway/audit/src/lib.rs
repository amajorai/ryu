use std::sync::{mpsc, Mutex};
use std::thread;

use dashmap::DashMap;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{error, info, warn};

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
    /// Path to the SQLite database file. Defaults to
    /// `$XDG_DATA_HOME/ryu/audit.db` (or `~/.local/share/ryu/audit.db`).
    #[serde(default = "default_audit_db_path")]
    pub db_path: String,
}

fn default_true() -> bool {
    true
}

fn default_audit_db_path() -> String {
    dirs::data_local_dir()
        .map(|d| d.join("ryu").join("audit.db"))
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "audit.db".to_string())
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
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ModelCall => "model_call",
            Self::ExecCall => "exec_call",
            Self::CredentialRead => "credential_read",
            Self::WidgetFollowUp => "widget_follow_up",
            Self::ControlChange => "control_change",
        }
    }
}

impl Default for EventType {
    fn default() -> Self {
        Self::ModelCall
    }
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
    pub cache_hit: bool,
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
    /// Only return rows with an id greater than this cursor. Cursor queries are
    /// oldest-first so callers can advance exactly once after a successful
    /// batch delivery; ordinary queries remain newest-first.
    pub id_after: Option<i64>,
}

/// Rolled-up totals across the whole local audit store. Used by the control-
/// plane reporter to push a single aggregate snapshot up the hierarchy.
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
}

/// One canonical 15-minute usage bucket returned to analytics consumers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditUsageEvent {
    pub timestamp: String,
    pub provider: String,
    pub model: String,
    pub member_id: Option<String>,
    pub node_id: Option<String>,
    pub feature: Option<String>,
    pub source: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
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
    pub cache_hit: bool,
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
}

/// Default number of rows returned by a query when no limit is given.
const DEFAULT_QUERY_LIMIT: u32 = 100;
/// Hard ceiling on rows returned by a single query, to keep responses bounded.
const MAX_QUERY_LIMIT: u32 = 1_000;

/// Keep sentinel identities readable because they are not credentials. Every
/// other API key is represented on disk by a deterministic SHA-256 lookup key;
/// the raw value remains available only in the request process.
fn api_key_storage_key(key: &str) -> String {
    if key == "anonymous" || key == "master" {
        return key.to_owned();
    }
    let mut digest = Sha256::new();
    digest.update(key.as_bytes());
    hex::encode(digest.finalize())
}

/// Migrate pre-hash audit rows in place. The display prefix preserves the UI's
/// existing redacted view while the original credential is removed from disk.
fn migrate_api_key_storage(conn: &Connection) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, api_key FROM audit_log
         WHERE api_key_prefix IS NULL OR api_key_prefix = ''",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, raw_key) in rows {
        conn.execute(
            "UPDATE audit_log SET api_key = ?1, api_key_prefix = ?2 WHERE id = ?3",
            params![api_key_storage_key(&raw_key), redact_key(&raw_key), id],
        )?;
    }
    Ok(())
}

/// SQLite-backed audit logger.
///
/// Writes are dispatched to a background OS thread via a bounded channel so
/// the async request path is never blocked on disk I/O.  The in-memory
/// `token_totals` map is used for real-time budget enforcement without
/// needing to query SQLite on the hot path.
pub struct AuditLogger {
    sender: mpsc::SyncSender<AuditRecord>,
    /// Read-only connection for local queries. Separate from the writer thread's
    /// connection; safe under WAL, serialised behind a mutex.
    reader: Option<Mutex<Connection>>,
    /// Per API-key lifetime token totals (input + output).
    token_totals: DashMap<String, u64>,
    enabled: bool,
}

impl AuditLogger {
    pub fn new(config: &AuditConfig) -> anyhow::Result<Self> {
        if !config.enabled {
            return Ok(Self::disabled());
        }

        // Ensure parent directories exist.
        if let Some(parent) = std::path::Path::new(&config.db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut conn = Connection::open(&config.db_path)?;
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
                 cache_hit     INTEGER NOT NULL DEFAULT 0,
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
        migrate_api_key_storage(&conn)?;
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
        // Add managed billing attribution and provider-reported cost. Both are
        // safe for existing audit databases and default old rows to unmanaged
        // with no provider-reported cost.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN managed_inference INTEGER NOT NULL DEFAULT 0;",
        );
        let _ =
            conn.execute_batch("ALTER TABLE audit_log ADD COLUMN provider_cost_micro_usd INTEGER;");
        // Add the widget instance id column (Ryu Apps, §4.4) for existing tables.
        // Indexed so per-widget governance queries are efficient.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN widget_instance_id TEXT; \
             CREATE INDEX IF NOT EXISTS idx_audit_widget_instance_id ON audit_log(widget_instance_id);",
        );

        // Keep the lifetime summary in a singleton row. The INSERT makes the
        // migration idempotent; the UPDATE backfills databases created by older
        // versions. New writes update this row in the same transaction as the
        // append-only audit row, so reads stay O(1) without sacrificing accuracy.
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
             );
             INSERT OR IGNORE INTO audit_summary (singleton) VALUES (1);
             UPDATE audit_summary SET
                 request_count = (SELECT COUNT(*) FROM audit_log WHERE event_type != 'control_change'),
                 error_count = (SELECT COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0)
                                FROM audit_log WHERE event_type != 'control_change'),
                 input_tokens = (SELECT COALESCE(SUM(input_tokens), 0)
                                 FROM audit_log WHERE event_type != 'control_change'),
                 output_tokens = (SELECT COALESCE(SUM(output_tokens), 0)
                                  FROM audit_log WHERE event_type != 'control_change'),
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
             WHERE singleton = 1;",
        )?;

        // Load existing per-key token totals so budget enforcement survives restarts.
        let token_totals: DashMap<String, u64> = DashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT api_key, SUM(input_tokens + output_tokens) \
                 FROM audit_log GROUP BY api_key",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows.flatten() {
                token_totals.insert(row.0, row.1 as u64);
            }
        }

        info!(db = %config.db_path, "audit store opened");

        // Dedicated read-only connection for local audit queries. WAL mode lets
        // this read concurrently with the background writer.
        let reader = Connection::open(&config.db_path)?;
        reader.execute_batch("PRAGMA query_only=ON;")?;

        let (sender, receiver) = mpsc::sync_channel::<AuditRecord>(1_000);

        thread::spawn(move || {
            for record in receiver {
                let is_summary_row = record.event_type != EventType::ControlChange;
                let is_model_call = record.event_type == EventType::ModelCall;
                let has_error = record.error.is_some();
                let reported_cost = record.provider_cost_micro_usd.unwrap_or(0);
                let is_unpriced_managed = is_model_call
                    && record.managed_inference
                    && record.provider_cost_micro_usd.is_none();

                let write_result = (|| -> rusqlite::Result<()> {
                    let tx = conn.transaction()?;
                    tx.execute(
                    "INSERT INTO audit_log (
                         request_id, api_key, api_key_prefix, user_name, org_id, team_id, project_id,
                         provider, model, input_tokens, output_tokens,
                         cache_hit, latency_ms, eval_score, error, skill_ids, session_id,
                         event_type, backend, command, duration_ms, exit_code,
                         user_id, agent_id, feature, managed_inference, provider_cost_micro_usd,
                         widget_instance_id
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,
                               ?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)",
                    params![
                        &record.request_id,
                        api_key_storage_key(&record.api_key),
                        redact_key(&record.api_key),
                        record.user_name.as_deref(),
                        record.org_id.as_deref(),
                        record.team_id.as_deref(),
                        record.project_id.as_deref(),
                        &record.provider,
                        &record.model,
                        record.input_tokens as i64,
                        record.output_tokens as i64,
                        record.cache_hit as i32,
                        record.latency_ms as i64,
                        record.eval_score,
                        record.error.as_deref(),
                        record.skill_ids.as_deref(),
                        record.session_id.as_deref(),
                        record.event_type.as_str(),
                        record.backend.as_deref(),
                        record.command.as_deref(),
                        record.duration_ms.map(|v| v as i64),
                        record.exit_code,
                        record.user_id.as_deref(),
                        record.agent_id.as_deref(),
                        record.feature.as_deref(),
                        record.managed_inference as i32,
                        record.provider_cost_micro_usd.map(|v| v as i64),
                        record.widget_instance_id.as_deref(),
                    ],
                )?;
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
                            i64::from(is_summary_row),
                            i64::from(is_summary_row && has_error),
                            if is_summary_row {
                                record.input_tokens as i64
                            } else {
                                0
                            },
                            if is_summary_row {
                                record.output_tokens as i64
                            } else {
                                0
                            },
                            if is_model_call && record.managed_inference {
                                reported_cost as i64
                            } else {
                                0
                            },
                            if is_unpriced_managed {
                                record.input_tokens as i64
                            } else {
                                0
                            },
                            if is_unpriced_managed {
                                record.output_tokens as i64
                            } else {
                                0
                            },
                        ],
                    )?;
                    tx.commit()
                })();
                if let Err(e) = write_result {
                    error!("audit log write failed: {e}");
                }
            }
        });

        Ok(Self {
            sender,
            reader: Some(Mutex::new(reader)),
            token_totals,
            enabled: true,
        })
    }

    fn disabled() -> Self {
        // Channel is created but nothing reads it — that's fine for a no-op logger.
        let (sender, _) = mpsc::sync_channel(1);
        Self {
            sender,
            reader: None,
            token_totals: DashMap::new(),
            enabled: false,
        }
    }

    /// Enqueue a record for async persistence. Drops silently if disabled or channel full.
    pub fn log(&self, record: AuditRecord) {
        if !self.enabled {
            return;
        }
        if let Err(e) = self.sender.try_send(record) {
            warn!("audit channel full or closed: {e}");
        }
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
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            project_id: None,
            provider: "sandbox".to_string(),
            model: backend.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_hit: false,
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
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            project_id: None,
            provider: "widget".to_string(),
            model: origin_server.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_hit: false,
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
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            project_id: None,
            provider: "widget".to_string(),
            model: origin_server.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_hit: false,
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
            request_id,
            api_key,
            user_name: None,
            org_id: None,
            team_id: None,
            project_id: None,
            provider: "identity".to_string(),
            model: source.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_hit: false,
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
            request_id,
            api_key,
            user_name: Some(actor),
            org_id: None,
            team_id: None,
            project_id: None,
            provider: "gateway_control".to_string(),
            model: target,
            input_tokens: 0,
            output_tokens: 0,
            cache_hit: false,
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
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: None,
        }
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
             user_id, agent_id, feature, widget_instance_id, managed_inference, provider_cost_micro_usd \
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
                managed_inference: row.get::<_, i64>(28).unwrap_or(0) != 0,
                provider_cost_micro_usd: row
                    .get::<_, Option<i64>>(29)
                    .unwrap_or(None)
                    .map(|v| v as u64),
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
                                   THEN output_tokens ELSE 0 END), 0)
             FROM audit_log
             WHERE {}
             GROUP BY bucket, provider, model, user_id, feature, managed_inference
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
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }
}

fn local_usage_source(provider: &str, managed_inference: bool) -> &'static str {
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
    /// Whether the store is enabled (persisting and queryable).
    fn is_enabled(&self) -> bool;
    /// Total lifetime tokens used by `api_key`.
    fn token_usage(&self, api_key: &str) -> u64;
    /// Increment the in-memory token total for `api_key`.
    fn add_tokens(&self, api_key: &str, n: u64);
    /// Query the store, newest-first, api_key redacted.
    fn query(&self, query: &AuditQuery) -> anyhow::Result<Vec<AuditEntry>>;
    /// Aggregate summary over the whole store.
    fn summary(&self) -> anyhow::Result<AuditSummary>;
    /// Canonical 15-minute usage buckets for analytics surfaces.
    fn usage_rollup(&self, query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>>;
}

impl AuditBackend for AuditLogger {
    fn log(&self, record: AuditRecord) {
        AuditLogger::log(self, record);
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
    fn usage_rollup(&self, query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>> {
        AuditLogger::usage_rollup(self, query)
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(request_id: &str, error: Option<&str>) -> AuditRecord {
        AuditRecord {
            request_id: request_id.to_string(),
            api_key: "sk-secret-1234567890".to_string(),
            user_name: Some("alice".to_string()),
            org_id: Some("org-1".to_string()),
            team_id: None,
            project_id: None,
            provider: "openai".to_string(),
            model: "gpt-4o".to_string(),
            input_tokens: 10,
            output_tokens: 5,
            cache_hit: false,
            latency_ms: 42,
            eval_score: None,
            error: error.map(|e| e.to_string()),
            skill_ids: None,
            session_id: None,
            event_type: EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            user_id: None,
            agent_id: None,
            feature: None,
            managed_inference: false,
            provider_cost_micro_usd: None,
            widget_instance_id: None,
        }
    }

    /// Block until the async writer thread has persisted at least `expected` rows.
    fn wait_for_rows(logger: &AuditLogger, query: &AuditQuery, expected: usize) -> Vec<AuditEntry> {
        for _ in 0..100 {
            let rows = logger.query(query).expect("query failed");
            if rows.len() >= expected {
                return rows;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("timed out waiting for {expected} audit rows");
    }

    #[test]
    fn redacts_api_key_to_prefix() {
        assert_eq!(redact_key("sk-secret-1234567890"), "sk-sec…");
        assert_eq!(redact_key("master"), "master");
        assert_eq!(redact_key("anonymous"), "anonymous");
    }

    #[test]
    fn stores_only_api_key_hash_and_supports_raw_key_filtering() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-hash-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        };
        let logger = AuditLogger::new(&config).expect("logger");
        let raw_key = "sk-secret-1234567890";
        logger.log(sample_record("req-hash", None));
        wait_for_rows(&logger, &AuditQuery::default(), 1);

        let conn = Connection::open(&db_path).unwrap();
        let (stored_key, prefix): (String, String) = conn
            .query_row(
                "SELECT api_key, api_key_prefix FROM audit_log WHERE request_id = 'req-hash'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_ne!(stored_key, raw_key);
        assert_eq!(stored_key, api_key_storage_key(raw_key));
        assert_eq!(prefix, "sk-sec…");
        assert!(!stored_key.contains("secret"));

        let filtered = logger
            .query(&AuditQuery {
                api_key: Some(raw_key.to_owned()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].api_key, "sk-sec…");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_raw_api_keys_before_serving_queries() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-migrate-{}", unique_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("audit.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                request_id TEXT NOT NULL,
                api_key TEXT NOT NULL,
                user_name TEXT,
                org_id TEXT,
                team_id TEXT,
                project_id TEXT,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_hit INTEGER NOT NULL DEFAULT 0,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                eval_score REAL,
                error TEXT
            );
            INSERT INTO audit_log (request_id, api_key, provider, model)
            VALUES ('legacy-req', 'sk-legacy-secret', 'openai', 'gpt-4o');",
        )
        .unwrap();
        drop(conn);

        let logger = AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        })
        .unwrap();
        let rows = logger
            .query(&AuditQuery {
                api_key: Some("sk-legacy-secret".to_owned()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].api_key, "sk-leg…");
        let summary = logger.summary().expect("backfilled summary");
        assert_eq!(summary.request_count, 1);

        let conn = Connection::open(&db_path).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT api_key FROM audit_log WHERE request_id = 'legacy-req'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(stored, "sk-legacy-secret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logs_and_queries_records_with_redaction() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-test-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_string(),
        };

        let logger = AuditLogger::new(&config).expect("logger");
        logger.log(sample_record("req-1", None));
        logger.log(sample_record("req-2", Some("provider exploded")));

        let all = wait_for_rows(&logger, &AuditQuery::default(), 2);
        // Newest-first ordering.
        assert_eq!(all[0].request_id, "req-2");
        // Raw key never returned.
        assert_eq!(all[0].api_key, "sk-sec…");
        assert!(!all[0].api_key.contains("1234567890"));

        // errors_only filter.
        let errors = logger
            .query(&AuditQuery {
                errors_only: true,
                ..Default::default()
            })
            .expect("query");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].request_id, "req-2");

        // provider filter.
        let by_provider = logger
            .query(&AuditQuery {
                provider: Some("openai".to_string()),
                ..Default::default()
            })
            .expect("query");
        assert_eq!(by_provider.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_queries_are_exclusive_and_oldest_first() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-cursor-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let logger = AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        })
        .unwrap();
        logger.log(sample_record("req-1", None));
        logger.log(sample_record("req-2", None));
        logger.log(sample_record("req-3", None));

        let all = wait_for_rows(&logger, &AuditQuery::default(), 3);
        let cursor = all.last().expect("oldest row").id;
        let next = logger
            .query(&AuditQuery {
                id_after: Some(cursor),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            next.iter()
                .map(|entry| entry.request_id.as_str())
                .collect::<Vec<_>>(),
            vec!["req-2", "req-3"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_logger_returns_empty() {
        let logger = AuditLogger::disabled();
        assert!(!logger.is_enabled());
        assert!(logger.query(&AuditQuery::default()).unwrap().is_empty());
        let summary = logger.summary().expect("summary");
        assert_eq!(summary.request_count, 0);
        assert_eq!(summary.error_count, 0);
    }

    #[test]
    fn summary_rolls_up_totals() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-sum-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_string(),
        };

        let logger = AuditLogger::new(&config).expect("logger");
        logger.log(sample_record("req-1", None));
        logger.log(sample_record("req-2", Some("boom")));
        logger.log(AuditLogger::make_control_record(
            "control-1".to_string(),
            "master".to_string(),
            "master-key".to_string(),
            None,
            "config.apply".to_string(),
            "gateway_config".to_string(),
            Some("firewall".to_string()),
        ));
        wait_for_rows(&logger, &AuditQuery::default(), 3);

        let summary = logger.summary().expect("summary");
        assert_eq!(summary.request_count, 2);
        assert_eq!(summary.error_count, 1);
        // Each sample record carries 10 input + 5 output tokens.
        assert_eq!(summary.input_tokens, 20);
        assert_eq!(summary.output_tokens, 10);

        let controls = logger
            .query(&AuditQuery {
                event_type: Some("control_change".to_string()),
                ..Default::default()
            })
            .expect("control query");
        assert_eq!(controls.len(), 1);
        assert_eq!(controls[0].user_name.as_deref(), Some("master-key"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_rollup_uses_canonical_buckets_and_exact_event_math() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-usage-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let logger = AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        })
        .expect("logger");

        let conn = Connection::open(&db_path).expect("writer connection");
        conn.execute_batch(
            "INSERT INTO audit_log (
                 timestamp, request_id, api_key, provider, model, input_tokens,
                 output_tokens, latency_ms, error, event_type, user_id, feature,
                 managed_inference, provider_cost_micro_usd
             ) VALUES
                 ('2026-08-22 10:01:00', 'model-1', 'master', 'openrouter', 'gpt-5',
                  100, 40, 250, NULL, 'model_call', 'member-1', 'chat', 1, 90),
                 ('2026-08-22 10:14:59', 'model-2', 'master', 'openrouter', 'gpt-5',
                  20, 10, 750, 'failed', 'model_call', 'member-1', 'chat', 1, NULL),
                 ('2026-08-22 10:12:00', 'exec-1', 'master', 'openrouter', 'gpt-5',
                  0, 0, 0, NULL, 'exec_call', 'member-1', 'chat', 1, NULL),
                 ('2026-08-22 10:15:00', 'model-3', 'master', 'anthropic', 'claude',
                  9, 3, 100, NULL, 'model_call', NULL, 'agent', 0, NULL);
             UPDATE audit_log SET duration_ms = 2500 WHERE request_id = 'exec-1';",
        )
        .expect("seed usage rows");

        let events = logger
            .usage_rollup(&AuditUsageQuery {
                timestamp_from: "2026-08-22T10:00:00Z".to_owned(),
                timestamp_until: "2026-08-22T10:15:00Z".to_owned(),
                provider: Some("openrouter".to_owned()),
                model: Some("gpt-5".to_owned()),
            })
            .expect("usage rollup");
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.timestamp, "2026-08-22T10:00:00Z");
        assert_eq!(event.member_id.as_deref(), Some("member-1"));
        assert_eq!(event.feature.as_deref(), Some("chat"));
        assert_eq!(event.source, "managed");
        assert_eq!(event.input_tokens, 120);
        assert_eq!(event.output_tokens, 50);
        assert_eq!(event.request_count, 2);
        assert_eq!(event.error_count, 1);
        assert_eq!(event.latency_total_ms, 1000);
        assert_eq!(event.latency_samples, 2);
        assert_eq!(event.agent_seconds, 2.5);
        assert_eq!(event.cost_micro_usd, Some(90));
        assert_eq!(event.unpriced_input_tokens, 20);
        assert_eq!(event.unpriced_output_tokens, 10);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persists_managed_provider_cost_and_separates_unpriced_tokens() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-cost-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let logger = AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_string(),
        })
        .expect("logger");

        let mut priced = sample_record("priced", None);
        priced.managed_inference = true;
        priced.provider_cost_micro_usd = Some(1_250);
        logger.log(priced);

        let mut unpriced = sample_record("unpriced", None);
        unpriced.managed_inference = true;
        logger.log(unpriced);
        let rows = wait_for_rows(&logger, &AuditQuery::default(), 2);

        let priced_row = rows
            .iter()
            .find(|row| row.request_id == "priced")
            .expect("priced row");
        assert!(priced_row.managed_inference);
        assert_eq!(priced_row.provider_cost_micro_usd, Some(1_250));

        let summary = logger.summary().expect("summary");
        assert_eq!(summary.reported_cost_micro_usd, 1_250);
        assert_eq!(summary.unpriced_input_tokens, 10);
        assert_eq!(summary.unpriced_output_tokens, 5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_record_shape() {
        let record = AuditLogger::make_control_record(
            "control-id".to_string(),
            "master".to_string(),
            "loopback-admin".to_string(),
            Some("user-123".to_string()),
            "firewall.update".to_string(),
            "firewall_policy".to_string(),
            Some("enabled, policy".to_string()),
        );
        assert_eq!(record.event_type, EventType::ControlChange);
        assert_eq!(record.event_type.as_str(), "control_change");
        assert_eq!(record.user_name.as_deref(), Some("loopback-admin"));
        assert_eq!(record.user_id.as_deref(), Some("user-123"));
        assert_eq!(record.model, "firewall_policy");
        assert_eq!(
            record.command.as_deref(),
            Some("firewall.update: enabled, policy")
        );
        assert_eq!(record.backend.as_deref(), Some("gateway_admin"));
        assert_eq!(record.input_tokens, 0);
        assert_eq!(record.output_tokens, 0);
    }

    #[test]
    fn agent_control_record_keeps_the_agent_passport_link() {
        let record = AuditLogger::make_control_record_with_agent(
            "control-agent-id".to_owned(),
            "master".to_owned(),
            "member@example.com".to_owned(),
            Some("user-123".to_owned()),
            Some("agent-support".to_owned()),
            "agent.update".to_owned(),
            "agent:agent-support".to_owned(),
            Some("successful Core agent-management mutation".to_owned()),
        );
        assert_eq!(record.agent_id.as_deref(), Some("agent-support"));
        assert_eq!(record.user_id.as_deref(), Some("user-123"));
        assert_eq!(record.event_type, EventType::ControlChange);
    }

    /// Log a record with an explicit session_id.
    fn sample_record_with_session(request_id: &str, session_id: &str) -> AuditRecord {
        AuditRecord {
            session_id: Some(session_id.to_string()),
            ..sample_record(request_id, None)
        }
    }

    /// Verifies that logging two different sessions and querying by session_id returns
    /// only the rows that belong to the requested session (M4 / #176 AC4).
    #[test]
    fn session_id_filter_returns_only_matching_session() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-session-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_string(),
        };

        let logger = AuditLogger::new(&config).expect("logger");

        // Two requests belonging to session A.
        logger.log(sample_record_with_session("req-a1", "session-A"));
        logger.log(sample_record_with_session("req-a2", "session-A"));
        // One request belonging to session B.
        logger.log(sample_record_with_session("req-b1", "session-B"));

        // Wait for all three rows to be persisted.
        wait_for_rows(&logger, &AuditQuery::default(), 3);

        // Querying by session-A must return exactly two rows.
        let session_a_rows = logger
            .query(&AuditQuery {
                session_id: Some("session-A".to_string()),
                ..Default::default()
            })
            .expect("query by session_id");
        assert_eq!(session_a_rows.len(), 2, "expected 2 rows for session-A");
        for entry in &session_a_rows {
            assert_eq!(entry.session_id.as_deref(), Some("session-A"));
        }

        // Querying by session-B must return exactly one row.
        let session_b_rows = logger
            .query(&AuditQuery {
                session_id: Some("session-B".to_string()),
                ..Default::default()
            })
            .expect("query by session_id session-B");
        assert_eq!(session_b_rows.len(), 1, "expected 1 row for session-B");
        assert_eq!(session_b_rows[0].request_id, "req-b1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamp_range_accepts_iso_bounds_and_excludes_upper_bound() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-timestamp-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        };
        let logger = AuditLogger::new(&config).expect("logger");
        logger.log(sample_record("req-time", None));
        let rows = wait_for_rows(&logger, &AuditQuery::default(), 1);
        let iso_timestamp = format!("{}Z", rows[0].timestamp.replace(' ', "T"));

        let in_range = logger
            .query(&AuditQuery {
                timestamp_from: Some(iso_timestamp.clone()),
                timestamp_until: Some("2999-01-01T00:00:00Z".to_string()),
                ..Default::default()
            })
            .expect("query by ISO timestamp range");
        assert_eq!(in_range.len(), 1);

        let at_upper_bound = logger
            .query(&AuditQuery {
                timestamp_until: Some(iso_timestamp),
                ..Default::default()
            })
            .expect("query by exclusive upper bound");
        assert!(at_upper_bound.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #523: the credential-read constructor produces a distinct, attributable
    /// record (domain in `command`, source in `backend`/`model`) that is NOT a
    /// sandbox exec — so identity reads are filterable and never look like execs.
    #[test]
    fn credential_read_record_shape() {
        let rec = AuditLogger::make_credential_read_record(
            "req-id".to_string(),
            "sk-core".to_string(),
            "manual".to_string(),
            "app.example.com".to_string(),
            Some("session-X".to_string()),
            None,
        );
        assert_eq!(rec.event_type, EventType::CredentialRead);
        assert_eq!(rec.event_type.as_str(), "credential_read");
        assert_eq!(rec.provider, "identity");
        // Source is attributable via both backend and the model slot.
        assert_eq!(rec.backend.as_deref(), Some("manual"));
        assert_eq!(rec.model, "manual");
        // The domain — never a secret — lands in the command slot.
        assert_eq!(rec.command.as_deref(), Some("app.example.com"));
        assert_eq!(rec.session_id.as_deref(), Some("session-X"));
        // Inert exec-only fields don't masquerade as an execution.
        assert!(rec.duration_ms.is_none());
        assert!(rec.exit_code.is_none());
    }

    /// §4.4: the widget `callTool` constructor produces an attributable
    /// `ExecCall` tagged `feature="widget"` (backend=origin_server,
    /// command=tool_id) carrying the per-render instance id — so it drains the
    /// exec budget like any tool run but is filterable per widget.
    #[test]
    fn widget_call_record_shape() {
        let rec = AuditLogger::make_widget_call_record(
            "req-id".to_string(),
            "sk-core".to_string(),
            "io.ryu.checklist".to_string(),
            "checklist.toggle".to_string(),
            Some("agent-1".to_string()),
            Some("conv-9".to_string()),
            "wi-abc".to_string(),
            12,
            None,
        );
        assert_eq!(rec.event_type, EventType::ExecCall);
        assert_eq!(rec.feature.as_deref(), Some("widget"));
        assert_eq!(rec.backend.as_deref(), Some("io.ryu.checklist"));
        assert_eq!(rec.command.as_deref(), Some("checklist.toggle"));
        assert_eq!(rec.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(rec.session_id.as_deref(), Some("conv-9"));
        assert_eq!(rec.widget_instance_id.as_deref(), Some("wi-abc"));
    }

    /// §4.4: the widget follow-up constructor is its own `WidgetFollowUp`
    /// discriminator (never an exec) so follow-ups are filterable on their own.
    #[test]
    fn widget_followup_record_shape() {
        let rec = AuditLogger::make_widget_followup_record(
            "req-id".to_string(),
            "sk-core".to_string(),
            "io.ryu.checklist".to_string(),
            Some("conv-9".to_string()),
            "wi-abc".to_string(),
            Some("firewall: prompt_injection".to_string()),
        );
        assert_eq!(rec.event_type, EventType::WidgetFollowUp);
        assert_eq!(rec.event_type.as_str(), "widget_follow_up");
        assert_eq!(rec.feature.as_deref(), Some("widget"));
        assert_eq!(rec.command.as_deref(), Some("follow_up"));
        assert_eq!(rec.session_id.as_deref(), Some("conv-9"));
        assert_eq!(rec.widget_instance_id.as_deref(), Some("wi-abc"));
        assert!(rec.duration_ms.is_none());
    }

    /// §4.4: logging widget rows and querying by `widget_instance_id` returns
    /// only the rows for that rendered widget.
    #[test]
    fn widget_instance_id_filter_returns_only_matching_widget() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-widget-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_string(),
        };

        let logger = AuditLogger::new(&config).expect("logger");
        logger.log(AuditLogger::make_widget_call_record(
            "req-w1".to_string(),
            "sk-core".to_string(),
            "io.ryu.checklist".to_string(),
            "checklist.toggle".to_string(),
            None,
            Some("conv-9".to_string()),
            "wi-A".to_string(),
            5,
            None,
        ));
        logger.log(AuditLogger::make_widget_followup_record(
            "req-w2".to_string(),
            "sk-core".to_string(),
            "io.ryu.checklist".to_string(),
            Some("conv-9".to_string()),
            "wi-B".to_string(),
            None,
        ));
        wait_for_rows(&logger, &AuditQuery::default(), 2);

        let wi_a = logger
            .query(&AuditQuery {
                widget_instance_id: Some("wi-A".to_string()),
                ..Default::default()
            })
            .expect("query by widget_instance_id");
        assert_eq!(wi_a.len(), 1);
        assert_eq!(wi_a[0].request_id, "req-w1");
        assert_eq!(wi_a[0].widget_instance_id.as_deref(), Some("wi-A"));
        assert_eq!(wi_a[0].feature.as_deref(), Some("widget"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_id_filter_returns_only_matching_rows() {
        let dir = std::env::temp_dir().join(format!("ryu-audit-agent-{}", unique_suffix()));
        let db_path = dir.join("audit.db");
        let logger = AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        })
        .expect("logger");

        let mut agent_a = sample_record("req-agent-a", None);
        agent_a.agent_id = Some("agent-a".to_owned());
        let mut agent_b = sample_record("req-agent-b", None);
        agent_b.agent_id = Some("agent-b".to_owned());
        logger.log(agent_a);
        logger.log(agent_b);

        let rows = wait_for_rows(
            &logger,
            &AuditQuery {
                agent_id: Some("agent-a".to_owned()),
                ..Default::default()
            },
            1,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent_id.as_deref(), Some("agent-a"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cheap unique-ish suffix for temp dirs without pulling extra deps into tests.
    fn unique_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
