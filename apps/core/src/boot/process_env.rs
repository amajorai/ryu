/// Seed the profile-aware env vars the Ghost MCP server needs, which its plugin
/// manifest (`fixtures/ghost.manifest.json`) can't express statically. Called once,
/// early in `main` (before threads spawn), so the values are present when the
/// manifest decl is lowered and when the Ghost child is later spawned:
/// - `RYU_GHOST_BIN` → the profile-scoped `<data dir>/bin/ghost` path,
///   consumed at lowering time by `mcp_server_config_from_decl` (`command_env`);
/// - `RYU_GHOST_OVERLAY_URL` → the island loopback overlay endpoint (profile port
///   math mirrors `control.ts`: base 7989, +1000 for dev), so Ghost's pointer
///   actions drive the visible ghost-cursor overlay (fire-and-forget; a dead port
///   is a harmless no-op);
/// - `GHOST_DATA_DIR` → the per-profile `<data dir>/services/ghost` state dir
///   (isolating dev vs release), read by Ghost's recipe and snapshot stores;
/// - `GHOST_MODELS_DIR` → `<data dir>/models/vision/ghost`, where Ghost looks for
///   its ShowUI vision model.
///
/// Set-if-unset: a user-provided value wins, matching `profile::apply_env_defaults`.
/// The latter three reach the scrubbed Ghost child via the `mcp_safe_env` allowlist.
pub(super) fn seed_ghost_sidecar_env() {
    let set_if_unset = |key: &str, value: String| {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    };
    set_if_unset(
        "RYU_GHOST_BIN",
        crate::sidecar::tools::ghost::ghost_bin_path()
            .to_string_lossy()
            .into_owned(),
    );
    set_if_unset(
        "RYU_GHOST_OVERLAY_URL",
        format!(
            "http://127.0.0.1:{}/ghost-cursor",
            crate::profile::port(7989)
        ),
    );
    set_if_unset(
        "GHOST_DATA_DIR",
        crate::sidecar::tools::ghost::data_dir()
            .to_string_lossy()
            .into_owned(),
    );
    set_if_unset(
        "GHOST_MODELS_DIR",
        crate::sidecar::tools::ghost::models_dir()
            .to_string_lossy()
            .into_owned(),
    );
}

/// Protect secrets held by Core, including Gateway keys generated after boot,
/// from same-UID ACP and shell children through Linux procfs and ptrace.
pub(super) fn protect_privileged_process_environment() -> anyhow::Result<()> {
    ryu_gw_credentials::protect_process_environment()
}

/// `ryu-core acp [--agent <id>] [--core-url <url>]`: run as an Agent Client
/// Protocol agent on stdio so an ACP editor can drive Ryu agents.
///
/// This is a client of an ALREADY RUNNING Core, not a second Core: it opens no
/// store and starts no sidecar. Core's own path and profile resolution pick the
/// local listener and the node-auth token file, so the subcommand reaches the
/// same node, with the same credential, as every other local surface. Stdout is
/// reserved for protocol frames; diagnostics go to stderr.
pub(super) async fn run_acp_server_subcommand() -> i32 {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let options = match ryu_acp_server::CliOptions::parse(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("ryu-core acp: {error}\n\n{}", ryu_acp_server::USAGE);
            return 2;
        }
    };
    if options.help {
        print!("{}", ryu_acp_server::USAGE);
        return 0;
    }
    let default_bind = std::env::var("RYU_BIND")
        .ok()
        .filter(|bind| !bind.trim().is_empty())
        .unwrap_or_else(|| format!("127.0.0.1:{}", crate::profile::port(7980)));
    let endpoint = ryu_acp_server::CoreEndpoint::resolve(
        options.core_url.as_deref(),
        &default_bind,
        &crate::node_token::token_path(),
    );
    let config = ryu_acp_server::ServerConfig {
        endpoint,
        agent: options.agent,
    };
    match ryu_acp_server::run_stdio(config).await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("ryu-core acp: {}", error.message);
            1
        }
    }
}
