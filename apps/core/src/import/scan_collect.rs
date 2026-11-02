//! The scan walk: root files, MCP configs, skills, plugins, memories, and Codex stores.

use super::*;

/// Root-level items: instruction files and MCP config files sitting at `root`.
pub(super) fn collect_root_files(root: &Path, c: &mut Collector) {
    if c.exhausted() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        c.bump();
        if let Some(n) = entry.file_name().to_str() {
            names.push(n.to_string());
        }
    }
    let lower = |n: &str| n.to_ascii_lowercase();

    // Instructions: any AGENTS.md / CLAUDE.md at the root (case-insensitive).
    for n in names.iter().filter(|n| {
        let l = lower(n);
        l == "agents.md" || l == "claude.md"
    }) {
        if c.instructions.len() >= MAX_INSTRUCTIONS {
            break;
        }
        let path = root.join(n);
        if file_size(&path)
            .map(|s| s > MAX_INSTRUCTIONS_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        c.instructions.push(ScanItem {
            content_revision: instruction_content_revision(root, n),
            ..ScanItem::titled(
                kind::INSTRUCTIONS,
                format!("{}/{}", kind::INSTRUCTIONS, n),
                Message::new(messages::IMPORT_INSTRUCTIONS_TITLE_MESSAGE).text("file", n),
                Some(path.to_string_lossy().to_string()),
            )
        });
    }

    // MCP configs at the root.
    collect_mcp_config(root, "json", "mcp.json", c);
    collect_mcp_config(root, "toml", "config.toml", c);
    collect_mcp_config(root, "claude", ".claude.json", c);
    // Framework homes keep MCP servers in their own config dialects; only read
    // them when the folder IS that home, so an unrelated project's
    // `config.yaml` is never parsed as Hermes config.
    match frameworks::detect(root) {
        Some(frameworks::Framework::OpenClaw) => {
            for (token, rel) in [
                ("openclaw", "openclaw.json"),
                ("clawdbot", "clawdbot.json"),
                ("moltbot", "moltbot.json"),
            ] {
                collect_mcp_config(root, token, rel, c);
            }
        }
        Some(frameworks::Framework::Hermes) => collect_mcp_config(root, "hermes", "config.yaml", c),
        _ => {}
    }
}

/// Parse an MCP config file in the dialect its config token names.
pub(super) fn parse_mcp_file(rel: &str, path: &Path) -> Result<Vec<(String, McpServerConfig)>> {
    match rel {
        "openclaw.json" | "clawdbot.json" | "moltbot.json" => frameworks::parse_openclaw_mcp(path),
        "config.yaml" => frameworks::parse_hermes_mcp(path),
        _ if is_toml_mcp(rel) => parse_mcp_toml(path),
        _ => parse_mcp_json(path),
    }
}

/// Parse one MCP config file at `root` and emit an item per server.
pub(super) fn collect_mcp_config(root: &Path, token: &str, rel: &str, c: &mut Collector) {
    if c.mcp.len() >= MAX_MCP_SERVERS {
        return;
    }
    let path = root.join(rel);
    if !path.is_file() {
        return;
    }
    if file_size(&path)
        .map(|s| s > MAX_SCAN_BYTES)
        .unwrap_or(false)
    {
        c.warn(
            Message::new(messages::IMPORT_TOO_LARGE_WARNING_MESSAGE)
                .text("path", path.to_string_lossy()),
        );
        return;
    }
    let servers = match parse_mcp_file(rel, &path) {
        Ok(s) => s,
        Err(e) => {
            c.warn_verbatim(format!("{}: {}", path.to_string_lossy(), e));
            return;
        }
    };
    for (name, _cfg) in servers {
        if c.mcp.len() >= MAX_MCP_SERVERS {
            break;
        }
        c.mcp.push(ScanItem {
            already_exists: c.mcp_names_present.contains(&name),
            ..ScanItem::titled(
                kind::MCP_SERVER,
                format!("{}/mcp/{}/{}", kind::MCP_SERVER, token, name),
                Message::new(messages::IMPORT_MCP_SERVER_TITLE_MESSAGE).text("name", &name),
                Some(path.to_string_lossy().to_string()),
            )
        });
    }
}

/// True when a config file path names a Codex-style TOML MCP config.
pub(super) fn is_toml_mcp(rel: &str) -> bool {
    rel.ends_with("config.toml")
}

/// Recursive bounded walk: any dir that IS a skill / plugin / memory store is
/// recorded and not descended into.
pub(super) fn walk(root: &Path, dir: &Path, depth: usize, c: &mut Collector) {
    if depth > MAX_SCAN_DEPTH || c.exhausted() {
        return;
    }

    // A plugin bundle: a directory that directly contains a manifest. Record it
    // (when under the cap) and never descend — a plugin dir is a unit.
    if let Some(manifest_name) = find_manifest(dir) {
        if c.plugins.len() < MAX_PLUGINS {
            if let Some(id) = plugin_id_from_file(&dir.join(manifest_name)) {
                let rel = rel_path(&c.root, dir);
                c.plugins.push(ScanItem {
                    already_exists: plugin_dir_exists(&id),
                    ..ScanItem::titled(
                        kind::PLUGIN,
                        format!("{}/{rel}", kind::PLUGIN),
                        Message::new(messages::IMPORT_PLUGIN_TITLE_MESSAGE).text("name", &id),
                        Some(dir.to_string_lossy().to_string()),
                    )
                });
            }
        }
        return;
    }

    // A skill: a directory that directly contains a SKILL.md. Record it and
    // don't descend (bundled resources live inside the skill dir).
    if has_skill_md(dir) {
        if c.skills.len() < MAX_SKILLS {
            let name = skill_install_name(dir);
            let rel = rel_path(&c.root, dir);
            c.skills.push(ScanItem {
                already_exists: ryu_skills::SkillRegistry::skills_dir().join(&name).is_dir(),
                ..ScanItem::titled(
                    kind::SKILL,
                    format!("{}/{rel}", kind::SKILL),
                    Message::new(messages::IMPORT_SKILL_TITLE_MESSAGE).text("name", &name),
                    Some(dir.to_string_lossy().to_string()),
                )
            });
        }
        return;
    }

    // A Claude Code memory store: `**/memory/<uuid>.md`.
    if c.memories.len() < MAX_MEMORIES
        && dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("memory"))
            .unwrap_or(false)
    {
        let root = c.root.clone();
        collect_memory_files(&root, dir, c);
        return;
    }

    // A Codex subagent store: `agents/<name>.md` (only files that parse as
    // subagents are listed, so a project's stray `agents/` notes stay silent).
    let dir_name = dir.file_name().and_then(|n| n.to_str());
    if c.agents.len() < MAX_SUBAGENTS
        && c.codex_root
            .as_ref()
            .is_some_and(|codex_root| dir.starts_with(codex_root))
        && dir_name
            .map(|n| n.eq_ignore_ascii_case("agents"))
            .unwrap_or(false)
    {
        let root = c.root.clone();
        collect_codex_subagents(&root, dir, c);
        return;
    }

    // A Codex slash-command store: `prompts/<name>.md`.
    if c.slash_commands.len() < MAX_SLASH_COMMANDS
        && c.codex_root
            .as_ref()
            .is_some_and(|codex_root| dir.starts_with(codex_root))
        && dir_name
            .map(|n| n.eq_ignore_ascii_case("prompts"))
            .unwrap_or(false)
    {
        let root = c.root.clone();
        collect_codex_prompts(&root, dir, c);
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        c.bump();
        if c.exhausted() {
            return;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        if is_skipped_dir(name) {
            continue;
        }
        walk(root, &entry.path(), depth + 1, c);
    }
}

/// Emit one item per Claude-style memory file under a `memory/` dir. Only files
/// that plausibly ARE Claude memories are listed (uuid-like stem OR the known
/// JSON content shape), so a project's random `memory/notes.md` stays silent.
pub(super) fn collect_memory_files(root: &Path, dir: &Path, c: &mut Collector) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if c.memories.len() >= MAX_MEMORIES {
            break;
        }
        c.bump();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|n| n.split('.').next()) else {
            continue;
        };
        if name.to_string_lossy().to_ascii_lowercase().ends_with(".nl") {
            continue;
        }
        let path = entry.path();
        // Claude memory stems are uuids (hex + dashes). A non-uuid stem is only
        // accepted when the body looks like the Claude memory JSON/front-matter
        // shape (a raw-text file is too generic to be a memory store).
        let uuid_like =
            stem.len() == 36 && stem.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-');
        if !uuid_like && !looks_like_json_memory(&path) {
            continue;
        }
        let rel = rel_path(root, &path);
        c.memories.push(ScanItem::titled(
            kind::MEMORY,
            format!("{}/{rel}", kind::MEMORY),
            Message::new(messages::IMPORT_MEMORY_TITLE_MESSAGE).text("name", stem),
            Some(dir.to_string_lossy().to_string()),
        ));
    }
}

/// Emit one item per Codex subagent under an `agents/` dir. Only files that
/// parse as Codex subagents (front-matter with a `name`) are listed.
pub(super) fn collect_codex_subagents(root: &Path, dir: &Path, c: &mut Collector) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if c.agents.len() >= MAX_SUBAGENTS {
            break;
        }
        c.bump();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if parse_codex_subagent(&path).is_none() {
            continue;
        }
        let rel = rel_path(root, &path);
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("subagent");
        c.agents.push(ScanItem::titled(
            kind::AGENT,
            format!("{}/{rel}", kind::AGENT),
            Message::new(messages::IMPORT_AGENT_TITLE_MESSAGE).text("name", name),
            Some(path.to_string_lossy().to_string()),
        ));
    }
}

/// Emit one item per Codex slash-command prompt under a `prompts/` dir. The
/// file stem is the command name; a file with no body is skipped.
pub(super) fn collect_codex_prompts(root: &Path, dir: &Path, c: &mut Collector) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if c.slash_commands.len() >= MAX_SLASH_COMMANDS {
            break;
        }
        c.bump();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_command_name(stem) || parse_codex_prompt(&path).is_none() {
            continue;
        }
        let rel = rel_path(root, &path);
        c.slash_commands.push(ScanItem::titled(
            kind::SLASH_COMMAND,
            format!("{}/{rel}", kind::SLASH_COMMAND),
            Message::new(messages::IMPORT_SLASH_COMMAND_TITLE_MESSAGE).text("name", stem),
            Some(path.to_string_lossy().to_string()),
        ));
    }
}

// ---------------------------------------------------------------------------
// Item id resolution (re-read from disk, never trust client bytes)
// ---------------------------------------------------------------------------
