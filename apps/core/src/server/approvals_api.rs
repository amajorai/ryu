//! HTTP handlers for the human-in-the-loop approval inbox.
//!
//! A thin layer over [`crate::approvals::ApprovalEngine`]: list / get / decide
//! (approve|reject) plus an SSE event stream the desktop inbox + island chip
//! subscribe to. Mirrors `quests_api.rs` (plain `Json` responses, fetch-based SSE
//! so the bearer token can ride the request).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::approvals::ApprovalStatus;
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// Optional status filter (`pending` / `approved` / `rejected` / `expired` /
    /// `cancelled`). Omitted ⇒ all.
    #[serde(default)]
    status: Option<String>,
    /// `app_jobs` keeps approvals whose scheduled-job target is an app job. Off
    /// by default: released clients parse job targets with a strict union.
    #[serde(default)]
    include: Option<String>,
}

impl ListQuery {
    fn include_app_jobs(&self) -> bool {
        self.include
            .as_deref()
            .is_some_and(|include| include.split(',').any(|item| item.trim() == "app_jobs"))
    }
}

/// Whether `request` runs an app job (hidden from clients that did not opt in).
fn runs_app_job(request: &crate::approvals::ApprovalRequest) -> bool {
    matches!(
        &request.action,
        Some(crate::approvals::PendingAction::ScheduledJob {
            target: crate::scheduler::store::JobTarget::AppJob { .. },
            ..
        })
    )
}

type Reply = (StatusCode, Json<serde_json::Value>);

fn error_reply(status: StatusCode, error: &str) -> Reply {
    (status, Json(json!({ "success": false, "error": error })))
}

/// The approval, a 404 for an unknown id, or a 500 on a store failure.
fn approval_reply(result: anyhow::Result<Option<crate::approvals::ApprovalRequest>>) -> Reply {
    match result {
        Ok(Some(req)) => (StatusCode::OK, Json(json!({ "approval": req }))),
        Ok(None) => error_reply(StatusCode::NOT_FOUND, "approval not found"),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

fn parse_status(s: &str) -> Option<ApprovalStatus> {
    match s {
        "pending" => Some(ApprovalStatus::Pending),
        "approved" => Some(ApprovalStatus::Approved),
        "rejected" => Some(ApprovalStatus::Rejected),
        "expired" => Some(ApprovalStatus::Expired),
        "cancelled" => Some(ApprovalStatus::Cancelled),
        _ => None,
    }
}

/// `GET /api/approvals?status=pending` — list approval requests, newest first.
/// Approvals that run an app job are listed only with `include=app_jobs`.
#[utoipa::path(
    get,
    path = "/api/approvals",
    tag = "Approvals",
    summary = "list approval requests, newest first.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_approvals(
    State(state): State<ServerState>,
    Query(q): Query<ListQuery>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(status) = require_permission(&state, &caller, "approvals.view").await {
        return status.into_response();
    }
    let status = q.status.as_deref().and_then(parse_status);
    let include_app_jobs = q.include_app_jobs();
    match state.approvals.store.list(status).await {
        Ok(approvals) => {
            let approvals: Vec<_> = approvals
                .into_iter()
                .filter(|request| include_app_jobs || !runs_app_job(request))
                .collect();
            Json(json!({ "approvals": approvals })).into_response()
        }
        // A store failure is not an empty inbox: answer an error status so the
        // client shows that approvals are unavailable instead of "none pending".
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// `GET /api/approvals/:id` — fetch a single request.
#[utoipa::path(
    get,
    path = "/api/approvals/{id}",
    tag = "Approvals",
    summary = "fetch a single request.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_approval(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(status) = require_permission(&state, &caller, "approvals.view").await {
        return error_reply(status, "forbidden");
    }
    approval_reply(state.approvals.store.get(&id).await)
}

#[derive(Debug, Deserialize, Default)]
pub struct DecideBody {
    /// Optional note the deciding user attaches (a reason for the decision).
    #[serde(default)]
    note: Option<String>,
}

/// Approve or reject `id` for a caller holding `approvals.decide`.
async fn decide(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    id: &str,
    approve: bool,
    body: Option<Json<DecideBody>>,
) -> Reply {
    if let Err(status) = require_permission(state, caller, "approvals.decide").await {
        return error_reply(status, "forbidden");
    }
    let note = body.and_then(|b| b.0.note);
    approval_reply(state.approvals.decide(id, approve, note).await)
}

/// `POST /api/approvals/:id/approve` — approve a request (runs its action).
#[utoipa::path(
    post,
    path = "/api/approvals/{id}/approve",
    tag = "Approvals",
    summary = "approve a request (runs its action).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn approve_approval(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<DecideBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    decide(&state, &caller, &id, true, body).await
}

/// `POST /api/approvals/:id/reject` — reject a request (fails a workflow gate).
#[utoipa::path(
    post,
    path = "/api/approvals/{id}/reject",
    tag = "Approvals",
    summary = "reject a request (fails a workflow gate).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn reject_approval(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<DecideBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    decide(&state, &caller, &id, false, body).await
}

/// `GET /api/approvals/mode` — the global approval mode (Layer B): `off` /
/// `smart` / `manual`. `off` is the default (gates nothing).
#[utoipa::path(
    get,
    path = "/api/approvals/mode",
    tag = "Approvals",
    summary = "the global approval mode (Layer B): `off` /",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_mode(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(status) = require_permission(&state, &caller, "approvals.view").await {
        return status.into_response();
    }
    let mode = state.approvals.approval_mode().await;
    Json(json!({ "mode": mode.as_str() })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct SetModeBody {
    /// `off` / `smart` / `manual` (anything else is treated as `off`).
    mode: String,
}

/// `PUT /api/approvals/mode` — set the global approval mode.
#[utoipa::path(
    put,
    path = "/api/approvals/mode",
    tag = "Approvals",
    summary = "set the global approval mode.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn set_mode(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SetModeBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(status) = require_permission(&state, &caller, "approvals.decide").await {
        return error_reply(status, "forbidden");
    }
    // Normalize through the enum so only a valid mode is ever stored.
    let mode = crate::approvals::policy::ApprovalMode::from_pref(&body.mode);
    match state
        .preferences
        .set(crate::approvals::policy::APPROVAL_MODE_PREF, mode.as_str())
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "mode": mode.as_str() }))),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// `GET /api/approvals/events` — SSE feed of approval events (created / decided).
#[utoipa::path(
    get,
    path = "/api/approvals/events",
    tag = "Approvals",
    summary = "SSE feed of approval events (created / decided).",
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Caller lacks `approvals.view`, or its credential expired"),
        (status = 503, description = "The control plane could not answer the `approvals.view` check; retry later")
    )
)]
pub async fn approval_events(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    user_jwt: Option<Extension<super::VerifiedUserJwt>>,
    authorization: Option<Extension<super::ResolvedAuthorization>>,
) -> axum::response::Response {
    match open_approval_feed(state, caller, user_jwt, authorization).await {
        Ok(feed) => approval_sse(feed),
        Err(status) => status.into_response(),
    }
}

/// A bounded stream of approval events for one authorized caller.
pub(crate) type ApprovalFeed =
    Pin<Box<dyn futures_util::Stream<Item = crate::approvals::ApprovalEvent> + Send>>;

/// Open the approval event feed for a caller, or refuse it.
///
/// Approval events carry titles, summaries, and tool arguments, so every route
/// that streams them (`/api/approvals/events` and the `approvals` channel of
/// `/api/events/all`) opens them here. The caller needs `approvals.view` at
/// connect time. The feed then ends when the credential it connected with
/// expires, or when a re-check of `approvals.view` every [`REVALIDATE_EVERY`]
/// fails.
///
/// Refusals are `403` for a definite denial and `503` when the control plane
/// could not answer the permission lookup; both open no feed.
pub(crate) async fn open_approval_feed(
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    user_jwt: Option<Extension<super::VerifiedUserJwt>>,
    authorization: Option<Extension<super::ResolvedAuthorization>>,
) -> Result<ApprovalFeed, axum::http::StatusCode> {
    require_permission_or_unavailable(&state, &caller, "approvals.view").await?;
    let user_jwt = user_jwt.and_then(|Extension(super::VerifiedUserJwt(token))| token);
    // Bound the feed to the credential it connected with: the user JWT's `exp`,
    // or the delegated grant's expiry when no user JWT rode the request.
    let expires_at = match user_jwt.as_deref() {
        Some(token) => match super::verified_caller_with_expiry_from_token(token).await {
            Some((_, expires_at)) => Some(expires_at),
            None => return Err(axum::http::StatusCode::FORBIDDEN),
        },
        None => authorization
            .and_then(|Extension(resolved)| resolved.context.expires_at)
            .map(|at| i64::try_from(at).unwrap_or(i64::MAX)),
    };
    let rx = state.approvals.store.subscribe();
    // Re-verify the same credential and re-check `approvals.view`. The role
    // tier comes from the token's claims, so a role change is seen at expiry;
    // a revoked custom-role grant is seen at the next re-check.
    let revalidate: Revalidate = Arc::new(move || {
        let state = state.clone();
        let caller = caller.clone();
        let user_jwt = user_jwt.clone();
        Box::pin(async move {
            let caller = match user_jwt.as_deref() {
                Some(token) => match super::verified_caller_with_expiry_from_token(token).await {
                    Some((caller, _)) => Some(caller),
                    None => return false,
                },
                None => caller,
            };
            require_permission(&state, &caller, "approvals.view")
                .await
                .is_ok()
        })
    });
    Ok(approval_feed(rx, expires_at, revalidate, REVALIDATE_EVERY))
}

/// How often an open approvals feed re-checks its caller's permission.
const REVALIDATE_EVERY: Duration = Duration::from_secs(30);

/// Re-checks a feed's caller. `false` ends the feed.
type Revalidate = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

struct FeedState {
    rx: tokio::sync::broadcast::Receiver<crate::approvals::ApprovalEvent>,
    revalidate: Revalidate,
    timer: tokio::time::Interval,
    expiry: Pin<Box<dyn Future<Output = ()> + Send>>,
}

/// Yield approval events until the channel closes, the credential expires
/// (`expires_at`, unix seconds), or a periodic re-check fails.
fn approval_feed(
    rx: tokio::sync::broadcast::Receiver<crate::approvals::ApprovalEvent>,
    expires_at: Option<i64>,
    revalidate: Revalidate,
    every: Duration,
) -> ApprovalFeed {
    use tokio::sync::broadcast::error::RecvError;

    let state = FeedState {
        rx,
        revalidate,
        timer: tokio::time::interval_at(tokio::time::Instant::now() + every, every),
        expiry: Box::pin(super::ws_ticket::wait_for_jwt_expiry(expires_at)),
    };
    Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            loop {
                // Expiry and revocation win over a ready event.
                tokio::select! {
                    biased;
                    () = &mut state.expiry => return None,
                    _ = state.timer.tick() => {
                        if !(state.revalidate)().await {
                            return None;
                        }
                    }
                    received = state.rx.recv() => match received {
                        Ok(event) => return Some((event, state)),
                        Err(RecvError::Lagged(_)) => {}
                        Err(RecvError::Closed) => return None,
                    },
                }
            }
        },
    ))
}

/// One channel-tagged SSE stream of a multiplexed event feed.
pub(crate) type TaggedEvents = Pin<
    Box<
        dyn futures_util::Stream<
                Item = Result<axum::response::sse::Event, std::convert::Infallible>,
            > + Send,
    >,
>;

/// Resolves when an `approvals` channel of `/api/events/all` ends.
pub(crate) type ChannelEnded = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Opens an approval feed for one connection; see [`open_approval_feed`].
pub(crate) type OpenFeed = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<ApprovalFeed, axum::http::StatusCode>> + Send>>
        + Send
        + Sync,
>;

/// First and longest wait between attempts to open a feed whose permission
/// check met a control-plane outage.
const OPEN_RETRY_FIRST: Duration = Duration::from_secs(1);
const OPEN_RETRY_MAX: Duration = Duration::from_secs(30);

/// Tag a feed as the `approvals` channel of `/api/events/all`.
///
/// Returns the channel and a future that resolves when the feed ends (expiry,
/// failed re-check, or a closed bus). The caller ends the whole multiplex on it,
/// so the client reconnects and is authorized again rather than keeping a
/// connection that silently stopped carrying approvals.
pub(crate) fn approvals_channel(feed: ApprovalFeed) -> (TaggedEvents, ChannelEnded) {
    use axum::response::sse::Event;
    use futures_util::StreamExt;

    let (ended_tx, ended_rx) = tokio::sync::oneshot::channel::<()>();
    let events = feed.map(|event| {
        let data = serde_json::to_string(&event).unwrap_or_default();
        Ok::<_, std::convert::Infallible>(Event::default().event("approvals").data(data))
    });
    let on_end = futures_util::stream::once(async move { drop(ended_tx) })
        .filter_map(|()| async { None::<Result<Event, std::convert::Infallible>> });
    let ended = Box::pin(async move {
        let _ = ended_rx.await;
    });
    (Box::pin(events.chain(on_end)), ended)
}

/// The approvals decision for one `/api/events/all` connection.
pub(crate) struct EventsAllApprovals {
    /// The `approvals` channel and its end future, or `None` when the caller
    /// is definitely refused `approvals.view`.
    pub channel: Option<(TaggedEvents, ChannelEnded)>,
    /// Whether the connect-time check passed. `false` on a refusal and during
    /// a control-plane outage. Other channels that mirror approval content
    /// (activity) carry it only when this is `true`; the multiplex already ends
    /// with the approvals feed, so they share its expiry and re-check bounds.
    pub may_view: bool,
}

/// The `approvals` channel of one `/api/events/all` connection, or `None` when
/// the caller is definitely refused `approvals.view`.
///
/// A control-plane outage during the connect-time check is not a denial. The
/// connection carries no approvals channel yet, and the node re-runs the full
/// check with backoff ([`OPEN_RETRY_FIRST`] doubling to [`OPEN_RETRY_MAX`]).
/// As soon as a check is decided either way, the returned future resolves and
/// the whole multiplex ends, so the client reconnects with its current
/// credential, resyncs what it missed, and is authorized from scratch.
pub(crate) async fn events_all_approvals_channel(
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    user_jwt: Option<Extension<super::VerifiedUserJwt>>,
    authorization: Option<Extension<super::ResolvedAuthorization>>,
) -> EventsAllApprovals {
    let open: OpenFeed = Arc::new(move || {
        let (state, caller, user_jwt, authorization) = (
            state.clone(),
            caller.clone(),
            user_jwt.clone(),
            authorization.clone(),
        );
        Box::pin(open_approval_feed(state, caller, user_jwt, authorization))
    });
    approvals_decision(open, OPEN_RETRY_FIRST, OPEN_RETRY_MAX).await
}

/// [`approvals_channel_retrying`] plus whether its connect-time open succeeded.
async fn approvals_decision(
    open: OpenFeed,
    first_retry: Duration,
    max_retry: Duration,
) -> EventsAllApprovals {
    use std::sync::atomic::{AtomicBool, Ordering};

    // Set when an open succeeds. Read right after the connect-time attempt,
    // before any background retry can run, so it reflects that attempt only.
    let opened = Arc::new(AtomicBool::new(false));
    let tracked: OpenFeed = {
        let opened = opened.clone();
        Arc::new(move || {
            let (open, opened) = (open.clone(), opened.clone());
            Box::pin(async move {
                let feed = open().await;
                if feed.is_ok() {
                    opened.store(true, Ordering::SeqCst);
                }
                feed
            })
        })
    };
    let channel = approvals_channel_retrying(tracked, first_retry, max_retry).await;
    let may_view = channel.is_some() && opened.load(Ordering::SeqCst);
    EventsAllApprovals { channel, may_view }
}

/// Open the channel now. On `503` return an empty channel whose end future
/// keeps retrying the check and resolves on the first decided outcome, so the
/// multiplex ends and the client reconnects. On any other refusal return `None`.
///
/// A retry never forwards events on the connection it started on: a feed opened
/// after the outage would hide the events emitted during it (the client only
/// resyncs on reconnect), and it would be bound to a credential that may have
/// expired while the control plane was down.
async fn approvals_channel_retrying(
    open: OpenFeed,
    first_retry: Duration,
    max_retry: Duration,
) -> Option<(TaggedEvents, ChannelEnded)> {
    match open().await {
        Ok(feed) => Some(approvals_channel(feed)),
        Err(axum::http::StatusCode::SERVICE_UNAVAILABLE) => {
            let ended: ChannelEnded = Box::pin(async move {
                let mut delay = first_retry;
                loop {
                    tokio::time::sleep(delay).await;
                    match open().await {
                        Err(axum::http::StatusCode::SERVICE_UNAVAILABLE) => {
                            delay = delay.saturating_mul(2).min(max_retry);
                        }
                        // Authorized, denied, or the credential expired: either
                        // way the decision belongs to a fresh connection.
                        _ => return,
                    }
                }
            });
            Some((Box::pin(futures_util::stream::empty()), ended))
        }
        Err(_) => None,
    }
}

/// Serve a feed as the `/api/approvals/events` SSE response.
fn approval_sse(feed: ApprovalFeed) -> axum::response::Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::StreamExt;

    let events = feed.map(|event| {
        let data = serde_json::to_string(&event).unwrap_or_default();
        Ok::<_, std::convert::Infallible>(Event::default().data(data))
    });
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn require_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), StatusCode> {
    // Approval decisions are governance actions. Unlike a local read-only
    // catalog, a node-token-only/paired request must not list or execute a
    // user's pending action, even on an otherwise unbound node.
    if caller.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }
    super::enforce_permission(state, caller, permission).await
}

/// Whether `caller` may read approval content, under the same rule as
/// `GET /api/approvals`. Any refusal, including a control-plane outage, is
/// `false`: a reader of a shared feed that mirrors approvals (the activity feed)
/// gets the feed without them rather than an error.
pub(crate) async fn caller_may_view_approvals(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    require_permission(state, caller, "approvals.view")
        .await
        .is_ok()
}

/// [`require_permission`] that reports a control-plane outage as `503`.
async fn require_permission_or_unavailable(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), axum::http::StatusCode> {
    if caller.is_none() {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }
    super::enforce_permission_or_unavailable(state, caller, permission).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};

    fn scheduled(target: JobTarget) -> crate::approvals::ApprovalRequest {
        crate::approvals::ApprovalRequest::for_scheduled_job(&ScheduledJob {
            id: "job".to_owned(),
            name: "job".to_owned(),
            schedule: Schedule::Every {
                interval: "1h".to_owned(),
            },
            target,
            enabled: true,
            require_approval: true,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "t".to_owned(),
            updated_at: "t".to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        })
    }

    /// Approvals that run an app job are hidden unless `include=app_jobs`.
    #[test]
    fn app_job_approvals_are_listed_only_on_request() {
        let app = scheduled(JobTarget::AppJob {
            plugin_id: "@example/owner".to_owned(),
            job_id: "m1".to_owned(),
            payload: None,
        });
        let agent = scheduled(JobTarget::Agent {
            agent_id: "a".to_owned(),
            prompt: "p".to_owned(),
            model: None,
            conversation_id: None,
        });
        assert!(runs_app_job(&app));
        assert!(!runs_app_job(&agent));
        let query = |include: Option<&str>| ListQuery {
            status: None,
            include: include.map(str::to_owned),
        };
        assert!(!query(None).include_app_jobs());
        assert!(!query(Some("apps")).include_app_jobs());
        assert!(query(Some("app_jobs")).include_app_jobs());
        assert!(query(Some("x, app_jobs")).include_app_jobs());
    }

    fn created_event() -> crate::approvals::ApprovalEvent {
        crate::approvals::ApprovalEvent::Created {
            request: scheduled(JobTarget::Agent {
                agent_id: "a".to_owned(),
                prompt: "secret-tool-args".to_owned(),
                model: None,
                conversation_id: None,
            }),
        }
    }

    fn allow(result: bool) -> Revalidate {
        Arc::new(move || Box::pin(async move { result }))
    }

    /// Reads the next body chunk, or `None` once the stream has ended.
    async fn next_chunk(body: &mut axum::body::BodyDataStream) -> Option<String> {
        use futures_util::StreamExt;
        tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("stream should yield or end")
            .map(|chunk| String::from_utf8_lossy(&chunk.unwrap()).into_owned())
    }

    #[tokio::test]
    async fn authorized_stream_forwards_events() {
        let (tx, rx) = tokio::sync::broadcast::channel(8);
        let far_future = chrono::Utc::now().timestamp() + 3600;
        let response = approval_sse(approval_feed(
            rx,
            Some(far_future),
            allow(true),
            Duration::from_millis(10),
        ));
        let mut body = response.into_body().into_data_stream();
        tx.send(created_event()).unwrap();
        let chunk = next_chunk(&mut body).await.expect("event frame");
        assert!(chunk.contains("secret-tool-args"));
        // Passing re-checks keep the stream open for later events.
        tokio::time::sleep(Duration::from_millis(40)).await;
        tx.send(created_event()).unwrap();
        assert!(next_chunk(&mut body).await.is_some());
    }

    #[tokio::test]
    async fn stream_ends_when_permission_recheck_fails() {
        let (tx, rx) = tokio::sync::broadcast::channel(8);
        let response = approval_sse(approval_feed(
            rx,
            None,
            allow(false),
            Duration::from_millis(20),
        ));
        let mut body = response.into_body().into_data_stream();
        tokio::time::sleep(Duration::from_millis(60)).await;
        // Queued after revocation: never delivered, the stream is closed.
        let _ = tx.send(created_event());
        assert!(next_chunk(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn stream_ends_at_credential_expiry_before_forwarding() {
        let (tx, rx) = tokio::sync::broadcast::channel(8);
        tx.send(created_event()).unwrap();
        let expired = chrono::Utc::now().timestamp() - 1;
        let response = approval_sse(approval_feed(
            rx,
            Some(expired),
            allow(true),
            Duration::from_secs(30),
        ));
        let mut body = response.into_body().into_data_stream();
        assert!(next_chunk(&mut body).await.is_none());
    }

    /// A caller without a verified identity gets no approval feed on either
    /// route (`/api/approvals/events` or the `/api/events/all` channel).
    #[tokio::test]
    async fn anonymous_caller_is_refused_the_feed() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(dir.path());
        let refused = open_approval_feed(state, None, None, None).await;
        assert_eq!(refused.err(), Some(axum::http::StatusCode::FORBIDDEN));
    }

    /// Events on the multiplexed channel are tagged `approvals`, and when the
    /// feed ends the whole multiplex ends even though other channels are idle.
    #[tokio::test]
    async fn multiplex_ends_when_the_approvals_channel_ends() {
        use futures_util::StreamExt;

        let (tx, rx) = tokio::sync::broadcast::channel(8);
        let feed = approval_feed(rx, None, allow(true), Duration::from_secs(30));
        let (channel, ended) = approvals_channel(feed);
        let idle: TaggedEvents = Box::pin(futures_util::stream::pending());
        let mut multiplex = futures_util::stream::select_all(vec![idle, channel]).take_until(ended);
        tx.send(created_event()).unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("event")
            .expect("frame");
        // Render the frame through the SSE encoder to read its bytes.
        let mut body = axum::response::sse::Sse::new(futures_util::stream::iter([first]))
            .into_response()
            .into_body()
            .into_data_stream();
        let frame = next_chunk(&mut body).await.expect("frame bytes");
        assert!(frame.contains("event: approvals"));
        assert!(frame.contains("secret-tool-args"));
        // The bus closes: the approvals feed ends, so the multiplex ends too.
        drop(tx);
        let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("multiplex should end");
        assert!(end.is_none());
    }

    /// A failed re-check ends the multiplex, not just the approvals channel.
    #[tokio::test]
    async fn multiplex_ends_when_the_permission_recheck_fails() {
        use futures_util::StreamExt;

        let (_tx, rx) = tokio::sync::broadcast::channel(8);
        let feed = approval_feed(rx, None, allow(false), Duration::from_millis(20));
        let (channel, ended) = approvals_channel(feed);
        let idle: TaggedEvents = Box::pin(futures_util::stream::pending());
        let mut multiplex = futures_util::stream::select_all(vec![idle, channel]).take_until(ended);
        let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("multiplex should end");
        assert!(end.is_none());
    }

    /// An opener that answers each attempt from `outcomes` in order (the last
    /// one repeats) and counts the attempts.
    fn scripted_open(
        outcomes: Vec<axum::http::StatusCode>,
        bus: tokio::sync::broadcast::Sender<crate::approvals::ApprovalEvent>,
    ) -> (OpenFeed, Arc<std::sync::atomic::AtomicUsize>) {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = attempts.clone();
        let open: OpenFeed = Arc::new(move || {
            let attempt = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let outcome = outcomes[attempt.min(outcomes.len() - 1)];
            let rx = bus.subscribe();
            Box::pin(async move {
                if outcome == axum::http::StatusCode::OK {
                    Ok(approval_feed(
                        rx,
                        None,
                        allow(true),
                        Duration::from_secs(30),
                    ))
                } else {
                    Err(outcome)
                }
            })
        });
        (open, attempts)
    }

    /// A definite denial at connect time opens no approvals channel.
    #[tokio::test]
    async fn events_all_omits_the_channel_on_a_definite_denial() {
        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let (open, attempts) = scripted_open(vec![axum::http::StatusCode::FORBIDDEN], tx);
        let channel =
            approvals_channel_retrying(open, Duration::from_millis(5), Duration::from_millis(5))
                .await;
        assert!(channel.is_none());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Approval-derived activity rides `/api/events/all` only when the
    /// connect-time check passed: never on a refusal, and never during an
    /// outage, even after a background retry later succeeds.
    #[tokio::test]
    async fn events_all_lets_activity_carry_approvals_only_after_a_passed_check() {
        use futures_util::StreamExt;

        let ok = axum::http::StatusCode::OK;
        let unavailable = axum::http::StatusCode::SERVICE_UNAVAILABLE;
        let (tx, _rx) = tokio::sync::broadcast::channel(8);

        let (open, _) = scripted_open(vec![ok], tx.clone());
        let passed =
            approvals_decision(open, Duration::from_millis(5), Duration::from_millis(5)).await;
        assert!(passed.may_view);
        assert!(passed.channel.is_some());

        let (open, _) = scripted_open(vec![axum::http::StatusCode::FORBIDDEN], tx.clone());
        let denied =
            approvals_decision(open, Duration::from_millis(5), Duration::from_millis(5)).await;
        assert!(!denied.may_view);
        assert!(denied.channel.is_none());

        let (open, attempts) = scripted_open(vec![unavailable, ok], tx);
        let outage =
            approvals_decision(open, Duration::from_millis(2), Duration::from_millis(2)).await;
        assert!(!outage.may_view, "an outage is not a passed check");
        let (channel, ended) = outage.channel.expect("an outage is not a denial");
        let (_other_tx, other) = other_channel();
        let mut multiplex =
            futures_util::stream::select_all(vec![other, channel]).take_until(ended);
        // The retry succeeds and ends the stream; the flag was decided before it.
        let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("the multiplex ends once the check passes");
        assert!(end.is_none());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// A test channel other than `approvals`, fed through the returned sender.
    fn other_channel() -> (
        tokio::sync::mpsc::UnboundedSender<&'static str>,
        TaggedEvents,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
        let stream: TaggedEvents =
            Box::pin(futures_util::stream::unfold(rx, |mut rx| async move {
                let name = rx.recv().await?;
                let event = axum::response::sse::Event::default().event(name).data("x");
                Some((Ok::<_, std::convert::Infallible>(event), rx))
            }));
        (tx, stream)
    }

    async fn frame_text(
        frame: Result<axum::response::sse::Event, std::convert::Infallible>,
    ) -> String {
        let mut body = axum::response::sse::Sse::new(futures_util::stream::iter([frame]))
            .into_response()
            .into_body()
            .into_data_stream();
        next_chunk(&mut body).await.expect("frame bytes")
    }

    /// Drive `multiplex` until `attempts` reaches `target`, failing if it yields
    /// anything (approvals or an end) in the meantime.
    async fn drive_until_attempt<S>(
        multiplex: &mut S,
        attempts: &std::sync::atomic::AtomicUsize,
        target: usize,
    ) where
        S: futures_util::Stream + Unpin,
    {
        use futures_util::StreamExt;
        let reached = async {
            while attempts.load(std::sync::atomic::Ordering::SeqCst) < target {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        };
        tokio::select! {
            _ = multiplex.next() => panic!("nothing is forwarded and the stream stays open during the outage"),
            waited = tokio::time::timeout(Duration::from_secs(5), reached) => waited.expect("retried"),
        }
    }

    /// During a control-plane outage the other channels keep flowing, no
    /// approval is forwarded, and the connection stays open while the check
    /// keeps failing with `503`.
    #[tokio::test]
    async fn events_all_outage_forwards_no_approvals_and_keeps_other_channels() {
        use futures_util::StreamExt;

        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let unavailable = axum::http::StatusCode::SERVICE_UNAVAILABLE;
        let (open, attempts) = scripted_open(vec![unavailable], tx.clone());
        let (channel, ended) =
            approvals_channel_retrying(open, Duration::from_millis(2), Duration::from_millis(4))
                .await
                .expect("an outage is not a denial");
        let (other_tx, other) = other_channel();
        let mut multiplex =
            futures_util::stream::select_all(vec![other, channel]).take_until(ended);
        let _ = tx.send(created_event());
        drive_until_attempt(&mut multiplex, &attempts, 4).await;
        let _ = tx.send(created_event());
        other_tx.send("notifications").unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("other channel still flows")
            .expect("frame");
        let frame = frame_text(frame).await;
        assert!(frame.contains("event: notifications"));
        assert!(!frame.contains("event: approvals"));
    }

    /// When the check passes again after an outage, the connection ends instead
    /// of starting approvals mid-stream: the client reconnects, resyncs what it
    /// missed during the outage, and is authorized with its current credential.
    #[tokio::test]
    async fn events_all_ends_the_stream_once_the_check_passes_after_an_outage() {
        use futures_util::StreamExt;

        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let unavailable = axum::http::StatusCode::SERVICE_UNAVAILABLE;
        let (open, attempts) = scripted_open(
            vec![unavailable, unavailable, axum::http::StatusCode::OK],
            tx.clone(),
        );
        let (channel, ended) =
            approvals_channel_retrying(open, Duration::from_millis(5), Duration::from_millis(20))
                .await
                .expect("an outage is not a denial");
        let (_other_tx, other) = other_channel();
        let mut multiplex =
            futures_util::stream::select_all(vec![other, channel]).take_until(ended);
        // Sent before any check passed: no feed is subscribed, nothing leaks.
        let _ = tx.send(created_event());
        let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("the multiplex ends once the check passes");
        assert!(
            end.is_none(),
            "no approval frame is forwarded on this connection"
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    /// A refusal on a retry (a revoked grant, or a credential that expired
    /// during the outage) also ends the stream, so the client reconnects with a
    /// fresh token rather than keeping a connection without approvals.
    #[tokio::test]
    async fn events_all_ends_the_stream_when_a_retry_is_refused() {
        use futures_util::StreamExt;

        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let (open, attempts) = scripted_open(
            vec![
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                axum::http::StatusCode::FORBIDDEN,
            ],
            tx.clone(),
        );
        let (channel, ended) =
            approvals_channel_retrying(open, Duration::from_millis(5), Duration::from_millis(5))
                .await
                .expect("an outage is not a denial");
        let (other_tx, other) = other_channel();
        let mut multiplex =
            futures_util::stream::select_all(vec![other, channel]).take_until(ended);
        // The other channel flows while the outage lasts.
        other_tx.send("notifications").unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("other channel flows")
            .expect("frame");
        assert!(frame_text(frame).await.contains("event: notifications"));
        let _ = tx.send(created_event());
        let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
            .await
            .expect("the multiplex ends on the refused retry");
        assert!(end.is_none());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
    }
}
