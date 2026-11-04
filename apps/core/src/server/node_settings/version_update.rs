//! Version + update handlers (unified update service).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Version + update handlers (unified update service) ─────────────────────────

/// `GET /api/version` — the installed Ryu version + per-component builds.
#[utoipa::path(
    get,
    path = "/api/version",
    tag = "Health",
    summary = "Installed version and per-component builds",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_version() -> Json<crate::update::VersionInfo> {
    // The Gateway is the one component Core can actually observe — its version is
    // cached by the readiness probe, so this stays a pure read. Before this, every
    // component was stamped with Core's own version and a stale Gateway reported
    // itself as current.
    Json(crate::update::version_info_with(
        crate::sidecar::gateway::observed_gateway_version().as_deref(),
    ))
}

/// Query for `GET /api/update/check`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct UpdateCheckQuery {
    /// Release channel to check (`stable` / `beta` / `nightly` / `canary`).
    ///
    /// Omitted means "the channel this build is already on", derived from the
    /// running version itself — so a nightly Core checks nightly with no stored
    /// preference. The desktop passes its user-chosen channel explicitly so the
    /// channel picker can move a user between channels.
    pub(in crate::server) channel: Option<String>,
    /// RFC-3339 instant limiting the verdict to releases published at or before
    /// it — the caller's lifetime updates window. Omitted (the normal case, and
    /// every non-lifetime caller) means unclamped, byte-identical to the
    /// historical behaviour.
    ///
    /// ADVISORY ONLY. This route is on the UNAUTHENTICATED public router, so the
    /// value is caller-supplied and trivially omitted. Core declines to OFFER a
    /// build; it cannot prevent one. The perpetual desktop licence is an honour
    /// system by design.
    ///
    /// PRIVACY NOTE: this is a per-user, purchase-derived timestamp travelling in
    /// a URL query string. Core has no TraceLayer so it does not access-log URIs,
    /// but a node reached over the network sits behind a proxy that does.
    pub(in crate::server) updates_until: Option<String>,
}

/// The 200 body [`update_check`] answers with when the check itself failed.
///
/// A SECOND, hand-built copy of the [`crate::update::UpdateCheck`] wire shape —
/// the `error` key exists only here, so the struct cannot be reused — which makes
/// it the one place the two definitions can silently drift. It is a named
/// function purely so `update_check_fail_open_matches_the_verdict_shape` can hold
/// the two key sets against each other.
///
/// `restricted_by_cutoff` and `cutoff_unresolved` are deliberately FALSE: this
/// arm means "GitHub is unreachable", and a client must never read a network
/// failure as an expired updates window.
pub(in crate::server) fn update_check_fail_open_body(
    current: &str,
    channel: &str,
    error: &str,
) -> serde_json::Value {
    json!({
        "current": current,
        "latest": current,
        "channel": channel,
        "update_available": false,
        "notes": serde_json::Value::Null,
        "html_url": serde_json::Value::Null,
        "asset": serde_json::Value::Null,
        "tag": serde_json::Value::Null,
        "published_at": serde_json::Value::Null,
        "latest_unrestricted": current,
        "restricted_by_cutoff": false,
        "cutoff_waived_for_security": false,
        "cutoff_unresolved": false,
        "error": error,
    })
}

/// `GET /api/update/check` — compares the installed version against the latest
/// release ON ITS CHANNEL. Fails open: a network/API error returns 200 with
/// `update_available: false` so a client never blocks launch on a flaky check.
#[utoipa::path(
    get,
    path = "/api/update/check",
    tag = "Health",
    summary = "Compare installed version against the latest release on its channel",
    params(
        ("channel" = Option<String>, Query, description = "stable | beta | nightly | canary"),
        (
            "updates_until" = Option<String>,
            Query,
            description = "RFC-3339 cutoff; clamp to releases published at or before it (lifetime updates window)"
        )
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_check(
    State(state): State<ServerState>,
    Query(query): Query<UpdateCheckQuery>,
) -> axum::response::Response {
    let requested = query
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let requested_cutoff = query
        .updates_until
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    match crate::update::check_for_update_with(
        &state.client,
        crate::update::UpdateCheckOptions {
            channel: requested,
            updates_until: requested_cutoff,
        },
    )
    .await
    {
        Ok(verdict) => (StatusCode::OK, Json(json!(verdict))).into_response(),
        Err(e) => {
            tracing::warn!("update check failed (treating as up-to-date): {e}");
            let current = crate::update::current_version();
            let channel = requested
                .map(str::to_string)
                .unwrap_or_else(|| crate::update::channel_of(&current));
            (
                StatusCode::OK,
                Json(update_check_fail_open_body(
                    &current,
                    &channel,
                    &e.to_string(),
                )),
            )
                .into_response()
        }
    }
}

/// `POST /api/update/schedule` — install this update at the node's next quiet
/// hour instead of now.
///
/// The asset is PINNED from the request body, not re-resolved when the window
/// arrives: installing "whatever is latest at 03:00" would put a version the
/// user never saw onto a machine they deliberately chose not to touch during
/// the day.
#[utoipa::path(
    post,
    path = "/api/update/schedule",
    tag = "Health",
    summary = "Defer an update to the node's next quiet hour",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn schedule_update(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<serde_json::Value>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::NODES_MANAGE,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "Node management permission is required for updates" })),
        )
            .into_response();
    }

    let asset: crate::update::ReleaseAsset =
        match serde_json::from_value(body.get("asset").cloned().unwrap_or(body.clone())) {
            Ok(a) => a,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("invalid asset: {e}") })),
                )
                    .into_response();
            }
        };
    let version = body
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    match crate::update::schedule::set_pending(asset, version) {
        Ok(pending) => (StatusCode::OK, Json(json!(pending))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/update/schedule` — the deferred update, if any.
///
/// Also reports the node's zone so a client can say WHEN without guessing: the
/// viewer's zone is usually not the node's, and "03:00" with no zone is exactly
/// the ambiguity deferring is supposed to remove.
#[utoipa::path(
    get,
    path = "/api/update/schedule",
    tag = "Health",
    summary = "The deferred update, if one is pending",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_update_schedule() -> axum::response::Response {
    let pending = crate::update::schedule::get_pending();
    (
        StatusCode::OK,
        Json(json!({
            "pending": pending,
            "timeZone": crate::update::schedule::local_timezone(),
        })),
    )
        .into_response()
}

/// `DELETE /api/update/schedule` — forget the deferred update.
#[utoipa::path(
    delete,
    path = "/api/update/schedule",
    tag = "Health",
    summary = "Cancel a deferred update",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn cancel_update_schedule(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::NODES_MANAGE,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "Node management permission is required for updates" })),
        )
            .into_response();
    }

    match crate::update::schedule::clear_pending() {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/update/apply` — download + install an update for the headless
/// binaries. Body is the [`crate::update::ReleaseAsset`] returned by the check.
#[utoipa::path(
    post,
    path = "/api/update/apply",
    tag = "Health",
    summary = "Download and apply an update (headless binaries)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_apply(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(asset): Json<crate::update::ReleaseAsset>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::NODES_MANAGE,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "Node management permission is required for updates" })),
        )
            .into_response();
    }

    match crate::update::apply::apply_update(&state.downloads, &asset).await {
        Ok(result) => (StatusCode::OK, Json(json!(result))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
