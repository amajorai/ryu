//! Registration of manifest-declared MCP servers.

use super::*;

/// The three MCP transports a config entry can name. `Http` is Streamable HTTP;
/// `Sse` is the deprecated HTTP+SSE transport retained for compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTransportKind {
    Stdio,
    Http,
    Sse,
}

/// Lower a manifest [`McpServerDecl`] (pure kernel-contracts data) into the
/// runtime [`McpServerConfig`] the registry spawns.
///
/// Resolution order for the program, highest priority first:
///
/// 1. **`command_env`** — when the declaration names an env var and that var is set to
///    a non-empty value (e.g. a path a downloader or `bun dev` wrote to `RYU_GHOST_BIN`),
///    it OVERRIDES `command`. Applied **unconditionally**, without checking that the
///    target exists: a stale override must fail loudly, naming the bad path, rather than
///    silently falling through to some other binary. (It is also what keeps
///    `ghost_manifest_is_skipped_when_no_ghost_binary_exists` deterministic on a host
///    that happens to have a real `~/.ryu/bin/ghost`.)
/// 2. **The managed bin dir** — a *bare* `command` (no path separator) that exists at
///    [`manifest_sidecar::managed_bin_path`] is lowered to that absolute path. This is
///    the generic, app-agnostic seam: every Ryu-managed binary is installed to
///    `<data dir>/bin` by `ensure_local_sidecar_present`, which is NOT on `PATH`, so
///    without this rung a manifest could only reach its own sidecar binary by declaring
///    a `command_env` that something else had to remember to seed. Nothing app-specific
///    lives here — no plugin id, no port, no capability string; the manifest's `command`
///    is the only input.
/// 3. **`command` verbatim** — resolved by `PATH` at spawn (`Command::new`), which is
///    what the lazy-package-runner idiom (`npx`/`bunx`/`uvx`) needs.
///
/// Rung 2 is what makes [`mcp_command_is_present`] answer `true` for a managed binary:
/// the lowered command carries a separator, so the probe takes its `Path::is_file()`
/// branch. That is also why the probe itself needs no change — it runs on the
/// **resolved** command, per the rules on [`register_manifest_mcp_servers`].
///
/// `version`/`catalog_id` are always `None` — a plugin-declared server is versioned by
/// its owning plugin, not the MCP catalog.
pub fn mcp_server_config_from_decl(
    decl: &crate::plugin_manifest::McpServerDecl,
) -> McpServerConfig {
    let env_override = decl
        .command_env
        .as_ref()
        .and_then(|var| std::env::var(var).ok())
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    // A remote declaration has no command to resolve at all — the three rungs
    // above are about locating a *binary*, and there isn't one. Resolving `None`
    // through them would produce `Some("")` and a spawn of the empty program.
    let declared = decl.command.as_deref().unwrap_or("");
    let command = match env_override {
        Some(overridden) => Some(overridden),
        None if declared.is_empty() => None,
        None => Some(managed_bin_fallback(declared).unwrap_or_else(|| declared.to_owned())),
    };
    McpServerConfig {
        command,
        transport: decl.transport.clone(),
        url: decl.url.clone(),
        headers: decl.headers.clone(),
        auth: decl.auth.clone(),
        owner_plugin_id: None,
        owner_server_name: None,
        cwd: None,
        args: decl.args.clone(),
        env: decl.env.clone(),
        description: decl.description.clone(),
        enabled: decl.enabled,
        version: None,
        catalog_id: None,
    }
}

/// The Gateway grant a Community-tier plugin must hold (**approved**) before Core
/// will register — and therefore spawn — the MCP servers its manifest declares.
///
/// A manifest `mcp_servers` entry is a verbatim `command` + `args` + `env` that the
/// next tool listing hands to `Command::new` (see `client.rs`). That is the same
/// arbitrary-code-execution class as [`crate::sidecar::manifest_sidecar::GRANT_SIDECAR_PROCESS`]
/// (`sidecar:process`) and `runtime:external`, so it is gated the same way instead
/// of riding on the mere presence of a `~/.ryu/plugins/<id>/manifest.json` — which
/// is user-writable and validated for nothing but semver + id uniqueness.
///
/// Like its two siblings this grant is deliberately **not** on the Gateway's
/// default allowlist (`mcp` is a reserved namespace there, so it can never be
/// owner-scope self-approved either). A Community plugin gets it only when an
/// operator adds it to `RYU_MARKETPLACE_GRANT_ALLOWLIST` — the same explicit,
/// out-of-band decision running an unsandboxed process already requires.
pub const GRANT_MCP_SERVER: &str = "mcp:server";

/// Whether a plugin may register its manifest-declared `mcp_servers`.
///
/// **Core**-tier packages are auto-allowed. Core tier is a reviewed capability
/// policy, not a statement that the package is embedded in the binary; official
/// marketplace packages may be installed on disk and still receive this gate.
/// **Community**-tier packages need the approved [`GRANT_MCP_SERVER`] grant.
///
/// `approved_grants` MUST be the Gateway-approved set
/// ([`crate::plugins::PluginRecord::approved_grants`]), never the manifest's
/// declared, unvalidated `permission_grants`. Fail-closed. Pure, so the gate is
/// unit-tested without a live enable — mirrors
/// [`crate::sidecar::manifest_sidecar::may_run_sidecar`] exactly.
pub fn may_register_mcp_servers(
    tier: crate::plugin_manifest::PluginTier,
    approved_grants: &[String],
) -> bool {
    match tier {
        crate::plugin_manifest::PluginTier::Core => true,
        crate::plugin_manifest::PluginTier::Community => {
            approved_grants.iter().any(|g| g == GRANT_MCP_SERVER)
        }
    }
}

/// Register every MCP server a plugin's manifest declares into `registry`.
///
/// The plugin enable/activation seam (`activate_plugin` + the boot
/// `fire_activation_event` loop). A no-op for the common case (a manifest with no
/// `mcp_servers`). Returns the server names registered, for logging. Idempotent:
/// re-activation re-registers the same names (overwriting in place).
///
/// **Gated** by [`may_register_mcp_servers`]: a Community-tier manifest without the
/// approved [`GRANT_MCP_SERVER`] grant registers nothing and returns an empty vec.
/// The gate lives HERE rather than at the call sites so every path into the
/// registry — enable, the `onStartup` re-register, and any future one — inherits it
/// (registration is what makes the declared command spawnable, so it is the real
/// choke point).
///
/// Each name is also **owned** by `manifest.id`: a registration whose name is
/// already held by a DIFFERENT plugin is refused and left out of the returned
/// names, so a late-installed plugin cannot repoint an established server name
/// (`ghost`, `agentbrowser`) at its own command.
///
/// # A server whose command cannot spawn is not offered to the model
///
/// Registration is what puts a server's tools into the next `tools/list`, so
/// registering a declaration whose command does not exist hands the model a block of
/// tools that every call ENOENTs on. `ghost` is the live instance: it is Core-tier
/// and pre-installed, so registration used to be unconditional, and Ghost's binary is
/// only ever fetched by its own downloader — whose `archive_url()` has no default, so
/// no end user has it. Every agent on a stock node therefore carried ~29 `ghost.*`
/// tools that could not run. A model cannot tell "this tool is broken" from "I called
/// it wrong", so it retries; an absent tool it simply routes around.
///
/// So each declaration is probed with [`mcp_command_is_present`] and skipped (warn,
/// fail-soft — never an error, never a boot failure) when its command cannot be
/// resolved. Three properties an implementer must keep:
///
/// * The probe runs on the **resolved** command — `mcp_server_config_from_decl` applies
///   `command_env` first (`RYU_GHOST_BIN`), then lowers a bare name that exists in the
///   Ryu-managed bin dir to its absolute path. So neither an operator pointing at a
///   binary outside `PATH` nor a Ryu-installed sidecar binary (which lands in
///   `<data dir>/bin`, a directory that is deliberately NOT on `PATH`) is told it is
///   missing. Keep every resolution rung in that one function: the probe below has no
///   knowledge of them and must not grow any.
/// * It probes the **runner, not the payload**. `agentbrowser` is
///   `npx -y agent-browser mcp`: the command is `npx`, which exists, and the package
///   is fetched lazily on first spawn. Probing `agent-browser` would break the whole
///   lazy-package-runner idiom (`npx`/`bunx`/`uvx`/`pipx`). Because the probe reads
///   `command` verbatim it gets this right with no exemption list — and if `npx`
///   itself is absent, skipping is still correct.
/// * A skip is **re-evaluated**, not remembered: the next boot's `onStartup` pass and
///   any re-enable run this again, so installing the binary and restarting Core (or
///   toggling the app) is all it takes. Nothing re-probes mid-process — an acceptable
///   cost for a lookup on a path that must stay synchronous and cheap.
/// * "Resolvable" must mean **spawnable by the code that actually spawns it**
///   (`client::connect` → `Command::new(&cmd.command)`), not merely "a file with that
///   name is on `PATH`". On Windows those differ: the runners this gate exists for
///   ship as `npx.cmd` / `bunx.cmd`, and `std` only ever appends `.exe` to a bare
///   name. The probe counts a `.cmd`/`.bat` shim as present ONLY because
///   [`spawn_program_for`] rewrites such a command to its full resolved path before
///   the spawn, and every registry spawn reaches `client` through
///   [`McpServerConfig::to_target`], which calls it on its stdio branch. Break that
///   rewrite and this gate
///   silently starts passing commands that cannot spawn — the exact failure it exists
///   to prevent, for exactly the `npx` case above.
///
/// One consequence: a skipped name is not *owned* either, so it stays claimable. That
/// is not a new hole — claiming it still requires the `mcp:server` grant, which is
/// off the Gateway's default allowlist and can never be owner-scope self-approved.
pub fn register_manifest_mcp_servers(
    registry: &McpRegistry,
    manifest: &PluginManifest,
    tier: crate::plugin_manifest::PluginTier,
    approved_grants: &[String],
) -> Vec<String> {
    if manifest.mcp_servers.is_empty() {
        return Vec::new();
    }
    if !may_register_mcp_servers(tier, approved_grants) {
        tracing::warn!(
            "plugin '{}' declares {} MCP server(s) but is Community-tier without an approved \
             '{GRANT_MCP_SERVER}' grant; registration is skipped (fail-closed) — the declared \
             commands are never spawned",
            manifest.id,
            manifest.mcp_servers.len()
        );
        return Vec::new();
    }
    // The app's lazy / idle-stopped sidecars: a tool call on any of its stdio
    // servers wakes them first (see `McpRegistry::wake_owner_sidecars`).
    registry.set_wake_sidecars(
        &manifest.id,
        manifest
            .sidecars
            .iter()
            .filter(|spec| spec.lazy || spec.idle_stop_secs.is_some())
            .map(|spec| crate::sidecar::manifest_sidecar::namespaced_name(&manifest.id, &spec.name))
            .collect(),
    );
    let mut names = Vec::new();
    for (name, decl) in &manifest.mcp_servers {
        let mut config = mcp_server_config_from_decl(decl);
        config.owner_plugin_id = Some(manifest.id.clone());
        config.owner_server_name = Some(name.clone());
        config.cwd = installed_plugin_dir(&manifest.id);
        let anchored = match (config.cwd.as_deref(), config.command.as_deref()) {
            (Some(cwd), Some(command)) => match anchor_relative_command(command, cwd) {
                Ok(anchored) => anchored,
                Err(()) => {
                    tracing::warn!(
                        "plugin '{}' declares MCP server '{name}' with a command ('{command}') \
                         that leaves its package directory; registration is skipped",
                        manifest.id
                    );
                    continue;
                }
            },
            _ => None,
        };
        if anchored.is_some() {
            config.command = anchored;
        }
        if !mcp_server_is_present(&config) {
            tracing::warn!(
                "plugin '{}' declares MCP server '{name}' but its command '{}' is not \
                 installed (no `command_env` override, absent from {}, not on PATH, and not \
                 an existing file); registration is skipped so the model is not offered tools \
                 that cannot spawn. Install it and restart Core (or re-enable the app) to pick \
                 it up",
                manifest.id,
                config.command.as_deref().unwrap_or("(none)"),
                crate::sidecar::download_manager::bin_dir().display()
            );
            continue;
        }
        if registry.register_server(&manifest.id, name.clone(), config) {
            names.push(name.clone());
        }
    }
    names
}

/// Deregister every MCP server a plugin's manifest declares from `registry`.
///
/// The symmetric teardown seam (`deactivate_plugin`, reached by both disable and
/// uninstall). A no-op for a manifest with no `mcp_servers`.
///
/// Ownership-checked: a plugin only tears down the names IT registered. Without
/// this, uninstalling a plugin that merely *declared* `ghost` would deregister the
/// real Ghost server until the next Core restart (a cross-plugin DoS).
pub fn deregister_manifest_mcp_servers(registry: &McpRegistry, manifest: &PluginManifest) {
    for name in manifest.mcp_servers.keys() {
        registry.deregister_server(&manifest.id, name);
    }
    registry.set_wake_sidecars(&manifest.id, Vec::new());
}

#[cfg(test)]
#[path = "tests/manifest_servers.rs"]
mod tests;
