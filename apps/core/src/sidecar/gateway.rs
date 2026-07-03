//! Local ryu-gateway lifecycle (data plane, per-machine).
//!
//! Core routes every model call it makes through `apps/gateway` (`ryu-gateway`,
//! an OpenAI-compatible Axum server). This module owns the gateway as part of
//! the local stack: it spawns the binary, waits for it to become healthy, and
//! keeps the child handle so it is killed on shutdown.
//!
//! Provider credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LOCAL_LLM_URL`,
//! …) live in Core's environment and are inherited by the spawned gateway, so
//! the gateway — not Core — owns provider creds and forwards to the engine.
//!
//! Scope (U18): only the HTTP calls Core itself makes (the OpenAI-compat chat
//! path) go through the gateway. ACP agents are subprocesses that make their
//! own provider calls internally; Core cannot intercept those, so they are out
//! of scope here.

use std::time::Duration;

use crate::sidecar::active_engine::{local_engine_url, ActiveEngineStore};
use crate::sidecar::process::ProcessHandle;

/// Default address the local gateway binds to and Core forwards chat to.
/// Matches `apps/gateway` default bind (`0.0.0.0:7981`) on the loopback host.
pub const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:7981";

/// Env var pointing Core at the gateway base URL (no trailing `/v1`).
const ENV_GATEWAY_URL: &str = "RYU_GATEWAY_URL";
/// Env var with a bearer token for the gateway, when it runs with auth enabled.
const ENV_GATEWAY_TOKEN: &str = "RYU_GATEWAY_TOKEN";
/// Env var to disable Core spawning/managing the gateway (assume external).
const ENV_GATEWAY_MANAGED: &str = "RYU_GATEWAY_MANAGED";
/// Env var overriding the gateway binary path (otherwise resolved on PATH).
const ENV_GATEWAY_BIN: &str = "RYU_GATEWAY_BIN";
/// Default gateway binary name (resolved via PATH, including `~/.ryu/bin`).
const DEFAULT_GATEWAY_BIN: &str = "ryu-gateway";
/// Env var the gateway reads to configure its `local` provider base URL
/// (see `apps/gateway/src/config.rs`). Core sets this to the active local
/// engine's OpenAI-compatible URL so the engine registers as a routable
/// provider in the gateway router (U19).
const ENV_LOCAL_LLM_URL: &str = "LOCAL_LLM_URL";

/// Base URL Core forwards chat completions to. Always non-empty.
pub fn gateway_url() -> String {
    std::env::var(ENV_GATEWAY_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_owned())
}

/// Optional bearer token Core presents to the gateway (only when the gateway
/// runs with `require_auth`). This is the gateway token slot — never a provider
/// API key.
pub fn gateway_token() -> Option<String> {
    std::env::var(ENV_GATEWAY_TOKEN)
        .ok()
        .filter(|s| !s.is_empty())
}

/// Resolve the OpenAI-compatible base URL of the currently selected local
/// engine, for registering it as the gateway's `local` provider (U19).
///
/// Resolution order:
///   1. An explicit `LOCAL_LLM_URL` in Core's environment always wins, so an
///      operator can point the gateway at an external/custom local server.
///   2. Otherwise the persisted active local engine (U4) is mapped to its
///      serving URL.
///   3. Otherwise, when the default local stack (`llamacpp`) is installed per
///      the version store, its URL — a fresh install has no persisted engine
///      selection (nothing ever swapped), and without this fallback the gateway
///      got NO `local` provider, so the zero-key default chat model
///      (`gemma* → Local`) failed with "all_providers_unavailable" even while
///      llama-server was healthy (QA finding B1's last leg). `start_all` also
///      persists its resolved resident engine now, but the gateway spawns
///      concurrently with `start_all`, so this closes the first-boot race too.
///
/// Returns `None` when none apply, in which case the gateway falls back to
/// its own built-in default (Ollama on `11434`).
pub fn local_engine_gateway_url() -> Option<String> {
    if let Ok(url) = std::env::var(ENV_LOCAL_LLM_URL) {
        if !url.is_empty() {
            return Some(url);
        }
    }
    if let Some(active) = ActiveEngineStore::load().active {
        return local_engine_url(&active).map(str::to_owned);
    }
    let versions = crate::sidecar::download_manager::VersionStore::load();
    if versions.installed_version("llamacpp").is_some() {
        return local_engine_url("llamacpp").map(str::to_owned);
    }
    None
}

/// Environment overrides Core layers onto the spawned gateway so it routes the
/// `local` provider at the active engine. Empty when nothing is selected.
fn gateway_spawn_env() -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(url) = local_engine_gateway_url() {
        tracing::info!(local_llm_url = %url, "gateway: registering active local engine as provider");
        env.push((ENV_LOCAL_LLM_URL.to_owned(), url));
    }
    // Context compression (M2 / #425): when the headroom proxy is enabled, turn
    // on the gateway's egress compression transform and point it at the proxy.
    // This auto-wraps every gateway-routed agent. The gateway fails open if the
    // proxy is unreachable, so this is safe even before headroom is healthy.
    if crate::sidecar::headroom::is_enabled() {
        let policy = crate::sidecar::headroom::compression_policy();
        let url = crate::sidecar::headroom::headroom_url();
        tracing::info!(
            %url,
            service = policy.service.as_deref().unwrap_or("headroom"),
            "gateway: enabling egress compression"
        );
        env.push(("GATEWAY_COMPRESSION_ENABLED".to_owned(), "1".to_owned()));
        env.push(("GATEWAY_COMPRESSION_URL".to_owned(), url));
        // Forward the rest of the plugin-defined service config so the whole
        // compression setup is data-driven (any compression plugin, not just the
        // bundled headroom one).
        if let Some(token) = policy.token {
            env.push(("GATEWAY_COMPRESSION_TOKEN".to_owned(), token));
        }
        if let Some(timeout_ms) = policy.timeout_ms {
            env.push((
                "GATEWAY_COMPRESSION_TIMEOUT_MS".to_owned(),
                timeout_ms.to_string(),
            ));
        }
        if let Some(min_messages) = policy.min_messages {
            env.push((
                "GATEWAY_COMPRESSION_MIN_MESSAGES".to_owned(),
                min_messages.to_string(),
            ));
        }
    }
    // Gateway policy plugins (M2 / #447): the firewall and smart-routing policies
    // are boolean-shaped on/off switches that force their gateway feature on when
    // their Policy plugin is enabled. Core flips a process-global flag (seeded
    // from the plugin's persisted state at startup) and this spawn-env injects the
    // matching `GATEWAY_*` env so the gateway config-load forces the feature on.
    // The rich definitions (firewall pattern set, routing model_map/rules) stay
    // owned by `/v1/config` — the plugin only toggles active state.
    if crate::sidecar::gateway_policy::firewall_enabled() {
        tracing::info!("gateway: firewall policy plugin enabled, forcing firewall on");
        env.push(("GATEWAY_FIREWALL_ENABLED".to_owned(), "1".to_owned()));
    }
    if crate::sidecar::gateway_policy::routing_enabled() {
        tracing::info!("gateway: routing policy plugin enabled, forcing smart routing on");
        env.push(("GATEWAY_SMART_ROUTING_ENABLED".to_owned(), "1".to_owned()));
    }
    // Composio (#456 deep integration): inject the user's Composio API key so the
    // gateway's tool loop is enabled — key presence alone flips
    // `ComposioConfig.enabled` (apps/gateway/src/config.rs). Resolved from the
    // in-process resolver (preferences-first, env fallback); this spawn path is
    // sync, so it must not touch the async PreferencesStore. On a key change the
    // preferences handler calls `GatewayManager::refresh()` to respawn with the
    // new value.
    if let Some(key) = crate::composio_auth::key() {
        tracing::info!("gateway: Composio key present, enabling tool loop");
        env.push(("COMPOSIO_API_KEY".to_owned(), key));
    } else if managed_node() {
        // On a managed node Composio is the expected zero-setup default (mirrors
        // the OpenRouter block below); warn (do not fail) so an operator notices
        // a missing credential. Resolved through the env fallback in
        // `composio_auth::key()` (`RYU_COMPOSIO_API_KEY` / `COMPOSIO_API_KEY`),
        // which a headless managed node sets — never the desktop UI.
        tracing::warn!(
            "gateway: managed node has no Composio key (set RYU_COMPOSIO_API_KEY); Composio tool loop will be inactive"
        );
    }
    // OpenRouter (A4 / #501): inject the resolved OpenRouter API key so the
    // gateway activates its `openrouter` provider — key presence alone flips it
    // on (apps/gateway/src/config.rs). Resolved through the same preferences-
    // first/env-fallback resolver as Composio, so a key set in the desktop UI
    // (persisted, never on Core's process env) still reaches the gateway. This
    // is unconditional, not gated on `managed`: a key resolving means the
    // operator/user wants OpenRouter, exactly like the Composio block above.
    // The whole point on a MANAGED Ryu Cloud node is that the operator sets this
    // once and every end user gets OpenRouter routing with zero setup.
    if let Some(key) = crate::openrouter_auth::key() {
        tracing::info!("gateway: OpenRouter key present, enabling openrouter provider");
        env.push(("OPENROUTER_API_KEY".to_owned(), key));
        // Managed nodes: privacy-by-default. Route only to OpenRouter providers
        // that do not retain/train on prompts. Scoped to managed nodes so a
        // self-host / BYOK user's own routing is never overridden, and skipped
        // when the operator already pinned the policy explicitly.
        if managed_node() && std::env::var_os("OPENROUTER_DATA_COLLECTION").is_none() {
            tracing::info!("gateway: managed node — defaulting OpenRouter data_collection=deny");
            env.push(("OPENROUTER_DATA_COLLECTION".to_owned(), "deny".to_owned()));
        }
    } else if managed_node() {
        // On a managed node OpenRouter is the expected zero-setup default; warn
        // (do not fail) so an operator notices a missing credential.
        tracing::warn!(
            "gateway: managed node has no OpenRouter key (set RYU_OPENROUTER_API_KEY); openrouter provider will be inactive"
        );
    }
    // Cloud media providers (Replicate / Fal): inject the resolved keys so the
    // gateway activates its `replicate` / `fal` providers for cloud image/video
    // generation — key presence alone flips each on. Same preferences-first/env-
    // fallback resolver as OpenRouter above, so a key set in the desktop UI (BYOK)
    // or by a managed-node operator both reach the gateway. On a managed node the
    // operator sets these once and every end user gets cloud media with zero setup.
    if let Some(key) = crate::replicate_auth::key() {
        tracing::info!("gateway: Replicate key present, enabling replicate media provider");
        env.push(("REPLICATE_API_KEY".to_owned(), key));
    }
    if let Some(key) = crate::fal_auth::key() {
        tracing::info!("gateway: Fal key present, enabling fal media provider");
        env.push(("FAL_API_KEY".to_owned(), key));
    }
    // Unified tool gateway (#475): point the gateway's `providers.core` at this
    // Core instance so the gateway's search-based tool loop and `/v1/exec/tool`
    // can reach Core's unified catalog (`/api/tools/{search,describe}`,
    // `/api/mcp/tools/call`). Without CORE_URL the gateway leaves `state.tools`
    // = None and the front is inert. NOTE: CORE_URL (providers.core) is distinct
    // from RYU_CORE_URL (the channels listeners' callback URL).
    let core_url = core_self_url();
    tracing::info!(core_url = %core_url, "gateway: wiring unified tool catalog client");
    env.push(("CORE_URL".to_owned(), core_url));
    if let Ok(token) = std::env::var("RYU_TOKEN") {
        if !token.is_empty() {
            env.push(("CORE_TOKEN".to_owned(), token));
        }
    }
    // Mesh (#478, security HIGH / B-9): under userspace networking inbound peers
    // proxy to 127.0.0.1, so the gateway's loopback-admin gates fail OPEN to the
    // tailnet. Push RYU_MESH_ENABLED EXPLICITLY so the value is normalized to "1"
    // regardless of how Core was launched (the gateway child does inherit Core's
    // env, but we do not rely on that — this guarantees the signal is set and
    // canonical) so `tools::mesh_enabled()` neutralizes loopback trust on every
    // admin/exec path. Mirror Core's `mesh::is_enabled()` truthy semantics so both
    // sides agree on the same signal.
    if crate::mesh::is_enabled() {
        tracing::info!("gateway: mesh enabled, neutralizing gateway loopback-admin trust");
        env.push(("RYU_MESH_ENABLED".to_owned(), "1".to_owned()));
    }
    // Credits debit hook (#505): activate the gateway's per-request wallet debit
    // (apps/gateway/src/pipeline POSTs `{base}/credits/debit`). This is a NOP
    // unless the install is configured for metered billing, so unconfigured
    // local installs stay graceful-degrade (no debit attempted). Markup is 0 —
    // the platform margin is captured at deposit (B2), so usage debits at cost.
    env.extend(credits_spawn_env());
    // Crash reporting tier (#544, P3): forward the user's `crash-reports-enabled`
    // consent + the Sentry DSN so the gateway's Sentry panic tier follows the SAME
    // single toggle (the gateway has no `PreferencesStore`, so it reads these env
    // vars). Consent is the process-global seeded at Core startup from the pref;
    // the DSN is canonicalized to `RYU_SENTRY_DSN`. With no DSN, nothing is
    // forwarded and the gateway tier stays a no-op.
    env.push((
        "RYU_CRASH_REPORTS_ENABLED".to_owned(),
        if crate::crash::is_consented() {
            "1".to_owned()
        } else {
            "0".to_owned()
        },
    ));
    if let Some(dsn) = crate::crash::dsn() {
        env.push(("RYU_SENTRY_DSN".to_owned(), dsn));
    }
    // Data-plane OTLP export + Gateway LLM analytics (#548, P6): forward the user's
    // ONE `diagnostics-export-enabled` consent + the OTLP destination into the
    // gateway sidecar so its `gen_ai.*` spans (#540) drain to the SAME configured
    // backend (PostHog LLM analytics, Axiom, a Collector, …) ONLY when the user
    // opted in. The gateway reads these env vars in `telemetry::build_otlp_layer`
    // (it has no `PreferencesStore`); Core seeded the process-globals from the pref
    // at startup. With consent OFF or no endpoint, the gateway's gate is a true
    // no-op and NOTHING egresses — the §6 data-plane opt-in posture, end to end.
    let export_consented = crate::telemetry::is_export_consented();
    let endpoint = if export_consented {
        crate::telemetry::otlp_endpoint()
    } else {
        None
    };
    if let Some(endpoint) = endpoint {
        tracing::info!(
            endpoint = %endpoint,
            "gateway: forwarding consented OTLP export (gen_ai LLM analytics)"
        );
        env.push(("RYU_DIAGNOSTICS_EXPORT_ENABLED".to_owned(), "1".to_owned()));
        env.push(("OTEL_EXPORTER_OTLP_ENDPOINT".to_owned(), endpoint));
        // The `gen_ai.*` attributes are EXPERIMENTAL OTel semconv, gated on this
        // opt-in in the gateway. Enable it so PostHog/Axiom receive the LLM
        // attributes (model/provider/tokens/latency) rather than bare spans.
        env.push((
            "OTEL_SEMCONV_STABILITY_OPT_IN".to_owned(),
            "gen_ai_latest_experimental".to_owned(),
        ));
        // OTLP request headers (auth) — forwarded only when configured. The
        // vendor-neutral `OTEL_EXPORTER_OTLP_HEADERS` works for any sink; the
        // PostHog key convenience is folded in by the resolver.
        if let Some(headers) = crate::telemetry::otlp_headers_env() {
            env.push((crate::telemetry::OTLP_HEADERS_ENV.to_owned(), headers));
        }
    } else {
        // Consent OFF (or no endpoint): push an EXPLICIT "0" rather than relying on
        // absence. The gateway child inherits Core's process env, so an operator-set
        // `OTEL_EXPORTER_OTLP_ENDPOINT` + `RYU_DIAGNOSTICS_EXPORT_ENABLED=1` would
        // otherwise leak through and the gateway would export while Core does not.
        // Forcing "0" neutralizes any inherited endpoint (the gateway's `should_export`
        // requires enabled=true), so "off → nothing sent" holds end-to-end. Mirrors
        // the crash tier, which pushes an explicit "0" for the same reason.
        env.push(("RYU_DIAGNOSTICS_EXPORT_ENABLED".to_owned(), "0".to_owned()));
    }
    env
}

/// Env var enabling the credits debit hook in Core. Default off, so a fresh
/// local install never tries to debit a wallet. The gateway also reads
/// `GATEWAY_CREDITS_ENABLED` directly, but Core gates the whole block on a
/// single is-configured check so unconfigured installs inject nothing at all.
const ENV_CREDITS_ENABLED: &str = "GATEWAY_CREDITS_ENABLED";
/// Env var with the shared internal secret the gateway presents to the control
/// plane (`x-ryu-internal-secret`) so a service-to-service debit for an org is
/// trusted. Without it the debit endpoint rejects the call, so the hook is inert
/// — we therefore treat its presence as a precondition for activation.
const ENV_CREDITS_INTERNAL_SECRET: &str = "RYU_CREDITS_INTERNAL_SECRET";
/// Optional override for the credits control-plane base URL the gateway debits
/// against. When unset, Core derives it from the control-plane base it already
/// knows (`RYU_CONTROL_PLANE_URL` / `RYU_SERVER_URL`) + the `/api` mount.
const ENV_CREDITS_URL: &str = "GATEWAY_CREDITS_URL";
/// Optional wallet-empty action override (`stop` | `downgrade`). Default `stop`.
const ENV_CREDITS_WALLET_EMPTY_ACTION: &str = "GATEWAY_CREDITS_WALLET_EMPTY_ACTION";
/// Per-tool-call cost in micro-USD for billable Composio executions (#496).
/// Composio is not free, so on the managed plan each executed `composio__*` tool
/// call debits the org wallet by this amount (at cost). Operator-provisioned on a
/// managed node; same name on both sides — Core forwards it to the gateway.
/// Default `0` ⇒ tool calls stay free until a deployment sets a real rate.
const ENV_CREDITS_COST_PER_TOOL_CALL: &str = "GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD";

/// Env var flagging this Core as a **managed node** (e.g. a Ryu Cloud host).
/// On a managed node Core self-registers to the control plane and the gateway
/// is expected to be pre-provisioned with provider creds (OpenRouter, Composio)
/// + the credits hook so end users do zero setup. Default off — a normal local
/// install is never "managed". Read by [`managed_node`] and surfaced on
/// `GET /api/system/info` so a reachable managed node identifies itself.
pub const ENV_MANAGED_NODE: &str = "RYU_MANAGED_NODE";

/// Whether this Core is flagged as a managed node (A4 / #501). Truthy =
/// `1` / `true` / `yes`. Public so the control-plane registration path and the
/// system-info surface share one definition.
pub fn managed_node() -> bool {
    env_truthy(ENV_MANAGED_NODE)
}

/// Whether truthy: `1` / `true` / `yes` (case-insensitive). Anything else is
/// false, so the hook stays off by default.
fn env_truthy(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// The internal debit secret, if configured (env, trimmed, non-empty).
fn credits_internal_secret() -> Option<String> {
    std::env::var(ENV_CREDITS_INTERNAL_SECRET)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Resolve the control-plane base URL the credits debit targets.
///
/// Resolution order (nothing hardcoded — every step is a swappable default):
///   1. An explicit `GATEWAY_CREDITS_URL` always wins (operator override).
///   2. Otherwise derive it from the control-plane base Core already knows
///      (`RYU_CONTROL_PLANE_URL` → `RYU_SERVER_URL` → the local dev default)
///      with the `/api` mount the credits router lives under appended.
fn credits_base_url() -> String {
    if let Ok(url) = std::env::var(ENV_CREDITS_URL) {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_owned();
        }
    }
    let base = std::env::var("RYU_CONTROL_PLANE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("RYU_SERVER_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "http://127.0.0.1:3000".to_owned());
    let base = base.trim().trim_end_matches('/');
    // The credits router is mounted under `/api` (POST /api/credits/debit), and
    // the gateway appends `/credits/debit` to `GATEWAY_CREDITS_URL`, so the base
    // it receives must end in `/api`. Avoid doubling it if the operator URL
    // already includes the mount.
    if base.ends_with("/api") {
        base.to_owned()
    } else {
        format!("{base}/api")
    }
}

/// Whether the credits debit hook is configured for this install.
///
/// Requires BOTH the explicit enable signal AND the internal secret: without
/// the secret the control plane rejects every debit, so injecting the block
/// would be pointless and could surface confusing failures. When this is false
/// Core injects no `GATEWAY_CREDITS_*` vars at all, leaving the gateway hook a
/// NOP (graceful degrade preserved for local/unconfigured installs).
fn credits_configured() -> bool {
    env_truthy(ENV_CREDITS_ENABLED) && credits_internal_secret().is_some()
}

/// Env Core layers onto the gateway to activate the per-request wallet debit
/// (#505). Empty unless [`credits_configured`] — so unconfigured installs are
/// untouched. `GATEWAY_CREDITS_MARKUP_BPS` is pinned to `0`: usage is debited at
/// cost and the platform margin is captured at deposit (B2).
fn credits_spawn_env() -> Vec<(String, String)> {
    if !credits_configured() {
        return Vec::new();
    }
    let Some(secret) = credits_internal_secret() else {
        return Vec::new();
    };
    let base = credits_base_url();
    let action = std::env::var(ENV_CREDITS_WALLET_EMPTY_ACTION)
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s == "stop" || s == "downgrade")
        .unwrap_or_else(|| "stop".to_owned());
    // Per-tool-call (Composio) cost: forward the operator-provisioned rate,
    // defaulting to "0" (free) when unset so non-managed installs are unchanged.
    // Only a valid non-negative integer is honoured; anything else falls to 0.
    let tool_call_cost = std::env::var(ENV_CREDITS_COST_PER_TOOL_CALL)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| s.parse::<u64>().is_ok())
        .unwrap_or_else(|| "0".to_owned());
    tracing::info!(
        base_url = %base,
        wallet_empty_action = %action,
        tool_call_cost_micro_usd = %tool_call_cost,
        "gateway: activating credits debit hook (usage + tool calls debited at cost, markup_bps=0)"
    );
    vec![
        (ENV_CREDITS_ENABLED.to_owned(), "true".to_owned()),
        (ENV_CREDITS_URL.to_owned(), base),
        (ENV_CREDITS_INTERNAL_SECRET.to_owned(), secret),
        ("GATEWAY_CREDITS_MARKUP_BPS".to_owned(), "0".to_owned()),
        (ENV_CREDITS_COST_PER_TOOL_CALL.to_owned(), tool_call_cost),
        (ENV_CREDITS_WALLET_EMPTY_ACTION.to_owned(), action),
    ]
}

/// Derive the URL the gateway should use to reach *this* Core instance.
///
/// Core binds from `--bind=` / `RYU_BIND` / the `127.0.0.1:7980` default. This
/// spawn path is sync (does not see Core's parsed args), so we read `RYU_BIND`
/// directly. A wildcard bind host (`0.0.0.0` / `::`) is not a usable client
/// host, so it is rewritten to loopback.
fn core_self_url() -> String {
    let bind = std::env::var("RYU_BIND").unwrap_or_else(|_| "127.0.0.1:7980".to_owned());
    let (host, port) = match bind.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (bind.as_str(), "7980"),
    };
    let host = match host.trim() {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        other => other,
    };
    format!("http://{host}:{port}")
}

/// Whether Core should spawn and manage the gateway process itself.
/// Defaults to `true`; set `RYU_GATEWAY_MANAGED=0`/`false` to point Core at an
/// already-running (e.g. shared/cloud) gateway instead.
fn is_managed() -> bool {
    match std::env::var(ENV_GATEWAY_MANAGED) {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"),
        Err(_) => true,
    }
}

/// Manages the local gateway child process.
pub struct GatewayManager {
    handle: ProcessHandle,
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            handle: ProcessHandle::new(),
        }
    }

    /// Spawn the gateway (unless externally managed) and wait for it to report
    /// healthy. Returns `Ok(true)` when a healthy gateway is reachable,
    /// `Ok(false)` when Core is configured to use an external gateway (caller
    /// should not assume it is up), and `Err` when a managed spawn failed.
    pub async fn start(&self) -> anyhow::Result<bool> {
        if !is_managed() {
            tracing::info!(
                url = %gateway_url(),
                "gateway: externally managed (RYU_GATEWAY_MANAGED disabled), not spawning"
            );
            return Ok(false);
        }

        // Already healthy (e.g. a separately launched gateway on the same port)?
        if health_check(&gateway_url()).await {
            tracing::info!(url = %gateway_url(), "gateway: already running, reusing");
            return Ok(true);
        }

        let bin = std::env::var(ENV_GATEWAY_BIN)
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_GATEWAY_BIN.to_owned());

        let bind = gateway_bind_from_url();
        tracing::info!(bin = %bin, bind = %bind, "gateway: spawning");

        // Inherit Core's environment so provider credentials flow to the
        // gateway, which owns them and forwards to the engine/provider. On top
        // of that, point the gateway's `local` provider at the active local
        // engine so a model bound to it routes through the gateway to that
        // engine (U19).
        let env = gateway_spawn_env();
        self.handle
            .start_path_with_env(&bin, &[format!("--bind={bind}")], &env)
            .await
            .map_err(|e| anyhow::anyhow!("failed to spawn ryu-gateway ({bin}): {e}"))?;

        // Wait for health, polling for a short window.
        for _ in 0..30 {
            if health_check(&gateway_url()).await {
                tracing::info!(url = %gateway_url(), "gateway: healthy");
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        anyhow::bail!("ryu-gateway spawned but did not become healthy in time")
    }

    /// Re-point the gateway at the currently active local engine.
    ///
    /// Called after a local-engine swap (U4) so the gateway's `local` provider
    /// follows the active engine and the swap stays invisible to agents (U19).
    /// For a Core-managed gateway this stops and respawns the child with fresh
    /// `LOCAL_LLM_URL` env. For an externally managed gateway it is a no-op
    /// (Core does not own that process), so the caller should treat a swap as
    /// best-effort there.
    pub async fn refresh(&self) -> anyhow::Result<bool> {
        if !is_managed() {
            tracing::info!("gateway: externally managed, skipping refresh after engine swap");
            return Ok(false);
        }
        if self.handle.is_running() {
            self.handle.stop().await?;
        }
        self.start().await
    }

    /// Whether a managed gateway child is currently running.
    pub fn is_running(&self) -> bool {
        self.handle.is_running()
    }

    /// Stop the managed gateway child (if any).
    pub async fn stop(&self) -> anyhow::Result<()> {
        self.handle.stop().await
    }
}

impl Default for GatewayManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Derive the gateway `--bind=host:port` from the configured URL so the spawned
/// process listens where Core forwards.
fn gateway_bind_from_url() -> String {
    let url = gateway_url();
    let stripped = url
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    if stripped.contains(':') {
        stripped.to_owned()
    } else {
        format!("{stripped}:7981")
    }
}

/// Returns `true` when the gateway at [`gateway_url`] responds healthy.
///
/// Used by the OpenAI-compat routing path to decide whether to forward through
/// the gateway or fall back to the direct provider path (graceful degradation).
pub async fn is_healthy() -> bool {
    health_check(&gateway_url()).await
}

// ── Exec audit / budget gate (M6 / #192) ─────────────────────────────────────
//
// Core calls these two functions to implement the Gateway-owns-policy rule for
// sandbox executions:
//   1. `check_exec_budget`  — pre-run, fail-closed gate (policy = allowed/deny).
//   2. `report_exec_audit`  — post-run, best-effort record (already ran, so
//      if the gateway blinks here we log a warning but don't fail the caller).
//
// Env: `RYU_ALLOW_GATEWAY_FALLBACK=1` opts into fail-open on the pre-run gate
// (identical semantics to the chat-path fallback env var).

/// Env var name: when set to `1`, a gateway-unreachable pre-run check allows
/// execution instead of failing closed. Default: fail-closed.
const ENV_ALLOW_GATEWAY_FALLBACK: &str = "RYU_ALLOW_GATEWAY_FALLBACK";

/// Env var that controls gateway base-URL injection into ACP subprocess spawns.
///
/// Default: injection enabled (`"1"`). Set to `"0"` / `"false"` / `"no"` to
/// disable injection so the subprocess talks directly to its provider (BYO-endpoint
/// mode). This satisfies the BYO principle: users who supply their own provider
/// keys and endpoints can bypass the local gateway completely.
const ENV_ACP_GATEWAY_INJECT: &str = "RYU_ACP_GATEWAY_INJECT";

/// Returns `true` when gateway base-URL injection into ACP subprocess spawns is
/// enabled (the default). Opt out by setting `RYU_ACP_GATEWAY_INJECT=0`.
pub fn should_inject_gateway() -> bool {
    !matches!(
        std::env::var(ENV_ACP_GATEWAY_INJECT)
            .as_deref()
            .unwrap_or("1"),
        "0" | "false" | "no"
    )
}

fn allow_fallback() -> bool {
    matches!(
        std::env::var(ENV_ALLOW_GATEWAY_FALLBACK)
            .as_deref()
            .unwrap_or(""),
        "1" | "true" | "yes"
    )
}

/// Outcome of a pre-run exec budget check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecBudgetOutcome {
    /// Execution is permitted.
    Allow,
    /// Gateway denied the execution (budget exhausted, action=stop).
    Deny(String),
}

/// Check with the gateway whether a sandbox execution is permitted.
///
/// Fail-closed: if the gateway is unreachable AND `RYU_ALLOW_GATEWAY_FALLBACK`
/// is not set, this returns `Deny` so Core refuses to run the exec. This
/// satisfies hard constraint #1 (fail-closed gateway).
///
/// `api_key` is the bearer token Core uses to talk to the gateway.
pub async fn check_exec_budget(backend: &str, command: &str) -> ExecBudgetOutcome {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/budget/check", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "backend": backend,
            "command": command,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                let allowed = body
                    .get("allowed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                if allowed {
                    ExecBudgetOutcome::Allow
                } else {
                    let reason = body
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("exec budget exhausted")
                        .to_owned();
                    ExecBudgetOutcome::Deny(reason)
                }
            }
            Err(e) => {
                tracing::warn!("exec budget check: could not parse gateway response: {e}");
                if allow_fallback() {
                    ExecBudgetOutcome::Allow
                } else {
                    ExecBudgetOutcome::Deny(
                        "gateway response parse error; set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                            .to_owned(),
                    )
                }
            }
        },
        Ok(resp) => {
            // Non-2xx from gateway = explicit deny.
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("exec budget check: gateway returned {status}: {body}");
            ExecBudgetOutcome::Deny(format!("gateway denied exec: HTTP {status}"))
        }
        Err(e) => {
            // Network error: gateway unreachable.
            tracing::warn!("exec budget check: gateway unreachable: {e}");
            if allow_fallback() {
                tracing::warn!(
                    "exec budget check: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK=1, allowing"
                );
                ExecBudgetOutcome::Allow
            } else {
                ExecBudgetOutcome::Deny(format!(
                    "gateway unreachable ({e}); set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                ))
            }
        }
    }
}

// ── Command-approval scan gate (POST /v1/exec/scan) ──────────────────────────
//
// A second, orthogonal pre-run gate alongside the budget check: the gateway
// scans the actual command against its policy (firewall patterns, allow/deny
// rules) and returns a verdict. Unlike the budget gate this control is OPT-IN —
// it only calls the gateway when `RYU_EXEC_APPROVAL_MODE` is set to something
// other than `off`, so an install that never sets it behaves exactly as before
// (the scan short-circuits to Allow with no network call). When enabled it is
// fail-closed on the same terms as the budget gate: unreachable / non-2xx /
// parse error => Deny unless `RYU_ALLOW_GATEWAY_FALLBACK=1`.

/// Env var selecting the command-approval mode. Unset or `off` (case-insensitive)
/// disables the scan entirely (Core does not call the gateway and always allows).
/// Any other value enables the fail-closed scan gate.
const ENV_EXEC_APPROVAL_MODE: &str = "RYU_EXEC_APPROVAL_MODE";

/// Whether the command-approval scan gate is enabled. Off when the env var is
/// unset or equals `off` (case-insensitive, trimmed) — preserving prior behavior
/// for any install that does not opt in.
fn exec_approval_enabled() -> bool {
    match std::env::var(ENV_EXEC_APPROVAL_MODE) {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "off"),
        Err(_) => false,
    }
}

/// Outcome of a pre-run exec scan (`POST /v1/exec/scan`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecScanOutcome {
    /// The gateway allows the command (or the gate is disabled).
    Allow,
    /// The gateway denied the command (policy violation, or fail-closed on an
    /// unreachable/unparseable gateway). Carries a human-readable reason.
    Deny(String),
    /// The gateway requires human approval before the command may run. Carries
    /// the gateway's reason so the caller can surface it.
    ApprovalRequired(String),
}

/// Map a gateway `decision` string (+ `reason`) to an [`ExecScanOutcome`].
/// `allow` allows; `approval_required` requires approval; **any other value**
/// (including `deny` and unknown verdicts) is a fail-closed deny.
fn map_scan_decision(decision: &str, reason: &str) -> ExecScanOutcome {
    match decision {
        "allow" => ExecScanOutcome::Allow,
        "approval_required" => ExecScanOutcome::ApprovalRequired(if reason.is_empty() {
            "command requires approval".to_owned()
        } else {
            reason.to_owned()
        }),
        _ => ExecScanOutcome::Deny(if reason.is_empty() {
            "command denied by gateway policy".to_owned()
        } else {
            reason.to_owned()
        }),
    }
}

/// Scan a command against gateway policy before running it
/// (`POST /v1/exec/scan`). Mirrors [`check_exec_budget`]'s base-url, auth, and
/// fail-closed semantics.
///
/// Short-circuits to `Allow` **without** any network call when the gate is
/// disabled (`RYU_EXEC_APPROVAL_MODE` unset or `off`), so behavior is unchanged
/// for installs that do not opt in.
///
/// Fail-closed when enabled: an unreachable gateway, a non-2xx response, or an
/// unparseable body all map to `Deny` unless `RYU_ALLOW_GATEWAY_FALLBACK=1` is
/// set (then `Allow`), identical to the budget gate.
pub async fn check_exec_scan(
    backend: &str,
    command: &str,
    session_id: Option<&str>,
    agent: Option<&str>,
) -> ExecScanOutcome {
    // Opt-in: with the gate off, never touch the network and always allow.
    if !exec_approval_enabled() {
        return ExecScanOutcome::Allow;
    }

    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/scan", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "backend": backend,
            "command": command,
            "session_id": session_id,
            "agent": agent,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                let decision = body
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("deny");
                let reason = body.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                map_scan_decision(decision, reason)
            }
            Err(e) => {
                tracing::warn!("exec scan: could not parse gateway response: {e}");
                if allow_fallback() {
                    ExecScanOutcome::Allow
                } else {
                    ExecScanOutcome::Deny(
                        "gateway response parse error; set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                            .to_owned(),
                    )
                }
            }
        },
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("exec scan: gateway returned {status}: {body}");
            ExecScanOutcome::Deny(format!("gateway denied exec scan: HTTP {status}"))
        }
        Err(e) => {
            tracing::warn!("exec scan: gateway unreachable: {e}");
            if allow_fallback() {
                tracing::warn!(
                    "exec scan: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK=1, allowing"
                );
                ExecScanOutcome::Allow
            } else {
                ExecScanOutcome::Deny(format!(
                    "gateway unreachable ({e}); set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                ))
            }
        }
    }
}

/// Report a completed sandbox execution to the gateway audit store.
///
/// Best-effort: the exec already ran with permission, so if the gateway is
/// unreachable we log a warning but do not fail the caller.
pub async fn report_exec_audit(
    backend: &str,
    command: &str,
    duration_ms: u64,
    exit_code: i32,
    session_id: Option<String>,
    error: Option<String>,
) {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/audit", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "backend": backend,
            "command": command,
            "duration_ms": duration_ms,
            "exit_code": exit_code,
            "session_id": session_id,
            "error": error,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!(
                backend,
                command,
                duration_ms,
                exit_code,
                "exec audit: reported to gateway"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                status = %resp.status(),
                "exec audit: gateway returned non-2xx, event may be lost"
            );
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "exec audit: gateway unreachable, event lost (best-effort)"
            );
        }
    }
}

// ── Identity-vault credential reads (#523) ───────────────────────────────────
//
// The Identity Vault's sealed store lives in Core (it decides *what runs*), but
// reading a credential is a governed action the Gateway owns (*what is
// allowed/measured*). So a credential read mirrors the exec pattern above:
//   1. `check_identity_grant`        — pre-read, fail-closed grant gate.
//   2. `report_credential_read_audit`— post-read, best-effort audit record.
// Same `RYU_ALLOW_GATEWAY_FALLBACK` opt-in to fail-open as the exec gate.

/// Outcome of a pre-read identity grant check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityGrantOutcome {
    /// The read is permitted (the gateway approved the grant).
    Allow,
    /// The read is denied (grant not approved, or gateway unreachable while
    /// fail-closed). Carries a human-readable reason.
    Deny(String),
}

/// Check with the Gateway whether reading an identity-vault credential is
/// permitted, by validating the `identity.read` grant against gateway policy
/// (`POST /v1/grants/validate`, the same endpoint the plugin lifecycle uses).
///
/// Fail-closed: a denied grant, an unparseable response, or an unreachable
/// gateway all return `Deny` unless `RYU_ALLOW_GATEWAY_FALLBACK=1` is set. This
/// keeps the moat (scope enforcement) in the Gateway: Core never approves a read
/// on its own.
///
/// `scope` is the grant scope to check (e.g. `"identity.read"`); `context` is an
/// opaque attribution string (e.g. the domain) forwarded as `app_id` for the
/// gateway's logs — never a secret.
pub async fn check_identity_grant(scope: &str, context: &str) -> IdentityGrantOutcome {
    let base = gateway_url();
    let endpoint = format!("{}/v1/grants/validate", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "app_id": context,
            "grants": [scope],
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                // `all_approved` is authoritative; fall back to an empty `denied`
                // list (the gateway derives one from the other).
                let approved = body
                    .get("all_approved")
                    .and_then(|v| v.as_bool())
                    .unwrap_or_else(|| {
                        body.get("denied")
                            .and_then(|v| v.as_array())
                            .map(|d| d.is_empty())
                            .unwrap_or(false)
                    });
                if approved {
                    IdentityGrantOutcome::Allow
                } else {
                    IdentityGrantOutcome::Deny(format!("grant `{scope}` denied by gateway policy"))
                }
            }
            Err(e) => {
                tracing::warn!("identity grant check: could not parse gateway response: {e}");
                if allow_fallback() {
                    IdentityGrantOutcome::Allow
                } else {
                    IdentityGrantOutcome::Deny(
                        "gateway response parse error; set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                            .to_owned(),
                    )
                }
            }
        },
        Ok(resp) => {
            let status = resp.status();
            tracing::warn!("identity grant check: gateway returned {status}");
            IdentityGrantOutcome::Deny(format!("gateway denied identity read: HTTP {status}"))
        }
        Err(e) => {
            tracing::warn!("identity grant check: gateway unreachable: {e}");
            if allow_fallback() {
                tracing::warn!(
                    "identity grant check: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK=1, allowing"
                );
                IdentityGrantOutcome::Allow
            } else {
                IdentityGrantOutcome::Deny(format!(
                    "gateway unreachable ({e}); set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                ))
            }
        }
    }
}

/// Report a completed identity-vault credential read to the gateway audit store
/// (`POST /v1/exec/audit` with `event_type=credential_read`).
///
/// Best-effort, like [`report_exec_audit`]: the read already happened under a
/// granted scope, so a gateway blink here only logs a warning. The payload
/// carries the `source` (CredentialSource id) and `domain` for attribution —
/// **never** the decrypted credential.
pub async fn report_credential_read_audit(
    source: &str,
    domain: &str,
    session_id: Option<String>,
    error: Option<String>,
) {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/audit", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "event_type": "credential_read",
            // `backend` = the CredentialSource id, `command` = the domain. The
            // exec-only fields are inert for a credential-read row.
            "backend": source,
            "command": domain,
            "duration_ms": 0,
            "exit_code": 0,
            "session_id": session_id,
            "error": error,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!(
                source,
                domain,
                "identity audit: credential read reported to gateway"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                status = %resp.status(),
                "identity audit: gateway returned non-2xx, event may be lost"
            );
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "identity audit: gateway unreachable, event lost (best-effort)"
            );
        }
    }
}

/// GET `{base}/health`; returns true on a 2xx response.
async fn health_check(base_url: &str) -> bool {
    let endpoint = format!("{}/health", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    matches!(
        client
            .get(&endpoint)
            .timeout(Duration::from_millis(500))
            .send()
            .await,
        Ok(resp) if resp.status().is_success()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_url_defaults_to_loopback() {
        // Without RYU_GATEWAY_URL set in this process, the default applies.
        if std::env::var(ENV_GATEWAY_URL).is_err() {
            assert_eq!(gateway_url(), DEFAULT_GATEWAY_URL);
        }
    }

    #[test]
    fn bind_extracts_host_port_from_url() {
        // Default URL has an explicit port → host:port preserved.
        let bind = gateway_bind_from_url();
        assert!(
            bind.contains(':'),
            "bind should contain host:port, got {bind}"
        );
    }

    #[test]
    fn explicit_local_llm_url_takes_precedence() {
        // An operator-set LOCAL_LLM_URL must win over the active-engine mapping
        // so a custom/external local server can be targeted.
        let prev = std::env::var(ENV_LOCAL_LLM_URL).ok();
        std::env::set_var(ENV_LOCAL_LLM_URL, "http://example.test:9999/v1");
        assert_eq!(
            local_engine_gateway_url().as_deref(),
            Some("http://example.test:9999/v1")
        );
        match prev {
            Some(v) => std::env::set_var(ENV_LOCAL_LLM_URL, v),
            None => std::env::remove_var(ENV_LOCAL_LLM_URL),
        }
    }

    /// Snapshot + restore a set of env vars so a test that mutates process env
    /// does not leak into the others (cargo runs tests in the same process).
    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }
    impl EnvGuard {
        fn capture(names: &[&'static str]) -> Self {
            let saved = names.iter().map(|n| (*n, std::env::var(n).ok())).collect();
            for n in names {
                std::env::remove_var(n);
            }
            Self { saved }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (n, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(n, val),
                    None => std::env::remove_var(n),
                }
            }
        }
    }

    /// Serializes the credits tests that mutate process-global env vars. cargo
    /// runs tests in one process and in parallel, so without this two of them can
    /// race on the same vars between `EnvGuard::capture` and its `Drop` restore.
    /// Poison-tolerant: a panicking test must not cascade-fail the rest.
    static CREDITS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_credits_env() -> std::sync::MutexGuard<'static, ()> {
        CREDITS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    const CREDITS_ENV: &[&str] = &[
        ENV_CREDITS_ENABLED,
        ENV_CREDITS_INTERNAL_SECRET,
        ENV_CREDITS_URL,
        ENV_CREDITS_WALLET_EMPTY_ACTION,
        ENV_CREDITS_COST_PER_TOOL_CALL,
        "RYU_CONTROL_PLANE_URL",
        "RYU_SERVER_URL",
    ];

    #[test]
    fn credits_env_absent_when_unconfigured() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        // Nothing set → NOP, no vars injected (graceful degrade preserved).
        assert!(credits_spawn_env().is_empty());
        assert!(!credits_configured());

        // Enabled but no secret → still inert (control plane would reject).
        std::env::set_var(ENV_CREDITS_ENABLED, "true");
        assert!(!credits_configured());
        assert!(credits_spawn_env().is_empty());

        // Secret but not enabled → still inert.
        std::env::remove_var(ENV_CREDITS_ENABLED);
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "shh");
        assert!(!credits_configured());
        assert!(credits_spawn_env().is_empty());
    }

    #[test]
    fn credits_env_present_when_configured() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        std::env::set_var(ENV_CREDITS_ENABLED, "1");
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "  top-secret  ");
        std::env::set_var("RYU_CONTROL_PLANE_URL", "https://cp.example.test");

        assert!(credits_configured());
        let env = credits_spawn_env();
        let get = |k: &str| {
            env.iter()
                .find(|(name, _)| name == k)
                .map(|(_, v)| v.as_str())
        };

        assert_eq!(get(ENV_CREDITS_ENABLED), Some("true"));
        // Secret trimmed, never echoed elsewhere.
        assert_eq!(get(ENV_CREDITS_INTERNAL_SECRET), Some("top-secret"));
        // Markup pinned to 0 — margin is at deposit (B2).
        assert_eq!(get("GATEWAY_CREDITS_MARKUP_BPS"), Some("0"));
        // Per-tool-call cost defaults to 0 (free) until a node provisions a rate.
        assert_eq!(get(ENV_CREDITS_COST_PER_TOOL_CALL), Some("0"));
        // Wallet-empty action defaults to Stop.
        assert_eq!(get(ENV_CREDITS_WALLET_EMPTY_ACTION), Some("stop"));
        // Base derived from the control-plane URL + the `/api` mount.
        assert_eq!(get(ENV_CREDITS_URL), Some("https://cp.example.test/api"));
    }

    #[test]
    fn credits_base_url_resolution() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);

        // Default local dev when nothing is set.
        assert_eq!(credits_base_url(), "http://127.0.0.1:3000/api");

        // RYU_SERVER_URL is the fallback.
        std::env::set_var("RYU_SERVER_URL", "http://server.test:3000/");
        assert_eq!(credits_base_url(), "http://server.test:3000/api");

        // RYU_CONTROL_PLANE_URL wins over RYU_SERVER_URL.
        std::env::set_var("RYU_CONTROL_PLANE_URL", "http://cp.test:3000");
        assert_eq!(credits_base_url(), "http://cp.test:3000/api");

        // An explicit GATEWAY_CREDITS_URL always wins, and an existing `/api`
        // mount is not doubled.
        std::env::set_var(ENV_CREDITS_URL, "http://explicit.test/api/");
        assert_eq!(credits_base_url(), "http://explicit.test/api");
    }

    #[test]
    fn credits_wallet_empty_action_downgrade_passthrough() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        std::env::set_var(ENV_CREDITS_ENABLED, "yes");
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "s");
        std::env::set_var(ENV_CREDITS_WALLET_EMPTY_ACTION, "Downgrade");
        let env = credits_spawn_env();
        let action = env
            .iter()
            .find(|(k, _)| k == ENV_CREDITS_WALLET_EMPTY_ACTION)
            .map(|(_, v)| v.as_str());
        assert_eq!(action, Some("downgrade"));
    }

    #[test]
    fn credits_tool_call_cost_passthrough() {
        // #496: an operator-provisioned per-tool-call (Composio) cost is forwarded
        // to the gateway verbatim; a non-integer value falls back to "0" (free).
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        std::env::set_var(ENV_CREDITS_ENABLED, "1");
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "s");

        std::env::set_var(ENV_CREDITS_COST_PER_TOOL_CALL, "1500");
        let env = credits_spawn_env();
        let cost = env
            .iter()
            .find(|(k, _)| k == ENV_CREDITS_COST_PER_TOOL_CALL)
            .map(|(_, v)| v.as_str());
        assert_eq!(cost, Some("1500"));

        // Garbage → 0, never propagated as an invalid value.
        std::env::set_var(ENV_CREDITS_COST_PER_TOOL_CALL, "not-a-number");
        let env = credits_spawn_env();
        let cost = env
            .iter()
            .find(|(k, _)| k == ENV_CREDITS_COST_PER_TOOL_CALL)
            .map(|(_, v)| v.as_str());
        assert_eq!(cost, Some("0"));
    }

    #[test]
    fn managed_node_zero_setup_provider_keys_resolve_from_env() {
        // A4 / #501: a headless managed node sets provider keys via env (never the
        // desktop UI), and the resolvers must pick them up so the gateway spawn
        // injects them with zero user setup. Pins the env-fallback contract both
        // `gateway_spawn_env` blocks depend on.
        let _g = EnvGuard::capture(&[
            ENV_MANAGED_NODE,
            "RYU_OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
            "RYU_COMPOSIO_API_KEY",
            "COMPOSIO_API_KEY",
        ]);
        std::env::set_var(ENV_MANAGED_NODE, "1");
        std::env::set_var("RYU_OPENROUTER_API_KEY", "sk-or-managed");
        std::env::set_var("RYU_COMPOSIO_API_KEY", "comp-managed");
        // Clear any in-process preference cache a concurrent test may have set, so
        // resolution falls through to the env vars this test controls.
        crate::openrouter_auth::set_key("");
        crate::composio_auth::set_key("");
        assert!(managed_node());
        assert_eq!(
            crate::openrouter_auth::key().as_deref(),
            Some("sk-or-managed")
        );
        assert_eq!(crate::composio_auth::key().as_deref(), Some("comp-managed"));
    }

    #[test]
    fn managed_node_defaults_off_and_reads_env() {
        let _g = EnvGuard::capture(&[ENV_MANAGED_NODE]);
        // Unset → not managed.
        assert!(!managed_node());
        // Truthy values flip it on.
        for v in ["1", "true", "yes", "YES", " True "] {
            std::env::set_var(ENV_MANAGED_NODE, v);
            assert!(managed_node(), "{v:?} should be managed");
        }
        // Anything else stays off.
        std::env::set_var(ENV_MANAGED_NODE, "0");
        assert!(!managed_node());
    }

    /// #447: the four gateway/sandbox policy plugins (compression / firewall /
    /// routing / sandbox) round-trip through their on/off flag into the surface
    /// the gateway actually reads. Three are gateway-spawn-env policies, so they
    /// must appear in `gateway_spawn_env` when ON and vanish when OFF; the fourth
    /// (sandbox) is Core-local, so it round-trips through `sandbox::is_enabled()`,
    /// NOT the gateway env. This is the test that lets #447 close: every policy
    /// `apply_policy` flips is observable end-to-end.
    #[test]
    fn policy_flags_roundtrip_into_their_surface() {
        // The three gateway-env policies. Capture their dev-seed env so a stray
        // GATEWAY_* in the runner does not skew the OFF assertions.
        let _g = EnvGuard::capture(&[
            "GATEWAY_FIREWALL_ENABLED",
            "GATEWAY_SMART_ROUTING_ENABLED",
            "RYU_HEADROOM_ENABLED",
            "GATEWAY_COMPRESSION_ENABLED",
            // Sandbox toggles via this env var; restore it so the test leaves no
            // residue (cargo runs all tests in one process).
            "RYU_SANDBOX_DISABLED",
        ]);
        let has = |env: &[(String, String)], key: &str| env.iter().any(|(k, _)| k == key);

        // ── ON: flip every flag the way apply_policy does, assert it lands. ──
        crate::sidecar::gateway_policy::set_firewall_enabled(true);
        crate::sidecar::gateway_policy::set_routing_enabled(true);
        crate::sidecar::headroom::set_enabled(true);
        crate::sidecar::mcp::sandbox::set_enabled(true);

        let env_on = gateway_spawn_env();
        assert!(
            has(&env_on, "GATEWAY_FIREWALL_ENABLED"),
            "firewall policy ON must inject GATEWAY_FIREWALL_ENABLED"
        );
        assert!(
            has(&env_on, "GATEWAY_SMART_ROUTING_ENABLED"),
            "routing policy ON must inject GATEWAY_SMART_ROUTING_ENABLED"
        );
        assert!(
            has(&env_on, "GATEWAY_COMPRESSION_ENABLED"),
            "compression policy ON must inject GATEWAY_COMPRESSION_ENABLED"
        );
        // Sandbox is Core-local — it round-trips through is_enabled, not the env.
        assert!(
            crate::sidecar::mcp::sandbox::is_enabled(),
            "sandbox policy ON must flip sandbox::is_enabled()"
        );

        // ── OFF: every flag back down, every surface clears. ──
        crate::sidecar::gateway_policy::set_firewall_enabled(false);
        crate::sidecar::gateway_policy::set_routing_enabled(false);
        crate::sidecar::headroom::set_enabled(false);
        crate::sidecar::mcp::sandbox::set_enabled(false);

        let env_off = gateway_spawn_env();
        assert!(
            !has(&env_off, "GATEWAY_FIREWALL_ENABLED"),
            "firewall OFF must not inject the env"
        );
        assert!(
            !has(&env_off, "GATEWAY_SMART_ROUTING_ENABLED"),
            "routing OFF must not inject the env"
        );
        assert!(
            !has(&env_off, "GATEWAY_COMPRESSION_ENABLED"),
            "compression OFF must not inject the env"
        );
        assert!(
            !crate::sidecar::mcp::sandbox::is_enabled(),
            "sandbox OFF must flip sandbox::is_enabled() back"
        );
    }

    // ── Command-approval scan gate (check_exec_scan) ─────────────────────────

    /// Serializes the scan-gate tests: they mutate the process-global
    /// `RYU_EXEC_APPROVAL_MODE` / `RYU_GATEWAY_URL` / `RYU_ALLOW_GATEWAY_FALLBACK`
    /// env vars, and cargo runs tests in one process in parallel. Poison-tolerant.
    static SCAN_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_scan_env() -> std::sync::MutexGuard<'static, ()> {
        SCAN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    const SCAN_ENV: &[&str] = &[
        ENV_EXEC_APPROVAL_MODE,
        ENV_GATEWAY_URL,
        ENV_ALLOW_GATEWAY_FALLBACK,
    ];

    #[test]
    fn exec_scan_verdict_mapping() {
        // The pure decision mapper: allow → Allow, approval_required → Approval,
        // deny / anything else → fail-closed Deny.
        assert_eq!(map_scan_decision("allow", ""), ExecScanOutcome::Allow);
        assert_eq!(
            map_scan_decision("approval_required", "needs sign-off"),
            ExecScanOutcome::ApprovalRequired("needs sign-off".to_owned())
        );
        assert_eq!(
            map_scan_decision("deny", "blocked by firewall"),
            ExecScanOutcome::Deny("blocked by firewall".to_owned())
        );
        // Unknown verdict is fail-closed (Deny), never a silent allow.
        assert!(matches!(
            map_scan_decision("wat", ""),
            ExecScanOutcome::Deny(_)
        ));
        // Empty reasons get sensible defaults.
        assert!(matches!(
            map_scan_decision("approval_required", ""),
            ExecScanOutcome::ApprovalRequired(_)
        ));
    }

    #[test]
    fn exec_scan_off_mode_reads_env() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Unset → disabled.
        assert!(!exec_approval_enabled());
        // "off" (any case, trimmed) → disabled.
        for v in ["off", "OFF", " Off "] {
            std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
            assert!(!exec_approval_enabled(), "{v:?} should disable the gate");
        }
        // Any other value → enabled.
        for v in ["on", "enforce", "prompt"] {
            std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
            assert!(exec_approval_enabled(), "{v:?} should enable the gate");
        }
    }

    #[tokio::test]
    async fn exec_scan_off_mode_short_circuits_without_network() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Gate disabled + a guaranteed-unreachable gateway + NO fallback. If the
        // off-mode path touched the network it would fail-closed to Deny; an Allow
        // proves it short-circuited before any HTTP call.
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let out = check_exec_scan("deno", "rm -rf /", Some("sess"), Some("ryu")).await;
        assert_eq!(out, ExecScanOutcome::Allow);
    }

    #[tokio::test]
    async fn exec_scan_unreachable_denies_unless_fallback() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Gate enabled, gateway unreachable, no fallback → fail-closed Deny.
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "enforce");
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let denied = check_exec_scan("deno", "echo hi", None, None).await;
        assert!(
            matches!(denied, ExecScanOutcome::Deny(_)),
            "unreachable gateway must fail closed, got {denied:?}"
        );

        // Same, but with the fallback opt-in → Allow.
        std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
        let allowed = check_exec_scan("deno", "echo hi", None, None).await;
        assert_eq!(allowed, ExecScanOutcome::Allow);
    }
}
