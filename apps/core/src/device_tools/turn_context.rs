//! Which live ACP turn may serve a device offer (design §2.2 "ACP plane").
//!
//! The ACP plane reaches device tools only through the in-process MCP bridge,
//! which is built once per ACP instance and outlives a turn. Several instances
//! can share one conversation id: team-member and delegated text turns, other
//! pooled agents, a concurrent instance. A conversation id alone therefore
//! never selects an offer. The instance that serves the user's own-chat turn
//! registers it when it admits that turn, together with its own bridge
//! channel (the `permission_tx` its bridge holds) and agent id; the bridge
//! gets the offer only when both match. The guard clears the entry at turn
//! end (only if it is still that turn's entry).
//!
//! Listing is separate: agents cache `tools/list`, so a bridge lists device
//! tools for the whole session once a turn of this conversation and agent was
//! stamped with an offer (flag on, own chat), and dispatch decides per call.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::mpsc::UnboundedSender;

use super::offer::DeviceOffer;
use crate::sidecar::adapters::acp::AcpEvent;

/// More distinct listed sessions than this resets the set (a bound, not a
/// policy: a cleared entry only stops listing until the next stamped turn).
const MAX_LISTINGS: usize = 4_096;

struct TurnContext {
    offer: Arc<DeviceOffer>,
    instance: UnboundedSender<AcpEvent>,
    agent_id: String,
}

fn contexts() -> &'static Mutex<HashMap<String, TurnContext>> {
    static CONTEXTS: OnceLock<Mutex<HashMap<String, TurnContext>>> = OnceLock::new();
    CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn listings() -> &'static Mutex<HashSet<(String, String)>> {
    static LISTINGS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    LISTINGS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) struct TurnContextGuard {
    conversation_id: String,
    turn_id: String,
}

impl Drop for TurnContextGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = contexts().lock() {
            if map
                .get(&self.conversation_id)
                .is_some_and(|context| context.offer.turn_id == self.turn_id)
            {
                map.remove(&self.conversation_id);
            }
        }
    }
}

/// Register the user's live device turn for the ACP instance serving it.
/// `instance` is that instance's bridge channel and `agent_id` its agent; a
/// device read already in the conversation's history marks the turn private
/// at once, because the agent still holds the raw result.
pub(crate) fn register_turn_context(
    offer: Arc<DeviceOffer>,
    instance: &UnboundedSender<AcpEvent>,
    agent_id: &str,
) -> TurnContextGuard {
    if let Some(source) = offer.history_private_read.as_deref() {
        super::taint::mark_device_read(&offer, source);
    }
    allow_device_listing(&offer.conversation_id, agent_id);
    let guard = TurnContextGuard {
        conversation_id: offer.conversation_id.clone(),
        turn_id: offer.turn_id.clone(),
    };
    if let Ok(mut map) = contexts().lock() {
        map.insert(
            offer.conversation_id.clone(),
            TurnContext {
                offer,
                instance: instance.clone(),
                agent_id: agent_id.to_owned(),
            },
        );
    }
    guard
}

/// The live turn's offer for a bridge: only for the instance (same bridge
/// channel) and agent that registered it.
pub(crate) fn turn_context_for(
    conversation_id: &str,
    instance: &UnboundedSender<AcpEvent>,
    agent_id: &str,
) -> Option<Arc<DeviceOffer>> {
    let map = contexts().lock().ok()?;
    let context = map.get(conversation_id)?;
    (context.agent_id == agent_id && context.instance.same_channel(instance))
        .then(|| Arc::clone(&context.offer))
}

/// The live device turn of a conversation whatever instance serves it. Only
/// ever used to tighten a decision (for example, to keep an agent's own
/// egress tools asking after a device read), never to grant anything.
pub(crate) fn live_offer_for_conversation(conversation_id: &str) -> Option<Arc<DeviceOffer>> {
    let map = contexts().lock().ok()?;
    map.get(conversation_id)
        .map(|context| Arc::clone(&context.offer))
}

/// A turn of this conversation and agent was stamped with an offer.
pub(crate) fn allow_device_listing(conversation_id: &str, agent_id: &str) {
    if let Ok(mut set) = listings().lock() {
        if set.len() >= MAX_LISTINGS {
            set.clear();
        }
        set.insert((conversation_id.to_owned(), agent_id.to_owned()));
    }
}

/// Whether a bridge for this conversation and agent may list device tools.
pub(crate) fn device_listing_allowed(conversation_id: &str, agent_id: &str) -> bool {
    listings()
        .lock()
        .is_ok_and(|set| set.contains(&(conversation_id.to_owned(), agent_id.to_owned())))
}
