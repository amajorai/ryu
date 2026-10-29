// ── Provider prompt caching (forwarded to the gateway) ─────────────────────────

/// Preference key for the node's provider prompt-cache mode: `off` | `auto` |
/// `explicit`. Unset ⇒ nothing is forwarded and the gateway's `[prompt_cache]`
/// config decides. Mirrored in `apps/desktop/src/lib/api/preferences.ts`.
pub const PROMPT_CACHE_PREF: &str = "gateway.prompt-cache";

/// Preference key for the prompt-cache TTL (e.g. `1h`). Unset ⇒ provider default.
pub const PROMPT_CACHE_TTL_PREF: &str = "gateway.prompt-cache-ttl";

pub(crate) fn is_prompt_cache_mode(v: &str) -> bool {
    matches!(v, "off" | "auto" | "explicit")
}

/// Accepts the TTL spellings the providers document. Deliberately a closed set:
/// an arbitrary string forwarded here would be rejected upstream mid-turn, and a
/// caching hint is not worth failing a chat over.
pub(crate) fn is_prompt_cache_ttl(v: &str) -> bool {
    matches!(v, "5m" | "1h")
}

/// Read a validated prompt-cache preference, or `None` when unset, invalid, or
/// no `ServerState` was published (tests / headless).
///
/// Uses the same published-`ServerState` handle the local-engine sync in this
/// module already relies on, so no new plumbing is threaded through the six
/// stream-dispatch signatures between here and the HTTP handler.
pub(crate) async fn prompt_cache_pref(key: &str, valid: fn(&str) -> bool) -> Option<String> {
    let state = crate::learning::global_state()?;
    let raw = state.preferences.get(key).await.ok().flatten()?;
    let v = raw.trim().to_ascii_lowercase();
    valid(&v).then_some(v)
}

// ── OpenAI-compat streaming ────────────────────────────────────────────────────

/// Shown when a limited agent's turn would reach a provider key without Gateway.
pub(crate) const DIRECT_PROVIDER_REFUSAL: &str = "This agent's model provider access is limited, so it can only reach your model providers through the Gateway, which is not available for this turn.";

/// The `x-ryu-agent-provider-access` value for an agent, from the process-wide
/// agent store. `None` when the agent is unrestricted (or Core has no store
/// yet, so no record could limit it); a store error fails closed to `none`.
pub(crate) async fn agent_provider_access_header(agent_id: &str) -> Option<String> {
    let store = crate::agents::global()?;
    crate::agent_access::provider_access_for_agent(store, agent_id)
        .await
        .map(|ids| crate::agent_access::provider_access_header_value(&ids))
}

/// What one inference hop carries for an agent's provider access: the header
/// value on the Gateway hop, nothing on an unrestricted or keyless direct hop,
/// and a refusal for a limited agent's direct hop with a provider key.
pub(crate) fn provider_access_for_hop(
    to_gateway: bool,
    provider_access: Option<String>,
    api_key: Option<&str>,
) -> Result<Option<String>, String> {
    if to_gateway {
        return Ok(provider_access);
    }
    let limited = provider_access.is_some().then_some(&[] as &[String]);
    if crate::agent_access::direct_provider_permitted(limited, api_key) {
        Ok(None)
    } else {
        Err(DIRECT_PROVIDER_REFUSAL.to_owned())
    }
}

/// How long Core waits for a TCP/TLS connection to an OpenAI-compat endpoint
/// before treating the hop as unreachable (and trying the next fallback).
const STREAM_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Longest silence tolerated on a chat stream from the Gateway or a provider Core
/// calls directly, including the wait for the response headers. Matches the
/// Gateway's own upstream read timeout, so a Core→provider stream that wedges
/// fails at the same point a Gateway-proxied one would. It bounds the gap between
/// reads, not the whole reply: a long answer that keeps producing tokens is never
/// cut off.
const STREAM_IDLE_READ_TIMEOUT: std::time::Duration = ryu_gw_providers::STREAM_READ_TIMEOUT;

/// Longest silence tolerated on a chat stream from a local engine or an SDK app.
/// Neither has the Gateway's bound: a local engine sends nothing while it
/// prefills a long prompt, which takes minutes on a CPU, and an SDK app's outer
/// stream stays quiet while its own model and tool calls run (each of which may
/// itself wait the full Gateway limit). These routes have no fallback chain, so
/// this only catches a wedged process, never a slow one.
pub(crate) const LOCAL_STREAM_IDLE_READ_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30 * 60);

/// Which kind of endpoint a chat stream reads from, which decides how long it
/// may stay silent before the turn fails as stalled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamHop {
    /// The Gateway, or a provider endpoint Core calls directly (including the
    /// raw-provider fallback leg).
    Provider,
    /// A local engine or an SDK app's loopback endpoint.
    Local,
}

impl StreamHop {
    pub(crate) const fn idle_read_timeout(self) -> std::time::Duration {
        match self {
            Self::Provider => STREAM_IDLE_READ_TIMEOUT,
            Self::Local => LOCAL_STREAM_IDLE_READ_TIMEOUT,
        }
    }

    /// The shared streaming client for this hop kind, built once per kind.
    pub(crate) fn http_client(self) -> &'static reqwest::Client {
        static PROVIDER: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        static LOCAL: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        let cell = match self {
            Self::Provider => &PROVIDER,
            Self::Local => &LOCAL,
        };
        cell.get_or_init(|| {
            build_stream_http_client(STREAM_CONNECT_TIMEOUT, self.idle_read_timeout())
        })
    }
}

/// The HTTP client for the streaming chat-completions hop, with explicit connect
/// and idle-read timeouts. Without them a provider that accepts the request and
/// then goes silent holds the turn open forever and failover never runs. Split
/// out so tests can build one with short durations.
pub(crate) fn build_stream_http_client(
    connect_timeout: std::time::Duration,
    read_timeout: std::time::Duration,
) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .build()
        // The builder only fails on TLS backend initialisation; fall back to the
        // default client rather than taking chat down over a timeout setting.
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Describe a transport error from the streaming chat hop. A timeout reads as a
/// stalled stream with the limit that tripped, rather than reqwest's terse
/// "operation timed out", so the user and the failover log see what happened.
pub(crate) fn describe_stream_error(
    error: &reqwest::Error,
    read_timeout: std::time::Duration,
) -> String {
    if error.is_timeout() {
        if error.is_connect() {
            return format!("Model connection timed out: {error}");
        }
        return format!(
            "Model stream stalled: no data for {}s ({error})",
            read_timeout.as_secs()
        );
    }
    error.to_string()
}
