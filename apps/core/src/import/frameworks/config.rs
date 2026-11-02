//! OpenClaw and Hermes config files: MCP servers and the JSON5 reader.

use super::*;

pub(super) fn read_openclaw_config(root: &Path) -> Option<Value> {
    OPENCLAW_CONFIG_FILES.iter().find_map(|file| {
        let raw = read_bounded(&root.join(file), MAX_FRAMEWORK_FILE_BYTES)?;
        serde_json::from_str(&json5_to_json(&raw)).ok()
    })
}

pub(super) fn read_hermes_config(root: &Path) -> Option<Value> {
    let raw = read_bounded(&root.join("config.yaml"), MAX_FRAMEWORK_FILE_BYTES)?;
    let yaml: noyalib::compat::serde_yaml::Value =
        noyalib::compat::serde_yaml::from_str(&raw).ok()?;
    serde_json::to_value(yaml).ok()
}

/// Parse MCP servers from an OpenClaw config (`mcp.servers.<name>`).
pub fn parse_openclaw_mcp(path: &Path) -> anyhow::Result<Vec<(String, McpServerConfig)>> {
    let raw = read_bounded(path, MAX_FRAMEWORK_FILE_BYTES)
        .ok_or_else(|| anyhow::anyhow!("cannot read {}", path.to_string_lossy()))?;
    let config: Value = serde_json::from_str(&json5_to_json(&raw))
        .map_err(|e| anyhow::anyhow!("parsing OpenClaw config: {e}"))?;
    Ok(lower_mcp_map(config.pointer("/mcp/servers")))
}

/// Parse MCP servers from a Hermes `config.yaml` (`mcp_servers.<name>`).
/// Servers disabled in the source are omitted.
pub fn parse_hermes_mcp(path: &Path) -> anyhow::Result<Vec<(String, McpServerConfig)>> {
    let raw = read_bounded(path, MAX_FRAMEWORK_FILE_BYTES)
        .ok_or_else(|| anyhow::anyhow!("cannot read {}", path.to_string_lossy()))?;
    let yaml: noyalib::compat::serde_yaml::Value = noyalib::compat::serde_yaml::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parsing config.yaml: {e}"))?;
    let config = serde_json::to_value(yaml)?;
    Ok(lower_mcp_map(config.get("mcp_servers")))
}

pub(super) fn lower_mcp_map(map: Option<&Value>) -> Vec<(String, McpServerConfig)> {
    let Some(map) = map.and_then(Value::as_object) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, entry)| {
            let entry = entry.as_object()?;
            // Ryu enables every imported server, so a server the user switched
            // off in the source is not offered at all.
            if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            let text = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let strings = |key: &str| -> BTreeMap<String, String> {
                entry
                    .get(key)
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| match v {
                                Value::String(s) => Some((k.clone(), s.clone())),
                                Value::Number(n) => Some((k.clone(), n.to_string())),
                                Value::Bool(b) => Some((k.clone(), b.to_string())),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let transport = text("transport").or_else(|| text("type")).map(|t| {
                match t.to_ascii_lowercase().as_str() {
                    "streamable-http" | "streamable_http" | "http" => "http".to_string(),
                    other => other.to_string(),
                }
            });
            Some((
                name.clone(),
                McpServerConfig {
                    command: text("command"),
                    transport,
                    url: text("url"),
                    headers: strings("headers"),
                    auth: None,
                    owner_plugin_id: None,
                    owner_server_name: None,
                    cwd: None,
                    args: entry
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    env: strings("env"),
                    description: text("description"),
                    enabled: true,
                    version: None,
                    catalog_id: None,
                },
            ))
        })
        .collect()
}

/// Convert JSON5 (comments, trailing commas, unquoted keys, single-quoted
/// strings) into strict JSON. Strict JSON passes through unchanged.
pub fn json5_to_json(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '"' | '\'' => {
                let quote = ch;
                out.push('"');
                i += 1;
                while i < chars.len() && chars[i] != quote {
                    let c = chars[i];
                    if c == '\\' && i + 1 < chars.len() {
                        let next = chars[i + 1];
                        if next == '\'' {
                            out.push('\'');
                        } else if next == '\n' {
                            // JSON5 line continuation.
                        } else {
                            out.push('\\');
                            out.push(next);
                        }
                        i += 2;
                        continue;
                    }
                    if c == '"' {
                        out.push_str("\\\"");
                    } else if c == '\n' {
                        out.push_str("\\n");
                    } else {
                        out.push(c);
                    }
                    i += 1;
                }
                out.push('"');
                i += 1;
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            '}' | ']' => {
                let trimmed_len = out.trim_end().len();
                if out[..trimmed_len].ends_with(',') {
                    out.truncate(trimmed_len - 1);
                }
                out.push(ch);
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$')
                {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                let is_key = chars.get(j) == Some(&':');
                if is_key {
                    out.push('"');
                    out.push_str(&ident);
                    out.push('"');
                } else {
                    out.push_str(&ident);
                }
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Review notes (never imported, never values)
// ---------------------------------------------------------------------------
