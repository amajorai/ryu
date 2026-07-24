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
///
/// Profile-aware default: release ⇒ `http://127.0.0.1:7981`, dev ⇒ `:8981`, ….
/// (Under a non-release profile `profile::apply_env_defaults` also seeds
/// `RYU_GATEWAY_URL`, so the env branch normally wins; the default is computed via
/// the same `profile::port(7981)` so both agree.)
pub fn gateway_url() -> String {
    std::env::var(ENV_GATEWAY_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(7981)))
}

/// Optional bearer token Core presents to the gateway (only when the gateway
/// runs with `require_auth`). This is the gateway token slot — never a provider
/// API key.
pub fn gateway_token() -> Option<String> {
    std::env::var(ENV_GATEWAY_TOKEN)
        .ok()
        .filter(|s| !s.is_empty())
}

/// Resolve the bearer Core presents to the gateway, fail-closed on a remote data
/// plane (WS1).
///
/// On the normal local path a missing [`gateway_token`] falls back to the local
/// gateway's `"ryu-local"` dev bearer (the local gateway accepts it). In
/// [`remote_data_plane`] mode Core talks to a hosted, multi-tenant gateway fleet
/// that MUST reject the shared `"ryu-local"` literal, so a missing token is a hard
/// error instead of silently presenting a bearer the fleet would 401 — the caller
/// fails closed with a clear reason rather than emitting the shared literal.
pub fn gateway_bearer() -> anyhow::Result<String> {
    if let Some(token) = gateway_token() {
        return Ok(token);
    }
    if remote_data_plane() {
        anyhow::bail!(
            "remote data plane requires RYU_GATEWAY_TOKEN; refusing to present the shared \"ryu-local\" bearer to a hosted multi-tenant gateway"
        );
    }
    Ok("ryu-local".to_owned())
}

/// Route outbound message `text` through the Gateway firewall before it leaves
/// the box (egress DLP). The shared governance seam for every outbound channel
/// send — the workflow `ChannelSend` node and the agent-callable `channel__send`
/// tool both call this, so their egress can never drift.
///
/// Returns `Ok(())` when the gateway allows it (or there is nothing to scan), and
/// `Err(reason)` when a guardrail trips OR the gateway is unreachable
/// (fail-closed, matching `run_guardrails` / the support-bundle egress gate,
/// including the `RYU_ALLOW_GATEWAY_FALLBACK=1` escape hatch). Only `pii`/`secret`
/// are requested — the `jailbreak`/`injection` patterns target inbound prompts,
/// not outbound chat. The firewall has no sanitize surface for Core to call, so a
/// tripped guardrail is block-and-refuse.
pub async fn govern_egress(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
        .ok()
        .is_some_and(|v| v == "1");

    let payload = serde_json::json!({
        "text": text,
        "checks": ["pii", "secret"],
    });

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/firewall/check", gateway_url().trim_end_matches('/'));
    let mut builder = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(10))
        .json(&payload);
    if let Some(token) = gateway_token() {
        builder = builder.bearer_auth(token);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if allow_fallback {
                return Ok(());
            }
            return Err(format!(
                "channel egress: gateway firewall unreachable (fail-closed): {e}"
            ));
        }
    };
    if !resp.status().is_success() {
        if allow_fallback {
            return Ok(());
        }
        return Err(format!(
            "channel egress: gateway firewall returned HTTP {}",
            resp.status()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("channel egress: invalid gateway firewall response: {e}"))?;
    let allowed = body
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err("channel egress: message blocked by the gateway firewall (egress DLP)".to_string())
    }
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
        return local_engine_url(&active);
    }
    let versions = crate::sidecar::download_manager::VersionStore::load();
    if versions.installed_version("llamacpp").is_some() {
        return local_engine_url("llamacpp");
    }
    None
}

/// Build the `PUT {gateway}/v1/config` request for a config patch, carrying the
/// gateway bearer when one is configured. Split out (base/token as params) so the
/// auth-forwarding + URL shape are unit-testable against a local listener without
/// mutating the process environment.
fn gateway_config_request(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    patch: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let base = base.trim_end_matches('/');
    let mut req = client
        .put(format!("{base}/v1/config"))
        .timeout(Duration::from_millis(5000))
        .json(patch);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req
}

/// Push a `/v1/config` patch to the LIVE gateway (the hot-swap path).
///
/// This is the single config-push transport: the `PUT /api/gateway/config` proxy
/// handler AND Core's policy-plugin toggles both route through it, so a firewall /
/// routing toggle reconfigures the RUNNING gateway — local **or** remote (the PUT
/// targets [`gateway_url`], and the gateway hot-swaps on `PUT /v1/config` with no
/// respawn). Returns the gateway's `(status, body)` verbatim so callers can relay
/// the exact status (the proxy) or inspect success (the policy path). Errs only on
/// a transport failure.
pub(crate) async fn push_config(
    client: &reqwest::Client,
    patch: &serde_json::Value,
) -> anyhow::Result<(reqwest::StatusCode, serde_json::Value)> {
    let base = gateway_url();
    let resp = gateway_config_request(client, &base, gateway_token().as_deref(), patch)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("gateway config push failed: {e}"))?;
    let status = resp.status();
    let body = resp
        .json::<serde_json::Value>()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    Ok((status, body))
}

/// Build the `GET {gateway}/v1/config` request, carrying the gateway bearer when
/// one is configured. Split out (base/token as params) so the auth-forwarding +
/// URL shape are unit-testable against a local listener without mutating the
/// process environment. Mirrors [`gateway_config_request`] (the PUT builder).
fn gateway_config_get_request(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let base = base.trim_end_matches('/');
    let mut req = client
        .get(format!("{base}/v1/config"))
        .timeout(Duration::from_millis(5000));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req
}

/// Read the LIVE gateway config (`GET /v1/config`) as JSON — the `ConfigView` with
/// the in-memory firewall/budget/routing state, reflecting any prior hot-swap.
///
/// This is the read half of the config plane; it is **not** a second config-*push*
/// path ([`push_config`] remains the single PUT transport). A policy toggle uses it
/// to read-modify-write the RUNNING gateway's firewall section — sourcing the full
/// live object (`policy`, `locked_fields`, `inspector`, operator `custom_patterns`,
/// …) so the PUT that follows preserves every field it does not intend to change,
/// instead of reconstructing a partial section from Core's local disk (which is
/// empty for a REMOTE gateway → a full-replacement PUT would clobber enforcement).
/// Targets [`gateway_url`] and forwards [`gateway_token`] (the master key), so it
/// works against a remote gateway exactly like the PUT. Errs on a transport failure
/// or a non-2xx status.
pub(crate) async fn fetch_config(client: &reqwest::Client) -> anyhow::Result<serde_json::Value> {
    let base = gateway_url();
    let resp = gateway_config_get_request(client, &base, gateway_token().as_deref())
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("gateway config read failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("gateway GET /v1/config returned {status}: {body}");
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| anyhow::anyhow!("gateway config read: bad JSON: {e}"))
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
    // Provider credentials (Composio / OpenRouter / Replicate / Fal). On a remote
    // data plane (WS1) these keys live ONLY in the hosted gateway fleet — Core must
    // hold and inject NONE of them, so skip the whole block without even resolving
    // the local key prefs. (This is belt-and-suspenders: `start()` never spawns a
    // local gateway in remote mode, so this env is not built there anyway.)
    if remote_data_plane() {
        tracing::info!(
            "gateway: remote data plane — provider keys live in the hosted fleet, injecting none"
        );
    } else {
        push_provider_key_env(&mut env);
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
    // admin/exec path. Mirror Core's `ryu_mesh::is_enabled()` truthy semantics so
    // both sides agree on the same signal.
    if ryu_mesh::is_enabled() {
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

/// Resolve and inject the local provider-credential env (Composio / OpenRouter /
/// Replicate / Fal) onto the gateway spawn env. Only called on a LOCAL data plane
/// (see [`gateway_spawn_env`]) — on a remote data plane the keys live only in the
/// hosted fleet and this is never called, so no local key pref is even resolved.
fn push_provider_key_env(env: &mut Vec<(String, String)>) {
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

/// Sandbox per-resource billing rates, in **nano-USD per unit-second** (`u64`),
/// forwarded to the gateway alongside the credits hook. Rates are nano-USD (not
/// micro) because the Daytona storage rate (0.03 micro-USD/GiB/s) truncates to 0
/// in a micro-USD field; the gateway converts nano→micro once, inside
/// `sandbox_tick_cost_raw_micro`. Defaults mirror the Daytona base table in the
/// FROZEN CONTRACT §1. The gateway also carries these defaults, but Core injects
/// them explicitly so an operator can pin rates on Core's env and have them flow
/// to the managed gateway child (belt-and-suspenders, like the tool-call rate).
const SANDBOX_RATE_ENVS: &[(&str, u64)] = &[
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_VCPU_SECOND_NANO_USD",
        14_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_MEM_GIB_SECOND_NANO_USD",
        4_500,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_STORAGE_GIB_SECOND_NANO_USD",
        30,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H200_SECOND_NANO_USD",
        1_261_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H100_SECOND_NANO_USD",
        1_097_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_PRO_6000_SECOND_NANO_USD",
        842_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_5090_SECOND_NANO_USD",
        358_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_4090_SECOND_NANO_USD",
        275_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_WINDOWS_VCPU_SECOND_NANO_USD",
        23_800,
    ),
];

/// Free storage allowance (GiB) subtracted before storage billing. Default 5.
const ENV_CREDITS_SANDBOX_FREE_STORAGE_GIB: &str = "GATEWAY_CREDITS_SANDBOX_FREE_STORAGE_GIB";
const DEFAULT_SANDBOX_FREE_STORAGE_GIB: u64 = 5;

/// Sandbox markup in basis points. **Distinct from the global
/// `GATEWAY_CREDITS_MARKUP_BPS` (pinned 0)** — sandbox time is billed with a real
/// margin (default 3000 = +30%), so this must NOT reuse the global markup field.
const ENV_CREDITS_SANDBOX_MARKUP_BPS: &str = "GATEWAY_CREDITS_SANDBOX_MARKUP_BPS";
const DEFAULT_SANDBOX_MARKUP_BPS: u64 = 3000;

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

/// Env var flagging this Core node's model-call data plane as **remote** (WS1):
/// model traffic routes to a separate hosted gateway fleet rather than a local
/// gateway. Default off. Set truthy (`1` / `true` / `yes`) on a node whose keys
/// live only in the remote fleet.
pub const ENV_GATEWAY_REMOTE: &str = "RYU_GATEWAY_REMOTE";

/// Whether Core's model-call data plane is remote (WS1). True when
/// [`ENV_GATEWAY_REMOTE`] is truthy, OR this is a [`managed_node`]: a managed Ryu
/// Cloud node routes model traffic to the hosted gateway fleet, so a managed node
/// IS a remote-data-plane node. When true it means: do NOT spawn a local gateway,
/// keys live ONLY in the remote fleet (inject none), and `RYU_GATEWAY_URL` +
/// `RYU_GATEWAY_TOKEN` are required so Core has a governed endpoint to reach.
pub fn remote_data_plane() -> bool {
    env_truthy(ENV_GATEWAY_REMOTE) || managed_node()
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
    let mut env = vec![
        (ENV_CREDITS_ENABLED.to_owned(), "true".to_owned()),
        (ENV_CREDITS_URL.to_owned(), base),
        (ENV_CREDITS_INTERNAL_SECRET.to_owned(), secret),
        ("GATEWAY_CREDITS_MARKUP_BPS".to_owned(), "0".to_owned()),
        (ENV_CREDITS_COST_PER_TOOL_CALL.to_owned(), tool_call_cost),
        (ENV_CREDITS_WALLET_EMPTY_ACTION.to_owned(), action),
    ];
    // Sandbox metering rail (Daytona): forward the per-resource nano-USD rates,
    // the free-storage allowance, and the sandbox markup. Unlike the global
    // markup (pinned 0 — usage bills at cost), sandbox time carries a real margin
    // (default 3000 = +30%), so `GATEWAY_CREDITS_SANDBOX_MARKUP_BPS` is forwarded
    // with its real value, NOT pinned 0.
    env.extend(sandbox_credits_spawn_env());
    env
}

/// Resolve a `u64` env var to its string form, defaulting when unset or invalid.
/// Only a valid non-negative integer is honoured; anything else falls to
/// `default` so a malformed operator value never breaks the spawn.
fn resolve_u64_env_string(name: &str, default: u64) -> String {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| s.parse::<u64>().is_ok())
        .unwrap_or_else(|| default.to_string())
}

/// Build the sandbox-billing env pairs forwarded to the gateway (the nine
/// per-resource nano-USD rates + free-storage allowance + sandbox markup).
/// Resolved from Core's env with the FROZEN CONTRACT §1 defaults so a managed
/// gateway child always receives consistent, real sandbox rates.
fn sandbox_credits_spawn_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = SANDBOX_RATE_ENVS
        .iter()
        .map(|(var, default)| ((*var).to_owned(), resolve_u64_env_string(var, *default)))
        .collect();
    env.push((
        ENV_CREDITS_SANDBOX_FREE_STORAGE_GIB.to_owned(),
        resolve_u64_env_string(
            ENV_CREDITS_SANDBOX_FREE_STORAGE_GIB,
            DEFAULT_SANDBOX_FREE_STORAGE_GIB,
        ),
    ));
    let markup = resolve_u64_env_string(ENV_CREDITS_SANDBOX_MARKUP_BPS, DEFAULT_SANDBOX_MARKUP_BPS);
    tracing::info!(
        sandbox_markup_bps = %markup,
        "gateway: forwarding sandbox metering rates (real markup, NOT pinned 0)"
    );
    env.push((ENV_CREDITS_SANDBOX_MARKUP_BPS.to_owned(), markup));
    env
}

/// Derive the URL the gateway should use to reach *this* Core instance.
///
/// Core binds from `--bind=` / `RYU_BIND` / the `127.0.0.1:7980` default. This
/// spawn path is sync (does not see Core's parsed args), so we read `RYU_BIND`
/// directly. A wildcard bind host (`0.0.0.0` / `::`) is not a usable client
/// host, so it is rewritten to loopback.
pub(crate) fn core_self_url() -> String {
    let default_bind = format!("127.0.0.1:{}", crate::profile::port(7980));
    let bind = std::env::var("RYU_BIND").unwrap_or(default_bind);
    let default_port = crate::profile::port(7980).to_string();
    let (host, port) = match bind.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (bind.as_str(), default_port.as_str()),
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
        // Remote data plane (WS1): a managed/remote Ryu Cloud node routes every
        // model call to a separate hosted gateway fleet, so Core must NOT spawn a
        // local (keyed) gateway — the same effect as an externally managed gateway,
        // but the keys live only in the fleet. Require the remote endpoint + token
        // so chat has a governed place to go; without both Core has no data plane,
        // so fail with a clear startup error rather than silently degrading.
        if remote_data_plane() {
            let has_url = std::env::var(ENV_GATEWAY_URL)
                .ok()
                .filter(|s| !s.is_empty())
                .is_some();
            if !has_url || gateway_token().is_none() {
                anyhow::bail!(
                    "remote data plane (RYU_GATEWAY_REMOTE / managed node) requires both RYU_GATEWAY_URL and RYU_GATEWAY_TOKEN to be set; refusing to spawn a local keyed gateway"
                );
            }
            tracing::info!(
                url = %gateway_url(),
                "gateway: remote data plane — routing to the hosted gateway fleet, not spawning a local gateway"
            );
            return Ok(false);
        }
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
        let args = [format!("--bind={bind}")];
        // Defense-in-depth (WS1): `start()` returns early on a remote data plane,
        // so this spawn is only reached on a LOCAL plane where the gateway legitimately
        // inherits provider creds. Should a gateway child ever be spawned in remote
        // mode, route its env through the scrub allowlist so it cannot inherit a
        // provider key from Core's own process env.
        let spawned = if remote_data_plane() {
            self.handle
                .start_path_with_scrubbed_env(&bin, &args, &env)
                .await
        } else {
            self.handle.start_path_with_env(&bin, &args, &env).await
        };
        spawned.map_err(|e| anyhow::anyhow!("failed to spawn ryu-gateway ({bin}): {e}"))?;

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
// rules) and returns a verdict. This gate is armed BY DEFAULT — an unset
// `RYU_EXEC_APPROVAL_MODE` scans (the gateway's own default mode governs the
// verdict); only an explicit `off` disarms it. The default-on posture is what
// closes the headless auto-approve hole: non-interactive runs (scheduler,
// triggers, healing, delegation) auto-approve permission requests, so without
// this scan they get unattended arbitrary shell/file-write. When armed it is
// fail-closed on the same terms as the budget gate: unreachable / non-2xx /
// parse error => Deny unless `RYU_ALLOW_GATEWAY_FALLBACK=1`.

/// Env var selecting the command-approval mode. An explicit `off`
/// (case-insensitive) disables the scan entirely (Core does not call the gateway
/// and always allows). Unset/empty or any other value arms the fail-closed scan
/// gate — armed is the default.
const ENV_EXEC_APPROVAL_MODE: &str = "RYU_EXEC_APPROVAL_MODE";

/// Whether the command-approval scan gate is enabled. Armed by default (unset /
/// empty env); only an explicit `off` (case-insensitive, trimmed) disarms —
/// governance must be an explicit opt-OUT, never a silent default-off.
fn exec_approval_enabled() -> bool {
    match std::env::var(ENV_EXEC_APPROVAL_MODE) {
        Ok(v) => !v.trim().eq_ignore_ascii_case("off"),
        Err(_) => true,
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
/// Armed by default: only an EXPLICIT `RYU_EXEC_APPROVAL_MODE=off` short-circuits
/// to `Allow` without any network call (the operator's documented opt-out).
///
/// Fail-closed when armed: an unreachable gateway, a non-2xx response, or an
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

/// Shared, poison-tolerant lock serializing EVERY test — in ANY module — that
/// mutates the process-global gateway env vars (`RYU_GATEWAY_URL`,
/// `RYU_ALLOW_GATEWAY_FALLBACK`, and the scan gate's `RYU_EXEC_APPROVAL_MODE`),
/// or that mutates ACP gateway-injection env (`RYU_ACP_GATEWAY_INJECT`) whose
/// spawn commands read `gateway_url()`. cargo runs all tests in one process in
/// parallel, so these globals are only race-free when every toucher holds the
/// *same* lock. This module owns the env constants, so the canonical lock lives
/// here; identity/tool_exec/acp/codex_config/delegate/delegation all grab it.
#[cfg(test)]
pub(crate) static GATEWAY_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire [`GATEWAY_ENV_TEST_LOCK`], recovering a poisoned guard so one
/// panicking test never cascade-fails the rest.
#[cfg(test)]
pub(crate) fn lock_gateway_env() -> std::sync::MutexGuard<'static, ()> {
    GATEWAY_ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Shared, poison-tolerant lock serializing EVERY test — in ANY module — that
/// touches the managed-node gate (`RYU_MANAGED_NODE`) or the process-global
/// provider-auth key caches (`openrouter_auth` / `composio_auth`, plus their
/// `RYU_*_API_KEY` env vars). These globals are entangled (the managed-node
/// zero-setup test reads both), so a single lock guards them all.
#[cfg(test)]
pub(crate) static MANAGED_NODE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire [`MANAGED_NODE_TEST_LOCK`], recovering a poisoned guard.
#[cfg(test)]
pub(crate) fn lock_managed_node_env() -> std::sync::MutexGuard<'static, ()> {
    MANAGED_NODE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
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
        let _lock = super::lock_managed_node_env();
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
        let _lock = super::lock_managed_node_env();
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
        // These flip the process-global policy atomics (firewall / routing /
        // headroom / sandbox); serialize against every other test that reads or
        // writes them, and restore each to its prior value on exit.
        let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
        let prev_firewall = crate::sidecar::gateway_policy::firewall_enabled();
        let prev_routing = crate::sidecar::gateway_policy::routing_enabled();
        let prev_headroom = crate::sidecar::headroom::is_enabled();
        let prev_sandbox = crate::sidecar::mcp::sandbox::is_enabled();
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

        // Restore the flags to their prior values so this test leaves no residue.
        crate::sidecar::gateway_policy::set_firewall_enabled(prev_firewall);
        crate::sidecar::gateway_policy::set_routing_enabled(prev_routing);
        crate::sidecar::headroom::set_enabled(prev_headroom);
        crate::sidecar::mcp::sandbox::set_enabled(prev_sandbox);
    }

    // ── Command-approval scan gate (check_exec_scan) ─────────────────────────

    /// Serializes the scan-gate tests: they mutate the process-global
    /// `RYU_EXEC_APPROVAL_MODE` / `RYU_GATEWAY_URL` / `RYU_ALLOW_GATEWAY_FALLBACK`
    /// env vars. These are the SAME vars other modules' tests touch, so this
    /// delegates to the one crate-wide [`super::GATEWAY_ENV_TEST_LOCK`] rather
    /// than a second parallel lock (two locks on one global do not serialize).
    fn lock_scan_env() -> std::sync::MutexGuard<'static, ()> {
        super::lock_gateway_env()
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
        // Unset → ARMED (the default-on posture; only explicit `off` disarms).
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        assert!(exec_approval_enabled(), "unset must arm the gate");
        // "off" (any case, trimmed) → disabled.
        for v in ["off", "OFF", " Off "] {
            std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
            assert!(!exec_approval_enabled(), "{v:?} should disable the gate");
        }
        // Any other value → enabled.
        for v in ["on", "enforce", "prompt", ""] {
            std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
            assert!(exec_approval_enabled(), "{v:?} should enable the gate");
        }
    }

    #[tokio::test]
    async fn exec_scan_off_mode_short_circuits_without_network() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Gate explicitly disarmed + a guaranteed-unreachable gateway + NO
        // fallback. If the off-mode path touched the network it would fail-closed
        // to Deny; an Allow proves it short-circuited before any HTTP call.
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let out = check_exec_scan("deno", "rm -rf /", Some("sess"), Some("ryu")).await;
        assert_eq!(out, ExecScanOutcome::Allow);
    }

    #[tokio::test]
    async fn exec_scan_default_is_armed_and_fail_closed() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // The load-bearing default: with NOTHING configured, the scan runs and an
        // unreachable gateway fails closed — a default install's headless runs
        // cannot execute unscanned commands.
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let out = check_exec_scan("deno", "echo hi", None, None).await;
        assert!(
            matches!(out, ExecScanOutcome::Deny(_)),
            "default-armed gate must fail closed on an unreachable gateway, got {out:?}"
        );
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

    /// The config-push transport must PUT `/v1/config` and forward the gateway
    /// bearer (the master key on a remote gateway) so a remote/unmanaged gateway
    /// toggle is actually authorized — the item-1 "verify the master-key auth is
    /// sent" requirement. Drives a oneshot listener so no process env is touched.
    #[tokio::test]
    async fn config_request_puts_config_path_and_forwards_bearer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind oneshot listener");
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Read until we have the full request (header block + JSON body). One
            // small localhost request usually arrives at once, but loop with a
            // short timeout so a split header/body still assembles.
            let mut raw = Vec::new();
            let mut buf = [0u8; 2048];
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    sock.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        raw.extend_from_slice(&buf[..n]);
                        // Stop once the body token has arrived.
                        if String::from_utf8_lossy(&raw).contains("\"firewall\"") {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await;
            String::from_utf8_lossy(&raw).into_owned()
        });

        let client = reqwest::Client::new();
        let base = format!("http://{addr}");
        let patch = serde_json::json!({ "firewall": { "enabled": true } });
        let resp = gateway_config_request(&client, &base, Some("secret-master-key"), &patch)
            .send()
            .await
            .expect("request sent to oneshot listener");
        assert!(resp.status().is_success());

        let raw = server.await.unwrap();
        let lower = raw.to_ascii_lowercase();
        assert!(
            lower.contains("put /v1/config"),
            "must target PUT /v1/config, got:\n{raw}"
        );
        assert!(
            lower.contains("authorization: bearer secret-master-key"),
            "must forward the master-key bearer, got:\n{raw}"
        );
        assert!(
            raw.contains("\"firewall\""),
            "must carry the config patch body, got:\n{raw}"
        );
    }

    /// The live-config READ (the read-modify-write source for a firewall toggle)
    /// must GET `/v1/config` and forward the gateway bearer, so a remote gateway's
    /// live firewall section is actually readable (else the toggle fail-closed
    /// no-ops remotely). Mirror of the PUT test, driven off a oneshot listener.
    #[tokio::test]
    async fn config_get_request_targets_config_path_and_forwards_bearer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind oneshot listener");
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 2048];
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    sock.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        raw.extend_from_slice(&buf[..n]);
                        // A GET has no body; stop as soon as the header block ends.
                        if String::from_utf8_lossy(&raw).contains("\r\n\r\n") {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let body = b"{\"firewall\":{\"enabled\":true,\"policy\":\"block\"}}";
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body).await;
            String::from_utf8_lossy(&raw).into_owned()
        });

        let client = reqwest::Client::new();
        let base = format!("http://{addr}");
        let resp = gateway_config_get_request(&client, &base, Some("secret-master-key"))
            .send()
            .await
            .expect("request sent to oneshot listener");
        assert!(resp.status().is_success());
        let cfg: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(cfg["firewall"]["policy"], serde_json::json!("block"));

        let raw = server.await.unwrap();
        let lower = raw.to_ascii_lowercase();
        assert!(
            lower.contains("get /v1/config"),
            "must target GET /v1/config, got:\n{raw}"
        );
        assert!(
            lower.contains("authorization: bearer secret-master-key"),
            "must forward the master-key bearer, got:\n{raw}"
        );
    }
}
