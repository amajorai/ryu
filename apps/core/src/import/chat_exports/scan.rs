//! Scan an export into conversation groups, and read a group back.

use super::*;

pub(in crate::import) fn collect(root: &Path, c: &mut Collector) -> Option<ExportSource> {
    let source = detect(root)?;
    let raw = match conversations(root) {
        Ok(raw) => raw,
        Err(error) => {
            c.warn(
                Message::new(messages::IMPORT_EXPORT_UNREADABLE_WARNING_MESSAGE)
                    .text("source", source.label())
                    .text("error", error.to_string()),
            );
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
            None => counted(
                Message::new(messages::IMPORT_EXPORT_CHATS_TITLE_MESSAGE),
                *count,
            ),
            Some(_) if *count == 0 => Message::new(messages::IMPORT_EXPORT_PROJECT_TITLE_MESSAGE),
            Some(_) if *count == 1 => {
                Message::new(messages::IMPORT_EXPORT_PROJECT_ONE_CHAT_TITLE_MESSAGE)
            }
            Some(_) => counted(
                Message::new(messages::IMPORT_EXPORT_PROJECT_CHATS_TITLE_MESSAGE),
                *count,
            ),
        }
        .text("source", source.label());
        let title = match &project {
            Some(project) => title.text("name", &project.name),
            None => title,
        };
        let item = ScanItem::titled(
            kind::CONVERSATIONS,
            format!("{}/conversations.json#{group}", kind::CONVERSATIONS),
            title,
            None,
        );
        let Some(project) = project else {
            c.conversations.push(item);
            continue;
        };
        let mut sentences = Vec::new();
        // ChatGPT does not export project names; name a recent chat instead.
        if let Some((_, latest)) = example_titles
            .get(group)
            .filter(|_| source == ExportSource::ChatGpt)
        {
            sentences.push(
                Message::new(messages::IMPORT_LATEST_CHAT_DETAIL_MESSAGE).text("title", latest),
            );
        }
        sentences.push(Message::new(
            match (!project.instructions.is_empty(), !project.memory.is_empty()) {
                (true, true) => messages::IMPORT_PROJECT_FOLDER_INSTRUCTIONS_MEMORY_DETAIL_MESSAGE,
                (true, false) => messages::IMPORT_PROJECT_FOLDER_INSTRUCTIONS_DETAIL_MESSAGE,
                (false, true) => messages::IMPORT_PROJECT_FOLDER_MEMORY_DETAIL_MESSAGE,
                (false, false) => messages::IMPORT_PROJECT_FOLDER_DETAIL_MESSAGE,
            },
        ));
        match project.docs.len() {
            0 => {}
            1 => sentences.push(Message::new(
                messages::IMPORT_PROJECT_ONE_FILE_DETAIL_MESSAGE,
            )),
            docs => sentences.push(counted(
                Message::new(messages::IMPORT_PROJECT_FILES_DETAIL_MESSAGE),
                docs,
            )),
        }
        c.conversations.push(item.with_sentences(sentences));
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
            ExportSource::ChatGpt => (
                conversations_file,
                messages::IMPORT_CHATGPT_INSTRUCTIONS_TITLE_MESSAGE,
            ),
            ExportSource::Claude if root.join("memories.json").is_file() => (
                "memories.json".to_string(),
                messages::IMPORT_CLAUDE_MEMORY_TITLE_MESSAGE,
            ),
            ExportSource::Claude => (
                conversations_file,
                messages::IMPORT_CLAUDE_MEMORY_TITLE_MESSAGE,
            ),
        };
        c.memories.push(ScanItem::titled(
            kind::MEMORY,
            format!("{}/{file}#{SAVED_CONTEXT}", kind::MEMORY),
            Message::new(label),
            Some(root.join(&file).to_string_lossy().to_string()),
        ));
    }
    match source {
        ExportSource::ChatGpt => {
            c.warn(Message::new(
                messages::IMPORT_CHATGPT_NO_PROJECTS_WARNING_MESSAGE,
            ));
        }
        ExportSource::Claude => {
            if !root.join("memories.json").is_file() && !root.join("memories").is_dir() {
                c.warn(Message::new(
                    messages::IMPORT_CLAUDE_NO_MEMORIES_WARNING_MESSAGE,
                ));
            }
            if groups.len() > 1 || !groups.contains_key(UNGROUPED) {
                c.warn(Message::new(
                    messages::IMPORT_CLAUDE_PROJECT_CHATS_WARNING_MESSAGE,
                ));
            }
        }
    }
    c.warn(
        Message::new(messages::IMPORT_EXPORT_PLACEHOLDERS_WARNING_MESSAGE)
            .text("source", source.label()),
    );
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

pub(super) fn clamp(text: &str) -> String {
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

pub(super) fn finish(
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

pub(super) fn epoch_seconds_to_ms(value: Option<&Value>) -> Option<i64> {
    let seconds = value?.as_f64()?;
    (seconds.is_finite() && seconds > 0.0).then(|| (seconds * 1000.0) as i64)
}

pub(super) fn iso_to_ms(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}
