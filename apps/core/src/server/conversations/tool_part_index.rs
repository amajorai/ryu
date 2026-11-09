//! Tool calls in the keyword (FTS) index.
//!
//! The transcript is the ground truth of what the agent did, and much of that
//! lives in an assistant turn's tool-call parts (sealed in `messages.parts`), not
//! in its plain `content`. Each tool part is rendered as bounded text, the tool
//! id followed by the scalar leaves of its arguments and result, and indexed
//! under the message's own id and conversation, so every tenancy filter that
//! scopes message search applies to it unchanged.
//!
//! Bounds and safety:
//! - at most [`TOOL_PARTS_PER_MESSAGE`] tool parts per message, each kept to
//!   [`TOOL_PART_TEXT_CAP`] bytes;
//! - attachments (image, audio, video and file objects), `data:` URIs and long
//!   encoded blobs are skipped;
//! - Core's locked export redaction (the one tool content gets before it leaves
//!   in traces, history exports and crash reports) replaces recognized secrets
//!   and PII before anything is tokenized. A cut never keeps a partial word, so
//!   a secret split by the cap cannot survive as a fragment the scanner missed.
//!   It runs per leaf, and a value under a credential key (`password`,
//!   `client_secret`, …) is replaced whole, however many words it holds.

use std::collections::HashMap;

use serde_json::Value;

use super::*;
use crate::server::conversation_history::redaction::{redact_text, RedactionCounts};

/// Rendered text kept per tool part, in bytes.
pub(crate) const TOOL_PART_TEXT_CAP: usize = 1536;
/// Tool parts rendered per message; later ones are not indexed.
pub(crate) const TOOL_PARTS_PER_MESSAGE: usize = 32;
/// Raw argument/result text read per part before redaction. Bounds the
/// scanner's work on a large result while leaving room for placeholders that
/// are shorter than what they replace.
const RAW_SCAN_CAP: usize = TOOL_PART_TEXT_CAP * 4;
/// Longest tool id kept, in bytes.
const TOOL_ID_CAP: usize = 128;
/// A string at least this long with only base64/hex characters is an encoded
/// blob, not text.
const BLOB_MIN_BYTES: usize = 200;
/// Nesting depth walked in arguments and results.
const MAX_DEPTH: usize = 8;
/// Object `type` values that mark an attachment rather than text.
const ATTACHMENT_TYPES: &[&str] = &["image", "audio", "video", "file", "blob"];
/// Name of the one-time re-index that adds tool text to rows indexed before.
const TOOL_PARTS_REINDEX: &str = "fts-tool-parts-v1";

/// The searchable text of a message's parts: one line per tool part (tool id,
/// then its redacted argument and result text). Empty when there is none.
pub(crate) fn tool_parts_search_text(parts: &Value) -> String {
    let Some(parts) = parts.as_array() else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|part| tool_id(part).map(|id| render_tool_part(id, part)))
        .take(TOOL_PARTS_PER_MESSAGE)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The tool id of a reduced UIMessage tool part (`tool-<name>` or
/// `dynamic-tool` with `toolName`); `None` for text, data and file parts.
fn tool_id(part: &Value) -> Option<&str> {
    let kind = part.get("type")?.as_str()?;
    let id = if kind == "dynamic-tool" {
        part.get("toolName")?.as_str()?
    } else {
        // A stored tool part always carries its call id; this also keeps
        // stream frame names (`tool-input-available`) out.
        part.get("toolCallId")?;
        kind.strip_prefix("tool-")?
    };
    let id = id.trim();
    (!id.is_empty()).then_some(id)
}

fn render_tool_part(tool_id: &str, part: &Value) -> String {
    let mut leaves = Leaves::default();
    for key in ["input", "output", "errorText"] {
        if let Some(value) = part.get(key) {
            leaves.walk(value, None, 0);
        }
    }
    let mut text = String::from(&tool_id[..floor_char_boundary(tool_id, TOOL_ID_CAP)]);
    if !leaves.text.trim().is_empty() {
        text.push(' ');
        text.push_str(leaves.text.trim());
    }
    cut_to_whole_words(&mut text, TOOL_PART_TEXT_CAP);
    text
}

/// Redacted scalar leaves of a JSON value as `key: value` text, read up to
/// [`RAW_SCAN_CAP`] raw bytes.
///
/// Each leaf is redacted on its own, while its value is still whole: flattened
/// to unquoted text, a credential value would lose the quotes that bound it,
/// and the scanner would stop at its first word. A value under a credential
/// key (decided by the export scanner itself, see [`is_credential_key`]) is
/// replaced whole, so no word of it reaches the index or a snippet.
#[derive(Default)]
struct Leaves {
    text: String,
    /// Raw leaf bytes read so far.
    read: usize,
    /// A leaf did not fit: nothing more is read.
    full: bool,
    /// [`is_credential_key`] per key already seen in this part.
    credential_keys: HashMap<String, bool>,
}

impl Leaves {
    fn walk(&mut self, value: &Value, key: Option<&str>, depth: usize) {
        if self.full || depth > MAX_DEPTH {
            return;
        }
        match value {
            Value::Null => {}
            Value::Bool(_) | Value::Number(_) => self.push(key, &value.to_string()),
            Value::String(text) if !is_blob(text) => self.push(key, text),
            Value::String(_) => {}
            Value::Array(items) => {
                for item in items {
                    self.walk(item, key, depth + 1);
                }
            }
            Value::Object(map) => {
                let kind = map.get("type").and_then(Value::as_str);
                if kind.is_some_and(|kind| ATTACHMENT_TYPES.contains(&kind)) {
                    return;
                }
                for (name, item) in map {
                    self.walk(item, Some(name), depth + 1);
                }
            }
        }
    }

    fn push(&mut self, key: Option<&str>, value: &str) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        let mut leaf = match key {
            Some(key) => format!("{key}: {value}"),
            None => value.to_owned(),
        };
        let room = RAW_SCAN_CAP.saturating_sub(self.read);
        if leaf.len() > room {
            // The cut word could be the head of a secret too short for the
            // scanner to recognize, so it goes too.
            leaf.truncate(floor_char_boundary(&leaf, room));
            drop_partial_word(&mut leaf);
            self.full = true;
        }
        self.read += leaf.len() + 1;
        if leaf.is_empty() {
            return;
        }
        // Only the text is kept; nothing reports how much was redacted.
        let mut counts = RedactionCounts::default();
        let redacted = match key {
            Some(key) if self.is_credential_key(key) => {
                format!(
                    "{}: {CREDENTIAL_PLACEHOLDER}",
                    redact_text(key, &mut counts)
                )
            }
            _ => redact_text(&leaf, &mut counts),
        };
        if !self.text.is_empty() {
            self.text.push(' ');
        }
        self.text.push_str(&redacted);
    }

    fn is_credential_key(&mut self, key: &str) -> bool {
        if let Some(known) = self.credential_keys.get(key) {
            return *known;
        }
        let credential = is_credential_key(key);
        self.credential_keys.insert(key.to_owned(), credential);
        credential
    }
}

/// What a value under a credential key is indexed as.
const CREDENTIAL_PLACEHOLDER: &str = "[REDACTED:CREDENTIAL]";

/// Whether the export scanner treats any value under `key` as a secret: the
/// key with an empty JSON string value, the shape it redacts in raw tool JSON.
fn is_credential_key(key: &str) -> bool {
    let Ok(quoted) = serde_json::to_string(key) else {
        return false;
    };
    let mut counts = RedactionCounts::default();
    redact_text(&format!("{quoted}: \"\""), &mut counts);
    counts.secrets > 0
}

/// Whether a string is binary carried as text (a `data:` URI or a long run of
/// base64/hex characters), which has no words worth indexing.
fn is_blob(text: &str) -> bool {
    if text.trim_start().starts_with("data:") {
        return true;
    }
    text.len() >= BLOB_MIN_BYTES
        && text.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

/// Cut `text` to at most `cap` bytes, dropping the word the cap falls in.
fn cut_to_whole_words(text: &mut String, cap: usize) {
    if text.len() <= cap {
        return;
    }
    text.truncate(floor_char_boundary(text, cap + 1));
    drop_partial_word(text);
}

/// Drop the last (possibly cut) word, and everything when there is no
/// whitespace to cut at.
fn drop_partial_word(text: &mut String) {
    let keep = text.rfind(char::is_whitespace).unwrap_or(0);
    text.truncate(keep);
    let trimmed = text.trim_end().len();
    text.truncate(trimmed);
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut end = index;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// The text the keyword index holds for a message: its content, then its tool
/// text.
pub(super) fn keyword_index_text(content: String, tool_text: &str) -> String {
    match (content.trim().is_empty(), tool_text.is_empty()) {
        (_, true) => content,
        (true, false) => tool_text.to_owned(),
        (false, false) => format!("{content}\n{tool_text}"),
    }
}

impl ConversationStore {
    /// The redacted tool text of a sealed `parts` value. Empty when there are no
    /// tool parts or the value does not open (never placeholder text).
    pub(super) fn tool_text_for_index(&self, sealed: Option<String>) -> String {
        self.open_parts(sealed)
            .map(|parts| tool_parts_search_text(&parts))
            .unwrap_or_default()
    }

    /// A keyword hit's snippet: the message content, with its tool text added
    /// when the content shares no term with the query (the match came from a
    /// tool call), so the reader sees why the message matched.
    pub(super) fn keyword_snippet(
        &self,
        query: &str,
        content: String,
        parts: Option<String>,
    ) -> String {
        let query_terms = ryu_crypto::tokenize_terms(query);
        let content_terms = ryu_crypto::tokenize_terms(&content);
        if query_terms
            .iter()
            .any(|term| content_terms.binary_search(term).is_ok())
        {
            return content;
        }
        keyword_index_text(content, &self.tool_text_for_index(parts))
    }

    /// Keep tool-call text in step with `parts`, and queue rows indexed before
    /// tool text was searchable for one keyword re-index (once per database).
    /// Only queue rows are written; the re-index runs lazily with the next
    /// exact search, like every other keyword backfill.
    pub(super) fn init_tool_part_search(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS message_search_parts_update
             AFTER UPDATE OF parts ON messages BEGIN
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id, dirty)
                 VALUES (1, NEW.id, 2);
             END;
             CREATE TABLE IF NOT EXISTS message_search_migrations (
                 name TEXT PRIMARY KEY,
                 applied_at INTEGER NOT NULL
             );",
        )
        .context("initializing tool-call keyword indexing")?;
        let applied = conn
            .query_row(
                "SELECT 1 FROM message_search_migrations WHERE name = ?1",
                [TOOL_PARTS_REINDEX],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if applied {
            return Ok(());
        }
        let tx = conn.unchecked_transaction()?;
        let queued = tx.execute(
            "INSERT OR REPLACE INTO message_search_pending(kind, message_id, dirty)
             SELECT 1, id, 2 FROM messages WHERE parts IS NOT NULL",
            [],
        )?;
        tx.execute(
            "INSERT INTO message_search_migrations(name, applied_at)
             VALUES (?1, strftime('%s', 'now'))",
            [TOOL_PARTS_REINDEX],
        )?;
        tx.commit()?;
        if queued > 0 {
            tracing::info!(
                queued,
                "keyword index: queued messages with tool calls for re-index"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tool_part_index_tests.rs"]
mod tests;
