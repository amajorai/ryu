//! ChatGPT and Claude account data exports: conversations, projects, and
//! saved context, read from the unzipped folder each product's "Export data"
//! download produces.
//!
//! - **ChatGPT** (Settings → Data controls → Export data): `conversations.json`
//!   is an array of conversations whose messages form a tree in `mapping`; the
//!   visible thread is the path from `current_node` up to the root. Project
//!   chats carry a `g-p-…` `gizmo_id`; project names are not exported. Custom
//!   instructions appear as `user_editable_context` system messages.
//! - **Claude** (Settings → Privacy → Export data): `conversations.json` is an
//!   array of conversations with a flat `chat_messages` list; `projects.json`
//!   holds project names, instructions (`prompt_template`), and knowledge docs;
//!   `memories.json`, when present, holds saved memory text.
//!
//! Like the rest of `crate::import`, this module is the pure read side. It
//! groups conversations into importable units (one per project plus one for
//! chats outside a project) so a scan of a large export stays a short list, and
//! the server handler writes each conversation through the same conversation
//! store seam the native thread importer uses, deduplicated by the source id.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::{counted, kind, messages, Collector, Message, ScanItem};
use crate::native_history::ImportedMessage;

mod parse;
mod project_folder;
mod saved_context;
mod scan;

pub use parse::*;
pub use project_folder::*;
pub use saved_context::*;
pub use scan::*;

/// Largest total of conversation files read (`conversations.json`, or every
/// `conversations-NNN.json` part together). Exports of heavy accounts run to
/// hundreds of megabytes; beyond this the scan reports it instead of loading.
const MAX_EXPORT_BYTES: u64 = 1024 * 1024 * 1024;
/// Most `conversations-NNN.json` parts read from one split export.
const MAX_EXPORT_PARTS: usize = 1_000;
/// Largest `projects.json` / `memories.json` / `user.json` read.
const MAX_SIDE_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Messages kept per imported conversation (oldest first).
pub const MAX_MESSAGES_PER_CONVERSATION: usize = 5_000;
/// Longest single imported message, in bytes.
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// Largest project knowledge document written into a project folder.
const MAX_DOC_BYTES: usize = 8 * 1024 * 1024;

/// Group id for conversations that are not in a project.
pub const UNGROUPED: &str = "chats";
/// Fragment naming saved custom instructions / memories in an export.
pub const SAVED_CONTEXT: &str = "saved-context";

/// Which product an export came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportSource {
    ChatGpt,
    Claude,
}

impl ExportSource {
    pub fn id(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatgpt",
            Self::Claude => "claude-ai",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT",
            Self::Claude => "Claude",
        }
    }

    /// Conversation import origin, used to deduplicate re-imports.
    pub fn origin(self) -> String {
        format!("import:{}", self.id())
    }
}

/// One conversation from an export, normalized to Ryu messages.
#[derive(Debug, Clone)]
pub struct ExportConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<ImportedMessage>,
    pub truncated: bool,
    /// Fingerprints of messages the export still holds but that are no longer
    /// on the visible branch (a ChatGPT prompt edited or a reply regenerated).
    /// A re-import uses them to recognise an earlier import of a branch the
    /// user has since replaced, instead of appending the new branch after it.
    superseded: Vec<(u64, Option<i64>)>,
}

impl ExportConversation {
    /// Whether a stored message matches a message the export has moved off
    /// its visible branch since it was imported.
    pub fn is_superseded(&self, role: &str, content: &str, created_at: i64) -> bool {
        let key = message_key(role, content);
        self.superseded
            .iter()
            .any(|(k, at)| *k == key && at.is_none_or(|at| at == created_at))
    }
}

fn message_key(role: &str, content: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    role.hash(&mut hasher);
    content.hash(&mut hasher);
    hasher.finish()
}

/// A project as the export describes it.
#[derive(Debug, Clone, Default)]
pub struct ExportProject {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    /// `(file name, content)` knowledge documents.
    pub docs: Vec<(String, String)>,
    /// Project-scoped memory text (Claude), written into the project folder.
    pub memory: String,
}

/// The conversation files of an export: `conversations.json`, or the
/// `conversations-000.json`, `conversations-001.json`, … split that large
/// ChatGPT accounts receive.
fn conversation_files(root: &Path) -> Vec<PathBuf> {
    let single = root.join("conversations.json");
    if single.is_file() {
        return vec![single];
    }
    let mut split: Vec<PathBuf> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_conversation_part)
        })
        .collect();
    split.sort();
    split
}

/// `conversations-NNN.json`: one part of a split ChatGPT export.
fn is_conversation_part(name: &str) -> bool {
    name.strip_prefix("conversations-")
        .and_then(|n| n.strip_suffix(".json"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether `name` is a top-level file of an export that the importer reads, or
/// that [`detect`] falls back on to recognise an empty export. Everything else
/// beside them, such as the file kept for every image a heavy account handled,
/// is never read.
pub fn is_import_file(name: &str) -> bool {
    matches!(
        name,
        "conversations.json"
            | "projects.json"
            | "memories.json"
            | "users.json"
            | "user.json"
            | "chat.html"
    ) || is_conversation_part(name)
}

/// Detect a ChatGPT or Claude export by peeking at its conversation file.
pub fn detect(root: &Path) -> Option<ExportSource> {
    let path = conversation_files(root).into_iter().next()?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    // Read a bounded prefix: both formats name their distinguishing key in
    // the first conversation object.
    use std::io::Read;
    let mut head = vec![0u8; 256 * 1024];
    let n = fs::File::open(&path).ok()?.read(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head[..n]);
    let trimmed = head.trim_start();
    if !trimmed.starts_with('[') {
        return None;
    }
    if head.contains("\"chat_messages\"") {
        return Some(ExportSource::Claude);
    }
    if head.contains("\"mapping\"") && head.contains("\"current_node\"") {
        return Some(ExportSource::ChatGpt);
    }
    // An empty export (`[]`): fall back to the companion files.
    if trimmed.trim_end() == "[]" || trimmed.len() < 4 {
        if root.join("projects.json").is_file()
            || root.join("projects").is_dir()
            || root.join("users.json").is_file()
        {
            return Some(ExportSource::Claude);
        }
        if root.join("chat.html").is_file() || root.join("user.json").is_file() {
            return Some(ExportSource::ChatGpt);
        }
    }
    None
}

fn read_json(path: &Path, max: u64) -> Result<Value> {
    let meta = fs::metadata(path).with_context(|| format!("{} not found", path.display()))?;
    if meta.len() > max {
        bail!(
            "{} is {} MB, larger than the {} MB import limit",
            path.display(),
            meta.len() / (1024 * 1024),
            max / (1024 * 1024)
        );
    }
    let file = fs::File::open(path)?;
    serde_json::from_reader(std::io::BufReader::new(file))
        .with_context(|| format!("parsing {}", path.display()))
}

fn conversations(root: &Path) -> Result<Vec<Value>> {
    let files = conversation_files(root);
    if files.is_empty() {
        bail!("conversations.json not found");
    }
    if files.len() > MAX_EXPORT_PARTS {
        bail!(
            "the export is split into {} conversation files, more than the {MAX_EXPORT_PARTS} import limit",
            files.len()
        );
    }
    // The limit covers the parts of a split export together: each part is
    // parsed and held at once, so a per-file limit alone would not bound it.
    let mut total: u64 = 0;
    for file in &files {
        let len = fs::metadata(file)
            .with_context(|| format!("{} not found", file.display()))?
            .len();
        total = total.saturating_add(len);
    }
    if total > MAX_EXPORT_BYTES {
        bail!(
            "the conversation files total {} MB, larger than the {} MB import limit",
            total / (1024 * 1024),
            MAX_EXPORT_BYTES / (1024 * 1024)
        );
    }
    let mut all = Vec::new();
    for file in files {
        match read_json(&file, MAX_EXPORT_BYTES)? {
            Value::Array(items) => all.extend(items),
            _ => bail!("{} is not a list of conversations", file.display()),
        }
    }
    Ok(all)
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/// The project group a raw conversation belongs to, or [`UNGROUPED`].
fn group_of(source: ExportSource, conversation: &Value) -> String {
    let project = match source {
        ExportSource::ChatGpt => ["gizmo_id", "conversation_template_id"]
            .iter()
            .filter_map(|key| conversation.get(*key).and_then(Value::as_str))
            .find(|id| id.starts_with("g-p-"))
            .map(str::to_string),
        ExportSource::Claude => conversation
            .get("project_uuid")
            .and_then(Value::as_str)
            .or_else(|| {
                conversation
                    .pointer("/project/uuid")
                    .and_then(Value::as_str)
            })
            .map(str::to_string),
    };
    project
        .filter(|id| is_fragment_safe(id))
        .unwrap_or_else(|| UNGROUPED.to_string())
}

/// Characters allowed in an item-id fragment (uuids, `g-p-…`, `chats`).
pub fn is_fragment_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Projects declared by the export (Claude `projects.json`), keyed by id.
pub fn declared_projects(root: &Path, source: ExportSource) -> BTreeMap<String, ExportProject> {
    let mut out = BTreeMap::new();
    if source != ExportSource::Claude {
        return out;
    }
    // Older exports ship one `projects.json` list; newer ones a
    // `projects/<uuid>.json` file per project.
    let mut projects = Vec::new();
    if let Ok(Value::Array(list)) = read_json(&root.join("projects.json"), MAX_SIDE_FILE_BYTES) {
        projects.extend(list);
    }
    projects.extend(json_records(&root.join("projects")));
    let project_memories = claude_project_memories(root);
    for project in projects {
        let Some(id) = project
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|id| is_fragment_safe(id))
        else {
            continue;
        };
        let text = |key: &str| {
            project
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        let docs = project
            .get("docs")
            .and_then(Value::as_array)
            .map(|docs| {
                docs.iter()
                    .filter_map(|doc| {
                        let name = doc.get("filename").and_then(Value::as_str)?.trim();
                        let content = doc.get("content").and_then(Value::as_str)?;
                        (!name.is_empty()).then(|| (name.to_string(), content.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.insert(
            id.to_string(),
            ExportProject {
                id: id.to_string(),
                name: text("name"),
                description: text("description"),
                instructions: text("prompt_template"),
                docs,
                memory: project_memories.get(id).cloned().unwrap_or_default(),
            },
        );
    }
    out
}

/// The project for a group id: declared metadata when the export has it,
/// otherwise a placeholder named after the source (ChatGPT does not export
/// project names).
pub fn project_for(root: &Path, source: ExportSource, group: &str) -> Option<ExportProject> {
    if group == UNGROUPED {
        return None;
    }
    project_in(&declared_projects(root, source), source, group)
}

/// [`project_for`] against projects already read with [`declared_projects`],
/// so a scan or batch reads the export's project files once.
pub fn project_in(
    declared: &BTreeMap<String, ExportProject>,
    source: ExportSource,
    group: &str,
) -> Option<ExportProject> {
    if group == UNGROUPED {
        return None;
    }
    if let Some(project) = declared.get(group) {
        return Some(project.clone());
    }
    let short = group.trim_start_matches("g-p-");
    Some(ExportProject {
        id: group.to_string(),
        name: format!(
            "{} project {}",
            source.label(),
            &short[..short.len().min(8)]
        ),
        ..ExportProject::default()
    })
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
