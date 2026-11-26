//! Tell the user once per conversation that a paid API key is in use.
//!
//! When an API key first serves a conversation in place of a subscription
//! account, Core keeps a notice for that conversation. The desktop collects it
//! with `POST /api/conversations/{id}/paid-key-notice` and shows it. A notice
//! is handed out once; the conversations already told are saved (ids only, a
//! bounded list) so a restart does not tell them again.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::json;

use crate::server::{preferences::PreferencesStore, ServerState};

const TOLD_PREF: &str = "provider-credential-fallback-told";
/// How many conversations are remembered, in each of the two lists.
const MAX_TRACKED: usize = 500;

/// What the user is told: which provider switched and to which saved key.
/// Carries the key's label, never the key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidKeyNotice {
    /// The subscription provider whose accounts ran out.
    pub provider_id: String,
    /// The provider the API key belongs to.
    pub key_provider_id: String,
    pub account_id: String,
    pub label: String,
}

/// Notices waiting to be shown, and the conversations already told.
#[derive(Default)]
pub(crate) struct Ledger {
    restored: bool,
    waiting: BTreeMap<String, PaidKeyNotice>,
    waiting_order: VecDeque<String>,
    told: VecDeque<String>,
}

impl Ledger {
    /// Load the saved list of told conversations, once.
    pub(crate) fn restore(&mut self, told: Vec<String>) {
        if self.restored {
            return;
        }
        self.restored = true;
        for conversation in told {
            self.remember(conversation);
        }
    }

    fn remember(&mut self, conversation: String) {
        if self.told.contains(&conversation) {
            return;
        }
        if self.told.len() >= MAX_TRACKED {
            self.told.pop_front();
        }
        self.told.push_back(conversation);
    }

    /// Note that a paid key served `conversation`. Returns false when the user
    /// was already told, or a notice is already waiting.
    pub(crate) fn record(&mut self, conversation: &str, notice: PaidKeyNotice) -> bool {
        if self.told.iter().any(|told| told == conversation)
            || self.waiting.contains_key(conversation)
        {
            return false;
        }
        if self.waiting_order.len() >= MAX_TRACKED {
            if let Some(oldest) = self.waiting_order.pop_front() {
                self.waiting.remove(&oldest);
            }
        }
        self.waiting_order.push_back(conversation.to_owned());
        self.waiting.insert(conversation.to_owned(), notice);
        true
    }

    /// Hand the waiting notice out. A second call returns `None`.
    pub(crate) fn claim(&mut self, conversation: &str) -> Option<PaidKeyNotice> {
        let notice = self.waiting.remove(conversation)?;
        self.waiting_order.retain(|waiting| waiting != conversation);
        self.remember(conversation.to_owned());
        Some(notice)
    }

    /// The conversations already told, oldest first.
    pub(crate) fn told(&self) -> Vec<String> {
        self.told.iter().cloned().collect()
    }
}

fn ledger() -> MutexGuard<'static, Ledger> {
    static LEDGER: OnceLock<Mutex<Ledger>> = OnceLock::new();
    LEDGER
        .get_or_init(|| Mutex::new(Ledger::default()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

async fn ensure_restored(preferences: &PreferencesStore) {
    let restored = ledger().restored;
    if restored {
        return;
    }
    let told = match preferences.get(TOLD_PREF).await {
        Ok(Some(raw)) => serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default(),
        _ => Vec::new(),
    };
    ledger().restore(told);
}

/// Note that a paid key served `conversation` (see [`Ledger::record`]).
pub(crate) async fn record(
    preferences: &PreferencesStore,
    conversation: &str,
    notice: PaidKeyNotice,
) {
    ensure_restored(preferences).await;
    ledger().record(conversation, notice);
}

/// `POST /api/conversations/{id}/paid-key-notice`: collect the notice that a
/// paid API key is in use for this conversation. Answers `{"notice": null}`
/// when there is nothing to tell, or the user was already told.
pub async fn claim(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = crate::server::require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return response;
    }
    ensure_restored(&state.preferences).await;
    let (notice, told) = {
        let mut ledger = ledger();
        let notice = ledger.claim(&id);
        (notice, ledger.told())
    };
    if notice.is_some() {
        match serde_json::to_string(&told) {
            Ok(serialized) => {
                if let Err(error) = state.preferences.set(TOLD_PREF, &serialized).await {
                    tracing::warn!(%error, "could not save the paid key notice list");
                }
            }
            Err(error) => tracing::warn!(%error, "could not encode the paid key notice list"),
        }
    }
    Json(json!({ "notice": notice })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(label: &str) -> PaidKeyNotice {
        PaidKeyNotice {
            provider_id: "claude-pro-max".to_owned(),
            key_provider_id: "anthropic".to_owned(),
            account_id: "acct_key".to_owned(),
            label: label.to_owned(),
        }
    }

    #[test]
    fn a_conversation_is_told_once_however_often_the_key_is_used() {
        let mut ledger = Ledger::default();
        assert!(ledger.record("conversation-a", notice("Work key")));
        assert!(!ledger.record("conversation-a", notice("Work key")));
        assert_eq!(ledger.claim("conversation-a"), Some(notice("Work key")));
        assert_eq!(ledger.claim("conversation-a"), None);
        // The key keeps serving the conversation; the user is not told again.
        assert!(!ledger.record("conversation-a", notice("Work key")));
        assert_eq!(ledger.claim("conversation-a"), None);
    }

    #[test]
    fn each_conversation_gets_its_own_notice() {
        let mut ledger = Ledger::default();
        assert!(ledger.record("conversation-a", notice("Work key")));
        assert!(ledger.record("conversation-b", notice("Spare key")));
        assert_eq!(ledger.claim("conversation-b"), Some(notice("Spare key")));
        assert_eq!(ledger.claim("conversation-a"), Some(notice("Work key")));
        assert_eq!(ledger.claim("conversation-c"), None);
    }

    #[test]
    fn told_conversations_survive_a_restart() {
        let mut before = Ledger::default();
        before.record("conversation-a", notice("Work key"));
        before.claim("conversation-a");
        let saved = serde_json::to_string(&before.told()).unwrap();

        let mut after = Ledger::default();
        after.restore(serde_json::from_str(&saved).unwrap());
        assert!(!after.record("conversation-a", notice("Work key")));
        assert!(after.record("conversation-b", notice("Work key")));
        // A second restore must not wipe what happened since the first.
        after.claim("conversation-b");
        after.restore(Vec::new());
        assert_eq!(after.told(), vec!["conversation-a", "conversation-b"]);
    }

    #[test]
    fn both_lists_stay_bounded() {
        let mut ledger = Ledger::default();
        for index in 0..=MAX_TRACKED {
            assert!(ledger.record(&format!("waiting-{index}"), notice("Work key")));
        }
        // The oldest waiting notice was dropped to make room.
        assert_eq!(ledger.claim("waiting-0"), None);
        for index in 1..=MAX_TRACKED {
            assert!(ledger.claim(&format!("waiting-{index}")).is_some());
        }
        assert_eq!(ledger.told().len(), MAX_TRACKED);
        ledger.record("one-more", notice("Work key"));
        ledger.claim("one-more");
        let told = ledger.told();
        assert_eq!(told.len(), MAX_TRACKED);
        assert_eq!(told.last().map(String::as_str), Some("one-more"));
        assert!(!told.contains(&"waiting-1".to_owned()));
    }

    #[test]
    fn the_notice_names_the_key_by_label_only() {
        let value = serde_json::to_value(notice("Work key")).unwrap();
        assert_eq!(
            value,
            json!({
                "providerId": "claude-pro-max",
                "keyProviderId": "anthropic",
                "accountId": "acct_key",
                "label": "Work key",
            })
        );
    }
}
