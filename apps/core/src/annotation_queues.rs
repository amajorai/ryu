//! Core-owned persistence for human annotation queues.
//!
//! A queue belongs to one agent (so it reuses the agent ACL), carries the
//! reviewer rubric, an optional closed label set and a score range, and holds
//! items that reference a run (conversation), a single message in it, or an
//! externally observed trace. Reviewers claim the next item, submit a score,
//! labels and a comment, and completed items can be exported into a Prompt
//! Studio suite as regression cases (see `server::annotation_queues_api`).
//!
//! Encryption at rest: queue `description`, `rubric` and `labels`, and item
//! `input`, `output`, `metadata`, `labels` and `comment` are sealed per value as
//! `encb:v1:` under the `annotation-queues.db` content key, each bound to its row
//! id and column. Names, ids, source references, assignees, statuses, scores and
//! timestamps stay plaintext for listing, dedup and counts. Legacy rows are
//! sealed on open; a value that does not open is an error on a get and skipped
//! (counted) in a list.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::activity::sealed_store::{core_cipher, StoreSeal};

/// Registered store name (content-key input; never rename).
const STORE: &str = "annotation-queues.db";
const QUEUE_DESCRIPTION: &str = "annotation_queues.description";
const QUEUE_RUBRIC: &str = "annotation_queues.rubric";
const QUEUE_LABELS: &str = "annotation_queues.labels";
const ITEM_INPUT: &str = "annotation_items.input";
const ITEM_OUTPUT: &str = "annotation_items.output";
const ITEM_METADATA: &str = "annotation_items.metadata";
const ITEM_LABELS: &str = "annotation_items.labels";
const ITEM_COMMENT: &str = "annotation_items.comment";

fn column_plans() -> Result<Vec<ColumnPlan>> {
    [
        ("annotation_queues", "description"),
        ("annotation_queues", "rubric"),
        ("annotation_queues", "labels"),
        ("annotation_items", "input"),
        ("annotation_items", "output"),
        ("annotation_items", "metadata"),
        ("annotation_items", "labels"),
        ("annotation_items", "comment"),
    ]
    .into_iter()
    .map(|(table, column)| ColumnPlan::text(table, column, "id", KeyKind::Text))
    .collect()
}

fn context(purpose: &str, id: &str) -> ContentContext {
    ContentContext::for_id(purpose, id)
}

pub const MAX_QUEUE_ITEMS: i64 = 10_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_RUBRIC_CHARS: usize = 20_000;
const MAX_LABELS: usize = 50;
const MAX_LABEL_CHARS: usize = 100;
const MAX_COMMENT_CHARS: usize = 10_000;
pub const MAX_ITEM_TEXT_CHARS: usize = 20_000;
const MAX_LIST_LIMIT: i64 = 500;

/// Review state of one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    InProgress,
    Completed,
    Skipped,
}

impl ItemStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Skipped => "skipped",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "pending" => Self::Pending,
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "skipped" => Self::Skipped,
            other => anyhow::bail!("unknown annotation item status '{other}'"),
        })
    }
}

/// What an item points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// A whole run (conversation): its last user/assistant exchange.
    Run,
    /// One assistant message of a run.
    Message,
    /// An externally observed trace (for example a Gateway request/trace id).
    Trace,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Message => "message",
            Self::Trace => "trace",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "run" => Self::Run,
            "message" => Self::Message,
            "trace" => Self::Trace,
            other => anyhow::bail!("unknown annotation source kind '{other}'"),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnnotationQueue {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: Option<String>,
    pub rubric: String,
    /// Closed label vocabulary. Empty means free-form labels are rejected and
    /// only a score/comment is collected.
    pub labels: Vec<String>,
    pub score_min: f64,
    pub score_max: f64,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Fields accepted when creating or updating a queue.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueueInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub rubric: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub score_min: Option<f64>,
    #[serde(default)]
    pub score_max: Option<f64>,
}

/// Per-status item counts for a queue.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct QueueCounts {
    pub pending: i64,
    pub in_progress: i64,
    pub completed: i64,
    pub skipped: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueSummary {
    #[serde(flatten)]
    pub queue: AnnotationQueue,
    pub counts: QueueCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnnotationItem {
    pub id: String,
    pub queue_id: String,
    pub source_kind: SourceKind,
    pub run_id: Option<String>,
    pub message_id: Option<String>,
    pub trace_id: Option<String>,
    pub input: String,
    pub output: String,
    pub metadata: Value,
    pub assignee: Option<String>,
    pub status: ItemStatus,
    pub score: Option<f64>,
    pub labels: Vec<String>,
    pub comment: Option<String>,
    pub reviewed_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

/// A resolved item to add (the HTTP layer resolves runs/messages to text).
#[derive(Debug, Clone)]
pub struct NewItem {
    pub source_kind: SourceKind,
    pub run_id: Option<String>,
    pub message_id: Option<String>,
    pub trace_id: Option<String>,
    pub input: String,
    pub output: String,
    pub metadata: Value,
    pub assignee: Option<String>,
}

impl NewItem {
    /// Dedupe key: the same run/message/trace is queued at most once.
    fn source_key(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.source_kind.as_str(),
            self.run_id.as_deref().unwrap_or_default(),
            self.message_id.as_deref().unwrap_or_default(),
            self.trace_id.as_deref().unwrap_or_default()
        )
    }
}

/// A reviewer's verdict for one item.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Submission {
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub comment: Option<String>,
    /// `completed` (default) or `skipped`.
    #[serde(default)]
    pub status: Option<ItemStatus>,
}

/// Item list filter.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ItemFilter {
    #[serde(default)]
    pub status: Option<ItemStatus>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    /// Runs the caller may not read: items that point at them are left out.
    /// Set by the API from the per-conversation ACL, never from the request.
    #[serde(skip)]
    pub exclude_run_ids: Vec<String>,
}

#[derive(Clone)]
pub struct AnnotationQueueStore {
    conn: std::sync::Arc<Mutex<Connection>>,
    seal: StoreSeal,
}

static GLOBAL: OnceLock<AnnotationQueueStore> = OnceLock::new();

fn db_path() -> PathBuf {
    crate::paths::db_path("annotation-queues.db")
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

fn clip(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn optional_text(value: Option<&str>, max: usize, field: &str) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > max {
        anyhow::bail!("{field} must be at most {max} characters");
    }
    Ok(Some(value.to_owned()))
}

fn normalize_labels(labels: &[String]) -> Result<Vec<String>> {
    if labels.len() > MAX_LABELS {
        anyhow::bail!("at most {MAX_LABELS} labels are allowed");
    }
    let mut out: Vec<String> = Vec::with_capacity(labels.len());
    for label in labels {
        let label = label.trim();
        if label.is_empty() {
            anyhow::bail!("labels must not be empty");
        }
        if label.chars().count() > MAX_LABEL_CHARS {
            anyhow::bail!("labels must be at most {MAX_LABEL_CHARS} characters");
        }
        if !out.iter().any(|existing| existing == label) {
            out.push(label.to_owned());
        }
    }
    Ok(out)
}

/// Apply `input` over `base` and validate the merged queue definition.
fn merge_queue_input(base: &mut AnnotationQueue, input: &QueueInput) -> Result<()> {
    if let Some(name) = &input.name {
        base.name = name.trim().to_owned();
    }
    if base.name.is_empty() {
        anyhow::bail!("annotation queue name is required");
    }
    if base.name.chars().count() > MAX_NAME_CHARS {
        anyhow::bail!("annotation queue name must be at most {MAX_NAME_CHARS} characters");
    }
    if input.description.is_some() {
        base.description = optional_text(
            input.description.as_deref(),
            MAX_DESCRIPTION_CHARS,
            "description",
        )?;
    }
    if let Some(rubric) = &input.rubric {
        if rubric.chars().count() > MAX_RUBRIC_CHARS {
            anyhow::bail!("rubric must be at most {MAX_RUBRIC_CHARS} characters");
        }
        base.rubric = rubric.trim().to_owned();
    }
    if let Some(labels) = &input.labels {
        base.labels = normalize_labels(labels)?;
    }
    if let Some(min) = input.score_min {
        base.score_min = min;
    }
    if let Some(max) = input.score_max {
        base.score_max = max;
    }
    if !base.score_min.is_finite()
        || !base.score_max.is_finite()
        || base.score_min >= base.score_max
    {
        anyhow::bail!("score_min must be a finite number below score_max");
    }
    Ok(())
}

const QUEUE_COLUMNS: &str = "id, agent_id, name, description, rubric, labels, score_min, score_max, created_by, created_at, updated_at";
const ITEM_COLUMNS: &str = "id, queue_id, source_kind, run_id, message_id, trace_id, input, output, metadata, assignee, status, score, labels, comment, reviewed_by, created_at, updated_at, completed_at";

fn enum_column<T>(raw: String, index: usize, parse: fn(&str) -> Result<T>) -> rusqlite::Result<T> {
    parse(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::<dyn std::error::Error + Send + Sync>::from(error.to_string()),
        )
    })
}

/// The sealed values of one queue row.
struct SealedQueue {
    description: Option<String>,
    rubric: String,
    labels: String,
}

/// A queue row as stored: `description`, `rubric` and `labels` are still sealed.
struct RawQueue {
    queue: AnnotationQueue,
    labels: String,
}

/// An item row as stored: `input`, `output`, `comment`, `metadata` and `labels`
/// are still sealed.
struct RawItem {
    item: AnnotationItem,
    metadata: String,
    labels: String,
}

fn decode_queue(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawQueue> {
    Ok(RawQueue {
        queue: AnnotationQueue {
            id: row.get(0)?,
            agent_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            rubric: row.get(4)?,
            labels: Vec::new(),
            score_min: row.get(6)?,
            score_max: row.get(7)?,
            created_by: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        },
        labels: row.get(5)?,
    })
}

fn decode_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawItem> {
    Ok(RawItem {
        item: AnnotationItem {
            id: row.get(0)?,
            queue_id: row.get(1)?,
            source_kind: enum_column(row.get(2)?, 2, SourceKind::parse)?,
            run_id: row.get(3)?,
            message_id: row.get(4)?,
            trace_id: row.get(5)?,
            input: row.get(6)?,
            output: row.get(7)?,
            metadata: Value::Null,
            assignee: row.get(9)?,
            status: enum_column(row.get(10)?, 10, ItemStatus::parse)?,
            score: row.get(11)?,
            labels: Vec::new(),
            comment: row.get(13)?,
            reviewed_by: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
            completed_at: row.get(17)?,
        },
        metadata: row.get(8)?,
        labels: row.get(12)?,
    })
}

fn open_json<T: serde::de::DeserializeOwned>(
    seal: &StoreSeal,
    stored: &str,
    purpose: &str,
    id: &str,
) -> Result<T> {
    let json = seal.open(stored, &context(purpose, id))?;
    serde_json::from_str(&json).with_context(|| format!("decoding {purpose} of {id}"))
}

fn open_queue(seal: &StoreSeal, raw: RawQueue) -> Result<AnnotationQueue> {
    let RawQueue { mut queue, labels } = raw;
    let id = queue.id.clone();
    queue.description = seal.open_opt(
        queue.description.as_deref(),
        &context(QUEUE_DESCRIPTION, &id),
    )?;
    queue.rubric = seal.open(&queue.rubric, &context(QUEUE_RUBRIC, &id))?;
    queue.labels = open_json(seal, &labels, QUEUE_LABELS, &id)?;
    Ok(queue)
}

fn open_item(seal: &StoreSeal, raw: RawItem) -> Result<AnnotationItem> {
    let RawItem {
        mut item,
        metadata,
        labels,
    } = raw;
    let id = item.id.clone();
    item.input = seal.open(&item.input, &context(ITEM_INPUT, &id))?;
    item.output = seal.open(&item.output, &context(ITEM_OUTPUT, &id))?;
    item.comment = seal.open_opt(item.comment.as_deref(), &context(ITEM_COMMENT, &id))?;
    item.metadata = open_json(seal, &metadata, ITEM_METADATA, &id)?;
    item.labels = open_json(seal, &labels, ITEM_LABELS, &id)?;
    Ok(item)
}

/// Open every raw row, skipping (and counting) rows that do not open.
fn open_rows<R, T>(
    seal: &StoreSeal,
    rows: Vec<R>,
    open: impl Fn(&StoreSeal, R) -> Result<T>,
) -> Vec<T> {
    let mut out = Vec::with_capacity(rows.len());
    let mut skipped = 0u64;
    for row in rows {
        match open(seal, row) {
            Ok(value) => out.push(value),
            Err(_) => skipped += 1,
        }
    }
    seal.count_unreadable(skipped);
    out
}

fn get_queue_locked(
    conn: &Connection,
    seal: &StoreSeal,
    queue_id: &str,
) -> Result<Option<AnnotationQueue>> {
    conn.query_row(
        &format!("SELECT {QUEUE_COLUMNS} FROM annotation_queues WHERE id = ?1"),
        params![queue_id],
        decode_queue,
    )
    .optional()?
    .map(|raw| open_queue(seal, raw))
    .transpose()
}

fn get_item_locked(
    conn: &Connection,
    seal: &StoreSeal,
    queue_id: &str,
    item_id: &str,
) -> Result<Option<AnnotationItem>> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM annotation_items WHERE id = ?1 AND queue_id = ?2"),
        params![item_id, queue_id],
        decode_item,
    )
    .optional()?
    .map(|raw| open_item(seal, raw))
    .transpose()
}

fn counts_locked(conn: &Connection, queue_id: &str) -> Result<QueueCounts> {
    let mut counts = QueueCounts::default();
    let mut statement = conn.prepare(
        "SELECT status, COUNT(*) FROM annotation_items WHERE queue_id = ?1 GROUP BY status",
    )?;
    let rows = statement.query_map(params![queue_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (status, count) = row?;
        match status.as_str() {
            "pending" => counts.pending = count,
            "in_progress" => counts.in_progress = count,
            "completed" => counts.completed = count,
            "skipped" => counts.skipped = count,
            _ => {}
        }
        counts.total += count;
    }
    Ok(counts)
}

/// Validate a submission against its queue's score range and label set.
pub fn validate_submission(queue: &AnnotationQueue, submission: &Submission) -> Result<()> {
    if let Some(score) = submission.score {
        if !score.is_finite() || score < queue.score_min || score > queue.score_max {
            anyhow::bail!(
                "score must be within [{}, {}]",
                queue.score_min,
                queue.score_max
            );
        }
    }
    let labels = normalize_labels(&submission.labels)?;
    if let Some(unknown) = labels.iter().find(|label| !queue.labels.contains(label)) {
        anyhow::bail!("label '{unknown}' is not defined on this queue");
    }
    if submission
        .comment
        .as_deref()
        .is_some_and(|comment| comment.chars().count() > MAX_COMMENT_CHARS)
    {
        anyhow::bail!("comment must be at most {MAX_COMMENT_CHARS} characters");
    }
    if matches!(
        submission.status,
        Some(ItemStatus::Pending | ItemStatus::InProgress)
    ) {
        anyhow::bail!("a submission must complete or skip the item");
    }
    let completes = !matches!(submission.status, Some(ItemStatus::Skipped));
    if completes
        && submission.score.is_none()
        && labels.is_empty()
        && submission
            .comment
            .as_deref()
            .is_none_or(|comment| comment.trim().is_empty())
    {
        anyhow::bail!("a completed review needs a score, a label, or a comment");
    }
    Ok(())
}

/// Promptfoo-compatible suite case for an exported item.
pub fn item_to_suite_case(queue: &AnnotationQueue, item: &AnnotationItem) -> Value {
    let mut metadata = json!({
        "source": "ryu-annotation",
        "queueId": queue.id,
        "queueName": queue.name,
        "itemId": item.id,
        "sourceKind": item.source_kind.as_str(),
        "humanScore": item.score,
        "labels": item.labels,
        "comment": item.comment,
        "reviewedBy": item.reviewed_by,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
    });
    if let Some(object) = metadata.as_object_mut() {
        if let Some(run_id) = &item.run_id {
            object.insert("sourceRunId".to_owned(), json!(run_id));
        }
        if let Some(message_id) = &item.message_id {
            object.insert("sourceMessageId".to_owned(), json!(message_id));
        }
        if let Some(trace_id) = &item.trace_id {
            object.insert("sourceTraceId".to_owned(), json!(trace_id));
        }
    }
    json!({
        "id": format!("annotation-{}", item.id),
        "prompt": item.input,
        "expected": item.output,
        "metadata": metadata,
    })
}

impl AnnotationQueueStore {
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating annotation queue data dir")?;
        }
        Self::open_at(path, core_cipher(STORE)?)
    }

    /// Open the store at `path` under an explicit content cipher (tests).
    pub fn open_at(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening annotation queue database at {}", path.display()))?;
        Self::migrate(&conn)?;
        let seal = StoreSeal::prepare(&mut conn, Some(Path::new(&path)), cipher, &column_plans()?)
            .context("sealing the annotation queue store")?;
        let conn = std::sync::Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, Some(Path::new(&path)));
        Ok(Self { conn, seal })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        let seal = StoreSeal::prepare(&mut conn, None, core_cipher(STORE)?, &column_plans()?)
            .context("sealing the annotation queue store")?;
        Ok(Self {
            conn: std::sync::Arc::new(Mutex::new(conn)),
            seal,
        })
    }

    /// Values list reads skipped because they did not open (since open).
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS annotation_queues (
                id          TEXT PRIMARY KEY,
                agent_id    TEXT NOT NULL,
                name        TEXT NOT NULL,
                description TEXT,
                rubric      TEXT NOT NULL DEFAULT '',
                labels      TEXT NOT NULL DEFAULT '[]',
                score_min   REAL NOT NULL DEFAULT 0,
                score_max   REAL NOT NULL DEFAULT 1,
                created_by  TEXT,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_annotation_queues_agent
                ON annotation_queues(agent_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS annotation_items (
                id           TEXT PRIMARY KEY,
                queue_id     TEXT NOT NULL,
                source_kind  TEXT NOT NULL,
                source_key   TEXT NOT NULL,
                run_id       TEXT,
                message_id   TEXT,
                trace_id     TEXT,
                input        TEXT NOT NULL,
                output       TEXT NOT NULL,
                metadata     TEXT NOT NULL DEFAULT '{}',
                assignee     TEXT,
                status       TEXT NOT NULL DEFAULT 'pending',
                score        REAL,
                labels       TEXT NOT NULL DEFAULT '[]',
                comment      TEXT,
                reviewed_by  TEXT,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                completed_at INTEGER,
                UNIQUE (queue_id, source_key)
            );
            CREATE INDEX IF NOT EXISTS idx_annotation_items_queue_status
                ON annotation_items(queue_id, status, created_at);",
        )
        .context("creating annotation queue schema")?;
        Ok(())
    }

    /// The sealed columns of `queue`, bound to its id.
    fn seal_queue(&self, queue: &AnnotationQueue) -> Result<SealedQueue> {
        Ok(SealedQueue {
            description: self.seal.seal_opt(
                queue.description.as_deref(),
                &context(QUEUE_DESCRIPTION, &queue.id),
            )?,
            rubric: self
                .seal
                .seal(&queue.rubric, &context(QUEUE_RUBRIC, &queue.id))?,
            labels: self.seal.seal(
                &serde_json::to_string(&queue.labels)?,
                &context(QUEUE_LABELS, &queue.id),
            )?,
        })
    }

    pub fn install_global(store: Self) -> Result<()> {
        GLOBAL
            .set(store)
            .map_err(|_| anyhow::anyhow!("annotation queue store already installed"))
    }

    pub fn global() -> Option<&'static Self> {
        GLOBAL.get()
    }

    pub async fn create_queue(
        &self,
        agent_id: &str,
        input: &QueueInput,
        created_by: Option<&str>,
    ) -> Result<AnnotationQueue> {
        let now = now_millis();
        let mut queue = AnnotationQueue {
            id: new_id("aq"),
            agent_id: agent_id.to_owned(),
            name: String::new(),
            description: None,
            rubric: String::new(),
            labels: Vec::new(),
            score_min: 0.0,
            score_max: 1.0,
            created_by: created_by.map(str::to_owned),
            created_at: now,
            updated_at: now,
        };
        merge_queue_input(&mut queue, input)?;
        let sealed = self.seal_queue(&queue)?;
        let conn = self.conn.lock().await;
        conn.execute(
            &format!("INSERT INTO annotation_queues ({QUEUE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
            params![
                queue.id,
                queue.agent_id,
                queue.name,
                sealed.description,
                sealed.rubric,
                sealed.labels,
                queue.score_min,
                queue.score_max,
                queue.created_by,
                queue.created_at,
                queue.updated_at
            ],
        )?;
        Ok(queue)
    }

    pub async fn list_queues(&self, agent_id: &str) -> Result<Vec<QueueSummary>> {
        let conn = self.conn.lock().await;
        let queues = {
            let mut statement = conn.prepare(&format!(
                "SELECT {QUEUE_COLUMNS} FROM annotation_queues WHERE agent_id = ?1 ORDER BY updated_at DESC, id DESC"
            ))?;
            let rows = statement.query_map(params![agent_id], decode_queue)?;
            let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            open_rows(&self.seal, raw, open_queue)
        };
        queues
            .into_iter()
            .map(|queue| {
                let counts = counts_locked(&conn, &queue.id)?;
                Ok(QueueSummary { queue, counts })
            })
            .collect()
    }

    pub async fn get_queue(&self, queue_id: &str) -> Result<Option<AnnotationQueue>> {
        let conn = self.conn.lock().await;
        get_queue_locked(&conn, &self.seal, queue_id)
    }

    pub async fn queue_summary(&self, queue_id: &str) -> Result<Option<QueueSummary>> {
        let conn = self.conn.lock().await;
        let Some(queue) = get_queue_locked(&conn, &self.seal, queue_id)? else {
            return Ok(None);
        };
        let counts = counts_locked(&conn, queue_id)?;
        Ok(Some(QueueSummary { queue, counts }))
    }

    pub async fn update_queue(
        &self,
        queue_id: &str,
        input: &QueueInput,
    ) -> Result<Option<AnnotationQueue>> {
        let conn = self.conn.lock().await;
        let Some(mut queue) = get_queue_locked(&conn, &self.seal, queue_id)? else {
            return Ok(None);
        };
        merge_queue_input(&mut queue, input)?;
        queue.updated_at = now_millis();
        let sealed = self.seal_queue(&queue)?;
        conn.execute(
            "UPDATE annotation_queues SET name = ?1, description = ?2, rubric = ?3, labels = ?4,
                score_min = ?5, score_max = ?6, updated_at = ?7 WHERE id = ?8",
            params![
                queue.name,
                sealed.description,
                sealed.rubric,
                sealed.labels,
                queue.score_min,
                queue.score_max,
                queue.updated_at,
                queue.id
            ],
        )?;
        Ok(Some(queue))
    }

    pub async fn delete_queue(&self, queue_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<bool> {
            conn.execute(
                "DELETE FROM annotation_items WHERE queue_id = ?1",
                params![queue_id],
            )?;
            Ok(conn.execute(
                "DELETE FROM annotation_queues WHERE id = ?1",
                params![queue_id],
            )? > 0)
        })();
        finish_transaction(&conn, result)
    }

    /// Add items, skipping any whose run/message/trace is already queued.
    /// Returns the inserted items and the number skipped as duplicates.
    pub async fn add_items(
        &self,
        queue_id: &str,
        items: Vec<NewItem>,
    ) -> Result<Option<(Vec<AnnotationItem>, usize)>> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<Option<(Vec<AnnotationItem>, usize)>> {
            if get_queue_locked(&conn, &self.seal, queue_id)?.is_none() {
                return Ok(None);
            }
            let existing: i64 = conn.query_row(
                "SELECT COUNT(*) FROM annotation_items WHERE queue_id = ?1",
                params![queue_id],
                |row| row.get(0),
            )?;
            if existing + items.len() as i64 > MAX_QUEUE_ITEMS {
                anyhow::bail!("an annotation queue holds at most {MAX_QUEUE_ITEMS} items");
            }
            let mut added = Vec::with_capacity(items.len());
            let mut skipped = 0usize;
            for item in items {
                let now = now_millis();
                let id = new_id("aqi");
                let input = self.seal.seal(
                    &clip(&item.input, MAX_ITEM_TEXT_CHARS),
                    &context(ITEM_INPUT, &id),
                )?;
                let output = self.seal.seal(
                    &clip(&item.output, MAX_ITEM_TEXT_CHARS),
                    &context(ITEM_OUTPUT, &id),
                )?;
                let metadata = self.seal.seal(
                    &serde_json::to_string(&item.metadata)?,
                    &context(ITEM_METADATA, &id),
                )?;
                let labels = self.seal.seal("[]", &context(ITEM_LABELS, &id))?;
                let inserted = conn.execute(
                    "INSERT OR IGNORE INTO annotation_items
                        (id, queue_id, source_kind, source_key, run_id, message_id, trace_id,
                         input, output, metadata, assignee, status, labels, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?13)",
                    params![
                        id,
                        queue_id,
                        item.source_kind.as_str(),
                        item.source_key(),
                        item.run_id,
                        item.message_id,
                        item.trace_id,
                        input,
                        output,
                        metadata,
                        item.assignee,
                        labels,
                        now
                    ],
                )?;
                if inserted == 0 {
                    skipped += 1;
                    continue;
                }
                if let Some(item) = get_item_locked(&conn, &self.seal, queue_id, &id)? {
                    added.push(item);
                }
            }
            if !added.is_empty() {
                conn.execute(
                    "UPDATE annotation_queues SET updated_at = ?1 WHERE id = ?2",
                    params![now_millis(), queue_id],
                )?;
            }
            Ok(Some((added, skipped)))
        })();
        finish_transaction(&conn, result)
    }

    pub async fn list_items(
        &self,
        queue_id: &str,
        filter: &ItemFilter,
    ) -> Result<Vec<AnnotationItem>> {
        let limit = filter.limit.unwrap_or(100).clamp(1, MAX_LIST_LIMIT);
        let offset = filter.offset.unwrap_or(0).max(0);
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(&format!(
            "SELECT {ITEM_COLUMNS} FROM annotation_items
             WHERE queue_id = ?1 AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR assignee = ?3)
               AND (run_id IS NULL OR run_id NOT IN (SELECT value FROM json_each(?6)))
             ORDER BY created_at, rowid LIMIT ?4 OFFSET ?5"
        ))?;
        let rows = statement.query_map(
            params![
                queue_id,
                filter.status.map(ItemStatus::as_str),
                filter.assignee,
                limit,
                offset,
                serde_json::to_string(&filter.exclude_run_ids)?
            ],
            decode_item,
        )?;
        let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(open_rows(&self.seal, raw, open_item))
    }

    pub async fn get_item(&self, queue_id: &str, item_id: &str) -> Result<Option<AnnotationItem>> {
        let conn = self.conn.lock().await;
        get_item_locked(&conn, &self.seal, queue_id, item_id)
    }

    /// Claim the next item for `reviewer`: their own in-progress item first,
    /// else the oldest pending item that is unassigned or assigned to them.
    /// Atomic, so two reviewers never claim the same item.
    pub async fn next_item(
        &self,
        queue_id: &str,
        reviewer: &str,
    ) -> Result<Option<AnnotationItem>> {
        self.next_item_excluding(queue_id, reviewer, &[]).await
    }

    /// [`Self::next_item`], never claiming an item that points at one of
    /// `exclude_run_ids` (runs the reviewer may not read).
    pub async fn next_item_excluding(
        &self,
        queue_id: &str,
        reviewer: &str,
        exclude_run_ids: &[String],
    ) -> Result<Option<AnnotationItem>> {
        let excluded = serde_json::to_string(exclude_run_ids)?;
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<Option<AnnotationItem>> {
            let current: Option<String> = conn
                .query_row(
                    "SELECT id FROM annotation_items
                     WHERE queue_id = ?1 AND status = 'in_progress' AND assignee = ?2
                       AND (run_id IS NULL OR run_id NOT IN (SELECT value FROM json_each(?3)))
                     ORDER BY updated_at, rowid LIMIT 1",
                    params![queue_id, reviewer, excluded],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = current {
                return get_item_locked(&conn, &self.seal, queue_id, &id);
            }
            let next: Option<String> = conn
                .query_row(
                    "SELECT id FROM annotation_items
                     WHERE queue_id = ?1 AND status = 'pending'
                       AND (assignee IS NULL OR assignee = ?2)
                       AND (run_id IS NULL OR run_id NOT IN (SELECT value FROM json_each(?3)))
                     ORDER BY CASE WHEN assignee = ?2 THEN 0 ELSE 1 END, created_at, rowid
                     LIMIT 1",
                    params![queue_id, reviewer, excluded],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(id) = next else {
                return Ok(None);
            };
            conn.execute(
                "UPDATE annotation_items SET status = 'in_progress', assignee = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![reviewer, now_millis(), id],
            )?;
            get_item_locked(&conn, &self.seal, queue_id, &id)
        })();
        finish_transaction(&conn, result)
    }

    /// Reassign or release an item. `assignee = Some(None)` unassigns it;
    /// releasing an in-progress item returns it to `pending`.
    pub async fn assign_item(
        &self,
        queue_id: &str,
        item_id: &str,
        assignee: Option<&str>,
    ) -> Result<Option<AnnotationItem>> {
        let conn = self.conn.lock().await;
        let Some(item) = get_item_locked(&conn, &self.seal, queue_id, item_id)? else {
            return Ok(None);
        };
        let status = match (item.status, assignee) {
            (ItemStatus::InProgress, None) => ItemStatus::Pending,
            (status, _) => status,
        };
        conn.execute(
            "UPDATE annotation_items SET assignee = ?1, status = ?2, updated_at = ?3
             WHERE id = ?4 AND queue_id = ?5",
            params![assignee, status.as_str(), now_millis(), item_id, queue_id],
        )?;
        get_item_locked(&conn, &self.seal, queue_id, item_id)
    }

    /// Record a reviewer's verdict. Validates against the queue definition.
    pub async fn submit(
        &self,
        queue_id: &str,
        item_id: &str,
        submission: &Submission,
        reviewer: Option<&str>,
    ) -> Result<Option<AnnotationItem>> {
        let conn = self.conn.lock().await;
        let Some(queue) = get_queue_locked(&conn, &self.seal, queue_id)? else {
            return Ok(None);
        };
        let Some(item) = get_item_locked(&conn, &self.seal, queue_id, item_id)? else {
            return Ok(None);
        };
        // An item stays with the reviewer who owns it: one another reviewer has
        // claimed or was assigned, or whose review is already recorded, is never
        // overwritten by a different reviewer (a stale form, or a caller with edit
        // access). The connection lock makes this check and the write one step.
        let owned_by_other =
            |owner: Option<&str>| owner.is_some_and(|owner| Some(owner) != reviewer);
        let reviewed_by_other = matches!(item.status, ItemStatus::Completed | ItemStatus::Skipped)
            && owned_by_other(item.reviewed_by.as_deref());
        if owned_by_other(item.assignee.as_deref()) || reviewed_by_other {
            anyhow::bail!("this item is being reviewed by someone else");
        }
        validate_submission(&queue, submission)?;
        let status = submission.status.unwrap_or(ItemStatus::Completed);
        let now = now_millis();
        let comment = optional_text(submission.comment.as_deref(), MAX_COMMENT_CHARS, "comment")?;
        let comment = self
            .seal
            .seal_opt(comment.as_deref(), &context(ITEM_COMMENT, item_id))?;
        let labels = self.seal.seal(
            &serde_json::to_string(&normalize_labels(&submission.labels)?)?,
            &context(ITEM_LABELS, item_id),
        )?;
        conn.execute(
            "UPDATE annotation_items SET status = ?1, score = ?2, labels = ?3, comment = ?4,
                reviewed_by = ?5, completed_at = ?6, updated_at = ?6,
                assignee = COALESCE(assignee, ?5)
             WHERE id = ?7 AND queue_id = ?8",
            params![
                status.as_str(),
                submission.score,
                labels,
                comment,
                reviewer,
                now,
                item_id,
                queue_id
            ],
        )?;
        get_item_locked(&conn, &self.seal, queue_id, item_id)
    }

    /// Distinct conversation ids the queue's items were copied from.
    pub async fn run_ids(&self, queue_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT DISTINCT run_id FROM annotation_items
             WHERE queue_id = ?1 AND run_id IS NOT NULL",
        )?;
        let rows = statement.query_map(params![queue_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Delete every item copied from a conversation. Called when the
    /// conversation is deleted so no copy of its content outlives it.
    pub async fn delete_items_for_run(&self, run_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM annotation_items WHERE run_id = ?1",
            params![run_id],
        )?)
    }

    /// Delete every queue (and its items) that belongs to an agent. Called
    /// when the agent is deleted.
    pub async fn delete_queues_for_agent(&self, agent_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<usize> {
            conn.execute(
                "DELETE FROM annotation_items WHERE queue_id IN
                   (SELECT id FROM annotation_queues WHERE agent_id = ?1)",
                params![agent_id],
            )?;
            Ok(conn.execute(
                "DELETE FROM annotation_queues WHERE agent_id = ?1",
                params![agent_id],
            )?)
        })();
        finish_transaction(&conn, result)
    }

    pub async fn delete_item(&self, queue_id: &str, item_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM annotation_items WHERE id = ?1 AND queue_id = ?2",
            params![item_id, queue_id],
        )? > 0)
    }

    /// Completed items eligible for export, oldest first. `min_score` keeps
    /// only items whose human score is at least that value.
    pub async fn exportable_items(
        &self,
        queue_id: &str,
        min_score: Option<f64>,
        labels: &[String],
    ) -> Result<Vec<AnnotationItem>> {
        let items = {
            let conn = self.conn.lock().await;
            let mut statement = conn.prepare(&format!(
                "SELECT {ITEM_COLUMNS} FROM annotation_items
                 WHERE queue_id = ?1 AND status = 'completed'
                 ORDER BY completed_at, rowid"
            ))?;
            let rows = statement.query_map(params![queue_id], decode_item)?;
            let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            open_rows(&self.seal, raw, open_item)
        };
        Ok(items
            .into_iter()
            .filter(|item| min_score.is_none_or(|min| item.score.is_some_and(|score| score >= min)))
            .filter(|item| {
                labels.is_empty() || labels.iter().any(|label| item.labels.contains(label))
            })
            .collect())
    }
}

fn finish_transaction<T>(conn: &Connection, result: Result<T>) -> Result<T> {
    match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_input() -> QueueInput {
        QueueInput {
            name: Some("Support answers".to_owned()),
            rubric: Some("Is the answer correct and polite?".to_owned()),
            labels: Some(vec![
                "correct".to_owned(),
                "rude".to_owned(),
                "correct".to_owned(),
            ]),
            score_min: Some(1.0),
            score_max: Some(5.0),
            ..QueueInput::default()
        }
    }

    fn run_item(run: &str) -> NewItem {
        NewItem {
            source_kind: SourceKind::Run,
            run_id: Some(run.to_owned()),
            message_id: None,
            trace_id: None,
            input: "How do I reset my password?".to_owned(),
            output: "Use the reset link.".to_owned(),
            metadata: json!({}),
            assignee: None,
        }
    }

    #[tokio::test]
    async fn queue_crud_validates_and_counts() {
        let store = AnnotationQueueStore::open_in_memory().unwrap();
        let queue = store
            .create_queue("agent-1", &queue_input(), Some("user-1"))
            .await
            .unwrap();
        assert_eq!(queue.labels, vec!["correct", "rude"]);
        assert!(store
            .create_queue("agent-1", &QueueInput::default(), None)
            .await
            .is_err());
        assert!(store
            .create_queue(
                "agent-1",
                &QueueInput {
                    name: Some("bad".into()),
                    score_min: Some(2.0),
                    score_max: Some(1.0),
                    ..QueueInput::default()
                },
                None
            )
            .await
            .is_err());
        let updated = store
            .update_queue(
                &queue.id,
                &QueueInput {
                    name: Some("Renamed".into()),
                    ..QueueInput::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.rubric, queue.rubric);
        store
            .add_items(
                &queue.id,
                vec![run_item("r1"), run_item("r2"), run_item("r1")],
            )
            .await
            .unwrap()
            .unwrap();
        let listed = store.list_queues("agent-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].counts.pending, 2);
        assert_eq!(listed[0].counts.total, 2);
        assert!(store.list_queues("agent-2").await.unwrap().is_empty());
        assert!(store.delete_queue(&queue.id).await.unwrap());
        assert!(store.get_queue(&queue.id).await.unwrap().is_none());
        assert!(store
            .list_items(&queue.id, &ItemFilter::default())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn add_items_dedupes_by_source() {
        let store = AnnotationQueueStore::open_in_memory().unwrap();
        let queue = store.create_queue("a", &queue_input(), None).await.unwrap();
        let (added, skipped) = store
            .add_items(&queue.id, vec![run_item("r1"), run_item("r1")])
            .await
            .unwrap()
            .unwrap();
        assert_eq!((added.len(), skipped), (1, 1));
        let mut message = run_item("r1");
        message.source_kind = SourceKind::Message;
        message.message_id = Some("m1".into());
        let (added, skipped) = store
            .add_items(&queue.id, vec![message, run_item("r1")])
            .await
            .unwrap()
            .unwrap();
        assert_eq!((added.len(), skipped), (1, 1));
        assert!(store
            .add_items("missing", vec![run_item("r9")])
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn next_item_claims_atomically_and_resumes() {
        let store = AnnotationQueueStore::open_in_memory().unwrap();
        let queue = store.create_queue("a", &queue_input(), None).await.unwrap();
        let mut reserved = run_item("r3");
        reserved.assignee = Some("bob".into());
        store
            .add_items(&queue.id, vec![run_item("r1"), run_item("r2"), reserved])
            .await
            .unwrap();
        let alice = store.next_item(&queue.id, "alice").await.unwrap().unwrap();
        assert_eq!(alice.run_id.as_deref(), Some("r1"));
        assert_eq!(alice.status, ItemStatus::InProgress);
        // Alice resumes her in-progress item rather than claiming another.
        let again = store.next_item(&queue.id, "alice").await.unwrap().unwrap();
        assert_eq!(again.id, alice.id);
        // Bob gets the item reserved for him first.
        let bob = store.next_item(&queue.id, "bob").await.unwrap().unwrap();
        assert_eq!(bob.run_id.as_deref(), Some("r3"));
        // Releasing returns it to pending.
        let released = store
            .assign_item(&queue.id, &bob.id, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(released.status, ItemStatus::Pending);
        assert_eq!(released.assignee, None);
    }

    #[tokio::test]
    async fn items_of_unreadable_runs_are_left_out_of_list_and_claim() {
        let store = AnnotationQueueStore::open_in_memory().unwrap();
        let queue = store.create_queue("a", &queue_input(), None).await.unwrap();
        store
            .add_items(&queue.id, vec![run_item("secret"), run_item("shared")])
            .await
            .unwrap()
            .unwrap();
        let mut runs = store.run_ids(&queue.id).await.unwrap();
        runs.sort();
        assert_eq!(runs, vec!["secret".to_owned(), "shared".to_owned()]);

        let filter = ItemFilter {
            exclude_run_ids: vec!["secret".to_owned()],
            ..ItemFilter::default()
        };
        let listed = store.list_items(&queue.id, &filter).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].run_id.as_deref(), Some("shared"));

        // The oldest pending item is the excluded one, yet it is never claimed.
        let claimed = store
            .next_item_excluding(&queue.id, "carol", &["secret".to_owned()])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.run_id.as_deref(), Some("shared"));
        assert!(store
            .next_item_excluding(
                &queue.id,
                "carol",
                &["secret".to_owned(), "shared".to_owned()]
            )
            .await
            .unwrap()
            .is_none());
        let untouched = store
            .list_items(&queue.id, &ItemFilter::default())
            .await
            .unwrap();
        let secret = untouched
            .iter()
            .find(|item| item.run_id.as_deref() == Some("secret"))
            .unwrap();
        assert_eq!(secret.status, ItemStatus::Pending);
        assert_eq!(secret.assignee, None);
    }

    #[tokio::test]
    async fn deleting_a_conversation_or_agent_removes_its_annotation_copies() {
        let store = AnnotationQueueStore::open_in_memory().unwrap();
        let kept = store
            .create_queue("agent-keep", &queue_input(), None)
            .await
            .unwrap();
        let doomed = store
            .create_queue("agent-gone", &queue_input(), None)
            .await
            .unwrap();
        store
            .add_items(&kept.id, vec![run_item("r1"), run_item("r2")])
            .await
            .unwrap()
            .unwrap();
        store
            .add_items(&doomed.id, vec![run_item("r3")])
            .await
            .unwrap()
            .unwrap();

        assert_eq!(store.delete_items_for_run("r1").await.unwrap(), 1);
        let left = store
            .list_items(&kept.id, &ItemFilter::default())
            .await
            .unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].run_id.as_deref(), Some("r2"));

        assert_eq!(
            store.delete_queues_for_agent("agent-gone").await.unwrap(),
            1
        );
        assert!(store.get_queue(&doomed.id).await.unwrap().is_none());
        assert!(store
            .list_items(&doomed.id, &ItemFilter::default())
            .await
            .unwrap()
            .is_empty());
        assert!(store.get_queue(&kept.id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn submit_validates_and_export_builds_suite_cases() {
        let store = AnnotationQueueStore::open_in_memory().unwrap();
        let queue = store.create_queue("a", &queue_input(), None).await.unwrap();
        let (added, _) = store
            .add_items(&queue.id, vec![run_item("r1"), run_item("r2")])
            .await
            .unwrap()
            .unwrap();
        let bad_score = Submission {
            score: Some(9.0),
            ..Submission::default()
        };
        assert!(store
            .submit(&queue.id, &added[0].id, &bad_score, Some("alice"))
            .await
            .is_err());
        let bad_label = Submission {
            score: Some(4.0),
            labels: vec!["unknown".into()],
            ..Submission::default()
        };
        assert!(store
            .submit(&queue.id, &added[0].id, &bad_label, Some("alice"))
            .await
            .is_err());
        assert!(store
            .submit(
                &queue.id,
                &added[0].id,
                &Submission::default(),
                Some("alice")
            )
            .await
            .is_err());
        // An item claimed by another reviewer cannot be submitted over.
        let claimed = store.next_item(&queue.id, "bob").await.unwrap().unwrap();
        assert_eq!(claimed.id, added[0].id);
        let by_alice = Submission {
            score: Some(4.0),
            ..Submission::default()
        };
        assert!(store
            .submit(&queue.id, &added[0].id, &by_alice, Some("alice"))
            .await
            .is_err());
        store
            .assign_item(&queue.id, &added[0].id, None)
            .await
            .unwrap();
        let good = Submission {
            score: Some(4.0),
            labels: vec!["correct".into()],
            comment: Some("Accurate".into()),
            status: None,
        };
        let done = store
            .submit(&queue.id, &added[0].id, &good, Some("alice"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(done.status, ItemStatus::Completed);
        assert_eq!(done.reviewed_by.as_deref(), Some("alice"));
        assert!(done.completed_at.is_some());
        // A completed review is never overwritten by a different reviewer, while
        // its own reviewer may amend it.
        let by_bob = Submission {
            score: Some(1.0),
            ..Submission::default()
        };
        assert!(store
            .submit(&queue.id, &added[0].id, &by_bob, Some("bob"))
            .await
            .is_err());
        let kept = store
            .get_item(&queue.id, &added[0].id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (kept.score, kept.reviewed_by.as_deref()),
            (Some(4.0), Some("alice"))
        );
        store
            .submit(&queue.id, &added[0].id, &good, Some("alice"))
            .await
            .unwrap()
            .unwrap();
        // An item pre-assigned to another reviewer cannot be pre-empted.
        let mut reserved = run_item("r9");
        reserved.assignee = Some("alice".into());
        let (reserved, _) = store
            .add_items(&queue.id, vec![reserved])
            .await
            .unwrap()
            .unwrap();
        assert!(store
            .submit(&queue.id, &reserved[0].id, &by_bob, Some("bob"))
            .await
            .is_err());
        store.delete_item(&queue.id, &reserved[0].id).await.unwrap();
        let skip = Submission {
            status: Some(ItemStatus::Skipped),
            ..Submission::default()
        };
        store
            .submit(&queue.id, &added[1].id, &skip, Some("alice"))
            .await
            .unwrap();
        let exportable = store
            .exportable_items(&queue.id, Some(3.0), &[])
            .await
            .unwrap();
        assert_eq!(exportable.len(), 1);
        assert!(store
            .exportable_items(&queue.id, Some(4.5), &[])
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .exportable_items(&queue.id, None, &["rude".into()])
            .await
            .unwrap()
            .is_empty());
        let case = item_to_suite_case(&queue, &exportable[0]);
        assert_eq!(case["id"], format!("annotation-{}", exportable[0].id));
        assert_eq!(case["prompt"], "How do I reset my password?");
        assert_eq!(case["expected"], "Use the reset link.");
        assert_eq!(case["metadata"]["humanScore"], 4.0);
        assert_eq!(case["metadata"]["sourceRunId"], "r1");
        let counts = store
            .queue_summary(&queue.id)
            .await
            .unwrap()
            .unwrap()
            .counts;
        assert_eq!((counts.completed, counts.skipped), (1, 1));
    }

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[17u8; 32], STORE)
    }

    #[tokio::test]
    async fn content_columns_are_sealed_on_disk_and_legacy_rows_are_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("annotation-queues.db");
        // A legacy plaintext row, written before sealing existed.
        {
            let conn = Connection::open(&path).unwrap();
            AnnotationQueueStore::migrate(&conn).unwrap();
            conn.execute(
                "INSERT INTO annotation_queues (id, agent_id, name, description, rubric, labels, created_at, updated_at)
                 VALUES ('aq_legacy', 'a', 'Legacy', 'legacy-description', 'legacy-rubric', '[\"good\"]', 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO annotation_items (id, queue_id, source_kind, source_key, input, output, metadata, labels, comment, created_at, updated_at)
                 VALUES ('aqi_legacy', 'aq_legacy', 'run', 'run:r0::', 'legacy-input', 'legacy-output', '{\"k\":1}', '[\"good\"]', 'legacy-comment', 1, 1)",
                [],
            )
            .unwrap();
        }
        let store = AnnotationQueueStore::open_at(path.clone(), test_cipher()).unwrap();
        let legacy = store.get_queue("aq_legacy").await.unwrap().unwrap();
        assert_eq!(legacy.rubric, "legacy-rubric");
        assert_eq!(legacy.labels, vec!["good".to_owned()]);
        let legacy_item = store
            .get_item("aq_legacy", "aqi_legacy")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(legacy_item.comment.as_deref(), Some("legacy-comment"));
        assert_eq!(legacy_item.metadata["k"], 1);

        let mut input = queue_input();
        input.description = Some("description-marker".into());
        input.rubric = Some("rubric-marker".into());
        let queue = store.create_queue("a", &input, None).await.unwrap();
        let mut item = run_item("r1");
        item.input = "input-marker".into();
        item.output = "output-marker".into();
        let (added, _) = store
            .add_items(&queue.id, vec![item])
            .await
            .unwrap()
            .unwrap();
        let submission = Submission {
            score: Some(1.0),
            labels: vec!["correct".into()],
            comment: Some("comment-marker".into()),
            status: None,
        };
        store
            .submit(&queue.id, &added[0].id, &submission, Some("alice"))
            .await
            .unwrap()
            .unwrap();
        drop(store);

        let bytes = std::fs::read(&path).unwrap();
        for marker in [
            "legacy-description",
            "legacy-rubric",
            "legacy-input",
            "legacy-output",
            "legacy-comment",
            "description-marker",
            "rubric-marker",
            "input-marker",
            "output-marker",
            "comment-marker",
        ] {
            assert!(
                !bytes.windows(marker.len()).any(|w| w == marker.as_bytes()),
                "{marker} must not be readable on disk"
            );
        }

        // Reopened, the values read back; the labels column holds an envelope.
        let store = AnnotationQueueStore::open_at(path.clone(), test_cipher()).unwrap();
        let item = store
            .get_item(&queue.id, &added[0].id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(item.comment.as_deref(), Some("comment-marker"));
        assert_eq!(item.labels, vec!["correct".to_owned()]);
        let reread = store.get_queue(&queue.id).await.unwrap().unwrap();
        assert_eq!(reread.description.as_deref(), Some("description-marker"));
        let conn = Connection::open(&path).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT labels FROM annotation_items WHERE id = ?1",
                params![added[0].id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored.starts_with("encb:v1:"));
    }
}
