//! The forward hop to a sidecar.

use super::*;

/// The refusal every "I never dialed" path in this file returns: **503**, naming the
/// sidecar key, the port and the reason.
///
/// The 502/503 split is the file's discriminator and is load-bearing for whoever reads
/// the log: 502 (in [`forward_to_sidecar`]) means Core dialed a sidecar it legitimately
/// owns and the hop failed; 503 means Core refused to dial at all because it does not own
/// that port. Naming the port is deliberate — the apps-store manifests publish them
/// already, so there is nothing to redact, and without it the operator cannot tell which
/// port to free. The durable half of the diagnosis (why registration failed, visible even
/// with no request in flight) rides `/api/sidecar/status` as `failure_reason`.
pub(super) fn sidecar_unavailable(denied: &ForwardDenied) -> Response {
    let name = denied.name();
    let reason = denied.reason();
    tracing::warn!(sidecar = %name, port = ?denied.port(), "ext proxy refused to forward: {reason}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "sidecar unavailable",
            "sidecar": name,
            "port": denied.port(),
            "reason": reason,
        })),
    )
        .into_response()
}

/// Inputs to [`forward_to_sidecar`]. Grouped in a struct so the shared forwarder is
/// not an 8-argument function (both the inbound ext-proxy and the capability broker
/// call it).
pub(super) struct ForwardArgs<'a> {
    /// Proof that the manager registered this sidecar, still holds its port claim, and
    /// the owning process is alive — carrying the port to dial. NOT a bare `u16` on
    /// purpose: the only way to build one is [`crate::sidecar::SidecarManager::forward_target`]
    /// (outside `#[cfg(test)]`), so no caller can forward to a manifest-derived port that
    /// some *other* process on the host happens to be squatting on. See [`ForwardTarget`].
    pub(super) target: ForwardTarget,
    /// The full upstream path on the sidecar (mount + sub-path, no query).
    pub(super) upstream_path: &'a str,
    /// The query string including the leading `?`, or empty.
    pub(super) query: &'a str,
    /// The forwarded HTTP method.
    pub(super) method: reqwest::Method,
    /// The caller's headers (hop-by-hop stripped, bearer re-stamped).
    pub(super) src_headers: &'a HeaderMap,
    /// The request body to forward verbatim.
    pub(super) body: Vec<u8>,
    /// The plugin id whose minted [`ext_token`] is stamped as the upstream bearer —
    /// for the inbound proxy this is the target plugin; for the broker it is the
    /// PROVIDER (so the consumer never sees the provider's token).
    pub(super) hop_plugin_id: &'a str,
    /// Whether a caller-supplied `Authorization: Payment` credential may cross this
    /// hop in the reserved internal header. Enabled only for manifest-public routes.
    pub(super) forward_payment_authorization: bool,
    /// App-owned browser cookie names explicitly declared by the manifest. Core
    /// forwards only these names; all other cookies remain hop-local.
    pub(super) forward_cookie_names: &'a [String],
    /// Whether the manifest opted this sidecar into the verified caller email
    /// ([`HttpProxySpec::forward_caller_email`]). Only an address the token marks
    /// `email_verified` is stamped; caller-supplied copies of the header are
    /// stripped for every sidecar regardless.
    pub(super) forward_caller_email: bool,
    /// Verified human identity, if Core resolved one. Caller-controlled copies
    /// of the corresponding headers are stripped before this is stamped.
    pub(super) caller: Option<&'a crate::identity_verify::VerifiedCaller>,
    /// Current ids in the manifest-requested resource scope. This value is
    /// derived by Core after authenticating the caller and replaces any inbound
    /// header with the same name.
    pub(super) caller_resource_ids: Option<&'a str>,
    /// Pseudonymous per-client rate subject ([`rate_subject_for`]), for a
    /// sidecar that opted in. Replaces any inbound header with the same name.
    pub(super) caller_rate_subject: Option<&'a str>,
    /// Core-verified calling agent (see [`verified_agent_lane`]). Caller-controlled
    /// lane and grant headers are stripped before this value and its agent grant
    /// are stamped.
    pub(super) caller_agent_id: Option<&'a str>,
    /// Whether `caller_agent_id`'s account access is restricted (or could not
    /// be read). Only then does the forward open the agent-request context in
    /// which the app's grant-less `providers.call`s are refused.
    pub(super) caller_agent_restricted: bool,
    /// The delivery id of a Core event delivery, stamped as [`HDR_EVENT_DELIVERY`]
    /// (any caller-supplied copy is stripped first). `None` on every other hop.
    pub(super) event_delivery: Option<&'a str>,
}

/// Reuse connection pools across proxy hops; credentials stay on each request.
pub(super) fn proxy_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(PROXY_CONNECT_TIMEOUT)
            .pool_max_idle_per_host(8)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Forward one buffered request to a sidecar on loopback, re-stamping the hop
/// plugin's minted token, and translate the upstream response back. The single
/// place the Core→sidecar hop is performed — shared by [`ext_proxy`] and the
/// capability broker so their auth/token/hop-header handling can never drift.
pub(super) async fn forward_to_sidecar(args: ForwardArgs<'_>) -> Response {
    let ForwardArgs {
        target,
        upstream_path,
        query,
        method,
        src_headers,
        body,
        hop_plugin_id,
        forward_payment_authorization,
        forward_cookie_names,
        forward_caller_email,
        caller,
        caller_resource_ids,
        caller_rate_subject,
        caller_agent_id,
        caller_agent_restricted,
        event_delivery,
    } = args;

    let hop_token = ext_token(node_token().as_deref(), hop_plugin_id);
    let port = target.port();
    let target = format!("http://127.0.0.1:{port}{upstream_path}{query}");

    // Connect-timeout only — NO total-request timeout: the response body may be a
    // long-lived SSE stream that never completes (see [`PROXY_CONNECT_TIMEOUT`]).
    let client = proxy_http_client();
    let mut headers = reqwest::header::HeaderMap::new();
    let payment_authorization =
        forwarded_payment_authorization(src_headers, forward_payment_authorization);
    copy_headers(src_headers, &mut headers, forward_cookie_names);
    if let Some(proof) = crate::sidecar::deferred_authorization::principal_proof(
        hop_plugin_id,
        caller,
        src_headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer ")),
    ) {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&proof) {
            headers.insert(
                crate::sidecar::deferred_authorization::PRINCIPAL_HEADER,
                value,
            );
        }
    }
    if let Some(caller) = caller {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&caller.user_id) {
            headers.insert(HDR_CALLER_USER_ID, value);
        }
        if let Some(org_id) = caller.org_id.as_deref() {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(org_id) {
                headers.insert(HDR_CALLER_ORG_ID, value);
            }
        }
        // An unverified address is the identity provider's claim, not proof of
        // mailbox ownership, so it never reaches a sidecar that grants access by
        // email. No header is safer than an unverified one.
        if let Some(email) = caller.verified_email().filter(|_| forward_caller_email) {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(email) {
                headers.insert(HDR_CALLER_EMAIL, value);
            }
        }
    }
    if let Some(resource_ids) = caller_resource_ids {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(resource_ids) {
            headers.insert(HDR_CALLER_RESOURCE_IDS, value);
        } else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if let Some(subject) = caller_rate_subject {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(subject) {
            headers.insert(HDR_CALLER_RATE_SUBJECT, value);
        }
    }
    // While the app serves a restricted agent's request, its `providers.call`s
    // must carry that agent's grant; one without it is refused rather than run
    // with the user's accounts. Held until the response body ends. An
    // unrestricted agent may use every account a grant-less call uses, so its
    // requests do not hold up the app's other work.
    let agent_context = caller_agent_id
        .filter(|_| caller_agent_restricted)
        .map(|_| crate::sidecar::deferred_authorization::enter_agent_request(hop_plugin_id));
    if let Some(agent_id) = caller_agent_id {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(agent_id) {
            headers.insert(HDR_CALLER_AGENT_ID, value);
        }
        // The app hands this back on `providers.call` (also for work it defers),
        // so Core can apply the agent's account access there.
        if let Some(value) =
            crate::sidecar::deferred_authorization::agent_grant(hop_plugin_id, agent_id)
                .and_then(|grant| reqwest::header::HeaderValue::from_str(&grant).ok())
        {
            headers.insert(
                crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
                value,
            );
        }
    }
    if let Some(delivery_id) = event_delivery {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(delivery_id) {
            headers.insert(HDR_EVENT_DELIVERY, value);
        }
    }
    if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {hop_token}")) {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    if let Some(value) = payment_authorization {
        headers.insert(HDR_FORWARDED_AUTHORIZATION, value);
    }

    let upstream = client
        .request(method, &target)
        .headers(headers)
        .body(body)
        .send()
        .await;

    let resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            // A dead/absent sidecar 502s on ITS OWN route only — Core is never blocked.
            tracing::warn!("sidecar for '{hop_plugin_id}' unreachable at {target}: {e}");
            return (StatusCode::BAD_GATEWAY, "sidecar unreachable").into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = HeaderMap::new();
    for (name, value) in resp.headers().iter() {
        if is_hop_by_hop(name.as_str())
            || name
                .as_str()
                .eq_ignore_ascii_case(HDR_FORWARDED_AUTHORIZATION)
        {
            continue;
        }
        // All apps share Core's origin: only the hop's declared cookies may be set.
        if name == reqwest::header::SET_COOKIE
            && !super::response_cookies::set_cookie_allowed(value.as_bytes(), forward_cookie_names)
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            axum::http::HeaderName::from_bytes(name.as_str().as_bytes()),
            axum::http::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            out.append(n, v);
        }
    }
    // Stream the upstream body straight through rather than buffering it. An SSE
    // endpoint's body never ends, so the old `resp.bytes().await` held back ALL response
    // headers until the whole body arrived — i.e. forever — which is why the SSE feeds
    // (dashboards `/events`, meetings `/stream`, quests/monitors events) hung with no
    // response headers. `bytes_stream()` → `Body::from_stream` emits status + headers
    // immediately and pipes each chunk as it lands. The response is streamed UNBOUNDED
    // (matching the old unbounded `resp.bytes()` — there was never a response-size cap to
    // preserve); only the REQUEST body stays capped (`to_bytes(body, max_body)`).
    // content-length + transfer-encoding are stripped as hop-by-hop above, so hyper
    // re-frames the outgoing stream itself.
    let body = match agent_context {
        Some(context) => {
            use futures_util::StreamExt as _;
            Body::from_stream(resp.bytes_stream().map(move |chunk| {
                let _held_until_the_body_ends = &context;
                chunk
            }))
        }
        None => Body::from_stream(resp.bytes_stream()),
    };
    (status, out, body).into_response()
}

// ── WebSocket tunnel (/api/ext/ws/*) ──────────────────────────────────────────
//
// The HTTP ext-proxy (`reqwest`) cannot carry a WebSocket upgrade, so an interactive
// sidecar stream — the desktop's live noVNC remote-desktop feed — needs its own lane.
// This is that lane: it shares the SAME route-allowlist + auth model as the HTTP
// proxy (a sidecar declares a `ws` route the same way it declares HTTP ones), then
// bridges the caller's socket to the sidecar's loopback WS endpoint byte-for-byte.
//
// Transport rationale: noVNC speaks RFB over WebSocket, and the remote node (managed
// cloud / self-hosted) exposes only Core's port, so the stream MUST ride through Core
// rather than the sidecar's loopback port. Bridging WS→WS at Core keeps every app
// (the `@ryu/desktop` sidecar) a self-contained satellite: Core is a dumb pipe that
// knows nothing about VNC, exactly like the HTTP lane.
