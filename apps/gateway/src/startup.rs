//! Startup policy for the Gateway process: the auth and CORS posture it
//! refuses or admits, the `gateway.toml` sealing key it captures, and the
//! boot-time log lines and housekeeping loops `run` starts.

use std::{sync::Arc, time::Duration};

use axum::http::HeaderValue;
use tower_http::cors::{Any, CorsLayer};

use crate::{api, config, config::GatewayConfig, state::AppState};

/// Whether startup must refuse a Gateway whose auth is disabled: on a
/// non-loopback bind, or with exposure hardening on
/// ([`crate::custody::exposure_hardened`]), where a loopback listener sits behind a
/// load balancer and proves nothing.
pub(crate) fn auth_disabled_startup_rejected(
    bind_addr: &str,
    exposure_hardened: bool,
    require_auth: bool,
) -> bool {
    if require_auth {
        return false;
    }
    let is_loopback_bind = bind_addr
        .parse::<std::net::SocketAddr>()
        .map(|address| address.ip().is_loopback())
        .unwrap_or_else(|_| {
            bind_addr
                .rsplit_once(':')
                .is_some_and(|(host, _)| host == "localhost")
        });
    !is_loopback_bind || exposure_hardened
}

/// The startup line naming the gateway.toml this process reads. `Err` (logged
/// as a warning) when no file is there: `GatewayConfig::load` then runs on
/// built-in defaults, and a config placed at the wrong path must not be ignored
/// silently.
pub(crate) fn config_file_notice(path: Option<&std::path::Path>) -> Result<String, String> {
    match path {
        Some(path) if path.is_file() => Ok(format!("configuration file: {}", path.display())),
        Some(path) => Err(format!(
            "no configuration file at {}; running on built-in defaults (set GATEWAY_CONFIG \
             to the path of your gateway.toml)",
            path.display()
        )),
        None => Err(
            "cannot determine a configuration path; running on built-in defaults (set \
             GATEWAY_CONFIG to the path of your gateway.toml)"
                .to_owned(),
        ),
    }
}

/// The hosted Ryu web app's origin. Its editor AI calls the user's local,
/// Core-managed Gateway from the browser.
pub(crate) const HOSTED_WEB_ORIGIN: &str = "https://app.ryuhq.com";

/// Whether CORS admits [`HOSTED_WEB_ORIGIN`]. An explicit
/// `RYU_CORS_ALLOW_HOSTED_WEB` (`1`/`true`/`on` or `0`/`false`/`off`) wins.
/// Otherwise it is admitted only for a Gateway paired with Ryu: one that holds a
/// trusted Core relay credential (Core-managed or hosted) or has Fleet custody.
/// A plain self-hosted Gateway does not trust a Ryu-hosted page by default, even
/// when it sets the fleet flag for exposure hardening.
pub(crate) fn hosted_web_origin_allowed(
    explicit: Option<&str>,
    core_paired: bool,
    fleet_custody: bool,
) -> bool {
    match explicit
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("1" | "true" | "on" | "yes") => true,
        Some("0" | "false" | "off" | "no") => false,
        _ => core_paired || fleet_custody,
    }
}

/// The CORS origin allowlist: local desktop/webapp dev and Tauri origins, the
/// hosted web app when [`hosted_web_origin_allowed`], plus comma-separated
/// `RYU_CORS_ORIGINS` extras.
/// The CORS layer for an origin allowlist. Exposes the Gateway's response
/// headers (request id, rate-limit signals, routing) so browser callers can
/// read them, not only the body.
pub(crate) fn cors_layer(origins: Vec<HeaderValue>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(api::http_conventions::exposed_headers())
        .allow_private_network(true)
}

pub(crate) fn cors_allowed_origins(
    allow_hosted_web: bool,
    extra: Option<&str>,
) -> Vec<HeaderValue> {
    let mut origins: Vec<&str> = vec![
        "http://localhost:5173",   // desktop vite dev
        "http://localhost:5174",   // webapp vite dev
        "http://127.0.0.1:5173",   // desktop vite dev (127 variant)
        "http://127.0.0.1:5174",   // webapp vite dev (127 variant)
        "http://localhost:1420",   // tauri dev
        "tauri://localhost",       // tauri prod (macOS/Linux)
        "https://tauri.localhost", // tauri prod (Windows)
        "http://tauri.localhost",  // tauri prod (Windows alt)
    ];
    if allow_hosted_web {
        origins.push(HOSTED_WEB_ORIGIN);
    }
    origins.extend(
        extra
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty()),
    );
    origins
        .into_iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect()
}

/// How this process got the key that seals `gateway.toml` secrets. Logged once
/// tracing is up; never carries key material.
pub(crate) enum SealKeyStatus {
    /// Core derived the Gateway subkey and passed it in the spawn environment.
    Delivered,
    /// A standalone Gateway derived it from the master key it resolved itself.
    Resolved,
    /// No key: plaintext files still load, sealed ones and new secrets fail.
    Unavailable(String),
}

/// Take the `gateway.toml` sealing key into memory and out of the environment.
///
/// Runs before the tokio runtime starts any thread (editing the environment
/// while another thread reads it is unsound). A Core-spawned Gateway receives
/// only its component subkey (`RYU_SEAL_KEY`); a standalone Gateway resolves
/// the master key (`RYU_MASTER_KEY`, or the data-dir key file under
/// `RYU_KEYCHAIN=off`) and derives the same subkey. Either way every
/// key-carrying variable is then removed, so no MCP server, channel adapter, or
/// tool the Gateway spawns inherits a key.
pub(crate) fn capture_seal_key() -> anyhow::Result<SealKeyStatus> {
    let status = if ryu_crypto::capture_process_seal_key()? {
        SealKeyStatus::Delivered
    } else {
        ryu_crypto::install_standalone_host();
        match ryu_crypto::component_cipher_for_process(ryu_crypto::components::GATEWAY) {
            Ok(_) => SealKeyStatus::Resolved,
            Err(error) => SealKeyStatus::Unavailable(error.to_string()),
        }
    };
    for name in ryu_crypto::SEAL_ENV_VARS {
        std::env::remove_var(name);
    }
    Ok(status)
}

/// `ryu-gateway print-key admin|relay`: print a generated key from the sealed
/// `gateway-admin.key` / `gateway-relay.key` beside `gateway.toml`, so an
/// operator can hand it to a client without the file holding it in plaintext.
/// Needs the same sealing key the Gateway runs with.
pub(crate) fn print_generated_key(role: Option<&str>) -> anyhow::Result<()> {
    let file = match role {
        Some("admin") => config::ADMIN_KEY_FILE,
        Some("relay") => config::RELAY_KEY_FILE,
        _ => anyhow::bail!("usage: ryu-gateway print-key admin|relay"),
    };
    let path = GatewayConfig::config_path()
        .and_then(|path| path.parent().map(|parent| parent.join(file)))
        .ok_or_else(|| anyhow::anyhow!("cannot determine Gateway credential directory"))?;
    let sealer = ryu_gw_credentials::sealed_config::config_sealer().map_err(|error| {
        anyhow::anyhow!(
            "{error}. Set RYU_MASTER_KEY, or RYU_SEAL_KEY and RYU_SEAL_SCOPE from \
             `ryu-core gateway-seal-env`, as for the Gateway itself"
        )
    })?;
    let key = ryu_gw_credentials::read_sealed(&path, &*sealer)?;
    println!("{key}");
    Ok(())
}

/// Log how this process got its `gateway.toml` sealing key (never the key).
pub(crate) fn log_seal_key_status(seal_key: &SealKeyStatus) {
    match seal_key {
        SealKeyStatus::Delivered => {
            tracing::info!("gateway.toml secrets: sealing key delivered by Core")
        }
        SealKeyStatus::Resolved => {
            tracing::info!("gateway.toml secrets: sealing key derived from the master key")
        }
        SealKeyStatus::Unavailable(reason) => tracing::warn!(
            "gateway.toml secrets: no sealing key ({reason}); plaintext configuration still \
             loads, but sealed secrets cannot be read and new secrets cannot be saved. Set \
             RYU_SEAL_KEY and RYU_SEAL_SCOPE from `ryu-core gateway-seal-env`, or RYU_MASTER_KEY"
        ),
    }
}

/// The one startup line naming which features the loaded configuration turns on.
pub(crate) fn log_loaded_configuration(config: &GatewayConfig, bind_addr: &str) {
    tracing::info!(
        bind = %bind_addr,
        openai = config.providers.openai.is_some(),
        anthropic = config.providers.anthropic.is_some(),
        local = config.providers.local.is_some(),
        openrouter = config.providers.openrouter.is_some(),
        core = config.providers.core.is_some(),
        auth_required = config.auth.require_auth,
        firewall = config.firewall.enabled,
        cache = config.cache.enabled,
        circuit_breaker = config.circuit_breaker.enabled,
        skills = config.skills.skills.len(),
        audit = config.audit.enabled,
        evals = config.evals.enabled,
        composio = config.composio.enabled,
        semantic_cache = config.semantic_cache.enabled,
        telegram = config.channels.telegram.is_some(),
        control_plane = config.control_plane.enabled,
        slack = config.channels.slack.is_some(),
        discord = config.channels.discord.is_some(),
        whatsapp = config.channels.whatsapp.is_some(),
        bluebubbles = config.channels.bluebubbles.is_some(),
        "configuration loaded"
    );
}

/// Housekeeping loops: stale rate-limit buckets every 5 minutes, expired
/// exact, semantic and embedding cache entries every minute.
pub(crate) fn spawn_eviction_loops(state: &Arc<AppState>) {
    // Background: evict stale rate-limit buckets every 5 minutes
    {
        let s = Arc::clone(state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            loop {
                interval.tick().await;
                s.rate_limiter.evict_stale(Duration::from_secs(600));
                s.org_rate.evict_stale(Duration::from_secs(600));
            }
        });
    }

    // Background: evict expired cache entries (exact + semantic) every minute
    {
        let s = Arc::clone(state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                s.cache.evict_expired();
                if let Some(sc) = s.semantic_cache.active() {
                    sc.evict_expired();
                }
                if let Some(embeddings) = &s.embedding_cache {
                    embeddings.evict_expired();
                }
            }
        });
    }
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;
