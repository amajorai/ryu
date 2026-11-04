//! The CatalogSource seam and the agent tool-egress SSRF screen: `screen_egress_url_pinned_with_allowlist_mode` through `guarded_post_stream_with_headers`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) async fn screen_egress_url_pinned_with_allowlist_mode(
    url: &str,
    guard_enabled: bool,
    allow_hosts: Option<&str>,
    allow_bare_host: bool,
) -> anyhow::Result<(url::Url, ScreenedEgress)> {
    let trimmed = url.trim();
    // Redacted in the message even here: a URL that fails to PARSE is still a URL
    // the operator pasted a credential into. See [`redact_url_for_display`].
    let parsed = url::Url::parse(trimmed)
        .map_err(|e| anyhow::anyhow!("invalid URL '{}': {e}", redact_url_for_display(trimmed)))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!(
            "URL scheme '{}' is not allowed — only http and https are accepted",
            parsed.scheme()
        );
    }
    if !guard_enabled {
        return Ok((parsed, ScreenedEgress::Exempt));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {}", redact_url_for_display(trimmed)))?
        .to_owned();
    // Resolved BEFORE the allowlist check, because the allowlist is port-scoped:
    // `127.0.0.1:3000` must exempt exactly that port. A bare `127.0.0.1` entry
    // still matches whatever port is passed (the compatibility form).
    let default_port = if parsed.scheme() == "https" { 443 } else { 80 };
    let port = parsed.port_or_known_default().unwrap_or(default_port);
    if host_is_allowlisted_in_with_mode(&host, port, allow_hosts, allow_bare_host) {
        return Ok((parsed, ScreenedEgress::Exempt));
    }
    let resolved = resolve_guarded_host(&host, port).await.map_err(|e| {
        // Name the escape hatch in the message. The single most common remote-MCP
        // development target is `http://127.0.0.1:3000/mcp`, and it is blocked by
        // design (loopback is exactly what SSRF reaches for). A developer who
        // hits this and is told only "private/loopback host is not allowed"
        // concludes the feature is broken; told the variable, they unblock
        // themselves in one line.
        //
        // The message recommends the NARROW `host:port` form, because this same
        // variable also governs model-supplied URLs in `tool_exec` — a bare host
        // entry added to reach one dev server opens every port on that host to
        // whatever URL a model puts in a tool argument. See
        // [`host_is_allowlisted_in`].
        anyhow::anyhow!(
            "blocked egress to {host}:{port}: {e}. If this is an intentional local or \
             internal target, add `{host}:{port}` to {ENV_AGENT_EGRESS_ALLOW_HOSTS} \
             (comma-separated) — that is the supported escape hatch. A bare `{host}` \
             entry also works but grants EVERY port on that host, including to \
             model-supplied tool URLs; prefer the host:port form"
        )
    })?;
    Ok((parsed, ScreenedEgress::Pinned(resolved)))
}

/// SSRF-guarded HTTPS GET, shared by the catalog fetch paths so they all get the
/// same protection as [`install_app_from_url`]: https-only, resolve + screen IPs,
/// pin the client to the validated IPs (no re-resolution, defeating DNS
/// rebinding), and disable redirects (a remote cannot bounce us inward after the
/// check). Returns the response on success.
pub(crate) async fn guarded_get(url: &str) -> anyhow::Result<reqwest::Response> {
    guarded_get_with_bearer(url, None).await
}

// Proxies resolve destinations themselves, so they cannot carry the guarantee
// that this request connects only to the addresses already screened locally.
pub(in crate::server) fn pin_screened_http_client(
    builder: reqwest::ClientBuilder,
    host: &str,
    addresses: &[std::net::SocketAddr],
) -> reqwest::ClientBuilder {
    builder.no_proxy().resolve_to_addrs(host, addresses)
}

/// The resolve → screen → **pin** client builder every first-party guarded fetch
/// shares: parse, require `https`, [`resolve_guarded_host`] (rejects `localhost`
/// and any host resolving to a loopback / RFC1918 / link-local / ULA / CGNAT
/// address), pin the client to exactly those addresses so it never re-resolves
/// (defeating DNS rebinding), and refuse redirects so a remote cannot bounce us
/// inward after the check.
///
/// One copy, four callers. It used to be four byte-identical copies inline in
/// [`guarded_get_with_bearer`], [`guarded_get_with_headers`],
/// [`guarded_fetch_text_with_headers`], and (now) [`guarded_post_json`]; every
/// copy was a place a future edit could drop the pin or the redirect policy in
/// one path only, which is a silent SSRF regression rather than a visible bug.
///
/// The pin is **host-specific**, which is exactly why this returns a freshly
/// built client rather than reusing a shared one: `resolve_to_addrs` binds a
/// client to one hostname's validated IPs, so a process-wide
/// `reqwest::Client` physically cannot carry it.
///
/// Returns the client plus the parsed URL (callers that need the host/path).
/// `https`-only on purpose — this is the first-party catalog/model/skill fetch
/// path. The http-tolerant variant is [`guarded_post_json`], which routes its
/// scheme decision through [`screen_agent_egress_url`] instead.
pub(crate) async fn guarded_client(url: &str) -> Result<(reqwest::Client, url::Url), String> {
    let trimmed = url.trim();
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("invalid URL {trimmed}: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("remote URL must use https: {trimmed}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("URL has no host: {trimmed}"))?
        .to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolved = resolve_guarded_host(&host, port).await?;
    let client = pin_screened_http_client(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none()),
        &host,
        &resolved,
    )
    .build()
    .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    Ok((client, parsed))
}

/// How long a single MCP HTTP round-trip may take. Matches the client's
/// `RPC_TIMEOUT` so the transport is never the thing that gives up first —
/// the driver's own deadline stays the one that reports the failure.
pub(in crate::server) const MCP_HTTP_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(60);

/// SSRF-guarded `POST` of a JSON body, returning `(status, response headers,
/// body text)`. This is the egress seam for Core's **MCP HTTP client transport**.
///
/// # Why this is not `guarded_client`
///
/// Two deliberate differences from the first-party family above:
///
/// 1. **`http` is allowed.** The guarded-`get` family is `https`-only and
///    rejects `localhost` outright, which would block `http://127.0.0.1:3000/mcp`
///    — the single most common remote-MCP development target, and the first thing
///    anyone tries. Rejecting it makes the whole feature look broken.
/// 2. **The screen is [`screen_agent_egress_url`]**, not a bare
///    `resolve_guarded_host`. That is the same pre-installed screen the agent
///    browsing tools use, so `RYU_AGENT_EGRESS_ALLOW_HOSTS` is the ONE documented
///    escape hatch for reaching a loopback or internal MCP endpoint, rather than
///    this path inventing a second, undocumented one.
///
/// This is not a relaxation of the SSRF posture — it is the *same* posture with a
/// documented, opt-in override. The screen still refuses `http://169.254.169.254/`
/// (cloud metadata), RFC1918, link-local, ULA and CGNAT by default.
///
/// # Why not `McpRegistry.http`
///
/// The registry holds a bare `reqwest::Client::new()` with no address pin and
/// default redirect-follow. Reusing it here would silently drop both halves of the
/// guard, and the pin *cannot* be moved onto a shared client because
/// `resolve_to_addrs` is per-hostname. So the client is built per request against
/// the screened host, exactly like [`guarded_client`].
///
/// The body is read streamed and capped at `max_body` so a hostile endpoint cannot
/// OOM Core with a multi-GB "SSE stream". A non-2xx status is **returned, not
/// raised**: the MCP transport needs the status and body to report a useful error
/// (a `401` from a bad `Authorization` header must not read as a network failure).
/// Invalid header names are skipped and **header values are never logged** — they
/// routinely carry the user's API token. For the same reason the URL is never
/// formatted raw into an error: it is passed through [`redact_url_for_display`]
/// first, because a hosted MCP endpoint's credential is as likely to be in the URL
/// (userinfo, `?api_key=`) as in a header, and these errors reach logs and API
/// responses. Callers that build their own message about this endpoint must do the
/// same — see `sidecar::mcp::client`.
pub(crate) async fn guarded_post_json(
    url: &str,
    headers: &[(String, String)],
    body: String,
    max_body: u64,
) -> anyhow::Result<(reqwest::StatusCode, reqwest::header::HeaderMap, String)> {
    let shown = redact_url_for_display(url);
    let mut resp = guarded_post_stream_with_headers(url, headers, body, MCP_HTTP_TIMEOUT).await?;
    let status = resp.status();
    let resp_headers = resp.headers().clone();
    if let Some(len) = resp.content_length() {
        if len > max_body {
            anyhow::bail!("{shown} response too large ({len} bytes; cap {max_body})");
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| anyhow::anyhow!("reading {shown}: {e}"))?
    {
        if buf.len() as u64 + chunk.len() as u64 > max_body {
            anyhow::bail!("{shown} exceeded the {max_body}-byte body cap");
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((
        status,
        resp_headers,
        String::from_utf8_lossy(&buf).into_owned(),
    ))
}

/// Keep an MCP POST response open so server elicitation can be answered while
/// its SSE result stream is still live. Caller owns read deadlines and caps.
pub(crate) async fn guarded_post_stream_with_headers(
    url: &str,
    headers: &[(String, String)],
    body: String,
    timeout: std::time::Duration,
) -> anyhow::Result<reqwest::Response> {
    // Pin to the addresses the screen ACTUALLY VALIDATED, threaded out of the
    // screen rather than obtained from a second lookup. Re-resolving here would
    // pin to addresses nobody checked, and swallowing a failed re-resolve as
    // "must have been exempt" would hand an attacker who controls DNS a fail-open:
    // a public answer passes the screen, a private answer fails the pin, and the
    // unpinned request then connects to whatever DNS serves at connect time.
    // `ScreenedEgress::Exempt` is the ONLY thing that legitimately means "do not
    // pin", and it is reported explicitly, never inferred.
    let (parsed, screened) = screen_egress_url_pinned(
        url,
        agent_egress_guard_enabled(),
        std::env::var(ENV_AGENT_EGRESS_ALLOW_HOSTS).ok().as_deref(),
    )
    .await?;
    // EVERY message out of this function names the endpoint through this, never
    // `url` itself: a remote MCP endpoint's URL routinely carries the operator's
    // credential (userinfo, or Smithery-style `?api_key=`), and these strings reach
    // logs, the model, and API responses. Redacting the `headers` map while
    // printing the URL verbatim would leak the same secret through the other door.
    let shown = redact_url_for_display(url);
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {shown}"))?
        .to_owned();

    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());
    match screened {
        ScreenedEgress::Pinned(addrs) => {
            builder = pin_screened_http_client(builder, &host, &addrs);
        }
        // Guard off, or an operator-allowlisted host (the loopback dev target).
        // There is nothing validated to pin to; the operator opted in by name.
        ScreenedEgress::Exempt => {}
    }
    let client = builder
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build HTTP client: {e}"))?;

    let mut req = client
        .post(parsed.as_str())
        .header("User-Agent", crate::skills_catalog::USER_AGENT)
        .body(body);
    for (name, value) in headers {
        match (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            (Ok(n), Ok(v)) => req = req.header(n, v),
            // Skip a malformed header name; the VALUE is never logged (secret).
            _ => tracing::warn!("guarded POST: skipping invalid header name '{name}'"),
        }
    }

    req.send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {shown}: {e}"))
}
