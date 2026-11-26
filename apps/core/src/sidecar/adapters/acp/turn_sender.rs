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
//!
//! A turn's sender is not enough for a tool that asks who a call acts for: the
//! bridge outlives a turn, so an engine that keeps working for an earlier turn
//! (a background task, a sub-agent) would borrow the sender of the next one.
//! Each instance therefore also remembers, for as long as its bridge lives,
//! every sender it has served and whether it ever served a turn with none.
//! That record is matched like the live sender, by the instance's bridge
//! channel and agent id, and its guard removes it when the instance ends.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::mpsc::UnboundedSender;

use super::AcpEvent;
use crate::identity_verify::VerifiedCaller;
use crate::sidecar::mcp::search_conversations::InstanceSenders;

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

/// What one instance has served since its bridge was built.
struct InstanceMemory {
    id: u64,
    instance: UnboundedSender<AcpEvent>,
    agent_id: String,
    senders: Vec<Arc<VerifiedCaller>>,
    served_without_sender: bool,
}

fn memories() -> &'static Mutex<HashMap<String, Vec<InstanceMemory>>> {
    static MEMORIES: OnceLock<Mutex<HashMap<String, Vec<InstanceMemory>>>> = OnceLock::new();
    MEMORIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Held by an instance for as long as its bridge lives. Dropping it removes
/// that instance's record and no other.
pub(crate) struct InstanceMemoryGuard {
    conversation_id: String,
    id: u64,
}

impl InstanceMemoryGuard {
    /// Note the turn the instance is about to serve: its verified sender, or
    /// that it has none. Written before the prompt goes out, so the first tool
    /// call of the turn already sees it. A person is kept once, with the
    /// claims of their latest turn.
    pub(crate) fn remember_turn(&self, sender: Option<&Arc<VerifiedCaller>>) {
        let Ok(mut map) = memories().lock() else {
            return;
        };
        let Some(memory) = map
            .get_mut(&self.conversation_id)
            .and_then(|records| records.iter_mut().find(|record| record.id == self.id))
        else {
            return;
        };
        match sender {
            Some(sender) => {
                memory
                    .senders
                    .retain(|known| known.user_id != sender.user_id);
                memory.senders.push(Arc::clone(sender));
            }
            None => memory.served_without_sender = true,
        }
    }
}

impl Drop for InstanceMemoryGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = memories().lock() {
            if let Some(records) = map.get_mut(&self.conversation_id) {
                records.retain(|record| record.id != self.id);
                if records.is_empty() {
                    map.remove(&self.conversation_id);
                }
            }
        }
    }
}

/// Start the record of `instance` (its bridge channel) and `agent_id` in
/// `conversation_id`. The instance keeps the guard until it ends.
pub(crate) fn remember_instance(
    conversation_id: &str,
    instance: &UnboundedSender<AcpEvent>,
    agent_id: &str,
) -> InstanceMemoryGuard {
    let id = next_registration();
    if let Ok(mut map) = memories().lock() {
        map.entry(conversation_id.to_owned())
            .or_default()
            .push(InstanceMemory {
                id,
                instance: instance.clone(),
                agent_id: agent_id.to_owned(),
                senders: Vec::new(),
                served_without_sender: false,
            });
    }
    InstanceMemoryGuard {
        conversation_id: conversation_id.to_owned(),
        id,
    }
}

/// Everyone the instance has served, for its own bridge: only the instance
/// (same bridge channel) and agent that started the record in this
/// conversation get it. `None` when there is no such record.
pub(crate) fn remembered_senders_for(
    conversation_id: &str,
    instance: &UnboundedSender<AcpEvent>,
    agent_id: &str,
) -> Option<InstanceSenders> {
    let map = memories().lock().ok()?;
    let memory = map
        .get(conversation_id)?
        .iter()
        .find(|record| record.agent_id == agent_id && record.instance.same_channel(instance))?;
    Some(InstanceSenders {
        senders: memory
            .senders
            .iter()
            .map(|sender| sender.as_ref().clone())
            .collect(),
        served_without_sender: memory.served_without_sender,
    })
}

#[cfg(test)]
#[path = "turn_sender_tests.rs"]
mod tests;
