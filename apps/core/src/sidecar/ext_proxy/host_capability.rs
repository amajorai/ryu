//! The host capability broker.

use super::*;

/// `POST /api/host/capability/:cap` — the **capability broker**. A consumer sidecar
/// invokes an *abstract* capability; Core resolves it to the bound provider app and
/// forwards the call to the provider's declared route using the PROVIDER's minted
/// token (the consumer never sees it). This is where a `requires: [rag]` edge turns
/// into a real call to whichever provider is bound.
///
/// Two kinds of capability share this one route:
///
/// - **Kernel** capabilities ([`KERNEL_CAPABILITIES`]) — host primitives Core itself
///   implements. Authenticated caller + the row's declared∩approved grant, then
///   dispatched IN-PROCESS. This is where the retired `/api/host/<app>/*` callbacks
///   now live.
/// - **App-provided** capabilities — resolved to a bound provider app and proxied to
///   its sidecar route with the PROVIDER's minted token (the consumer never sees it).
///   This is where a `requires: [rag]` edge turns into a real call.
///
/// A **fan-out** capability ([`crate::plugins::binding::FANOUT_CAPABILITIES`]) is
/// neither: Core calls it on every provider itself, and the broker refuses it (404)
/// whatever the caller declares or holds.
///
/// The provider path's three-way check, fail-closed at each step:
/// 1. the CALLER **declared** the edge (its `requires.capabilities` names `cap`) —
///    else 404;
/// 2. the bound **PROVIDER** `provides` `cap`, resolved via the binding registry
///    over the enabled set (Unprovided ⇒ 404, Ambiguous ⇒ 409);
/// 3. the caller **holds** the provider's declared `grant` (Gateway-approved) —
///    else 403.
///
/// A capability with no sidecar/route (in-process) is not broker-proxyable ⇒ 501.
pub(super) async fn host_capability(
    State(state): State<ServerState>,
    Path(cap): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();

    // 1. Authenticate the CALLER (consumer) sidecar.
    let (caller_id, caller_grants) = match authenticate_sidecar(&state, &parts.headers).await {
        Ok(v) => v,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    // 1b. KERNEL capability — Core is the implementation, so there is no provider to
    //     bind and the binding registry (which would answer `Unprovided`) must never
    //     be reached. Gate on the row's grant, then dispatch in-process and return.
    if let Some(kernel) = kernel_capability(&cap) {
        if let Some(grant) = kernel.grant {
            if !holds_host_api_grant(&state, &caller_id, &caller_grants, grant).await {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "capability grant not granted", "capability": cap, "grant": grant })),
                )
                    .into_response();
            }
        }
        let bytes = match axum::body::to_bytes(body, DEFAULT_MAX_PROXY_BYTES).await {
            Ok(b) => b,
            Err(_) => {
                return (StatusCode::PAYLOAD_TOO_LARGE, "capability body too large")
                    .into_response();
            }
        };
        return dispatch_kernel_capability(&cap, state, parts.headers, &bytes).await;
    }

    // 1c. FAN-OUT capability (`data.*`, `jobs.*`): served by every app for its OWN
    //     data or jobs, and called only by Core on each provider in turn. Never
    //     brokered: the ordinary ladder would bind a sole provider and let any
    //     sidecar that declared the edge read or run another app's data or jobs.
    if crate::plugins::binding::is_fanout_capability(&cap) {
        return (
            StatusCode::NOT_FOUND,
            Json(
                json!({ "error": "capability not callable through the broker", "capability": cap }),
            ),
        )
            .into_response();
    }

    // 2. The caller must have DECLARED this capability edge; capture its version floor.
    let required = {
        let manifests = state.app_manifests.read().await;
        manifests.iter().find(|m| m.id == caller_id).and_then(|m| {
            m.required_capabilities()
                .iter()
                .find(|r| r.capability == cap)
                .cloned()
        })
    };
    let Some(required) = required else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "capability not required by caller", "capability": cap })),
        )
            .into_response();
    };

    // 3. Resolve the bound provider over the ENABLED manifest set, then pin its
    //    sidecar route — all before any await, so no read guard is held across the
    //    upstream hop.
    let records = match state.app_store.list().await {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "lookup failed" })),
            )
                .into_response();
        }
    };
    let enabled_ids: HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();

    let resolved: Result<ProviderRoute, Response> = {
        let manifests = state.app_manifests.read().await;
        let enabled: Vec<crate::plugin_manifest::PluginManifest> = manifests
            .iter()
            .filter(|m| enabled_ids.contains(&m.id))
            .cloned()
            .collect();
        let cfg = crate::plugins::binding::active_config();
        let registry = crate::plugins::binding::BindingRegistry::new(&cfg, &enabled);
        match registry.resolve(&required) {
            Ok(binding) => {
                let provider = enabled.iter().find(|m| m.id == binding.provider_id);
                let entry = provider.and_then(|p| {
                    p.provided_capabilities()
                        .iter()
                        .find(|e| e.capability == cap)
                        .map(|e| (p, e))
                });
                match entry {
                    Some((provider, entry)) => {
                        // Grant gate: the caller must hold the provider's declared grant.
                        if let Some(grant) = &entry.grant {
                            if !caller_grants.contains(grant) {
                                Err((
                                    StatusCode::FORBIDDEN,
                                    Json(json!({ "error": "capability grant not held", "grant": grant })),
                                )
                                    .into_response())
                            } else {
                                resolve_provider_route(provider, entry, &binding.provider_id)
                            }
                        } else {
                            resolve_provider_route(provider, entry, &binding.provider_id)
                        }
                    }
                    None => Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({ "error": "provider not enabled" })),
                    )
                        .into_response()),
                }
            }
            Err(e) => {
                use crate::plugins::binding::BindingError;
                let status = match e {
                    BindingError::Unprovided { .. } => StatusCode::NOT_FOUND,
                    _ => StatusCode::CONFLICT,
                };
                Err((
                    status,
                    Json(json!({ "error": e.to_string(), "code": e.code() })),
                )
                    .into_response())
            }
        }
    };
    let ProviderRoute {
        provider_id,
        sidecar_name,
        upstream_path,
        wake_name,
    } = match resolved {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    // 3b. Wake a lazy/idle-stopped PROVIDER sidecar before forwarding — the broker
    //     analogue of the ext-proxy wake. Reached only after the full 3-way check
    //     (authenticated caller + declared edge + grant held), so no unauthenticated
    //     caller can spin a provider process. `_activity` pins it for the hop.
    let _activity = if let Some(wake) = &wake_name {
        match state
            .manager
            .wake_and_await_healthy(wake, WAKE_WARMUP_TIMEOUT)
            .await
        {
            Ok(woke) => {
                if woke {
                    fire_lazy_activation(&state, ACTIVATION_ON_CAPABILITY_CALL);
                }
            }
            Err(e) => return wake_failed_response("broker", wake, &e, true),
        }
        Some(state.manager.enter_request(wake))
    } else {
        None
    };

    // 3c. The SAME registration gate the inbound proxy applies. The broker used to be
    //     asymmetric with the proxy here: it derived its wake target from the MANIFEST
    //     spec (`spec.lazy || idle_stop_secs`), so a lazy provider that failed to
    //     register at least failed closed on the wake — but an EAGER provider had no
    //     gate at all and forwarded straight to `profile::port(spec.port)`, squatter or
    //     not. Resolving through the manager immediately before dialing closes that hole
    //     and removes the asymmetry: both lanes now dial only a claimed, live port.
    let target = match state.manager.forward_target(&sidecar_name) {
        Ok(t) => t,
        Err(denied) => return sidecar_unavailable(&denied),
    };

    // 4. Forward the caller's body to the provider's route, stamping the PROVIDER's
    //    minted token (forward_to_sidecar overwrites the caller's Authorization).
    let body_bytes = match axum::body::to_bytes(body, DEFAULT_MAX_PROXY_BYTES).await {
        Ok(b) => b.to_vec(),
        Err(_) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, "capability body too large").into_response();
        }
    };
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &upstream_path,
        query: &query,
        method: reqwest::Method::POST,
        src_headers: &parts.headers,
        body: body_bytes,
        hop_plugin_id: &provider_id,
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_restricted: false,
        event_delivery: None,
    })
    .await
}
