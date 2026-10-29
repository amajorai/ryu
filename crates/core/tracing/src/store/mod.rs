//! The SQLite-backed [`TraceStore`] - connection, schema, and retention.
//!
//! The store's methods are split by concern across `policy` (content policy,
//! sealing, sink), `write` (span and scope lifecycle), and `read` (queries).

mod guard;
mod policy;
mod read;
mod write;

#[cfg(test)]
mod retention_tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU8;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::{ContentPolicy, ContentSealer, Span, SpanContext, SpanKind, SpanSink, SpanStatus};

pub use guard::ScopeGuard;

#[derive(Debug, Clone)]
struct ActiveScope {
    context: SpanContext,
    kind: SpanKind,
}

/// Where the content policy comes from: a fixed value, or a function the
/// host re-reads on every span so live privacy changes apply immediately.
#[derive(Clone, Copy)]
enum ContentSource {
    Fixed(ContentPolicy),
    Live(fn() -> ContentPolicy),
}

struct Inner {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    active: std::sync::Mutex<HashMap<String, Vec<ActiveScope>>>,
    content: std::sync::RwLock<ContentSource>,
    sealer: std::sync::RwLock<Option<Arc<dyn ContentSealer>>>,
    /// What the last write saw of the capture policy ([`CAPTURE_UNKNOWN`] until
    /// the first write), so stored payloads are cleared once when it is off.
    capture_state: AtomicU8,
    sink: std::sync::RwLock<Option<Arc<dyn SpanSink>>>,
}

const CAPTURE_UNKNOWN: u8 = 0;
const CAPTURE_ON: u8 = 1;
const CAPTURE_OFF: u8 = 2;
const INPUT_PURPOSE: &str = "spans.input";
const OUTPUT_PURPOSE: &str = "spans.output";

/// A span row with `input` and `output` still as stored (possibly sealed).
type RawSpan = (Span, Option<String>, Option<String>);

/// SQLite-backed trace store.  Cheap to clone — all clones share one
/// connection, scope stack, content policy, and sink.
#[derive(Clone)]
pub struct TraceStore {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct TracePruneSummary {
    pub deleted_rows: u64,
    pub retention_days: Option<u64>,
    pub max_rows: Option<u64>,
}

const DEFAULT_TRACE_RETENTION_DAYS: u64 = 90;
const DEFAULT_TRACE_MAX_ROWS: u64 = 1_000_000;

/// Stored status, with a derivation for rows written before the column existed.
fn status_sql(alias: &str) -> String {
    format!(
        "COALESCE({alias}.status, CASE WHEN {alias}.ended_at IS NULL THEN 'running' \
         WHEN {alias}.error IS NOT NULL THEN 'error' ELSE 'ok' END)"
    )
}

fn span_columns(alias: &str) -> String {
    format!(
        "{alias}.seq, {alias}.id, {alias}.conversation_id, {alias}.kind, {alias}.name, \
         {alias}.args_hash, {alias}.started_at, {alias}.ended_at, {alias}.error, \
         {alias}.session_id, {alias}.trace_id, {alias}.span_id, {alias}.parent_span_id, \
         {status}, {alias}.agent_id, {alias}.attributes, {alias}.input, {alias}.output",
        status = status_sql(alias)
    )
}

fn parse_json_text(text: Option<String>) -> Option<Value> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

fn span_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawSpan> {
    let status: String = row.get(13)?;
    let attributes = match parse_json_text(row.get(15)?) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let span = Span {
        seq: row.get(0)?,
        id: row.get(1)?,
        conversation_id: row.get(2)?,
        kind: row.get(3)?,
        name: row.get(4)?,
        args_hash: row.get(5)?,
        started_at: row.get(6)?,
        ended_at: row.get(7)?,
        error: row.get(8)?,
        session_id: row.get(9)?,
        trace_id: row.get(10)?,
        span_id: row.get(11)?,
        parent_span_id: row.get(12)?,
        status: SpanStatus::parse(&status).unwrap_or_default(),
        agent_id: row.get(14)?,
        attributes,
        input: None,
        output: None,
    };
    Ok((span, row.get(16)?, row.get(17)?))
}

fn trace_retention_policy() -> (Option<u64>, Option<u64>) {
    retention_policy_from(|name| std::env::var(name).ok())
}

/// Parse the retention bounds from `lookup`: `0` disables a bound and an
/// unset or unparseable value falls back to the default.
fn retention_policy_from(lookup: impl Fn(&str) -> Option<String>) -> (Option<u64>, Option<u64>) {
    let parse = |name: &str, fallback: u64| {
        lookup(name)
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|value| if value == 0 { None } else { Some(value) })
            .unwrap_or(Some(fallback))
    };
    (
        parse("RYU_TRACE_RETENTION_DAYS", DEFAULT_TRACE_RETENTION_DAYS),
        parse("RYU_TRACE_MAX_ROWS", DEFAULT_TRACE_MAX_ROWS),
    )
}

pub(crate) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn to_json_text(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| serde_json::to_string(value).ok())
}

impl TraceStore {
    fn from_parts(conn: Connection, path: Option<PathBuf>) -> Self {
        Self {
            inner: Arc::new(Inner {
                conn: Mutex::new(conn),
                path,
                active: std::sync::Mutex::new(HashMap::new()),
                content: std::sync::RwLock::new(ContentSource::Fixed(ContentPolicy::default())),
                sealer: std::sync::RwLock::new(None),
                capture_state: AtomicU8::new(CAPTURE_UNKNOWN),
                sink: std::sync::RwLock::new(None),
            }),
        }
    }

    /// Open (or create) the trace store at a specific path.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating trace db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening trace db {}", path.display()))?;
        // Rewritten and deleted payloads are zeroed in place, not left behind
        // in the page.
        conn.pragma_update(None, "secure_delete", "ON")
            .context("enabling secure_delete on the trace db")?;
        Self::init_schema(&conn)?;
        let (retention_days, max_rows) = trace_retention_policy();
        let summary = prune_connection(&conn, retention_days, max_rows)?;
        if summary.deleted_rows > 0 {
            tracing::info!(
                deleted_rows = summary.deleted_rows,
                "trace retention pass removed old spans"
            );
        }
        Ok(Self::from_parts(conn, Some(path)))
    }

    /// Open an in-memory store (tests / ephemeral use).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory trace db")?;
        Self::init_schema(&conn)?;
        Ok(Self::from_parts(conn, None))
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS spans (
                 seq             INTEGER PRIMARY KEY AUTOINCREMENT,
                 id              TEXT NOT NULL UNIQUE,
                 conversation_id TEXT NOT NULL,
                 kind            TEXT NOT NULL,
                 name            TEXT NOT NULL,
                 args_hash       TEXT,
                 started_at      INTEGER NOT NULL,
                 ended_at        INTEGER,
                 error           TEXT,
                 session_id      TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_spans_conversation
                 ON spans(conversation_id, seq);",
        )
        .context("initializing trace schema")?;

        // Additive migration guard — safe to call on every startup. Pre-v2 rows
        // keep NULLs in the hierarchical columns and stay readable.
        let existing: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(spans)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for column in [
            "session_id",
            "trace_id",
            "span_id",
            "parent_span_id",
            "status",
            "agent_id",
            "attributes",
            "input",
            "output",
        ] {
            if !existing.contains(column) {
                conn.execute_batch(&format!("ALTER TABLE spans ADD COLUMN {column} TEXT"))
                    .with_context(|| format!("adding {column} column"))?;
            }
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
             CREATE INDEX IF NOT EXISTS idx_spans_roots ON spans(parent_span_id, started_at);
             CREATE INDEX IF NOT EXISTS idx_spans_agent ON spans(agent_id, started_at);",
        )
        .context("creating hierarchical trace indexes")?;
        Ok(())
    }
}

fn prune_connection(
    conn: &Connection,
    retention_days: Option<u64>,
    max_rows: Option<u64>,
) -> Result<TracePruneSummary> {
    let mut deleted_rows = 0_u64;
    if let Some(days) = retention_days {
        let cutoff = chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::days(days.min(i64::MAX as u64) as i64))
            .map(|value| value.timestamp_millis())
            .unwrap_or(i64::MIN);
        deleted_rows = deleted_rows.saturating_add(
            conn.execute("DELETE FROM spans WHERE started_at < ?1", params![cutoff])? as u64,
        );
    }
    if let Some(max_rows) = max_rows {
        let max_rows = max_rows.min(i64::MAX as u64) as i64;
        deleted_rows = deleted_rows.saturating_add(conn.execute(
            "DELETE FROM spans
				 WHERE seq NOT IN (SELECT seq FROM spans ORDER BY seq DESC LIMIT ?1)",
            params![max_rows],
        )? as u64);
    }
    Ok(TracePruneSummary {
        deleted_rows,
        retention_days,
        max_rows,
    })
}
