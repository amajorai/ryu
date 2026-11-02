//! Code-defined agents (Mastra, LangChain) and their source-file helpers.

use super::*;

/// One agent extracted from source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeAgent {
    pub name: String,
    pub description: Option<String>,
    pub instructions: String,
    pub model: Option<String>,
}

/// Outcome of extracting agents from one file: agents with static
/// instructions, plus call sites that could not be converted.
#[derive(Debug, Default)]
pub struct CodeAgents {
    pub agents: Vec<CodeAgent>,
    pub unresolved: Vec<String>,
}

pub(super) fn collect_code_agents(root: &Path, framework: Framework, c: &mut Collector) {
    let mut files = Vec::new();
    source_files(root, 0, &mut files);
    let mut unresolved = Vec::new();
    for path in files {
        if c.agents.len() >= super::super::MAX_SUBAGENTS {
            break;
        }
        let Some(src) = read_bounded(&path, MAX_SOURCE_FILE_BYTES) else {
            continue;
        };
        let found = extract_code_agents(&src, &path, framework);
        let rel = rel_path(&c.root, &path);
        for (index, agent) in found.agents.iter().enumerate() {
            // The cap holds within one file too: a single source can define
            // more agents than a scan offers.
            if c.agents.len() >= super::super::MAX_SUBAGENTS {
                break;
            }
            c.agents.push(ScanItem::titled(
                kind::AGENT,
                format!("{}/{rel}#{index}", kind::AGENT),
                Message::new(messages::IMPORT_SOURCE_AGENT_TITLE_MESSAGE)
                    .text("source", framework.label())
                    .text("name", &agent.name),
                Some(path.to_string_lossy().to_string()),
            ));
        }
        unresolved.extend(
            found
                .unresolved
                .into_iter()
                .map(|what| format!("{rel}: {what}")),
        );
    }
    if !unresolved.is_empty() {
        let shown: Vec<_> = unresolved.iter().take(10).cloned().collect();
        let names = format!(
            "{}{}",
            shown.join("; "),
            if unresolved.len() > shown.len() {
                "; …"
            } else {
                ""
            }
        );
        let message = if unresolved.len() == 1 {
            Message::new(messages::IMPORT_RUNTIME_AGENT_ONE_WARNING_MESSAGE)
        } else {
            counted(
                Message::new(messages::IMPORT_RUNTIME_AGENTS_WARNING_MESSAGE),
                unresolved.len(),
            )
        };
        c.warn(message.text("names", names));
    }
    c.warn(
        Message::new(messages::IMPORT_CODE_NOT_CONVERTED_WARNING_MESSAGE)
            .text("source", framework.label()),
    );
}

pub(super) fn source_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SOURCE_DEPTH || out.len() >= MAX_SOURCE_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_SOURCE_FILES {
            return;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if ft.is_dir() {
            if name.starts_with('.')
                || super::super::is_skipped_dir(name)
                || matches!(
                    name,
                    "__pycache__" | "venv" | ".venv" | "site-packages" | "coverage"
                )
            {
                continue;
            }
            source_files(&entry.path(), depth + 1, out);
        } else if ft.is_file() {
            let is_source = [".ts", ".tsx", ".mts", ".js", ".mjs", ".py"]
                .iter()
                .any(|ext| name.ends_with(ext))
                && !name.ends_with(".d.ts")
                && !name.contains(".test.")
                && !name.contains(".spec.");
            if is_source
                && file_size(&entry.path())
                    .map(|s| s <= MAX_SOURCE_FILE_BYTES)
                    .unwrap_or(false)
            {
                out.push(entry.path());
            }
        }
    }
}

/// Extract the `#index`-th code agent from a source file. Used by the import
/// step to re-read the agent from disk.
pub fn parse_code_agent(root: &Path, path: &Path, index: usize) -> Option<CodeAgent> {
    let framework = detect(root)?;
    let src = read_bounded(path, MAX_SOURCE_FILE_BYTES)?;
    extract_code_agents(&src, path, framework)
        .agents
        .into_iter()
        .nth(index)
}

/// Constructor calls that define an agent, per framework and language.
pub(super) fn agent_constructors(framework: Framework, python: bool) -> &'static [&'static str] {
    match (framework, python) {
        (Framework::Mastra, false) => &["new Agent("],
        (Framework::LangChain, true) => &[
            "create_react_agent(",
            "create_agent(",
            "create_deep_agent(",
            "create_tool_calling_agent(",
        ],
        (Framework::LangChain, false) => &[
            "createReactAgent(",
            "createAgent(",
            "createDeepAgent(",
            "createToolCallingAgent(",
        ],
        _ => &[],
    }
}

/// Keys that carry the system prompt, in preference order.
pub(super) fn instruction_keys(framework: Framework, python: bool) -> &'static [&'static str] {
    match (framework, python) {
        (Framework::Mastra, _) => &["instructions"],
        (Framework::LangChain, true) => {
            &["system_prompt", "prompt", "instructions", "state_modifier"]
        }
        _ => &["systemPrompt", "prompt", "instructions", "stateModifier"],
    }
}

pub(super) fn provider_for_constructor(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let provider = match lower.as_str() {
        "openai" | "chatopenai" | "azurechatopenai" => "openai",
        "anthropic" | "chatanthropic" => "anthropic",
        "google" | "chatgooglegenerativeai" | "chatvertexai" => "google",
        "groq" | "chatgroq" => "groq",
        "mistral" | "chatmistralai" => "mistral",
        "ollama" | "chatollama" => "ollama",
        "deepseek" | "chatdeepseek" => "deepseek",
        "xai" | "chatxai" => "xai",
        "openrouter" | "chatopenrouter" => "openrouter",
        _ => return None,
    };
    Some(provider.to_string())
}

pub(super) fn unescape(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => {}
            Some('\n') => {}
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Remove the common leading indentation of a multi-line literal.
pub(super) fn dedent(text: &str) -> String {
    let indent = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    text.lines()
        .map(|l| {
            if l.len() >= indent {
                &l[indent..]
            } else {
                l.trim_start()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(super) fn read_bounded(path: &Path, max: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    fs::read_to_string(path).ok()
}

pub(super) fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) => dirs::home_dir()
            .map(|home| home.join(rest.trim_start_matches(['/', '\\'])))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}
