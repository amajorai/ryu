//! HTTP routes of session Boxes. Every route is owner-scoped: a Box another
//! caller holds in the same conversation answers 403, and a conversation with
//! no Box answers 404.
//!
//! - `GET  /api/session-boxes/{conversationId}`: status, cost and caps.
//! - `POST /api/session-boxes/{conversationId}/screen`: a screen grant.
//! - `GET  /api/session-boxes/{conversationId}/screen/ws`: the self-hosted
//!   relay (public router, Core ticket; 409 in hosted mode).
//! - `POST /api/session-boxes/{conversationId}/stop`, `/resume`, `/extend`.
//! - `POST /api/session-boxes/{conversationId}/cost-notice`: the caller's
//!   one-time acknowledgement of the computer-use Box cost (`notice`).
//! - `GET|POST /api/session-boxes/cost-notice`: the same acknowledgement read
//!   and given ahead of any conversation (desktop settings). The static
//!   segment takes precedence over `{conversationId}`.
//! - `ANY  /api/session-boxes/inference/v1/*rest`: the Box inference relay
//!   (public router, `gwb1` only).
//!
//! `{conversationId}` may name a sub-agent child as `<conversationId>#sub:<n>`
//! (percent-encoded).
use super::{
    api_error, box_api_error, box_credential, caps, cloud_tasks, environments, existing_slot,
    held_by_another_owner, inference, owner_of, park, relay, relay_viewers, resume_entry, rfc3339,
    status, touch, unix_now, ApiError, Phase, ResolvedAuthorization, SessionBoxKey,
    SessionBoxStatus, MAX_RUN_AHEAD_SECONDS,
};
use axum::{
    extract::{ws::WebSocketUpgrade, Path, Query},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use ryu_sandbox::{
    box_session::BoxSessionClient,
    box_types::{DesktopTokenRequest, ParkReason},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// How long a relay grant's path stays usable before the client must ask for
/// a ticket (the ticket's own lifetime).
const RELAY_GRANT_SECONDS: u64 = 60;
const DEFAULT_EXTEND_SECONDS: u64 = 60 * 60;
const MIN_EXTEND_SECONDS: u64 = 60;
const MAX_EXTEND_SECONDS: u64 = 4 * 60 * 60;
const MAX_ORIGIN_CHARS: usize = 256;

/// `POST …/screen`.
#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
#[schema(as = SessionBoxScreenRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScreenRequest {
    /// Watch without sending input. Defaults to false.
    #[serde(default)]
    view_only: bool,
    /// The viewer's origin when the request carries no `Origin` header (a
    /// native client). It must be in the Box service's stream allowlist.
    #[serde(default)]
    origin: Option<String>,
}

/// How a viewer reaches a Box screen: `direct` (dial `url` with `protocols`)
/// or `relay` (take a `session-box` Core ticket for `path`).
#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[schema(as = SessionBoxScreenGrant)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScreenGrant {
    /// `direct` or `relay`.
    mode: String,
    /// Absolute `wss://` stream URL (direct mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    /// WebSocket subprotocols to dial with; the single-use token travels here.
    protocols: Vec<String>,
    /// Core relay path (relay mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    expires_at: String,
}

/// `POST …/extend`.
#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
#[schema(as = SessionBoxExtendRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExtendRequest {
    /// Seconds to add, 60-14400. Defaults to 3600.
    #[serde(default)]
    seconds: Option<u64>,
}

/// `POST …/cost-notice`.
#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
#[schema(as = SessionBoxCostNoticeRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CostNoticeRequest {
    /// The hourly rate the notice showed, micro-USD. It must still be the
    /// Gateway's live rate.
    #[serde(default)]
    rate_per_hour_micro_usd: Option<u64>,
}

/// `POST …/cost-notice` answer.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[schema(as = SessionBoxCostNoticeAcknowledged)]
#[serde(rename_all = "camelCase")]
pub(super) struct CostNoticeAcknowledged {
    acknowledged: bool,
    acknowledged_at: Option<String>,
    rate_per_hour_micro_usd: u64,
}

/// `POST …/extend` answer.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[schema(as = SessionBoxExtended)]
#[serde(rename_all = "camelCase")]
pub(super) struct Extended {
    /// When the Box is now parked for its lifetime.
    expires_at: Option<String>,
}

/// Error responses; a capacity refusal also sends `Retry-After`.
fn respond(error: ApiError) -> Response {
    let retry_after = error.1 .0["error"]["retryAfter"].as_u64();
    let mut response = error.into_response();
    if let Some(seconds) = retry_after {
        if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert("retry-after", value);
        }
    }
    response
}

fn bad_request(message: &str) -> ApiError {
    api_error(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn forbidden() -> ApiError {
    api_error(
        StatusCode::FORBIDDEN,
        "session_box_forbidden",
        "This session Box belongs to a different caller.",
    )
}

fn require_gateway_route(auth: &ResolvedAuthorization) -> Result<(), ApiError> {
    use crate::authorization::{AuthorizationDecision, Capability, RoutePolicy};
    let policy = RoutePolicy::requires([Capability::GatewayRoute]);
    if matches!(
        auth.context.authorize(&policy, &auth.bindings, unix_now()),
        AuthorizationDecision::Allow
    ) {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::FORBIDDEN,
            "session_box_forbidden",
            "Session Boxes require current Gateway authority.",
        ))
    }
}

/// The caller's key for a route segment.
fn key_for(auth: &ResolvedAuthorization, segment: &str) -> Result<SessionBoxKey, ApiError> {
    require_gateway_route(auth)?;
    let owner = owner_of(auth)?;
    SessionBoxKey::parse(&owner, segment)
        .ok_or_else(|| bad_request("A valid conversation ID is required."))
}

/// 403 when another caller holds a Box in this conversation, else 404.
async fn absent(key: &SessionBoxKey) -> ApiError {
    if held_by_another_owner(&key.owner, &key.conversation_id).await {
        forbidden()
    } else {
        super::not_found()
    }
}

fn parse_json<T: serde::de::DeserializeOwned + Default>(body: &[u8]) -> Result<T, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(body).map_err(|_| bad_request("The request body is invalid."))
}

/// The Box a screen request is for: the cloud task Box, or the session Box
/// (resumed when parked, after admission).
async fn screen_target(
    auth: &ResolvedAuthorization,
    key: &SessionBoxKey,
) -> Result<super::BoxTarget, ApiError> {
    if key.child.is_none() {
        if let Some(target) = cloud_tasks::bound_box(&key.owner, &key.conversation_id).await {
            return Ok(target);
        }
    }
    let Some(slot) = existing_slot(key) else {
        return Err(absent(key).await);
    };
    let mut guard = slot.lock().await;
    let Some(entry) = guard.as_mut() else {
        return Err(absent(key).await);
    };
    if entry.phase != Phase::Live {
        caps::admit(auth, &key.owner, Some(key), entry.size).await?;
        resume_entry(entry).await?;
    }
    Ok(entry.target())
}

/// A viewer origin: `scheme://host[:port]`, nothing else.
fn valid_origin(origin: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    origin.len() <= MAX_ORIGIN_CHARS
        && matches!(url.scheme(), "http" | "https" | "tauri")
        && url.host_str().is_some()
        && url.path() == "/"
        && !origin.trim_end().ends_with('/')
        && url.query().is_none()
        && url.username().is_empty()
}

#[utoipa::path(get,path="/api/session-boxes/{conversation_id}",operation_id="get_session_box",tag="Session Boxes",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation, or `<conversation>#sub:<n>` for a sub-agent child")),description="Read the caller's session Box for a conversation: the Box (a cloud task Box when the conversation has one), its state (provisioning, ready, parked, stopped or error), placement, screen readiness and viewers, running time, cost so far and hourly rate from the Gateway's sandbox ticks, the low-credit warning level, why it last stopped, and its sub-agent child Boxes, plus the caller's running-Box cap. While a Box of the conversation waits for the caller's one-time acknowledgement of its hourly cost, `costNotice` names the size and the Gateway's live rate (and `box` may be null). Requires GatewayRoute and a personal identity.",responses((status=200,body=SessionBoxStatus),(status=400,description="Invalid conversation ID"),(status=403,description="session_box_forbidden: another caller's Box"),(status=404,description="session_box_not_found")))]
pub(super) async fn get_status(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(segment): Path<String>,
) -> Response {
    let key = match key_for(&auth, &segment) {
        Ok(key) => key,
        Err(error) => return respond(error),
    };
    caps::refresh(&auth, &key.owner).await;
    match status(&key.owner, &key.conversation_id).await {
        Some(found) => Json(found).into_response(),
        None => respond(absent(&key).await),
    }
}

#[utoipa::path(post,path="/api/session-boxes/{conversation_id}/screen",operation_id="session_box_screen",tag="Session Boxes",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation, or `<conversation>#sub:<n>`")),request_body=ScreenRequest,description="Grant one viewer the Box's screen. Direct mode (the Box service has a public ingress) returns an absolute wss URL and the WebSocket subprotocols carrying a single-use, 30-second token bound to the viewer's origin and identity; the Box bearer never leaves Core. Relay mode (self-hosted) returns the Core path to open with a one-use `session-box` WebSocket ticket. A parked Box is resumed first. Requires GatewayRoute, a personal identity and the Fresh cloud box rollout (a local owner without a cloud identity is gated only by the node's Box configuration).",responses((status=200,body=ScreenGrant),(status=400,description="Invalid body, conversation ID or origin"),(status=402,description="session_box_insufficient_credits"),(status=403,description="session_box_forbidden or cloud_environment_feature_unavailable"),(status=404,description="session_box_not_found"),(status=429,description="session_box_limit_reached"),(status=503,description="session_box_capacity (with Retry-After) or session_box_unavailable")))]
pub(super) async fn screen(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(segment): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    match screen_inner(&auth, &segment, &headers, &body).await {
        Ok(grant) => Json(grant).into_response(),
        Err(error) => respond(error),
    }
}

async fn screen_inner(
    auth: &ResolvedAuthorization,
    segment: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<ScreenGrant, ApiError> {
    let key = key_for(auth, segment)?;
    let request: ScreenRequest = parse_json(body)?;
    environments::require_box_backend_feature(auth).await?;
    let target = screen_target(auth, &key).await?;
    let credential = box_credential()
        .await
        .map_err(|_| super::unavailable("Ryu Box is not configured on this node."))?;
    touch(&key).await;
    let Some(public_base) = credential.public_base.clone() else {
        return Ok(ScreenGrant {
            mode: "relay".to_owned(),
            url: None,
            protocols: Vec::new(),
            path: Some(format!(
                "/api/session-boxes/{}/screen/ws",
                urlencoding::encode(&key.session_id())
            )),
            expires_at: rfc3339(unix_now() + RELAY_GRANT_SECONDS).unwrap_or_default(),
        });
    };
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or(request.origin)
        .filter(|origin| valid_origin(origin))
        .ok_or_else(|| bad_request("A viewer origin is required."))?;
    let url = relay::direct_url(&public_base, &target.box_id.0)
        .ok_or_else(|| super::unavailable("The Box service's public ingress is invalid."))?;
    let token = BoxSessionClient::from_credential(&credential)
        .mint_desktop_token(
            &target.box_id,
            &DesktopTokenRequest {
                origin,
                sub: key.owner.clone(),
                view_only: request.view_only,
            },
        )
        .await
        .map_err(|error| box_api_error(&error))?;
    Ok(ScreenGrant {
        mode: "direct".to_owned(),
        url: Some(url),
        protocols: token.protocols,
        path: None,
        expires_at: token.expires_at,
    })
}

/// [`screen`] without the HTTP layer, as JSON.
#[cfg(test)]
pub(super) async fn screen_grant_for_test(
    auth: &ResolvedAuthorization,
    segment: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, ApiError> {
    let grant = screen_inner(auth, segment, headers, body).await?;
    Ok(serde_json::to_value(grant).unwrap_or_default())
}

#[utoipa::path(post,path="/api/session-boxes/{conversation_id}/stop",operation_id="stop_session_box",tag="Session Boxes",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation, or `<conversation>#sub:<n>`")),description="Park the caller's session Box (and, for a conversation, its sub-agent Boxes): its state is saved and its compute released, with stop reason `user`. A cloud task Box is parked the same way and its task stops. The next heavy call resumes a session Box. Requires GatewayRoute and a personal identity; revoked rollout access does not prevent stopping.",responses((status=200,body=SessionBoxStatus),(status=403,description="session_box_forbidden"),(status=404,description="session_box_not_found"),(status=503,description="The Box service could not park it; retry")))]
pub(super) async fn stop(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(segment): Path<String>,
) -> Response {
    let key = match key_for(&auth, &segment) {
        Ok(key) => key,
        Err(error) => return respond(error),
    };
    let result = if key.child.is_none()
        && cloud_tasks::bound_box(&key.owner, &key.conversation_id)
            .await
            .is_some()
    {
        cloud_tasks::park_bound_box(&key.owner, &key.conversation_id, ParkReason::User).await
    } else if existing_slot(&key).is_some() {
        park(&key, ParkReason::User).await
    } else {
        Err(absent(&key).await)
    };
    if let Err(error) = result {
        return respond(error);
    }
    match status(&key.owner, &key.conversation_id).await {
        Some(found) => Json(found).into_response(),
        None => respond(absent(&key).await),
    }
}

#[utoipa::path(post,path="/api/session-boxes/{conversation_id}/resume",operation_id="resume_session_box",tag="Session Boxes",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation, or `<conversation>#sub:<n>`")),description="Resume the caller's parked session Box after admission (plan cap, credit pre-flight, Box service limits). Requires GatewayRoute, a personal identity and the Fresh cloud box rollout.",responses((status=200,body=SessionBoxStatus),(status=402,description="session_box_insufficient_credits"),(status=403,description="session_box_forbidden or cloud_environment_feature_unavailable"),(status=404,description="session_box_not_found"),(status=409,description="session_box_not_resumable: a cloud task Box"),(status=429,description="session_box_limit_reached"),(status=503,description="session_box_capacity (with Retry-After)")))]
pub(super) async fn resume(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(segment): Path<String>,
) -> Response {
    let key = match key_for(&auth, &segment) {
        Ok(key) => key,
        Err(error) => return respond(error),
    };
    if let Err(error) = environments::require_box_backend_feature(&auth).await {
        return respond(error);
    }
    let resumed = async {
        let Some(slot) = existing_slot(&key) else {
            if key.child.is_none()
                && cloud_tasks::bound_box(&key.owner, &key.conversation_id)
                    .await
                    .is_some()
            {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "session_box_not_resumable",
                    "A cloud task Box resumes with its task.",
                ));
            }
            return Err(absent(&key).await);
        };
        let mut guard = slot.lock().await;
        let Some(entry) = guard.as_mut() else {
            return Err(absent(&key).await);
        };
        if entry.phase != Phase::Live {
            caps::admit(&auth, &key.owner, Some(&key), entry.size).await?;
        }
        resume_entry(entry).await
    }
    .await;
    if let Err(error) = resumed {
        return respond(error);
    }
    match status(&key.owner, &key.conversation_id).await {
        Some(found) => Json(found).into_response(),
        None => respond(absent(&key).await),
    }
}

#[utoipa::path(post,path="/api/session-boxes/{conversation_id}/extend",operation_id="extend_session_box",tag="Session Boxes",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation, or `<conversation>#sub:<n>`")),request_body=ExtendRequest,description="Push back when the caller's live session Box is parked for its lifetime (4 hours from start or resume) by 60-14400 seconds, at most 24 hours ahead. Requires GatewayRoute, a personal identity and the Fresh cloud box rollout.",responses((status=200,body=Extended),(status=400,description="Invalid body"),(status=403,description="session_box_forbidden or cloud_environment_feature_unavailable"),(status=404,description="session_box_not_found"),(status=409,description="session_box_not_live")))]
pub(super) async fn extend(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(segment): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let extended = async {
        let key = key_for(&auth, &segment)?;
        let request: ExtendRequest = parse_json(&body)?;
        let seconds = request.seconds.unwrap_or(DEFAULT_EXTEND_SECONDS);
        if !(MIN_EXTEND_SECONDS..=MAX_EXTEND_SECONDS).contains(&seconds) {
            return Err(bad_request("Extend by 60-14400 seconds."));
        }
        environments::require_box_backend_feature(&auth).await?;
        let Some(slot) = existing_slot(&key) else {
            return Err(absent(&key).await);
        };
        let mut guard = slot.lock().await;
        let Some(entry) = guard.as_mut() else {
            return Err(absent(&key).await);
        };
        if entry.phase != Phase::Live {
            return Err(api_error(
                StatusCode::CONFLICT,
                "session_box_not_live",
                "Resume the Box before extending it.",
            ));
        }
        let now = unix_now();
        entry.run_until = (entry.run_until.max(now) + seconds).min(now + MAX_RUN_AHEAD_SECONDS);
        entry.last_activity = std::time::Instant::now();
        Ok(Extended {
            expires_at: rfc3339(entry.run_until),
        })
    }
    .await;
    match extended {
        Ok(extended) => Json(extended).into_response(),
        Err(error) => respond(error),
    }
}

#[utoipa::path(post,path="/api/session-boxes/{conversation_id}/cost-notice",operation_id="acknowledge_session_box_cost",tag="Session Boxes",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="The conversation whose notice was shown")),request_body=CostNoticeRequest,description="Acknowledge, once per caller, the hourly cost of the session Box that computer use, the browser and worker threads start. Until then the caller's first session Box call (after the plan cap and credit checks pass) is held while the conversation's status carries `costNotice` (`waiting` while a call is held); allowing it lets that call start the Box. A call not allowed within 90 s is refused with 428 session_box_cost_notice_required (its body names `size`, `ratePerHourMicroUsd` and `minimumSecondsPerStart`). The body echoes the rate the notice showed; it must equal the Gateway's live rate. Requires GatewayRoute and a personal identity.",responses((status=200,body=CostNoticeAcknowledged),(status=400,description="Invalid body or conversation ID"),(status=409,description="session_box_rate_changed: the body names the current rate"),(status=503,description="session_box_rate_unavailable or session_box_unavailable")))]
pub(super) async fn acknowledge_cost(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(segment): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let acknowledged = async {
        let key = key_for(&auth, &segment)?;
        record_acknowledgement(&key.owner, &body).await
    }
    .await;
    match acknowledged {
        Ok(acknowledged) => Json(acknowledged).into_response(),
        Err(error) => respond(error),
    }
}

/// Record `owner`'s acknowledgement of the rate a `CostNoticeRequest` names.
async fn record_acknowledgement(
    owner: &str,
    body: &[u8],
) -> Result<CostNoticeAcknowledged, ApiError> {
    let request: CostNoticeRequest = parse_json(body)?;
    let Some(shown) = request.rate_per_hour_micro_usd else {
        return Err(bad_request(
            "ratePerHourMicroUsd, the rate the notice showed, is required.",
        ));
    };
    let acknowledgement = super::notice::acknowledge(owner, shown).await?;
    Ok(CostNoticeAcknowledged {
        acknowledged: true,
        acknowledged_at: rfc3339(acknowledgement.acknowledged_at),
        rate_per_hour_micro_usd: acknowledgement.rate_per_hour_micro_usd,
    })
}

/// The caller's owner key, for the routes that name no conversation.
fn owner_for(auth: &ResolvedAuthorization) -> Result<String, ApiError> {
    require_gateway_route(auth)?;
    owner_of(auth)
}

#[utoipa::path(get,path="/api/session-boxes/cost-notice",operation_id="get_session_box_cost_notice",tag="Session Boxes",security(("bearerAuth"=[])),description="The caller's one-time computer-use cost acknowledgement, with the size, the Gateway's live hourly rate and the per-start minimum a session Box starts at. A settings screen uses it to allow the cost ahead of any conversation, which a routine's or channel bot's run needs because nobody is there to answer the notice. Requires GatewayRoute and a personal identity.",responses((status=200,body=super::notice::OwnerNotice),(status=403,description="Not a personal identity, or no GatewayRoute")))]
pub(super) async fn get_owner_cost_notice(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Response {
    match owner_for(&auth) {
        Ok(owner) => Json(super::notice::owner_notice(&owner).await).into_response(),
        Err(error) => respond(error),
    }
}

#[utoipa::path(post,path="/api/session-boxes/cost-notice",operation_id="acknowledge_session_box_cost_ahead",tag="Session Boxes",security(("bearerAuth"=[])),request_body=CostNoticeRequest,description="Acknowledge the computer-use session Box cost ahead of any conversation (the same acknowledgement as `POST /api/session-boxes/{conversation_id}/cost-notice`). Any call already held for it goes on. The body echoes the rate shown; it must equal the Gateway's live rate. Requires GatewayRoute and a personal identity.",responses((status=200,body=CostNoticeAcknowledged),(status=400,description="Invalid body"),(status=409,description="session_box_rate_changed: the body names the current rate"),(status=503,description="session_box_rate_unavailable or session_box_unavailable")))]
pub(super) async fn acknowledge_owner_cost(
    Extension(auth): Extension<ResolvedAuthorization>,
    body: axum::body::Bytes,
) -> Response {
    let acknowledged = async {
        let owner = owner_for(&auth)?;
        record_acknowledgement(&owner, &body).await
    }
    .await;
    match acknowledged {
        Ok(acknowledged) => Json(acknowledged).into_response(),
        Err(error) => respond(error),
    }
}

/// `GET /api/session-boxes/{conversationId}/screen/ws` (public router): the
/// self-hosted relay. The ticket's caller must own the session.
pub(super) async fn screen_ws(
    Path(segment): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if query.contains_key("token") || query.contains_key("jwt") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let expected_path = format!("/api/session-boxes/{segment}/screen/ws");
    let Some(ticket) = crate::server::ws_ticket::consume(
        query.get("ticket").map(String::as_str),
        crate::server::ws_ticket::WsTicketRoute::SessionBox,
        Some(&expected_path),
    ) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let owner = ticket.caller.as_ref().map_or_else(
        || "node-owner".to_owned(),
        |caller| format!("user:{}", caller.user_id),
    );
    let Some(key) = SessionBoxKey::parse(&owner, &segment) else {
        return respond(bad_request("A valid conversation ID is required."));
    };
    let Ok(credential) = box_credential().await else {
        return respond(super::unavailable(
            "Ryu Box is not configured on this node.",
        ));
    };
    if credential.public_base.is_some() {
        return respond(api_error(
            StatusCode::CONFLICT,
            "stream_direct_only",
            "This node's Box screens stream directly; request a direct screen grant.",
        ));
    }
    let target = match live_target(&key).await {
        Ok(target) => target,
        Err(error) => return respond(error),
    };
    let view_only = query
        .get("viewOnly")
        .is_some_and(|value| matches!(value.as_str(), "1" | "true"));
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| valid_origin(origin))
        .map_or_else(crate::sidecar::gateway::core_self_url, str::to_owned);
    let Some(url) = relay::upstream_url(&credential.base, &target.box_id.0) else {
        return respond(super::unavailable("The Box service URL is invalid."));
    };
    let token = match BoxSessionClient::from_credential(&credential)
        .mint_desktop_token(
            &target.box_id,
            &DesktopTokenRequest {
                origin: origin.clone(),
                sub: key.owner.clone(),
                view_only,
            },
        )
        .await
    {
        Ok(token) => token,
        Err(error) => return respond(box_api_error(&error)),
    };
    let upstream = match relay::dial(&url, &origin, &token.protocols).await {
        Ok(upstream) => upstream,
        Err(_) => {
            return respond(super::unavailable(
                "The Box screen could not be reached. Try again.",
            ))
        }
    };
    touch(&key).await;
    let box_id = target.box_id.0.clone();
    ws.protocols(["binary"])
        .on_upgrade(move |socket| async move {
            adjust_viewers(&box_id, true);
            let activity_key = key.clone();
            relay::bridge(socket, upstream, move || {
                let key = activity_key.clone();
                tokio::spawn(async move { touch(&key).await });
            })
            .await;
            adjust_viewers(&box_id, false);
        })
}

fn adjust_viewers(box_id: &str, joined: bool) {
    let mut viewers = relay_viewers()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let count = viewers.entry(box_id.to_owned()).or_insert(0);
    if joined {
        *count = count.saturating_add(1);
    } else {
        *count = count.saturating_sub(1);
        if *count == 0 {
            viewers.remove(box_id);
        }
    }
}

/// A live Box of `key` (cloud task or session), for the relay.
async fn live_target(key: &SessionBoxKey) -> Result<super::BoxTarget, ApiError> {
    if key.child.is_none() {
        if let Some(target) = cloud_tasks::bound_box(&key.owner, &key.conversation_id).await {
            return Ok(target);
        }
    }
    let Some(slot) = existing_slot(key) else {
        return Err(absent(key).await);
    };
    let guard = slot.lock().await;
    match guard.as_ref() {
        Some(entry) if entry.phase == Phase::Live => Ok(entry.target()),
        Some(_) => Err(api_error(
            StatusCode::CONFLICT,
            "session_box_not_live",
            "The Box is parked. Request a screen grant to resume it.",
        )),
        None => Err(absent(key).await),
    }
}

pub(super) fn routes() -> axum::Router<crate::server::ServerState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route(
            "/api/session-boxes/cost-notice",
            get(get_owner_cost_notice).post(acknowledge_owner_cost),
        )
        .route("/api/session-boxes/:conversation_id", get(get_status))
        .route("/api/session-boxes/:conversation_id/screen", post(screen))
        .route("/api/session-boxes/:conversation_id/stop", post(stop))
        .route("/api/session-boxes/:conversation_id/resume", post(resume))
        .route("/api/session-boxes/:conversation_id/extend", post(extend))
        .route(
            "/api/session-boxes/:conversation_id/cost-notice",
            post(acknowledge_cost),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
}

pub(super) fn public_routes() -> axum::Router<crate::server::ServerState> {
    use axum::routing::{any, get};
    axum::Router::new()
        .route(
            "/api/session-boxes/:conversation_id/screen/ws",
            get(screen_ws),
        )
        .route(
            "/api/session-boxes/inference/v1/*rest",
            any(inference::relay).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
}

#[derive(utoipa::OpenApi)]
#[openapi(
    paths(
        get_status,
        screen,
        stop,
        resume,
        extend,
        acknowledge_cost,
        get_owner_cost_notice,
        acknowledge_owner_cost
    ),
    components(schemas(
        SessionBoxStatus,
        super::SessionBoxView,
        super::SessionBoxPlacement,
        super::SessionBoxDesktop,
        caps::BoxCaps,
        ScreenRequest,
        ScreenGrant,
        ExtendRequest,
        Extended,
        super::notice::CostNotice,
        super::notice::OwnerNotice,
        CostNoticeRequest,
        CostNoticeAcknowledged
    ))
)]
struct SessionBoxApiDoc;

pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    SessionBoxApiDoc::openapi()
}
