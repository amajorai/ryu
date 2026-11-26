//! Passthrough upstreams: the default base URLs and their overrides, the
//! forwarded-header policy, and the HTTP client each wire format uses (the
//! provider egress proxy while the Claude route is in effect).

use std::time::Duration;

use serde_json::Value;

use super::WireFormat;

/// Default upstream the Anthropic passthrough forwards to. Overridable via
/// `RYU_PASSTHROUGH_ANTHROPIC_UPSTREAM` (the "nothing hardcoded" knob — point it
/// at a regional endpoint or a test double without a rebuild).
pub(super) const DEFAULT_ANTHROPIC_UPSTREAM: &str = "https://api.anthropic.com";

/// Default upstream the Codex (ChatGPT-login) passthrough forwards to. This is
/// OpenAI's special Codex backend for subscription accounts. Overridable via
/// `RYU_PASSTHROUGH_CODEX_UPSTREAM` (the "nothing hardcoded" knob).
pub(super) const DEFAULT_CODEX_UPSTREAM: &str = "https://chatgpt.com/backend-api/codex";

/// Hop-by-hop / connection headers that must NOT be forwarded verbatim — reqwest
/// recomputes host/length and manages the connection itself. Everything else
/// (notably `authorization`, `anthropic-version`, `anthropic-beta`, `x-api-key`)
/// is forwarded UNCHANGED so the caller's own subscription auth reaches upstream.
pub(super) const STRIPPED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "transfer-encoding",
];

/// Total deadline of a call on an inert route (model listing, batch status).
/// It is the client default; prompt routes lift it per request.
const INERT_TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

/// A dial that takes longer than this is an unreachable upstream.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The builder both passthrough clients start from. Provider credentials and
/// prompt bodies must never follow an upstream redirect. `total` bounds a whole
/// call unless the request lifts it ([`with_route_deadline`]); the read timeout
/// bounds the wait for the response head and between body reads, so a stalled
/// upstream still fails once the total is lifted.
fn client_builder(total: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(ryu_gw_providers::STREAM_READ_TIMEOUT)
        .timeout(total)
}

/// Apply the deadline of the route to one upstream request. A prompt route
/// carries a generation that can run for many minutes (thinking, large file
/// writes), so it gets the provider path's stream total
/// (`ryu_gw_providers::STREAM_TOTAL_TIMEOUT`) instead of the client's 60 s,
/// which cut the response body mid-stream. Inert routes keep the 60 s total.
pub(super) fn with_route_deadline(
    request: reqwest::RequestBuilder,
    prompt_route: bool,
) -> reqwest::RequestBuilder {
    if prompt_route {
        ryu_gw_providers::streaming_request(request)
    } else {
        request
    }
}

pub(super) fn passthrough_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        client_builder(INERT_TOTAL_TIMEOUT)
            .build()
            .expect("failed to build passthrough HTTP client")
    })
}

/// Set by Core on a cloud node: its provider egress proxy, and the state file
/// that says which provider routes currently leave through the owner's desktop.
const PROVIDER_PROXY_ENV: &str = "RYU_PROVIDER_EGRESS_PROXY_URL";
const PROVIDER_STATE_ENV: &str = "RYU_PROVIDER_EGRESS_STATE";

/// The provider proxy as a `reqwest` proxy. Loopback upstreams (test doubles)
/// never go through it.
pub(super) fn provider_proxy(value: Option<String>) -> Option<reqwest::Proxy> {
    let url = value.filter(|value| !value.trim().is_empty())?;
    let proxy = reqwest::Proxy::all(url.trim()).ok()?;
    Some(proxy.no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1")))
}

/// What Core's state file says about the Claude route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ClaudeRoute {
    /// Whether Claude must leave through the owner's desktop.
    pub(super) active: bool,
    /// Core's current provider listener, when the file names one.
    pub(super) proxy: Option<String>,
}

/// Parse the state file. A file that cannot be read or parsed counts as active
/// with no proxy named, so the Gateway falls back to the proxy Core passed at
/// spawn and never leaves directly while a route may apply.
pub(super) fn claude_route(contents: Option<&str>) -> ClaudeRoute {
    let Some(parsed) = contents.and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
        return ClaudeRoute {
            active: true,
            proxy: None,
        };
    };
    let active = parsed
        .get("active")
        .and_then(Value::as_array)
        .is_none_or(|active| active.iter().any(|id| id.as_str() == Some("claude")));
    let proxy = parsed
        .get("proxy")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|proxy| !proxy.is_empty())
        .map(str::to_owned);
    ClaudeRoute { active, proxy }
}

/// Read the state file for this request. It is a few bytes and model requests
/// are long, so reading it every time costs nothing noticeable and a route the
/// owner just turned on applies to the very next request. `None` when Core set
/// no state file: this node does not route providers.
async fn claude_route_now() -> Option<ClaudeRoute> {
    let path = std::env::var_os(PROVIDER_STATE_ENV)?;
    Some(claude_route(
        tokio::fs::read_to_string(path).await.ok().as_deref(),
    ))
}

/// Why an Anthropic passthrough call was refused: the Claude route applies but
/// the Gateway has no working provider proxy.
pub(super) const CLAUDE_ROUTE_UNAVAILABLE: &str = "Claude traffic must leave through the owner's computer, but this node's route for it is not running";

/// Which proxy, if any, carries Anthropic: `Ok(None)` is the direct client,
/// `Err` refuses. The state file's proxy (Core's current listener) wins over
/// the one passed at spawn, which a Core restart may have replaced.
pub(super) fn anthropic_proxy(
    route: Option<ClaudeRoute>,
    spawn_proxy: Option<String>,
) -> Result<Option<String>, &'static str> {
    let Some(route) = route else {
        return Ok(None);
    };
    if !route.active {
        return Ok(None);
    }
    route
        .proxy
        .or(spawn_proxy.filter(|proxy| !proxy.trim().is_empty()))
        .map(Some)
        .ok_or(CLAUDE_ROUTE_UNAVAILABLE)
}

/// The client for one passthrough format: Anthropic uses the node's provider
/// proxy while the Claude route is in effect; everything else, and Anthropic
/// the rest of the time, uses the direct client. `Err` refuses the call: the
/// route applies but cannot carry it, and it must not go out directly.
pub(super) async fn passthrough_client_for(
    format: WireFormat,
) -> Result<reqwest::Client, &'static str> {
    use std::sync::Mutex;
    static ANTHROPIC: Mutex<Option<(String, reqwest::Client)>> = Mutex::new(None);
    if format != WireFormat::Anthropic {
        return Ok(passthrough_http_client().clone());
    }
    let Some(url) = anthropic_proxy(
        claude_route_now().await,
        std::env::var(PROVIDER_PROXY_ENV).ok(),
    )?
    else {
        return Ok(passthrough_http_client().clone());
    };
    let mut cached = ANTHROPIC
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((cached_url, client)) = cached.as_ref() {
        if *cached_url == url {
            return Ok(client.clone());
        }
    }
    let proxy = provider_proxy(Some(url.clone())).ok_or(CLAUDE_ROUTE_UNAVAILABLE)?;
    let client = client_builder(INERT_TOTAL_TIMEOUT)
        .proxy(proxy)
        .build()
        .map_err(|_| CLAUDE_ROUTE_UNAVAILABLE)?;
    *cached = Some((url, client.clone()));
    Ok(client)
}

pub(super) fn anthropic_upstream() -> String {
    std::env::var("RYU_PASSTHROUGH_ANTHROPIC_UPSTREAM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANTHROPIC_UPSTREAM.to_string())
}

pub(super) fn codex_upstream() -> String {
    std::env::var("RYU_PASSTHROUGH_CODEX_UPSTREAM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CODEX_UPSTREAM.to_string())
}

#[cfg(test)]
#[path = "upstream_test.rs"]
mod tests;
