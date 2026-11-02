//! Markdown memory files and persona parsing.

use super::*;

pub(super) fn markdown_files(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if ft.is_dir() && depth > 1 {
            out.extend(markdown_files(&path, depth - 1));
        } else if ft.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
    out
}

/// `YYYY-MM-DD` or `YYYY-MM-DD-<suffix>`.
pub(super) fn is_dated_stem(stem: &str) -> bool {
    let bytes = stem.as_bytes();
    bytes.len() >= 10
        && bytes[..10].iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// A persona workspace composed into a Ryu agent definition.
pub fn parse_persona(root: &Path, anchor: &Path) -> Option<CodexSubagent> {
    let dir = anchor.parent()?;
    let mut sections = Vec::new();
    for (file, heading) in PERSONA_FILES {
        let Some(text) = read_bounded(&dir.join(file), MAX_FRAMEWORK_FILE_BYTES) else {
            continue;
        };
        let text = text.trim();
        if !text.is_empty() {
            sections.push(format!("## {heading}\n\n{text}"));
        }
    }
    if sections.is_empty() {
        return None;
    }
    let framework = detect(root).unwrap_or(Framework::Persona);
    let identity = read_bounded(&dir.join("IDENTITY.md"), MAX_FRAMEWORK_FILE_BYTES);
    let workspace_suffix = dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("workspace-"))
        .filter(|s| !s.is_empty() && *s != "main");
    let name = identity
        .as_deref()
        .and_then(identity_name)
        .or_else(|| workspace_suffix.map(|s| format!("{}-{s}", framework.id())))
        .unwrap_or_else(|| framework.id().to_string());
    Some(CodexSubagent {
        name,
        description: Some(format!(
            "Migrated from {} ({}).",
            framework.label(),
            dir.to_string_lossy()
        )),
        system_prompt: sections.join("\n\n"),
        tools: Vec::new(),
        model: persona_model(root, framework),
    })
}

/// The `Name:` field of an OpenClaw-style `IDENTITY.md`
/// (`- **Name:** Clawd`, `Name: Clawd`, or `name: Clawd`).
pub(super) fn identity_name(identity: &str) -> Option<String> {
    identity.lines().find_map(|line| {
        let cleaned: String = line
            .trim()
            .trim_start_matches(['-', '*', ' '])
            .replace("**", "");
        let (key, value) = cleaned.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("name") {
            return None;
        }
        let value = value.trim().trim_matches(['"', '\'', '*', '_']).trim();
        (!value.is_empty() && value.len() <= 80).then(|| value.to_string())
    })
}

/// The default model a persona home was configured with, as `provider/model`.
pub(super) fn persona_model(root: &Path, framework: Framework) -> Option<String> {
    match framework {
        Framework::OpenClaw => {
            let config = read_openclaw_config(root)?;
            let model = config.pointer("/agents/defaults/model")?;
            model
                .as_str()
                .or_else(|| model.get("primary").and_then(Value::as_str))
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
        }
        Framework::Hermes => {
            let config = read_hermes_config(root)?;
            let model = config.get("model")?;
            let name = model
                .as_str()
                .or_else(|| model.get("default").and_then(Value::as_str))?
                .trim();
            if name.is_empty() {
                return None;
            }
            let provider = model
                .get("provider")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|p| !p.is_empty() && !name.contains('/'));
            Some(match provider {
                Some(p) => format!("{p}/{name}"),
                None => name.to_string(),
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Markdown memory files
// ---------------------------------------------------------------------------

/// A Markdown memory file split into entries.
#[derive(Debug, Clone)]
pub struct MarkdownMemory {
    pub entries: Vec<String>,
    pub category: ryu_memory::MemoryCategory,
}

/// True when an item path is a Markdown memory document this module owns
/// (rather than a Claude Code `memory/<uuid>.md` record).
pub fn is_markdown_memory_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.eq_ignore_ascii_case("MEMORY.md") || name.eq_ignore_ascii_case("USER.md") {
        return true;
    }
    let in_dir = |dir: &str| {
        path.ancestors()
            .skip(1)
            .take(4)
            .any(|a| a.file_name().and_then(|n| n.to_str()) == Some(dir))
    };
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    (in_dir("memory") && is_dated_stem(stem)) || in_dir("bank")
}

/// Split a Markdown memory file into entries. Hermes separates entries with
/// `§`; OpenClaw and Muse use bullets and paragraphs. Dated daily notes are
/// prefixed with their date so the entry keeps its time context.
pub fn parse_markdown_memory(path: &Path) -> Option<MarkdownMemory> {
    let raw = read_bounded(path, MAX_FRAMEWORK_FILE_BYTES)?;
    let (_, body) = super::super::split_front_matter(&raw);
    let name = path.file_name()?.to_str()?;
    let stem = path.file_stem()?.to_str()?;
    let dated = is_dated_stem(stem).then(|| stem[..10].to_string());
    let bank_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(str::to_ascii_lowercase);
    let category = if name.eq_ignore_ascii_case("USER.md") {
        ryu_memory::MemoryCategory::UserFact
    } else if dated.is_some() {
        ryu_memory::MemoryCategory::Event
    } else {
        match bank_dir.as_deref() {
            Some("preferences") => ryu_memory::MemoryCategory::Preference,
            Some("experiences") => ryu_memory::MemoryCategory::Event,
            Some("circumstances") => ryu_memory::MemoryCategory::UserFact,
            _ => ryu_memory::MemoryCategory::Other,
        }
    };
    let mut entries = split_memory_entries(&body);
    if let Some(date) = dated {
        for entry in &mut entries {
            *entry = format!("On {date}: {entry}");
        }
    }
    entries.truncate(MAX_MEMORY_ENTRIES_PER_FILE);
    Some(MarkdownMemory { entries, category })
}

/// Split free-form memory text into entries (`§`-delimited, bullets, or
/// paragraphs). Shared with the ChatGPT / Claude export importer.
pub fn split_memory_text(body: &str) -> Vec<String> {
    split_memory_entries(body)
}

pub(super) fn split_memory_entries(body: &str) -> Vec<String> {
    let clean = |s: &str| -> Option<String> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(trimmed.chars().take(MAX_MEMORY_ENTRY_CHARS).collect())
    };
    if body.contains('§') {
        return body.split('§').filter_map(clean).collect();
    }
    let mut entries = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, entries: &mut Vec<String>| {
        if let Some(entry) = clean(current) {
            entries.push(entry);
        }
        current.clear();
    };
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || is_rule(trimmed) {
            flush(&mut current, &mut entries);
            continue;
        }
        if let Some(item) = bullet_text(line) {
            flush(&mut current, &mut entries);
            current.push_str(item);
            continue;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(trimmed);
    }
    flush(&mut current, &mut entries);
    entries
}

pub(super) fn is_rule(line: &str) -> bool {
    line.len() >= 3 && line.chars().all(|c| matches!(c, '-' | '*' | '_' | '='))
}

/// The text of a top-level bullet line (`- x`, `* x`, `+ x`, `1. x`), with an
/// optional task checkbox removed. Indented sub-bullets continue the parent.
pub(super) fn bullet_text(line: &str) -> Option<&str> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let rest = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "))
        .or_else(|| {
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            (digits > 0)
                .then(|| line[digits..].strip_prefix(". "))
                .flatten()
        })?;
    let rest = rest
        .strip_prefix("[ ] ")
        .or_else(|| rest.strip_prefix("[x] "))
        .or_else(|| rest.strip_prefix("[X] "))
        .unwrap_or(rest);
    Some(rest)
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------
