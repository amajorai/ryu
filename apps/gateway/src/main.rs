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
mod http_trace;
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
mod startup;
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

use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::{
    config::GatewayConfig,
    http_trace::{http_server_span, record_http_response, shutdown_signal},
    startup::{
        auth_disabled_startup_rejected, capture_seal_key, config_file_notice, cors_allowed_origins,
        cors_layer, hosted_web_origin_allowed, print_generated_key, SealKeyStatus,
    },
    state::AppState,
};

fn main() -> anyhow::Result<()> {
    // Windows DLL sideloading hardening (the Yoba pattern: a genuine signed
    // executable beside a planted DLL). Restrict the search order before any
    // code can load a library by name; the build-time /DEPENDENTLOADFLAG
    // still covers static imports if Windows refuses.
    if let Err(error) = ryu_sidecar_runtime::dll_search::harden_dll_search() {
        eprintln!("ryu-gateway: could not restrict the DLL search order: {error}");
    }
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
        "GATEWAY_CORE_RELAY_MASTER_KEY",
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

    startup::log_seal_key_status(&seal_key);
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

    startup::log_loaded_configuration(&config, &bind_addr);

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

    startup::spawn_eviction_loops(&state);

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
