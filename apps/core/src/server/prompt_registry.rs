//! Local prompt registry (Prompt Hub on a node).
//!
//! Named prompts with immutable, numbered versions and movable labels, served
//! at `/api/prompts` in the same wire shape as the organization registry on the
//! control plane (`@ryuhq/protocol/prompt-hub`). Two kinds of entry share one
//! namespace:
//!
//! - `local` entries are authored on this node and are fully editable, so a
//!   node that is offline or never signed in still has a working registry;
//! - `cloud` entries mirror the organization registry when the node is bound to
//!   an org. They are read-only here (edit them in the organization registry)
//!   and keep serving while the node is offline. A mirror refresh runs on
//!   demand (`POST /api/prompts/sync`) and lazily, at most every few minutes,
//!   when the registry is read.
//!
//! Templates use the shared mustache subset; the variable extraction below is
//! pinned to `packages/protocol/src/fixtures/prompt-templates.json`.

use anyhow::{Context, Result};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::activity::sealed_store::{core_cipher, StoreSeal};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};

/// Registered store name (content-key input; never rename).
const STORE: &str = "prompt-registry.db";
const ENTRY_DESCRIPTION: &str = "prompt_entries.description";
const VERSION_TEMPLATE: &str = "prompt_entry_versions.template";
const VERSION_MESSAGES: &str = "prompt_entry_versions.messages_json";
const VERSION_MODEL_CONFIG: &str = "prompt_entry_versions.model_config_json";
const VERSION_COMMIT_MESSAGE: &str = "prompt_entry_versions.commit_message";

fn column_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![ColumnPlan::text(
        "prompt_entries",
        "description",
        "name",
        KeyKind::Text,
    )?
    .with_context(&[], |row| {
        ContentContext::for_id(ENTRY_DESCRIPTION, row.key())
    })?])
}

/// The context of a version value: bound to the prompt name, version and column.
fn version_context(purpose: &'static str, name: &str, version: i64) -> ContentContext {
    ContentContext::new(purpose)
        .with("name", name)
        .with("version", version.to_string())
}

const LATEST_LABEL: &str = "latest";
const DEFAULT_LABEL: &str = "production";
const MAX_TEMPLATE_CHARS: usize = 100_000;
const MAX_MESSAGES: usize = 100;
const MAX_LABELS: usize = 32;
const MAX_TAGS: usize = 20;
const MAX_COMMIT_MESSAGE_CHARS: usize = 500;
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_LIST: u32 = 1000;
const DEFAULT_VERSION_PAGE: u32 = 50;
const MAX_SYNC_PAGES: usize = 40;
const SYNC_PAGE_SIZE: u32 = 500;
const SYNC_INTERVAL: Duration = Duration::from_secs(300);
const MESSAGE_ROLES: &[&str] = &["system", "user", "assistant", "developer"];

// ── Names and templates ─────────────────────────────────────────────────────

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
pub fn is_prompt_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `^[a-z0-9][a-z0-9_-]{0,62}$`, excluding the computed `latest`.
pub fn is_assignable_label(value: &str) -> bool {
    let mut chars = value.chars();
    value != LATEST_LABEL
        && matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        && value.len() <= 63
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
}

fn is_label_selector(value: &str) -> bool {
    value == LATEST_LABEL || is_assignable_label(value)
}

fn is_path_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn is_tag_path(path: &str) -> bool {
    path == "." || (!path.is_empty() && path.split('.').all(is_path_segment))
}

/// Every name a template may read, in first-use order: the first segment of
/// each variable and section tag. Errors on unterminated tags, malformed
/// names, and unbalanced sections.
pub fn template_variables(template: &str) -> std::result::Result<Vec<String>, String> {
    let mut seen: Vec<String> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = template[cursor..].find("{{") {
        let open = cursor + relative;
        let triple = template[open..].starts_with("{{{");
        let (start, closer) = if triple {
            (open + 3, "}}}")
        } else {
            (open + 2, "}}")
        };
        let Some(close_relative) = template[start..].find(closer) else {
            return Err(format!("unterminated tag at offset {open}"));
        };
        let close = start + close_relative;
        let raw = template[start..close].trim();
        cursor = close + closer.len();
        let sigil = if triple { None } else { raw.chars().next() };
        if sigil == Some('!') {
            continue;
        }
        let body = match sigil {
            Some('#' | '^' | '/' | '&') => raw[1..].trim(),
            _ => raw,
        };
        if !is_tag_path(body) {
            return Err(format!("invalid tag name \"{body}\" at offset {open}"));
        }
        match sigil {
            Some('/') => match stack.pop() {
                Some(expected) if expected == body => {}
                Some(expected) => {
                    return Err(format!("section \"{expected}\" closed by \"{body}\""))
                }
                None => return Err(format!("unopened section \"{body}\" closed")),
            },
            other => {
                if matches!(other, Some('#' | '^')) {
                    stack.push(body.to_owned());
                }
                if body != "." {
                    let root = body.split('.').next().unwrap_or(body).to_owned();
                    if !seen.contains(&root) {
                        seen.push(root);
                    }
                }
            }
        }
    }
    if let Some(unclosed) = stack.pop() {
        return Err(format!("section \"{unclosed}\" is never closed"));
    }
    Ok(seen)
}

// ── Wire types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(untagged)]
pub enum ChatEntry {
    Placeholder(PlaceholderEntry),
    Message(MessageEntry),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaceholderEntry {
    #[serde(rename = "type")]
    pub kind: PlaceholderKind,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PlaceholderKind {
    Placeholder,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MessageEntry {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PromptType {
    Text,
    Chat,
}

impl PromptType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Chat => "chat",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "chat" {
            Self::Chat
        } else {
            Self::Text
        }
    }
}

/// One immutable version, as every registry serves it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionWire {
    pub name: String,
    pub version: i64,
    #[serde(rename = "type")]
    pub kind: PromptType,
    pub template: Option<String>,
    pub messages: Option<Vec<ChatEntry>>,
    pub variables: Vec<String>,
    #[serde(default)]
    pub placeholders: Vec<String>,
    #[serde(default)]
    pub model_config: ModelConfig,
    pub commit_message: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub labels: Vec<String>,
}

/// One registry entry: metadata plus where each label points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryWire {
    pub name: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    #[serde(rename = "type")]
    pub kind: PromptType,
    pub latest_version: i64,
    pub labels: BTreeMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionInput {
    #[serde(rename = "type")]
    pub kind: PromptType,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub messages: Option<Vec<ChatEntry>>,
    #[serde(default)]
    pub model_config: Option<ModelConfig>,
    #[serde(default)]
    pub commit_message: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub expected_latest_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    pub version: VersionInput,
}

/// A version body after validation, with its computed variables.
#[derive(Debug, Clone)]
struct ValidVersion {
    kind: PromptType,
    template: Option<String>,
    messages: Option<Vec<ChatEntry>>,
    variables: Vec<String>,
    placeholders: Vec<String>,
    model_config: ModelConfig,
    commit_message: Option<String>,
    labels: Vec<String>,
    expected_latest_version: Option<i64>,
}

fn validate_version(input: VersionInput) -> std::result::Result<ValidVersion, String> {
    let mut variables: Vec<String> = Vec::new();
    let mut placeholders: Vec<String> = Vec::new();
    let mut add = |names: Vec<String>| {
        for name in names {
            if !variables.contains(&name) {
                variables.push(name);
            }
        }
    };
    match input.kind {
        PromptType::Text => {
            if input.messages.is_some() {
                return Err("messages: a text prompt cannot carry messages".into());
            }
            let template = input
                .template
                .as_deref()
                .ok_or("template: a text prompt needs a template")?;
            if template.chars().count() > MAX_TEMPLATE_CHARS {
                return Err("template: too long".into());
            }
            add(template_variables(template).map_err(|error| format!("template: {error}"))?);
        }
        PromptType::Chat => {
            if input.template.is_some() {
                return Err("template: a chat prompt cannot carry a template".into());
            }
            let messages = input
                .messages
                .as_ref()
                .ok_or("messages: a chat prompt needs messages")?;
            if messages.is_empty() || messages.len() > MAX_MESSAGES {
                return Err(format!("messages: between 1 and {MAX_MESSAGES} entries"));
            }
            for (index, entry) in messages.iter().enumerate() {
                match entry {
                    ChatEntry::Message(message) => {
                        if !MESSAGE_ROLES.contains(&message.role.as_str()) {
                            return Err(format!("messages.{index}.role: invalid role"));
                        }
                        if message.content.chars().count() > MAX_TEMPLATE_CHARS {
                            return Err(format!("messages.{index}.content: too long"));
                        }
                        add(template_variables(&message.content)
                            .map_err(|error| format!("messages.{index}.content: {error}"))?);
                    }
                    ChatEntry::Placeholder(slot) => {
                        if !is_path_segment(&slot.name)
                            || slot.name.contains('-')
                            || slot.name.len() > 64
                        {
                            return Err(format!("messages.{index}.name: invalid placeholder name"));
                        }
                        if !placeholders.contains(&slot.name) {
                            placeholders.push(slot.name.clone());
                        }
                    }
                }
            }
        }
    }
    let commit_message = input
        .commit_message
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if commit_message
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_COMMIT_MESSAGE_CHARS)
    {
        return Err("commitMessage: too long".into());
    }
    let mut labels: Vec<String> = Vec::new();
    for label in input.labels.unwrap_or_default() {
        if !is_assignable_label(&label) {
            return Err(format!(
                "labels: invalid or reserved prompt label \"{label}\""
            ));
        }
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    if labels.len() > MAX_LABELS {
        return Err("labels: too many".into());
    }
    let model_config = input.model_config.unwrap_or_default();
    if model_config
        .temperature
        .is_some_and(|value| !(0.0..=2.0).contains(&value))
        || model_config
            .top_p
            .is_some_and(|value| !(0.0..=1.0).contains(&value))
    {
        return Err("modelConfig: temperature must be 0..2 and topP 0..1".into());
    }
    Ok(ValidVersion {
        kind: input.kind,
        template: if input.kind == PromptType::Text {
            input.template
        } else {
            None
        },
        messages: if input.kind == PromptType::Chat {
            input.messages
        } else {
            None
        },
        variables,
        placeholders,
        model_config,
        commit_message,
        labels,
        expected_latest_version: input.expected_latest_version,
    })
}

fn clean_tags(tags: Option<Vec<String>>) -> std::result::Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags.unwrap_or_default() {
        let tag = tag.trim().to_owned();
        if tag.is_empty() || tag.chars().count() > 64 {
            return Err("tags: each tag is 1-64 characters".into());
        }
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    if out.len() > MAX_TAGS {
        return Err(format!("tags: at most {MAX_TAGS}"));
    }
    Ok(out)
}

// ── Store ───────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum RegistryError {
    Invalid(String),
    NotFound(String),
    Conflict(String),
    ReadOnly(String),
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for RegistryError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error)
    }
}

impl From<rusqlite::Error> for RegistryError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Internal(error.into())
    }
}

impl From<serde_json::Error> for RegistryError {
    fn from(error: serde_json::Error) -> Self {
        Self::Internal(error.into())
    }
}

type RegistryResult<T> = std::result::Result<T, RegistryError>;

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    summary: SummaryWire,
    org_id: Option<String>,
}

/// What a mirror refresh changed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub mirrored: usize,
    pub removed: usize,
    /// Organization prompts skipped because a local prompt has the same name.
    pub conflicts: Vec<String>,
    /// The feed was longer than this node walks: the pages received were
    /// applied, and stale mirrored prompts were kept instead of removed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// One organization entry from the control plane's node feed.
#[derive(Debug, Clone, Deserialize)]
pub struct CloudEntry {
    pub prompt: SummaryWire,
    pub versions: Vec<VersionWire>,
}

#[derive(Clone)]
pub struct PromptRegistryStore {
    conn: Arc<Mutex<Connection>>,
    seal: StoreSeal,
}

/// A version row as stored: `template`, `messages_json`, `model_config_json`
/// and `commit_message` are still sealed.
struct RawVersion {
    wire: VersionWire,
    messages: Option<String>,
    model_config: String,
}

/// The sealed values of one version row.
struct SealedVersion {
    template: Option<String>,
    messages: Option<String>,
    model_config: String,
    commit_message: Option<String>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl PromptRegistryStore {
    /// The process-wide registry at `<data dir>/db/prompt-registry.db`.
    pub fn open_default() -> Result<Self> {
        static STORE: OnceLock<PromptRegistryStore> = OnceLock::new();
        if let Some(store) = STORE.get() {
            return Ok(store.clone());
        }
        let store = Self::open(crate::paths::db_path("prompt-registry.db"))?;
        Ok(STORE.get_or_init(|| store).clone())
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        Self::open_at(path, core_cipher(STORE)?)
    }

    /// Open the registry at `path` under an explicit content cipher (tests).
    pub fn open_at(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let mut conn =
            Connection::open(&path).with_context(|| format!("opening {}", path.display()))?;
        Self::create_tables(&conn)?;
        let seal = Self::seal_store(&mut conn, Some(&path), cipher)?;
        let conn = Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, Some(&path));
        Ok(Self { conn, seal })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        Self::create_tables(&conn)?;
        let seal = Self::seal_store(&mut conn, None, core_cipher(STORE)?)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            seal,
        })
    }

    fn seal_store(
        conn: &mut Connection,
        db_path: Option<&FsPath>,
        cipher: ContentCipher,
    ) -> Result<StoreSeal> {
        let seal = StoreSeal::prepare(conn, db_path, cipher, &column_plans()?)
            .context("sealing the prompt registry")?;
        if seal.writable() && seal_legacy_versions(conn, &seal)? > 0 {
            seal.finish(conn, db_path);
        }
        Ok(seal)
    }

    /// Values list reads skipped because they did not open (since open).
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    fn create_tables(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS prompt_entries (
                 name TEXT PRIMARY KEY,
                 source TEXT NOT NULL,
                 org_id TEXT,
                 description TEXT,
                 tags_json TEXT NOT NULL,
                 type TEXT NOT NULL,
                 latest_version INTEGER NOT NULL,
                 labels_json TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS prompt_entry_versions (
                 name TEXT NOT NULL,
                 version INTEGER NOT NULL,
                 type TEXT NOT NULL,
                 template TEXT,
                 messages_json TEXT,
                 variables_json TEXT NOT NULL,
                 placeholders_json TEXT NOT NULL,
                 model_config_json TEXT NOT NULL,
                 commit_message TEXT,
                 created_by TEXT,
                 created_at TEXT NOT NULL,
                 PRIMARY KEY (name, version)
             );",
        )
        .context("creating prompt registry tables")?;
        Ok(())
    }

    /// An entry as stored: its `description` is still sealed.
    fn read_entry_raw(conn: &Connection, name: &str) -> rusqlite::Result<Option<Entry>> {
        conn.query_row(
            "SELECT name, source, org_id, description, tags_json, type, latest_version,
                    labels_json, created_at, updated_at
             FROM prompt_entries WHERE name = ?1",
            params![name],
            entry_from_row,
        )
        .optional()
    }

    fn read_entry(&self, conn: &Connection, name: &str) -> RegistryResult<Option<Entry>> {
        Ok(Self::read_entry_raw(conn, name)?
            .map(|entry| self.open_entry(entry))
            .transpose()?)
    }

    fn read_version(
        &self,
        conn: &Connection,
        name: &str,
        version: i64,
    ) -> RegistryResult<Option<VersionWire>> {
        let raw = conn
            .query_row(
                "SELECT name, version, type, template, messages_json, variables_json,
                        placeholders_json, model_config_json, commit_message, created_by,
                        created_at
                 FROM prompt_entry_versions WHERE name = ?1 AND version = ?2",
                params![name, version],
                version_from_row,
            )
            .optional()?;
        Ok(raw.map(|raw| self.open_version(raw)).transpose()?)
    }

    fn open_entry(&self, mut entry: Entry) -> Result<Entry> {
        entry.summary.description = self.seal.open_opt(
            entry.summary.description.as_deref(),
            &ContentContext::for_id(ENTRY_DESCRIPTION, &entry.summary.name),
        )?;
        Ok(entry)
    }

    fn open_version(&self, raw: RawVersion) -> Result<VersionWire> {
        let RawVersion {
            mut wire,
            messages,
            model_config,
        } = raw;
        let (name, version) = (wire.name.clone(), wire.version);
        wire.template = self.seal.open_opt(
            wire.template.as_deref(),
            &version_context(VERSION_TEMPLATE, &name, version),
        )?;
        wire.commit_message = self.seal.open_opt(
            wire.commit_message.as_deref(),
            &version_context(VERSION_COMMIT_MESSAGE, &name, version),
        )?;
        wire.messages = self
            .seal
            .open_opt(
                messages.as_deref(),
                &version_context(VERSION_MESSAGES, &name, version),
            )?
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .with_context(|| format!("decoding the messages of {name} v{version}"))?;
        wire.model_config = serde_json::from_str(&self.seal.open(
            &model_config,
            &version_context(VERSION_MODEL_CONFIG, &name, version),
        )?)
        .with_context(|| format!("decoding the model config of {name} v{version}"))?;
        Ok(wire)
    }

    fn seal_description(&self, name: &str, description: Option<&str>) -> Result<Option<String>> {
        self.seal.seal_opt(
            description,
            &ContentContext::for_id(ENTRY_DESCRIPTION, name),
        )
    }

    /// Seal the content columns of one version before they are written.
    fn seal_version(
        &self,
        name: &str,
        version: i64,
        template: Option<&str>,
        messages: Option<&[ChatEntry]>,
        model_config: &ModelConfig,
        commit_message: Option<&str>,
    ) -> Result<SealedVersion> {
        let messages_json = messages.map(serde_json::to_string).transpose()?;
        Ok(SealedVersion {
            template: self
                .seal
                .seal_opt(template, &version_context(VERSION_TEMPLATE, name, version))?,
            messages: self.seal.seal_opt(
                messages_json.as_deref(),
                &version_context(VERSION_MESSAGES, name, version),
            )?,
            model_config: self.seal.seal(
                &serde_json::to_string(model_config)?,
                &version_context(VERSION_MODEL_CONFIG, name, version),
            )?,
            commit_message: self.seal.seal_opt(
                commit_message,
                &version_context(VERSION_COMMIT_MESSAGE, name, version),
            )?,
        })
    }

    /// Entries visible on this node: local ones, and the mirror of `org_id`.
    pub async fn list(&self, org_id: Option<&str>) -> RegistryResult<Vec<SummaryWire>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT name, source, org_id, description, tags_json, type, latest_version,
                    labels_json, created_at, updated_at
             FROM prompt_entries ORDER BY updated_at DESC, name ASC LIMIT ?1",
        )?;
        let rows = statement
            .query_map(params![MAX_LIST], entry_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut skipped = 0u64;
        let mut summaries = Vec::new();
        for entry in rows.into_iter().filter(|entry| visible(entry, org_id)) {
            match self.open_entry(entry) {
                Ok(entry) => summaries.push(entry.summary),
                Err(_) => skipped += 1,
            }
        }
        self.seal.count_unreadable(skipped);
        Ok(summaries)
    }

    async fn visible_entry(&self, name: &str, org_id: Option<&str>) -> RegistryResult<Entry> {
        let conn = self.conn.lock().await;
        match self.read_entry(&conn, name)? {
            Some(entry) if visible(&entry, org_id) => Ok(entry),
            _ => Err(RegistryError::NotFound(format!(
                "no prompt named \"{name}\""
            ))),
        }
    }

    pub async fn get(&self, name: &str, org_id: Option<&str>) -> RegistryResult<SummaryWire> {
        Ok(self.visible_entry(name, org_id).await?.summary)
    }

    pub async fn create_local(
        &self,
        input: CreateInput,
        actor: Option<&str>,
    ) -> RegistryResult<(SummaryWire, VersionWire)> {
        if !is_prompt_name(&input.name) {
            return Err(RegistryError::Invalid("name: invalid prompt name".into()));
        }
        let description = input
            .description
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if description
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_DESCRIPTION_CHARS)
        {
            return Err(RegistryError::Invalid("description: too long".into()));
        }
        let tags = clean_tags(input.tags).map_err(RegistryError::Invalid)?;
        let version = validate_version(input.version).map_err(RegistryError::Invalid)?;
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        if Self::read_entry_raw(&tx, &input.name)?.is_some() {
            return Err(RegistryError::Conflict(format!(
                "a prompt named \"{}\" already exists",
                input.name
            )));
        }
        let at = now();
        tx.execute(
            "INSERT INTO prompt_entries (name, source, org_id, description, tags_json, type,
                 latest_version, labels_json, created_at, updated_at)
             VALUES (?1, 'local', NULL, ?2, ?3, ?4, 0, '{}', ?5, ?5)",
            params![
                input.name,
                self.seal_description(&input.name, description.as_deref())?,
                serde_json::to_string(&tags)?,
                version.kind.as_str(),
                at
            ],
        )?;
        let wire = self.commit_in(&tx, &input.name, version, actor, &at)?;
        let summary = self
            .read_entry(&tx, &input.name)?
            .ok_or_else(|| RegistryError::Internal(anyhow::anyhow!("entry vanished")))?
            .summary;
        tx.commit()?;
        Ok((summary.clone(), with_labels(wire, &summary)))
    }

    fn commit_in(
        &self,
        conn: &Connection,
        name: &str,
        version: ValidVersion,
        actor: Option<&str>,
        at: &str,
    ) -> RegistryResult<VersionWire> {
        let entry = self
            .read_entry(conn, name)?
            .ok_or_else(|| RegistryError::NotFound(format!("no prompt named \"{name}\"")))?;
        let highest: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM prompt_entry_versions WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        let latest = highest.max(entry.summary.latest_version);
        if let Some(expected) = version.expected_latest_version {
            if expected != latest {
                return Err(RegistryError::Conflict(format!(
                    "expected latest version {expected}, found {latest}"
                )));
            }
        }
        let number = latest + 1;
        let sealed = self.seal_version(
            name,
            number,
            version.template.as_deref(),
            version.messages.as_deref(),
            &version.model_config,
            version.commit_message.as_deref(),
        )?;
        conn.execute(
            "INSERT INTO prompt_entry_versions (name, version, type, template, messages_json,
                 variables_json, placeholders_json, model_config_json, commit_message,
                 created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                name,
                number,
                version.kind.as_str(),
                sealed.template,
                sealed.messages,
                serde_json::to_string(&version.variables)?,
                serde_json::to_string(&version.placeholders)?,
                sealed.model_config,
                sealed.commit_message,
                actor,
                at,
            ],
        )?;
        let mut labels = entry.summary.labels.clone();
        for label in &version.labels {
            labels.insert(label.clone(), number);
        }
        conn.execute(
            "UPDATE prompt_entries SET latest_version = ?2, type = ?3, labels_json = ?4,
                 updated_at = ?5 WHERE name = ?1",
            params![
                name,
                number,
                version.kind.as_str(),
                serde_json::to_string(&labels)?,
                at
            ],
        )?;
        self.read_version(conn, name, number)?
            .ok_or_else(|| RegistryError::Internal(anyhow::anyhow!("version vanished")))
    }

    fn require_local(entry: &Entry) -> RegistryResult<()> {
        if entry.summary.source.as_deref() == Some("cloud") {
            return Err(RegistryError::ReadOnly(format!(
                "\"{}\" mirrors the organization registry; edit it there",
                entry.summary.name
            )));
        }
        Ok(())
    }

    pub async fn commit_local(
        &self,
        name: &str,
        input: VersionInput,
        actor: Option<&str>,
    ) -> RegistryResult<(SummaryWire, VersionWire)> {
        let version = validate_version(input).map_err(RegistryError::Invalid)?;
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        let entry = self
            .read_entry(&tx, name)?
            .ok_or_else(|| RegistryError::NotFound(format!("no prompt named \"{name}\"")))?;
        Self::require_local(&entry)?;
        let wire = self.commit_in(&tx, name, version, actor, &now())?;
        let summary = self
            .read_entry(&tx, name)?
            .ok_or_else(|| RegistryError::Internal(anyhow::anyhow!("entry vanished")))?
            .summary;
        tx.commit()?;
        Ok((summary.clone(), with_labels(wire, &summary)))
    }

    pub async fn delete_local(&self, name: &str) -> RegistryResult<()> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        let entry = self
            .read_entry(&tx, name)?
            .ok_or_else(|| RegistryError::NotFound(format!("no prompt named \"{name}\"")))?;
        Self::require_local(&entry)?;
        tx.execute(
            "DELETE FROM prompt_entry_versions WHERE name = ?1",
            params![name],
        )?;
        tx.execute("DELETE FROM prompt_entries WHERE name = ?1", params![name])?;
        tx.commit()?;
        Ok(())
    }

    pub async fn versions(
        &self,
        name: &str,
        org_id: Option<&str>,
        before: Option<i64>,
        limit: u32,
    ) -> RegistryResult<(SummaryWire, Vec<VersionWire>)> {
        let entry = self.visible_entry(name, org_id).await?;
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT name, version, type, template, messages_json, variables_json,
                    placeholders_json, model_config_json, commit_message, created_by, created_at
             FROM prompt_entry_versions WHERE name = ?1 AND version < ?2
             ORDER BY version DESC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![name, before.unwrap_or(i64::MAX), limit],
                version_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let summary = entry.summary;
        let mut skipped = 0u64;
        let mut versions = Vec::with_capacity(rows.len());
        for raw in rows {
            match self.open_version(raw) {
                Ok(version) => versions.push(with_labels(version, &summary)),
                Err(_) => skipped += 1,
            }
        }
        self.seal.count_unreadable(skipped);
        Ok((summary, versions))
    }

    pub async fn version(
        &self,
        name: &str,
        org_id: Option<&str>,
        version: i64,
    ) -> RegistryResult<VersionWire> {
        let entry = self.visible_entry(name, org_id).await?;
        let conn = self.conn.lock().await;
        self.read_version(&conn, name, version)?
            .map(|wire| with_labels(wire, &entry.summary))
            .ok_or_else(|| {
                RegistryError::NotFound(format!("prompt \"{name}\" has no version {version}"))
            })
    }

    /// Resolve `label` (default `production`; `latest` is computed) or `version`.
    pub async fn resolve(
        &self,
        name: &str,
        org_id: Option<&str>,
        label: Option<&str>,
        version: Option<i64>,
    ) -> RegistryResult<VersionWire> {
        if let Some(version) = version {
            return self.version(name, org_id, version).await;
        }
        let entry = self.visible_entry(name, org_id).await?;
        let label = label.unwrap_or(DEFAULT_LABEL);
        let target = if label == LATEST_LABEL {
            Some(entry.summary.latest_version)
        } else {
            entry.summary.labels.get(label).copied()
        };
        let Some(target) = target else {
            return Err(RegistryError::NotFound(format!(
                "prompt \"{name}\" has no \"{label}\" label"
            )));
        };
        self.version(name, org_id, target).await
    }

    /// Point `label` at `version`, or remove it with `None`.
    pub async fn move_label(
        &self,
        name: &str,
        label: &str,
        version: Option<i64>,
    ) -> RegistryResult<SummaryWire> {
        if !is_assignable_label(label) {
            return Err(RegistryError::Invalid(
                "label: invalid, or latest (which is computed)".into(),
            ));
        }
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        let entry = self
            .read_entry(&tx, name)?
            .ok_or_else(|| RegistryError::NotFound(format!("no prompt named \"{name}\"")))?;
        Self::require_local(&entry)?;
        let mut labels = entry.summary.labels.clone();
        match version {
            Some(version) => {
                if self.read_version(&tx, name, version)?.is_none() {
                    return Err(RegistryError::NotFound(format!(
                        "prompt \"{name}\" has no version {version}"
                    )));
                }
                labels.insert(label.to_owned(), version);
            }
            None => {
                if labels.remove(label).is_none() {
                    return Err(RegistryError::NotFound(format!(
                        "prompt \"{name}\" has no \"{label}\" label"
                    )));
                }
            }
        }
        tx.execute(
            "UPDATE prompt_entries SET labels_json = ?2, updated_at = ?3 WHERE name = ?1",
            params![name, serde_json::to_string(&labels)?, now()],
        )?;
        let summary = self
            .read_entry(&tx, name)?
            .ok_or_else(|| RegistryError::Internal(anyhow::anyhow!("entry vanished")))?
            .summary;
        tx.commit()?;
        Ok(summary)
    }

    /// Replace the mirror of `org_id` with a complete organization snapshot.
    /// Mirrors of any other organization are dropped; local prompts are never
    /// touched, and an organization prompt that collides with one is skipped.
    pub async fn apply_cloud_snapshot(
        &self,
        org_id: &str,
        entries: Vec<CloudEntry>,
    ) -> RegistryResult<SyncReport> {
        self.apply_cloud_entries(org_id, entries, true).await
    }

    /// [`Self::apply_cloud_snapshot`] for a feed that was cut short: mirrors
    /// the entries received but deletes nothing of this organization's mirror
    /// it did not reach.
    pub async fn apply_cloud_partial(
        &self,
        org_id: &str,
        entries: Vec<CloudEntry>,
    ) -> RegistryResult<SyncReport> {
        let mut report = self.apply_cloud_entries(org_id, entries, false).await?;
        report.truncated = true;
        Ok(report)
    }

    async fn apply_cloud_entries(
        &self,
        org_id: &str,
        entries: Vec<CloudEntry>,
        prune: bool,
    ) -> RegistryResult<SyncReport> {
        let mut report = SyncReport::default();
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        let mut keep: BTreeSet<String> = BTreeSet::new();
        for entry in entries {
            let name = entry.prompt.name.clone();
            if !is_prompt_name(&name) {
                continue;
            }
            if let Some(existing) = Self::read_entry_raw(&tx, &name)? {
                if existing.summary.source.as_deref() != Some("cloud") {
                    report.conflicts.push(name);
                    continue;
                }
                // Another organization's copy, or an upstream prompt that was
                // deleted and recreated under the same name (its version numbers
                // restart): the stored versions are not this entry's history.
                if existing.org_id.as_deref() != Some(org_id)
                    || existing.summary.created_at != entry.prompt.created_at
                {
                    tx.execute(
                        "DELETE FROM prompt_entry_versions WHERE name = ?1",
                        params![name],
                    )?;
                }
            }
            let labels: BTreeMap<String, i64> = entry
                .prompt
                .labels
                .into_iter()
                .filter(|(label, _)| is_assignable_label(label))
                .collect();
            tx.execute(
                "INSERT INTO prompt_entries (name, source, org_id, description, tags_json, type,
                     latest_version, labels_json, created_at, updated_at)
                 VALUES (?1, 'cloud', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(name) DO UPDATE SET source = 'cloud', org_id = excluded.org_id,
                     description = excluded.description, tags_json = excluded.tags_json,
                     type = excluded.type, latest_version = excluded.latest_version,
                     labels_json = excluded.labels_json, created_at = excluded.created_at,
                     updated_at = excluded.updated_at",
                params![
                    name,
                    org_id,
                    self.seal_description(&name, entry.prompt.description.as_deref())?,
                    serde_json::to_string(&entry.prompt.tags)?,
                    entry.prompt.kind.as_str(),
                    entry.prompt.latest_version,
                    serde_json::to_string(&labels)?,
                    entry.prompt.created_at,
                    entry.prompt.updated_at,
                ],
            )?;
            for version in entry
                .versions
                .into_iter()
                .filter(|version| version.name == name)
            {
                // Versions are immutable upstream, so an existing row is kept.
                let sealed = self.seal_version(
                    &name,
                    version.version,
                    version.template.as_deref(),
                    version.messages.as_deref(),
                    &version.model_config,
                    version.commit_message.as_deref(),
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO prompt_entry_versions (name, version, type, template,
                         messages_json, variables_json, placeholders_json, model_config_json,
                         commit_message, created_by, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        name,
                        version.version,
                        version.kind.as_str(),
                        sealed.template,
                        sealed.messages,
                        serde_json::to_string(&version.variables)?,
                        serde_json::to_string(&version.placeholders)?,
                        sealed.model_config,
                        sealed.commit_message,
                        version.created_by,
                        version.created_at,
                    ],
                )?;
            }
            keep.insert(name);
            report.mirrored += 1;
        }
        let stale: Vec<String> = {
            let mut statement =
                tx.prepare("SELECT name, org_id FROM prompt_entries WHERE source = 'cloud'")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter()
                .filter(|(name, owner)| {
                    owner.as_deref() != Some(org_id) || (prune && !keep.contains(name))
                })
                .map(|(name, _)| name)
                .collect()
        };
        for name in &stale {
            tx.execute(
                "DELETE FROM prompt_entry_versions WHERE name = ?1",
                params![name],
            )?;
            tx.execute("DELETE FROM prompt_entries WHERE name = ?1", params![name])?;
        }
        report.removed = stale.len();
        tx.commit()?;
        Ok(report)
    }
}

fn visible(entry: &Entry, org_id: Option<&str>) -> bool {
    entry.summary.source.as_deref() != Some("cloud")
        || (org_id.is_some() && entry.org_id.as_deref() == org_id)
}

fn json_column<T: serde::de::DeserializeOwned>(index: usize, raw: &str) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let tags: String = row.get(4)?;
    let labels: String = row.get(7)?;
    let kind: String = row.get(5)?;
    Ok(Entry {
        org_id: row.get(2)?,
        summary: SummaryWire {
            name: row.get(0)?,
            source: Some(row.get(1)?),
            description: row.get(3)?,
            tags: json_column(4, &tags)?,
            kind: PromptType::parse(&kind),
            latest_version: row.get(6)?,
            labels: json_column(7, &labels)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        },
    })
}

/// A version row with its content columns still sealed; `open_version` opens
/// them (`messages` and `model_config` decode only after that).
fn version_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawVersion> {
    let kind: String = row.get(2)?;
    let variables: String = row.get(5)?;
    let placeholders: String = row.get(6)?;
    Ok(RawVersion {
        messages: row.get(4)?,
        model_config: row.get(7)?,
        wire: VersionWire {
            name: row.get(0)?,
            version: row.get(1)?,
            kind: PromptType::parse(&kind),
            template: row.get(3)?,
            messages: None,
            variables: json_column(5, &variables)?,
            placeholders: json_column(6, &placeholders)?,
            model_config: ModelConfig::default(),
            commit_message: row.get(8)?,
            created_by: row.get(9)?,
            created_at: row.get(10)?,
            labels: Vec::new(),
        },
    })
}

/// Seal legacy plaintext version content and reseal values sealed under a
/// retired key. `prompt_entry_versions` is keyed by `(name, version)`, so it is
/// walked here (one transaction; compare-and-swap per value; idempotent)
/// instead of by the single-key cursor migration. A value that does not open
/// is left as it is. Returns how many values were rewritten.
fn seal_legacy_versions(conn: &mut Connection, seal: &StoreSeal) -> Result<u64> {
    type Row = (
        String,
        i64,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    );
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows: Vec<Row> = {
        let mut statement = transaction.prepare(
            "SELECT name, version, template, messages_json, model_config_json, commit_message
             FROM prompt_entry_versions",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut sealed = 0u64;
    for (name, version, template, messages, model_config, commit_message) in rows {
        let columns: [(&str, &'static str, Option<&str>); 4] = [
            ("template", VERSION_TEMPLATE, template.as_deref()),
            ("messages_json", VERSION_MESSAGES, messages.as_deref()),
            (
                "model_config_json",
                VERSION_MODEL_CONFIG,
                Some(model_config.as_str()),
            ),
            (
                "commit_message",
                VERSION_COMMIT_MESSAGE,
                commit_message.as_deref(),
            ),
        ];
        for (column, purpose, stored) in columns {
            let Some(stored) = stored else {
                continue;
            };
            let Ok(Some(value)) =
                seal.reseal_if_needed(stored, &version_context(purpose, &name, version))
            else {
                continue;
            };
            sealed += transaction.execute(
                &format!(
                    "UPDATE prompt_entry_versions SET {column} = ?1
                     WHERE name = ?2 AND version = ?3 AND {column} IS ?4"
                ),
                params![value, name, version, stored],
            )? as u64;
        }
    }
    transaction.commit()?;
    Ok(sealed)
}

/// Attach the labels that point at `version` (plus `latest` on the newest).
fn with_labels(mut version: VersionWire, summary: &SummaryWire) -> VersionWire {
    let mut labels: Vec<String> = summary
        .labels
        .iter()
        .filter(|(_, target)| **target == version.version)
        .map(|(label, _)| label.clone())
        .collect();
    if version.version == summary.latest_version {
        labels.push(LATEST_LABEL.to_owned());
    }
    version.labels = labels;
    version
}

// ── Organization mirror ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub organization_id: String,
    pub prompts: Vec<CloudEntry>,
    pub next_after: Option<String>,
}

/// Walk the control plane's node feed page by page and replace the mirror.
/// `fetch_page(after)` returns one page; the walk is applied only when it
/// completes, so a partial walk never deletes prompts it did not reach.
pub async fn sync_with<F, Fut>(
    store: &PromptRegistryStore,
    org_id: &str,
    mut fetch_page: F,
) -> Result<SyncReport>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<FeedPage>>,
{
    let mut entries = Vec::new();
    let mut after = String::new();
    for _ in 0..MAX_SYNC_PAGES {
        let page = fetch_page(after.clone()).await?;
        if page.organization_id != org_id {
            anyhow::bail!(
                "prompt feed returned a different organization than this node is bound to"
            );
        }
        entries.extend(page.prompts);
        match page.next_after {
            Some(next) if next > after => after = next,
            Some(_) => anyhow::bail!("prompt feed cursor did not advance"),
            None => {
                return store
                    .apply_cloud_snapshot(org_id, entries)
                    .await
                    .map_err(|error| anyhow::anyhow!(registry_message(&error)));
            }
        }
    }
    // A feed this long is more than the node walks. Mirror what arrived rather
    // than refuse the whole snapshot (which would freeze every update and
    // deletion), and keep the prompts the walk did not reach.
    tracing::warn!(
        pages = MAX_SYNC_PAGES,
        "prompt feed exceeded the page limit; mirrored the pages received without removing stale prompts"
    );
    store
        .apply_cloud_partial(org_id, entries)
        .await
        .map_err(|error| anyhow::anyhow!(registry_message(&error)))
}

async fn fetch_feed_page(client: &reqwest::Client, key: &str, after: String) -> Result<FeedPage> {
    let base = crate::sidecar::control_plane::control_plane_url();
    let response = client
        .get(format!(
            "{}/api/control-plane/gateway/prompts",
            base.trim_end_matches('/')
        ))
        .header("x-gateway-key", key)
        .query(&[
            ("after", after.as_str()),
            ("limit", &SYNC_PAGE_SIZE.to_string()),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("prompt feed request failed")?;
    if !response.status().is_success() {
        anyhow::bail!("prompt feed returned {}", response.status());
    }
    response
        .json::<FeedPage>()
        .await
        .context("prompt feed decode failed")
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
}

struct SyncState {
    attempted: Option<Instant>,
    status: SyncStatus,
}

fn sync_state() -> &'static std::sync::Mutex<SyncState> {
    static STATE: OnceLock<std::sync::Mutex<SyncState>> = OnceLock::new();
    STATE.get_or_init(|| {
        std::sync::Mutex::new(SyncState {
            attempted: None,
            status: SyncStatus::default(),
        })
    })
}

fn sync_status() -> SyncStatus {
    sync_state()
        .lock()
        .map(|state| state.status.clone())
        .unwrap_or_default()
}

/// Mirror the organization registry now. `Ok(None)` when the node is not
/// bound to an organization or has no node credential.
pub async fn sync_now(store: &PromptRegistryStore) -> Result<Option<SyncReport>> {
    let (Some(org), Some(key)) = (
        crate::sidecar::control_plane::registered_org(),
        crate::sidecar::control_plane::gateway_key(),
    ) else {
        return Ok(None);
    };
    if let Ok(mut state) = sync_state().lock() {
        state.attempted = Some(Instant::now());
    }
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new);
    let result = sync_with(store, &org.id, |after| fetch_feed_page(client, &key, after)).await;
    if let Ok(mut state) = sync_state().lock() {
        match &result {
            Ok(report) => {
                state.status.last_synced_at = Some(now());
                state.status.last_error = report.truncated.then(|| {
                    format!(
                        "the organization registry is larger than {} prompts; the rest are not mirrored",
                        MAX_SYNC_PAGES * SYNC_PAGE_SIZE as usize
                    )
                });
                state.status.last_report = Some(report.clone());
            }
            Err(error) => state.status.last_error = Some(error.to_string()),
        }
    }
    result.map(Some)
}

/// Start a background mirror refresh when the last attempt is old enough.
fn refresh_in_background(store: &PromptRegistryStore) {
    if crate::sidecar::control_plane::registered_org().is_none() {
        return;
    }
    let due = sync_state().lock().is_ok_and(|mut state| {
        let due = state
            .attempted
            .is_none_or(|at| at.elapsed() >= SYNC_INTERVAL);
        if due {
            state.attempted = Some(Instant::now());
        }
        due
    });
    if !due {
        return;
    }
    let store = store.clone();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            if let Err(error) = sync_now(&store).await {
                tracing::debug!(error = %error, "prompt registry mirror refresh failed");
            }
        });
    }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn registry_message(error: &RegistryError) -> String {
    match error {
        RegistryError::Invalid(message) => format!("prompt_invalid_request: {message}"),
        RegistryError::NotFound(message) => format!("prompt_not_found: {message}"),
        RegistryError::Conflict(message) => format!("prompt_version_conflict: {message}"),
        RegistryError::ReadOnly(message) => format!("prompt_read_only: {message}"),
        RegistryError::Internal(error) => error.to_string(),
    }
}

fn registry_error(failure: RegistryError) -> Response {
    let status = match &failure {
        RegistryError::Invalid(_) => StatusCode::BAD_REQUEST,
        RegistryError::NotFound(_) => StatusCode::NOT_FOUND,
        RegistryError::Conflict(_) | RegistryError::ReadOnly(_) => StatusCode::CONFLICT,
        RegistryError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error(status, registry_message(&failure))
}

fn store() -> Result<PromptRegistryStore, Response> {
    PromptRegistryStore::open_default()
        .map_err(|err| error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
}

async fn permit(
    state: &super::ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), Response> {
    super::enforce_permission(state, caller, permission)
        .await
        .map_err(|status| error(status, "forbidden"))
}

fn checked_name(name: &str) -> Result<(), Response> {
    if is_prompt_name(name) {
        Ok(())
    } else {
        Err(error(
            StatusCode::BAD_REQUEST,
            "prompt_invalid_request: invalid prompt name",
        ))
    }
}

fn actor(caller: &Option<crate::identity_verify::VerifiedCaller>) -> Option<String> {
    caller.as_ref().map(|value| value.user_id.clone())
}

macro_rules! guard {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}

/// GET /api/prompts — local prompts and this node's organization mirror.
#[utoipa::path(
    get, path = "/api/prompts", tag = "Prompts",
    description = "Prompts authored on this node plus, when the node is bound to an organization, the read-only mirror of its prompt registry. Requires agent.view. Reading starts a background mirror refresh at most every 5 minutes.",
    responses((status = 200, description = "`{ prompts, organizationId, sync }`", body = serde_json::Value), (status = 403, description = "Missing agent.view"))
)]
pub async fn list(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW
        )
        .await
    );
    let store = guard!(store());
    refresh_in_background(&store);
    let org = super::node_org_id();
    match store.list(org.as_deref()).await {
        Ok(prompts) => Json(json!({
            "prompts": prompts,
            "organizationId": org,
            "sync": sync_status(),
        }))
        .into_response(),
        Err(err) => registry_error(err),
    }
}

/// POST /api/prompts — create a local prompt with its first version.
#[utoipa::path(
    post, path = "/api/prompts", tag = "Prompts", request_body = CreateInput,
    description = "Create a local prompt and commit its first immutable version. Requires agent.edit.",
    responses((status = 201, description = "`{ prompt, version }`", body = serde_json::Value), (status = 400, description = "Invalid name, template, or limits"), (status = 409, description = "A prompt with this name exists"))
)]
pub async fn create(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<CreateInput>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT
        )
        .await
    );
    let store = guard!(store());
    match store.create_local(input, actor(&caller).as_deref()).await {
        Ok((prompt, version)) => (
            StatusCode::CREATED,
            Json(json!({ "prompt": prompt, "version": version })),
        )
            .into_response(),
        Err(err) => registry_error(err),
    }
}

/// POST /api/prompts/sync — refresh the organization mirror now.
#[utoipa::path(
    post, path = "/api/prompts/sync", tag = "Prompts",
    description = "Refresh the organization mirror now. The mirror is replaced only after every feed page arrives. Requires agent.view.",
    responses((status = 200, description = "`{ synced, report }`, or `{ synced: false, reason }` when the node is not signed in", body = serde_json::Value), (status = 502, description = "The control plane feed failed"))
)]
pub async fn sync(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW
        )
        .await
    );
    let store = guard!(store());
    match sync_now(&store).await {
        Ok(Some(report)) => Json(json!({ "synced": true, "report": report })).into_response(),
        Ok(None) => Json(json!({
            "synced": false,
            "reason": "this node is not signed in to an organization"
        }))
        .into_response(),
        Err(err) => error(StatusCode::BAD_GATEWAY, err.to_string()),
    }
}

/// GET /api/prompts/:name
#[utoipa::path(
    get, path = "/api/prompts/{name}", tag = "Prompts", params(("name" = String, Path)),
    description = "One registry entry. Requires agent.view.",
    responses((status = 200, description = "`{ prompt }`", body = serde_json::Value), (status = 404, description = "No such prompt"))
)]
pub async fn get(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    match store.get(&name, super::node_org_id().as_deref()).await {
        Ok(prompt) => Json(json!({ "prompt": prompt })).into_response(),
        Err(err) => registry_error(err),
    }
}

/// DELETE /api/prompts/:name — delete a local prompt and its history.
#[utoipa::path(
    delete, path = "/api/prompts/{name}", tag = "Prompts", params(("name" = String, Path)),
    description = "Delete a local prompt and its versions. Organization mirrors are read-only (409). Requires agent.delete.",
    responses((status = 200, description = "`{ deleted: true }`", body = serde_json::Value), (status = 404, description = "No such prompt"), (status = 409, description = "Read-only organization prompt"))
)]
pub async fn delete(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_DELETE
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    match store.delete_local(&name).await {
        Ok(()) => Json(json!({ "deleted": true })).into_response(),
        Err(err) => registry_error(err),
    }
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct VersionsQuery {
    before: Option<i64>,
    limit: Option<u32>,
}

/// GET /api/prompts/:name/versions — newest first, paged by `before`.
#[utoipa::path(
    get, path = "/api/prompts/{name}/versions", tag = "Prompts", params(("name" = String, Path), VersionsQuery),
    description = "Versions newest first, paged with `before`. Requires agent.view.",
    responses((status = 200, description = "`{ prompt, versions, nextBefore }`", body = serde_json::Value), (status = 404, description = "No such prompt"))
)]
pub async fn list_versions(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
    Query(query): Query<VersionsQuery>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    let limit = query.limit.unwrap_or(DEFAULT_VERSION_PAGE).clamp(1, 200);
    match store
        .versions(&name, super::node_org_id().as_deref(), query.before, limit)
        .await
    {
        Ok((prompt, versions)) => {
            let next_before = (versions.len() == limit as usize)
                .then(|| versions.last().map(|version| version.version))
                .flatten();
            Json(json!({ "prompt": prompt, "versions": versions, "nextBefore": next_before }))
                .into_response()
        }
        Err(err) => registry_error(err),
    }
}

/// POST /api/prompts/:name/versions — commit a new immutable local version.
#[utoipa::path(
    post, path = "/api/prompts/{name}/versions", tag = "Prompts", params(("name" = String, Path)), request_body = VersionInput,
    description = "Commit a new immutable version of a local prompt, optionally moving labels onto it. `expectedLatestVersion` refuses the commit (409) when another commit landed first. Requires agent.edit.",
    responses((status = 201, description = "`{ prompt, version }`", body = serde_json::Value), (status = 400, description = "Invalid version"), (status = 404, description = "No such prompt"), (status = 409, description = "Version conflict or read-only organization prompt"))
)]
pub async fn commit(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
    Json(input): Json<VersionInput>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    match store
        .commit_local(&name, input, actor(&caller).as_deref())
        .await
    {
        Ok((prompt, version)) => (
            StatusCode::CREATED,
            Json(json!({ "prompt": prompt, "version": version })),
        )
            .into_response(),
        Err(err) => registry_error(err),
    }
}

/// GET /api/prompts/:name/versions/:version
#[utoipa::path(
    get, path = "/api/prompts/{name}/versions/{version}", tag = "Prompts", params(("name" = String, Path), ("version" = i64, Path)),
    description = "One immutable version. Requires agent.view.",
    responses((status = 200, description = "`{ version }`", body = serde_json::Value), (status = 404, description = "No such prompt or version"))
)]
pub async fn get_version(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((name, version)): Path<(String, i64)>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    match store
        .version(&name, super::node_org_id().as_deref(), version)
        .await
    {
        Ok(version) => Json(json!({ "version": version })).into_response(),
        Err(err) => registry_error(err),
    }
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ResolveQuery {
    label: Option<String>,
    version: Option<i64>,
}

/// GET /api/prompts/:name/resolve — `?label=` (default production) or `?version=`.
#[utoipa::path(
    get, path = "/api/prompts/{name}/resolve", tag = "Prompts", params(("name" = String, Path), ResolveQuery),
    description = "Resolve a label (default `production`; `latest` is the newest version) or an exact version. Requires agent.view.",
    responses((status = 200, description = "`{ version }`", body = serde_json::Value), (status = 400, description = "Both label and version, or an invalid label"), (status = 404, description = "No such prompt, label, or version"))
)]
pub async fn resolve(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
    Query(query): Query<ResolveQuery>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW
        )
        .await
    );
    guard!(checked_name(&name));
    if query.label.is_some() && query.version.is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "prompt_invalid_request: pass label or version, not both",
        );
    }
    if query
        .label
        .as_deref()
        .is_some_and(|label| !is_label_selector(label))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "prompt_invalid_request: invalid label",
        );
    }
    let store = guard!(store());
    refresh_in_background(&store);
    match store
        .resolve(
            &name,
            super::node_org_id().as_deref(),
            query.label.as_deref(),
            query.version,
        )
        .await
    {
        Ok(version) => Json(json!({ "version": version })).into_response(),
        Err(err) => registry_error(err),
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct LabelMove {
    version: i64,
}

/// PUT /api/prompts/:name/labels/:label — point a label at a version.
#[utoipa::path(
    put, path = "/api/prompts/{name}/labels/{label}", tag = "Prompts", params(("name" = String, Path), ("label" = String, Path)), request_body = LabelMove,
    description = "Point a label at an existing version of a local prompt. `latest` is computed and cannot be moved. Requires agent.edit.",
    responses((status = 200, description = "`{ prompt }`", body = serde_json::Value), (status = 400, description = "Invalid label"), (status = 404, description = "No such prompt or version"), (status = 409, description = "Read-only organization prompt"))
)]
pub async fn put_label(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((name, label)): Path<(String, String)>,
    Json(body): Json<LabelMove>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    match store.move_label(&name, &label, Some(body.version)).await {
        Ok(prompt) => Json(json!({ "prompt": prompt })).into_response(),
        Err(err) => registry_error(err),
    }
}

/// DELETE /api/prompts/:name/labels/:label — remove a label.
#[utoipa::path(
    delete, path = "/api/prompts/{name}/labels/{label}", tag = "Prompts", params(("name" = String, Path), ("label" = String, Path)),
    description = "Remove a label from a local prompt. Requires agent.edit.",
    responses((status = 200, description = "`{ prompt }`", body = serde_json::Value), (status = 404, description = "No such prompt or label"), (status = 409, description = "Read-only organization prompt"))
)]
pub async fn delete_label(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((name, label)): Path<(String, String)>,
) -> Response {
    guard!(
        permit(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT
        )
        .await
    );
    guard!(checked_name(&name));
    let store = guard!(store());
    match store.move_label(&name, &label, None).await {
        Ok(prompt) => Json(json!({ "prompt": prompt })).into_response(),
        Err(err) => registry_error(err),
    }
}

#[derive(utoipa::OpenApi)]
#[openapi(
    paths(
        list,
        create,
        sync,
        get,
        delete,
        list_versions,
        commit,
        get_version,
        resolve,
        put_label,
        delete_label
    ),
    components(schemas(
        CreateInput,
        VersionInput,
        LabelMove,
        ChatEntry,
        MessageEntry,
        PlaceholderEntry,
        PlaceholderKind,
        ModelConfig,
        PromptType
    )),
    tags((
        name = "Prompts",
        description = "The node prompt registry: named prompts with immutable versions and movable labels, plus a read-only mirror of the organization registry."
    ))
)]
struct PromptRegistryApiDoc;

/// The `/api/prompts` OpenAPI sub-doc, merged into Core's spec.
pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    PromptRegistryApiDoc::openapi()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str =
        include_str!("../../../../packages/protocol/src/fixtures/prompt-templates.json");

    #[derive(Deserialize)]
    struct Golden {
        cases: Vec<GoldenCase>,
    }

    #[derive(Deserialize)]
    struct GoldenCase {
        name: String,
        template: String,
        #[serde(default)]
        variables: Vec<String>,
        #[serde(default)]
        error: bool,
    }

    #[test]
    fn template_variables_match_the_golden_cases() {
        let golden: Golden = serde_json::from_str(GOLDEN).unwrap();
        assert!(!golden.cases.is_empty());
        for case in golden.cases {
            let result = template_variables(&case.template);
            if case.error {
                assert!(result.is_err(), "{} should fail", case.name);
            } else {
                assert_eq!(result.unwrap(), case.variables, "{}", case.name);
            }
        }
    }

    #[test]
    fn the_openapi_doc_covers_every_prompt_route() {
        let doc = openapi();
        for path in [
            "/api/prompts",
            "/api/prompts/sync",
            "/api/prompts/{name}",
            "/api/prompts/{name}/versions",
            "/api/prompts/{name}/versions/{version}",
            "/api/prompts/{name}/resolve",
            "/api/prompts/{name}/labels/{label}",
        ] {
            assert!(doc.paths.paths.contains_key(path), "{path} is undocumented");
        }
        assert!(crate::server::openapi::api_doc()
            .paths
            .paths
            .contains_key("/api/prompts/{name}/resolve"));
    }

    #[test]
    fn names_and_labels_follow_the_shared_patterns() {
        assert!(is_prompt_name("support.triage-v2"));
        assert!(!is_prompt_name("a/b"));
        assert!(!is_prompt_name("-x"));
        assert!(is_assignable_label("production"));
        assert!(!is_assignable_label("latest"));
        assert!(!is_assignable_label("Prod"));
        assert!(!is_assignable_label("a.b"));
        assert!(is_label_selector("latest"));
    }

    fn text(template: &str) -> VersionInput {
        serde_json::from_value(json!({ "type": "text", "template": template })).unwrap()
    }

    async fn seeded() -> PromptRegistryStore {
        let store = PromptRegistryStore::open_in_memory().unwrap();
        let input: CreateInput = serde_json::from_value(json!({
            "name": "triage",
            "tags": ["support", "support"],
            "version": {
                "type": "text",
                "template": "Classify {{ticket}}",
                "labels": ["production"],
                "modelConfig": { "model": "gpt-x", "temperature": 0.2 }
            }
        }))
        .unwrap();
        store.create_local(input, Some("u1")).await.unwrap();
        let chat: VersionInput = serde_json::from_value(json!({
            "type": "chat",
            "messages": [
                { "role": "system", "content": "You help {{team}}." },
                { "type": "placeholder", "name": "history" },
                { "role": "user", "content": "{{ticket}}" }
            ],
            "labels": ["staging"],
            "commitMessage": "chat form"
        }))
        .unwrap();
        store
            .commit_local("triage", chat, Some("u1"))
            .await
            .unwrap();
        store
    }

    #[tokio::test]
    async fn commits_are_numbered_and_carry_variables_and_labels() {
        let store = seeded().await;
        let summary = store.get("triage", None).await.unwrap();
        assert_eq!(summary.latest_version, 2);
        assert_eq!(summary.tags, vec!["support"]);
        assert_eq!(summary.source.as_deref(), Some("local"));
        let first = store.version("triage", None, 1).await.unwrap();
        assert_eq!(first.variables, vec!["ticket"]);
        assert_eq!(first.labels, vec!["production"]);
        assert_eq!(first.model_config.model.as_deref(), Some("gpt-x"));
        assert_eq!(first.created_by.as_deref(), Some("u1"));
        let second = store.version("triage", None, 2).await.unwrap();
        assert_eq!(second.kind, PromptType::Chat);
        assert_eq!(second.variables, vec!["team", "ticket"]);
        assert_eq!(second.placeholders, vec!["history"]);
        assert_eq!(second.labels, vec!["staging", "latest"]);
        assert_eq!(second.commit_message.as_deref(), Some("chat form"));
    }

    #[tokio::test]
    async fn resolve_defaults_to_production_and_computes_latest() {
        let store = seeded().await;
        assert_eq!(
            store
                .resolve("triage", None, None, None)
                .await
                .unwrap()
                .version,
            1
        );
        assert_eq!(
            store
                .resolve("triage", None, Some("latest"), None)
                .await
                .unwrap()
                .version,
            2
        );
        assert_eq!(
            store
                .resolve("triage", None, None, Some(1))
                .await
                .unwrap()
                .version,
            1
        );
        assert!(matches!(
            store.resolve("triage", None, Some("canary"), None).await,
            Err(RegistryError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn stale_commits_and_duplicate_names_conflict() {
        let store = seeded().await;
        let mut stale = text("x");
        stale.expected_latest_version = Some(1);
        assert!(matches!(
            store.commit_local("triage", stale, None).await,
            Err(RegistryError::Conflict(_))
        ));
        let duplicate: CreateInput = serde_json::from_value(json!({
            "name": "triage",
            "version": { "type": "text", "template": "x" }
        }))
        .unwrap();
        assert!(matches!(
            store.create_local(duplicate, None).await,
            Err(RegistryError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn invalid_versions_are_refused_with_their_path() {
        let store = seeded().await;
        let Err(RegistryError::Invalid(message)) =
            store.commit_local("triage", text("{{#open}}"), None).await
        else {
            panic!("expected an invalid template");
        };
        assert!(message.starts_with("template:"));
        let mixed: VersionInput = serde_json::from_value(json!({
            "type": "text", "template": "x", "labels": ["latest"]
        }))
        .unwrap();
        assert!(matches!(
            store.commit_local("triage", mixed, None).await,
            Err(RegistryError::Invalid(_))
        ));
        assert!(serde_json::from_value::<VersionInput>(json!({
            "type": "text", "template": "x", "modelConfig": { "unknown": 1 }
        }))
        .is_err());
    }

    #[tokio::test]
    async fn labels_move_only_to_existing_versions() {
        let store = seeded().await;
        let summary = store
            .move_label("triage", "production", Some(2))
            .await
            .unwrap();
        assert_eq!(summary.labels.get("production"), Some(&2));
        assert!(matches!(
            store.move_label("triage", "production", Some(9)).await,
            Err(RegistryError::NotFound(_))
        ));
        assert!(matches!(
            store.move_label("triage", "latest", Some(1)).await,
            Err(RegistryError::Invalid(_))
        ));
        let summary = store.move_label("triage", "staging", None).await.unwrap();
        assert!(!summary.labels.contains_key("staging"));
        let (_, versions) = store.versions("triage", None, None, 10).await.unwrap();
        assert_eq!(
            versions.iter().map(|v| v.version).collect::<Vec<_>>(),
            vec![2, 1]
        );
        let (_, page) = store.versions("triage", None, Some(2), 10).await.unwrap();
        assert_eq!(page.len(), 1);
    }

    fn cloud_entry(name: &str, latest: i64, production: i64) -> CloudEntry {
        serde_json::from_value(json!({
            "prompt": {
                "name": name,
                "description": null,
                "tags": [],
                "type": "text",
                "latestVersion": latest,
                "labels": { "production": production },
                "createdAt": "2026-10-01T00:00:00.000Z",
                "updatedAt": "2026-10-02T00:00:00.000Z"
            },
            "versions": (1..=latest).rev().map(|version| json!({
                "name": name,
                "version": version,
                "type": "text",
                "template": format!("v{version} {{{{x}}}}"),
                "messages": null,
                "variables": ["x"],
                "placeholders": [],
                "modelConfig": {},
                "commitMessage": null,
                "createdBy": "u9",
                "createdAt": "2026-10-01T00:00:00.000Z",
                "labels": []
            })).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn the_cloud_mirror_is_read_only_and_scoped_to_the_bound_org() {
        let store = seeded().await;
        let report = store
            .apply_cloud_snapshot(
                "org1",
                vec![cloud_entry("summarize", 2, 1), cloud_entry("triage", 1, 1)],
            )
            .await
            .unwrap();
        assert_eq!(report.mirrored, 1);
        assert_eq!(report.conflicts, vec!["triage"]);
        // Hidden without the org binding, served offline with it.
        assert!(store.get("summarize", None).await.is_err());
        assert!(store.get("summarize", Some("org2")).await.is_err());
        let resolved = store
            .resolve("summarize", Some("org1"), None, None)
            .await
            .unwrap();
        assert_eq!(resolved.version, 1);
        assert_eq!(resolved.template.as_deref(), Some("v1 {{x}}"));
        assert_eq!(
            store
                .get("summarize", Some("org1"))
                .await
                .unwrap()
                .source
                .as_deref(),
            Some("cloud")
        );
        assert!(matches!(
            store.commit_local("summarize", text("x"), None).await,
            Err(RegistryError::ReadOnly(_))
        ));
        assert!(matches!(
            store.move_label("summarize", "production", Some(2)).await,
            Err(RegistryError::ReadOnly(_))
        ));
        assert!(matches!(
            store.delete_local("summarize").await,
            Err(RegistryError::ReadOnly(_))
        ));
        // The local prompt is untouched by the collision.
        assert_eq!(store.get("triage", None).await.unwrap().latest_version, 2);
    }

    #[tokio::test]
    async fn a_complete_snapshot_removes_deleted_and_foreign_mirrors() {
        let store = PromptRegistryStore::open_in_memory().unwrap();
        store
            .apply_cloud_snapshot("org1", vec![cloud_entry("a", 1, 1), cloud_entry("b", 1, 1)])
            .await
            .unwrap();
        let report = store
            .apply_cloud_snapshot("org1", vec![cloud_entry("a", 3, 3)])
            .await
            .unwrap();
        assert_eq!(report.removed, 1);
        assert!(store.get("b", Some("org1")).await.is_err());
        assert_eq!(
            store
                .resolve("a", Some("org1"), None, None)
                .await
                .unwrap()
                .version,
            3
        );
        let report = store.apply_cloud_snapshot("org2", vec![]).await.unwrap();
        assert_eq!(report.removed, 1);
        assert!(store.list(Some("org1")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_recreated_organization_prompt_drops_its_old_versions() {
        let store = PromptRegistryStore::open_in_memory().unwrap();
        store
            .apply_cloud_snapshot("org1", vec![cloud_entry("a", 2, 2)])
            .await
            .unwrap();
        let mut recreated = cloud_entry("a", 1, 1);
        recreated.prompt.created_at = "2026-10-05T00:00:00.000Z".into();
        recreated.versions[0].template = Some("fresh {{x}}".into());
        store
            .apply_cloud_snapshot("org1", vec![recreated])
            .await
            .unwrap();
        let resolved = store.resolve("a", Some("org1"), None, None).await.unwrap();
        assert_eq!(resolved.template.as_deref(), Some("fresh {{x}}"));
        let (_, versions) = store.versions("a", Some("org1"), None, 10).await.unwrap();
        assert_eq!(versions.len(), 1);
    }

    #[tokio::test]
    async fn sync_walks_every_page_before_applying() {
        let store = PromptRegistryStore::open_in_memory().unwrap();
        let mut afters = Vec::new();
        let report = sync_with(&store, "org1", |after| {
            afters.push(after.clone());
            let page = if after.is_empty() {
                FeedPage {
                    organization_id: "org1".into(),
                    prompts: vec![cloud_entry("a", 1, 1)],
                    next_after: Some("a".into()),
                }
            } else {
                FeedPage {
                    organization_id: "org1".into(),
                    prompts: vec![cloud_entry("b", 1, 1)],
                    next_after: None,
                }
            };
            async move { Ok(page) }
        })
        .await
        .unwrap();
        assert_eq!(afters, vec!["", "a"]);
        assert_eq!(report.mirrored, 2);
    }

    #[tokio::test]
    async fn sync_refuses_another_org_and_partial_walks() {
        let store = PromptRegistryStore::open_in_memory().unwrap();
        store
            .apply_cloud_snapshot("org1", vec![cloud_entry("keep", 1, 1)])
            .await
            .unwrap();
        let foreign = sync_with(&store, "org1", |_| async {
            Ok(FeedPage {
                organization_id: "org2".into(),
                prompts: vec![],
                next_after: None,
            })
        })
        .await;
        assert!(foreign.is_err());
        let failing = sync_with(&store, "org1", |after| async move {
            if after.is_empty() {
                Ok(FeedPage {
                    organization_id: "org1".into(),
                    prompts: vec![],
                    next_after: Some("m".into()),
                })
            } else {
                anyhow::bail!("network down")
            }
        })
        .await;
        assert!(failing.is_err());
        assert!(store.get("keep", Some("org1")).await.is_ok());
    }

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[23u8; 32], STORE)
    }

    fn file_contains(path: &FsPath, needle: &str) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
            .unwrap_or(false)
    }

    const MARKERS: [&str; 5] = [
        "template-marker",
        "system-message-marker",
        "commit-marker",
        "description-marker",
        "model-marker",
    ];

    fn assert_no_markers(dir: &FsPath) {
        for file in [
            dir.join("prompt-registry.db"),
            dir.join("prompt-registry.db-wal"),
        ] {
            for marker in MARKERS {
                assert!(
                    !file_contains(&file, marker),
                    "{marker} in {}",
                    file.display()
                );
            }
        }
    }

    #[tokio::test]
    async fn prompt_content_is_sealed_on_disk_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prompt-registry.db");
        let store = PromptRegistryStore::open_at(path.clone(), test_cipher()).unwrap();
        let input: CreateInput = serde_json::from_value(json!({
            "name": "secret-prompt",
            "description": "description-marker",
            "version": {
                "type": "text",
                "template": "template-marker {{x}}",
                "commitMessage": "commit-marker",
                "modelConfig": { "model": "model-marker" }
            }
        }))
        .unwrap();
        store.create_local(input, Some("u1")).await.unwrap();
        let chat: VersionInput = serde_json::from_value(json!({
            "type": "chat",
            "messages": [{ "role": "system", "content": "system-message-marker" }]
        }))
        .unwrap();
        store
            .commit_local("secret-prompt", chat, None)
            .await
            .unwrap();
        let mut mirrored = cloud_entry("org-prompt", 1, 1);
        mirrored.prompt.description = Some("description-marker".into());
        mirrored.versions[0].template = Some("template-marker {{x}}".into());
        mirrored.versions[0].commit_message = Some("commit-marker".into());
        store
            .apply_cloud_snapshot("org1", vec![mirrored])
            .await
            .unwrap();
        drop(store);
        assert_no_markers(dir.path());

        let store = PromptRegistryStore::open_at(path.clone(), test_cipher()).unwrap();
        let summary = store.get("secret-prompt", None).await.unwrap();
        assert_eq!(summary.description.as_deref(), Some("description-marker"));
        let first = store
            .resolve("secret-prompt", None, None, Some(1))
            .await
            .unwrap();
        assert_eq!(first.template.as_deref(), Some("template-marker {{x}}"));
        assert_eq!(first.commit_message.as_deref(), Some("commit-marker"));
        assert_eq!(first.model_config.model.as_deref(), Some("model-marker"));
        let (_, versions) = store
            .versions("secret-prompt", None, None, 10)
            .await
            .unwrap();
        let ChatEntry::Message(message) = &versions[0].messages.as_ref().unwrap()[0] else {
            panic!("expected a message");
        };
        assert_eq!(message.content, "system-message-marker");
        let mirror = store
            .resolve("org-prompt", Some("org1"), None, None)
            .await
            .unwrap();
        assert_eq!(mirror.template.as_deref(), Some("template-marker {{x}}"));
        // A listing reads the sealed description too.
        let listed = store.list(Some("org1")).await.unwrap();
        assert!(listed
            .iter()
            .any(|entry| entry.description.as_deref() == Some("description-marker")));
        let conn = Connection::open(&path).unwrap();
        ryu_crypto::content_sqlite::assert_all_open(
            &conn,
            &test_cipher(),
            &column_plans().unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn legacy_plaintext_prompts_are_sealed_on_open_and_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prompt-registry.db");
        {
            let conn = Connection::open(&path).unwrap();
            PromptRegistryStore::create_tables(&conn).unwrap();
            conn.execute_batch(
                r#"INSERT INTO prompt_entries VALUES ('old', 'local', NULL, 'description-marker', '[]', 'text', 1, '{"production":1}', 'a', 'a');
                   INSERT INTO prompt_entry_versions VALUES ('old', 1, 'text', 'template-marker', NULL, '[]', '[]', '{"model":"model-marker"}', 'commit-marker', NULL, 'a');"#,
            )
            .unwrap();
        }
        let store = PromptRegistryStore::open_at(path.clone(), test_cipher()).unwrap();
        let resolved = store.resolve("old", None, None, None).await.unwrap();
        assert_eq!(resolved.template.as_deref(), Some("template-marker"));
        assert_eq!(resolved.commit_message.as_deref(), Some("commit-marker"));
        assert_eq!(resolved.model_config.model.as_deref(), Some("model-marker"));
        assert_eq!(
            store.get("old", None).await.unwrap().description.as_deref(),
            Some("description-marker")
        );
        drop(store);
        assert_no_markers(dir.path());
    }

    #[tokio::test]
    async fn a_feed_longer_than_the_page_limit_is_mirrored_without_pruning() {
        let store = PromptRegistryStore::open_in_memory().unwrap();
        store
            .apply_cloud_snapshot("org1", vec![cloud_entry("stale", 1, 1)])
            .await
            .unwrap();
        let report = sync_with(&store, "org1", |after| {
            let index = after.trim_start_matches('p').parse::<usize>().unwrap_or(0);
            let page = FeedPage {
                organization_id: "org1".into(),
                prompts: vec![cloud_entry(&format!("p{:04}", index + 1), 1, 1)],
                next_after: Some(format!("p{:04}", index + 1)),
            };
            async move { Ok(page) }
        })
        .await
        .unwrap();
        assert!(report.truncated);
        assert_eq!(report.mirrored, MAX_SYNC_PAGES);
        assert_eq!(report.removed, 0);
        assert!(store.get("stale", Some("org1")).await.is_ok());
        assert!(store.get("p0001", Some("org1")).await.is_ok());
    }
}
