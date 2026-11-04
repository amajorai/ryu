//! Version/update, preferences, safe mode, capability bindings, email and alert delivery, model launch config and downloads: `all_events_stream` through `all_events_stream`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/events/all` — unified SSE that multiplexes EVERY feature event bus
/// (notifications, quests, monitors, approvals, meetings, dashboards, downloads)
/// into ONE connection, each event tagged with its channel via the SSE `event:`
/// field. The desktop subscribes here ONCE instead of opening 6+ always-on
/// streams; otherwise those feeds hold every slot of the browser's
/// 6-connection-per-host HTTP/1.1 budget and starve all other fetches (the
/// "every page loads forever" bug). The per-feature endpoints stay for
/// non-desktop clients (mobile, CLI).
#[utoipa::path(
    get,
    path = "/api/events/all",
    tag = "Events",
    summary = "Stream every node event (SSE)",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn all_events_stream(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    user_jwt: Option<Extension<VerifiedUserJwt>>,
    authorization: Option<Extension<ResolvedAuthorization>>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::stream::{self, Stream, StreamExt};
    use std::convert::Infallible;
    use std::pin::Pin;
    use tokio::sync::broadcast::error::RecvError;

    type TaggedStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

    // Downloads is snapshot-first (a late client self-heals from the snapshot).
    // The snapshot and the subscription are taken atomically, so the deltas that
    // follow are exactly the commits after the snapshot: none missed, none replayed.
    let downloads: TaggedStream = Box::pin(
        download_event_frames(state.downloads.clone())
            .map(|data| Ok(Event::default().event("downloads").data(data))),
    );

    // Dashboards is now out-of-process (`ryu-dashboards` sidecar); its widget events
    // no longer ride Core's in-process broadcast. The desktop reads them off the
    // sidecar's own `/api/dashboards/events` SSE via `public_mount` (which registers
    // the live UI viewer the refresh cost-guard keys off), so this unified fan-out no
    // longer carries a `dashboards` channel — mirroring monitors/quests.

    // Notifications need a FILTERED tap (not the generic `tagged`): this unified
    // stream is unauthenticated, so it may only carry BROADCAST notifications.
    // User-targeted pings (`target_user_id` set) are dropped here and reach the
    // right member solely via the per-user `/api/notifications/stream`; otherwise
    // a ping for one teammate would toast on every desktop sharing a team node.
    let notifications: TaggedStream = Box::pin(stream::unfold(
        crate::events::subscribe(),
        |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if ev.target_user_id.is_some() {
                            continue;
                        }
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        return Some((Ok(Event::default().event("notifications").data(data)), rx));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    ));

    // Navigation is user-scoped on shared nodes. Keep it on the unified socket
    // so the Desktop does not spend another long-lived HTTP connection, while
    // applying the same filter as the legacy navigation endpoint.
    let node_bound = crate::sidecar::control_plane::registered_org().is_some();
    let approvals_caller = caller.clone();
    let navigation: TaggedStream = Box::pin(stream::unfold(
        (crate::events::subscribe_navigation(), caller, node_bound),
        |(mut rx, caller, node_bound)| async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if !navigation_visible_to_caller(&ev, &caller, node_bound) {
                            continue;
                        }
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        return Some((
                            Ok(Event::default().event("navigation").data(data)),
                            (rx, caller, node_bound),
                        ));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    ));

    // Approvals carry titles, summaries, and tool arguments, so the channel goes
    // only to a caller `/api/approvals/events` would admit, under the same
    // bounds (credential expiry, periodic `approvals.view` re-check). When that
    // feed ends, the whole stream ends so the client reconnects and is
    // authorized again; a caller without the permission gets no approvals channel.
    // A control-plane outage during the check is not a denial: no approvals are
    // forwarded, the check is retried with backoff, and once it is decided the
    // stream ends so the client reconnects, resyncs, and is checked afresh.
    let approvals = approvals_api::events_all_approvals_channel(
        state.clone(),
        approvals_caller,
        user_jwt,
        authorization,
    )
    .await;

    // The activity store also records every approval event (title, summary,
    // agent, conversation), so approval-derived items ride this channel only
    // when the approvals check above passed. A refusal or an outage withholds
    // them. An authorized caller's stream ends with the approvals feed, so the
    // activity channel shares its expiry and re-check bounds.
    let may_view_approvals = approvals.may_view;
    let activity: TaggedStream = Box::pin(stream::unfold(
        state.activity.subscribe(),
        move |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(item) => {
                        if !may_view_approvals && crate::activity::is_approval_derived(&item) {
                            continue;
                        }
                        let data = serde_json::to_string(&item).unwrap_or_default();
                        return Some((Ok(Event::default().event("activity").data(data)), rx));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    ));
    let mut streams: Vec<TaggedStream> = vec![activity, notifications, downloads, navigation];
    let approvals_ended: Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
        match approvals.channel {
            Some((channel, ended)) => {
                streams.push(channel);
                ended
            }
            None => Box::pin(std::future::pending::<()>()),
        };
    // Monitors, quests, dashboards, and meetings are now out-of-process
    // (`ryu-monitors` / `ryu-quests` / `ryu-dashboards` / `ryu-meetings` sidecars);
    // their events no longer ride Core's in-process broadcast. The activity STORE still
    // records them — the monitors alert callback + the quests/meetings SSE folds — they
    // just do not join this live per-engine fan-out (the desktop reads monitor alerts
    // off the sidecar's own `/api/monitors/alerts/stream`, dashboard events off
    // `/api/dashboards/events`, and meeting events off `/api/meetings/stream`, via
    // `public_mount`).

    Sse::new(stream::select_all(streams).take_until(approvals_ended))
        .keep_alive(KeepAlive::default())
}
