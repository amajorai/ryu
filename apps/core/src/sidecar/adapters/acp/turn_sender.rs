//! Which live ACP turn's verified sender a bridge tool call may act for.
//!
//! The in-process MCP bridge is built once per ACP instance and outlives a
//! turn, and several instances can share one conversation id (team-member and
//! delegated turns, other pooled agents, a concurrent instance). A conversation
//! id alone therefore never selects a sender. The instance that admits a turn
//! registers its sender together with its own bridge channel (the
//! `permission_tx` its bridge holds) and agent id; the bridge gets the sender
//! only when all three match. The guard clears the entry at turn end, and only
//! if it is still that turn's entry. Modelled on `device_tools::turn_context`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::mpsc::UnboundedSender;

use super::AcpEvent;
use crate::identity_verify::VerifiedCaller;

struct TurnSender {
    registration: u64,
    sender: Arc<VerifiedCaller>,
    instance: UnboundedSender<AcpEvent>,
    agent_id: String,
}

fn senders() -> &'static Mutex<HashMap<String, TurnSender>> {
    static SENDERS: OnceLock<Mutex<HashMap<String, TurnSender>>> = OnceLock::new();
    SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_registration() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(crate) struct TurnSenderGuard {
    conversation_id: String,
    registration: u64,
}

impl Drop for TurnSenderGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = senders().lock() {
            if map
                .get(&self.conversation_id)
                .is_some_and(|entry| entry.registration == self.registration)
            {
                map.remove(&self.conversation_id);
            }
        }
    }
}

/// Register the verified sender of the live turn `instance` (its bridge
/// channel) and `agent_id` serve in `conversation_id`.
pub(crate) fn register_turn_sender(
    conversation_id: &str,
    sender: Arc<VerifiedCaller>,
    instance: &UnboundedSender<AcpEvent>,
    agent_id: &str,
) -> TurnSenderGuard {
    let registration = next_registration();
    if let Ok(mut map) = senders().lock() {
        map.insert(
            conversation_id.to_owned(),
            TurnSender {
                registration,
                sender,
                instance: instance.clone(),
                agent_id: agent_id.to_owned(),
            },
        );
    }
    TurnSenderGuard {
        conversation_id: conversation_id.to_owned(),
        registration,
    }
}

/// The live turn's sender for a bridge: only for the instance (same bridge
/// channel) and agent that registered it in this conversation.
pub(crate) fn turn_sender_for(
    conversation_id: &str,
    instance: &UnboundedSender<AcpEvent>,
    agent_id: &str,
) -> Option<Arc<VerifiedCaller>> {
    let map = senders().lock().ok()?;
    let entry = map.get(conversation_id)?;
    (entry.agent_id == agent_id && entry.instance.same_channel(instance))
        .then(|| Arc::clone(&entry.sender))
}

#[cfg(test)]
#[path = "turn_sender_tests.rs"]
mod tests;
