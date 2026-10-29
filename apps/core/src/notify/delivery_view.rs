//! The HTTP view of the node-level alert delivery targets
//! (`GET`/`PUT /api/alerts/delivery`).
//!
//! A GET never returns a stored credential: the Telegram `bot_token`, the
//! webhook `url` (a Slack/Discord incoming-webhook URL is itself the bearer
//! secret) and the Expo push `token` are replaced by
//! [`ryu_crypto::redact::REDACTED`]. Each such target also carries
//!
//! - `secret_ref`: an opaque handle naming which stored credential it stands
//!   for, an HMAC under a random key that lives only in this Core process (it
//!   reveals nothing about the secret and stops matching after a restart);
//! - `preview` (webhooks only): the URL's host, so a person can tell entries
//!   apart.
//!
//! A PUT that echoes a target with the placeholder and its `secret_ref` keeps
//! the stored credential; a placeholder whose `secret_ref` no longer matches a
//! stored target is refused, so a stale form can never store the placeholder as
//! the credential.

use std::sync::OnceLock;

use ryu_crypto::redact;
use ryu_notify::{AlertDeliveryTargets, NotifyTarget};
use serde_json::{json, Value};

/// Field added to a redacted target in the GET view.
pub const SECRET_REF_FIELD: &str = "secret_ref";
/// Host preview added to a redacted webhook target in the GET view.
pub const PREVIEW_FIELD: &str = "preview";

fn ref_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(rand::random)
}

/// The credential a target carries, if any, with its JSON field name.
fn credential(target: &NotifyTarget) -> Option<(&'static str, &str)> {
    match target {
        NotifyTarget::Webhook { url } => Some(("url", url)),
        NotifyTarget::Telegram { bot_token, .. } => Some(("bot_token", bot_token)),
        NotifyTarget::ExpoPush { token } => Some(("token", token)),
        NotifyTarget::Email { .. } => None,
    }
}

fn kind_of(target: &NotifyTarget) -> &'static str {
    match target {
        NotifyTarget::Webhook { .. } => "webhook",
        NotifyTarget::Telegram { .. } => "telegram",
        NotifyTarget::ExpoPush { .. } => "expo_push",
        NotifyTarget::Email { .. } => "email",
    }
}

fn secret_ref(target: &NotifyTarget) -> Option<String> {
    let (_, secret) = credential(target)?;
    let mut message = kind_of(target).as_bytes().to_vec();
    message.push(0);
    message.extend_from_slice(secret.as_bytes());
    Some(ryu_crypto::hmac_sha256_hex(ref_key(), &message)[..32].to_owned())
}

fn webhook_host(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
}

/// The GET body: targets with every credential redacted, plus the recipients.
pub fn redacted_view(cfg: &AlertDeliveryTargets) -> Value {
    let targets: Vec<Value> = cfg
        .targets
        .iter()
        .map(|target| {
            let mut value = serde_json::to_value(target).unwrap_or(Value::Null);
            if let Some((field, secret)) = credential(target) {
                if !secret.is_empty() {
                    value[field] = Value::String(redact::REDACTED.to_owned());
                    if let Some(handle) = secret_ref(target) {
                        value[SECRET_REF_FIELD] = Value::String(handle);
                    }
                }
                if let NotifyTarget::Webhook { url } = target {
                    if let Some(host) = webhook_host(url) {
                        value[PREVIEW_FIELD] = Value::String(host);
                    }
                }
            }
            value
        })
        .collect();
    json!({ "targets": targets, "emails": cfg.emails })
}

/// Turn the PUT body's targets back into stored targets, keeping the stored
/// credential wherever the client echoed the placeholder with a matching
/// `secret_ref`.
pub fn merge_put(
    incoming: Vec<Value>,
    current: &AlertDeliveryTargets,
) -> Result<Vec<NotifyTarget>, String> {
    let mut merged = Vec::with_capacity(incoming.len());
    for (index, mut value) in incoming.into_iter().enumerate() {
        let handle = value
            .as_object_mut()
            .and_then(|object| {
                object.remove(PREVIEW_FIELD);
                object.remove(SECRET_REF_FIELD)
            })
            .and_then(|handle| handle.as_str().map(str::to_owned));
        let mut target: NotifyTarget = serde_json::from_value(value)
            .map_err(|error| format!("target #{index} is invalid: {error}"))?;
        let is_placeholder = credential(&target).is_some_and(|(_, v)| redact::is_placeholder(v));
        if is_placeholder {
            let stored = handle
                .as_deref()
                .and_then(|handle| {
                    current.targets.iter().find(|stored| {
                        kind_of(stored) == kind_of(&target)
                            && secret_ref(stored).as_deref() == Some(handle)
                    })
                })
                .ok_or_else(|| {
                    format!(
                        "target #{index} sent a redacted credential that no longer matches a stored {} target; reload and enter it again",
                        kind_of(&target)
                    )
                })?;
            let secret = credential(stored)
                .map(|(_, v)| v.to_owned())
                .unwrap_or_default();
            match &mut target {
                NotifyTarget::Webhook { url } => *url = secret,
                NotifyTarget::Telegram { bot_token, .. } => *bot_token = secret,
                NotifyTarget::ExpoPush { token } => *token = secret,
                NotifyTarget::Email { .. } => {}
            }
        }
        merged.push(target);
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> AlertDeliveryTargets {
        AlertDeliveryTargets {
            targets: vec![
                NotifyTarget::Webhook {
                    url: "https://hooks.slack.test/services/T0/B0/first-secret".into(),
                },
                NotifyTarget::Webhook {
                    url: "https://discord.test/api/webhooks/1/second-secret".into(),
                },
                NotifyTarget::Telegram {
                    bot_token: "123:telegram-secret".into(),
                    chat_id: "42".into(),
                },
                NotifyTarget::ExpoPush {
                    token: "ExponentPushToken[expo-secret]".into(),
                },
            ],
            emails: vec!["ops@example.test".into()],
        }
    }

    #[test]
    fn get_view_never_contains_a_credential() {
        let view = redacted_view(&stored());
        let text = view.to_string();
        for secret in [
            "first-secret",
            "second-secret",
            "telegram-secret",
            "expo-secret",
        ] {
            assert!(!text.contains(secret), "{secret} leaked into the GET view");
        }
        assert_eq!(view["targets"][0]["url"], redact::REDACTED);
        assert_eq!(view["targets"][0]["preview"], "hooks.slack.test");
        assert_eq!(view["targets"][2]["chat_id"], "42");
        assert_eq!(view["emails"][0], "ops@example.test");
    }

    #[test]
    fn put_of_the_view_keeps_stored_credentials_and_order_changes() {
        let current = stored();
        let view = redacted_view(&current);
        let mut targets = view["targets"].as_array().unwrap().clone();
        // Drop the first webhook and add a new one: the remaining placeholder
        // must resolve to the SECOND stored URL, not by position.
        targets.remove(0);
        targets.push(json!({ "kind": "webhook", "url": "https://new.test/hook" }));
        let merged = merge_put(targets, &current).unwrap();
        assert_eq!(merged[0], current.targets[1]);
        assert_eq!(merged[1], current.targets[2]);
        assert_eq!(merged[2], current.targets[3]);
        assert_eq!(
            merged[3],
            NotifyTarget::Webhook {
                url: "https://new.test/hook".into()
            }
        );
    }

    #[test]
    fn placeholder_without_a_matching_ref_is_refused() {
        let current = stored();
        let stale =
            vec![json!({ "kind": "webhook", "url": redact::REDACTED, "secret_ref": "nope" })];
        assert!(merge_put(stale, &current).is_err());
        let bare = vec![json!({ "kind": "telegram", "bot_token": "***", "chat_id": "42" })];
        assert!(merge_put(bare, &current).is_err());
    }
}
