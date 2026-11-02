//! Parse Claude memory records and Codex subagents and prompts.

use super::*;

/// True when a file's first non-whitespace character marks it as the Claude
/// memory JSON body (`{`) or `---` front-matter shape — the cheap gate for
/// non-uuid memory filenames.
pub(super) fn looks_like_json_memory(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let text = raw.trim_start();
    text.starts_with('{') || text.starts_with("---")
}

/// Parse one Claude Code memory file into `(content, when_to_use, importance)`.
/// Tolerant: a JSON body (`{"content": ..., "when_to_use": ..., "importance": N}`),
/// a `---` JSON front-matter block, or the raw file text. `None` when the file
/// cannot be read or is empty.
pub fn parse_claude_memory(path: &Path) -> Option<(String, Option<String>, i32)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    // JSON body (Claude's memory file format).
    if text.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
            if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
                let content = content.trim();
                if content.is_empty() {
                    return None;
                }
                let when = val
                    .get("when_to_use")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let importance = val
                    .get("importance")
                    .and_then(|v| v.as_i64())
                    .map(|i| i.clamp(1, 5) as i32)
                    .unwrap_or(3);
                return Some((content.to_string(), when, importance));
            }
        }
    }
    // `---`-delimited JSON front-matter.
    if text.starts_with("---") {
        if let Some(end) = text[3..].find("\n---") {
            let block = &text[3..3 + end];
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(block.trim()) {
                let content = val
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let when = val
                    .get("when_to_use")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let importance = val
                    .get("importance")
                    .and_then(|v| v.as_i64())
                    .map(|i| i.clamp(1, 5) as i32)
                    .unwrap_or(3);
                if let Some(content) = content {
                    let body = text[3 + end + 4..].trim();
                    let full = if body.is_empty() {
                        content
                    } else {
                        format!("{content}\n\n{body}")
                    };
                    if !full.trim().is_empty() {
                        return Some((full.trim().to_string(), when, importance));
                    }
                }
            }
        }
    }
    // Fallback: raw text.
    Some((text.to_string(), None, 3))
}

// ---------------------------------------------------------------------------
// Codex subagents + slash commands (`~/.codex/agents/*.md`, `~/.codex/prompts/*.md`)
// ---------------------------------------------------------------------------

/// A Codex subagent definition parsed from `agents/<name>.md`. The front-matter
/// carries `name`, `description`, optional `tools` / `model`; the body is the
/// system prompt.
#[derive(Debug, Clone)]
pub struct CodexSubagent {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub tools: Vec<String>,
    pub model: Option<String>,
}

/// A Codex slash-command prompt parsed from `prompts/<name>.md`. The file stem
/// is the command name (without the leading slash); the body is the prompt
/// template that fills the composer when the command is picked.
#[derive(Debug, Clone)]
pub struct CodexPrompt {
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

/// Split `---`-delimited YAML front-matter from a markdown body. Mirrors the
/// skills crate's `split_front_matter`: a file without an opener is all body,
/// an opener without a closer is all front-matter.
pub(super) fn split_front_matter(content: &str) -> (String, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), content.to_owned());
    }
    let after_opener = match trimmed.find('\n') {
        Some(pos) => &trimmed[pos + 1..],
        None => return (String::new(), content.to_owned()),
    };
    match after_opener.find("\n---") {
        Some(pos) => {
            let fm = after_opener[..pos].to_owned();
            let body = after_opener[pos + "\n---".len()..]
                .trim_start_matches('\n')
                .to_owned();
            (fm, body)
        }
        None => (after_opener.to_owned(), String::new()),
    }
}

/// Parse a Codex subagent file. `None` unless it has `---` front-matter with a
/// non-empty `name` — the gate that keeps a project's random `agents/*.md`
/// notes out of the import list.
pub fn parse_codex_subagent(path: &Path) -> Option<CodexSubagent> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fm {
        name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        tools: Option<Vec<String>>,
        #[serde(default)]
        model: Option<String>,
    }

    let content = fs::read_to_string(path).ok()?;
    let (front, body) = split_front_matter(&content);
    if front.trim().is_empty() {
        return None;
    }
    let fm: Fm = noyalib::compat::serde_yaml::from_str(&front).ok()?;
    let name = fm.name?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(CodexSubagent {
        name,
        description: fm
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
        system_prompt: body.trim().to_string(),
        tools: fm.tools.unwrap_or_default(),
        model: fm
            .model
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
    })
}

/// Parse a Codex slash-command prompt file. The file stem is the command name;
/// a file with no body is skipped.
pub fn parse_codex_prompt(path: &Path) -> Option<CodexPrompt> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fm {
        #[serde(default)]
        description: Option<String>,
    }

    let name = path.file_stem()?.to_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let (front, body) = split_front_matter(&content);
    let body = body.trim().to_string();
    if body.is_empty() {
        return None;
    }
    let description = if front.trim().is_empty() {
        None
    } else {
        noyalib::compat::serde_yaml::from_str::<Fm>(&front)
            .ok()
            .and_then(|f| f.description)
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
    };
    Some(CodexPrompt {
        name,
        description,
        body,
    })
}
