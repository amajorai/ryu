//! Working memory: a structured, per-thread or per-resource scratchpad.
//!
//! Long-term memory ([`crate::MemoryStore::record_full`]) is a growing set of
//! discrete facts that are *recalled* by relevance. Working memory is the other
//! shape: ONE small document per `(owner, scope, id)` that the agent keeps
//! up to date and that is injected, whole, into its context on every turn — the
//! user's name, the goal of the current task, the decisions made so far.
//!
//! Two modes, chosen by how the scratchpad is described:
//!
//! * **Template** ([`WorkingMemoryMode::Template`]) — free-form Markdown seeded
//!   from a template. An update *replaces* the whole document, so the agent
//!   rewrites the template with the fields filled in.
//! * **Schema** ([`WorkingMemoryMode::Schema`]) — a JSON object described by a
//!   JSON Schema. An update is a JSON **merge patch** (RFC 7386: objects merge
//!   recursively, `null` deletes a key, everything else replaces), and the merged
//!   result is validated against the schema before it is stored.
//!
//! Scope:
//!
//! * [`WorkingMemoryScope::Thread`] — `id` is a conversation / thread id; the
//!   scratchpad lives and dies with one conversation.
//! * [`WorkingMemoryScope::Resource`] — `id` is a caller-chosen resource key
//!   (a user, a customer, a project); the scratchpad is shared by every thread
//!   that names the same resource.
//!
//! Tenancy: every row is partitioned by the owning user derived from the shared
//! [`ResourceKey`] ([`crate::memory_user_from_key`]). A caller can only ever
//! address its OWN partition, so a guessed thread or resource id never reaches
//! another user's scratchpad. Further gates (e.g. "the caller may see this
//! conversation") are the host's job and live in Core.
//!
//! Storage: the document (content / data / template / schema) is encrypted at
//! rest with the same [`ryu_crypto`] cipher as long-term memory; only the routing
//! key `(owner, scope, id)`, the mode, and timestamps are plaintext.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_kernel_contracts::ResourceKey;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{memory_user_from_key, now_millis, MemoryStore};

/// Largest serialized working-memory document (content or data) accepted, in
/// bytes. Working memory is injected into EVERY turn, so it must stay small.
pub const MAX_WORKING_MEMORY_BYTES: usize = 16 * 1024;
/// Largest template or schema accepted, in bytes.
pub const MAX_WORKING_MEMORY_SPEC_BYTES: usize = 16 * 1024;
/// Longest thread / resource id accepted.
pub const MAX_WORKING_MEMORY_ID_LEN: usize = 256;
/// Deepest JSON nesting a schema-mode merge or validation will walk.
const MAX_DEPTH: usize = 32;

/// The default Markdown template used when an agent enables template-mode
/// working memory without supplying its own (mirrors Mastra's default).
pub const DEFAULT_WORKING_MEMORY_TEMPLATE: &str = "# User Information\n\
- **First Name**:\n\
- **Last Name**:\n\
- **Location**:\n\
- **Occupation**:\n\
- **Interests**:\n\
- **Goals**:\n\
- **Events**:\n\
- **Facts**:\n\
- **Projects**:\n";

/// Which partition a working-memory document belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkingMemoryScope {
    /// One conversation / thread; `id` is the thread id.
    #[default]
    Thread,
    /// Shared by every thread about one resource; `id` is the resource key.
    Resource,
}

impl WorkingMemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Resource => "resource",
        }
    }

    /// Parse a wire value. Unknown values are rejected rather than defaulted:
    /// silently widening `"threadd"` to a resource-wide scratchpad would leak
    /// one thread's notes into every other.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "thread" => Some(Self::Thread),
            "resource" => Some(Self::Resource),
            _ => None,
        }
    }
}

/// How the scratchpad is shaped and how updates apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkingMemoryMode {
    /// Markdown document; updates replace it.
    #[default]
    Template,
    /// JSON object validated by a JSON Schema; updates are merge patches.
    Schema,
}

impl WorkingMemoryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Template => "template",
            Self::Schema => "schema",
        }
    }

    fn from_db(value: &str) -> Self {
        if value == "schema" {
            Self::Schema
        } else {
            Self::Template
        }
    }
}

/// The agent-level working-memory configuration (an agent's `MemorySlot` and
/// the SDK `Agent({ workingMemory })` option share this shape).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkingMemoryConfig {
    /// Whether working memory is on. Defaults to `true` when the block is
    /// present, so `{ "scope": "thread" }` alone enables it.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// `thread` (default) or `resource`.
    #[serde(default = "default_scope")]
    pub scope: WorkingMemoryScope,
    /// Markdown template (template mode). Ignored when `schema` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// JSON Schema for the scratchpad object (schema mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
}

fn default_true() -> bool {
    true
}

fn default_scope() -> WorkingMemoryScope {
    WorkingMemoryScope::Thread
}

impl WorkingMemoryConfig {
    /// The mode this configuration selects: a schema wins over a template.
    pub fn mode(&self) -> WorkingMemoryMode {
        if self.schema.is_some() {
            WorkingMemoryMode::Schema
        } else {
            WorkingMemoryMode::Template
        }
    }

    /// Check the configuration is usable before it is persisted on an agent.
    pub fn validate(&self) -> Result<()> {
        if let Some(template) = &self.template {
            if template.len() > MAX_WORKING_MEMORY_SPEC_BYTES {
                bail!("working memory template exceeds {MAX_WORKING_MEMORY_SPEC_BYTES} bytes");
            }
        }
        if let Some(schema) = &self.schema {
            validate_schema_spec(schema)?;
        }
        Ok(())
    }
}

/// One stored working-memory document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkingMemory {
    pub scope: WorkingMemoryScope,
    pub id: String,
    pub mode: WorkingMemoryMode,
    /// Markdown document (template mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Structured object (schema mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// The template the document was seeded from (template mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// The schema `data` is validated against (schema mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// Monotonic per-document revision, starting at 1.
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A write to a working-memory document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkingMemoryWrite {
    /// Explicit mode. When absent: an existing document keeps its mode; a new one
    /// is schema mode when `data` or `schema` is given, else template mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<WorkingMemoryMode>,
    /// Replacement Markdown (template mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Merge patch (schema mode). With `replace: true` it replaces the object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// Template to record (or change) for template mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Schema to record (or change) for schema mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// Schema mode only: replace the whole object instead of merging.
    #[serde(default)]
    pub replace: bool,
    /// Optimistic concurrency: when set, the write fails unless the stored
    /// version equals this value (`0` = "must not exist yet").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i64>,
}

/// Why a working-memory write was refused. Hosts map these to 4xx statuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkingMemoryError {
    /// The request itself is malformed or violates the schema (400).
    Invalid(String),
    /// `expected_version` did not match (409).
    Conflict { current: i64 },
}

impl std::fmt::Display for WorkingMemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Conflict { current } => {
                write!(f, "working memory changed (current version {current})")
            }
        }
    }
}

impl std::error::Error for WorkingMemoryError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkingPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<Value>,
}

pub(crate) fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_working (
             owner_user_id TEXT NOT NULL,
             scope         TEXT NOT NULL,
             scope_id      TEXT NOT NULL,
             mode          TEXT NOT NULL,
             nonce         BLOB NOT NULL,
             ciphertext    BLOB NOT NULL,
             version       INTEGER NOT NULL,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL,
             PRIMARY KEY (owner_user_id, scope, scope_id)
         );",
    )
    .context("initializing working memory schema")
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(WorkingMemoryError::Invalid(message.into()))
}

fn normalize_id(id: &str) -> Result<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(invalid("a working memory id is required"));
    }
    if id.len() > MAX_WORKING_MEMORY_ID_LEN {
        return Err(invalid(format!(
            "a working memory id must be at most {MAX_WORKING_MEMORY_ID_LEN} characters"
        )));
    }
    if id.chars().any(char::is_control) {
        return Err(invalid(
            "a working memory id cannot contain control characters",
        ));
    }
    Ok(id)
}

impl MemoryStore {
    /// Read the caller's working memory for `(scope, id)`, or `None` when it has
    /// never been written.
    pub async fn get_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<Option<WorkingMemory>> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let conn = self.conn.lock().await;
        self.read_working(&conn, owner, scope, id)
    }

    fn read_working(
        &self,
        conn: &Connection,
        owner: &str,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<Option<WorkingMemory>> {
        type Row = (String, Vec<u8>, Vec<u8>, i64, i64, i64);
        let row: Option<Row> = conn
            .query_row(
                "SELECT mode, nonce, ciphertext, version, created_at, updated_at
                   FROM memory_working
                  WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3",
                params![owner, scope.as_str(), id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .context("reading working memory")?;
        let Some((mode, nonce, ciphertext, version, created_at, updated_at)) = row else {
            return Ok(None);
        };
        let plain = self.decrypt(&nonce, &ciphertext)?;
        let payload: WorkingPayload =
            serde_json::from_slice(&plain).context("decoding working memory payload")?;
        Ok(Some(WorkingMemory {
            scope,
            id: id.to_owned(),
            mode: WorkingMemoryMode::from_db(&mode),
            content: payload.content,
            data: payload.data,
            template: payload.template,
            schema: payload.schema,
            version,
            created_at,
            updated_at,
        }))
    }

    /// Create or update the caller's working memory for `(scope, id)`.
    ///
    /// Template mode replaces `content`; schema mode merge-patches `data` (or
    /// replaces it with `replace: true`) and validates the result against the
    /// stored or supplied schema. Errors carrying [`WorkingMemoryError`] are
    /// caller errors (map them to 400 / 409); anything else is a storage fault.
    pub async fn put_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
        write: WorkingMemoryWrite,
    ) -> Result<WorkingMemory> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let conn = self.conn.lock().await;
        let existing = self.read_working(&conn, owner, scope, id)?;
        let current_version = existing.as_ref().map_or(0, |doc| doc.version);
        if let Some(expected) = write.expected_version {
            if expected != current_version {
                return Err(anyhow::Error::new(WorkingMemoryError::Conflict {
                    current: current_version,
                }));
            }
        }
        let next = apply_write(existing.as_ref(), write)?;
        let encoded = serde_json::to_vec(&next.payload).context("encoding working memory")?;
        let (nonce, ciphertext) = self.encrypt(&encoded)?;
        let now = now_millis();
        let created_at = existing.as_ref().map_or(now, |doc| doc.created_at);
        let version = current_version + 1;
        conn.execute(
            "INSERT INTO memory_working
                 (owner_user_id, scope, scope_id, mode, nonce, ciphertext, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(owner_user_id, scope, scope_id) DO UPDATE SET
                 mode = excluded.mode,
                 nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext,
                 version = excluded.version,
                 updated_at = excluded.updated_at",
            params![
                owner,
                scope.as_str(),
                id,
                next.mode.as_str(),
                nonce,
                ciphertext,
                version,
                created_at,
                now
            ],
        )
        .context("writing working memory")?;
        Ok(WorkingMemory {
            scope,
            id: id.to_owned(),
            mode: next.mode,
            content: next.payload.content,
            data: next.payload.data,
            template: next.payload.template,
            schema: next.payload.schema,
            version,
            created_at,
            updated_at: now,
        })
    }

    /// Delete the caller's working memory for `(scope, id)`. Returns whether a
    /// document existed.
    pub async fn delete_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<bool> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let conn = self.conn.lock().await;
        let removed = conn
            .execute(
                "DELETE FROM memory_working
                  WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3",
                params![owner, scope.as_str(), id],
            )
            .context("deleting working memory")?;
        Ok(removed > 0)
    }

    /// Delete every thread-scoped working memory for `thread_id`, across owners.
    /// Called when a conversation is deleted so its scratchpad does not outlive it.
    pub async fn delete_thread_working_memory(&self, thread_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM memory_working WHERE scope = 'thread' AND scope_id = ?1",
            params![thread_id.trim()],
        )
        .context("deleting thread working memory")
    }
}

struct NextDocument {
    mode: WorkingMemoryMode,
    payload: WorkingPayload,
}

fn apply_write(
    existing: Option<&WorkingMemory>,
    write: WorkingMemoryWrite,
) -> Result<NextDocument> {
    let mode = write.mode.unwrap_or_else(|| match existing {
        Some(doc) => doc.mode,
        None if write.data.is_some() || write.schema.is_some() => WorkingMemoryMode::Schema,
        None => WorkingMemoryMode::Template,
    });
    if let Some(template) = &write.template {
        if template.len() > MAX_WORKING_MEMORY_SPEC_BYTES {
            return Err(invalid(format!(
                "working memory template exceeds {MAX_WORKING_MEMORY_SPEC_BYTES} bytes"
            )));
        }
    }
    if let Some(schema) = &write.schema {
        validate_schema_spec(schema).map_err(|error| invalid(error.to_string()))?;
    }
    // A mode switch starts the document over: template Markdown is not a valid
    // schema object and vice versa.
    let same_mode = existing.filter(|doc| doc.mode == mode);
    let payload = match mode {
        WorkingMemoryMode::Template => {
            if write.data.is_some() {
                return Err(invalid(
                    "template-mode working memory takes `content`, not `data`",
                ));
            }
            let template = write
                .template
                .or_else(|| same_mode.and_then(|doc| doc.template.clone()));
            let content = match write.content {
                Some(content) => Some(content),
                None => same_mode.and_then(|doc| doc.content.clone()),
            };
            if let Some(content) = &content {
                if content.len() > MAX_WORKING_MEMORY_BYTES {
                    return Err(invalid(format!(
                        "working memory exceeds {MAX_WORKING_MEMORY_BYTES} bytes"
                    )));
                }
            }
            WorkingPayload {
                content,
                data: None,
                template,
                schema: None,
            }
        }
        WorkingMemoryMode::Schema => {
            if write.content.is_some() {
                return Err(invalid(
                    "schema-mode working memory takes `data`, not `content`",
                ));
            }
            let schema = write
                .schema
                .or_else(|| same_mode.and_then(|doc| doc.schema.clone()));
            let base = same_mode
                .and_then(|doc| doc.data.clone())
                .unwrap_or_else(|| Value::Object(Map::new()));
            let data = match write.data {
                Some(patch) if write.replace => patch,
                Some(patch) => {
                    if !patch.is_object() {
                        return Err(invalid(
                            "a working memory merge patch must be a JSON object",
                        ));
                    }
                    merge_patch(base, patch, 0)?
                }
                None => base,
            };
            if !data.is_object() {
                return Err(invalid("schema-mode working memory must be a JSON object"));
            }
            let encoded_len = serde_json::to_vec(&data).map_or(usize::MAX, |bytes| bytes.len());
            if encoded_len > MAX_WORKING_MEMORY_BYTES {
                return Err(invalid(format!(
                    "working memory exceeds {MAX_WORKING_MEMORY_BYTES} bytes"
                )));
            }
            if let Some(schema) = &schema {
                let mut errors = Vec::new();
                validate_value(&data, schema, "$", 0, &mut errors);
                if !errors.is_empty() {
                    return Err(invalid(format!(
                        "working memory does not match its schema: {}",
                        errors.join("; ")
                    )));
                }
            }
            WorkingPayload {
                content: None,
                data: Some(data),
                template: None,
                schema,
            }
        }
    };
    Ok(NextDocument { mode, payload })
}

/// Apply an RFC 7386 JSON merge patch: objects merge recursively, `null`
/// removes a key, and any other value replaces the target.
pub fn merge_patch(target: Value, patch: Value, depth: usize) -> Result<Value> {
    if depth > MAX_DEPTH {
        return Err(invalid("working memory is nested too deeply"));
    }
    let Value::Object(patch) = patch else {
        return Ok(patch);
    };
    let mut target = match target {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        if value.is_null() {
            target.remove(&key);
            continue;
        }
        let current = target.remove(&key).unwrap_or(Value::Null);
        target.insert(key, merge_patch(current, value, depth + 1)?);
    }
    Ok(Value::Object(target))
}

fn validate_schema_spec(schema: &Value) -> Result<()> {
    let Some(map) = schema.as_object() else {
        bail!("a working memory schema must be a JSON Schema object");
    };
    let encoded_len = serde_json::to_vec(schema).map_or(usize::MAX, |bytes| bytes.len());
    if encoded_len > MAX_WORKING_MEMORY_SPEC_BYTES {
        bail!("working memory schema exceeds {MAX_WORKING_MEMORY_SPEC_BYTES} bytes");
    }
    match map.get("type") {
        None => Ok(()),
        Some(Value::String(kind)) if kind == "object" => Ok(()),
        Some(_) => bail!("a working memory schema must describe an object (`type: \"object\"`)"),
    }
}

fn type_matches(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        // Unknown type keywords are not enforced (forward compatible).
        _ => true,
    }
}

/// Validate `value` against the JSON Schema subset working memory enforces:
/// `type` (string or list), `enum`, `const`, `properties`, `required`,
/// `additionalProperties: false | schema`, `items`, and `anyOf`. Unknown
/// keywords are ignored rather than rejected, so a schema produced by zod /
/// valibot / arktype is accepted as-is.
fn validate_value(
    value: &Value,
    schema: &Value,
    path: &str,
    depth: usize,
    errors: &mut Vec<String>,
) {
    if depth > MAX_DEPTH || errors.len() >= 8 {
        return;
    }
    let Some(schema) = schema.as_object() else {
        return;
    };
    match schema.get("type") {
        Some(Value::String(kind)) if !type_matches(value, kind) => {
            errors.push(format!("{path} must be {kind}"));
            return;
        }
        Some(Value::Array(kinds)) => {
            let ok = kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| type_matches(value, kind));
            if !ok {
                errors.push(format!("{path} has the wrong type"));
                return;
            }
        }
        _ => {}
    }
    if let Some(Value::Array(options)) = schema.get("enum") {
        if !options.contains(value) {
            errors.push(format!("{path} must be one of the allowed values"));
        }
    }
    if let Some(expected) = schema.get("const") {
        if expected != value {
            errors.push(format!("{path} must equal its constant"));
        }
    }
    if let Some(Value::Array(branches)) = schema.get("anyOf") {
        let matched = branches.iter().any(|branch| {
            let mut scratch = Vec::new();
            validate_value(value, branch, path, depth + 1, &mut scratch);
            scratch.is_empty()
        });
        if !matched {
            errors.push(format!("{path} matches none of the allowed shapes"));
        }
    }
    if let Value::Object(object) = value {
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(Value::Array(required)) = schema.get("required") {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    errors.push(format!("{path}.{name} is required"));
                }
            }
        }
        for (name, child) in object {
            let child_path = format!("{path}.{name}");
            match properties.and_then(|props| props.get(name)) {
                Some(child_schema) => {
                    validate_value(child, child_schema, &child_path, depth + 1, errors);
                }
                None => match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => {
                        errors.push(format!("{child_path} is not an allowed property"));
                    }
                    Some(extra @ Value::Object(_)) => {
                        validate_value(child, extra, &child_path, depth + 1, errors);
                    }
                    _ => {}
                },
            }
        }
    }
    if let (Value::Array(items), Some(item_schema)) = (value, schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            validate_value(
                item,
                item_schema,
                &format!("{path}[{index}]"),
                depth + 1,
                errors,
            );
        }
    }
}

/// Render the per-turn context block for a working-memory document, or for an
/// empty one seeded from `config` when nothing has been stored yet. The block
/// tells the model what the scratchpad is and how to update it.
pub fn render_working_memory_block(
    doc: Option<&WorkingMemory>,
    config: &WorkingMemoryConfig,
    tool_name: &str,
) -> String {
    // The agent's configuration decides the mode: the update tool always writes
    // in `config.mode()`, so a stored document in the other mode (e.g. one
    // written through the HTTP API) is shown as empty rather than with
    // instructions the tool cannot follow.
    let mode = config.mode();
    let doc = doc.filter(|doc| doc.mode == mode);
    let mut block = String::from("<working_memory>\n");
    block.push_str("This is your working memory: a persistent scratchpad for this ");
    block.push_str(match config.scope {
        WorkingMemoryScope::Thread => "conversation",
        WorkingMemoryScope::Resource => "user across conversations",
    });
    block.push_str(". Keep it current. ");
    match mode {
        WorkingMemoryMode::Template => {
            block.push_str(&format!(
                "When you learn something worth keeping, call `{tool_name}` with the COMPLETE \
                 updated Markdown in `content` (it replaces the whole document). Do not mention \
                 the scratchpad to the user.\n\n"
            ));
            let content = doc
                .and_then(|doc| doc.content.clone())
                .filter(|content| !content.trim().is_empty());
            match content {
                Some(content) => block.push_str(content.trim_end()),
                None => {
                    let template = doc
                        .and_then(|doc| doc.template.clone())
                        .or_else(|| config.template.clone())
                        .unwrap_or_else(|| DEFAULT_WORKING_MEMORY_TEMPLATE.to_owned());
                    block.push_str("(empty — fill in this template)\n");
                    block.push_str(template.trim_end());
                }
            }
        }
        WorkingMemoryMode::Schema => {
            block.push_str(&format!(
                "When you learn something worth keeping, call `{tool_name}` with `data` set to \
                 a JSON merge patch: only the fields that changed; `null` removes a field. Do \
                 not mention the scratchpad to the user.\n\n"
            ));
            let data = doc
                .and_then(|doc| doc.data.clone())
                .unwrap_or_else(|| Value::Object(Map::new()));
            block.push_str("Current value:\n");
            block.push_str(&serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into()));
            let schema = doc
                .and_then(|doc| doc.schema.clone())
                .or_else(|| config.schema.clone());
            if let Some(schema) = schema {
                block.push_str("\n\nSchema:\n");
                block.push_str(&serde_json::to_string(&schema).unwrap_or_default());
            }
        }
    }
    block.push_str("\n</working_memory>");
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alice() -> ResourceKey {
        ResourceKey::owned(Some("alice"), None)
    }

    fn bob() -> ResourceKey {
        ResourceKey::owned(Some("bob"), None)
    }

    #[tokio::test]
    async fn template_mode_replaces_and_versions() {
        let store = MemoryStore::open_in_memory().unwrap();
        assert!(store
            .get_working_memory(&alice(), WorkingMemoryScope::Thread, "t1")
            .await
            .unwrap()
            .is_none());
        let first = store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Thread,
                "t1",
                WorkingMemoryWrite {
                    content: Some("# Notes\n- name: Ada".into()),
                    template: Some("# Notes\n- name:".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(first.mode, WorkingMemoryMode::Template);
        assert_eq!(first.version, 1);
        let second = store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Thread,
                "t1",
                WorkingMemoryWrite {
                    content: Some("# Notes\n- name: Ada Lovelace".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(
            second.content.as_deref(),
            Some("# Notes\n- name: Ada Lovelace")
        );
        // The template is retained across a content-only update.
        assert_eq!(second.template.as_deref(), Some("# Notes\n- name:"));
        let read = store
            .get_working_memory(&alice(), WorkingMemoryScope::Thread, " t1 ")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read, second);
    }

    #[tokio::test]
    async fn schema_mode_merges_deletes_and_validates() {
        let store = MemoryStore::open_in_memory().unwrap();
        let schema = json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "prefs": {
                    "type": "object",
                    "properties": { "theme": { "enum": ["light", "dark"] } }
                },
                "tags": { "type": "array", "items": { "type": "string" } }
            },
            "additionalProperties": false
        });
        let doc = store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Resource,
                "alice",
                WorkingMemoryWrite {
                    schema: Some(schema.clone()),
                    data: Some(json!({ "name": "Ada", "prefs": { "theme": "dark" } })),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(doc.mode, WorkingMemoryMode::Schema);

        let merged = store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Resource,
                "alice",
                WorkingMemoryWrite {
                    data: Some(json!({ "name": null, "tags": ["math"] })),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            merged.data,
            Some(json!({ "prefs": { "theme": "dark" }, "tags": ["math"] }))
        );
        assert_eq!(merged.schema, Some(schema));

        let rejected = store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Resource,
                "alice",
                WorkingMemoryWrite {
                    data: Some(json!({ "prefs": { "theme": "blue" }, "extra": 1 })),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        let error = rejected.downcast_ref::<WorkingMemoryError>().unwrap();
        assert!(matches!(error, WorkingMemoryError::Invalid(message)
            if message.contains("$.prefs.theme") && message.contains("$.extra")));
        // A rejected write leaves the stored document untouched.
        let still = store
            .get_working_memory(&alice(), WorkingMemoryScope::Resource, "alice")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still.version, 2);

        let replaced = store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Resource,
                "alice",
                WorkingMemoryWrite {
                    data: Some(json!({ "name": "Grace" })),
                    replace: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(replaced.data, Some(json!({ "name": "Grace" })));
    }

    #[tokio::test]
    async fn owners_are_isolated_and_scopes_are_distinct() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Thread,
                "shared-id",
                WorkingMemoryWrite {
                    content: Some("alice notes".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(store
            .get_working_memory(&bob(), WorkingMemoryScope::Thread, "shared-id")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_working_memory(&alice(), WorkingMemoryScope::Resource, "shared-id")
            .await
            .unwrap()
            .is_none());
        // Bob writing the same id creates his own document.
        let bobs = store
            .put_working_memory(
                &bob(),
                WorkingMemoryScope::Thread,
                "shared-id",
                WorkingMemoryWrite {
                    content: Some("bob notes".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(bobs.version, 1);
        assert!(!store
            .delete_working_memory(&bob(), WorkingMemoryScope::Resource, "shared-id")
            .await
            .unwrap());
        assert_eq!(
            store
                .delete_thread_working_memory("shared-id")
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn rejects_bad_requests_and_stale_versions() {
        let store = MemoryStore::open_in_memory().unwrap();
        let key = alice();
        let bad_id = store
            .put_working_memory(
                &key,
                WorkingMemoryScope::Thread,
                "  ",
                WorkingMemoryWrite::default(),
            )
            .await
            .unwrap_err();
        assert!(bad_id.downcast_ref::<WorkingMemoryError>().is_some());

        let wrong_field = store
            .put_working_memory(
                &key,
                WorkingMemoryScope::Thread,
                "t",
                WorkingMemoryWrite {
                    mode: Some(WorkingMemoryMode::Template),
                    data: Some(json!({ "a": 1 })),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(wrong_field.to_string().contains("content"));

        let too_big = store
            .put_working_memory(
                &key,
                WorkingMemoryScope::Thread,
                "t",
                WorkingMemoryWrite {
                    content: Some("x".repeat(MAX_WORKING_MEMORY_BYTES + 1)),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(too_big.to_string().contains("exceeds"));

        let non_object_schema = store
            .put_working_memory(
                &key,
                WorkingMemoryScope::Thread,
                "t",
                WorkingMemoryWrite {
                    schema: Some(json!({ "type": "string" })),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(non_object_schema.to_string().contains("object"));

        store
            .put_working_memory(
                &key,
                WorkingMemoryScope::Thread,
                "t",
                WorkingMemoryWrite {
                    content: Some("v1".into()),
                    expected_version: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let stale = store
            .put_working_memory(
                &key,
                WorkingMemoryScope::Thread,
                "t",
                WorkingMemoryWrite {
                    content: Some("v2".into()),
                    expected_version: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert_eq!(
            stale.downcast_ref::<WorkingMemoryError>(),
            Some(&WorkingMemoryError::Conflict { current: 1 })
        );
    }

    #[tokio::test]
    async fn content_is_encrypted_at_rest() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .put_working_memory(
                &alice(),
                WorkingMemoryScope::Thread,
                "t",
                WorkingMemoryWrite {
                    content: Some("secret plan: launch on friday".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let conn = store.conn.lock().await;
        let raw: Vec<u8> = conn
            .query_row("SELECT ciphertext FROM memory_working", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret plan"));
    }

    #[test]
    fn merge_patch_follows_rfc7386() {
        let merged = merge_patch(
            json!({ "a": "b", "c": { "d": "e", "f": "g" } }),
            json!({ "a": "z", "c": { "f": null } }),
            0,
        )
        .unwrap();
        assert_eq!(merged, json!({ "a": "z", "c": { "d": "e" } }));
        assert_eq!(
            merge_patch(json!({ "a": 1 }), json!([1]), 0).unwrap(),
            json!([1])
        );
    }

    #[test]
    fn config_parses_and_selects_mode() {
        let config: WorkingMemoryConfig =
            serde_json::from_value(json!({ "scope": "resource" })).unwrap();
        assert!(config.enabled);
        assert_eq!(config.scope, WorkingMemoryScope::Resource);
        assert_eq!(config.mode(), WorkingMemoryMode::Template);
        let schema_config: WorkingMemoryConfig =
            serde_json::from_value(json!({ "schema": { "type": "object" } })).unwrap();
        assert_eq!(schema_config.scope, WorkingMemoryScope::Thread);
        assert_eq!(schema_config.mode(), WorkingMemoryMode::Schema);
        assert!(schema_config.validate().is_ok());
        assert!(WorkingMemoryConfig {
            schema: Some(json!(["not", "an", "object"])),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert_eq!(
            WorkingMemoryScope::parse("thread"),
            Some(WorkingMemoryScope::Thread)
        );
        assert_eq!(WorkingMemoryScope::parse("org"), None);
    }

    #[test]
    fn render_block_seeds_template_and_shows_schema_state() {
        let config = WorkingMemoryConfig {
            enabled: true,
            scope: WorkingMemoryScope::Thread,
            template: Some("# Task\n- goal:".into()),
            schema: None,
        };
        let empty = render_working_memory_block(None, &config, "update_working_memory");
        assert!(empty.contains("# Task\n- goal:"));
        assert!(empty.contains("update_working_memory"));
        assert!(empty.starts_with("<working_memory>"));

        let doc = WorkingMemory {
            scope: WorkingMemoryScope::Resource,
            id: "u".into(),
            mode: WorkingMemoryMode::Schema,
            content: None,
            data: Some(json!({ "name": "Ada" })),
            template: None,
            schema: Some(json!({ "type": "object" })),
            version: 3,
            created_at: 1,
            updated_at: 2,
        };
        let schema_config = WorkingMemoryConfig {
            scope: WorkingMemoryScope::Resource,
            schema: Some(json!({ "type": "object" })),
            ..Default::default()
        };
        let rendered =
            render_working_memory_block(Some(&doc), &schema_config, "update_working_memory");
        assert!(rendered.contains("\"name\": \"Ada\""));
        assert!(rendered.contains("merge patch"));
        assert!(rendered.contains("across conversations"));

        // A stored document in the other mode is not shown with instructions the
        // agent's update tool cannot follow.
        let template_config = WorkingMemoryConfig {
            scope: WorkingMemoryScope::Resource,
            template: Some("# Profile".into()),
            ..Default::default()
        };
        let mismatched =
            render_working_memory_block(Some(&doc), &template_config, "update_working_memory");
        assert!(mismatched.contains("`content`"));
        assert!(mismatched.contains("# Profile"));
        assert!(!mismatched.contains("\"name\": \"Ada\""));
    }
}
