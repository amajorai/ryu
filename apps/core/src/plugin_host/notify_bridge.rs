//! `host.notify` and `host.notifications_send`: bounded, informational
//! notifications from a plugin, delivered through Core's shared
//! inbox/toast/push fan-out.
//!
//! Both accept an optional `i18n` payload alongside the English `title`/`body`:
//! `{ title: { message, args }, body: [{ message, args }], join }`, the same
//! wire form an app backend sends with `notify.deliver`. With it, the inbox row
//! and desktop toast are written in the node's language and each device's push
//! in the language that device registered; without it (or when it is
//! malformed), the English text is delivered as before.

use serde_json::{json, Value};

use crate::i18n::AlertText;
use crate::tool_exec::InvokeOutcome;

use super::{
    bounded_notification_text, err, ok, PluginHookBridge, GRANT_NOTIFY, GRANT_NOTIFY_TARGET,
    MAX_NOTIFICATION_BODY_CHARS, MAX_NOTIFICATION_TARGET_CHARS, MAX_NOTIFICATION_TITLE_CHARS,
};

/// Bound a localized rendering the same way the English text is bounded.
fn clip_notification(title: String, body: String) -> (String, String) {
    (
        bounded_notification_text(Some(&title), MAX_NOTIFICATION_TITLE_CHARS),
        bounded_notification_text(Some(&body), MAX_NOTIFICATION_BODY_CHARS),
    )
}

/// The `i18n` payload of a notify call. A single body message may be given
/// as an object instead of a one-item list.
pub(super) fn localized_notification(args: &Value) -> Option<AlertText> {
    let mut wire = args.get("i18n")?.clone();
    if let Some(body) = wire.get_mut("body") {
        if body.is_object() {
            *body = Value::Array(vec![body.take()]);
        }
    }
    AlertText::from_wire(&wire)
}

impl PluginHookBridge {
    /// Deliver one notification to `user_id`, localized when the call carries
    /// a usable `i18n` payload.
    async fn deliver_plugin_notification(
        &self,
        user_id: &str,
        title: &str,
        body: &str,
        args: &Value,
    ) -> Result<String, String> {
        let Some(store) = crate::notify::global_store() else {
            return Err("notification store is not ready".to_string());
        };
        match localized_notification(args) {
            Some(text) => {
                crate::notify::deliver_localized_app_notification(
                    &store,
                    &self.plugin_id,
                    user_id,
                    &text,
                    "info",
                    clip_notification,
                )
                .await
            }
            None => {
                crate::notify::deliver_app_notification(
                    &store,
                    &self.plugin_id,
                    user_id,
                    title,
                    body,
                    "info",
                )
                .await
            }
        }
    }

    /// `host.notify({ title, body, i18n? })` — deliver one bounded,
    /// informational notification for the active user through Core's shared
    /// inbox/toast/push fan-out. This is intentionally not an app-host RPC or an
    /// external-target alert primitive: a plugin cannot choose a recipient,
    /// channel, or level.
    pub(super) async fn notify(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_NOTIFY) {
            return err(format!(
                "capability '{GRANT_NOTIFY}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let title = bounded_notification_text(
            args.get("title").and_then(Value::as_str),
            MAX_NOTIFICATION_TITLE_CHARS,
        );
        if title.is_empty() {
            return err("host.notify requires a usable 'title'".to_string());
        }
        let body = bounded_notification_text(
            args.get("body").and_then(Value::as_str),
            MAX_NOTIFICATION_BODY_CHARS,
        );
        if crate::notify::global_store().is_none() {
            return err("host.notify unavailable: notification store is not ready".to_string());
        }
        let active_user_id = crate::auth::load_accounts().active_user_id;
        let user_id = self
            .verified_caller
            .as_ref()
            .map(|caller| caller.user_id.clone())
            .or_else(|| self.storage_tenant.clone())
            .or(active_user_id);
        let Some(user_id) = user_id else {
            return err("host.notify unavailable: no active user".to_string());
        };
        match self
            .deliver_plugin_notification(&user_id, &title, &body, &args)
            .await
        {
            Ok(notification_id) => {
                ok(json!({ "queued": true, "notification_id": notification_id }))
            }
            Err(error) => err(format!("host.notify failed: {error}")),
        }
    }

    /// `host.notifications_send({ target_user_id, title, body, i18n? })` —
    /// deliver one bounded informational notification to a member in the
    /// node's resolved organization/team scope. This is the Inbox app's
    /// explicit-recipient bridge; the older `host.notify` path remains
    /// active-user-only.
    pub(super) async fn notifications_send(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_NOTIFY_TARGET) {
            return err(format!(
                "capability '{GRANT_NOTIFY_TARGET}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if self
            .verified_caller
            .as_ref()
            .and_then(|caller| caller.org_id.as_ref())
            .is_none()
        {
            return err(
                "targeted notifications require a verified organization caller".to_string(),
            );
        }
        let target_user_id = bounded_notification_text(
            args.get("target_user_id").and_then(Value::as_str),
            MAX_NOTIFICATION_TARGET_CHARS,
        );
        if target_user_id.is_empty() {
            return err("host.notifications_send requires a usable 'target_user_id'".to_string());
        }
        let title = bounded_notification_text(
            args.get("title").and_then(Value::as_str),
            MAX_NOTIFICATION_TITLE_CHARS,
        );
        if title.is_empty() {
            return err("host.notifications_send requires a usable 'title'".to_string());
        }
        let body = bounded_notification_text(
            args.get("body").and_then(Value::as_str),
            MAX_NOTIFICATION_BODY_CHARS,
        );
        let members =
            match crate::sidecar::control_plane::resolve_notify_targets(&self.state.client, None)
                .await
            {
                Ok(members) => members,
                Err(error) => {
                    return err(format!(
                        "host.notifications_send could not resolve the recipient roster: {error}"
                    ));
                }
            };
        if !members
            .iter()
            .any(|member| member.user_id == target_user_id)
        {
            return err(
                "notification recipient is not in the resolved organization/team".to_string(),
            );
        }
        if crate::notify::global_store().is_none() {
            return err(
                "host.notifications_send unavailable: notification store is not ready".to_string(),
            );
        }
        match self
            .deliver_plugin_notification(&target_user_id, &title, &body, &args)
            .await
        {
            Ok(notification_id) => ok(json!({
                "notification_id": notification_id,
                "target_user_id": target_user_id,
            })),
            Err(error) => err(format!("host.notifications_send failed: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_i18n_accepts_a_single_body_message_and_renders_per_locale() {
        let args = json!({
            "title": "Delegation finished",
            "i18n": {
                "title": { "message": "Delegation finished" },
                "body": { "message": "{count} tasks done.", "args": { "count": 3 } },
            },
        });
        let text = localized_notification(&args).expect("usable i18n payload");
        let (title, body) = text.render("en");
        assert_eq!(title, "Delegation finished");
        assert_eq!(body, "3 tasks done.");
    }

    #[test]
    fn notify_without_or_with_malformed_i18n_keeps_the_english_text() {
        assert!(localized_notification(&json!({ "title": "x" })).is_none());
        assert!(localized_notification(&json!({ "i18n": { "title": 7 } })).is_none());
    }

    #[test]
    fn localized_renderings_are_bounded_like_the_english_text() {
        let (title, body) = clip_notification("t".repeat(500), "b\u{0000}".repeat(3_000));
        assert_eq!(title.chars().count(), MAX_NOTIFICATION_TITLE_CHARS);
        assert_eq!(body.chars().count(), MAX_NOTIFICATION_BODY_CHARS);
    }
}
