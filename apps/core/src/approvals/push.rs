//! Mobile push for a new approval, rendered per device locale.

use super::*;
use crate::i18n::{locale, messages, Message};

impl ApprovalEngine {
    /// Fan a freshly-created request out to mobile push (best-effort). The
    /// desktop/island surface it over SSE (handled by the store broadcast); this
    /// adds Expo push so a phone learns about a pending decision while away.
    ///
    /// Every registered device is told that a decision is waiting, but only a
    /// device whose registering member may read the inbox (`approvals.view`
    /// under the node's binding, see [`approval_push_audience`]) gets the
    /// request's title and kind. Any other device, or a failed permission
    /// lookup, gets the content-free message. Each push is in the language its
    /// device registered with, else the node's `ui-language`.
    pub(super) async fn notify_created(&self, req: &ApprovalRequest) {
        let Some(push_store) = &self.push_store else {
            return;
        };
        let devices = match push_store.push_targets().await {
            Ok(devices) if !devices.is_empty() => devices,
            _ => return,
        };
        let node_locale = locale::node_locale().await;
        let audience = approval_push_audience();
        let mut decided: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
        let mut messages = Vec::with_capacity(devices.len());
        for device in &devices {
            let show = match (&audience, device.owner.as_deref()) {
                (ApprovalPushAudience::Members, Some(user)) => {
                    if let Some(known) = decided.get(user) {
                        *known
                    } else {
                        let allowed = member_may_view_approvals(&self.http, user).await;
                        decided.insert(user.to_owned(), allowed);
                        allowed
                    }
                }
                (audience, owner) => push_shows_approval_content(audience, owner),
            };
            let device_locale = locale::stored(device.locale.as_deref()).unwrap_or(node_locale);
            messages.push(approval_push_message(
                &device.token,
                req,
                show,
                device_locale,
            ));
        }
        let result = self
            .http
            .post("https://exp.host/--/api/v2/push/send")
            .json(&messages)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await;
        if let Err(e) = result {
            tracing::warn!("approvals: expo push notify failed: {e}");
        }
    }
}

/// Which registered devices may receive an approval's content in a push,
/// mirroring how `approvals.view` is enforced on this node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ApprovalPushAudience {
    /// Unbound, unmanaged node: any device registered with a verified user
    /// identity. A device registered without one (a node-token or paired
    /// client, owner `None`) is refused by the inbox here too.
    Unbound,
    /// Managed node with no organization binding: Core refuses every caller.
    Nobody,
    /// Personal node: only its owner's devices.
    Owner(Option<String>),
    /// Organization or team node: members whose effective permissions,
    /// resolved by the control plane, include `approvals.view`.
    Members,
}

pub(super) fn approval_push_audience() -> ApprovalPushAudience {
    use crate::sidecar::control_plane as cp;
    if let Some(node) = cp::registered_node() {
        if node.scope == cp::NodeScope::Personal {
            return ApprovalPushAudience::Owner(node.owner_user_id);
        }
        return ApprovalPushAudience::Members;
    }
    if cp::registered_org().is_some() {
        return ApprovalPushAudience::Members;
    }
    if cp::is_managed_node() {
        return ApprovalPushAudience::Nobody;
    }
    ApprovalPushAudience::Unbound
}

/// The decision for every audience that needs no control-plane lookup.
///
/// A device registered without a user identity never qualifies, on any node,
/// unbound ones included. The approval routes refuse a caller with no verified
/// identity before any binding check (`require_permission` in
/// `server/approvals_api.rs`), so the generic rule that admits anonymous
/// callers on an unbound node does not apply to the inbox. A push must not
/// show what the inbox would refuse.
/// [`ApprovalPushAudience::Members`] is decided by
/// [`member_may_view_approvals`]; here it is `false`.
pub(super) fn push_shows_approval_content(
    audience: &ApprovalPushAudience,
    owner: Option<&str>,
) -> bool {
    match (audience, owner) {
        (_, None) => false,
        (ApprovalPushAudience::Unbound, Some(_)) => true,
        (ApprovalPushAudience::Owner(node_owner), Some(user)) => {
            node_owner.as_deref() == Some(user)
        }
        (ApprovalPushAudience::Nobody | ApprovalPushAudience::Members, Some(_)) => false,
    }
}

/// Whether the control plane grants `user` `approvals.view` on this node's
/// organization (and team, for a team node). The answer includes the member's
/// built-in role tier. An outage or a refusal is `false`.
pub(super) async fn member_may_view_approvals(http: &reqwest::Client, user: &str) -> bool {
    crate::sidecar::control_plane::try_resolve_permission_context(http, user)
        .await
        .is_ok_and(|resolved| {
            resolved
                .permissions
                .contains(crate::identity_verify::permissions::APPROVALS_VIEW)
        })
}

/// One Expo push message for a new approval, in `locale`. Without
/// `show_content` it says only that a decision is waiting, plus the opaque
/// request id the app opens through the permission-checked inbox. The
/// request's title is rendered in `locale` from its messages when it has them
/// (its arguments, such as tool and job names, stay as written).
pub(super) fn approval_push_message(
    token: &str,
    req: &ApprovalRequest,
    show_content: bool,
    locale: &str,
) -> serde_json::Value {
    let title = Message::new(messages::APPROVAL_NEEDED_TITLE_MESSAGE).render(locale);
    if show_content {
        serde_json::json!({
            "to": token,
            "title": title,
            "body": req.localized_title(locale),
            "sound": "default",
            "data": { "approval_id": req.id, "kind": req.kind },
        })
    } else {
        serde_json::json!({
            "to": token,
            "title": title,
            "body": Message::new(messages::APPROVAL_WAITING_BODY_MESSAGE).render(locale),
            "sound": "default",
            "data": { "approval_id": req.id },
        })
    }
}
