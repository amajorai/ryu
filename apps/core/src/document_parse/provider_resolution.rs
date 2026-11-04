//! Provider resolution.
// test-exempt: moved verbatim out of document_parse.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::document_parse::*;

// ── Provider resolution ───────────────────────────────────────────────────────

/// The bound `document.parse` provider: its plugin id, display name, and the
/// resolved route to its sidecar. `None` when no enabled app provides the capability.
///
/// Mirrors [`crate::memory_provider::bound_provider`] in intent — "who serves this
/// capability right now" — but resolves through the binding registry rather than the
/// MCP verb table, because this capability is served by an HTTP route on a sidecar
/// (`provides[].sidecar` + `provides[].route`), not by MCP verbs.
pub(in crate::document_parse) async fn bound_provider(
    state: &ServerState,
) -> Option<(ProviderRoute, String)> {
    let records = state.app_store.list().await.ok()?;
    let enabled: HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();

    let manifests = state.app_manifests.read().await;
    let candidates: Vec<crate::plugin_manifest::PluginManifest> = manifests
        .iter()
        .filter(|m| enabled.contains(&m.id))
        .cloned()
        .collect();
    drop(manifests);

    let cfg = crate::plugins::binding::active_config();
    let registry = crate::plugins::binding::BindingRegistry::new(&cfg, &candidates);
    let req = crate::plugin_manifest::CapabilityReq {
        capability: CAP_DOCUMENT_PARSE.to_owned(),
        min_version: None,
    };
    let binding = registry.resolve(&req).ok()?;
    let provider = candidates.iter().find(|m| m.id == binding.provider_id)?;
    let entry = provider
        .provided_capabilities()
        .iter()
        .find(|e| e.capability == CAP_DOCUMENT_PARSE)?
        .clone();
    let route = resolve_provider_route(provider, &entry, &binding.provider_id).ok()?;
    Some((route, provider.name.clone()))
}

/// The provider's sibling route for `name`, derived from its declared submit route.
///
/// **The convention, stated once:** a `document.parse` provider declares its *submit*
/// route in `provides[].route` (`/parse`) and serves `capability` and `jobs/{id}` as
/// siblings of it. The manifest schema has one `route` field, and inventing three
/// would push backend-specific layout into the kernel contract for every capability;
/// pinning the sibling names here keeps the manifest a single line while the poll and
/// discovery surfaces stay provider-agnostic. `/parse` → `/capability`, `/jobs/<id>`,
/// and a mounted provider (`/api/doc/parse`) keeps its mount.
pub(in crate::document_parse) fn sibling_path(route: &ProviderRoute, name: &str) -> String {
    let base = match route.upstream_path.rfind('/') {
        Some(i) => &route.upstream_path[..i],
        None => "",
    };
    format!("{base}/{name}")
}

/// Wake a lazy provider sidecar and hold it for the hop.
///
/// The returned guard must stay alive across the request: the ext-proxy's activity
/// guard drops at header arrival, so without it an idle-stop sidecar can be reaped
/// between the wake and the call.
///
/// Route-only: the in-process API uses its typed twin [`hold_provider`].
pub(in crate::document_parse) async fn wake_provider(
    state: &ServerState,
    route: &ProviderRoute,
) -> Result<Option<crate::sidecar::manager::ActivityGuard>, Response> {
    let Some(wake) = route.wake_name.as_ref() else {
        return Ok(None);
    };
    state
        .manager
        .wake_and_await_healthy(wake, WAKE_TIMEOUT)
        .await
        .map_err(|e| {
            tracing::warn!("document.parse: waking provider '{wake}' failed: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "document parser is warming up, retry shortly",
                    "code": "provider_warming",
                })),
            )
                .into_response()
        })?;
    Ok(Some(state.manager.enter_request(wake)))
}

/// One authenticated hop to the provider sidecar. The bearer is the PROVIDER's
/// minted `ext_token` — the same secret the ext-proxy stamps — so the sidecar's
/// fail-closed middleware accepts it and no other local process can.
///
/// Typed variant: the HTTP handlers below flatten this into a [`Response`]
/// ([`provider_call`]), the in-process API keeps the reason so a caller can tell a
/// transport timeout from a refused connection.
///
/// Takes `state` for ONE reason: the port is resolved here, from the sidecar manager's
/// live port claim, and nowhere else in this file. Pinning the derivation to the single
/// dial site is what keeps this facade from re-growing a second, drifting copy of "which
/// port is the provider on" — the copy that, when it disagreed with the manager, sent
/// the document bytes and the provider's minted `ext_token` to whatever unrelated
/// process happened to hold the manifest's declared port. See
/// [`crate::sidecar::manager::ForwardTarget`].
pub(in crate::document_parse) async fn provider_call_typed(
    state: &ServerState,
    route: &ProviderRoute,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    timeout: std::time::Duration,
) -> Result<(StatusCode, Value), ParseFailure> {
    let target = state
        .manager
        .forward_target(&route.sidecar_name)
        .map_err(|denied| {
            tracing::warn!(
                sidecar = %denied.name(),
                port = ?denied.port(),
                "document.parse refused to forward: {}",
                denied.reason()
            );
            ParseFailure::new(
                ParseFailureReason::ProviderError,
                format!(
                    "document parser '{}' is unavailable: {}",
                    denied.name(),
                    denied.reason()
                ),
            )
        })?;
    let url = format!("http://127.0.0.1:{}{}", target.port(), path);
    let token = ext_token(node_token().as_deref(), &route.provider_id);
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, &url)
        .timeout(timeout)
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().await.map_err(|e| {
        tracing::warn!("document.parse: provider call to {url} failed: {e}");
        let reason = if e.is_timeout() {
            ParseFailureReason::ProviderTimeout
        } else {
            ParseFailureReason::ProviderError
        };
        ParseFailure::new(reason, "document parser is unreachable")
    })?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let value: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    Ok((status, value))
}

/// [`provider_call_typed`] flattened for the HTTP handlers.
///
/// Both transport reasons collapse to the SAME 502 `provider_unreachable` the route
/// contract has always returned — the typed split is new information for in-process
/// callers, not a change to a shipped wire response.
///
/// Route-only: the three HTTP handlers are its only callers, and [`parse_capability`]
/// (the one that is mounted) is what keeps it live.
pub(in crate::document_parse) async fn provider_call(
    state: &ServerState,
    route: &ProviderRoute,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    timeout: std::time::Duration,
) -> Result<(StatusCode, Value), Response> {
    provider_call_typed(state, route, method, path, body, timeout)
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": "document parser is unreachable",
                    "code": "provider_unreachable",
                })),
            )
                .into_response()
        })
}
