//! MCP entries and tool calls from sidecars, ACP agents and host conversations: `synthesize_mcp_manifest` through `list_mcp_tools`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Create the plugin lifecycle record + on-disk manifest for a freshly-installed
/// MCP server, so the ONE plugin model governs it (requires / targets / grants /
/// AppGate / disable / uninstall) rather than a parallel registry.
///
/// The record is installed **DISABLED**, mirroring the mcp.json entry the catalog
/// install just wrote. The mcp.json entry remains the authoritative spawn config
/// and tool executor (`list_all_tools` / `call_tool` still read the server map);
/// this record is additive governance metadata. The synthesized manifest declares
/// **no runnables** (so it never double-lists the server's tools — the server map
/// is the single tool source) and holds the `widget:render` grant so that, once
/// the server's widget-bearing tools are recorded in `contributes.widgets`, the
/// promotion gate approves them.
///
/// Best-effort by contract: every failure is logged and swallowed — the MCP
/// install already succeeded, and a missing governance record must never fail it.
/// Synthesize the governance manifest for an installed MCP server.
///
/// Pure (no I/O) so the install sink and its tests share exactly one definition of
/// the record's shape. The MCP server name is the plugin id: external servers
/// self-namespace their tools as `server.tool`, so `id == server_name` lets the
/// plugin model resolve the owner of any such tool. Returns `None` when the server
/// name is not a valid plugin id (the caller then skips the record, best-effort).
///
/// The manifest declares **no runnables** (the mcp.json server map stays the tool
/// executor this pass, so runnables would double-list — Risk 4) and holds the
/// `widget:render` grant so that, once the server's widget tools are recorded in
/// `contributes.widgets`, the promotion gate approves them.
pub(in crate::server) fn synthesize_mcp_manifest(
    plan: &crate::mcp_catalog::InstallPlan,
) -> Option<crate::plugin_manifest::PluginManifest> {
    if crate::plugin_manifest::validate_plugin_id(&plan.server_name).is_err() {
        return None;
    }
    // A plugin record requires a valid semver version; the mcp.json entry keeps the
    // catalog's raw version string, so falling back here is cosmetic only.
    let version = plan
        .version
        .as_deref()
        .filter(|v| semver::Version::parse(v).is_ok())
        .unwrap_or("0.0.0")
        .to_owned();
    Some(crate::plugin_manifest::PluginManifest {
        id: plan.server_name.clone(),
        name: plan.server_name.clone(),
        version,
        runnables: Vec::new(),
        permission_grants: vec![crate::sidecar::mcp::WIDGET_RENDER_GRANT.to_owned()],
        description: plan.description.clone(),
        category: Some(crate::sidecar::mcp::MCP_SERVER_CATEGORY.to_owned()),
        ..Default::default()
    })
}

pub(in crate::server) async fn persist_mcp_plugin_record(
    state: &ServerState,
    plan: &crate::mcp_catalog::InstallPlan,
) {
    let Some(manifest) = synthesize_mcp_manifest(plan) else {
        tracing::warn!(
            server = %plan.server_name,
            "MCP install: skipping plugin-governance record — '{}' is not a valid plugin id",
            plan.server_name
        );
        return;
    };

    match persist_installed_plugin(state, manifest, None, None).await {
        Ok(_) => tracing::info!(
            server = %plan.server_name,
            "MCP install: created disabled plugin-governance record"
        ),
        // Already recorded (e.g. a forced re-install over an existing plugin) —
        // benign; the record and manifest are left as-is.
        Err((StatusCode::CONFLICT, msg)) => tracing::debug!(
            server = %plan.server_name,
            "MCP install: plugin-governance record already present ({msg})"
        ),
        Err((status, msg)) => tracing::warn!(
            server = %plan.server_name,
            "MCP install: could not create plugin-governance record ({status}): {msg}"
        ),
    }
}

/// Write a single **disabled** MCP server entry into `~/.ryu/mcp.json`,
/// read-modify-write with an atomic tmp + rename. Shared shape with
/// [`create_mcp_server`] but forces `enabled: false` so a catalog install never
/// auto-launches a registry-supplied command.
///
/// Takes an **assembled `McpServerConfig`** rather than the six positional
/// `&str`/`Option<&str>` params it used to. That was already at the edge of safe
/// — `description`, `version` and `catalog_id` are three adjacent, mutually
/// swappable `Option<&str>`s that the compiler cannot tell apart — and adding the
/// remote transport would have pushed it past ten, with `url` and `transport`
/// joining the same interchangeable run. A caller that transposes two of those
/// writes a config that parses fine and is simply wrong, which is the worst kind
/// of bug to find later. One struct argument makes every field named at the call
/// site.
///
/// `enabled` is still forced to `false` here, not trusted from the caller, so the
/// "an install never auto-launches" guarantee survives the signature change.
pub(in crate::server) async fn write_mcp_entry(
    name: &str,
    mut new_cfg: crate::sidecar::mcp::McpServerConfig,
    // When true, overwrite an existing entry (used by the update flow) instead of
    // refusing on a name collision — preserving its `enabled`, `env`, `headers`,
    // `auth` and owner.
    force: bool,
) -> Result<(), (StatusCode, String)> {
    let name = name.to_string();
    // Installed disabled — never auto-launch on install, whatever the caller set.
    new_cfg.enabled = false;
    crate::sidecar::mcp::McpConfigStore::mutate(
        crate::sidecar::mcp::McpRegistry::config_path(),
        move |document| {
            let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;
            if let Some(existing) = servers.get(&name) {
                if force {
                    let existing: crate::sidecar::mcp::McpServerConfig =
                        serde_json::from_value(existing.clone()).map_err(|error| {
                            format!("bad_request: invalid MCP server entry: {error}")
                        })?;
                    new_cfg.enabled = existing.enabled;
                    new_cfg.env = existing.env;
                    // An update must not log the user out: the catalog entry
                    // carries no secrets, so a hosted server's API-key headers
                    // and OAuth config come from the existing entry (its values
                    // win over any placeholder the new entry declares), and so
                    // does the owning plugin.
                    new_cfg.headers.extend(existing.headers);
                    if new_cfg.auth.is_none() {
                        new_cfg.auth = existing.auth;
                    }
                    if new_cfg.owner_plugin_id.is_none() {
                        new_cfg.owner_plugin_id = existing.owner_plugin_id;
                        new_cfg.owner_server_name = existing.owner_server_name;
                    }
                } else {
                    return Err(format!(
                        "conflict: MCP server '{name}' is already in mcp.json"
                    ));
                }
            }
            crate::sidecar::mcp::McpConfigStore::replace_server(servers, name, &new_cfg)?;
            Ok((true, ()))
        },
    )
    .await
    .map_err(|error| {
        let status = if error.starts_with("conflict:") {
            StatusCode::CONFLICT
        } else if error.starts_with("bad_request:") || error.contains("malformed") {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (
            status,
            error
                .strip_prefix("conflict: ")
                .or_else(|| error.strip_prefix("bad_request: "))
                .unwrap_or(&error)
                .to_owned(),
        )
    })
}

/// An in-place mutation of a single `~/.ryu/mcp.json` entry, used to keep the
/// spawn config in sync with the ONE plugin model's lifecycle for a synth
/// MCP-server record (`category == MCP_SERVER_CATEGORY`).
#[derive(Clone, Copy)]
pub(in crate::server) enum McpEntryMutation {
    /// Flip the entry's `enabled` flag — the flag that actually gates spawn +
    /// tool listing. Wired to the plugin enable/disable lifecycle so the record's
    /// enabled bit is no longer a no-op against the running server.
    SetEnabled(bool),
    /// Remove the entry entirely — wired to plugin uninstall so removing the
    /// governance record actually uninstalls the server (stops it + drops its
    /// tools) instead of leaving a running orphan.
    Remove,
}

/// Apply [`McpEntryMutation`] to the entry `name` in the mcp.json at `cfg_path`,
/// read-modify-write with an atomic tmp + rename. Preserves the `mcpServers`
/// schema and every other entry untouched. Returns `Ok(true)` when the file
/// changed, `Ok(false)` when the entry was absent / already in the target state
/// (a no-op). Path-injected so tests drive it against a temp file with no env or
/// cross-module lock.
pub(in crate::server) async fn mutate_mcp_entry(
    cfg_path: std::path::PathBuf,
    name: &str,
    mutation: McpEntryMutation,
) -> Result<bool, String> {
    let name = name.to_string();
    crate::sidecar::mcp::McpConfigStore::mutate(cfg_path, move |document| {
        let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;

        if let McpEntryMutation::Remove = mutation {
            let changed = servers.remove(&name).is_some();
            return Ok((changed, changed));
        }

        let Some(entry) = servers.get_mut(&name) else {
            return Ok((false, false));
        };
        let changed = match mutation {
            McpEntryMutation::SetEnabled(enabled) => {
                let Some(object) = entry.as_object_mut() else {
                    return Err(format!("MCP server '{name}' is not an object"));
                };
                let current = object
                    .get("enabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);
                if current == enabled {
                    false
                } else {
                    object.insert("enabled".to_owned(), serde_json::json!(enabled));
                    true
                }
            }
            McpEntryMutation::Remove => {
                unreachable!("remove is handled before borrowing the entry")
            }
        };
        Ok((changed, changed))
    })
    .await
}

/// Keep the `~/.ryu/mcp.json` spawn config in sync when a synth MCP-server plugin
/// record's lifecycle changes. Best-effort by contract (mirrors
/// `persist_mcp_plugin_record`): a mcp.json write/reload failure is logged and
/// swallowed — the lifecycle record is the source of truth for the response, and
/// this sync is a side effect that must never fail the enable/disable/uninstall.
///
/// No-op for any manifest that is not a synth MCP-server record, so the 8
/// built-in apps and every ordinary plugin are untouched (they set no
/// `category`, so the guard excludes them).
pub(in crate::server) async fn sync_mcp_entry_for_record(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    mutation: McpEntryMutation,
) {
    if manifest.category.as_deref() != Some(crate::sidecar::mcp::MCP_SERVER_CATEGORY) {
        return;
    }
    let path = crate::sidecar::mcp::McpRegistry::config_path();
    match mutate_mcp_entry(path, &manifest.id, mutation).await {
        Ok(true) => {
            // The server map changed — hot-reload so spawn/list reflects it.
            state.mcp.reload();
            tracing::info!(
                server = %manifest.id,
                "MCP-server plugin lifecycle: synced mcp.json spawn config"
            );
        }
        Ok(false) => {
            tracing::debug!(
                server = %manifest.id,
                "MCP-server plugin lifecycle: mcp.json already in target state (no-op)"
            );
        }
        Err(e) => tracing::warn!(
            server = %manifest.id,
            "MCP-server plugin lifecycle: mcp.json sync failed (best-effort): {e}"
        ),
    }
}

/// `GET /api/mcp/tools` — list every tool across registered MCP servers. An
/// optional `?agent=<id>` narrows the list to that agent's allowlist.
///
/// ## App-enable filtering (AC3)
///
/// Tools whose slug is *declared* by at least one loaded App manifest (via
/// `permission_grants: ["mcp:<slug>"]`) are only included when at least one
/// app that claims them is currently **enabled**. Tools not claimed by any
/// app are always included — they are standalone/built-in MCP tools.
///
/// ## Core-vs-Gateway boundary
///
/// This is a list-time *visibility* filter, not a policy gate. Grant
/// *enforcement* — whether the agent is actually allowed to call the tool —
/// belongs to the Gateway. Core decides what *runs*; Gateway decides what
/// is *allowed*.
#[utoipa::path(
    get,
    path = "/api/mcp/tools",
    tag = "MCP",
    summary = "List available MCP tools",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_mcp_tools(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    list_mcp_tools_for(
        &state,
        caller.as_ref(),
        params.get("agent").map(String::as_str),
        None,
        None,
    )
    .await
}
