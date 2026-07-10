use std::sync::{mpsc, Mutex};
use std::thread;

use dashmap::DashMap;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use crate::config::AuditConfig;

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
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ModelCall => "model_call",
            Self::ExecCall => "exec_call",
            Self::CredentialRead => "credential_read",
            Self::WidgetFollowUp => "widget_follow_up",
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
    /// Filter by gateway-internal request id (M4 / #176).
    pub request_id: Option<String>,
    /// Filter by Core session/conversation id (M4 / #176).
    /// When set, returns only the audit rows that belong to the given session.
    pub session_id: Option<String>,
    /// Filter by widget instance id (Ryu Apps, §4.4). When set, returns only the
    /// `callTool` / follow-up rows that belong to the given rendered widget.
    pub widget_instance_id: Option<String>,
}

/// Rolled-up totals across the whole local audit store. Used by the control-
/// plane reporter to push a single aggregate snapshot up the hierarchy.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AuditSummary {
    pub request_count: u64,
    pub error_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
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
    /// Widget instance id (Ryu Apps, §4.4); `None` for non-widget rows.
    pub widget_instance_id: Option<String>,
}

/// Default number of rows returned by a query when no limit is given.
const DEFAULT_QUERY_LIMIT: u32 = 100;
/// Hard ceiling on rows returned by a single query, to keep responses bounded.
const MAX_QUERY_LIMIT: u32 = 1_000;

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

        let conn = Connection::open(&config.db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS audit_log (
                 id            INTEGER PRIMARY KEY AUTOINCREMENT,
                 timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
                 request_id    TEXT    NOT NULL,
                 api_key       TEXT    NOT NULL,
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
        // Add the widget instance id column (Ryu Apps, §4.4) for existing tables.
        // Indexed so per-widget governance queries are efficient.
        let _ = conn.execute_batch(
            "ALTER TABLE audit_log ADD COLUMN widget_instance_id TEXT; \
             CREATE INDEX IF NOT EXISTS idx_audit_widget_instance_id ON audit_log(widget_instance_id);",
        );

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
                if let Err(e) = conn.execute(
                    "INSERT INTO audit_log (
                         request_id, api_key, user_name, org_id, team_id, project_id,
                         provider, model, input_tokens, output_tokens,
                         cache_hit, latency_ms, eval_score, error, skill_ids, session_id,
                         event_type, backend, command, duration_ms, exit_code,
                         user_id, agent_id, feature, widget_instance_id
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
                               ?17,?18,?19,?20,?21,?22,?23,?24,?25)",
                    params![
                        record.request_id,
                        record.api_key,
                        record.user_name,
                        record.org_id,
                        record.team_id,
                        record.project_id,
                        record.provider,
                        record.model,
                        record.input_tokens,
                        record.output_tokens,
                        record.cache_hit as i32,
                        record.latency_ms,
                        record.eval_score,
                        record.error,
                        record.skill_ids,
                        record.session_id,
                        record.event_type.as_str(),
                        record.backend,
                        record.command,
                        record.duration_ms.map(|v| v as i64),
                        record.exit_code,
                        record.user_id,
                        record.agent_id,
                        record.feature,
                        record.widget_instance_id,
                    ],
                ) {
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
            widget_instance_id: None,
        }
    }

    /// Return the total lifetime tokens used by `api_key`.
    pub fn token_usage(&self, api_key: &str) -> u64 {
        self.token_totals.get(api_key).map(|v| *v).unwrap_or(0)
    }

    /// Increment the in-memory token total for `api_key`.
    pub fn add_tokens(&self, api_key: &str, n: u64) {
        *self.token_totals.entry(api_key.to_string()).or_insert(0) += n;
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
        let mut push = |col: &'static str, val: &Option<String>| {
            if let Some(v) = val {
                clauses.push(col);
                binds.push(v.clone());
            }
        };
        push("api_key = ?", &query.api_key);
        push("org_id = ?", &query.org_id);
        push("team_id = ?", &query.team_id);
        push("project_id = ?", &query.project_id);
        push("provider = ?", &query.provider);
        push("model = ?", &query.model);
        push("request_id = ?", &query.request_id);
        push("session_id = ?", &query.session_id);
        push("widget_instance_id = ?", &query.widget_instance_id);
        if query.errors_only {
            clauses.push("error IS NOT NULL");
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

        let sql = format!(
            "SELECT id, timestamp, request_id, api_key, user_name, org_id, team_id, \
             project_id, provider, model, input_tokens, output_tokens, cache_hit, \
             latency_ms, eval_score, error, skill_ids, session_id, \
             event_type, backend, command, duration_ms, exit_code, \
             user_id, agent_id, feature, widget_instance_id \
             FROM audit_log {where_sql} ORDER BY id DESC LIMIT {limit}"
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
                api_key: redact_key(&row.get::<_, String>(3)?),
                user_name: row.get(4)?,
                org_id: row.get(5)?,
                team_id: row.get(6)?,
                project_id: row.get(7)?,
                provider: row.get(8)?,
                model: row.get(9)?,
                input_tokens: row.get::<_, i64>(10)? as u64,
                output_tokens: row.get::<_, i64>(11)? as u64,
                cache_hit: row.get::<_, i64>(12)? != 0,
                latency_ms: row.get::<_, i64>(13)? as u64,
                eval_score: row.get(14)?,
                error: row.get(15)?,
                skill_ids: row.get(16).unwrap_or(None),
                session_id: row.get(17).unwrap_or(None),
                event_type: row
                    .get::<_, Option<String>>(18)
                    .unwrap_or(None)
                    .unwrap_or_else(|| "model_call".to_owned()),
                backend: row.get(19).unwrap_or(None),
                command: row.get(20).unwrap_or(None),
                duration_ms: row
                    .get::<_, Option<i64>>(21)
                    .unwrap_or(None)
                    .map(|v| v as u64),
                exit_code: row.get(22).unwrap_or(None),
                user_id: row.get(23).unwrap_or(None),
                agent_id: row.get(24).unwrap_or(None),
                feature: row.get(25).unwrap_or(None),
                widget_instance_id: row.get(26).unwrap_or(None),
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
            "SELECT COUNT(*), \
             COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(input_tokens), 0), \
             COALESCE(SUM(output_tokens), 0) \
             FROM audit_log",
            [],
            |row| {
                Ok(AuditSummary {
                    request_count: row.get::<_, i64>(0)? as u64,
                    error_count: row.get::<_, i64>(1)? as u64,
                    input_tokens: row.get::<_, i64>(2)? as u64,
                    output_tokens: row.get::<_, i64>(3)? as u64,
                })
            },
        )?;
        Ok(row)
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
        wait_for_rows(&logger, &AuditQuery::default(), 2);

        let summary = logger.summary().expect("summary");
        assert_eq!(summary.request_count, 2);
        assert_eq!(summary.error_count, 1);
        // Each sample record carries 10 input + 5 output tokens.
        assert_eq!(summary.input_tokens, 20);
        assert_eq!(summary.output_tokens, 10);

        let _ = std::fs::remove_dir_all(&dir);
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
            "checklist__toggle".to_string(),
            Some("agent-1".to_string()),
            Some("conv-9".to_string()),
            "wi-abc".to_string(),
            12,
            None,
        );
        assert_eq!(rec.event_type, EventType::ExecCall);
        assert_eq!(rec.feature.as_deref(), Some("widget"));
        assert_eq!(rec.backend.as_deref(), Some("io.ryu.checklist"));
        assert_eq!(rec.command.as_deref(), Some("checklist__toggle"));
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
            "checklist__toggle".to_string(),
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

    /// Cheap unique-ish suffix for temp dirs without pulling extra deps into tests.
    fn unique_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
