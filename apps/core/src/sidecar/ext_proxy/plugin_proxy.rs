//! The per-plugin HTTP proxy: resolve, gate and forward one request.

use super::*;

/// The shared reverse-proxy core: enabled-gate → resolve the declared route
/// (undeclared ⇒ 404) → per-route auth → forward to the sidecar with the plugin's
/// minted token. Used by BOTH the `/api/ext/:id/*` catch-all and the build-time
/// public-mount routes, so the two lanes can never drift on the security-critical
/// gates.
pub(super) async fn proxy_for_plugin(
    state: &ServerState,
    plugin_id: &str,
    sub_path: &str,
    _startup_node_token: Option<String>,
    req: Request,
) -> Response {
    let request_method = req.method().as_str().to_owned();
    // Enabled gate (secrecy: a disabled/absent plugin's proxied surface must not exist).
    match state.app_store.get(plugin_id).await {
        Ok(Some(rec)) if rec.enabled => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::warn!("ext proxy: app_store lookup for '{plugin_id}' failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    // Resolve the manifest → sidecar spec + matched route (undeclared path ⇒ 404).
    let manifests = state.app_manifests.read().await;
    let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The forward below appends `?<query>` exactly when the request carries one.
    if forward_url_trims_path_end(sub_path, req.uri().query()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((spec, http, route)) = resolve_route(manifest, sub_path, &request_method) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = route.auth;
    if public_route_raw_path_is_unsafe(auth, req.uri().path()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Resolved while the manifest guard is still held, since the gate below runs
    // after it is dropped.
    let required = required_permission_for(route, sub_path, plugin_id);
    // Only a web-delegated request pays for (or is affected by) these facts.
    let web_facts = req
        .headers()
        .contains_key(HDR_WEB_DELEGATION)
        .then(|| web_delegation_facts(&manifests, manifest, required.is_some(), req.headers()));
    let (caller_agent_id, caller_agent_egress_allowlist) = match verified_agent(&req, plugin_id) {
        Ok(Some(agent)) => (Some(agent.id), agent.egress_allowlist),
        Ok(None) => (None, None),
        Err(response) => return response,
    };
    // Only an agent whose account access is restricted needs the app's
    // provider calls tied to its grant; an unrestricted one may use every
    // account the user's own (grant-less) calls use. A store error counts as
    // restricted.
    let caller_agent_restricted = match caller_agent_id.as_deref() {
        Some(agent_id) => {
            crate::agent_access::account_confinement_for_agent(&state.agent_store, agent_id)
                .await
                .is_confined()
        }
        None => false,
    };
    let mut caller = crate::server::verified_caller_from_headers(req.headers()).await;
    if crate::sidecar::control_plane::is_managed_node()
        && matches!(
            plugin_id,
            "@ryu/docling" | "@ryu/markitdown" | "@ryu/mineru" | "@ryu/unstructured"
        )
    {
        return (
            StatusCode::FORBIDDEN,
            "document sidecar jobs require per-job tenant binding on managed nodes",
        )
            .into_response();
    }
    // NOTE: the manifest supplies mount, routes, auth, permission and max_body_bytes —
    // everything EXCEPT the port. The port comes from the manager's claim registry
    // (`forward_target`, below), never from `spec.port`: see [`ForwardTarget`] for why
    // those two facts must not be allowed to disagree at a hop.
    let mount = http
        .mount
        .as_deref()
        .map(|m| m.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    let max_body = http.max_body_bytes.unwrap_or(DEFAULT_MAX_PROXY_BYTES);
    let forward_cookie_names = http.forward_cookie_names.clone();
    let forward_caller_email = http.forward_caller_email;
    let forward_caller_rate_subject = http.forward_caller_rate_subject;
    let caller_resource_scope = http.caller_resource_scope.clone();
    // The manager key for this sidecar.
    let sidecar_name = crate::sidecar::manifest_sidecar::namespaced_name(plugin_id, &spec.name);
    // Only an exact compiled first-party manifest keeps the shared origin for the
    // documents it serves (see `response_hardening`).
    let trusted_first_party = crate::plugins::builtins::is_exact_compiled_manifest(manifest);
    drop(manifests);
    // Whether this sidecar opted into on-demand start — resolved from the manager's
    // registered state (lazy-registered, or carrying an idle-stop timeout so it may
    // have been scaled to zero), the single source of truth the reaper also uses.
    let wake_eligible = state.manager.is_wake_eligible(&sidecar_name);

    // Per-route auth: a Protected route requires the node bearer, checked exactly as
    // `require_auth` does (None ⇒ allow, for loopback dev with no token configured).
    // A route that declares a permission level also admits a member's own
    // session or app route delegation, which then IS the caller the permission
    // check below evaluates (see `member_admission`).
    if auth == RouteAuth::Protected {
        match member_admission::admit_protected(
            req.headers(),
            plugin_id,
            sub_path,
            &request_method,
            required.is_some(),
        )
        .await
        {
            Ok(member_admission::Admission::NodeToken) => {}
            Ok(member_admission::Admission::Member(member)) => caller = member,
            Err(status) => return status.into_response(),
        }
    }

    // A request the web tier forwarded for a browser carries the node token, so on its
    // own it would read as the owner. Narrow it to a verified member of a bound node, a
    // permission-annotated route, and a reviewed grant edge of a web-capable Companion
    // app. A request without the marker skips this entirely, byte for byte as before.
    if let Some(facts) = web_facts.as_ref() {
        if let Err(status) = web_delegated_admission(state, plugin_id, &caller, facts).await {
            return status.into_response();
        }
    }

    // App-declared per-route permission. Manifest data, because only the app knows
    // which of its routes are destructive; enforced HERE, because only Core knows who
    // the caller is (the sidecar sees Core's minted hop token, never a human).
    //
    // Runs through the SAME `enforce_permission_on` the kernel's own per-resource
    // routes use, deliberately not a copy: the anonymous/org rules a personal node
    // depends on (anonymous + unbound node ⇒ allowed) are exactly the rules that must
    // not fork, and a second implementation is how they silently would.
    //
    // A route the app did not annotate never reaches this branch — no permission
    // lookup, no JWT verification, no behaviour change for any app shipping today.
    if let Some((permission, resource_id)) = required {
        // The plugin id is the resource KIND, so an app's resource ids live in their
        // own keyspace and can never be confused with the kernel's (`space:abc`) or
        // another app's.
        if let Err(status) = crate::server::enforce_permission_on(
            state,
            &caller,
            &permission,
            plugin_id,
            &resource_id,
        )
        .await
        {
            return status.into_response();
        }
    }

    let caller_resource_ids = match caller_resource_scope.as_deref() {
        None => None,
        Some("conversation") => {
            let (user_id, org_id, team_ids_json, node_bound) =
                crate::server::tenancy_filter_args(&caller);
            // Ids and source versions only (no summary decryption), newest first,
            // so the bounded header below keeps the caller's most recently active
            // conversations. Each entry is `<version>:<id>`: the version changes
            // when a conversation is deleted and another is created under the same
            // id, so the sidecar never serves the old one's derived data to it.
            let visible = state
                .conversations
                .visible_conversation_versions_for_teams(
                    user_id.as_deref(),
                    org_id.as_deref(),
                    node_bound,
                    team_ids_json.as_deref(),
                )
                .await;
            let visible = match visible {
                Ok(visible) => visible,
                Err(error) => {
                    tracing::warn!(%error, "ext proxy: caller resource scope lookup failed");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            let entries: Vec<String> = visible
                .iter()
                .map(|(id, version)| format!("{version}:{id}"))
                .collect();
            let (encoded, omitted) = encode_caller_resource_ids(
                entries.iter().map(String::as_str),
                MAX_CALLER_RESOURCE_IDS_BYTES,
            );
            if omitted > 0 {
                tracing::warn!(
                    plugin_id,
                    omitted,
                    "ext proxy: caller resource scope truncated to the most recently updated resources"
                );
            }
            Some(encoded)
        }
        Some(_) => return StatusCode::FORBIDDEN.into_response(),
    };

    // ── Registration gate + wake-on-demand ────────────────────────────────────
    //
    // STRICTLY AFTER the auth and permission checks above, so neither an
    // unauthenticated nor an unauthorized caller can spin a process (both also
    // short-circuit before the body is buffered, so a refused caller cannot push
    // `max_body_bytes` through Core either).
    //
    // The gate: the ONLY port we will ever dial is one the manager holds a live claim
    // on for this sidecar. Before this existed, the proxy dialed `profile::port(spec.port)`
    // unconditionally — so a sidecar whose `claim_port` was REFUSED (an unrelated host
    // process already listening on the declared port; very plausible in the dev profile's
    // +1000 band) had Core deliver authenticated requests, full bodies, cookies and the
    // plugin's minted `RYU_EXT_TOKEN` straight to that foreign process, while the app
    // merely looked broken. `is_wake_eligible` did NOT cover this: `lazy_registered` is
    // populated only AFTER a successful claim, so a failed-claim LAZY sidecar reads as
    // not-wake-eligible and fell through to the same blind forward as an eager one.
    //
    // Registration and running-ness are two different questions, which is why the arms
    // below are not one flat check: `register()` claims the port and inserts into the
    // registry WITHOUT starting the process, so "registered, claim held, not running" is
    // the normal resting state of a lazy sidecar and must still wake. Only "never
    // registered" is a refusal, and it must never wake — `wake_sidecar` would error
    // "unknown sidecar" anyway, and forwarding is the vulnerability itself.
    let mut target = match state.manager.forward_target(&sidecar_name) {
        Ok(t) => Some(t),
        // Never registered ⇒ refuse without dialing anything. 503 (not 502): 502 in this
        // file means "we dialed upstream and it failed"; 503 means "we never dialed".
        Err(denied @ ForwardDenied::NotRegistered { .. }) => return sidecar_unavailable(&denied),
        // Registered but down. Wake-eligible ⇒ the pre-existing wake path, byte-identical.
        Err(denied @ ForwardDenied::NotRunning { .. }) => {
            if !wake_eligible {
                // Eager sidecar mid-download or crash-looping. It used to forward blind
                // into whatever holds its port; now it is a clean, named 503.
                return sidecar_unavailable(&denied);
            }
            None
        }
    };

    // The `_activity` guard pins the sidecar alive + feeds its idle clock while Core sets
    // up the forward, making idle-stop real for manifest sidecars. Keyed on
    // `wake_eligible` — NOT on which arm above we took — because a WARM lazy/idle-stop
    // sidecar (the `Ok` arm) needs the guard just as much as a cold one, or the idle
    // reaper can stop it mid-request. NOTE: `forward_to_sidecar` returns the response at
    // HEADER-arrival (its body streams), so this guard drops when headers land, not at
    // body-end. That is fine today because every SSE-serving sidecar
    // (dashboards/meetings/quests/monitors) is EAGER, so `wake_eligible` is false here and
    // the guard is `None`. A future lazy/idle-stop sidecar that serves a long-lived stream
    // would need this guard moved INTO the response `Body` so the idle reaper cannot kill
    // it mid-stream.
    let _activity = if wake_eligible {
        if target.is_none() {
            match state
                .manager
                .wake_and_await_healthy(&sidecar_name, WAKE_WARMUP_TIMEOUT)
                .await
            {
                Ok(woke) => {
                    if woke {
                        // Cold-start edge: register any `onRoute`-gated Runnables.
                        fire_lazy_activation(state, ACTIVATION_ON_ROUTE);
                    }
                }
                Err(e) => return wake_failed_response("ext proxy", &sidecar_name, &e, false),
            }
            // Re-resolve rather than trusting the wake's return: a wake that reports
            // success but leaves the process down must 503, never fall back to a blind
            // forward at the declared port.
            target = match state.manager.forward_target(&sidecar_name) {
                Ok(t) => Some(t),
                Err(denied) => return sidecar_unavailable(&denied),
            };
        }
        Some(state.manager.enter_request(&sidecar_name))
    } else {
        None
    };

    let Some(target) = target else {
        // Unreachable: every arm above either set `target` or returned. Belt-and-braces
        // so a future edit that adds an arm fails closed rather than dialing blind.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "sidecar unavailable, retry shortly",
        )
            .into_response();
    };

    let caller_rate_subject = forward_caller_rate_subject
        .then(|| rate_subject_for(plugin_id, caller.as_ref(), request_client_ip(&req)));
    let (parts, body) = req.into_parts();
    let body_bytes = match axum::body::to_bytes(body, max_body).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "ext proxy: request body too large",
            )
                .into_response();
        }
    };

    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let upstream_path = upstream_path_for(&mount, sub_path);

    let mut response = forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &upstream_path,
        query: &query,
        method: parts.method,
        src_headers: &parts.headers,
        body: body_bytes.to_vec(),
        hop_plugin_id: plugin_id,
        forward_payment_authorization: auth == RouteAuth::Public,
        forward_cookie_names: &forward_cookie_names,
        forward_caller_email,
        caller: caller.as_ref(),
        caller_resource_ids: caller_resource_ids.as_deref(),
        caller_rate_subject: caller_rate_subject.as_deref(),
        caller_agent_id: caller_agent_id.as_deref(),
        caller_agent_egress_allowlist: caller_agent_egress_allowlist.as_deref(),
        caller_agent_restricted,
        event_delivery: None,
        trusted_first_party,
    })
    .await;
    if web_facts.is_some() {
        mark_web_delegation_admitted(&mut response);
    }
    response
}
