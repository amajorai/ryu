//! Which conversations a `search_conversations` call may touch.
//!
//! A verified bearer (REST `/api/mcp/tools/call`, network `/mcp/:agent_id`) on an
//! org-bound node reads through the SAME function the REST conversation search
//! uses ([`crate::server::visible_conversation_ids_for_caller`]), so a team
//! member's agent finds the team-shared chats that member already sees in the
//! UI, and never more. An in-chat agent gets the same view only on its owner's
//! own turn (the turn's verified sender is the conversation owner). Every other
//! principal keeps the principal-only filter.

use anyhow::Result;
use serde_json::Value;

use super::super::authenticated_scope;
use super::ToolPrincipal;
use crate::identity_verify::VerifiedCaller;
use crate::server::conversations::ConversationStore;

/// Resolve the conversation ids a search may touch.
///
/// **Tenancy.** This was the single worst leak in Core: `search_messages` took a
/// CALLER-SUPPLIED `conversation_ids` list and applied no tenancy filter at all, so
/// on an org-bound node "search my past conversations for the Q3 numbers" ran
/// semantic search across EVERY user's messages and printed the snippets into the
/// asking user's thread. Its REST twin (`search_conversations_handler`) already
/// filtered via `visible_conversation_ids`; that asymmetry WAS the bug.
///
/// The caller-supplied `conversation_ids` is an **INTERSECTION** with
/// `principal`'s visible set (and the server-owned scope), never a widening.
/// Omitting the argument searches the visible set; naming someone else's
/// conversation searches nothing. `Unrestricted` (unbound personal node) keeps
/// the caller's list exactly as supplied. Both exact and semantic searches use
/// the id set this returns.
pub(super) async fn resolve_conversation_ids(
    arguments: &Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
    conversation_scope: Option<&[String]>,
) -> Result<Option<Vec<String>>> {
    let requested_ids: Option<Vec<String>> = arguments
        .get("conversation_ids")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        });
    let in_scope = |id: &String| conversation_scope.is_none_or(|scope| scope.contains(id));

    if matches!(principal, ToolPrincipal::Unrestricted) {
        return Ok(match (requested_ids, conversation_scope) {
            (Some(requested), Some(_)) => Some(requested.into_iter().filter(in_scope).collect()),
            (None, Some(scope)) => Some(scope.to_vec()),
            (requested, None) => requested,
        });
    }
    // THE GATE — the same `TENANCY_VISIBLE_PREDICATE` the REST search uses.
    let visible = visible_ids(store, principal).await?;
    Ok(Some(
        requested_ids
            .unwrap_or_else(|| visible.clone())
            .into_iter()
            .filter(|id| visible.contains(id) && in_scope(id))
            .collect(),
    ))
}

/// The principal's readable conversation ids.
///
/// Team memberships are only trusted from a verified human whose principal this
/// is: a verified bearer, or the verified sender of the live chat turn. A chat
/// agent's principal is its host conversation's OWNER, and any collaborator or
/// team member who may write to that conversation can drive the turn, so the
/// owner's teams apply only to the owner's own turn (sender == principal). On an
/// unbound node the verified caller carries no org or teams, and REST's unbound
/// view would add untenanted legacy rows, so that case keeps the principal-only
/// filter.
async fn visible_ids(store: &ConversationStore, principal: &ToolPrincipal) -> Result<Vec<String>> {
    if crate::server::node_org_id().is_some() {
        if let Some(caller) = verified_caller_for(principal) {
            return crate::server::visible_conversation_ids_for_caller(store, &Some(caller)).await;
        }
    }
    let (uid, org, bound) = principal.filter_args();
    store.visible_conversation_ids(uid, org, bound).await
}

/// The verified caller (or else the live turn's verified sender) in scope, only
/// when `principal` is exactly the principal that human yields (same user and
/// org). Never pairs a principal with someone else's team memberships.
fn verified_caller_for(principal: &ToolPrincipal) -> Option<VerifiedCaller> {
    let ToolPrincipal::Owned { user_id, org_id } = principal else {
        return None;
    };
    authenticated_scope::current_verified_caller()
        .or_else(authenticated_scope::current_turn_sender)
        .filter(|caller| &caller.user_id == user_id && &caller.org_id == org_id)
}

#[cfg(test)]
#[path = "search_conversations_visibility_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "search_conversations_tool_parts_tests.rs"]
mod tool_parts_tests;
