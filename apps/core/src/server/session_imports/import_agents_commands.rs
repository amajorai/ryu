//! Session handlers, agent-thread imports and setup-import items: `import_agent_item` through `write_imported_mcp_entry`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Import a Codex subagent (`~/.codex/agents/<name>.md`), an OpenClaw / Hermes /
/// Muse persona workspace, or a Mastra / LangChain code-defined agent as a Ryu
/// agent through the SAME portable template the export/import endpoints use — there is no
/// second importer to drift from the first. The subagent's front-matter
/// `name`/`description`/`model` and its body (the system prompt) map onto
/// `AgentTemplate`; a same-named agent already present makes the import a no-op.
pub(in crate::server) async fn import_agent_item(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    use crate::import::kind;

    let (path, index) = match crate::import::resolve_agent_item(root, &selection.id) {
        Ok(resolved) => resolved,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                kind::AGENT,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let Some(sub) = crate::import::parse_agent_item(root, &path, index) else {
        return crate::import::ImportOutcome::failed_because(
            kind::AGENT,
            &selection.id,
            &selection.id,
            crate::i18n::messages::IMPORT_OUTCOME_UNREADABLE_AGENT_MESSAGE,
        );
    };
    let title_msg = crate::import::named_title(
        crate::i18n::messages::IMPORT_OUTCOME_AGENT_TITLE_MESSAGE,
        &sub.name,
    );
    let title = crate::import::english(&title_msg);
    match state.agent_store.list().await {
        Ok(records) if records.iter().any(|r| r.name == sub.name) => {
            return crate::import::ImportOutcome::already(kind::AGENT, &selection.id, &title);
        }
        Ok(_) => {}
        Err(_) => {}
    }
    let template = crate::agents::AgentTemplate {
        kind: "agent".to_owned(),
        name: sub.name,
        version: "1.0.0".to_owned(),
        agent_config: crate::agents::AgentTemplateConfig {
            title: String::new(),
            description: sub.description,
            system_prompt: Some(sub.system_prompt),
            tools: sub.tools,
            required_plugins: Vec::new(),
            composio_actions: Vec::new(),
            skills: Vec::new(),
            identity_profile_ids: Vec::new(),
            identity_mode: crate::agents::AgentIdentityMode::default(),
            engine: None,
            model: sub.model,
            chat_model: None,
            stt: None,
            tts: None,
            image_model: None,
            video_model: None,
            memory: None,
            persona: None,
            policy_ref: None,
            schedules: Vec::new(),
        },
    };
    match state.agent_store.create(template.into_create_agent()).await {
        Ok(_) => crate::import::ImportOutcome::ok(kind::AGENT, &selection.id, &title),
        Err(e) => {
            crate::import::ImportOutcome::failed(kind::AGENT, &selection.id, &title, &e.to_string())
                .titled(title_msg)
        }
    }
}

/// The preferences key holding imported user slash commands: a JSON array of
/// `{ command, description?, body }`. Served into the composer's `/` menu and
/// expanded client-side (the body fills the input when the command is picked).
pub(in crate::server) const USER_SLASH_COMMANDS_PREF: &str = "user.slash-commands";

/// Read the imported user slash commands from the preferences store.
pub(in crate::server) async fn read_user_slash_commands(
    prefs: &PreferencesStore,
) -> Vec<serde_json::Value> {
    match prefs.get(USER_SLASH_COMMANDS_PREF).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Import a Codex slash-command prompt (`~/.codex/prompts/<name>.md`) into the
/// preferences-backed user command list, replacing any same-`/name` entry.
/// The command shows up in the composer's `/` menu (served alongside plugin
/// contributions) and expands to its prompt template when picked.
pub(in crate::server) async fn import_slash_command_item(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    use crate::import::kind;

    let path = match crate::import::resolve_item_path(root, &selection.id) {
        Ok(p) => p,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                kind::SLASH_COMMAND,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let Some(prompt) = crate::import::parse_codex_prompt(&path) else {
        return crate::import::ImportOutcome::failed_because(
            kind::SLASH_COMMAND,
            &selection.id,
            &selection.id,
            crate::i18n::messages::IMPORT_OUTCOME_UNREADABLE_CODEX_COMMAND_MESSAGE,
        );
    };
    let title_msg = crate::import::named_title(
        crate::i18n::messages::IMPORT_SLASH_COMMAND_TITLE_MESSAGE,
        &prompt.name,
    );
    let title = crate::import::english(&title_msg);
    let command = format!("/{}", prompt.name);
    let mut entry = serde_json::json!({ "id": format!("user.{}", prompt.name), "command": command, "body": prompt.body });
    if let Some(desc) = prompt.description {
        entry["description"] = serde_json::json!(desc);
    }

    let mut list: Vec<serde_json::Value> =
        match state.preferences.get(USER_SLASH_COMMANDS_PREF).await {
            Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
            _ => Vec::new(),
        };
    let existed = list
        .iter()
        .any(|e| e.get("command").and_then(|c| c.as_str()) == Some(command.as_str()));
    list.retain(|e| e.get("command").and_then(|c| c.as_str()) != Some(command.as_str()));
    list.push(entry);
    let value = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_owned());
    match state
        .preferences
        .set(USER_SLASH_COMMANDS_PREF, &value)
        .await
    {
        Ok(()) => {
            if existed {
                crate::import::ImportOutcome::already(kind::SLASH_COMMAND, &selection.id, &title)
            } else {
                crate::import::ImportOutcome::ok(kind::SLASH_COMMAND, &selection.id, &title)
            }
        }
        Err(e) => crate::import::ImportOutcome::failed(
            kind::SLASH_COMMAND,
            &selection.id,
            &title,
            &e.to_string(),
        )
        .titled(title_msg),
    }
}

/// Millis epoch (local clock) for import bookkeeping, matching the crate's
/// `now_millis()` conventions.
pub(in crate::server) fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write a single **enabled** MCP server entry into `~/.ryu/mcp.json` —
/// read-modify-write with an atomic tmp + rename, preserving unknown top-level
/// keys. Imported servers are the user's own config, so they land enabled
/// (unlike catalog installs, which force disabled). Conflicts refuse rather
/// than clobber.
pub(in crate::server) async fn write_imported_mcp_entry(
    name: &str,
    mut cfg: crate::sidecar::mcp::McpServerConfig,
) -> Result<(), (StatusCode, String)> {
    cfg.enabled = true;
    let name = name.to_string();
    crate::sidecar::mcp::McpConfigStore::mutate(
        crate::sidecar::mcp::McpRegistry::config_path(),
        move |document| {
            let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;
            if servers.contains_key(&name) {
                return Err(format!(
                    "conflict: MCP server '{name}' is already in mcp.json"
                ));
            }
            crate::sidecar::mcp::McpConfigStore::replace_server(servers, name, &cfg)?;
            Ok((true, ()))
        },
    )
    .await
    .map_err(|error| {
        let status = if error.starts_with("conflict:") {
            StatusCode::CONFLICT
        } else if error.contains("malformed") {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (
            status,
            error
                .strip_prefix("conflict: ")
                .unwrap_or(&error)
                .to_owned(),
        )
    })
}
