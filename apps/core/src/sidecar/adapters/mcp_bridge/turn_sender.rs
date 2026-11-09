//! The verified sender of the live ACP turn this bridge serves.
//!
//! Only an in-process bridge (it holds its instance's `permission_tx`) whose
//! own instance and agent registered the turn gets a sender
//! (`acp::turn_sender`). The network `POST /mcp/:agent_id` transport has no
//! channel and never gets one. The sender only feeds the principal-matched
//! team-visibility filter of `search_conversations`; the principal is
//! unchanged.

use super::*;

impl RyuMcpHandler {
    pub(super) fn live_turn_sender(&self) -> Option<Arc<crate::identity_verify::VerifiedCaller>> {
        crate::sidecar::adapters::acp::turn_sender::turn_sender_for(
            self.permission_scope_id.as_deref()?,
            self.permission_tx.as_ref()?,
            &self.agent_id,
        )
    }
}

#[cfg(test)]
#[path = "turn_sender_tests.rs"]
mod tests;
