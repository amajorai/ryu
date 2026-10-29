mod api;
mod audit;
mod budget;
mod cache;
mod channels_host;
mod circuit_breaker;
mod compat;
mod composio;
mod compression;
mod concurrency;
mod config;
mod connections;
mod crash;
mod credit_pools;
mod custody;
mod egress;
mod enforcement;
mod error;
mod evals;
mod evaluators;
mod firewall;
mod governance;
mod identity;
mod jobs;
mod metrics;
mod online_evals;
mod org_limits;
mod own_supply_discovery;
mod own_supply_table;
mod passthrough;
mod phone_calls;
mod pipeline;
mod platform_floor;
mod policy;
mod policy_alert;
mod profile;
mod provider_pools;
mod provider_vault;
mod providers;
mod quota;
mod rate_limit;
mod reporter;
mod responses_store;
mod router;
mod ryu_analytics;
mod screening;
mod security_contact;
mod semantic_cache;
mod skills;
mod standing;
mod state;
mod telemetry;
mod tools;
mod traffic;
mod treg;
mod untrusted;
mod usage_windows;
mod violations;
mod wasm_policy;
mod web_config;
mod web_pools;

use std::{sync::Arc, time::Duration};

use axum::http::HeaderValue;
use tower_http::{
    cors::{Any, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::{config::GatewayConfig, state::AppState};

/// Whether startup must refuse a Gateway whose auth is disabled: on a
/// non-loopback bind, or with exposure hardening on
/// ([`custody::exposure_hardened`]), where a loopback listener sits behind a
/// load balancer and proves nothing.
fn auth_disabled_startup_rejected(
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
fn config_file_notice(path: Option<&std::path::Path>) -> Result<String, String> {
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
const HOSTED_WEB_ORIGIN: &str = "https://app.ryuhq.com";

/// Whether CORS admits [`HOSTED_WEB_ORIGIN`]. An explicit
/// `RYU_CORS_ALLOW_HOSTED_WEB` (`1`/`true`/`on` or `0`/`false`/`off`) wins.
/// Otherwise it is admitted only for a Gateway paired with Ryu: one that holds a
/// trusted Core relay credential (Core-managed or hosted) or has Fleet custody.
/// A plain self-hosted Gateway does not trust a Ryu-hosted page by default, even
/// when it sets the fleet flag for exposure hardening.
fn hosted_web_origin_allowed(
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
fn cors_layer(origins: Vec<HeaderValue>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(api::http_conventions::exposed_headers())
        .allow_private_network(true)
}

fn cors_allowed_origins(allow_hosted_web: bool, extra: Option<&str>) -> Vec<HeaderValue> {
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
enum SealKeyStatus {
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
fn capture_seal_key() -> anyhow::Result<SealKeyStatus> {
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
fn print_generated_key(role: Option<&str>) -> anyhow::Result<()> {
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

fn main() -> anyhow::Result<()> {
    if std::env::args().any(|argument| argument == "--version") {
        println!("ryu-gateway {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let seal_key = capture_seal_key()?;
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() == Some("print-key") {
        return print_generated_key(arguments.next().as_deref());
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(seal_key))
}

async fn run(seal_key: SealKeyStatus) -> anyhow::Result<()> {
    ryu_gw_credentials::protect_process_environment_if_present(&[
        "GATEWAY_MASTER_KEY",
        "GATEWAY_ADMIN_KEY",
        "GATEWAY_CORE_RELAY_KEY",
        "GATEWAY_CORE_PROOF_KEY",
        "GATEWAY_CORE_PROOF_MASTER_KEY",
    ])?;
    // The sealing key now lives only in this process's memory: keep same-UID
    // processes from reading it through procfs/ptrace.
    if !matches!(seal_key, SealKeyStatus::Unavailable(_)) {
        ryu_gw_credentials::protect_process_environment()?;
    }

    // OpenTelemetry export seam (#540, P1): build an OPTIONAL OTLP layer that is
    // installed ONLY when diagnostics export is enabled (`RYU_DIAGNOSTICS_EXPORT_ENABLED`)
    // AND a destination is set (`OTEL_EXPORTER_OTLP_ENDPOINT`). With the flag off this
    // resolves to `None` — `Option<Layer>` is itself a `Layer` whose `None` does
    // nothing, so zero spans egress and the always-on local sinks (stdout `fmt` + the
    // `audit/` SQLite store) are untouched. The provider is retained inside
    // `telemetry` and flushed by `telemetry::shutdown()` when the server returns.
    // Mirrors `apps/core/src/main.rs`.
    let otel_layer = telemetry::build_otlp_layer().map(|(layer, _provider)| layer);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .with(otel_layer)
        .init();

    tracing::info!("ryu-gateway v{} starting", env!("CARGO_PKG_VERSION"));

    // Crash reporting tier (#544, P3): init Sentry for PANICS ONLY, gated on the
    // `RYU_CRASH_REPORTS_ENABLED` env (Core forwards the user's desktop
    // `crash-reports-enabled` consent here) AND a DSN (`SENTRY_DSN`/`RYU_SENTRY_DSN`).
    // Off / no DSN => true no-op. The guard is BOUND for the whole `main` (NOT
    // leaked) so it flushes a pending panic event on shutdown. PII-scrubbed in
    // `before_send`; never fed `tracing`/log events, so no content reaches Sentry.
    let _crash_guard = crash::init();

    match &seal_key {
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
    // One-time migration: seal secrets an operator (or an older build) left in
    // plaintext. Comments and layout are kept; without a key the file is left
    // as it is.
    if let Some(path) = GatewayConfig::config_path().filter(|path| path.is_file()) {
        match ryu_gw_credentials::sealed_config::reseal_file(&path) {
            Ok(true) => tracing::info!("gateway.toml: sealed plaintext secrets in place"),
            Ok(false) => {}
            Err(error) => tracing::warn!("gateway.toml: could not seal plaintext secrets: {error}"),
        }
    }
    let mut config = GatewayConfig::load()?;
    match config_file_notice(GatewayConfig::config_path().as_deref()) {
        Ok(notice) => tracing::info!("{notice}"),
        Err(warning) => tracing::warn!("{warning}"),
    }
    let credential_dir = GatewayConfig::config_path()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .ok_or_else(|| anyhow::anyhow!("cannot determine Gateway credential directory"))?;
    config.auth.bootstrap(&credential_dir)?;

    let vault_http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        // The request carries the fleet vault secret. Never follow a redirect
        // that could move that header to an operator-typo or attacker-controlled
        // host; the control-plane route is a fixed endpoint.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build provider-vault client: {e}"))?;
    match provider_vault::apply_from_env(&mut config, &vault_http).await {
        Ok(applied) if !applied.is_empty() => {
            tracing::info!(providers = ?applied, "provider vault loaded into gateway memory");
        }
        Ok(_) => {}
        Err(error) if !provider_vault::required_from_env() => {
            tracing::warn!("provider vault unavailable; continuing with local config: {error}");
        }
        Err(error) => return Err(error),
    }
    if let Some(warning) = config.flat_rate_metering_warning() {
        tracing::warn!("{warning}");
    }

    let bind_addr = std::env::args()
        .skip(1)
        .find(|a| a.starts_with("--bind="))
        .and_then(|a| a.strip_prefix("--bind=").map(str::to_string))
        .unwrap_or_else(|| config.bind.clone());

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

    // Even an explicit development auth opt-out cannot expose a billable proxy.
    // Custody comes only from the vault signals; the fleet flag is exposure
    // hardening on its own. Either one holds the process to the hardened
    // posture, so a replica marked Fleet only by its environment and a
    // self-hosted stack behind its own proxy both refuse to run without auth.
    let custody = custody::GatewayCustody::from_env();
    let exposure_hardened = custody::exposure_hardened(config.fleet, custody);
    if auth_disabled_startup_rejected(&bind_addr, exposure_hardened, config.auth.require_auth) {
        anyhow::bail!(
            "refusing to start: gateway auth is DISABLED for an externally reachable posture \
             (bind={bind_addr}, custody={}, fleet_flag={}). Anyone who can reach this port could \
             use your providers and spend your credits. Enable auth.require_auth; a Gateway behind \
             a load balancer must never run unauthenticated even when its listener is loopback.",
            custody.as_str(),
            config.fleet
        );
    }
    // Credit debit spends a hosted organization's balance, so Fleet custody
    // refuses a fail-open debit even when `gateway.toml` leaves the fleet flag
    // off (`GatewayConfig::load` already refuses it under the flag).
    if custody.is_fleet() && config.credits.enabled && !config.credits.fail_closed {
        anyhow::bail!(
            "refusing to start a hosted fleet Gateway with credit debit fail-open; set \
             GATEWAY_CREDITS_FAIL_CLOSED=true"
        );
    }

    // Build the shared state, applying the config-selected active backend for
    // every inverted stage. An unknown backend id refuses startup (fail-closed)
    // rather than silently falling back to the built-in.
    let allow_hosted_web = hosted_web_origin_allowed(
        std::env::var("RYU_CORS_ALLOW_HOSTED_WEB").ok().as_deref(),
        config.auth.api_keys.iter().any(|key| key.trusted_forwarder),
        custody.is_fleet(),
    );
    // The fleet stamps a Ryu-derived identity on every upstream request, so it
    // refuses to start without the identity secrets; other custodies run
    // without them and send no upstream identity.
    let identity_keys = identity::IdentityKeys::from_env(custody)
        .map_err(|e| anyhow::anyhow!("refusing to start: {e}"))?;
    // Boot check I1 (spec 02.6.3): on the fleet a remote screening
    // processor's credential must not be one a chat provider slot holds.
    if custody.is_fleet() {
        screening::check_remote_credentials(&config, &|name| std::env::var(name).ok())
            .map_err(|e| anyhow::anyhow!("refusing to start: {e}"))?;
    }
    // Custody decides which routes exist, which a hosted replica refuses and
    // which fleet-only provider slots (the Vercel lane) the registry builds.
    let mut state = AppState::new_with_custody(config, custody)
        .map_err(|e| anyhow::anyhow!("refusing to start: {e}"))?;
    state.identity_keys = Arc::new(identity_keys);
    tracing::info!(
        custody = state.custody.as_str(),
        exposure_hardened,
        "gateway custody detected"
    );
    // The Ryu Router own-supply table: fleet gateways read the control plane's
    // published table (last-known-good file at boot, else empty) and run
    // discovery + canaries; every other gateway keeps the compiled seed.
    state.own_supply = Arc::new(own_supply_table::OwnSupplyRuntime::for_process(
        own_supply_table::fleet_from_env(),
        Some(credential_dir.as_path()),
    ));
    // Detection only: log which flagged egress features are active here.
    api::egress_posture::log_boot_posture(&state);
    let state = Arc::new(state);
    // Screener readiness (addendum 10.3): probe every backend now and every
    // 10 s. An engine down at boot opens its breaker, so the replica starts
    // in degraded mode instead of failing to start; `/health` never depends
    // on the screener.
    {
        let s = Arc::clone(&state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(screening::PROBE_EVERY);
            loop {
                interval.tick().await;
                s.screening.probe_all().await;
                s.screening.publish_transitions(&s.traffic);
            }
        });
    }
    own_supply_table::spawn_poller(Arc::clone(&state.own_supply));
    // Online evals: score sampled production traffic off the request path.
    if online_evals::spawn_worker(&state) {
        tracing::info!(
            evaluators = state.config.evals.online.evaluators.len(),
            "online evals: background scorer started"
        );
    }
    own_supply_discovery::spawn(Arc::clone(&state));

    // Channels: register configured messaging surfaces (Telegram, etc.). Each
    // runs its own inbound loop and routes messages through the gateway pipeline.
    // Loads enabled bot configs from the control-plane store first (M11 / #230);
    // env-configured channels are used as a fallback when the store is absent.
    channels_host::spawn_registered(Arc::clone(&state)).await;

    // U28: if this gateway is bound to a control plane, fetch its effective
    // policy now and refresh it periodically. The control plane has already
    // cascaded org/team/project/user layers and frozen admin-locked fields, so
    // the data plane just enforces what it receives. A configured managed
    // control plane is required for startup; refresh failures retain the last
    // verified policy instead of serving an empty policy.
    if let Some(source) = policy::PolicySource::from_env() {
        let resolved = source.fetch_resolved(&state.http).await.map_err(|error| {
            anyhow::anyhow!("refusing to start: initial control-plane policy fetch failed: {error}")
        })?;
        tracing::info!(
            approved_models = resolved.policy.approved_models.len(),
            locked_guardrails = resolved.policy.locked_guardrails.len(),
            allowed_regions = resolved.policy.allowed_regions.len(),
            policy_version = resolved.policy_version.as_deref().unwrap_or("unversioned"),
            "policy: fetched effective control-plane policy"
        );
        let _ = state.apply_resolved_policy(resolved);

        let s = Arc::clone(&state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await; // skip the immediate tick (already fetched)
            loop {
                interval.tick().await;
                match source.fetch_resolved(&s.http).await {
                    Ok(resolved) => {
                        s.apply_resolved_policy(resolved);
                    }
                    Err(e) => tracing::warn!("policy: refresh failed ({e})"),
                }
            }
        });
    }

    // Static policy-drift check (dangerous-tool-combo + elevation drift). Run
    // unconditionally — standalone gateways with no control plane still get the
    // check. Warn-only: nothing is blocked. The firewall is read live via
    // `with_firewall` (at startup it equals `state.config.firewall`).
    for warning in policy::detect_drift(
        &state.config.tools,
        &state.config.composio,
        &state.config.exec_budget,
        &state.with_firewall(|fw| fw.config().clone()),
        &state.policy_snapshot(),
    ) {
        tracing::warn!(
            code = %warning.code,
            severity = %warning.severity,
            "policy drift: {}",
            warning.message
        );
    }

    // Background: evict stale rate-limit buckets every 5 minutes
    {
        let s = Arc::clone(&state);
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
        let s = Arc::clone(&state);
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

    // Background: push eval/budget/audit aggregates up to the control plane
    reporter::spawn(Arc::clone(&state));
    // Violation outbox upkeep (excerpt expiry, size and row caps) runs
    // whether or not a control plane is configured.
    violations::spawn_maintenance(Arc::clone(&state));

    // CORS (F3): clamp off the permissive `allow_origin(Any)`. The gateway can bind
    // `0.0.0.0` and several privileged routes authorize on loopback posture alone,
    // so a bare `Any` origin let any web page the user visits `fetch()` a state
    // change cross-origin. Mirror Core's proven allowlist (apps/core/src/server:
    // desktop/webapp vite dev + tauri prod, and the hosted web app only for a
    // Ryu-paired gateway) plus a comma-split `RYU_CORS_ORIGINS` escape hatch.
    // `allow_private_network(true)` matches Core's
    // tauri-origin→loopback hop (Chrome's Private Network Access preflight). No
    // credentials are set, so a specific-origin list with `allow_headers(Any)` is
    // legal in tower-http and preserves the editor-AI `Authorization` header.
    let cors_origins = cors_allowed_origins(
        allow_hosted_web,
        std::env::var("RYU_CORS_ORIGINS").ok().as_deref(),
    );
    let cors = cors_layer(cors_origins);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    let app = api::router(Arc::clone(&state))
        .layer(axum::Extension(listener.local_addr()?))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(http_server_span)
                .on_response(record_http_response),
        )
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(300),
        ))
        // The timeout's 504 has an empty body; it gets the JSON envelope.
        .layer(axum::middleware::from_fn(
            api::http_conventions::gateway_timeout_envelope,
        ))
        // The router stamps `x-request-id` itself; this outer copy only fills
        // it in on a 504 the timeout produced after dropping the request.
        .layer(axum::middleware::from_fn(api::http_conventions::request_id))
        .layer(cors);

    tracing::info!("listening on http://{}", listener.local_addr()?);

    // `into_make_service_with_connect_info` exposes the peer `SocketAddr` to
    // handlers via `ConnectInfo`. Admin endpoints (config/audit) use it to allow
    // no-master-key access only from loopback, never from a remote peer.
    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    );
    // Core stops (and respawns) its managed Gateway with SIGTERM and a bounded
    // grace period. Exit promptly on it — in-flight requests are cut exactly as
    // before — but flush the consented OTLP batch first so spans that already
    // ended are not lost.
    let served = tokio::select! {
        served = std::future::IntoFuture::into_future(serve) => served,
        () = shutdown_signal() => {
            tracing::info!("shutdown signal received; flushing telemetry and exiting");
            Ok(())
        }
    };
    // Flush consented OTLP spans before exit (bounded; no-op without an exporter).
    let _ = tokio::task::spawn_blocking(telemetry::shutdown).await;
    served?;

    Ok(())
}

/// Resolves on Ctrl-C or (Unix) SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

/// Liveness/metrics polling routes: never worth a server span.
fn is_polling_path(path: &str) -> bool {
    matches!(
        path,
        "/health" | "/healthz" | "/livez" | "/readyz" | "/metrics"
    )
}

/// The OTel HTTP server span for one inbound request: named `{method} {route}`
/// (or just `{method}` when no route matched), `otel.kind = server`, parented
/// under the caller's W3C `traceparent` when present. INFO so it clears the
/// OTLP layer's INFO+ filter. Carries no URL query or headers.
fn http_server_span<B>(request: &axum::http::Request<B>) -> tracing::Span {
    // Without the consented exporter nothing would leave the process, so build
    // no span at all (one atomic load), and keep health/metrics polls out of
    // the export stream entirely.
    if !telemetry::export_active() || is_polling_path(request.uri().path()) {
        return tracing::Span::none();
    }
    let method = request.method().as_str();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(axum::extract::MatchedPath::as_str);
    let name = match route {
        Some(route) => format!("{method} {route}"),
        None => method.to_owned(),
    };
    let span = tracing::info_span!(
        "http.server.request",
        "otel.name" = %name,
        "otel.kind" = "server",
        "otel.status_code" = tracing::field::Empty,
        "http.request.method" = method,
        "http.route" = route,
        "url.path" = request.uri().path(),
        "http.response.status_code" = tracing::field::Empty,
    );
    telemetry::propagation::set_parent_from_headers(&span, request.headers());
    span
}

/// Record the response status on the server span; 5xx marks it ERROR per the
/// OTel HTTP server conventions (4xx is the client's error, not the server's).
fn record_http_response<B>(
    response: &axum::http::Response<B>,
    _latency: Duration,
    span: &tracing::Span,
) {
    let status = response.status();
    span.record("http.response.status_code", status.as_u16());
    if status.is_server_error() {
        span.record("otel.status_code", "ERROR");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        auth_disabled_startup_rejected, config_file_notice, cors_allowed_origins, cors_layer,
        hosted_web_origin_allowed, HOSTED_WEB_ORIGIN,
    };

    #[tokio::test]
    async fn cors_exposes_the_request_id_and_rate_limit_headers() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let origin = "http://localhost:1420";
        let app = axum::Router::new()
            .route("/v1/models", axum::routing::get(|| async { "ok" }))
            .layer(cors_layer(vec![axum::http::HeaderValue::from_static(
                origin,
            )]));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            origin
        );
        let exposed = response
            .headers()
            .get("access-control-expose-headers")
            .expect("expose list")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        for name in [
            "x-request-id",
            "retry-after",
            "ratelimit",
            "ratelimit-policy",
            "x-provider",
            "x-routed-model",
        ] {
            assert!(
                exposed.split(',').any(|item| item.trim() == name),
                "{name} in {exposed}"
            );
        }
    }

    #[test]
    fn a_missing_config_file_is_reported_not_silently_defaulted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.toml");
        let warning = config_file_notice(Some(&path)).unwrap_err();
        assert!(warning.contains(&path.display().to_string()), "{warning}");
        assert!(warning.contains("GATEWAY_CONFIG"), "{warning}");
        assert!(config_file_notice(None)
            .unwrap_err()
            .contains("GATEWAY_CONFIG"));

        std::fs::write(&path, "").unwrap();
        let notice = config_file_notice(Some(&path)).unwrap();
        assert!(notice.contains(&path.display().to_string()), "{notice}");
    }

    #[test]
    fn hosted_web_origin_is_only_trusted_by_a_ryu_paired_gateway() {
        // A plain self-hosted gateway does not admit the Ryu-hosted page.
        assert!(!hosted_web_origin_allowed(None, false, false));
        // Core-managed (trusted relay) and fleet gateways keep it.
        assert!(hosted_web_origin_allowed(None, true, false));
        assert!(hosted_web_origin_allowed(None, false, true));
        // An explicit operator choice wins either way.
        assert!(hosted_web_origin_allowed(Some(" On "), false, false));
        assert!(!hosted_web_origin_allowed(Some("0"), true, true));
        // Unrecognised values fall back to the pairing rule.
        assert!(!hosted_web_origin_allowed(Some("maybe"), false, false));
    }

    #[test]
    fn cors_allowlist_adds_hosted_origin_and_extras_only_on_request() {
        let has = |origins: &[axum::http::HeaderValue], origin: &str| {
            origins.iter().any(|value| value == origin)
        };
        let standalone = cors_allowed_origins(false, None);
        assert!(has(&standalone, "tauri://localhost"));
        assert!(!has(&standalone, HOSTED_WEB_ORIGIN));

        let paired = cors_allowed_origins(true, Some(" https://a.example , ,https://b.example"));
        assert!(has(&paired, HOSTED_WEB_ORIGIN));
        assert!(has(&paired, "https://a.example"));
        assert!(has(&paired, "https://b.example"));
    }

    #[test]
    fn polling_routes_get_no_server_span() {
        assert!(super::is_polling_path("/health"));
        assert!(super::is_polling_path("/metrics"));
        assert!(!super::is_polling_path("/v1/chat/completions"));
    }

    #[test]
    fn fleet_mode_rejects_auth_disabled_even_on_loopback() {
        assert!(auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            true,
            false
        ));
        assert!(auth_disabled_startup_rejected("0.0.0.0:8981", false, false));
        assert!(!auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            false,
            false
        ));
        assert!(!auth_disabled_startup_rejected("0.0.0.0:8981", true, true));
    }

    #[test]
    fn env_detected_fleet_custody_rejects_auth_disabled_on_loopback() {
        use crate::custody::{exposure_hardened, GatewayCustody};
        let vault_pair = GatewayCustody::from_lookup(|name| match name {
            "CONTROL_PLANE_URL" => Some("https://control.invalid".to_owned()),
            "RYU_VAULT_INTERNAL_SECRET" => Some("test-only".to_owned()),
            _ => None,
        });
        assert!(auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            exposure_hardened(false, vault_pair),
            false
        ));
        let vault_required = GatewayCustody::from_lookup(|name| {
            (name == "RYU_PROVIDER_VAULT_REQUIRED").then(|| "true".to_owned())
        });
        assert!(auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            exposure_hardened(false, vault_required),
            false
        ));
        let self_hosted = GatewayCustody::from_lookup(|_| None);
        assert!(!auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            exposure_hardened(false, self_hosted),
            false
        ));
    }

    /// The self-host compose stack sets `RYU_GATEWAY_FLEET=1` with no vault
    /// signal: custody stays SelfHosted, yet the fleet flag alone still refuses
    /// an auth-disabled start on a loopback listener.
    #[test]
    fn fleet_flag_without_vault_is_self_hosted_but_still_rejects_auth_disabled() {
        use crate::custody::{exposure_hardened, GatewayCustody};
        let custody = GatewayCustody::from_lookup(|name| {
            (name == "RYU_GATEWAY_FLEET").then(|| "1".to_owned())
        });
        assert_eq!(custody, GatewayCustody::SelfHosted);
        assert!(auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            exposure_hardened(true, custody),
            false
        ));
        // Fleet flag on, auth on: starts.
        assert!(!auth_disabled_startup_rejected(
            "127.0.0.1:8981",
            exposure_hardened(true, custody),
            true
        ));
        // The hosted web origin follows custody, not the flag.
        assert!(!hosted_web_origin_allowed(None, false, custody.is_fleet()));
    }
}
