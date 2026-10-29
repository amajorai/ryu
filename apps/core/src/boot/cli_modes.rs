use super::*;

/// Pre-boot mode switches of `core_main`. `None` means the process already did
/// what was asked and `core_main` returns; `Some` carries `offline_test_bootstrap`.
pub(super) async fn run_cli_modes() -> Option<bool> {
    // Before every other mode switch: an editor-launched ACP agent must never
    // print anything but protocol frames on stdout (`--version` included).
    if std::env::args().nth(1).as_deref() == Some("acp") {
        std::process::exit(run_acp_server_subcommand().await);
    }
    if std::env::args().any(|argument| argument == "--version") {
        println!("ryu-core {}", env!("CARGO_PKG_VERSION"));
        return None;
    }
    // The Ryu-managed Codex PreToolUse hook must be able to run without
    // starting the Core server or opening any durable state. Keep this before
    // every normal boot path so the hook is a pure JSON-in/JSON-out guard.
    if crate::codex_config::run_safe_delete_hook_if_requested() {
        return None;
    }

    if let Err(error) = protect_privileged_process_environment() {
        eprintln!("refusing to start Core with privileged Gateway secrets: {error}");
        std::process::exit(1);
    }
    let offline_test_bootstrap = match crate::offline_test_bootstrap::requested() {
        Ok(active) => active,
        Err(error) => {
            eprintln!("refusing offline test bootstrap: {error}");
            std::process::exit(1);
        }
    };
    if offline_test_bootstrap {
        eprintln!("offline test bootstrap active: unrelated discovery, provisioning and auto-start disabled");
    }

    // Emit the OpenAPI spec and exit — keeps stdout clean (before tracing init)
    // so `ryu-core --dump-openapi > core-openapi.json` is well-formed. The spec
    // is static (derived from handler annotations), so no server state is needed.
    if std::env::args().any(|a| a == "--dump-openapi") {
        // `api_doc()` folds in the feature-gated leaf sub-docs (research/clips/
        // recipes) so the dumped spec matches what `GET /api/openapi.json` serves.
        let spec = crate::server::openapi::api_doc();
        match spec.to_pretty_json() {
            Ok(json) => println!("{json}"),
            Err(e) => {
                eprintln!("failed to serialize OpenAPI spec: {e}");
                std::process::exit(1);
            }
        }
        return None;
    }

    // One-shot data-folder maintenance: `ryu-core data-path <migrate|import|export>`.
    // Runs while the desktop has Core STOPPED (so no SQLite handles are open) and
    // streams `@@PROGRESS {json}` lines to stdout. Done before tracing init to keep
    // that stream clean. On success it updates the pointer; the desktop then restarts
    // Core, which re-resolves the data dir from the pointer.
    {
        let args: Vec<String> = std::env::args().collect();
        if crate::data_path::run_cli(&args) {
            return None;
        }
    }

    crate::log_rotation::initialize_from_env();

    // RYU_PROFILE stack isolation: seed the profile-derived env defaults (data
    // dir, core bind, gateway URL + config, Shadow URL, embed/rerank URLs) BEFORE
    // anything caches a path/port or resolves the data dir. No-op on the default
    // `release` profile, and any env var the user already set wins. The matching
    // sidecar SPAWN ports are threaded through `profile::port` in `sidecar/**`.
    crate::profile::apply_env_defaults();

    // `ryu-core gateway-seal-env`: hand an externally managed Gateway the
    // subkey that seals `gateway.toml` secrets. Needs only the data dir and the
    // master key, so it runs before any store, lease or sidecar starts.
    if std::env::args().nth(1).as_deref() == Some("gateway-seal-env") {
        crate::crypto_host::install();
        std::process::exit(crate::sidecar::gateway::run_seal_env_subcommand());
    }

    // `ryu-core keys status|adopt|retire`: the recovery path every master-key
    // refusal points to. Runs before any store opens or key is resolved for
    // serving, so it works on a data folder Core refuses to boot on.
    if std::env::args().nth(1).as_deref() == Some("keys") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        match crate::crypto_host::run_keys_cli(&args) {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
        }
    }
    Some(offline_test_bootstrap)
}
