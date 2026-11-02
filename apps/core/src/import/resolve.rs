//! Resolve scanned item ids back to files, and parse MCP configs.

use super::*;

/// Re-resolve a selection's `id` to the on-disk path it names, guarding against
/// traversal outside `root`. Returns the absolute path and the id's relative form.
pub fn resolve_item_path(root: &Path, id: &str) -> Result<PathBuf> {
    let rel = id
        .strip_prefix(kind::INSTRUCTIONS)
        .and_then(|rest| rest.strip_prefix('/'))
        .or_else(|| {
            id.strip_prefix(kind::SKILL)
                .and_then(|rest| rest.strip_prefix('/'))
        })
        .or_else(|| {
            id.strip_prefix(kind::PLUGIN)
                .and_then(|rest| rest.strip_prefix('/'))
        })
        .or_else(|| {
            id.strip_prefix(kind::MEMORY)
                .and_then(|rest| rest.strip_prefix('/'))
                .map(|rest| split_fragment(rest).0)
        })
        .or_else(|| {
            id.strip_prefix(kind::AGENT)
                .and_then(|rest| rest.strip_prefix('/'))
                .map(|rest| split_agent_index(rest).0)
        })
        .or_else(|| {
            id.strip_prefix(kind::CONVERSATIONS)
                .and_then(|rest| rest.strip_prefix('/'))
                .map(|rest| split_fragment(rest).0)
        })
        .or_else(|| {
            id.strip_prefix(kind::SLASH_COMMAND)
                .and_then(|rest| rest.strip_prefix('/'))
        });
    let rel = match rel {
        Some(r) => r,
        None => bail!("unrecognized item id {id:?}"),
    };
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        bail!("invalid item id {id:?}");
    }
    let mut path = root.to_path_buf();
    for segment in rel.split('/') {
        if segment.is_empty() || segment == "." {
            bail!("invalid item id {id:?}");
        }
        path.push(segment);
    }
    let canonical = fs::canonicalize(&path).with_context(|| format!("item {id:?} not found"))?;
    let canonical_root = fs::canonicalize(root).context("canonicalizing scan root")?;
    if !canonical.starts_with(&canonical_root) {
        bail!("item id escapes scan root");
    }
    Ok(canonical)
}

/// Split a code-agent locator (`src/agents.ts#2`) into its file part and the
/// index of the agent within that file. Other agent ids have no index.
pub(super) fn split_agent_index(rel: &str) -> (&str, Option<usize>) {
    match rel.rsplit_once('#') {
        Some((file, index)) if !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit()) => {
            (file, index.parse().ok())
        }
        _ => (rel, None),
    }
}

/// Split an item locator into its file part and an optional `#fragment`
/// (a group or record inside that file). Fragments use only id-safe
/// characters, so a real file name containing `#` is left alone.
pub fn split_fragment(rel: &str) -> (&str, Option<&str>) {
    match rel.rsplit_once('#') {
        Some((file, fragment)) if chat_exports::is_fragment_safe(fragment) => {
            (file, Some(fragment))
        }
        _ => (rel, None),
    }
}

/// Resolve an `agent` item id to its file and, for a code-defined agent, the
/// agent's index within that file.
pub fn resolve_agent_item(root: &Path, id: &str) -> Result<(PathBuf, Option<usize>)> {
    let index = id
        .strip_prefix(kind::AGENT)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|rest| split_agent_index(rest).1);
    Ok((resolve_item_path(root, id)?, index))
}

/// Parse the agent an `agent` item names: a Codex subagent file, a persona
/// workspace (OpenClaw / Hermes / Muse `SOUL.md`), or a Mastra / LangChain
/// agent at `index` within a source file.
pub fn parse_agent_item(root: &Path, path: &Path, index: Option<usize>) -> Option<CodexSubagent> {
    if let Some(index) = index {
        let agent = frameworks::parse_code_agent(root, path, index)?;
        return Some(CodexSubagent {
            name: agent.name,
            description: agent.description,
            system_prompt: agent.instructions,
            tools: Vec::new(),
            model: agent.model,
        });
    }
    if let Some(sub) = parse_codex_subagent(path) {
        return Some(sub);
    }
    let name = path.file_name()?.to_str()?;
    if name.eq_ignore_ascii_case("SOUL.md") || name.eq_ignore_ascii_case("IDENTITY.md") {
        return frameworks::parse_persona(root, path);
    }
    None
}

/// Match the import reader's UTF-8 content contract without reading an unbounded file.
pub(super) fn instruction_content_revision(root: &Path, name: &str) -> Option<String> {
    use std::io::Read;
    let path = resolve_item_path(root, &format!("instructions/{name}")).ok()?;
    let mut content = String::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_INSTRUCTIONS_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;
    if content.len() as u64 > MAX_INSTRUCTIONS_BYTES {
        return None;
    }
    Some(content_sha256(&content))
}

/// Recover the config token + server name from an `mcp_server` item id
/// (`mcp_server/mcp/<token>/<name>`). Returns `(token, name)`.
pub fn resolve_mcp_id(id: &str) -> Result<(&'static str, String)> {
    let rest = id
        .strip_prefix(kind::MCP_SERVER)
        .and_then(|r| r.strip_prefix("/mcp/"))
        .ok_or_else(|| anyhow::anyhow!("invalid mcp_server id {id:?}"))?;
    let (token, name) = rest
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("invalid mcp_server id {id:?}"))?;
    let (known_token, _rel) = MCP_CONFIG_TOKENS
        .iter()
        .find(|(t, _)| *t == token)
        .ok_or_else(|| anyhow::anyhow!("invalid mcp_server id {id:?}"))?;
    if name.is_empty() {
        bail!("invalid mcp_server id {id:?}");
    }
    Ok((*known_token, name.to_string()))
}

/// Re-read one foreign MCP server entry by token + name. Returns the parsed
/// config. `root` is the scanned folder.
pub fn read_mcp_entry(root: &Path, token: &str, name: &str) -> Result<McpServerConfig> {
    let rel = MCP_CONFIG_TOKENS
        .iter()
        .find(|(t, _)| *t == token)
        .map(|(_, r)| *r)
        .ok_or_else(|| anyhow::anyhow!("unknown mcp config token {token:?}"))?;
    let path = root.join(rel);
    if !path.is_file() {
        bail!("MCP config {} not found", path.to_string_lossy());
    }
    let servers = parse_mcp_file(rel, &path)?;
    servers
        .into_iter()
        .find(|(n, _)| *n == name)
        .map(|(_, cfg)| cfg)
        .with_context(|| {
            format!(
                "MCP server {name:?} not present in {}",
                path.to_string_lossy()
            )
        })
}

// ---------------------------------------------------------------------------
// Foreign format parsers
// ---------------------------------------------------------------------------

/// Parse a JSON MCP config (`mcp.json` / `.cursor/mcp.json` / `.claude.json`)
/// into `(name, config)` pairs, lowering each entry with the shared dialect
/// (`McpServerConfig` understands the Claude/Cursor shape incl. remote
/// `type`/`url`/`headers`). One unparseable entry costs that entry, never the
/// whole file.
pub fn parse_mcp_json(path: &Path) -> Result<Vec<(String, McpServerConfig)>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.to_string_lossy()))?;
    let val: serde_json::Value = serde_json::from_str(&raw).context("parsing MCP config JSON")?;
    let mut out = Vec::new();
    for key in mcp_map_keys() {
        let Some(map) = val.get(key).and_then(|v| v.as_object()) else {
            continue;
        };
        for (name, entry) in map {
            match serde_json::from_value::<McpServerConfig>(entry.clone()) {
                Ok(cfg) => out.push((name.clone(), cfg)),
                Err(e) => tracing::debug!(
                    server = %name,
                    file = %path.to_string_lossy(),
                    "setup-import: skipping unparseable MCP entry ({e})"
                ),
            }
        }
        break;
    }
    Ok(out)
}

pub(super) fn get_str(table: &toml::Table, key: &str) -> Option<String> {
    table.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

pub(super) fn get_strs(table: &toml::Table, key: &str) -> Vec<String> {
    table
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn get_str_map(table: &toml::Table, key: &str) -> BTreeMap<String, String> {
    table
        .get(key)
        .and_then(|v| v.as_table())
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a Codex-style `config.toml` MCP block (`[mcp_servers.<name>]`) into
/// `(name, config)` pairs.
pub fn parse_mcp_toml(path: &Path) -> Result<Vec<(String, McpServerConfig)>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.to_string_lossy()))?;
    let val: toml::Value =
        toml::from_str(&raw).with_context(|| format!("parsing TOML {}", path.to_string_lossy()))?;
    let mut out = Vec::new();
    for key in ["mcp_servers", "mcpServers"] {
        let Some(table) = val.get(key).and_then(|v| v.as_table()) else {
            continue;
        };
        for (name, entry) in table {
            let Some(t) = entry.as_table() else {
                continue;
            };
            out.push((
                name.clone(),
                McpServerConfig {
                    command: get_str(t, "command"),
                    transport: get_str(t, "type"),
                    url: get_str(t, "url"),
                    headers: get_str_map(t, "headers"),
                    auth: None,
                    owner_plugin_id: None,
                    owner_server_name: None,
                    cwd: None,
                    args: get_strs(t, "args"),
                    env: get_str_map(t, "env"),
                    description: get_str(t, "description"),
                    enabled: true,
                    version: None,
                    catalog_id: None,
                },
            ));
        }
        break;
    }
    Ok(out)
}
