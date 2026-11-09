//! The verified sender of a live Gateway-plane chat turn, bound to the
//! host-conversation proof that turn's tool calls relay.
//!
//! A native agent's tool loop runs in the Gateway and calls back to
//! `/api/mcp/tools/call` anonymously with `host_conversation_id` and Core's
//! proof. The proof is per conversation, so it cannot say which turn (or whose
//! turn) a call serves. When the turn's verified author owns the conversation,
//! Core appends a random per-turn token (`<proof>.<token>`) registered here
//! with that author; the token lives exactly as long as the turn's stream holds
//! its [`GatewayTurnToken`]. Unknown, removed, or other-conversation tokens
//! yield no sender and the call keeps the owner-only filter.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::identity_verify::VerifiedCaller;

/// Live turns beyond this are not registered (they keep the owner-only
/// filter). Entries are removed at turn end, so this only bounds a leak.
const MAX_LIVE_TURNS: usize = 4_096;

struct Entry {
    conversation_id: String,
    sender: Arc<VerifiedCaller>,
}

fn turns() -> &'static Mutex<HashMap<String, Entry>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One live turn's registration. Dropping it removes the token.
pub(crate) struct GatewayTurnToken {
    conversation_id: String,
    token: Option<String>,
}

impl GatewayTurnToken {
    /// The proof the turn's Gateway hop relays: Core's base proof for the
    /// conversation, suffixed with the turn token when it was registered.
    pub(crate) fn host_conversation_proof(&self) -> String {
        let base = super::host_conversation_proof(&self.conversation_id);
        match &self.token {
            Some(token) => format!("{base}.{token}"),
            None => base,
        }
    }
}

impl Drop for GatewayTurnToken {
    fn drop(&mut self) {
        if let (Some(token), Ok(mut map)) = (self.token.as_ref(), turns().lock()) {
            map.remove(token);
        }
    }
}

fn new_token() -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
}

/// Register `sender` as the author of a live turn in `conversation_id`. The
/// caller must already have checked that the sender owns the conversation.
pub(crate) fn register_gateway_turn_sender(
    conversation_id: &str,
    sender: Arc<VerifiedCaller>,
) -> GatewayTurnToken {
    let token = turns().lock().ok().and_then(|mut map| {
        if map.len() >= MAX_LIVE_TURNS {
            return None;
        }
        let token = new_token();
        map.insert(
            token.clone(),
            Entry {
                conversation_id: conversation_id.to_owned(),
                sender,
            },
        );
        Some(token)
    });
    GatewayTurnToken {
        conversation_id: conversation_id.to_owned(),
        token,
    }
}

/// The live turn sender a relayed proof names: only when the proof's base is
/// valid for `conversation_id` and its token is registered for that same
/// conversation.
pub(in crate::server) fn gateway_turn_sender(
    conversation_id: &str,
    proof: &str,
) -> Option<Arc<VerifiedCaller>> {
    if !super::host_conversation_proof_is_valid(conversation_id, proof) {
        return None;
    }
    let (_, token) = proof.split_once('.')?;
    let map = turns().lock().ok()?;
    let entry = map.get(token)?;
    (entry.conversation_id == conversation_id).then(|| Arc::clone(&entry.sender))
}

#[cfg(test)]
#[path = "gateway_turn_sender_tests.rs"]
mod tests;
