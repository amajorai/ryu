//! The sub-agent Box scope (design §7.5): which conversation's `delegate.*` or
//! `threads.*` call is running, and the child Boxes its sub-agents get.

use super::*;

// ── Sub-agent scope ──────────────────────────────────────────────────────────

/// The conversation whose `delegate.*` or `threads.*` call is running, so the
/// sub-agents it starts get their own child Boxes (`<conversation>#sub:<n>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubagentScope {
    pub owner: String,
    pub parent_conversation_id: String,
}

tokio::task_local! {
    /// Set by the registry around a `delegate.*` or `threads.*` dispatch.
    pub(in crate::sidecar::mcp::box_desktop) static SUBAGENT_BOX_SCOPE: SubagentScope;
}

/// The sub-agent scope of the running task, if any.
pub(crate) fn current_subagent_scope() -> Option<SubagentScope> {
    SUBAGENT_BOX_SCOPE.try_with(Clone::clone).ok()
}

/// Run `future` with `scope` as its sub-agent scope. `None` runs it unscoped.
/// Use it to carry the scope across a `tokio::spawn`, which does not inherit
/// task-locals.
///
/// The scoped future is boxed here, once. The registry's dispatch core awaits
/// this around the whole `threads.*` dispatch; held inline, that state was the
/// largest arm of the dispatch future (about 110 KB in a debug build), and the
/// core re-enters itself through capability facades such as `memory.search`,
/// copying it once per level until a debug build overflowed an ordinary 2 MiB
/// worker stack (`honcho_registry_runtime_test`).
pub(crate) fn with_subagent_scope<F: std::future::Future>(
    scope: Option<SubagentScope>,
    future: F,
) -> std::pin::Pin<Box<impl std::future::Future<Output = F::Output>>> {
    Box::pin(async move {
        match scope {
            Some(scope) => SUBAGENT_BOX_SCOPE.scope(scope, future).await,
            None => future.await,
        }
    })
}

#[derive(Default)]
pub(in crate::sidecar::mcp::box_desktop) struct ChildTable {
    pub(in crate::sidecar::mcp::box_desktop) keys: HashMap<String, SessionBoxKey>,
    pub(in crate::sidecar::mcp::box_desktop) order: VecDeque<String>,
}

pub(in crate::sidecar::mcp::box_desktop) fn children() -> MutexGuard<'static, ChildTable> {
    pub(in crate::sidecar::mcp::box_desktop) static TABLE: OnceLock<Mutex<ChildTable>> =
        OnceLock::new();
    TABLE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The child key a sub-agent conversation was registered under.
pub(in crate::sidecar::mcp::box_desktop) fn child_key(
    conversation_id: &str,
) -> Option<SessionBoxKey> {
    children().keys.get(conversation_id).cloned()
}

/// `conversation#sub:n` for a registered sub-agent conversation.
#[cfg(test)]
pub(crate) fn child_session_id(conversation_id: &str) -> Option<String> {
    child_key(conversation_id).map(|key| key.session_id())
}

/// A conversation was deleted: forget every sub-agent registered under it, so a
/// thread worker of the deleted coordinator stops resolving to its tombstoned
/// Box. The child Boxes themselves are released with the conversation.
pub(crate) fn forget_children_of(parent_conversation_id: &str) {
    let mut table = children();
    let ChildTable { keys, order } = &mut *table;
    keys.retain(|_, key| key.conversation_id != parent_conversation_id);
    order.retain(|id| keys.contains_key(id));
}

/// Register `child_conversation_id` as the next sub-agent of `scope`. Its
/// machine verbs then run on the child Box `parent#sub:n` (or on the parent's
/// Box when the plan cap refuses another one). Registering the same
/// conversation again returns its existing key. The child takes the lowest
/// number no running sub-agent holds; with all of them held it shares the
/// parent's Box (design §7.5) rather than another child's.
pub(crate) fn register_child_conversation(
    scope: &SubagentScope,
    child_conversation_id: &str,
) -> Option<SessionBoxKey> {
    if child_conversation_id == scope.parent_conversation_id
        || !crate::sidecar::adapters::acp::is_safe_host_conversation_id(child_conversation_id)
    {
        return None;
    }
    let mut table = children();
    if let Some(existing) = table.keys.get(child_conversation_id) {
        return Some(existing.clone());
    }
    let key = match session_box::next_child_index(&scope.owner, &scope.parent_conversation_id) {
        Some(index) => SessionBoxKey::child(&scope.owner, &scope.parent_conversation_id, index),
        None => SessionBoxKey::session(&scope.owner, &scope.parent_conversation_id),
    };
    let ChildTable { keys, order } = &mut *table;
    while keys.len() >= MAX_REMEMBERED {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        keys.remove(&oldest);
    }
    keys.insert(child_conversation_id.to_owned(), key.clone());
    order.push_back(child_conversation_id.to_owned());
    Some(key)
}

/// A sub-agent conversation finished (a delegate's turn ended): forget it,
/// park its child Box and free its number for the next sub-agent.
pub(crate) async fn release_child_conversation(child_conversation_id: &str) {
    let key = {
        let mut table = children();
        let ChildTable { keys, order } = &mut *table;
        let Some(key) = keys.remove(child_conversation_id) else {
            return;
        };
        order.retain(|id| id != child_conversation_id);
        key
    };
    if key.child.is_some() {
        session_box::release_child(&key).await;
    }
}

/// Register `child_conversation_id` under the running task's sub-agent scope.
/// The delegation engine calls this when it starts a delegate's turn.
pub(crate) fn bind_child_conversation(child_conversation_id: &str) -> Option<SessionBoxKey> {
    let scope = current_subagent_scope()?;
    register_child_conversation(&scope, child_conversation_id)
}

/// The scope sub-agents started from `host_conversation_id` belong to. A
/// sub-agent that starts its own sub-agents shares its root conversation's
/// counter, so every child of a session is numbered once.
pub(crate) async fn subagent_scope_for(
    store: Option<&ConversationStore>,
    host_conversation_id: Option<&str>,
) -> Option<SubagentScope> {
    let conversation_id = host_conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    if let Some(key) = child_key(conversation_id) {
        return Some(SubagentScope {
            owner: key.owner,
            parent_conversation_id: key.conversation_id,
        });
    }
    let owner = conversation_owner(store, conversation_id).await?;
    Some(SubagentScope {
        owner,
        parent_conversation_id: conversation_id.to_owned(),
    })
}

#[cfg(test)]
#[path = "subagent_tests.rs"]
mod tests;
