//! Subscription OAuth login (ChatGPT / Claude / Copilot).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Subscription OAuth login (ChatGPT / Claude / Copilot) ────────────────────
//
// The provider cards' "Login" used to run the agent-advertised ACP method, which
// for pi-acp is a hint that logs nobody in — and the app had no channel to carry
// an authorization URL, device code, or prompt back to the user, so no
// interactive login could be completed at all. These four routes are that
// channel: start a flow, stream its events, answer its prompts, cancel it.

/// `POST /api/pi-config/providers/:id/login` — begin a subscription OAuth login
/// for a provider ("claude-pro-max" / "openai-codex" / "github-copilot").
/// Returns the session id to stream from. The credential lands in the managed
/// Pi's `auth.json`, which is what flips the card to Connected.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers/{id}/login",
    tag = "Agents",
    summary = "Start a subscription OAuth login",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn start_pi_provider_login(
    auth: Option<Extension<ResolvedAuthorization>>,
    Path(provider_id): Path<String>,
    Query(options): Query<PiLoginOptions>,
) -> axum::response::Response {
    if let Some(refusal) =
        chatgpt_plan_login_refusal(&provider_id, auth.as_ref().map(|Extension(auth)| auth)).await
    {
        return refusal;
    }
    match crate::pi_config::oauth_login::start_with_options(
        &provider_id,
        options.account_id.as_deref(),
        options.enable_plan_use,
    )
    .await
    {
        Ok(session_id) => Json(json!({ "sessionId": session_id })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// The refusal for a Sign in with ChatGPT login on a Ryu-hosted node, or `None`
/// when the login may start. Sign in with ChatGPT plan usage is self-serve for
/// open-source and locally hosted apps. A Ryu-hosted node is a hosted app, which
/// OpenAI must approve first (docs/subscription-cloud-sessions.md §2.2a), so it
/// stays behind its own flag. Every other provider is not gated here.
pub(in crate::server) async fn chatgpt_plan_login_refusal(
    provider_id: &str,
    auth: Option<&ResolvedAuthorization>,
) -> Option<axum::response::Response> {
    if provider_id != crate::pi_config::CHATGPT_PLAN_PROVIDER_ID {
        return None;
    }
    let allowed = match auth {
        Some(auth) => crate::server::subscription_cloud::openai_plan_allowed(auth).await,
        None => !crate::sidecar::control_plane::is_managed_node(),
    };
    if allowed {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "Using a ChatGPT plan on a Ryu-hosted node is not available yet. Sign in with ChatGPT on a node you run yourself.",
                "code": "chatgpt_plan_hosted_unavailable"
            })),
        )
            .into_response(),
    )
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct PiLoginOptions {
    pub(in crate::server) account_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) enable_plan_use: bool,
}

/// `GET /api/pi-config/login/:session/events` — SSE for one login flow:
/// `auth_url`, `device_code`, `prompt`, `progress`, and finally `success` or
/// `error`. Events already emitted are replayed first, because the client
/// subscribes after `start` returns — by which point the flow has usually
/// already produced the URL or its first prompt.
#[utoipa::path(
    get,
    path = "/api/pi-config/login/{session}/events",
    tag = "Agents",
    summary = "Stream a subscription login's events",
    params(("session" = String, Path, description = "Login session id")),
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn pi_provider_login_events(
    Path(session_id): Path<String>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let session = crate::pi_config::oauth_login::get(&session_id);
    let replay = session.as_ref().map(|s| s.replay()).unwrap_or_else(|| {
        vec![json!({ "type": "error", "message": "this login is no longer active" })]
    });
    let live = session.as_ref().map(|s| s.subscribe());

    let stream = futures_util::stream::unfold(
        (replay.into_iter(), live),
        |(mut replay, mut live)| async move {
            if let Some(event) = replay.next() {
                let data = serde_json::to_string(&event).unwrap_or_default();
                return Some((Ok(Event::default().data(data)), (replay, live)));
            }
            let rx = live.as_mut()?;
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let data = serde_json::to_string(&event).unwrap_or_default();
                        return Some((Ok(Event::default().data(data)), (replay, live)));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Body for `POST /api/pi-config/login/:session/answer`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct PiLoginAnswer {
    /// The `id` from the `prompt` event being answered.
    pub(in crate::server) prompt_id: String,
    /// For a `select` prompt this must be the chosen option's **id** — the flow
    /// matches on the id, not on a label or an index.
    pub(in crate::server) value: String,
}

/// `POST /api/pi-config/login/:session/answer` — answer a prompt the flow is
/// waiting on (a pasted authorization code, an enterprise domain, a choice).
#[utoipa::path(
    post,
    path = "/api/pi-config/login/{session}/answer",
    tag = "Agents",
    summary = "Answer a subscription login prompt",
    params(("session" = String, Path, description = "Login session id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn answer_pi_provider_login(
    Path(session_id): Path<String>,
    Json(body): Json<PiLoginAnswer>,
) -> axum::response::Response {
    let Some(session) = crate::pi_config::oauth_login::get(&session_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "this login is no longer active" })),
        )
            .into_response();
    };
    match session.answer(&body.prompt_id, &body.value).await {
        Ok(()) => Json(json!({ "accepted": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "accepted": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/pi-config/login/:session/cancel` — abandon a login and kill its
/// flow. Not optional politeness: `openai-codex` listens on a fixed
/// `localhost:1455` that its registered redirect URI depends on, so a flow left
/// running would make every later ChatGPT login fail to bind.
#[utoipa::path(
    post,
    path = "/api/pi-config/login/{session}/cancel",
    tag = "Agents",
    summary = "Cancel a subscription login",
    params(("session" = String, Path, description = "Login session id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn cancel_pi_provider_login(
    Path(session_id): Path<String>,
) -> axum::response::Response {
    let cancelled = crate::pi_config::oauth_login::cancel(&session_id);
    Json(json!({ "cancelled": cancelled })).into_response()
}

/// The stable well-known id for the lean Ryu agent (Pi + Gateway). Using a
/// constant rather than a hard-coded string literal ensures the id is consistent
/// across create, find, and update paths in this module.
pub(in crate::server) const RYU_AGENT_ID: &str = "ryu";
