//! One provider-route bearer per agent, so Core's provider proxies know which
//! agent a managed Pi request belongs to without trusting anything the
//! request says about itself.
//!
//! The managed Pi already holds a route-scoped bearer instead of the node
//! token (`pi_config::secret_env::provider_token`), because its shell tool
//! and every process below it inherit the variable. That bearer is the same
//! for every agent. A turn's Pi gets the value minted here instead; it is
//! accepted on the same provider routes only, and maps back to the agent the
//! turn runs as. A process cannot name another agent: it would need that
//! agent's random value. Values live in memory for the life of this Core
//! process, like the shared bearer.

use std::sync::Mutex;

/// Never a node bearer (`ryu_…`) and never the shared provider bearer.
const PREFIX: &str = "ryu-pi-agent-";
const MAX_AGENTS: usize = 4096;
const MAX_AGENT_ID_BYTES: usize = 128;

static TOKENS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn tokens() -> std::sync::MutexGuard<'static, Vec<(String, String)>> {
    TOKENS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The provider-route bearer of `agent_id`, created on first use. `None` for
/// an id no pool can be assigned to (empty or oversized, such as the
/// `acp:<spawn command>` stand-in of a turn with no agent), and when the
/// table is full; the caller then keeps the shared bearer and the request is
/// handled as today.
pub(crate) fn mint(agent_id: &str) -> Option<String> {
    if agent_id.is_empty() || agent_id.len() > MAX_AGENT_ID_BYTES {
        return None;
    }
    let mut tokens = tokens();
    if let Some((_, token)) = tokens.iter().find(|(agent, _)| agent == agent_id) {
        return Some(token.clone());
    }
    if tokens.len() >= MAX_AGENTS {
        tracing::warn!("agent provider bearer table is full; the agent keeps the shared bearer");
        return None;
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = format!("{PREFIX}{}", hex::encode(bytes));
    tokens.push((agent_id.to_owned(), token.clone()));
    Some(token)
}

fn same(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

/// The agent a presented bearer was minted for. Every stored value is
/// compared in full, so timing says nothing about a near miss.
pub(crate) fn agent_for_token(token: &str) -> Option<String> {
    if !token.starts_with(PREFIX) {
        return None;
    }
    let mut found = None;
    for (agent, minted) in tokens().iter() {
        if same(minted, token) {
            found = Some(agent.clone());
        }
    }
    found
}
