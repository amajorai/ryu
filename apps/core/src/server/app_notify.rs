//! The **app→inbox notification** kernel capability (`notify.deliver`).
//!
//! The generic seam that lets ANY enabled app (not just `@ryu/monitors`, which
//! owns the `notify.fanout` external fan-out) deliver a user-targeted
//! notification into the app-inbox feed — the same feed a workflow `notify_user`
//! step writes to. The desktop renders it in the Inbox; the icon/name shown for
//! each row is resolved from the row's `source_app_id`, which is derived HERE from
//! the authenticated sidecar token, never accepted from the body.
//!
//! Gate: a minted ext token for an ENABLED app. Writing to the node's own active
//! user under the caller's own attribution needs nothing more; that is the seam's
//! purpose. Naming any OTHER recipient (`target_user_id` that is not the active
//! account) additionally requires the Gateway-approved `notifications:send-to-user`
//! grant, the same reviewed scope that gates the `host.notifications_send` bridge
//! verb, plus org-roster membership of the recipient on a managed node. Without
//! that grant check any enabled app could put rows in another member's Inbox.
//! `notify.fanout` (below) is a separate `grant: None` row that stays pinned to
//! `@ryu/monitors`.
//!
//! Localizable text (additive): besides the English `title`/`body`, a caller may
//! send `i18n`, the same `{ title, body, join }` message object `notify.fanout`
//! takes as `alert.i18n` ([`crate::i18n::AlertText`]). Core then writes the inbox
//! row and toast in the node's `ui-language` and each push in the locale its
//! device registered with. A malformed `i18n` is ignored and the English text is
//! delivered, so an older or newer producer never loses its notification.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::sidecar::ext_proxy::authenticate_sidecar;

const MAX_NOTIFY_TITLE_BYTES: usize = 256;
const MAX_NOTIFY_BODY_BYTES: usize = 16 * 1024;
const MAX_NOTIFY_TARGET_BYTES: usize = 256;

/// Request body for `POST /api/host/capability/notify.deliver`.
#[derive(Debug, Deserialize)]
pub struct DeliverBody {
    /// The notification title (shown as the row's headline).
    pub title: String,
    /// Optional body text.
    #[serde(default)]
    pub body: Option<String>,
    /// One of `info` | `success` | `warning` | `error`. Defaults to `info`.
    #[serde(default)]
    pub level: Option<String>,
    /// The member to deliver to. Optional on an unbound local (single-user) node,
    /// where delivery falls back to the active account; on an org-bound node the
    /// caller should name its target explicitly.
    #[serde(default)]
    pub target_user_id: Option<String>,
    /// Optional localizable text: `{ title: { message, args }, body: [{ message,
    /// args }], join: "lines" | "sentences" }`, an English ICU source plus named
    /// arguments per message. `title`/`body` stay required as the English text.
    #[serde(default)]
    pub i18n: Option<serde_json::Value>,
    /// Optional tap target: a `ryu://apps/<this app id>/…` deep link
    /// ([`ryu_app_events::NotifyHint::link_is_valid_for`]). Any other link is
    /// refused with 400.
    #[serde(default)]
    pub link: Option<String>,
}

/// `POST /api/host/capability/notify.deliver` — raise a user-targeted
/// notification on behalf of the authenticated app. The row is persisted to the
/// app-inbox feed (with `source_app_id` = the caller), mirrored to the desktop
/// toast stream, and pushed to the target member's registered devices.
///
/// The handler authenticates the caller and resolves the recipient itself, so an
/// app cannot spoof whose notification this is or target an arbitrary member on a
/// shared node without naming them in a body the host still controls.
pub(crate) async fn host_notify_deliver(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<DeliverBody>,
) -> Response {
    let (plugin_id, grants) = match authenticate_sidecar(&state, &headers).await {
        Ok(caller) => caller,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    let text = body
        .i18n
        .as_ref()
        .and_then(crate::i18n::AlertText::from_wire);
    match deliver_for_app_localized(
        &state.client,
        &plugin_id,
        &grants,
        body.target_user_id.as_deref(),
        &body.title,
        body.body.as_deref().unwrap_or(""),
        body.level.as_deref(),
        text.as_ref(),
        body.link.as_deref(),
    )
    .await
    {
        Ok((notification_id, user_id)) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "notification_id": notification_id, "source_app_id": plugin_id, "target_user_id": user_id })),
        )
            .into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

/// The reviewed grant that lets an app choose a recipient other than the node's
/// active user.
const SEND_TO_USER_GRANT: &str = "notifications:send-to-user";

/// Whether `grants` allow delivering to `target_user_id`. The node's own active
/// user (or no explicit target) is always allowed; any other member needs
/// [`SEND_TO_USER_GRANT`].
fn may_target_recipient(
    grants: &std::collections::HashSet<String>,
    target_user_id: Option<&str>,
    active_user_id: Option<&str>,
) -> bool {
    match target_user_id.map(str::trim).filter(|t| !t.is_empty()) {
        None => true,
        Some(target) if Some(target) == active_user_id => true,
        Some(_) => grants.contains(SEND_TO_USER_GRANT),
    }
}

/// Deliver a notification on behalf of an authenticated app, resolving the
/// recipient (an explicit target wins; otherwise the node's active account) and
/// stamping `source_app_id` with the caller. Shared by `notify.deliver` and the
/// optional `notify` hint on `events.emit`, so the two seams deliver identically.
/// `grants` is the caller's Gateway-approved grant set from `authenticate_sidecar`.
/// Optional localizable `text`, when present, replaces the English
/// `title`/`body` on every channel, rendered per locale. An optional `link`
/// must be a deep link into `plugin_id` itself (else 400) and rides the toast
/// and the push `data`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn deliver_for_app_localized(
    client: &reqwest::Client,
    plugin_id: &str,
    grants: &std::collections::HashSet<String>,
    target_user_id: Option<&str>,
    title: &str,
    body: &str,
    level: Option<&str>,
    text: Option<&crate::i18n::AlertText>,
    link: Option<&str>,
) -> Result<(String, String), (StatusCode, String)> {
    let title = title.trim();
    if let Err(message) = validate_notify_input(title, body, target_user_id) {
        return Err((StatusCode::BAD_REQUEST, message.to_owned()));
    }
    if link.is_some_and(|link| !ryu_app_events::NotifyHint::link_is_valid_for(plugin_id, link)) {
        return Err((
            StatusCode::BAD_REQUEST,
            "notification link must be a ryu://apps/<calling app id> deep link".to_owned(),
        ));
    }
    let Some(store) = crate::notify::global_store() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "notify store not ready".to_string(),
        ));
    };

    let active_user_id = crate::auth::load_accounts().active_user_id;
    if !may_target_recipient(grants, target_user_id, active_user_id.as_deref()) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("notifying another member requires the {SEND_TO_USER_GRANT} grant"),
        ));
    }

    // Resolve the recipient: an explicit target wins; otherwise the node's active
    // account (the local single-user case that most apps run in).
    let user_id = match target_user_id.filter(|s| !s.trim().is_empty()) {
        Some(target) => target.to_owned(),
        None => match active_user_id {
            Some(active) => active,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "no recipient: pass target_user_id or have an active account".to_string(),
                ));
            }
        },
    };

    // On a managed node the control plane is the source of truth for tenancy.
    // A valid sidecar token identifies the app, not an arbitrary member, so
    // explicit and fallback recipients must both be present in the current
    // org roster. Any roster lookup failure rejects delivery rather than
    // silently turning an unavailable policy check into allow-all.
    if crate::sidecar::control_plane::registered_org().is_some() {
        let members = crate::sidecar::control_plane::resolve_notify_targets(client, None)
            .await
            .map_err(|e| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("cannot verify notification recipient membership: {e}"),
                )
            })?;
        if !target_is_org_member(&user_id, &members) {
            return Err((
                StatusCode::FORBIDDEN,
                "notification recipient is not a member of this organization".to_owned(),
            ));
        }
    }

    let level = level.filter(|l| !l.trim().is_empty()).unwrap_or("info");
    let level = match level {
        "success" | "warning" | "error" => level,
        _ => "info",
    };

    let delivered = match text {
        Some(text) => {
            crate::notify::deliver_localized_app_notification_linked(
                &store,
                plugin_id,
                &user_id,
                text,
                level,
                link,
                clip_rendered,
            )
            .await
        }
        None => {
            crate::notify::deliver_app_notification_linked(
                &store, plugin_id, &user_id, title, body, level, link,
            )
            .await
        }
    };
    match delivered {
        Ok(notification_id) => Ok((notification_id, user_id)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

/// Bound a rendered title and body like the plain text (a translation may be
/// longer than its English), cutting on a char boundary.
fn clip_rendered(title: String, body: String) -> (String, String) {
    fn clip(mut text: String, max: usize) -> String {
        if text.len() > max {
            let mut end = max;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        text
    }
    (
        clip(title, MAX_NOTIFY_TITLE_BYTES),
        clip(body, MAX_NOTIFY_BODY_BYTES),
    )
}

fn validate_notify_input(
    title: &str,
    body: &str,
    target_user_id: Option<&str>,
) -> Result<(), &'static str> {
    if title.trim().is_empty() {
        return Err("notification title must not be empty");
    }
    if title.len() > MAX_NOTIFY_TITLE_BYTES {
        return Err("notification title is too long");
    }
    if body.len() > MAX_NOTIFY_BODY_BYTES {
        return Err("notification body is too long");
    }
    if target_user_id
        .filter(|target| !target.trim().is_empty())
        .is_some_and(|target| target.len() > MAX_NOTIFY_TARGET_BYTES)
    {
        return Err("notification target is too long");
    }
    Ok(())
}

fn target_is_org_member(
    user_id: &str,
    members: &[crate::sidecar::control_plane::NotifyTargetUser],
) -> bool {
    members.iter().any(|member| member.user_id == user_id)
}

// ── `notify.fanout`: external channel fan-out of a fired alert ──────────────────

/// The `{ alert, targets }` body `notify.fanout` takes.
#[derive(Deserialize)]
pub(crate) struct AlertFanoutBody {
    /// The fired alert (`title`, `message`, `monitor_id`, `monitor_name`, `kind`,
    /// `created_at`).
    alert: serde_json::Value,
    /// The alert's own notification channels.
    #[serde(default)]
    targets: Vec<ryu_notify::NotifyTarget>,
}

/// `POST /api/host/capability/notify.fanout` — fan a fired alert out through the
/// kernel notify store (the alert's channels + global mobile push +
/// `notification` plugin hooks), copy it into the app inbox, and record it on the
/// unified activity feed.
///
/// Gate: the caller's minted ext token and a pin to the one app this was built for
/// (`@ryu/monitors`); the `KERNEL_CAPABILITIES` row carries no grant.
///
/// The pin was reviewed against the existing Gateway vocabulary on 2026-10-11 and
/// kept. The three notification grants each cover a narrower, single-recipient,
/// in-product delivery, none of them this operation:
///
/// - `notifications:send` (`host.notify`) raises one bounded notification for the
///   active user, and by design a plugin cannot choose the recipient or channel;
/// - `notifications:send-to-user` (`host.notifications_send`) reaches one member of
///   the resolved organization/team, for a verified organization caller;
/// - `native:notifications` is a bounded native host effect on the receiving
///   surface.
///
/// This handler instead delivers to external channels the CALLER chooses (webhook
/// URLs, Telegram bots, Expo tokens, email recipients over the node's SMTP), plus
/// node-wide mobile push and every `notification` plugin hook, and writes an
/// activity row attributed to "monitors". Replacing the pin needs a new reviewed
/// scope for that reach: a Gateway governance change. See
/// `docs/app-boundary-extraction-plan.md` (step 6).
pub(crate) async fn host_notify_fanout(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<AlertFanoutBody>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    if plugin_id != crate::plugins::builtins::MONITORS_PLUGIN_ID {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the monitors app" })),
        )
            .into_response();
    }

    let alert = &body.alert;
    let text = |key: &str| {
        alert
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let (title, message, monitor_id, kind) = (
        text("title"),
        text("message"),
        text("monitor_id"),
        text("kind"),
    );

    // (1) External fan-out through the kernel notify store.
    if let Some(store) = crate::notify::global_store() {
        let fanout = crate::notify::FanoutAlert {
            title: title.clone(),
            message: message.clone(),
            data: json!({ "monitor_id": monitor_id, "kind": kind }),
            hook_event: alert.clone(),
        };
        crate::notify::notify_all(&state.client, &store, &body.targets, &fanout).await;

        // (1b) App-inbox copy: the same alert lands in the user's Inbox feed with
        // `source_app_id` = the caller, so the desktop shows the app's icon and a
        // per-user read/archive trail.
        let level = if kind == "uptime_down" {
            "warning"
        } else {
            "info"
        };
        if let Some(active) = crate::auth::load_accounts().active_user_id {
            if let Err(e) = inbox_copy_of_alert(&store, &plugin_id, &active, alert, level).await {
                tracing::warn!("notify.fanout: inbox copy failed: {e}");
            }
        }
    } else {
        tracing::warn!("notify.fanout: notify store not ready; dropping alert fan-out");
    }

    // (2) Unified activity feed.
    let item = activity_item_from_alert(alert, crate::i18n::locale::node_locale().await);
    if let Err(e) = state.activity.record(item).await {
        tracing::warn!("activity: failed to record monitor alert: {e:#}");
    }

    Json(json!({ "ok": true })).into_response()
}

/// The inbox copy of a fanned-out alert: the inbox row and the desktop toast,
/// with no push. `notify_all` already pushed to every registered device (the
/// active member's included, each in its own locale), so pushing here would
/// reach that member's phone twice. With a well-formed `alert.i18n` the copy is
/// written in the node's `ui-language`; otherwise it is the English text.
async fn inbox_copy_of_alert(
    store: &crate::notify::NotifyStore,
    plugin_id: &str,
    user_id: &str,
    alert: &serde_json::Value,
    level: &str,
) -> Result<String, String> {
    let node_locale = crate::i18n::locale::node_locale().await;
    let (title, body) = alert_inbox_text(alert, node_locale);
    let id = format!("ntf_{}", uuid::Uuid::new_v4().simple());
    crate::notify::persist_and_toast(store, &id, user_id, &title, &body, level, Some(plugin_id))
        .await?;
    Ok(id)
}

/// The inbox title and body of a fired alert in `locale`: its `i18n` rendered
/// (and clipped like `notify.deliver` text) when that parses, else its English
/// `title`/`message`.
fn alert_inbox_text(alert: &serde_json::Value, locale: &str) -> (String, String) {
    if let Some(text) = alert
        .get("i18n")
        .and_then(crate::i18n::AlertText::from_wire)
    {
        let (title, body) = text.render(locale);
        return clip_rendered(title, body);
    }
    let text = |key: &str| {
        alert
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    (text("title"), text("message"))
}

/// Map a fired alert into an activity item worded like its inbox copy in `locale`.
fn activity_item_from_alert(alert: &serde_json::Value, locale: &str) -> ryu_activity::ActivityItem {
    let text = |key: &str| {
        alert
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    let kind = text("kind");
    let level = if kind == "uptime_down" {
        ryu_activity::ActivityLevel::Warning
    } else {
        ryu_activity::ActivityLevel::Info
    };
    let (title, body) = alert_inbox_text(alert, locale);
    ryu_activity::ActivityItem::new("monitor_alert", "monitors", title)
        .with_body(Some(body))
        .with_level(level)
        .with_metadata(json!({
            "monitor_id": text("monitor_id"),
            "monitor_name": text("monitor_name"),
            "alert_kind": kind,
        }))
        .with_created_at(epoch_secs(text("created_at")))
}

/// Parse an RFC3339 timestamp into epoch seconds, falling back to "now" so a
/// malformed source timestamp never drops an item.
fn epoch_secs(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|d| d.timestamp())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp())
}

#[cfg(test)]
#[path = "app_notify_test.rs"]
mod tests;
