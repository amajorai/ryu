//! Plugin tunnel adapters — the `network.tunnel` capability.
//!
//! The built-in tunnel backends (Tailcat, Tailscale/Headscale, Cloudflared,
//! OpenTunnel) are Core code. Everything else is a plugin: any app may provide
//! `network.tunnel` from one of its sidecars, and selecting **Plugin tunnel** in
//! the node's VPN layer points Core's port at whichever provider the capability
//! binding resolves (user override > sole provider > declared default > lowest
//! id — the same ladder as every other swappable layer).
//!
//! The provider declares the route in its manifest:
//!
//! ```json
//! "provides": [{
//!   "capability": "network.tunnel", "version": "1.0.0", "title": "Tunnel",
//!   "layerKind": "tunnel", "selectable": true,
//!   "sidecar": "tunnel", "route": "/tunnel"
//! }]
//! ```
//!
//! and serves three methods on that one route, authenticated with the plugin's
//! minted ext token like every other provider hop:
//!
//! | Method   | Body                                   | Meaning                        |
//! |----------|----------------------------------------|--------------------------------|
//! | `POST`   | `{"port": 7980, "target": "http://…"}` | Ensure Core's port is exposed  |
//! | `GET`    | —                                      | Report the current state       |
//! | `DELETE` | —                                      | Tear the tunnel down           |
//!
//! `POST` and `GET` answer `{"state": "starting" | "running" | "stopped" |
//! "error", "url": string | null, "error": string | null}`. Core publishes `url`
//! only when the state is `running` and the value is an absolute `http(s)` URL
//! without credentials.
//!
//! A tunnel adapter re-originates remote traffic towards Core, so while one is
//! selected and started [`forwarding_active`] makes Core stop trusting loopback
//! peers as local. The node token still gates every protected route.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use crate::server::ServerState;
use crate::sidecar::ext_proxy::{ext_token, node_token, resolve_provider_route, ProviderRoute};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

pub const SIDECAR_NAME: &str = "tunnel-plugin";

/// The capability a tunnel adapter provides.
pub const CAP_NETWORK_TUNNEL: &str = "network.tunnel";

/// Whole-hop budget for a lifecycle call: waking a lazy provider (up to a
/// minute) plus the request itself.
const LIFECYCLE_BUDGET: Duration = Duration::from_secs(90);
/// Whole-hop budget for a status read, wake included, so a stopped or unhealthy
/// provider can never stall `GET /api/mesh/status`.
const STATUS_BUDGET: Duration = Duration::from_secs(5);
const MAX_URL_LEN: usize = 2048;
/// The contract answers three short fields; anything larger is refused unread.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

static FORWARDING: AtomicBool = AtomicBool::new(false);

/// What Core last asked a provider to expose, and where Core listens.
#[derive(Debug, Clone)]
struct Started {
    route: ProviderRoute,
    port: u16,
    target: String,
}

/// The provider Core last asked to expose its port. Stopping targets this one,
/// not whatever the binding resolves to now, so switching providers can never
/// leave the previous provider's tunnel running.
static STARTED: std::sync::Mutex<Option<Started>> = std::sync::Mutex::new(None);
/// Providers whose teardown Core could not confirm. Loopback stays distrusted
/// until each one confirms its `DELETE` or its sidecar is no longer running.
static UNCONFIRMED_STOPS: std::sync::Mutex<Vec<ProviderRoute>> = std::sync::Mutex::new(Vec::new());
/// Serializes start, stop, and rebind so they never interleave.
static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Set while a binding change is re-pointing the tunnel.
static REBINDING: AtomicBool = AtomicBool::new(false);

/// A pending retry of a start the provider could not accept yet.
static RETRY: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>> = std::sync::Mutex::new(None);
/// At boot Core starts the tunnel alongside every other sidecar, which can be
/// before the provider app's own sidecar is listening. Retry for two minutes.
const RETRY_ATTEMPTS: u32 = 24;
const RETRY_INTERVAL: Duration = Duration::from_secs(5);

fn cancel_retry() {
    if let Some(handle) = RETRY.lock().ok().and_then(|mut guard| guard.take()) {
        handle.abort();
    }
}

async fn plugin_backend_selected() -> bool {
    ryu_mesh::is_enabled()
        && crate::sidecar::tailscale::mesh_backend().await.0
            == crate::sidecar::tailscale::MeshBackend::Plugin
}

/// Keep asking the provider to start while the plugin tunnel stays selected.
fn spawn_retry(port: u16, target: String) {
    cancel_retry();
    let handle = tokio::spawn(async move {
        for _ in 0..RETRY_ATTEMPTS {
            tokio::time::sleep(RETRY_INTERVAL).await;
            if !plugin_backend_selected().await {
                return;
            }
            match start_tunnel(port, &target).await {
                Ok(()) => return,
                Err(error) => tracing::debug!("plugin tunnel: start retry failed: {error:#}"),
            }
        }
        tracing::warn!("plugin tunnel: the provider never accepted Core's port");
    });
    if let Ok(mut guard) = RETRY.lock() {
        *guard = Some(handle);
    }
}

fn take_started() -> Option<Started> {
    STARTED.lock().ok().and_then(|mut guard| guard.take())
}

fn current_started() -> Option<Started> {
    STARTED.lock().ok().and_then(|guard| guard.clone())
}

fn remember_unconfirmed(route: ProviderRoute) {
    if let Ok(mut pending) = UNCONFIRMED_STOPS.lock() {
        if !pending.iter().any(|r| r.provider_id == route.provider_id) {
            pending.push(route);
        }
    }
}

fn take_unconfirmed() -> Vec<ProviderRoute> {
    UNCONFIRMED_STOPS
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

fn has_unconfirmed() -> bool {
    UNCONFIRMED_STOPS
        .lock()
        .map(|pending| !pending.is_empty())
        .unwrap_or(true)
}

/// Whether a plugin tunnel may currently be forwarding public traffic to Core.
pub(crate) fn forwarding_active() -> bool {
    FORWARDING.load(Ordering::Acquire)
}

/// The bound tunnel provider: its resolved route and display name.
struct BoundTunnel {
    route: ProviderRoute,
    name: String,
}

async fn bound_provider(state: &ServerState) -> Result<BoundTunnel> {
    let records = state
        .app_store
        .list()
        .await
        .context("reading installed apps")?;
    let enabled: HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();
    let candidates: Vec<crate::plugin_manifest::PluginManifest> = state
        .app_manifests
        .read()
        .await
        .iter()
        .filter(|m| enabled.contains(&m.id))
        .cloned()
        .collect();

    let cfg = crate::plugins::binding::active_config();
    let registry = crate::plugins::binding::BindingRegistry::new(&cfg, &candidates);
    let req = crate::plugin_manifest::CapabilityReq {
        capability: CAP_NETWORK_TUNNEL.to_owned(),
        min_version: None,
    };
    let binding = registry.resolve(&req).map_err(|_| {
        anyhow!("no enabled plugin provides a tunnel; install one from the Store or pick a built-in tunnel")
    })?;
    let provider = candidates
        .iter()
        .find(|m| m.id == binding.provider_id)
        .ok_or_else(|| anyhow!("the bound tunnel provider is not loaded"))?;
    let entry = provider
        .provided_capabilities()
        .iter()
        .find(|e| e.capability == CAP_NETWORK_TUNNEL)
        .ok_or_else(|| anyhow!("the bound tunnel provider does not declare network.tunnel"))?
        .clone();
    let route = resolve_provider_route(provider, &entry, &binding.provider_id).map_err(|_| {
        anyhow!(
            "the tunnel provider '{}' declares no sidecar route",
            provider.id
        )
    })?;
    Ok(BoundTunnel {
        route,
        name: provider.name.clone(),
    })
}

/// One authenticated hop to the provider's tunnel route. `budget` bounds the
/// whole hop, waking the provider included.
async fn call(
    state: &ServerState,
    route: &ProviderRoute,
    method: reqwest::Method,
    body: Option<Value>,
    budget: Duration,
) -> Result<Value> {
    let deadline = Instant::now() + budget;
    if let Some(wake) = route.wake_name.as_ref() {
        state
            .manager
            .wake_and_await_healthy(wake, budget)
            .await
            .with_context(|| format!("waking tunnel provider '{wake}'"))?;
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        bail!(
            "tunnel provider did not answer within {}s",
            budget.as_secs()
        );
    }
    let _activity = route
        .wake_name
        .as_ref()
        .map(|wake| state.manager.enter_request(wake));
    send(state, route, method, body, remaining).await
}

/// The request itself, against a provider already known to be up.
async fn send(
    state: &ServerState,
    route: &ProviderRoute,
    method: reqwest::Method,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value> {
    let target = state
        .manager
        .forward_target(&route.sidecar_name)
        .map_err(|denied| anyhow!("tunnel provider is unavailable: {}", denied.reason()))?;
    let url = format!("http://127.0.0.1:{}{}", target.port(), route.upstream_path);
    let token = ext_token(node_token().as_deref(), &route.provider_id);
    let mut request = reqwest::Client::new()
        .request(method, &url)
        .timeout(timeout)
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .context("tunnel provider is unreachable")?;
    let status = response.status();
    let bytes = crate::sidecar::read_body_capped(response, MAX_RESPONSE_BYTES)
        .await
        .context("reading the tunnel provider's answer")?;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("no detail");
        bail!("tunnel provider answered {status}: {detail}");
    }
    Ok(value)
}

/// The provider's reported state, normalized and validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TunnelReport {
    pub(crate) state: &'static str,
    pub(crate) url: Option<String>,
    pub(crate) error: Option<String>,
}

/// Accept only an absolute `http(s)` URL with a host and no userinfo, so a
/// provider can never publish a `javascript:` link or smuggle credentials.
fn sanitize_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_LEN {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    let scheme_ok = matches!(parsed.scheme(), "https" | "http");
    let has_host = parsed.host_str().is_some_and(|host| !host.is_empty());
    let no_userinfo = parsed.username().is_empty() && parsed.password().is_none();
    (scheme_ok && has_host && no_userinfo).then(|| raw.to_owned())
}

pub(crate) fn normalize_report(value: &Value) -> TunnelReport {
    let state = match value
        .get("state")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("running") => "running",
        Some("starting") => "starting",
        Some("error") => "error",
        _ => "stopped",
    };
    let url = (state == "running")
        .then(|| {
            value
                .get("url")
                .and_then(Value::as_str)
                .and_then(sanitize_url)
        })
        .flatten();
    let error = value
        .get("error")
        .and_then(Value::as_str)
        .map(|e| e.chars().take(500).collect::<String>())
        .filter(|e| !e.is_empty());
    // "running" without a publishable URL is not reachable from anywhere.
    let state = if state == "running" && url.is_none() {
        "error"
    } else {
        state
    };
    let error = if state == "error" && error.is_none() {
        Some("the tunnel provider reported no usable public URL".to_owned())
    } else {
        error
    };
    TunnelReport { state, url, error }
}

fn backend_state(report_state: &str) -> &'static str {
    match report_state {
        "running" => "Running",
        "starting" => "Starting",
        "error" => "Failed",
        _ => "Stopped",
    }
}

/// The provider snapshot `CoreMeshHost::status_json` hands to `ryu_mesh`.
pub(crate) async fn status_json() -> Value {
    let Some(state) = crate::learning::global_state() else {
        return json!({ "Backend": "plugin", "BackendState": "Stopped" });
    };
    let bound = match bound_provider(&state).await {
        Ok(bound) => bound,
        Err(error) => {
            return json!({
                "Backend": "plugin",
                "BackendState": "Failed",
                "Error": error.to_string(),
            })
        }
    };
    // The binding moved (a pin, or the old provider was disabled) while a tunnel
    // was up: re-point it so the reported provider is the one actually serving.
    if current_started().is_some_and(|started| started.route.provider_id != bound.route.provider_id)
    {
        tokio::spawn(reconcile_binding());
    }
    let report = match call(
        &state,
        &bound.route,
        reqwest::Method::GET,
        None,
        STATUS_BUDGET,
    )
    .await
    {
        Ok(value) => normalize_report(&value),
        Err(error) => TunnelReport {
            state: "error",
            url: None,
            error: Some(format!("{error:#}")),
        },
    };
    json!({
        "Backend": "plugin",
        "BackendState": backend_state(report.state),
        "Self": {
            "PublicUrl": report.url,
            "TunnelProvider": bound.route.provider_id,
            "TunnelProviderName": bound.name,
        },
        "Error": report.error,
    })
}

/// Only `starting` and `running` mean the provider took Core's port.
fn start_accepted(report: &TunnelReport) -> bool {
    matches!(report.state, "starting" | "running")
}

async fn start_tunnel(port: u16, target: &str) -> Result<()> {
    let state = crate::learning::global_state()
        .ok_or_else(|| anyhow!("Core is still starting; retry the plugin tunnel shortly"))?;
    let bound = bound_provider(&state).await?;
    let _lifecycle = LIFECYCLE.lock().await;
    if let Some(previous) = take_started() {
        if previous.route.provider_id != bound.route.provider_id
            && !stop_route(&state, &previous.route).await
        {
            remember_unconfirmed(previous.route);
        }
    }
    // Fail closed: loopback stops being trusted before the provider can forward.
    FORWARDING.store(true, Ordering::Release);
    if let Ok(mut guard) = STARTED.lock() {
        *guard = Some(Started {
            route: bound.route.clone(),
            port,
            target: target.to_owned(),
        });
    }
    let body = json!({ "port": port, "target": format!("http://{target}") });
    let value = call(
        &state,
        &bound.route,
        reqwest::Method::POST,
        Some(body),
        LIFECYCLE_BUDGET,
    )
    .await?;
    let report = normalize_report(&value);
    if !start_accepted(&report) {
        let detail = report
            .error
            .unwrap_or_else(|| format!("it reported '{}'", report.state));
        bail!("{} could not start the tunnel: {detail}", bound.name);
    }
    tracing::info!(
        provider = %bound.route.provider_id,
        state = report.state,
        "plugin tunnel: provider accepted Core's port"
    );
    Ok(())
}

/// Ask a provider to tear its tunnel down. `true` only when teardown is
/// confirmed: the provider acknowledged the `DELETE`, or its sidecar is no
/// longer running (so nothing of it can still forward). A stopped provider is
/// not woken just to be told to stop.
async fn stop_route(state: &ServerState, route: &ProviderRoute) -> bool {
    if state.manager.forward_target(&route.sidecar_name).is_err() {
        return true;
    }
    let _activity = route
        .wake_name
        .as_ref()
        .map(|wake| state.manager.enter_request(wake));
    match send(
        state,
        route,
        reqwest::Method::DELETE,
        None,
        LIFECYCLE_BUDGET,
    )
    .await
    {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(
                provider = %route.provider_id,
                "plugin tunnel: stop request failed; loopback stays distrusted: {error:#}"
            );
            false
        }
    }
}

async fn stop_tunnel() {
    cancel_retry();
    let _lifecycle = LIFECYCLE.lock().await;
    let mut routes = take_unconfirmed();
    if let Some(started) = take_started() {
        routes.push(started.route);
    }
    if let Some(state) = crate::learning::global_state() {
        for route in routes {
            if !stop_route(&state, &route).await {
                remember_unconfirmed(route);
            }
        }
    } else {
        for route in routes {
            remember_unconfirmed(route);
        }
    }
    // Loopback trust returns only once every provider confirmed teardown.
    if !has_unconfirmed() {
        FORWARDING.store(false, Ordering::Release);
    }
}

/// Re-point an active plugin tunnel after `network.tunnel` resolves to a
/// different provider: stop the old provider's tunnel and start the new one.
pub(crate) async fn reconcile_binding() {
    let Some(started) = current_started() else {
        return;
    };
    let Some(state) = crate::learning::global_state() else {
        return;
    };
    let Ok(bound) = bound_provider(&state).await else {
        return;
    };
    if bound.route.provider_id == started.route.provider_id || !plugin_backend_selected().await {
        return;
    }
    if REBINDING.swap(true, Ordering::AcqRel) {
        return;
    }
    cancel_retry();
    tracing::info!(
        from = %started.route.provider_id,
        to = %bound.route.provider_id,
        "plugin tunnel: binding changed; moving the tunnel"
    );
    if let Err(error) = start_tunnel(started.port, &started.target).await {
        tracing::warn!("plugin tunnel: the new provider did not start: {error:#}");
        if forwarding_active() {
            spawn_retry(started.port, started.target);
        }
    }
    REBINDING.store(false, Ordering::Release);
}

/// Lifecycle bridge between the VPN layer and the bound tunnel provider.
pub struct PluginTunnelManager {
    port: u16,
    /// Where Core listens (`host:port`), derived from its bind address.
    target: String,
}

impl PluginTunnelManager {
    pub fn new(port: u16, target: String) -> Self {
        Self { port, target }
    }
}

impl Sidecar for PluginTunnelManager {
    fn name(&self) -> &'static str {
        SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<Result<()>> {
        let port = self.port;
        let target = self.target.clone();
        Box::pin(async move {
            if port == 0 {
                bail!("a plugin tunnel needs Core to use a fixed HTTP port");
            }
            if !ryu_mesh::is_enabled() {
                bail!("network disabled: enable the plugin tunnel in the desktop");
            }
            if crate::sidecar::tailscale::mesh_backend().await.0
                != crate::sidecar::tailscale::MeshBackend::Plugin
            {
                bail!("a plugin tunnel is not the selected tunnel backend");
            }
            let result = start_tunnel(port, &target).await;
            // A resolved provider that could not take the request yet (its sidecar
            // is still starting) gets retried; a missing provider does not.
            if result.is_err() && forwarding_active() {
                spawn_retry(port, target);
            }
            result
        })
    }

    fn stop(&self) -> BoxFuture<Result<()>> {
        Box::pin(async {
            stop_tunnel().await;
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        Box::pin(async {
            let status = status_json().await;
            match status["BackendState"].as_str() {
                Some("Running") => HealthStatus::Healthy,
                _ => HealthStatus::Unhealthy(
                    status["Error"]
                        .as_str()
                        .unwrap_or("plugin tunnel is not running")
                        .to_owned(),
                ),
            }
        })
    }

    fn is_running(&self) -> bool {
        forwarding_active()
    }

    fn has_exited(&self) -> bool {
        false
    }

    fn pid(&self) -> Option<u32> {
        None
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<Result<()>> {
        // Nothing of Core's to remove: the provider is an app the Store owns.
        Box::pin(async {
            stop_tunnel().await;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_reports_publish_only_safe_absolute_urls() {
        let ok = normalize_report(&json!({"state": "running", "url": "https://abc.example.net"}));
        assert_eq!(ok.state, "running");
        assert_eq!(ok.url.as_deref(), Some("https://abc.example.net"));

        for bad in [
            "javascript:alert(1)",
            "https://user:pass@abc.example.net",
            "/relative",
            "ftp://abc.example.net",
            "",
        ] {
            let report = normalize_report(&json!({"state": "running", "url": bad}));
            assert_eq!(report.state, "error", "{bad:?} must not be published");
            assert!(report.url.is_none());
            assert!(report.error.is_some());
        }
    }

    #[test]
    fn non_running_states_never_publish_a_url() {
        let starting =
            normalize_report(&json!({"state": "Starting", "url": "https://abc.example.net"}));
        assert_eq!(starting.state, "starting");
        assert!(starting.url.is_none());
        let unknown = normalize_report(&json!({"state": "weird"}));
        assert_eq!(unknown.state, "stopped");
        let failed = normalize_report(&json!({"state": "error", "error": "quota exceeded"}));
        assert_eq!(failed.error.as_deref(), Some("quota exceeded"));
    }

    #[test]
    fn only_starting_or_running_accept_a_start() {
        for (raw, accepted) in [
            ("running", false), // no URL: normalized to error
            ("starting", true),
            ("stopped", false),
            ("error", false),
            ("weird", false),
        ] {
            let report = normalize_report(&json!({"state": raw}));
            assert_eq!(start_accepted(&report), accepted, "{raw}");
        }
        let running = normalize_report(&json!({"state": "running", "url": "https://a.example"}));
        assert!(start_accepted(&running));
    }

    #[test]
    fn report_states_map_onto_mesh_backend_states() {
        assert_eq!(backend_state("running"), "Running");
        assert_eq!(backend_state("starting"), "Starting");
        assert_eq!(backend_state("error"), "Failed");
        assert_eq!(backend_state("stopped"), "Stopped");
    }

    #[test]
    fn manager_uses_the_plugin_tunnel_sidecar_name() {
        let manager = PluginTunnelManager::new(7980, "127.0.0.1:7980".to_owned());
        assert_eq!(manager.name(), SIDECAR_NAME);
        assert!(!manager.is_required());
    }
}
