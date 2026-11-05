//! Routing a capability call to its provider sidecar.

use super::*;

/// Pin a provider's [`ProvidesEntry`] to a concrete [`ProviderRoute`] (provider id +
/// sidecar key + upstream path + optional wake target) — resolving the named sidecar's
/// mount + route. Returns a 501 for an in-process capability (no sidecar/route) the
/// broker cannot proxy.
///
/// Deliberately resolves NO port: the port is the manager's to hand out
/// ([`crate::sidecar::SidecarManager::forward_target`]), not the manifest's.
///
/// `pub(crate)` for [`crate::document_parse`], which resolves a `document.parse`
/// provider's sidecar route exactly the way the broker does rather than growing a
/// second, drifting copy of the mount+route+wake derivation.
pub(crate) fn resolve_provider_route(
    provider: &crate::plugin_manifest::PluginManifest,
    entry: &crate::plugin_manifest::ProvidesEntry,
    provider_id: &str,
) -> Result<ProviderRoute, Response> {
    let (Some(sc_name), Some(route)) = (&entry.sidecar, &entry.route) else {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "capability is in-process, not broker-proxyable" })),
        )
            .into_response());
    };
    let Some(spec) = provider.sidecars.iter().find(|s| &s.name == sc_name) else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "provider sidecar missing" })),
        )
            .into_response());
    };
    let mount = spec
        .http
        .as_ref()
        .and_then(|h| h.mount.as_deref())
        .map(|m| m.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    // The manager key for the provider's sidecar. Computed UNCONDITIONALLY: it is now
    // the route's only handle on a port (the caller resolves it through
    // `SidecarManager::forward_target` right before dialing), separate from the
    // should-I-wake hint below which stays manifest-derived.
    let sidecar_name = crate::sidecar::manifest_sidecar::namespaced_name(provider_id, &spec.name);
    // If the provider sidecar opted into on-demand start, name it so the broker can
    // wake it before forwarding (the capability-broker analogue of the ext-proxy wake).
    let wake_name = (spec.lazy || spec.idle_stop_secs.is_some()).then(|| sidecar_name.clone());
    Ok(ProviderRoute {
        provider_id: provider_id.to_owned(),
        sidecar_name,
        // Same root rule as the inbound proxy: a declared `"/"` route forwards to the
        // bare mount, because sidecars nest their routers there and `{mount}/` 404s.
        upstream_path: upstream_path_for(&mount, route),
        wake_name,
    })
}

/// Wake (when lazy) and pin a resolved provider route to the manager's live,
/// registered target — the broker's step 3b + 3c, shared with the Core-as-consumer
/// helper ([`crate::sidecar::capability_consumer`]) so both lanes apply the SAME
/// registration gate before handing a provider its minted token. The returned guard
/// (if any) must stay alive across the hop so an idle-stop sidecar is not reaped
/// between the wake and the call.
pub(crate) async fn provider_target(
    manager: &std::sync::Arc<crate::sidecar::SidecarManager>,
    route: &ProviderRoute,
) -> Result<
    (
        ForwardTarget,
        Option<crate::sidecar::manager::ActivityGuard>,
    ),
    String,
> {
    let activity = if let Some(wake) = &route.wake_name {
        manager
            .wake_and_await_healthy(wake, WAKE_WARMUP_TIMEOUT)
            .await
            .map_err(|e| format!("waking provider '{wake}' failed: {e}"))?;
        Some(manager.enter_request(wake))
    } else {
        None
    };
    let target = manager
        .forward_target(&route.sidecar_name)
        .map_err(|denied| denied.reason())?;
    Ok((target, activity))
}

/// POST a JSON body to a resolved provider route through [`forward_to_sidecar`] —
/// the single Core→sidecar hop the ext-proxy and the broker share — stamping the
/// PROVIDER's minted token. No caller identity, cookies, or payment headers are
/// forwarded: Core itself is the consumer.
pub(crate) async fn post_to_provider(
    target: ForwardTarget,
    route: &ProviderRoute,
    body: Vec<u8>,
) -> Response {
    post_to_provider_hop(target, route, body, None).await
}

/// [`post_to_provider`] for a Core event delivery: also stamps
/// [`HDR_EVENT_DELIVERY`] with `delivery_id`, which no other hop can carry.
pub(crate) async fn post_event_delivery(
    target: ForwardTarget,
    route: &ProviderRoute,
    body: Vec<u8>,
    delivery_id: &str,
) -> Response {
    post_to_provider_hop(target, route, body, Some(delivery_id)).await
}

pub(super) async fn post_to_provider_hop(
    target: ForwardTarget,
    route: &ProviderRoute,
    body: Vec<u8>,
    event_delivery: Option<&str>,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &route.upstream_path,
        query: "",
        method: reqwest::Method::POST,
        src_headers: &headers,
        body,
        hop_plugin_id: &route.provider_id,
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_restricted: false,
        event_delivery,
    })
    .await
}

/// A resolved broker target: where to forward + how to wake the provider sidecar.
///
/// `pub(crate)` alongside [`resolve_provider_route`] — the facade in
/// [`crate::document_parse`] holds one of these across its submit/poll hops.
#[derive(Debug, Clone)]
pub(crate) struct ProviderRoute {
    pub(crate) provider_id: String,
    /// The manager key (`<plugin_id>/<local_name>`) of the provider's sidecar. NOT a
    /// port: every consumer resolves this through
    /// [`crate::sidecar::SidecarManager::forward_target`] immediately before dialing, so
    /// a provider that never registered (its declared port is held by some other host
    /// process) is refused instead of handed the caller's body and the provider's minted
    /// token. See [`ForwardTarget`].
    pub(crate) sidecar_name: String,
    pub(crate) upstream_path: String,
    /// The manager key to wake before forwarding, when the provider sidecar is
    /// lazy/idle-eligible; `None` for an eager provider (forward directly).
    pub(crate) wake_name: Option<String>,
}
