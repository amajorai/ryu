//! Saved context: ChatGPT custom instructions and Claude memories.

use super::*;

/// Saved context as `(text, is_about_the_user)` entries, newest first and
/// deduplicated. ChatGPT: the latest custom instructions found in any
/// conversation. Claude: `memories.json` text.
pub fn saved_context(root: &Path, source: ExportSource) -> Vec<(String, bool)> {
    match source {
        ExportSource::ChatGpt => chatgpt_custom_instructions(root),
        ExportSource::Claude => claude_memories(root),
    }
}

pub(super) fn chatgpt_custom_instructions(root: &Path) -> Vec<(String, bool)> {
    conversations(root)
        .map(|raw| chatgpt_custom_instructions_in(&raw))
        .unwrap_or_default()
}

pub(super) fn chatgpt_custom_instructions_in(raw: &[Value]) -> Vec<(String, bool)> {
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
pub(super) fn strip_custom_instruction_preamble(text: &str) -> String {
    let text = text.trim();
    let body = text
        .split_once("```")
        .and_then(|(_, rest)| rest.rsplit_once("```").map(|(inner, _)| inner))
        .unwrap_or(text);
    body.trim().to_string()
}

/// JSON records from every `*.json` file in `dir` (each file an object or a
/// list of objects), in file-name order.
pub(super) fn json_records(dir: &Path) -> Vec<Value> {
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
pub(super) fn claude_memory_records(root: &Path) -> Vec<Value> {
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
pub(super) fn claude_project_memories(root: &Path) -> BTreeMap<String, String> {
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

pub(super) fn claude_memories(root: &Path) -> Vec<(String, bool)> {
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
        for entry in super::super::frameworks::split_memory_text(&text) {
            if !out.iter().any(|(existing, _)| *existing == entry) {
                out.push((entry, false));
            }
        }
    }
    out
}

/// Gather memory text from any JSON shape, skipping ids and timestamps.
pub(super) fn collect_strings(value: &Value, out: &mut Vec<String>, depth: usize) {
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
