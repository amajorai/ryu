//! Version/update, preferences, safe mode, capability bindings, email and alert delivery, model launch config and downloads: `models_context_window` through `navigation_stream`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/models/context-window?model=<id>` — best-effort context window for
/// a model string via models.dev (cached in Core). Fills the denominator gap for
/// ACP / cloud models that don't have a local launch `ctx_size`. Fail-open:
/// returns `{ "contextLength": null }` when unknown or unreachable.
#[utoipa::path(
    get,
    path = "/api/models/context-window",
    tag = "Models",
    summary = "Resolve a model's context window (models.dev)",
    params(("model" = String, Query, description = "Model id (bare or provider/id)")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_context_window(
    axum::extract::Query(q): axum::extract::Query<ModelsContextWindowQuery>,
) -> Json<serde_json::Value> {
    let context_length = crate::model_catalog::models_dev::context_window(&q.model).await;
    Json(json!({ "contextLength": context_length }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ModelsContextWindowQuery {
    pub(in crate::server) model: String,
}

/// `GET /api/models/insight?model=<id>&provider=<optional>` — unified hover-card
/// metadata (cost, context, modalities, AA benchmarks, 1–5 bar scores). Cascade:
/// models.dev → OpenRouter → Artificial Analysis. Fail-open: `{ "insight": null }`.
#[utoipa::path(
    get,
    path = "/api/models/insight",
    tag = "Models",
    summary = "Resolve model hover-card insight (models.dev / OpenRouter / AA)",
    params(
        ("model" = String, Query, description = "Model id (bare or provider/id)"),
        ("provider" = Option<String>, Query, description = "Optional provider id to disambiguate")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_insight(
    axum::extract::Query(q): axum::extract::Query<ModelsInsightQuery>,
) -> Json<serde_json::Value> {
    let provider = q
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let insight = crate::model_catalog::insight::insight_for(&q.model, provider).await;
    Json(json!({ "insight": insight }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ModelsInsightQuery {
    pub(in crate::server) model: String,
    #[serde(default)]
    pub(in crate::server) provider: Option<String>,
}

/// SSE stream of preference changes. The island companion subscribes to this so
/// theme edits in the desktop propagate live without polling.
#[utoipa::path(
    get,
    path = "/api/preferences/stream",
    tag = "Preferences",
    summary = "Preferences SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn preferences_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.preferences.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => {
                    // Dropped some events under backpressure; keep streaming.
                    continue;
                }
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /api/events/notifications/stream` — SSE: desktop notifications pushed by
/// built-in agent actions (e.g. `notify.desktop`). The desktop subscribes and
/// renders each as a native OS notification (#456).
#[utoipa::path(
    get,
    path = "/api/events/notifications/stream",
    tag = "Events",
    summary = "Desktop notifications SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn notifications_stream() -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = crate::events::subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    // This legacy stream is unauthenticated (no viewer identity), so
                    // it carries only BROADCAST notifications. A user-targeted ping
                    // (`target_user_id` set) must not fan out here — it would toast
                    // on every connected desktop on a shared team node. Those are
                    // delivered exclusively via the per-user, filtered
                    // `/api/notifications/stream`.
                    if ev.target_user_id.is_some() {
                        continue;
                    }
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /api/events/navigation/stream` — SSE: navigation requests emitted by a
/// sandboxed app via the `host.navigate` bridge primitive. The connected shell
/// subscribes and drives its router to the requested target.
pub(in crate::server) fn navigation_visible_to_caller(
    request: &crate::events::NavigationRequest,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    node_bound: bool,
) -> bool {
    match request.target_user_id.as_deref() {
        Some(target_user_id) => caller
            .as_ref()
            .is_some_and(|candidate| candidate.user_id == target_user_id),
        // An unaddressed navigation is safe only on a personal node. A shared
        // node must never broadcast one user's shell action to every teammate.
        None => !node_bound,
    }
}

#[utoipa::path(
    get,
    path = "/api/events/navigation/stream",
    tag = "Events",
    summary = "App navigation-request SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn navigation_stream(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let node_bound = crate::sidecar::control_plane::registered_org().is_some();
    let stream = futures_util::stream::unfold(
        (crate::events::subscribe_navigation(), caller, node_bound),
        |(mut rx, caller, node_bound)| async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if !navigation_visible_to_caller(&ev, &caller, node_bound) {
                            continue;
                        }
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        return Some((Ok(Event::default().data(data)), (rx, caller, node_bound)));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}
