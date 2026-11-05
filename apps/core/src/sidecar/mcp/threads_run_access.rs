//! Exact-agent `agent.run` authority for coordinator worker threads.
//!
//! `send_message_to_thread` runs the thread's agent with that agent's own
//! system prompt, tools, account bindings and identity profiles, and returns
//! the reply to the caller. On an organization-bound node that is an agent run
//! on the human principal's behalf, so it needs the same exact-agent
//! `agent.run` decision a chat turn applies: a member denied `agent.run` on an
//! agent must not reach it by asking an agent they may chat with to create and
//! drive a worker thread bound to it. The check runs at creation (so a denied
//! agent never gets a row) and again on every send (so revoking access stops
//! an existing thread).

use super::ToolPrincipal;

/// Require that `principal` may run `agent_id` now; `None` (or a blank id)
/// means the thread runs the default agent.
///
/// Only an owned principal on an org-bound node is checked: an unbound
/// personal node has no organization ACL, and an unresolved principal is
/// refused earlier by the dispatcher and by the threads write gate.
pub(super) async fn require_principal_may_run(
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
) -> anyhow::Result<()> {
    let ToolPrincipal::Owned { user_id, .. } = principal else {
        return Ok(());
    };
    let target = agent_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(crate::registry::DEFAULT_AGENT_ID);
    crate::scheduler::agent_run_access::require_owner_may_run_agent(Some(user_id), target)
        .await
        .map_err(anyhow::Error::msg)
}

#[cfg(test)]
#[path = "threads_run_access_tests.rs"]
mod tests;
