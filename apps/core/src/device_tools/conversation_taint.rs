//! A conversation's private device read outside its own live device turn.
//!
//! A device read marks the live turn (`taint`). The agent keeps the raw result
//! after that turn: in a later turn the phone is not part of, after the turn's
//! guard is dropped, and in a team or delegated instance on the same
//! conversation. So the guards that act after a device read (the broker
//! `propose` refusal, the bridge's exfiltration scope and the agent's own
//! egress hold) also ask [`conversation_private_read`], which looks, in order,
//! at the conversation's live device turn whatever instance serves it, a read
//! recorded when a private device turn of it ended (the stored history may not
//! hold it yet), and the stored history. A history that cannot be read is an
//! error, so callers fail closed.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::server::conversations::ConversationStore;

/// More remembered conversations than this resets the set. A cleared entry
/// only drops back to the stored history check, which finds a read that was
/// written; only a read that was never written is lost then.
const MAX_REMEMBERED: usize = 4_096;

/// The source a hold names when the history could not be checked.
pub(crate) const UNCHECKED_HISTORY: &str = "an unreadable conversation history";

fn remembered() -> &'static Mutex<HashMap<String, String>> {
    static REMEMBERED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    REMEMBERED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record that `conversation_id` read private device data with `source`. Kept
/// for the life of the process: a conversation never becomes clean again.
pub(crate) fn remember_private_read(conversation_id: &str, source: &str) {
    if conversation_id.is_empty() {
        return;
    }
    if let Ok(mut map) = remembered().lock() {
        if map.len() >= MAX_REMEMBERED && !map.contains_key(conversation_id) {
            map.clear();
        }
        map.entry(conversation_id.to_owned())
            .or_insert_with(|| source.to_owned());
    }
}

fn remembered_read(conversation_id: &str) -> Option<String> {
    remembered().lock().ok()?.get(conversation_id).cloned()
}

/// The device read that makes `conversation_id` private outside the caller's
/// own turn, or `None`. With no `store` only the live turn and the remembered
/// reads are checked. `Err` when the stored history cannot be read.
pub(crate) async fn conversation_private_read(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> anyhow::Result<Option<String>> {
    if conversation_id.is_empty() {
        return Ok(None);
    }
    let live = super::turn_context::live_offer_for_conversation(conversation_id)
        .and_then(|offer| super::taint::private_read_source(&offer));
    if let Some(source) = live.or_else(|| remembered_read(conversation_id)) {
        return Ok(Some(source));
    }
    let Some(store) = store else {
        return Ok(None);
    };
    let found = super::taint::history_private_read(store, conversation_id).await?;
    if let Some(source) = found.as_deref() {
        remember_private_read(conversation_id, source);
    }
    Ok(found)
}

/// [`conversation_private_read`] for a hold: the read, or
/// [`UNCHECKED_HISTORY`] when the history cannot be read.
pub(crate) async fn conversation_hold(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> Option<String> {
    conversation_private_read(store, conversation_id)
        .await
        .unwrap_or_else(|_| Some(UNCHECKED_HISTORY.to_owned()))
}
