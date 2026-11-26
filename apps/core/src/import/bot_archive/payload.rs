//! What a staged bot holds beside its persona: its files and its
//! conversations, read back for the import step.

use std::io::{self, Read};

use crate::import::chat_exports::ExportConversation;
use crate::import::kind;
use crate::native_history::ImportedMessage;

use super::*;

/// Conversation import origin. The same origin and conversation id resolve to
/// the same Ryu conversation, so a second import adds nothing.
pub const ORIGIN: &str = "import:grok-bot";
/// Id of the source, recorded in the project folder an import creates.
pub const SOURCE_ID: &str = "grok-bot";
/// Name of the source, as shown to the user.
pub const SOURCE_LABEL: &str = "Grok Bot";
/// Folder inside a bot's project folder that receives the bot's files.
pub const FILES_DIR: &str = "files";

/// A transcript entry of the zip, checked.
#[derive(Debug, Clone)]
pub(super) struct Transcript {
    pub title: String,
    pub messages: Vec<ImportedMessage>,
}

/// Read a transcript entry: `{ "title", "messages": [{ "role", "text", "at"? }] }`.
/// `role` is `user` or `assistant`; `at` is an RFC 3339 time or epoch seconds.
/// `None` when the bytes are not that shape or hold no message with text.
pub(super) fn parse_conversation(bytes: &[u8]) -> Option<Transcript> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let list = value.get("messages")?.as_array()?;
    let mut messages = Vec::new();
    for message in list {
        let role = match message.get("role").and_then(Value::as_str) {
            Some(role) if role.eq_ignore_ascii_case("user") => "user",
            Some(role) if role.eq_ignore_ascii_case("assistant") => "assistant",
            _ => continue,
        };
        let Some(text) = message.get("text").and_then(Value::as_str) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        messages.push(ImportedMessage {
            role: role.to_string(),
            content: text.trim().to_string(),
            created_at: message.get("at").and_then(time_ms),
        });
    }
    if messages.is_empty() {
        return None;
    }
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .map(|title| clean_line(title, 120))
        .unwrap_or_default();
    Some(Transcript { title, messages })
}

/// A message time as epoch milliseconds: an RFC 3339 string, or a number of
/// seconds (or of milliseconds, when it is too large to be seconds).
fn time_ms(value: &Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text.trim())
            .ok()
            .map(|time| time.timestamp_millis());
    }
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    Some(if number < 100_000_000_000.0 {
        (number * 1000.0) as i64
    } else {
        number as i64
    })
}

/// The scan item id of a bot's files and conversations.
pub fn bot_item_id(key: &str) -> String {
    format!("{}/bots/{key}", kind::CONVERSATIONS)
}

/// The bot key a `conversations/bots/<key>` item id names.
pub fn bot_key_of_item(id: &str) -> Option<&str> {
    id.strip_prefix(kind::CONVERSATIONS)?
        .strip_prefix("/bots/")
        .filter(|key| is_slug(key))
}

/// The bot `key` of the staging folder `root`.
pub fn staged_bot(root: &Path, key: &str) -> Option<BotSummary> {
    read_staged_summary(root)?
        .bots
        .into_iter()
        .find(|bot| bot.key == key)
}

fn payload_dir(root: &Path, key: &str) -> PathBuf {
    root.join("bots").join(key).join(PAYLOAD_DIR)
}

/// The bytes of a regular file no larger than `max`. A link is never followed.
fn read_regular(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    fs::read(path).ok()
}

/// Every conversation staged for the bot `key`, oldest first. The id of each
/// is `<key>/<entry name>`, so the same export imported twice matches itself.
pub fn read_bot_conversations(root: &Path, key: &str) -> Vec<ExportConversation> {
    let dir = payload_dir(root, key).join("conversations");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    names.truncate(MAX_CONVERSATIONS_PER_BOT);
    let mut out = Vec::new();
    for name in names {
        let Some(bytes) = read_regular(&dir.join(&name), MAX_CONVERSATION_ENTRY_BYTES) else {
            continue;
        };
        let Some(transcript) = parse_conversation(&bytes) else {
            continue;
        };
        let stem = name.trim_end_matches(".json");
        out.push(ExportConversation::linear(
            format!("{key}/{stem}"),
            transcript.title,
            transcript.messages,
        ));
    }
    out.sort_by_key(|conversation| {
        conversation
            .messages
            .first()
            .and_then(|message| message.created_at)
            .unwrap_or(0)
    });
    out
}

/// Every regular file staged under the bot's `files/`, as the path segments
/// below it, sorted. Links are never followed.
pub fn bot_files(root: &Path, key: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut prefix = Vec::new();
    walk_files(&payload_dir(root, key).join("files"), &mut prefix, &mut out);
    out
}

fn walk_files(dir: &Path, prefix: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
    if prefix.len() >= MAX_ENTRY_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_FILES_PER_BOT {
            return;
        }
        // `file_type` reports a link as a link, so a link is neither branch.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        prefix.push(name);
        if file_type.is_dir() {
            walk_files(&entry.path(), prefix, out);
        } else if file_type.is_file() {
            out.push(prefix.clone());
        }
        prefix.pop();
    }
}

/// What [`copy_bot_files`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopiedFiles {
    pub copied: usize,
    /// Already in the project folder with the same content.
    pub unchanged: usize,
    /// Paths (relative to the project folder) that exist there with other
    /// content. They are left as they are.
    pub kept: Vec<String>,
}

/// Copy the files staged for the bot `key` into `<folder>/files/`. A file
/// that is already there is never replaced.
pub fn copy_bot_files(root: &Path, key: &str, folder: &Path) -> io::Result<CopiedFiles> {
    let source = payload_dir(root, key).join("files");
    let mut result = CopiedFiles::default();
    for parts in bot_files(root, key) {
        let mut from = source.clone();
        from.extend(&parts);
        let mut to = folder.join(FILES_DIR);
        to.extend(&parts);
        if fs::symlink_metadata(&to).is_ok() {
            if same_content(&from, &to) {
                result.unchanged += 1;
            } else {
                result.kept.push(format!("{FILES_DIR}/{}", parts.join("/")));
            }
            continue;
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&from, &to)?;
        result.copied += 1;
    }
    Ok(result)
}

fn same_content(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (fs::metadata(a), fs::symlink_metadata(b)) else {
        return false;
    };
    if !meta_b.is_file() || meta_a.len() != meta_b.len() {
        return false;
    }
    let (Ok(mut file_a), Ok(mut file_b)) = (fs::File::open(a), fs::File::open(b)) else {
        return false;
    };
    let mut buffer_a = vec![0u8; 64 * 1024];
    let mut buffer_b = vec![0u8; 64 * 1024];
    loop {
        let Ok(read) = file_a.read(&mut buffer_a) else {
            return false;
        };
        if read == 0 {
            return true;
        }
        if file_b.read_exact(&mut buffer_b[..read]).is_err() || buffer_a[..read] != buffer_b[..read]
        {
            return false;
        }
    }
}

/// True when the skill at `dir` (a folder of a staging folder) has the name
/// of a skill that is already installed. An import from an archive never
/// replaces an installed skill.
pub fn skill_is_installed(dir: &Path) -> bool {
    ryu_skills::SkillRegistry::skills_dir()
        .join(crate::import::skill_install_name(dir))
        .is_dir()
}
