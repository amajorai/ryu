//! Which Box a conversation's machine verbs use, the conversation gate of the
//! registry's dispatch core, and the cloud-task machine verb names.

use super::*;

// ── Resolution ───────────────────────────────────────────────────────────────

/// The owner of a conversation as Core derives it: the stored owner (the same
/// rule the cloud tool arm applies). Only a conversation with no stored row
/// takes it from the one principal whose turn is remembered. A later writer
/// (a collaborator with write access) never changes it.
pub(in crate::sidecar::mcp::box_desktop) async fn conversation_owner(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> Option<String> {
    let meta = match store {
        Some(store) => match store.get_access_meta(conversation_id).await {
            Ok(meta) => meta,
            Err(_) => return None,
        },
        None => None,
    };
    let Some(meta) = meta else {
        return sole_remembered_owner(conversation_id);
    };
    let principal = ToolPrincipal::resolve_optional(store, Some(conversation_id)).await;
    match (principal, meta.owner_user_id) {
        (ToolPrincipal::Owned { user_id, .. }, Some(owner)) if user_id == owner => {
            Some(format!("user:{owner}"))
        }
        (ToolPrincipal::Unrestricted, Some(owner)) => Some(format!("user:{owner}")),
        (ToolPrincipal::Unrestricted, None) => Some(NODE_OWNER.to_owned()),
        _ => None,
    }
}

/// Which Box key a conversation's machine verbs use, and why.
pub(in crate::sidecar::mcp::box_desktop) struct Resolved {
    pub(in crate::sidecar::mcp::box_desktop) key: SessionBoxKey,
    pub(in crate::sidecar::mcp::box_desktop) reason: AcquireReason,
}

pub(in crate::sidecar::mcp::box_desktop) async fn resolve(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> Option<Resolved> {
    if let Some(key) = child_key(conversation_id) {
        // A sub-agent conversation with a stored row must still belong to the
        // owner it was registered for.
        let stored = match store {
            Some(store) => store.get_access_meta(conversation_id).await.ok().flatten(),
            None => None,
        };
        if stored.is_some() {
            let owner = conversation_owner(store, conversation_id).await;
            if owner.as_deref() != Some(key.owner.as_str()) {
                return None;
            }
        }
        return Some(Resolved {
            key,
            reason: AcquireReason::SubAgent,
        });
    }
    let owner = conversation_owner(store, conversation_id).await?;
    Some(Resolved {
        key: SessionBoxKey::session(&owner, conversation_id),
        reason: AcquireReason::ComputerUse,
    })
}

#[cfg(test)]
pub(in crate::sidecar::mcp::box_desktop) fn bound_for_test(
) -> MutexGuard<'static, std::collections::HashSet<String>> {
    pub(in crate::sidecar::mcp::box_desktop) static BOUND: OnceLock<
        Mutex<std::collections::HashSet<String>>,
    > = OnceLock::new();
    BOUND
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether the conversation is bound to a cloud task ("cloud tools only").
pub(in crate::sidecar::mcp::box_desktop) async fn conversation_is_bound(
    conversation_id: &str,
) -> bool {
    #[cfg(test)]
    if bound_for_test().contains(conversation_id) {
        return true;
    }
    crate::server::cloud_tasks::has_bound_task(conversation_id).await
}

/// Whether the machine verbs of `conversation_id` go to a Box: it (or, for a
/// sub-agent, its parent) has a session Box or a cloud task Box.
pub(in crate::sidecar::mcp::box_desktop) async fn machine_verbs_route_to_box(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> bool {
    let Some(resolved) = resolve(store, conversation_id).await else {
        return false;
    };
    session_box::routes_to_box(&resolved.key).await
}

#[cfg(test)]
tokio::task_local! {
    /// Counts gate evaluations of the calls made inside its scope.
    pub(super) static GATE_PROBE: Arc<std::sync::atomic::AtomicUsize>;
}

/// The conversation gate of the registry's dispatch core. Returns the refusal
/// for `tool_id` in `conversation_id`, or `None` to let it run.
///
/// - A cloud-task conversation runs only its cloud tools, plus `computer.*`
///   and `browser.*` when they are routed to its Box.
/// - A conversation whose machine verbs go to a Box never drives the node's
///   own display: not through Shadow computer use, and not through a node
///   display provider's raw tool (`drives_node_display`, which the registry
///   sets from [`node_display_servers`] for a direct call; a capability facade
///   dispatch the Box router left on the node is not one).
pub(crate) async fn conversation_gate(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    tool_id: &str,
    drives_node_display: bool,
) -> Option<&'static str> {
    #[cfg(test)]
    let _ = GATE_PROBE.try_with(|probe| probe.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    if crate::sidecar::mcp::cloud::is_tool(tool_id) {
        return None;
    }
    if (drives_node_display || NODE_COMPUTER_USE_TOOLS.contains(&tool_id))
        && machine_verbs_route_to_box(store, conversation_id).await
    {
        return Some(NODE_COMPUTER_USE_REFUSAL);
    }
    if !conversation_is_bound(conversation_id).await {
        return None;
    }
    if capability_tools::is_machine_verb(tool_id)
        && machine_verbs_route_to_box(store, conversation_id).await
    {
        return None;
    }
    Some(CLOUD_TOOLS_ONLY_REFUSAL)
}

/// The refusal of a non-cloud tool in a cloud-task conversation.
pub(crate) const CLOUD_TOOLS_ONLY_REFUSAL: &str =
    "Cloud tasks may execute only their isolated cloud tools";
/// The refusal of node computer use in a conversation that runs on a Box.
pub(crate) const NODE_COMPUTER_USE_REFUSAL: &str =
    "This conversation's computer use runs on its session Box; use the computer.* and browser.* tools instead of computer use on the node";
/// The refusal of computer use in a run with no verified chat caller, on a
/// node that puts computer use on session Boxes.
pub(crate) const NO_TURN_AUTHORITY_REFUSAL: &str =
    "Computer use and the browser run on a session Box on this node, and this run has no verified chat caller to start one (a scheduled, automation, agent-to-agent, voice, plugin or bot run). Run it from a conversation, or set the computer target to the node";

/// Whether `conversation_id`'s tool list withholds the node display tools:
/// its machine verbs run on a Box.
pub(crate) async fn withholds_node_display(
    store: Option<&ConversationStore>,
    conversation_id: Option<&str>,
) -> bool {
    match conversation_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(conversation_id) => machine_verbs_route_to_box(store, conversation_id).await,
        None => false,
    }
}

/// Whether the computer use of `conversation_id`, as `owner` sees it, runs on
/// a Box. Production code decides this per conversation through [`resolve`]
/// ([`conversation_gate`]); this owner-keyed form is for tests.
#[cfg(test)]
pub(crate) async fn owner_routes_to_box(owner: &str, conversation_id: &str) -> bool {
    match child_key(conversation_id) {
        Some(key) if key.owner == owner => session_box::routes_to_box(&key).await,
        Some(_) => false,
        None => session_box::routes_to_box(&SessionBoxKey::session(owner, conversation_id)).await,
    }
}

// ── Cloud task turns ─────────────────────────────────────────────────────────

/// The function name a cloud task turn offers a machine verb under:
/// `box_computer_click` for `computer.click` (function names cannot hold a
/// dot, and the prefix keeps them apart from the `cloud_*` tools).
pub(crate) fn cloud_machine_tool_name(verb_id: &str) -> String {
    format!("box_{}", verb_id.replace('.', "_"))
}

/// The machine verb a cloud task turn's function name stands for, if any.
pub(crate) fn cloud_machine_verb(name: &str) -> Option<&'static str> {
    name.strip_prefix("box_")?;
    capability_tools::verbs()
        .iter()
        .filter(|verb| capability_tools::is_machine_verb(verb.id))
        .find(|verb| cloud_machine_tool_name(verb.id) == name)
        .map(|verb| verb.id)
}

#[cfg(test)]
#[path = "resolution_tests.rs"]
mod tests;
