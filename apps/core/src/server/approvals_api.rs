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

// The list, read, decide and mode handlers live in `handlers.rs`. It starts with
// `use super::*;`, so the imports above and the helpers of this file reach it exactly as
// they did in the single file.
mod handlers;
#[cfg(test)]
mod tests;

pub use handlers::*;

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
