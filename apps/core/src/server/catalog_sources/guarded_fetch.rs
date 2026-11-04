//! The CatalogSource seam and the agent tool-egress SSRF screen: `guarded_get_stream_with_headers` through `catalog_sources_select`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// SSRF-guarded HTTP GET that keeps the response body open for a streaming
/// consumer. This is the egress seam for the legacy MCP HTTP+SSE transport:
/// the initial GET carries an `endpoint` event and then remains open for the
/// JSON-RPC responses sent after each POST.
///
/// Unlike [`guarded_get_with_headers`], this accepts the same `http` loopback
/// development targets as [`guarded_post_json`] and deliberately has no client
/// lifetime timeout. The MCP client applies a bounded timeout to each awaited
/// JSON-RPC response, while dropping the response closes the stream during
/// connection shutdown. The URL is still screened, pinned, and protected from
/// redirects before any bytes leave Core.
pub(crate) async fn guarded_get_stream_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> anyhow::Result<reqwest::Response> {
    let (parsed, screened) = screen_egress_url_pinned(
        url,
        agent_egress_guard_enabled(),
        std::env::var(ENV_AGENT_EGRESS_ALLOW_HOSTS).ok().as_deref(),
    )
    .await?;
    let shown = redact_url_for_display(url);
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {shown}"))?
        .to_owned();

    let mut builder = reqwest::Client::builder()
        // The stream can legitimately stay open for the lifetime of an MCP
        // session. Per-request RPC deadlines live in `sidecar::mcp::client`.
        // Reqwest 0.12 exposes a duration rather than an `Option`; keep the
        // transport body open well past Core's per-RPC deadline, which owns the
        // actual lifetime of an MCP request and closes this response on timeout.
        .timeout(std::time::Duration::from_secs(24 * 60 * 60))
        .redirect(reqwest::redirect::Policy::none());
    match screened {
        ScreenedEgress::Pinned(addrs) => {
            builder = pin_screened_http_client(builder, &host, &addrs);
        }
        ScreenedEgress::Exempt => {}
    }
    let client = builder
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build HTTP client: {e}"))?;

    let mut request = client
        .get(parsed.as_str())
        .header("User-Agent", crate::skills_catalog::USER_AGENT);
    for (name, value) in headers {
        match (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            (Ok(header_name), Ok(header_value)) => {
                request = request.header(header_name, header_value);
            }
            _ => tracing::warn!("guarded MCP GET: skipping invalid header name '{name}'"),
        }
    }

    request
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {shown}: {e}"))
}

/// SSRF-guarded HTTPS GET that optionally attaches an `Authorization: Bearer
/// <token>` header. Shares the exact resolve/screen/pin/redirect-none/https-only
/// guard with [`guarded_get`] so a BYOK credential (e.g. a Smithery registry API
/// key, #465) can never bypass the SSRF protections by being sent through a
/// plain client. The bearer is host-scoped by the *caller* (the credential must
/// only ever be attached to its own fixed host), so this helper simply attaches
/// whatever non-empty token it is given.
pub(crate) async fn guarded_get_with_bearer(
    url: &str,
    bearer: Option<&str>,
) -> anyhow::Result<reqwest::Response> {
    let trimmed = url.trim();
    let (client, _) = guarded_client(trimmed)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut req = client
        .get(trimmed)
        .header("User-Agent", crate::skills_catalog::USER_AGENT);
    if let Some(token) = bearer.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    req.send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {trimmed}: {e}"))
}

/// Max bytes read from an untrusted catalog/registry JSON response. These hosts
/// (official MCP registry, Smithery, model-index, marketplace, Ryu index) are
/// treated as untrusted, so a compromised/hostile one must not be able to OOM
/// Core with a multi-GB body. JSON catalog payloads are kilobytes; 32 MB is ample.
pub(crate) const MAX_CATALOG_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// SSRF-guarded GET that also asserts a success status and bounds the response
/// body to [`MAX_CATALOG_BODY_BYTES`] (streamed, so a lying `Content-Length`
/// can't bypass it). Returns the body bytes. Use for every untrusted catalog
/// fetch instead of `guarded_get(..).bytes()`.
pub(crate) async fn guarded_get_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    read_capped_body(guarded_get(url).await?, url).await
}

/// Bearer-bearing variant of [`guarded_get_bytes`] (e.g. Smithery BYOK key).
pub(crate) async fn guarded_get_bytes_with_bearer(
    url: &str,
    bearer: Option<&str>,
) -> anyhow::Result<Vec<u8>> {
    read_capped_body(guarded_get_with_bearer(url, bearer).await?, url).await
}

/// SSRF-guarded HTTPS GET that attaches caller-supplied request headers (e.g. a
/// private marketplace's `Authorization`/API-key headers). Shares the exact
/// resolve/screen/pin/redirect-none/https-only guard as [`guarded_get`], so an
/// injected credential can never bypass the SSRF protections. Invalid header
/// names/values are skipped (never sent); **header values are never logged.**
pub(crate) async fn guarded_get_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> anyhow::Result<reqwest::Response> {
    let trimmed = url.trim();
    let (client, _) = guarded_client(trimmed)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut req = client
        .get(trimmed)
        .header("User-Agent", crate::skills_catalog::USER_AGENT);
    for (name, value) in headers {
        match (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            (Ok(n), Ok(v)) => req = req.header(n, v),
            // Skip a malformed header name; the VALUE is never logged (may be secret).
            _ => tracing::warn!("catalog fetch: skipping invalid header name '{name}'"),
        }
    }
    req.send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {trimmed}: {e}"))
}

/// Header-bearing variant of [`guarded_get_bytes`] for private/authed catalogs.
pub(crate) async fn guarded_get_bytes_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> anyhow::Result<Vec<u8>> {
    read_capped_body(guarded_get_with_headers(url, headers).await?, url).await
}

/// Max bytes read from a `web_fetch` page body. A logged-in dashboard page is
/// typically tens to hundreds of KB; 5 MB bounds memory against a hostile/large
/// response. Read streamed, so a lying `Content-Length` can't bypass it; the body
/// is truncated at the cap rather than erroring (a partial page is still useful).
pub(crate) const MAX_WEB_FETCH_BODY_BYTES: u64 = 5 * 1024 * 1024;

/// SSRF-guarded HTTPS GET that attaches caller-supplied request headers and
/// returns the response status plus body text (UTF-8 lossy, capped).
///
/// This is the [`web_fetch`](crate::sidecar::mcp::web_fetch) tool's egress path:
/// the headers carry a user's Identity Vault session (e.g. a `Cookie`), spliced in
/// here so the request is made AS the user. It shares the exact
/// resolve/screen/pin/redirect-none/https-only guard as
/// [`guarded_get_with_bearer`], so an injected credential can never bypass the
/// SSRF protections. Invalid header names/values are skipped (never sent), and a
/// non-2xx status is returned (not an error) so an expired-cookie 302/401 is
/// observable rather than fatal. **Header values are never logged.**
pub(crate) async fn guarded_fetch_text_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> anyhow::Result<(u16, String)> {
    let trimmed = url.trim();
    let (client, _) = guarded_client(trimmed)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut req = client
        .get(trimmed)
        .header("User-Agent", crate::skills_catalog::USER_AGENT);
    for (name, value) in headers {
        match (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            (Ok(n), Ok(v)) => req = req.header(n, v),
            // Skip a malformed header name (value omitted from the log on purpose).
            _ => tracing::warn!("web_fetch: skipping invalid injected header name '{name}'"),
        }
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {trimmed}: {e}"))?;
    let status = resp.status().as_u16();
    // Stream the body with a hard cap; truncate at the cap rather than erroring.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| anyhow::anyhow!("reading {trimmed}: {e}"))?
    {
        if buf.len() as u64 + chunk.len() as u64 > MAX_WEB_FETCH_BODY_BYTES {
            let remaining = (MAX_WEB_FETCH_BODY_BYTES as usize).saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((status, String::from_utf8_lossy(&buf).into_owned()))
}

pub(crate) async fn read_capped_body(
    mut resp: reqwest::Response,
    url: &str,
) -> anyhow::Result<Vec<u8>> {
    if !resp.status().is_success() {
        anyhow::bail!("{url} returned HTTP {}", resp.status());
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_CATALOG_BODY_BYTES {
            anyhow::bail!("{url} response too large ({len} bytes; cap {MAX_CATALOG_BODY_BYTES})");
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| anyhow::anyhow!("reading {url}: {e}"))?
    {
        if buf.len() as u64 + chunk.len() as u64 > MAX_CATALOG_BODY_BYTES {
            anyhow::bail!("{url} exceeded the {MAX_CATALOG_BODY_BYTES}-byte body cap");
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// `POST /api/catalog/sources { kind, id, display_name, base_url? }`
/// Adds a custom source, persists it to the JSON file, returns ok.
#[utoipa::path(
    post,
    path = "/api/catalog/sources",
    tag = "Catalog",
    summary = "Add a custom catalog source",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn catalog_sources_add(
    State(state): State<ServerState>,
    Json(body): Json<AddCatalogSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "`id` must not be empty" })),
        );
    }
    // A custom source's base_url becomes an outbound fetch target — validate it
    // against the SSRF guard before persisting (authenticated, but still a
    // metadata/internal-host read primitive otherwise). Marketplace kinds
    // (Skill/Plugin) additionally accept local paths and git@/ssh clone URLs
    // (see `validate_marketplace_base_url`); every other kind stays https-only.
    if let Some(ref base) = body.base_url {
        if !base.trim().is_empty() {
            let result = match body.kind {
                crate::catalog_source::CatalogKind::Skill
                | crate::catalog_source::CatalogKind::Plugin => {
                    validate_marketplace_base_url(base).await
                }
                _ => validate_remote_base_url(base).await,
            };
            if let Err(e) = result {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "error": e })),
                );
            }
        }
    }
    let spec = crate::catalog_source::CustomSourceSpec {
        kind: body.kind,
        id: body.id,
        display_name: body.display_name,
        base_url: body.base_url,
        auth: body.auth,
    };
    match state.catalog_sources.add_custom(spec) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct RemoveCatalogSourceBody {
    pub(in crate::server) kind: crate::catalog_source::CatalogKind,
    pub(in crate::server) id: String,
}

/// `DELETE /api/catalog/sources { kind, id }`
/// Removes a user-added source. Built-in registries are intentionally immutable.
#[utoipa::path(
    delete,
    path = "/api/catalog/sources",
    tag = "Catalog",
    summary = "Remove a custom catalog source",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn catalog_sources_remove(
    State(state): State<ServerState>,
    Json(body): Json<RemoveCatalogSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.catalog_sources.remove_custom(body.kind, &body.id) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ReorderCatalogSourceBody {
    pub(in crate::server) kind: crate::catalog_source::CatalogKind,
    pub(in crate::server) id: String,
    pub(in crate::server) direction: String,
}

/// `POST /api/catalog/sources/reorder { kind, id, direction: up|down }`
/// Moves a user-added source within its kind's custom-source order.
#[utoipa::path(
    post,
    path = "/api/catalog/sources/reorder",
    tag = "Catalog",
    summary = "Reorder a custom catalog source",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn catalog_sources_reorder(
    State(state): State<ServerState>,
    Json(body): Json<ReorderCatalogSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let delta = match body.direction.as_str() {
        "up" => -1,
        "down" => 1,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": "direction must be `up` or `down`" })),
            );
        }
    };
    match state
        .catalog_sources
        .move_custom(body.kind, &body.id, delta)
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SelectCatalogSourceBody {
    pub(in crate::server) kind: crate::catalog_source::CatalogKind,
    pub(in crate::server) id: String,
}

/// `POST /api/catalog/sources/select { kind, id }`
/// Sets + persists the active source for a kind. Rejects an unknown id.
#[utoipa::path(
    post,
    path = "/api/catalog/sources/select",
    tag = "Catalog",
    summary = "Select the active source for a kind",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn catalog_sources_select(
    State(state): State<ServerState>,
    Json(body): Json<SelectCatalogSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state
        .catalog_sources
        .set_active(body.kind, &body.id, &state.preferences)
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}
