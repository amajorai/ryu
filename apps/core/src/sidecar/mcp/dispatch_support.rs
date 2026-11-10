//! Ghost cursor, plugin caller scope and desktop-reach helpers for dispatch.

use super::*;

const GHOST_CURSOR_ACTIONS: &[&str] = &[
    "ghost_click",
    "ghost_type",
    "ghost_press",
    "ghost_hotkey",
    "ghost_scroll",
    "ghost_hover",
    "ghost_long_press",
    "ghost_drag",
    "ghost_run",
];

/// Whether `server` is Ghost, the desktop-control server, as registered by
/// its own plugin.
pub(super) fn is_ghost_server(server: &str, config: &McpServerConfig) -> bool {
    server == GHOST_SERVER && config.owner_plugin_id.as_deref() == Some("@ryu/ghost")
}

/// `_meta` key carrying the server-derived principal of a plugin MCP call.
pub(crate) const PLUGIN_CALLER_META_KEY: &str = "ryu/caller";

/// Whether a call to this MCP server carries the caller's verified principal.
///
/// Only a plugin-owned, local (stdio) server receives it: the same trust boundary
/// as the `x-ryu-caller-user-id` / `x-ryu-caller-org-id` headers the ext-proxy
/// stamps on a plugin sidecar hop, and on a pipe Core owns end to end, so a
/// plugin can authorize its own stored resources per user. User-configured and
/// remote servers never receive it.
pub(super) fn carries_plugin_caller_scope(config: &McpServerConfig) -> bool {
    config.owner_plugin_id.is_some() && config.transport_kind() == McpTransportKind::Stdio
}

/// The out-of-band caller scope for a plugin MCP call. Built only from the
/// dispatch-time [`ToolPrincipal`], never from tool arguments, so the model
/// cannot select another principal. `unresolved` tells the plugin that a shared
/// node could not resolve the caller, so it can fail closed.
pub(super) fn plugin_caller_scope_meta(principal: &ToolPrincipal) -> Value {
    match principal {
        ToolPrincipal::Unrestricted => serde_json::json!({ "kind": "node" }),
        ToolPrincipal::Owned { user_id, org_id } => serde_json::json!({
            "kind": "user",
            "userId": user_id,
            "orgId": org_id,
        }),
        ToolPrincipal::Unresolved => serde_json::json!({ "kind": "unresolved" }),
    }
}

pub(super) fn is_ghost_cursor_action(server: &str, tool: &str, config: &McpServerConfig) -> bool {
    is_ghost_server(server, config) && GHOST_CURSOR_ACTIONS.contains(&tool)
}

/// Whether a tool backend URL reads Core's desktop-capture API (`/api/shadow/*`),
/// which serves what Shadow captured from the user's screen, audio and input,
/// so a tool that calls it needs desktop access like Ghost. Matched on the
/// route, not on an app id, so any app's tool that reaches it is covered.
pub(super) fn url_reads_desktop_captures(url: &str) -> bool {
    let Some(path) = url.strip_prefix(crate::tool_exec::CORE_URL_SCHEME) else {
        return false;
    };
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    matches!(
        (segments.next(), segments.next()),
        (Some(api), Some(shadow))
            if api.eq_ignore_ascii_case("api") && shadow.eq_ignore_ascii_case("shadow")
    )
}

/// Whether an app reads or drives the user's own desktop, judged from what its
/// manifest declares: it provides `computer.control` on this machine, or ships
/// a tool that reads Core's desktop-capture API.
pub(super) fn manifest_reaches_user_desktop(manifest: &PluginManifest) -> bool {
    let drives_this_machine = manifest.provided_capabilities().iter().any(|entry| {
        entry.capability == capability_tools::CAP_COMPUTER
            && entry.target == Some(crate::plugin_manifest::ProviderTarget::LocalMachine)
    });
    drives_this_machine
        || manifest.runnables.iter().any(|entry| {
            entry
                .config
                .as_ref()
                .and_then(|config| config.get("url"))
                .and_then(Value::as_str)
                .is_some_and(url_reads_desktop_captures)
        })
}

pub(super) fn cursor_identity_text(value: Option<&str>, limit: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(limit).collect())
}

/// Build the [`ryu_tool_exec::SandboxAugment`] for a `child_process`-capable
/// inline plugin tool: materialize the plugin's capability CLI shims and return a
/// scoped `--allow-run` allow-list (the shim program NAMES) plus the env the shims
/// authenticate the broker with.
///
/// The env layers, in order: the shim-prepended `PATH` + `RYU_CORE_PORT`
/// (`cli_shims::inject_shim_env`) and the per-plugin `RYU_EXT_TOKEN` +
/// `RYU_EXT_PLUGIN_ID` (`ext_proxy::ext_token`) — the same three vars a native
/// sidecar receives at spawn. These are handed to the backend as `extra_env` and
/// applied AFTER the secret-key scrub, so the freshly-minted token is delivered
/// rather than stripped (the scrubber blocks LEAKING Core's inherited secrets, not
/// the host handing the child a token minted for exactly this run).
///
/// Best-effort: on a materialize failure it logs and returns
/// an explicit scoped run list (with no shim env), never widening to a bare
/// `--allow-run` permission.
pub(super) async fn build_cap_shim_augment(
    plugin_id: &str,
    permissions: Option<&crate::plugin_manifest::PermissionSet>,
) -> ryu_tool_exec::SandboxAugment {
    let plugin_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(plugin_id));
    // The plugin's DECLARED capability edges → convenience-alias shims + the
    // scoped run allow-list. Empty is fine (the `ryu-cap` multiplexer still covers
    // every capability); only the convenience aliases are gated on this set.
    let declared: Vec<String> = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == plugin_id)
        .map(|m| {
            m.required_capabilities()
                .iter()
                .map(|c| c.capability.clone())
                .collect()
        })
        .unwrap_or_default();
    let mut run_allow = crate::sidecar::cli_shims::shim_names(&declared);
    if let Some(permissions) = permissions {
        run_allow.extend(permissions.run.iter().cloned());
    }
    run_allow.sort();
    run_allow.dedup();

    match crate::sidecar::cli_shims::materialize(&plugin_dir, &declared).await {
        Ok(shim_dir) => {
            let mut env = std::collections::BTreeMap::new();
            crate::sidecar::cli_shims::inject_shim_env(&mut env, &shim_dir);
            let token = crate::sidecar::ext_proxy::ext_token(
                crate::sidecar::ext_proxy::node_token().as_deref(),
                plugin_id,
            );
            env.insert(crate::sidecar::ext_proxy::ENV_EXT_TOKEN.to_owned(), token);
            env.insert(
                crate::sidecar::ext_proxy::ENV_EXT_PLUGIN_ID.to_owned(),
                plugin_id.to_owned(),
            );
            ryu_tool_exec::SandboxAugment {
                run_allow,
                extra_env: env.into_iter().collect(),
            }
        }
        Err(e) => {
            tracing::warn!(
                plugin_id = %plugin_id,
                error = %e,
                "could not materialize capability CLI shims for inline tool; \
                 retaining only the manifest executable allowlist"
            );
            // Keep subprocess execution scoped even if shim materialization fails.
            // Explicit binaries may still work from PATH; capability aliases fail
            // closed instead of widening to a bare `--allow-run`.
            ryu_tool_exec::SandboxAugment {
                run_allow,
                extra_env: Vec::new(),
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/dispatch_support.rs"]
mod tests;
