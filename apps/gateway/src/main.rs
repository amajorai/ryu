mod api;
mod audit;
mod budget;
mod cache;
mod channels;
mod circuit_breaker;
mod composio;
mod compression;
mod concurrency;
mod config;
mod crash;
mod error;
mod evals;
mod evaluators;
mod firewall;
mod governance;
mod jobs;
mod metrics;
mod passthrough;
mod pipeline;
mod policy;
mod policy_alert;
mod providers;
mod quota;
mod rate_limit;
mod reporter;
mod router;
mod semantic_cache;
mod skills;
mod state;
mod telemetry;
mod tools;
mod untrusted;

use std::{sync::Arc, time::Duration};

use tower_http::{
    cors::{Any, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::{config::GatewayConfig, state::AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // OpenTelemetry export seam (#540, P1): build an OPTIONAL OTLP layer that is
    // installed ONLY when diagnostics export is enabled (`RYU_DIAGNOSTICS_EXPORT_ENABLED`)
    // AND a destination is set (`OTEL_EXPORTER_OTLP_ENDPOINT`). With the flag off this
    // resolves to `None` — `Option<Layer>` is itself a `Layer` whose `None` does
    // nothing, so zero spans egress and the always-on local sinks (stdout `fmt` + the
    // `audit/` SQLite store) are untouched. The provider is held for the process
    // lifetime (leaked) so batched spans flush. Mirrors `apps/core/src/main.rs`.
    let (otel_layer, otel_provider) = match telemetry::build_otlp_layer() {
        Some((layer, provider)) => (Some(layer), Some(provider)),
        None => (None, None),
    };

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "ryu_gateway=debug,info".into()))
        .with(tracing_subscriber::fmt::layer())
        .with(otel_layer)
        .init();

    // Keep the tracer provider alive for the whole process so the batch exporter
    // continues to flush; leaking is intentional (mirrors a process-global sink).
    if let Some(provider) = otel_provider {
        std::mem::forget(provider);
    }

    tracing::info!("ryu-gateway v{} starting", env!("CARGO_PKG_VERSION"));

    // Crash reporting tier (#544, P3): init Sentry for PANICS ONLY, gated on the
    // `RYU_CRASH_REPORTS_ENABLED` env (Core forwards the user's desktop
    // `crash-reports-enabled` consent here) AND a DSN (`SENTRY_DSN`/`RYU_SENTRY_DSN`).
    // Off / no DSN => true no-op. The guard is BOUND for the whole `main` (NOT
    // leaked) so it flushes a pending panic event on shutdown. PII-scrubbed in
    // `before_send`; never fed `tracing`/log events, so no content reaches Sentry.
    let _crash_guard = crash::init();

    let config = GatewayConfig::load().unwrap_or_else(|e| {
        tracing::warn!("Failed to load config ({e}), using defaults");
        GatewayConfig::default()
    });

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
        "configuration loaded"
    );

    // Security guard: the gateway is an LLM proxy. Binding to a non-loopback
    // interface without auth exposes a fully open, billable proxy to the network.
    // Default bind is 0.0.0.0:7981 and require_auth is only enabled when
    // GATEWAY_MASTER_KEY is set. This is a HARD REFUSAL, not a warning (WS2): a
    // publicly-reachable fleet replica must never boot without auth. A loopback
    // bind keeps the old permissive behavior for local dev.
    let is_loopback_bind = bind_addr.starts_with("127.0.0.1")
        || bind_addr.starts_with("localhost")
        || bind_addr.starts_with("[::1]");
    if !is_loopback_bind && !config.auth.require_auth {
        anyhow::bail!(
            "refusing to start: gateway is bound to a non-loopback address ({bind_addr}) \
             with auth DISABLED — anyone who can reach this port could use your providers \
             and spend your credits. Set GATEWAY_MASTER_KEY (require_auth) and/or populate \
             auth.api_keys, or bind to 127.0.0.1 for local-only use."
        );
    }

    let state = Arc::new(AppState::new(config));

    // Channels: register configured messaging surfaces (Telegram, etc.). Each
    // runs its own inbound loop and routes messages through the gateway pipeline.
    // Loads enabled bot configs from the control-plane store first (M11 / #230);
    // env-configured channels are used as a fallback when the store is absent.
    channels::spawn_registered(Arc::clone(&state)).await;

    // U28: if this gateway is bound to a control plane, fetch its effective
    // policy now and refresh it periodically. The control plane has already
    // cascaded org/team/project/user layers and frozen admin-locked fields, so
    // the data plane just enforces what it receives. A missing/unreachable
    // control plane fails open (no extra policy) so the gateway still serves.
    if let Some(source) = policy::PolicySource::from_env() {
        match source.fetch(&state.http).await {
            Ok(policy) => {
                tracing::info!(
                    approved_models = policy.approved_models.len(),
                    locked_guardrails = policy.locked_guardrails.len(),
                    allowed_regions = policy.allowed_regions.len(),
                    "policy: fetched effective control-plane policy"
                );
                state.set_policy(policy);
            }
            Err(e) => tracing::warn!(
                "policy: initial control-plane fetch failed ({e}); serving with no distributed policy until next refresh"
            ),
        }

        let s = Arc::clone(&state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await; // skip the immediate tick (already fetched)
            loop {
                interval.tick().await;
                match source.fetch(&s.http).await {
                    Ok(policy) => s.set_policy(policy),
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
                if let Some(sc) = &s.semantic_cache {
                    sc.evict_expired();
                }
            }
        });
    }

    // Background: push eval/budget/audit aggregates up to the control plane
    reporter::spawn(Arc::clone(&state));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = api::router(Arc::clone(&state))
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(300),
        ))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);

    // `into_make_service_with_connect_info` exposes the peer `SocketAddr` to
    // handlers via `ConnectInfo`. Admin endpoints (config/audit) use it to allow
    // no-master-key access only from loopback, never from a remote peer.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
