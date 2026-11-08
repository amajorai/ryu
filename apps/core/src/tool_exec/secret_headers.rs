//! Secret header resolution, Core URL rewriting, agent-lane signing, and the
//! `run_http_tool` entry points.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

/// Resolve a single whitespace-delimited `word` against the secret grammar.
/// A `word` that does not carry a known prefix is [`SecretToken::Literal`] —
/// surrounding scheme text (e.g. `Bearer`) passes through untouched.
///   - `env:VARNAME`    → process env, else the encrypted plugin secret store
///     (the BYOK seam — see [`resolve_env_secret_from`]), gated by
///     [`may_read_env_secret`]; empty/unset/ungated → absent.
///   - `vault:<domain>` → the governed `identity::read_credential` (grant
///     `identity.read` + audit) for the connection bound to `<domain>` among the
///     agent's `profile_ids`.
///   - `secret:NAME`     → the encrypted user-managed vault, resolved against
///     the server-derived node/user/team/org context for this MCP call.
pub(super) async fn resolve_secret_token(
    word: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
    secret_context: Option<&crate::plugin_secrets::SecretResolutionContext>,
) -> SecretToken {
    if let Some(var) = word.strip_prefix("env:") {
        return resolve_env_secret_from(plugin_id, var, crate::plugin_secrets::global()).await;
    }
    if let Some(domain) = word.strip_prefix("vault:") {
        let domain = domain.trim().to_ascii_lowercase();
        let Some(store) = crate::identity::global() else {
            return SecretToken::Absent;
        };
        // Find the connection bound for this domain across the agent's profiles.
        for profile_id in profile_ids {
            if let Ok(Some(conn)) = store.find(profile_id, &domain).await {
                // A SECOND governed read/audit for this credential (the consult
                // already read+dropped it): this one actually injects it.
                match crate::identity::read_credential(
                    store,
                    &conn.id,
                    session_id.map(str::to_owned),
                )
                .await
                {
                    Ok(Some(state)) => return SecretToken::Value(state.expose().to_owned()),
                    // Bound but no sealed state, or a denied read → omit the header
                    // (the tool then surfaces its own auth error).
                    Ok(None) | Err(_) => return SecretToken::Absent,
                }
            }
        }
        return SecretToken::Absent;
    }
    if let Some(name) = word.strip_prefix("secret:") {
        let (Some(store), Some(context)) = (crate::plugin_secrets::global(), secret_context) else {
            return SecretToken::Absent;
        };
        match store.resolve_vault_secret(name, context).await {
            Ok(Some(value)) if !value.is_empty() => SecretToken::Value(value),
            Ok(_) => SecretToken::Absent,
            Err(error) => {
                tracing::warn!("reading user-managed vault secret failed: {error:#}");
                SecretToken::Absent
            }
        }
    } else {
        SecretToken::Literal
    }
}

/// Resolve a `secret_headers` value TEMPLATE to its concrete header value, or
/// `Ok(None)` when any token resolves to "absent" (missing env var / no bound
/// vault connection) so the header is simply omitted — which, with `fail_open` +
/// a downstream 401, reproduces the exa missing-key path.
///
/// The value is a template: every whitespace-delimited `env:VARNAME` /
/// `vault:<domain>` TOKEN is substituted with its server-side-resolved secret,
/// while surrounding literal text is preserved verbatim. So a value like
/// `"Bearer env:RYU_EXA_API_KEY"` yields `"Bearer <resolved>"` (the scheme
/// prefix the wire wants), and the degenerate whole-value `"env:RYU_EXA_API_KEY"`
/// still resolves to the bare secret (back-compat). Grammar mirrors
/// `run_command_tool`'s `env:` seam plus a governed `vault:<domain>` read:
///   - `env:VARNAME`    → process env, else the encrypted plugin secret store
///     (the BYOK seam), scoped to what `plugin_id` may read (see
///     [`may_read_env_secret`] and [`resolve_env_secret_from`]).
///   - `vault:<domain>` → the governed `identity::read_credential` (grant
///     `identity.read` + audit) for the connection bound to `<domain>` among the
///     agent's `profile_ids`.
///   - `secret:NAME`     → the encrypted user-managed vault, resolved against
///     the server-derived user/node/team/org context.
///
/// A value carrying NO token at all is an `Err` (never a silent skip — mirrors
/// the command `env:` unsupported-source rejection). Resolved values are spliced
/// only into `resolved_secret_headers` (never the args map), so they stay out of
/// the model-visible schema and the firewall/DLP scan.
pub(super) async fn resolve_secret_header_source(
    header_name: &str,
    source: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    resolve_secret_header_source_with_context(
        header_name,
        source,
        plugin_id,
        profile_ids,
        session_id,
        None,
    )
    .await
}

pub(super) async fn resolve_secret_header_source_with_context(
    header_name: &str,
    source: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
    secret_context: Option<&crate::plugin_secrets::SecretResolutionContext>,
) -> Result<Option<String>, String> {
    let mut out = String::with_capacity(source.len());
    let mut saw_token = false;
    let mut cursor = 0usize;
    while cursor < source.len() {
        let rest = &source[cursor..];
        // Emit any leading whitespace run verbatim (preserves literal layout).
        let ws_len = rest
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(rest.len());
        if ws_len > 0 {
            out.push_str(&rest[..ws_len]);
            cursor += ws_len;
            continue;
        }
        // A maximal non-whitespace word — a candidate token.
        let word_len = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..word_len];
        cursor += word_len;
        match resolve_secret_token(word, plugin_id, profile_ids, session_id, secret_context).await {
            SecretToken::Literal => out.push_str(word),
            SecretToken::Value(v) => {
                saw_token = true;
                out.push_str(&v);
            }
            // Any token resolving to absent omits the ENTIRE header.
            SecretToken::Absent => return Ok(None),
        }
    }
    if !saw_token {
        return Err(format!(
            "http tool: unsupported secret source '{source}' for header '{header_name}' (expected an 'env:VARNAME', 'vault:<domain>', or 'secret:NAME' token)"
        ));
    }
    Ok(Some(out))
}

/// The URL scheme a manifest uses to reach **this node's own Core** over loopback.
///
/// `core:/api/ext/@ryu/browser/tabs` — note the single slash; everything after
/// `core:` is the path, and the origin is filled in at call time.
pub const CORE_URL_SCHEME: &str = "core:";

/// Core's loopback origin for the ACTIVE profile.
///
/// Only the PORT is taken from `RYU_BIND`, never the host: a node bound to
/// `0.0.0.0:7980` is listening everywhere, but the address to DIAL from inside the
/// same process is still loopback, and `http://0.0.0.0/...` is not a route.
pub(super) fn core_loopback_origin() -> String {
    let bind = std::env::var("RYU_BIND").ok();
    format!("http://127.0.0.1:{}", core_port_from_bind(bind.as_deref()))
}

/// Core's port for this profile, given the raw `RYU_BIND` value. Pure, so the
/// precedence is testable without mutating process env in a parallel test binary.
///
/// `RYU_BIND` is seeded per profile by `profile::apply_env_defaults`, so reading it
/// keeps this in step with whatever Core actually bound — including an operator who
/// set it by hand. Falling back through `profile::port` keeps the "one offset
/// source" rule when it is absent.
pub(super) fn core_port_from_bind(bind: Option<&str>) -> u16 {
    bind.and_then(|b| b.rsplit(':').next())
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or_else(|| crate::profile::port(CORE_BASE_PORT))
}

/// [`resolve_core_url`] against an explicit origin. Split out so the scheme
/// expansion is testable independently of the ambient profile.
pub(super) fn resolve_core_url_with(url: &str, origin: &str) -> String {
    match url.strip_prefix(CORE_URL_SCHEME) {
        Some(path) => format!("{origin}/{}", path.trim_start_matches('/')),
        None => url.to_owned(),
    }
}

/// Core's base (release-profile) bind port. Every other profile is this plus the
/// profile offset, resolved through `profile::port` — never hardcoded shifted.
pub(super) const CORE_BASE_PORT: u16 = 7980;

/// Expand a `core:`-scheme url into a concrete loopback URL for this profile.
/// Any other url is returned untouched.
///
/// # Why this scheme exists
///
/// A manifest that wants to reach Core's own HTTP surface (the ext-proxy, the memory
/// CRUD) used to hardcode `http://127.0.0.1:7980`. That is wrong on every profile but
/// `release`: `bun dev` runs the `dev` profile, where Core binds 8980, so the tool
/// either reached nothing or — far worse — reached a *release-profile* Core that
/// happened to be running, crossing two profiles' data. `profile.rs` states the rule
/// this restores: there is exactly ONE offset source, and nothing hardcodes a shifted
/// port.
///
/// The egress domain is unchanged (`127.0.0.1`), so a manifest's existing
/// `tool:http-egress:127.0.0.1` grant still gates it.
pub fn resolve_core_url(url: &str) -> String {
    if !url.starts_with(CORE_URL_SCHEME) {
        return url.to_owned();
    }
    resolve_core_url_with(url, &core_loopback_origin())
}

pub(super) fn node_token_target_is_local_core(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let is_loopback = host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    is_loopback
        && parsed.port_or_known_default()
            == Some(core_port_from_bind(
                std::env::var("RYU_BIND").ok().as_deref(),
            ))
}

pub(super) fn secret_headers_use_only_node_token(
    secret_headers: &std::collections::BTreeMap<String, String>,
) -> bool {
    !secret_headers.is_empty()
        && secret_headers.values().all(|source| {
            let mut found_node_token = false;
            for word in source.split_whitespace() {
                if word.starts_with("env:") || word.starts_with("vault:") {
                    if word != "env:RYU_TOKEN" {
                        return false;
                    }
                    found_node_token = true;
                }
            }
            found_node_token
        })
}

/// Whether `url` is the local Core ext-proxy, where a calling agent is stamped.
pub(super) fn targets_local_ext_proxy(url: &str) -> bool {
    node_token_target_is_local_core(url)
        && reqwest::Url::parse(url)
            .ok()
            .is_some_and(|url| url.path().starts_with("/api/ext/"))
}

/// Name `agent_id` on a built request with a proof over its final method, path
/// and query, replacing any agent headers a tool's own header params set.
/// Without an agent (or a node token) both headers are removed, so a tool can
/// never name an agent itself; the proxy refuses an unproven one anyway.
pub(crate) fn sign_agent_lane_request(request: &mut reqwest::Request, agent_id: Option<&str>) {
    let headers = request.headers_mut();
    headers.remove(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID);
    headers.remove(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF);
    let Some(agent_id) = agent_id else {
        return;
    };
    let url = request.url();
    let mut path_and_query = url.path().to_owned();
    if let Some(query) = url.query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    let method = request.method().as_str().to_owned();
    let Some(proof) =
        crate::sidecar::ext_proxy::sign_agent_lane(agent_id, &method, &path_and_query)
    else {
        return;
    };
    if let (Ok(agent), Ok(proof)) = (
        reqwest::header::HeaderValue::from_str(agent_id),
        reqwest::header::HeaderValue::from_str(&proof),
    ) {
        let headers = request.headers_mut();
        headers.insert(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID, agent);
        headers.insert(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF, proof);
    }
}

pub(super) fn guarded_http_client(
    pin: Option<&(String, Vec<std::net::SocketAddr>)>,
) -> Result<reqwest::Client, String> {
    // A proxy resolves the target itself, bypassing the addresses already screened
    // by the SSRF guard. This dispatcher must connect to the validated first hop.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none());
    if let Some((host, addresses)) = pin {
        builder = builder.resolve_to_addrs(host, addresses);
    }
    builder
        .build()
        .map_err(|error| format!("http tool: client build failed: {error}"))
}

/// Proxy a plugin `http` tool call to `url`, Gateway-governed and egress-grant-gated.
///
/// Order matters. The **egress-grant check runs first** (deterministic — no
/// network, no gateway), so an ungranted domain is refused identically whether or
/// not the gateway is reachable. Then the SAME governance the PTC path uses gates
/// the call: a fail-closed budget check and the opt-in firewall/DLP scan, with a
/// post-call audit. Only then does Core make the outbound request.
///
/// `grants` is the owning plugin's grant set — for a Community-tier plugin the
/// RECORD's Gateway-approved grants, resolved by the dispatcher (see
/// `McpRegistry::resolve_app_tool_backend` / `effective_tool_grants`), not the
/// manifest's self-declaration. It must contain `tool:http-egress:<domain>` (or the
/// `*` wildcard). This tool reaches an EXTERNAL service — it never reads local user
/// data — so it needs no ACL principal. `agent_id` is the owning **plugin id** at
/// this seam; it names the audit principal AND scopes which process env vars the
/// `secret_headers` `env:` tokens may read.
#[allow(clippy::too_many_arguments)]
pub async fn run_http_tool(
    url: &str,
    method: &str,
    args: Value,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &std::collections::HashSet<String>,
    profile_ids: &[String],
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    run_http_tool_with_agent(
        url,
        method,
        args,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        grants,
        profile_ids,
        agent_id,
        session_id,
        None,
    )
    .await
}

/// Variant of [`run_http_tool`] that receives the actual calling agent id in
/// addition to the owning plugin id used for grants and secret resolution.
#[allow(clippy::too_many_arguments)]
pub async fn run_http_tool_with_agent(
    url: &str,
    method: &str,
    args: Value,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &std::collections::HashSet<String>,
    profile_ids: &[String],
    agent_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
) -> Result<Value, String> {
    run_http_tool_with_secret_context(
        url,
        method,
        args,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        grants,
        profile_ids,
        agent_id,
        session_id,
        audit_agent_id,
        None,
    )
    .await
}
