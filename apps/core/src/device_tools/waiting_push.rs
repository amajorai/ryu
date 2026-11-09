//! "Ryu needs your phone": a content-free push when a device-tool call starts
//! waiting for a phone.
//!
//! When no phone of the caller can take a call (none is in the foreground),
//! dispatch announces `waiting_device` once and waits. This sends the caller's
//! registered Expo push devices one generic push, so a locked phone learns it
//! should open Ryu. It is sent at most once per tool call, and it never names
//! the tool, the app, the conversation or anything the call carries: the
//! payload is a fixed title and body, localized per device, and a fixed
//! `data.kind`.
//!
//! Who receives it follows the device principal: a verified user's own
//! registered devices; for the owner of an unbound personal node (no user
//! identity to match), only the devices registered without a member id. A
//! verified member's phone registered on the same node never hears about the
//! owner's calls.

use std::collections::{HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use super::identity::DevicePrincipal;
use crate::i18n::{messages, Message};
use crate::notify::store::PushTarget;

/// The `data.kind` the phone app routes on. Nothing else rides along.
pub(crate) const PUSH_KIND: &str = "device_tools.waiting";
/// How many recent call ids are remembered for the once-per-call rule.
const REMEMBERED_CALLS: usize = 1024;

/// Remembers which calls already pushed, bounded to the most recent ones.
#[derive(Debug, Default)]
pub(crate) struct SentCalls {
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl SentCalls {
    /// Record `call_id`; `true` only the first time it is seen.
    pub(crate) fn first_time(&mut self, call_id: &str) -> bool {
        if call_id.is_empty() || self.seen.contains(call_id) {
            return false;
        }
        if self.order.len() >= REMEMBERED_CALLS {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        self.order.push_back(call_id.to_owned());
        self.seen.insert(call_id.to_owned());
        true
    }
}

fn sent_calls() -> &'static Mutex<SentCalls> {
    static SENT: OnceLock<Mutex<SentCalls>> = OnceLock::new();
    SENT.get_or_init(Mutex::default)
}

/// The content-free title and body in `locale`.
pub(crate) fn waiting_text(locale: &str) -> (String, String) {
    let title = Message::new(messages::DEVICE_WAITING_TITLE_MESSAGE).render(locale);
    let body = Message::new(messages::DEVICE_WAITING_BODY_MESSAGE).render(locale);
    (title, crate::i18n::bidi::rtl_body(body, locale))
}

/// The push payload's `data`: a fixed kind, nothing about the call.
pub(crate) fn waiting_data() -> Value {
    json!({ "kind": PUSH_KIND })
}

/// Which registered devices `principal` reaches.
pub(crate) fn audience(principal: &DevicePrincipal, devices: Vec<PushTarget>) -> Vec<PushTarget> {
    match principal {
        DevicePrincipal::User(user) => devices
            .into_iter()
            .filter(|device| device.owner.as_deref() == Some(user.as_str()))
            .collect(),
        DevicePrincipal::LocalOwner => devices
            .into_iter()
            .filter(|device| device.owner.is_none())
            .collect(),
    }
}

fn push_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Push "Ryu needs your phone" to `principal`'s devices, once for
/// `tool_call_id`. Detached and best-effort: it never delays or fails the call.
pub(crate) fn notify_waiting(principal: &DevicePrincipal, tool_call_id: &str) {
    let first = sent_calls()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .first_time(tool_call_id);
    if !first {
        return;
    }
    let Some(store) = crate::notify::global_store() else {
        return;
    };
    let principal = principal.clone();
    tokio::spawn(async move {
        let devices = match &principal {
            DevicePrincipal::User(user) => store.push_targets_for_user(user).await,
            DevicePrincipal::LocalOwner => store.push_targets_unowned().await,
        };
        let devices = match devices {
            Ok(devices) => audience(&principal, devices),
            Err(error) => {
                tracing::warn!(%error, "device-tools: could not read push tokens");
                return;
            }
        };
        if devices.is_empty() {
            return;
        }
        let node_locale = crate::i18n::locale::node_locale().await;
        for (locale, tokens) in crate::notify::tokens_by_locale(&devices, node_locale) {
            let (title, body) = waiting_text(locale);
            ryu_notify::push_expo_message(push_client(), &tokens, &title, &body, waiting_data())
                .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(token: &str, owner: Option<&str>) -> PushTarget {
        PushTarget {
            token: token.to_owned(),
            owner: owner.map(str::to_owned),
            locale: None,
        }
    }

    #[test]
    fn a_call_pushes_at_most_once() {
        let mut sent = SentCalls::default();
        assert!(sent.first_time("call-1"));
        assert!(!sent.first_time("call-1"));
        assert!(sent.first_time("call-2"));
        assert!(!sent.first_time(""));
    }

    #[test]
    fn the_memory_is_bounded_to_recent_calls() {
        let mut sent = SentCalls::default();
        for index in 0..=REMEMBERED_CALLS {
            assert!(sent.first_time(&format!("call-{index}")));
        }
        assert_eq!(sent.order.len(), REMEMBERED_CALLS);
        // The oldest call was forgotten; the newest is still remembered.
        assert!(!sent.first_time(&format!("call-{REMEMBERED_CALLS}")));
        assert!(sent.first_time("call-0"));
    }

    #[test]
    fn the_push_carries_no_call_details() {
        let (title, body) = waiting_text("en");
        assert_eq!(title, "Ryu needs your phone");
        assert_eq!(body, "Open Ryu on your phone to continue.");
        assert_eq!(waiting_data(), json!({ "kind": PUSH_KIND }));
    }

    #[test]
    fn a_user_reaches_only_their_own_devices() {
        let devices = vec![
            device("a", Some("u1")),
            device("b", Some("u2")),
            device("c", None),
        ];
        let user = audience(&DevicePrincipal::User("u1".into()), devices.clone());
        assert_eq!(
            user.iter().map(|d| d.token.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        // The local owner reaches only unowned devices, never a member's.
        let owner = audience(&DevicePrincipal::LocalOwner, devices);
        assert_eq!(
            owner.iter().map(|d| d.token.as_str()).collect::<Vec<_>>(),
            ["c"]
        );
    }
}
