//! `GET /api/widgets/asset` (the governed remote-asset proxy) and
//! `POST /api/mcp/resources/read` (widget resource reload).

use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    http::{header, HeaderName, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{err_reply, store, WidgetInstance};
use crate::server::ServerState;

// ── GET /api/widgets/asset — governed remote-asset proxy ─────────────────────
//
// A widget renders inside a null-origin sandbox whose CSP pins `connect-src
// 'none'`: it cannot `fetch()`/beacon, and its ONLY egress channel is passive
// subresources (`<img>`, `@font-face`, `<audio>`/`<video>`) which the mount
// rewrites to point here. This proxy is therefore the single governed egress
// lane for a widget's declared remote assets (the img-src analogue of the
// governed `callTool` lane). It rides the PUBLIC router because a browser
// subresource load cannot carry the node bearer; auth is in-handler:
//
//   1. `instance` → a live minted `WidgetInstance` (the capability + provenance)
//      → the authoritative `origin_server` (never a client-supplied `server=`).
//   2. the target host MUST be in that origin server's widget-resource
//      `resource_domains` allowlist (a forged `template` can only pick another
//      allowlist ON THE SAME SERVER — it can never widen beyond it).
//   3. the shared Ryu egress primitive rejects private/loopback/link-local/metadata
//      targets even if an allowlist entry names one, and pins the resolved address.
//   4. a content-type allowlist (image/font/audio/video only) + size cap +
//      timeout, and every fetch is exec-audited so the Gateway sees the egress.
//   5. every proxied response carries a sandboxing CSP, so an asset opened as a
//      top-level document (e.g. a scripted SVG) never runs script in Core's origin.

/// Max bytes proxied for a single asset (fail-closed above this).
const WIDGET_ASSET_MAX_BYTES: usize = 25 * 1024 * 1024;
/// Upstream fetch timeout for a proxied asset.
const WIDGET_ASSET_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct WidgetAssetQuery {
    /// Minted widget instance id — the capability + provenance handle. Resolves
    /// the authoritative origin server; never client-supplied server identity.
    #[serde(alias = "instanceId")]
    instance: String,
    /// The widget resource uri whose declared `resource_domains` allowlist gates
    /// this fetch. Resolved on the instance's origin server, so a forged value can
    /// only select another allowlist on the SAME server.
    #[serde(default, alias = "templateUri")]
    template: Option<String>,
    /// The absolute `https://` asset URL to proxy.
    url: String,
}

/// `GET /api/widgets/asset` — the governed remote-asset egress lane (see the
/// module comment above). Fail-closed at every step.
#[utoipa::path(
    get,
    path = "/api/widgets/asset",
    tag = "Widgets",
    summary = "governed remote-asset proxy for a sandboxed widget",
    params(
        ("instance" = String, Query, description = "minted widget instance id"),
        ("template" = Option<String>, Query, description = "widget resource uri"),
        ("url" = String, Query, description = "absolute https asset url")
    ),
    responses((status = 200, description = "asset bytes"))
)]
pub async fn widget_asset(
    State(state): State<ServerState>,
    Query(q): Query<WidgetAssetQuery>,
) -> axum::response::Response {
    // 1. instance → origin server (authoritative provenance; fail-closed).
    let Some(record) = store().get(&q.instance) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    };

    // 2. Parse the target; `https://` only.
    let Ok(target) = url::Url::parse(&q.url) else {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "asset url is not a valid URL",
        );
    };
    if target.scheme() != "https" {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "asset url must be https",
        );
    }
    let Some(host) = target.host_str().map(str::to_ascii_lowercase) else {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "asset url has no host",
        );
    };

    // 3. Authoritative allowlist: the origin server's widget-resource
    //    `resource_domains`. Empty allowlist (e.g. a built-in that inlines every
    //    asset) → refuse everything.
    let allow = widget_asset_allowlist(&state, &record.origin_server, q.template.as_deref()).await;
    if !allow.iter().any(|h| h == &host) {
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            format!("host '{host}' is not in the widget's declared resource_domains"),
        );
    }

    // 4. Core's shared egress primitive screens the hostname, resolves every
    //    address, rejects internal ranges, pins the connection to those addresses,
    //    disables redirects, and enforces the timeout/body cap.
    let started = Instant::now();
    let resp = match ryu_egress::guarded_request(
        ryu_egress::GuardedRequest {
            method: "GET".to_owned(),
            url: target.to_string(),
            headers: vec![(
                header::ACCEPT.as_str().to_owned(),
                "image/*,font/*,audio/*,video/*,*/*;q=0.1".to_owned(),
            )],
            body: None,
        },
        ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: WIDGET_ASSET_MAX_BYTES as u64,
            max_redirect_hops: 0,
            timeout: WIDGET_ASSET_TIMEOUT,
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            audit_asset(&record, &host, 0, started, Some(error.clone())).await;
            let status = if error.contains("not allowed") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_GATEWAY
            };
            return err_reply(status, "denied", error);
        }
    };
    if !(200..300).contains(&resp.status) {
        let status = resp.status;
        audit_asset(
            &record,
            &host,
            0,
            started,
            Some(format!("upstream {status}")),
        )
        .await;
        return err_reply(
            StatusCode::BAD_GATEWAY,
            "server_error",
            format!("asset upstream returned {status}"),
        );
    }

    // 7. Content-type allowlist: passive media only — never html/js (a widget can
    //    never turn this lane into a remote-code loader; script-src is nonce-only
    //    regardless, so this is belt-and-suspenders).
    let content_type = resp
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(header::CONTENT_TYPE.as_str()))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    if !content_type_is_allowed(&content_type) {
        audit_asset(
            &record,
            &host,
            0,
            started,
            Some(format!("blocked content-type {content_type}")),
        )
        .await;
        return err_reply(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "denied",
            format!("content-type '{content_type}' is not a permitted widget asset type"),
        );
    }

    // 8. The shared egress response is already bounded by the policy above.
    let bytes = resp.body;
    let n = bytes.len();
    audit_asset(&record, &host, n, started, None).await;

    // 9. Return the bytes with the real content-type. `Access-Control-Allow-Origin:
    //    *` is REQUIRED: a null-origin frame's cross-origin `@font-face` fetch is
    //    CORS-gated and silently fails without it (images are no-cors, so ACAO is a
    //    harmless no-op for them). `nosniff` + a modest cache round it out.
    widget_asset_response(content_type, bytes)
}

/// CSP on every proxied widget asset. The bytes are upstream-chosen and served
/// from Core's origin on the public router, and the type gate admits scriptable
/// `image/svg+xml`, so a top-level navigation to the asset must not become a
/// live document: `sandbox` (no `allow-*`) disables script and gives it an opaque
/// origin, and `default-src 'none'` blocks every fetch. The `data:` image/font
/// and inline-style allowances mirror the widget frame's own passive-asset CSP so
/// an SVG rendered as `<img>` (where some engines apply this header) keeps its
/// embedded images, fonts, and styles; none of them is a script or network channel.
const WIDGET_ASSET_CSP: &str =
    "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox";

/// The 200 response for a proxied widget asset (step 9 of [`widget_asset`]).
pub(super) fn widget_asset_response(
    content_type: String,
    bytes: Vec<u8>,
) -> axum::response::Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_owned()),
            (header::CACHE_CONTROL, "public, max-age=3600".to_owned()),
            (
                HeaderName::from_static("x-content-type-options"),
                "nosniff".to_owned(),
            ),
            (header::CONTENT_SECURITY_POLICY, WIDGET_ASSET_CSP.to_owned()),
        ],
        bytes,
    )
        .into_response()
}

/// Resolve the origin server's widget-resource `resource_domains` allowlist
/// (lowercased exact hosts). Server-scoped via `widget_resource(server, tpl)`, so
/// a client-forged `template` can only ever select another allowlist on the same
/// server. A built-in app (meta `None`) yields an empty allowlist → deny-all.
async fn widget_asset_allowlist(
    state: &ServerState,
    server: &str,
    template: Option<&str>,
) -> Vec<String> {
    let meta = match template {
        Some(tpl) => state
            .mcp
            .widget_resource(server, tpl)
            .await
            .and_then(|r| r.meta),
        None => None,
    };
    meta.as_ref()
        .map(parse_resource_domains)
        .unwrap_or_default()
}

/// Parse the `resource_domains` allowlist from a widget resource's `_meta`,
/// tolerating every spelling in the wild: top-level `resource_domains` /
/// `resourceDomains`, and the nested `openai/widgetCSP` / `ryu/widgetCSP` /
/// `ui.csp` objects. Each entry is normalized to a bare lowercase host.
pub(crate) fn parse_resource_domains(meta: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push_from = |v: Option<&Value>| {
        if let Some(arr) = v.and_then(Value::as_array) {
            for item in arr {
                if let Some(h) = item.as_str().and_then(normalize_allow_host) {
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
            }
        }
    };
    push_from(meta.get("resource_domains"));
    push_from(meta.get("resourceDomains"));
    for container in ["openai/widgetCSP", "ryu/widgetCSP"] {
        if let Some(csp) = meta.get(container) {
            push_from(csp.get("resource_domains"));
            push_from(csp.get("resourceDomains"));
        }
    }
    if let Some(csp) = meta.get("ui").and_then(|ui| ui.get("csp")) {
        push_from(csp.get("resource_domains"));
        push_from(csp.get("resourceDomains"));
    }
    out
}

/// Normalize an allowlist entry (`https://cdn.example.com`, `cdn.example.com`,
/// `cdn.example.com:443/x`) to its bare lowercase host, or `None`. Wildcards are
/// rejected (exact-host match only — fail-closed, mirroring the client sanitizer).
pub(super) fn normalize_allow_host(entry: &str) -> Option<String> {
    let e = entry.trim();
    if e.is_empty() {
        return None;
    }
    let host = if e.contains("://") {
        url::Url::parse(e).ok()?.host_str()?.to_ascii_lowercase()
    } else {
        e.split('/')
            .next()?
            .split(':')
            .next()?
            .trim()
            .to_ascii_lowercase()
    };
    if host.is_empty() || host.contains('*') || !host.contains('.') {
        return None;
    }
    Some(host)
}

/// Passive-media content types only. `application/octet-stream` is permitted (CDNs
/// serve fonts/images as it) — safe because the frame's `script-src` is nonce-only,
/// so a mislabeled script can never execute regardless of what this returns.
pub(super) fn content_type_is_allowed(ct: &str) -> bool {
    let m = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    m.starts_with("image/")
        || m.starts_with("font/")
        || m.starts_with("audio/")
        || m.starts_with("video/")
        || m == "application/font-woff"
        || m == "application/font-woff2"
        || m == "application/vnd.ms-fontobject"
        || m == "application/octet-stream"
}

/// Emit a Gateway exec-audit for a proxied asset fetch so every widget egress is
/// visible to the governance layer (the property the `connect-src 'none'` lock +
/// this proxy jointly provide). Best-effort; never blocks the response.
async fn audit_asset(
    record: &WidgetInstance,
    host: &str,
    bytes: usize,
    started: Instant,
    error: Option<String>,
) {
    crate::sidecar::gateway::report_exec_audit_with_attribution(
        "widget-asset",
        &format!("GET https://{host} ({bytes} bytes)"),
        started.elapsed().as_millis() as u64,
        i32::from(error.is_some()),
        Some(record.conversation_id.clone()),
        error,
        crate::sidecar::gateway::ExecAuditAttribution {
            agent_id: Some(record.agent_id.clone()),
            feature: Some("widget".to_owned()),
            ..Default::default()
        },
    )
    .await;
}

// ── Widget resource fetch (reload / third-party fallback) ────────────────────

#[derive(Debug, Deserialize)]
pub struct ResourceReadBody {
    /// The MCP server that owns the resource (in-process app namespace or a
    /// config server). Optional: when absent, only in-process apps resolve.
    #[serde(default)]
    server: Option<String>,
    uri: String,
}

/// `POST /api/mcp/resources/read` — resolve a widget resource by uri (used on
/// session reload to re-resolve `widget.html` from the resource cache).
#[utoipa::path(
    post,
    path = "/api/mcp/resources/read",
    tag = "MCP",
    summary = "resolve a widget resource by uri (used on",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn mcp_resources_read(
    State(state): State<ServerState>,
    Json(body): Json<ResourceReadBody>,
) -> axum::response::Response {
    let Some(server) = body.server.as_deref().filter(|s| !s.is_empty()) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown widget resource",
        );
    };
    match state.mcp.widget_resource(server, &body.uri).await {
        Some(res) => Json(json!({
            "ok": true,
            "uri": res.uri,
            "mimeType": res.mime_type,
            "text": res.html,
        }))
        .into_response(),
        None => err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown widget resource",
        ),
    }
}
