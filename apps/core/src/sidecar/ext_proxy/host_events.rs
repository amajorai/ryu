//! Host-API events, realtime publish, warmup and grant checks.

use super::*;

/// Body of the `events.emit` kernel capability.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct EventEmitBody {
    /// The fully-qualified event id (`<plugin id>#<event name>`). Must be one the
    /// calling plugin declared — see [`crate::plugin_host::may_emit_event`].
    pub(super) event: String,
    /// The payload delivered to every consumer as `ctx.event`. Forwarded verbatim.
    #[serde(default)]
    pub(super) payload: serde_json::Value,
    /// Optional conversation this event belongs to, when the emitter knows one (a
    /// meeting started from a chat, a workflow run kicked off by an agent). Carried
    /// into [`crate::plugin_host::HookContext::conversation_id`] so a consumer can
    /// key its own per-conversation state the same way a turn hook does.
    #[serde(default)]
    pub(super) conversation_id: Option<String>,
    /// OPTIONAL user-facing notification to raise alongside the fan-out
    /// (`{ title, body?, level?, target_user_id?, i18n? }`; `i18n` renders it
    /// per recipient locale, as on `notify.deliver`). Delivered into the app-inbox
    /// feed with `source_app_id` = the calling plugin (the desktop Inbox then shows
    /// the app's icon on the row) — the same delivery [`notify.deliver`] performs,
    /// so "emit an event AND ping the user" is one governed call. Best-effort: a
    /// delivery failure never fails the emit.
    #[serde(default)]
    pub(super) notify: Option<EventEmitNotify>,
    /// OPTIONAL activity-feed row to record alongside the fan-out
    /// (`{ kind, title, body?, level?, metadata? }`). Recorded with `source` derived
    /// from the AUTHENTICATED caller (`@ryu/meetings` → `meetings`), never from the
    /// body, so an app can only ever write rows attributed to itself. This is how an
    /// out-of-process app feeds the unified activity feed without Core holding a
    /// per-app subscribe loop. Best-effort: an invalid hint or a failed write is
    /// logged and never fails the emit.
    #[serde(default)]
    pub(super) activity: Option<crate::plugin_host::AppEventActivity>,
}

/// Body of the generic application-room sidecar publish capability. The caller
/// identity is authenticated from the ext token and supplies the app namespace;
/// `room_id` is the only room coordinate accepted from the sidecar.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct RealtimePublishBody {
    pub(super) room_id: String,
    pub(super) event: String,
    #[serde(default)]
    pub(super) data: serde_json::Value,
}

pub(super) async fn host_realtime_publish(
    state: ServerState,
    headers: HeaderMap,
    Json(body): Json<RealtimePublishBody>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    let room_id = body.room_id.trim();
    if room_id.is_empty() || room_id.len() > 512 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "room_id must be 1..512 bytes" })),
        )
            .into_response();
    }
    let event = ryu_realtime::ApplicationEvent {
        name: body.event,
        payload: body.data,
    };
    if !ryu_realtime::is_valid_application_event(&event) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid or oversized application event" })),
        )
            .into_response();
    }
    state.realtime.publish_application_event(
        &plugin_id,
        room_id,
        event.name.clone(),
        event.payload,
    );
    Json(json!({ "published": true })).into_response()
}

/// `warmup.*` — Core's heartbeat scheduler, scoped to the caller's own jobs.
///
/// Re-authenticates the caller to pin the owner (never taken from the body),
/// then runs the shared [`crate::server::app_warmup::WarmupOp`] with no user:
/// the scheduler's `agent.view` / `agent.edit` checks treat a sidecar exactly as
/// an anonymous caller, so an app grant never stands in for a user permission.
pub(super) async fn host_warmup(
    cap: &str,
    state: ServerState,
    headers: HeaderMap,
    args: serde_json::Value,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    let Some(op) = crate::server::app_warmup::WarmupOp::from_name(cap) else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "kernel capability has no implementation", "capability": cap })),
        )
            .into_response();
    };
    match op.run(&state, &plugin_id, &None, &args).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_capability_response(),
    }
}

/// The `notify` hint carried on an `events.emit` request.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct EventEmitNotify {
    pub(super) title: String,
    #[serde(default)]
    pub(super) body: Option<String>,
    #[serde(default)]
    pub(super) level: Option<String>,
    #[serde(default)]
    pub(super) target_user_id: Option<String>,
    /// Optional localizable text, the `notify.deliver` `i18n` shape.
    #[serde(default)]
    pub(super) i18n: Option<serde_json::Value>,
    /// Optional tap target, a deep link into the emitting app. An invalid one
    /// is dropped (see [`hint_link`]); the notification is still delivered.
    #[serde(default)]
    pub(super) link: Option<String>,
}

/// The tap link of an `events.emit` hint, when it is a deep link into the
/// emitting app ([`ryu_app_events::NotifyHint::link_is_valid_for`]). Any other
/// link is dropped with a warning, so a bad link never costs the user the
/// notification itself.
pub(super) fn hint_link<'a>(plugin_id: &str, link: Option<&'a str>) -> Option<&'a str> {
    let link = link?;
    if ryu_app_events::NotifyHint::link_is_valid_for(plugin_id, link) {
        return Some(link);
    }
    tracing::warn!(plugin = %plugin_id, "events.emit: dropped a notify link outside the app");
    None
}

/// `events.emit` — fan an app event out to its subscribers.
///
/// Re-authenticates the caller (the kernel-capability contract: every handler pins
/// its own caller rather than trusting the broker's dispatch), then refuses anything
/// the caller does not own. Ownership is the whole gate here, so it is checked
/// before the payload is even looked at.
///
/// Two fan-outs, deliberately different in kind:
/// - **plugin hooks** run through [`crate::plugin_host::dispatch_app_event`], which
///   is awaited so the emitter learns how many consumers acted;
/// - **workflows** are started detached, because a workflow run can take minutes and
///   an emitter blocking on one would turn "my meeting ended" into a request timeout.
pub(super) async fn host_events_emit(
    state: ServerState,
    headers: HeaderMap,
    Json(body): Json<EventEmitBody>,
) -> Response {
    let (plugin_id, grants) = match authenticate_sidecar(&state, &headers).await {
        Ok(caller) => caller,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    if !crate::plugin_host::may_emit_event(&state, &plugin_id, &body.event).await {
        // One message for "not yours" and "not declared" on purpose: distinguishing
        // them would let a caller probe which events other plugins have declared.
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "plugin may only emit events it declares in contributes.hook_events",
                "event": body.event,
            })),
        )
            .into_response();
    }

    let payload_len = serde_json::to_vec(&body.payload).map_or(0, |v| v.len());
    if payload_len > crate::plugin_host::MAX_EVENT_PAYLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": "event payload too large",
                "limit_bytes": crate::plugin_host::MAX_EVENT_PAYLOAD_BYTES,
                "size_bytes": payload_len,
            })),
        )
            .into_response();
    }

    if let Some(activity) = &body.activity {
        crate::plugin_host::record_app_event_activity(&state, &plugin_id, &body.event, activity)
            .await;
    }

    // Sidecar subscribers (`subscribes`) are delivered off this request's path: the
    // fan-out queues per subscriber and returns immediately.
    if let Some(fanout) = crate::sidecar::event_subscribers::global() {
        fanout.publish(&body.event, body.payload.clone());
    }

    let ctx = crate::plugin_host::HookContext {
        conversation_id: body.conversation_id.clone(),
        event: Some(body.payload.clone()),
        ..Default::default()
    };
    let directives = crate::plugin_host::dispatch_app_event(&state, &body.event, &ctx).await;

    // Surface any `note` a consumer returned. An app event has no chat turn to
    // attach a note to, so the notify store is the only place it can legibly go —
    // and it is where a user already looks for "something happened".
    for directive in &directives {
        if let crate::plugin_host::HookDirective::Note { text } = directive {
            crate::plugin_host::notify_app_event_note(&state, &body.event, text).await;
        }
    }

    let workflows =
        crate::workflow::triggers::fire_event_workflows(&body.event, &body.payload).await;

    // Optional user-facing notification raised alongside the fan-out. Delivered
    // best-effort through the same kernel path `notify.deliver` uses, so the row
    // is stamped with the AUTHENTICATED caller — an event's notify hint can never
    // be attributed to a different app.
    if let Some(notify) = &body.notify {
        let title = notify.title.trim();
        if !title.is_empty() {
            let text = notify
                .i18n
                .as_ref()
                .and_then(crate::i18n::AlertText::from_wire);
            let _ = crate::server::app_notify::deliver_for_app_localized(
                &state.client,
                &plugin_id,
                &grants,
                notify.target_user_id.as_deref(),
                title,
                notify.body.as_deref().unwrap_or(""),
                notify.level.as_deref(),
                text.as_ref(),
                hint_link(&plugin_id, notify.link.as_deref()),
            )
            .await;
        }
    }

    tracing::info!(
        event = %body.event,
        plugin = %plugin_id,
        hooks = directives.len(),
        workflows,
        "events.emit: app event fanned out"
    );

    Json(json!({
        "event": body.event,
        "hooks": directives.len(),
        "workflows": workflows,
    }))
    .into_response()
}

/// Whether `plugin_id` may exercise `grant`: the same declared∩approved intersection
/// [`authorize_host_call`] enforces, but taking the already-authenticated caller's
/// approved set so the kernel path does not re-run [`authenticate_sidecar`].
pub(super) async fn holds_host_api_grant(
    state: &ServerState,
    plugin_id: &str,
    approved: &HashSet<String>,
    grant: &str,
) -> bool {
    let manifests = state.app_manifests.read().await;
    let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
        return false;
    };
    host_api_grant_usable(manifest, approved, grant)
}

/// The pure predicate behind [`holds_host_api_grant`]: `grant` must be BOTH declared
/// in the manifest's `sidecars[].host_api.grants` (the app's own stated ceiling) AND
/// present in `approved` (what the Gateway actually approved at enable, as stored on
/// the app record). Either alone is not enough — a manifest cannot widen itself, and
/// an approval the app never asked for is not a licence to use it.
pub(super) fn host_api_grant_usable(
    manifest: &crate::plugin_manifest::PluginManifest,
    approved: &HashSet<String>,
    grant: &str,
) -> bool {
    approved.contains(grant)
        && manifest
            .sidecars
            .iter()
            .filter_map(|s| s.host_api.as_ref())
            .any(|h| h.grants.iter().any(|g| g == grant))
}
