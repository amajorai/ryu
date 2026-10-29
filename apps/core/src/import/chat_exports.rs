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

use super::{kind, Collector, ScanItem};
use crate::native_history::ImportedMessage;

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

pub(super) fn collect(root: &Path, c: &mut Collector) -> Option<ExportSource> {
    let source = detect(root)?;
    let raw = match conversations(root) {
        Ok(raw) => raw,
        Err(error) => {
            c.warnings
                .push(format!("{} export: {error}", source.label()));
            return Some(source);
        }
    };
    let mut groups: BTreeMap<String, usize> = BTreeMap::new();
    // ChatGPT does not export project names; show a recent chat title so the
    // user can recognise each project in the preview.
    let mut example_titles: BTreeMap<String, (f64, String)> = BTreeMap::new();
    for conversation in &raw {
        let group = group_of(source, conversation);
        *groups.entry(group.clone()).or_default() += 1;
        let updated = conversation
            .get("update_time")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some(title) = conversation.get("title").and_then(Value::as_str) {
            let entry = example_titles
                .entry(group)
                .or_insert((f64::MIN, String::new()));
            if updated > entry.0 && !title.trim().is_empty() {
                *entry = (updated, title.trim().to_string());
            }
        }
    }
    let projects = declared_projects(root, source);
    // Projects with no conversations still carry instructions and docs.
    for id in projects.keys() {
        groups.entry(id.clone()).or_default();
    }
    for (group, count) in &groups {
        let project = project_in(&projects, source, group);
        let title = match &project {
            None => format!("{} chats ({count})", source.label()),
            Some(project) if *count == 0 => {
                format!("{} project '{}'", source.label(), project.name)
            }
            Some(project) => format!(
                "{} project '{}' ({count} chat{})",
                source.label(),
                project.name,
                if *count == 1 { "" } else { "s" }
            ),
        };
        let example = example_titles
            .get(group)
            .filter(|_| source == ExportSource::ChatGpt && project.is_some())
            .map(|(_, title)| format!("Latest chat: “{title}”. "))
            .unwrap_or_default();
        let detail = project.as_ref().map(|project| {
            let mut parts = Vec::new();
            if !project.instructions.is_empty() {
                parts.push("instructions".to_string());
            }
            if !project.docs.is_empty() {
                parts.push(format!("{} knowledge file(s)", project.docs.len()));
            }
            if !project.memory.is_empty() {
                parts.push("project memory".to_string());
            }
            if parts.is_empty() {
                format!("{example}Becomes a project folder.")
            } else {
                format!(
                    "{example}Becomes a project folder with {}.",
                    parts.join(", ")
                )
            }
        });
        c.conversations.push(ScanItem {
            content_revision: None,
            kind: kind::CONVERSATIONS,
            id: format!("{}/conversations.json#{group}", kind::CONVERSATIONS),
            title,
            detail,
            already_exists: false,
        });
    }
    let has_saved_context = match source {
        // The conversations are already parsed; do not read them again.
        ExportSource::ChatGpt => !chatgpt_custom_instructions_in(&raw).is_empty(),
        ExportSource::Claude => !claude_memories(root).is_empty(),
    };
    drop(raw);
    if has_saved_context {
        // Name a file that exists: a split ChatGPT export has no
        // `conversations.json`, only `conversations-000.json` and on.
        let conversations_file = conversation_files(root)
            .first()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("conversations.json")
            .to_string();
        let (file, label) = match source {
            ExportSource::ChatGpt => (conversations_file, "ChatGPT custom instructions"),
            ExportSource::Claude if root.join("memories.json").is_file() => {
                ("memories.json".to_string(), "Claude memory")
            }
            ExportSource::Claude => (conversations_file, "Claude memory"),
        };
        c.memories.push(ScanItem {
            content_revision: None,
            kind: kind::MEMORY,
            id: format!("{}/{file}#{SAVED_CONTEXT}", kind::MEMORY),
            title: label.to_string(),
            detail: Some(root.join(&file).to_string_lossy().to_string()),
            already_exists: false,
        });
    }
    match source {
        ExportSource::ChatGpt => {
            c.warnings.push(
                "ChatGPT does not export project names, files, or saved memories. Imported projects are named by id; rename them in Ryu and add their files to the project folder."
                    .to_owned(),
            );
        }
        ExportSource::Claude => {
            if !root.join("memories.json").is_file() && !root.join("memories").is_dir() {
                c.warnings.push(
                    "This Claude export has no memories file; saved memory was not included in the download."
                        .to_owned(),
                );
            }
            if groups.len() > 1 || !groups.contains_key(UNGROUPED) {
                c.warnings.push(
                    "Claude exports do not record which project a chat belongs to, so project chats are imported with your other Claude chats. Each project still becomes a folder with its instructions, knowledge files, and memory."
                        .to_owned(),
                );
            }
        }
    }
    c.warnings.push(format!(
        "Images, uploaded files, and tool results in {} chats are imported as text placeholders.",
        source.label()
    ));
    Some(source)
}

// ---------------------------------------------------------------------------
// Read a group for import
// ---------------------------------------------------------------------------

/// Every conversation in `group`, normalized and oldest first.
pub fn read_group(
    root: &Path,
    source: ExportSource,
    group: &str,
) -> Result<Vec<ExportConversation>> {
    let groups = BTreeSet::from([group.to_string()]);
    Ok(read_groups(root, source, &groups)?
        .remove(group)
        .unwrap_or_default())
}

/// Every conversation in each of `groups`, normalized and oldest first, from
/// a single pass over the export. Importing several groups reads the export
/// once instead of once per group. Every requested group has an entry.
pub fn read_groups(
    root: &Path,
    source: ExportSource,
    groups: &BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<ExportConversation>>> {
    let mut out: BTreeMap<String, Vec<ExportConversation>> = groups
        .iter()
        .map(|group| (group.clone(), Vec::new()))
        .collect();
    for raw in conversations(root)? {
        let Some(list) = out.get_mut(&group_of(source, &raw)) else {
            continue;
        };
        let parsed = match source {
            ExportSource::ChatGpt => parse_chatgpt(&raw),
            ExportSource::Claude => parse_claude(&raw),
        };
        if let Some(conversation) = parsed.filter(|c| !c.messages.is_empty()) {
            list.push(conversation);
        }
    }
    for list in out.values_mut() {
        list.sort_by_key(|c| c.messages.first().and_then(|m| m.created_at).unwrap_or(0));
    }
    Ok(out)
}

fn clamp(text: &str) -> String {
    let text = text.trim();
    if text.len() <= MAX_MESSAGE_BYTES {
        return text.to_string();
    }
    let mut end = MAX_MESSAGE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[message truncated on import]", &text[..end])
}

fn finish(
    id: String,
    title: String,
    mut messages: Vec<ImportedMessage>,
    superseded: Vec<(u64, Option<i64>)>,
) -> ExportConversation {
    let truncated = messages.len() > MAX_MESSAGES_PER_CONVERSATION;
    messages.truncate(MAX_MESSAGES_PER_CONVERSATION);
    let title = if title.trim().is_empty() {
        "Imported chat".to_string()
    } else {
        title.trim().to_string()
    };
    ExportConversation {
        id,
        title,
        messages,
        truncated,
        superseded,
    }
}

fn epoch_seconds_to_ms(value: Option<&Value>) -> Option<i64> {
    let seconds = value?.as_f64()?;
    (seconds.is_finite() && seconds > 0.0).then(|| (seconds * 1000.0) as i64)
}

fn iso_to_ms(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// The visible ChatGPT thread: `current_node` up to the root, reversed.
pub fn parse_chatgpt(raw: &Value) -> Option<ExportConversation> {
    let id = raw
        .get("conversation_id")
        .or_else(|| raw.get("id"))
        .and_then(Value::as_str)?
        .to_string();
    let mapping = raw.get("mapping")?.as_object()?;
    let mut node_id = raw
        .get("current_node")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            // No current_node: follow first children from the root.
            let root = mapping
                .values()
                .find(|n| n.get("parent").map_or(true, Value::is_null))?;
            let mut node = root;
            loop {
                let next = node
                    .get("children")
                    .and_then(Value::as_array)
                    .and_then(|c| c.last())
                    .and_then(Value::as_str)
                    .and_then(|child| mapping.get(child));
                match next {
                    Some(child) => node = child,
                    None => break,
                }
            }
            node.get("id").and_then(Value::as_str).map(str::to_string)
        });
    let mut chain = Vec::new();
    let mut on_branch = HashSet::new();
    let mut guard = 0usize;
    while let Some(current) = node_id.take() {
        guard += 1;
        if guard > mapping.len() + 1 {
            break;
        }
        let Some(node) = mapping.get(&current) else {
            break;
        };
        if let Some(message) = node.get("message").filter(|m| !m.is_null()) {
            chain.push(message);
        }
        node_id = node
            .get("parent")
            .and_then(Value::as_str)
            .map(str::to_string);
        on_branch.insert(current);
    }
    chain.reverse();
    let messages = chain.into_iter().filter_map(chatgpt_message).collect();
    // Messages on branches the user has left (an edited prompt, a regenerated
    // reply). They are not imported; see `ExportConversation::superseded`.
    let superseded = mapping
        .iter()
        .filter(|(id, _)| !on_branch.contains(id.as_str()))
        .filter_map(|(_, node)| node.get("message").filter(|m| !m.is_null()))
        .filter_map(chatgpt_message)
        .map(|message| {
            (
                message_key(&message.role, &message.content),
                message.created_at,
            )
        })
        .collect();
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(finish(id, title, messages, superseded))
}

/// One visible user or assistant message of a ChatGPT export, as imported.
fn chatgpt_message(message: &Value) -> Option<ImportedMessage> {
    let role = message
        .pointer("/author/role")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hidden = message
        .pointer("/metadata/is_visually_hidden_from_conversation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || message.get("weight").and_then(Value::as_f64) == Some(0.0);
    if hidden || !matches!(role, "user" | "assistant") {
        return None;
    }
    let text = chatgpt_content_text(message.get("content"))?;
    Some(ImportedMessage {
        role: role.to_string(),
        content: clamp(&text),
        created_at: epoch_seconds_to_ms(message.get("create_time")),
    })
}

/// Readable text for one ChatGPT message content object. Reasoning and
/// context records return `None`; images and files become placeholders.
fn chatgpt_content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    let kind = content
        .get("content_type")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let text = match kind {
        "text" | "multimodal_text" => {
            let parts = content.get("parts").and_then(Value::as_array)?;
            parts
                .iter()
                .filter_map(|part| match part {
                    Value::String(s) => Some(s.clone()),
                    Value::Object(obj) => match obj.get("content_type").and_then(Value::as_str) {
                        Some("image_asset_pointer") => Some("[image]".to_string()),
                        Some("audio_transcription") => {
                            obj.get("text").and_then(Value::as_str).map(str::to_string)
                        }
                        Some(
                            "audio_asset_pointer" | "real_time_user_audio_video_asset_pointer",
                        ) => None,
                        _ => obj.get("text").and_then(Value::as_str).map(str::to_string),
                    },
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        "code" => {
            let language = content
                .get("language")
                .and_then(Value::as_str)
                .filter(|l| *l != "unknown")
                .unwrap_or("");
            let body = content.get("text").and_then(Value::as_str)?;
            format!("```{language}\n{body}\n```")
        }
        "tether_quote" => {
            let title = content
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Quote");
            let body = content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("> {title}\n> {body}")
        }
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn parse_claude(raw: &Value) -> Option<ExportConversation> {
    let id = raw.get("uuid").and_then(Value::as_str)?.to_string();
    let mut messages = Vec::new();
    for message in raw.get("chat_messages").and_then(Value::as_array)? {
        let role = match message.get("sender").and_then(Value::as_str) {
            Some("human") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let mut text = message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                        Some("text") => block
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        Some("tool_use") => block
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| format!("[used {name}]")),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .filter(|text| !text.trim().is_empty())
            .or_else(|| {
                message
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        for list in ["attachments", "files"] {
            for file in message
                .get(list)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = file.get("file_name").and_then(Value::as_str) {
                    text.push_str(&format!("\n\n[attached: {name}]"));
                }
            }
        }
        if text.trim().is_empty() {
            continue;
        }
        messages.push(ImportedMessage {
            role: role.to_string(),
            content: clamp(&text),
            created_at: iso_to_ms(message.get("created_at")),
        });
    }
    let title = raw
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(finish(id, title, messages, Vec::new()))
}

// ---------------------------------------------------------------------------
// Saved context (ChatGPT custom instructions, Claude memory)
// ---------------------------------------------------------------------------

/// Saved context as `(text, is_about_the_user)` entries, newest first and
/// deduplicated. ChatGPT: the latest custom instructions found in any
/// conversation. Claude: `memories.json` text.
pub fn saved_context(root: &Path, source: ExportSource) -> Vec<(String, bool)> {
    match source {
        ExportSource::ChatGpt => chatgpt_custom_instructions(root),
        ExportSource::Claude => claude_memories(root),
    }
}

fn chatgpt_custom_instructions(root: &Path) -> Vec<(String, bool)> {
    conversations(root)
        .map(|raw| chatgpt_custom_instructions_in(&raw))
        .unwrap_or_default()
}

fn chatgpt_custom_instructions_in(raw: &[Value]) -> Vec<(String, bool)> {
    let mut latest: Option<(f64, String, String)> = None;
    for conversation in raw {
        let updated = conversation
            .get("update_time")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if latest.as_ref().is_some_and(|(t, _, _)| *t >= updated) {
            continue;
        }
        let Some(mapping) = conversation.get("mapping").and_then(Value::as_object) else {
            continue;
        };
        for node in mapping.values() {
            // Newer exports: a hidden system message carrying
            // `user_context_message_data`.
            if let Some(data) = node.pointer("/message/metadata/user_context_message_data") {
                let field = |key: &str| {
                    data.get(key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or_default()
                        .to_string()
                };
                let profile = field("about_user_message");
                let instructions = field("about_model_message");
                if !profile.is_empty() || !instructions.is_empty() {
                    latest = Some((updated, profile, instructions));
                    break;
                }
            }
            let Some(content) = node.pointer("/message/content") else {
                continue;
            };
            if content.get("content_type").and_then(Value::as_str) != Some("user_editable_context")
            {
                continue;
            }
            let field = |key: &str| {
                content
                    .get(key)
                    .and_then(Value::as_str)
                    .map(strip_custom_instruction_preamble)
                    .unwrap_or_default()
            };
            let profile = field("user_profile");
            let instructions = field("user_instructions");
            if !profile.is_empty() || !instructions.is_empty() {
                latest = Some((updated, profile, instructions));
                break;
            }
        }
    }
    let Some((_, profile, instructions)) = latest else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if !profile.is_empty() {
        out.push((profile, true));
    }
    if !instructions.is_empty() {
        out.push((
            format!("How the user wants responses: {instructions}"),
            false,
        ));
    }
    out
}

/// ChatGPT wraps custom instructions in a fixed preamble; keep the user's text.
fn strip_custom_instruction_preamble(text: &str) -> String {
    let text = text.trim();
    let body = text
        .split_once("```")
        .and_then(|(_, rest)| rest.rsplit_once("```").map(|(inner, _)| inner))
        .unwrap_or(text);
    body.trim().to_string()
}

/// JSON records from every `*.json` file in `dir` (each file an object or a
/// list of objects), in file-name order.
fn json_records(dir: &Path) -> Vec<Value> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    files.sort();
    let mut records = Vec::new();
    for file in files {
        match read_json(&file, MAX_SIDE_FILE_BYTES) {
            Ok(Value::Array(list)) => records.extend(list),
            Ok(record @ Value::Object(_)) => records.push(record),
            _ => {}
        }
    }
    records
}

/// Every memory record in a Claude export: `memories.json` and/or
/// `memories/<uuid>.json`.
fn claude_memory_records(root: &Path) -> Vec<Value> {
    let mut records = Vec::new();
    match read_json(&root.join("memories.json"), MAX_SIDE_FILE_BYTES) {
        Ok(Value::Array(list)) => records.extend(list),
        Ok(record @ Value::Object(_)) => records.push(record),
        _ => {}
    }
    records.extend(json_records(&root.join("memories")));
    records
}

/// Claude project memory text keyed by project id: `project_memories` plus
/// `memory_files` stored under `/projects/<id>/`.
fn claude_project_memories(root: &Path) -> BTreeMap<String, String> {
    let mut parts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for record in claude_memory_records(root) {
        if let Some(map) = record.get("project_memories").and_then(Value::as_object) {
            for (id, text) in map {
                if let Some(text) = text.as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    parts.entry(id.clone()).or_default().push(text.to_string());
                }
            }
        }
        for file in record
            .get("memory_files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let path = file.get("path").and_then(Value::as_str).unwrap_or_default();
            let Some(id) = path
                .strip_prefix("/projects/")
                .and_then(|rest| rest.split('/').next())
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if let Some(text) = file.get("content").and_then(Value::as_str).map(str::trim) {
                if !text.is_empty() {
                    parts
                        .entry(id.to_string())
                        .or_default()
                        .push(text.to_string());
                }
            }
        }
    }
    parts
        .into_iter()
        .map(|(id, texts)| (id, texts.join("\n\n")))
        .collect()
}

fn claude_memories(root: &Path) -> Vec<(String, bool)> {
    let mut texts = Vec::new();
    for record in claude_memory_records(root) {
        let known = ["conversations_memory", "memory_files", "project_memories"]
            .iter()
            .any(|key| record.get(*key).is_some());
        if !known {
            // Unknown shape: fall back to every string field.
            collect_strings(&record, &mut texts, 0);
            continue;
        }
        if let Some(text) = record.get("conversations_memory").and_then(Value::as_str) {
            texts.push(text.to_string());
        }
        for file in record
            .get("memory_files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let path = file.get("path").and_then(Value::as_str).unwrap_or_default();
            if path.starts_with("/projects/") {
                continue;
            }
            if let Some(text) = file.get("content").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
        }
    }
    let mut out: Vec<(String, bool)> = Vec::new();
    for text in texts {
        for entry in super::frameworks::split_memory_text(&text) {
            if !out.iter().any(|(existing, _)| *existing == entry) {
                out.push((entry, false));
            }
        }
    }
    out
}

/// Gather memory text from any JSON shape, skipping ids and timestamps.
fn collect_strings(value: &Value, out: &mut Vec<String>, depth: usize) {
    if depth > 6 {
        return;
    }
    match value {
        Value::String(s) if s.trim().len() > 12 && !s.contains("T00:") => out.push(s.clone()),
        Value::Array(items) => items
            .iter()
            .for_each(|v| collect_strings(v, out, depth + 1)),
        Value::Object(map) => {
            for (key, v) in map {
                if key.contains("uuid") || key.ends_with("_at") || key == "id" {
                    continue;
                }
                collect_strings(v, out, depth + 1);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Project folders
// ---------------------------------------------------------------------------

/// Marker recording which export project a folder was created for, so a
/// re-import reuses it and never writes into an unrelated folder. It also
/// records a hash of each file the import wrote, so a re-import can tell a
/// file the user has edited from one it may refresh.
const MARKER: &str = ".ryu-import.json";

/// A project folder an import created or reused.
#[derive(Debug, Clone)]
pub struct ProjectFolder {
    pub path: PathBuf,
    /// Files (relative to `path`) the user edited after an earlier import,
    /// left as they are instead of being replaced with the export's version.
    pub kept: Vec<String>,
}

fn safe_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ', '-']).to_string();
    if cleaned.is_empty() {
        "Imported project".to_string()
    } else {
        cleaned.chars().take(80).collect()
    }
}

/// Create (or reuse) `<base>/<project name>` for an imported project, writing
/// its instructions to `AGENTS.md` (Ryu applies it to every chat in the
/// folder) and its knowledge docs as files. A re-import refreshes those files
/// only where the user has not edited them since the last import.
pub fn ensure_project_folder(
    base: &Path,
    source: ExportSource,
    project: &ExportProject,
) -> Result<ProjectFolder> {
    fs::create_dir_all(base)?;
    let owner = |files: &serde_json::Map<String, Value>| serde_json::json!({ "source": source.id(), "projectId": project.id, "files": files });
    let name = safe_file_name(&project.name);
    let mut folder = base.join(&name);
    let mut attempt = 1;
    let mut previous = serde_json::Map::new();
    loop {
        let marker_path = folder.join(MARKER);
        if !folder.exists() {
            fs::create_dir_all(&folder)?;
            break;
        }
        let existing = fs::read_to_string(&marker_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let owned = existing.as_ref().is_some_and(|existing| {
            existing.get("source").and_then(Value::as_str) == Some(source.id())
                && existing.get("projectId").and_then(Value::as_str) == Some(project.id.as_str())
        });
        if owned {
            if let Some(files) = existing
                .as_ref()
                .and_then(|existing| existing.get("files"))
                .and_then(Value::as_object)
            {
                previous = files.clone();
            }
            break;
        }
        attempt += 1;
        folder = base.join(format!("{name} ({} {attempt})", source.label()));
        if attempt > 50 {
            bail!(
                "could not find a free folder name for project {:?}",
                project.name
            );
        }
    }
    // Claim the folder before writing into it.
    write_new(
        &folder.join(MARKER),
        &serde_json::to_vec_pretty(&owner(&previous))?,
    )?;
    let mut written = serde_json::Map::new();
    let mut kept = Vec::new();
    let mut agents = format!(
        "# {}\n\nImported from {}.\n",
        project.name.trim(),
        source.label()
    );
    if !project.description.is_empty() {
        agents.push_str(&format!("\n{}\n", project.description));
    }
    if !project.instructions.is_empty() {
        agents.push_str(&format!(
            "\n## Project instructions\n\n{}\n",
            project.instructions
        ));
    }
    if !project.memory.is_empty() {
        agents.push_str(&format!("\n## Project memory\n\n{}\n", project.memory));
    }
    if !project.docs.is_empty() {
        agents.push_str("\n## Knowledge files\n\n");
        for (name, _) in &project.docs {
            agents.push_str(&format!("- `knowledge/{}`\n", safe_file_name(name)));
        }
    }
    let mut managed = |relative: String, bytes: &[u8]| -> Result<()> {
        let recorded = previous.get(&relative).and_then(Value::as_str);
        match write_managed(&folder, &relative, bytes, recorded)? {
            Managed::Written(hash) => {
                written.insert(relative, Value::String(hash));
            }
            Managed::Kept => {
                if let Some(hash) = recorded {
                    written.insert(relative.clone(), Value::String(hash.to_string()));
                }
                kept.push(relative);
            }
        }
        Ok(())
    };
    managed("AGENTS.md".to_string(), agents.as_bytes())?;
    if !project.docs.is_empty() {
        fs::create_dir_all(folder.join("knowledge"))?;
        for (name, content) in &project.docs {
            let mut bytes = content.as_bytes();
            if bytes.len() > MAX_DOC_BYTES {
                bytes = &bytes[..MAX_DOC_BYTES];
            }
            managed(format!("knowledge/{}", safe_file_name(name)), bytes)?;
        }
    }
    write_new(
        &folder.join(MARKER),
        &serde_json::to_vec_pretty(&owner(&written))?,
    )?;
    Ok(ProjectFolder { path: folder, kept })
}

enum Managed {
    /// The file now holds the import's content, whose hash is recorded.
    Written(String),
    /// The user changed the file after the last import; it was left alone.
    Kept,
}

/// Write one import-managed file unless the user has changed it: a file is
/// replaced only when it is missing, already identical, or still exactly what
/// the last import wrote (`recorded` hash). An existing file with no recorded
/// hash is treated as the user's and kept.
fn write_managed(
    folder: &Path,
    relative: &str,
    bytes: &[u8],
    recorded: Option<&str>,
) -> Result<Managed> {
    let path = folder.join(relative);
    let hash = bytes_sha256(bytes);
    match fs::read(&path) {
        Ok(current) => {
            let current = bytes_sha256(&current);
            if current == hash {
                return Ok(Managed::Written(hash));
            }
            if recorded != Some(current.as_str()) {
                return Ok(Managed::Kept);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("reading {}", path.display()));
        }
    }
    write_new(&path, bytes)?;
    Ok(Managed::Written(hash))
}

fn bytes_sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

/// Atomic write: temp file in the same folder, then rename.
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Default parent folder for imported projects: `~/Documents/Ryu`.
pub fn default_projects_base() -> Option<PathBuf> {
    dirs::document_dir().map(|docs| docs.join("Ryu"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_tree() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ryu-chat-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn chatgpt_conversation(id: &str, gizmo: Option<&str>, updated: f64) -> Value {
        json!({
            "title": format!("Chat {id}"),
            "create_time": 1_700_000_000.0,
            "update_time": updated,
            "conversation_id": id,
            "gizmo_id": gizmo,
            "current_node": "a2",
            "mapping": {
                "root": { "id": "root", "message": null, "parent": null, "children": ["sys"] },
                "sys": { "id": "sys", "parent": "root", "children": ["u1"], "message": {
                    "author": { "role": "system" },
                    "content": { "content_type": "user_editable_context",
                        "user_profile": "The user provided the following information about themselves. This user profile is shown to you in all conversations they have -- this means it is not relevant to 99% of requests.\n```I am a Rust developer in Lisbon.```",
                        "user_instructions": "The user provided the additional info about how they would like you to respond:\n```Be concise.```" },
                    "metadata": { "is_visually_hidden_from_conversation": true } } },
                "u1": { "id": "u1", "parent": "sys", "children": ["a1"], "message": {
                    "author": { "role": "user" }, "create_time": 1_700_000_001.0,
                    "content": { "content_type": "multimodal_text", "parts": [
                        { "content_type": "image_asset_pointer", "asset_pointer": "file-service://x" }, "What is this?" ] } } },
                "a1": { "id": "a1", "parent": "u1", "children": ["a2", "a1b"], "message": {
                    "author": { "role": "assistant" }, "create_time": 1_700_000_002.0,
                    "content": { "content_type": "thoughts", "thoughts": [] } } },
                "a1b": { "id": "a1b", "parent": "a1", "children": [], "message": {
                    "author": { "role": "assistant" }, "content": { "content_type": "text", "parts": ["abandoned branch"] } } },
                "a2": { "id": "a2", "parent": "a1", "children": [], "message": {
                    "author": { "role": "assistant" }, "create_time": 1_700_000_003.0,
                    "content": { "content_type": "text", "parts": ["It is a cat."] } } }
            }
        })
    }

    #[test]
    fn chatgpt_export_groups_projects_and_walks_the_visible_branch() {
        let root = temp_tree();
        let export = json!([
            chatgpt_conversation("c1", None, 10.0),
            chatgpt_conversation("c2", Some("g-p-abcdef123456"), 20.0),
            chatgpt_conversation("c3", Some("g-p-abcdef123456"), 5.0),
            chatgpt_conversation("c4", Some("g-abc"), 1.0),
        ]);
        fs::write(root.join("conversations.json"), export.to_string()).unwrap();
        assert_eq!(detect(&root), Some(ExportSource::ChatGpt));

        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(scan.source, Some("chatgpt"));
        let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
        assert!(
            ids.contains(&"conversations/conversations.json#chats"),
            "{ids:?}"
        );
        assert!(
            ids.contains(&"conversations/conversations.json#g-p-abcdef123456"),
            "{ids:?}"
        );
        assert!(
            ids.contains(&"memory/conversations.json#saved-context"),
            "{ids:?}"
        );
        let chats = scan
            .items
            .iter()
            .find(|i| i.id.ends_with("#chats"))
            .unwrap();
        assert_eq!(chats.title, "ChatGPT chats (2)");

        let group = read_group(&root, ExportSource::ChatGpt, UNGROUPED).unwrap();
        assert_eq!(group.len(), 2);
        let first = &group[0];
        assert_eq!(first.messages.len(), 2);
        assert_eq!(first.messages[0].role, "user");
        assert_eq!(first.messages[0].content, "[image]\n\nWhat is this?");
        assert_eq!(first.messages[0].created_at, Some(1_700_000_001_000));
        assert_eq!(first.messages[1].content, "It is a cat.");

        let context = saved_context(&root, ExportSource::ChatGpt);
        assert_eq!(
            context[0],
            ("I am a Rust developer in Lisbon.".to_string(), true)
        );
        assert_eq!(context[1].0, "How the user wants responses: Be concise.");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_export_reads_projects_docs_memories_and_messages() {
        let root = temp_tree();
        let export = json!([
            { "uuid": "conv-1", "name": "Plan the launch", "created_at": "2026-01-02T03:04:05Z",
              "chat_messages": [
                { "uuid": "m1", "sender": "human", "text": "Help me plan", "created_at": "2026-01-02T03:04:05Z",
                  "content": [{ "type": "text", "text": "Help me plan" }],
                  "attachments": [{ "file_name": "brief.pdf", "extracted_content": "..." }] },
                { "uuid": "m2", "sender": "assistant", "text": "", "created_at": "2026-01-02T03:04:09.500Z",
                  "content": [{ "type": "text", "text": "Here is a plan." }, { "type": "tool_use", "name": "web_search" }] }
              ] },
            { "uuid": "conv-2", "name": "Project chat", "project_uuid": "proj-1",
              "chat_messages": [{ "sender": "human", "text": "Hi", "content": [] }] }
        ]);
        fs::write(root.join("conversations.json"), export.to_string()).unwrap();
        fs::write(
            root.join("projects.json"),
            json!([
                { "uuid": "proj-1", "name": "Research / Notes", "description": "Papers",
                  "prompt_template": "Cite sources.", "docs": [{ "filename": "reading.md", "content": "# List" }] },
                { "uuid": "proj-2", "name": "Empty", "prompt_template": "", "docs": [] }
            ])
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("memories.json"),
            json!([{ "conversations_memory": "- Works at Acme\n- Prefers tables", "account_uuid": "x",
                     "project_memories": { "proj-1": "Focus on 2025 papers." } }]).to_string(),
        )
        .unwrap();
        assert_eq!(detect(&root), Some(ExportSource::Claude));
        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(scan.source, Some("claude-ai"));
        let titles: Vec<&str> = scan.items.iter().map(|i| i.title.as_str()).collect();
        assert!(titles.contains(&"Claude chats (1)"), "{titles:?}");
        assert!(
            titles.contains(&"Claude project 'Research / Notes' (1 chat)"),
            "{titles:?}"
        );
        assert!(titles.contains(&"Claude project 'Empty'"), "{titles:?}");
        assert!(titles.contains(&"Claude memory"), "{titles:?}");

        let chats = read_group(&root, ExportSource::Claude, UNGROUPED).unwrap();
        assert_eq!(
            chats[0].messages[0].content,
            "Help me plan\n\n[attached: brief.pdf]"
        );
        assert_eq!(
            chats[0].messages[1].content,
            "Here is a plan.\n\n[used web_search]"
        );
        assert_eq!(chats[0].messages[1].created_at, Some(1_767_323_049_500));

        let memories = saved_context(&root, ExportSource::Claude);
        assert_eq!(
            memories.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(),
            vec!["Works at Acme", "Prefers tables"]
        );

        let base = root.join("out");
        let project = project_for(&root, ExportSource::Claude, "proj-1").unwrap();
        let folder = ensure_project_folder(&base, ExportSource::Claude, &project)
            .unwrap()
            .path;
        assert_eq!(folder, base.join("Research - Notes"));
        let agents = fs::read_to_string(folder.join("AGENTS.md")).unwrap();
        assert!(agents.contains("Cite sources.") && agents.contains("knowledge/reading.md"));
        assert!(agents.contains("## Project memory") && agents.contains("Focus on 2025 papers."));
        assert_eq!(
            fs::read_to_string(folder.join("knowledge/reading.md")).unwrap(),
            "# List"
        );
        // Re-import reuses the owned folder; an unrelated same-name folder is never touched.
        assert_eq!(
            ensure_project_folder(&base, ExportSource::Claude, &project)
                .unwrap()
                .path,
            folder
        );
        fs::create_dir_all(base.join("Empty")).unwrap();
        let empty = project_for(&root, ExportSource::Claude, "proj-2").unwrap();
        let other = ensure_project_folder(&base, ExportSource::Claude, &empty)
            .unwrap()
            .path;
        assert_eq!(other, base.join("Empty (Claude 2)"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reimport_refreshes_unedited_project_files_and_keeps_user_edits() {
        let base = temp_tree();
        let mut project = ExportProject {
            id: "proj-1".to_string(),
            name: "Research".to_string(),
            instructions: "Cite sources.".to_string(),
            docs: vec![("reading.md".to_string(), "# List".to_string())],
            ..ExportProject::default()
        };
        let first = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
        assert!(first.kept.is_empty());
        let folder = first.path;

        // Untouched since the last import: a newer export refreshes it.
        project.instructions = "Cite primary sources.".to_string();
        let again = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
        assert_eq!(again.path, folder);
        assert!(again.kept.is_empty());
        let agents = fs::read_to_string(folder.join("AGENTS.md")).unwrap();
        assert!(agents.contains("Cite primary sources."), "{agents}");

        // Edited by the user: later imports leave it, even with no changes.
        fs::write(folder.join("AGENTS.md"), "# My own guidance\n").unwrap();
        fs::write(folder.join("knowledge/reading.md"), "# My notes").unwrap();
        for instructions in ["Cite primary sources.", "Cite everything."] {
            project.instructions = instructions.to_string();
            let reimport = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
            assert_eq!(reimport.path, folder);
            assert_eq!(reimport.kept, vec!["AGENTS.md", "knowledge/reading.md"]);
            assert_eq!(
                fs::read_to_string(folder.join("AGENTS.md")).unwrap(),
                "# My own guidance\n"
            );
            assert_eq!(
                fs::read_to_string(folder.join("knowledge/reading.md")).unwrap(),
                "# My notes"
            );
        }

        // Deleted by the user: the next import writes it again.
        fs::remove_file(folder.join("AGENTS.md")).unwrap();
        let restored = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
        assert_eq!(restored.kept, vec!["knowledge/reading.md"]);
        assert!(fs::read_to_string(folder.join("AGENTS.md"))
            .unwrap()
            .contains("Cite everything."));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn split_chatgpt_export_names_an_existing_saved_context_file() {
        let root = temp_tree();
        fs::write(
            root.join("conversations-000.json"),
            json!([chatgpt_conversation("c1", None, 10.0)]).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("conversations-001.json"),
            json!([chatgpt_conversation("c2", Some("g-p-abcdef123456"), 20.0)]).to_string(),
        )
        .unwrap();
        assert_eq!(detect(&root), Some(ExportSource::ChatGpt));
        let scan = super::super::scan_source(&root).unwrap();
        let saved = scan
            .items
            .iter()
            .find(|item| item.kind == kind::MEMORY)
            .expect("custom instructions are offered");
        assert_eq!(saved.id, "memory/conversations-000.json#saved-context");
        assert!(super::super::resolve_item_path(&root, &saved.id).is_ok());

        // Both groups come from one pass over both parts.
        let groups = BTreeSet::from([UNGROUPED.to_string(), "g-p-abcdef123456".to_string()]);
        let read = read_groups(&root, ExportSource::ChatGpt, &groups).unwrap();
        assert_eq!(read[UNGROUPED][0].id, "c1");
        assert_eq!(read["g-p-abcdef123456"][0].id, "c2");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn split_export_size_limit_covers_all_parts_together() {
        let root = temp_tree();
        // Each part is under the limit on its own; together they are over it.
        // Sparse files: nothing is read because the total is checked first.
        for part in ["conversations-000.json", "conversations-001.json"] {
            let file = fs::File::create(root.join(part)).unwrap();
            file.set_len(MAX_EXPORT_BYTES / 2 + 1).unwrap();
        }
        let error = conversations(&root).unwrap_err().to_string();
        assert!(error.contains("conversation files total"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chatgpt_records_messages_on_branches_the_user_left() {
        let conversation = parse_chatgpt(&chatgpt_conversation("c1", None, 10.0)).unwrap();
        assert_eq!(conversation.messages.len(), 2);
        assert!(conversation.is_superseded("assistant", "abandoned branch", 123));
        assert!(!conversation.is_superseded("assistant", "It is a cat.", 1_700_000_003_000));
        assert!(!conversation.is_superseded("user", "abandoned branch", 123));
    }

    #[test]
    fn unrelated_conversations_json_is_not_an_export() {
        let root = temp_tree();
        fs::write(root.join("conversations.json"), r#"{"conversations": []}"#).unwrap();
        assert_eq!(detect(&root), None);
        let _ = fs::remove_dir_all(&root);
    }
}
