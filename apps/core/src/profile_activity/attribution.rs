//! Who a turn's activity is credited to, and how sub-turns inherit it.

use super::*;

// ── Attribution of a turn and the sub-turns it starts ───────────────────────────

/// Who a turn's activity is credited to. Sub-turns a turn starts inherit it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ActivityAttribution {
    /// A verified human author; counts only when that user is signed in.
    Author(String),
    /// No verified author (loopback chat, scheduled runs): the signed-in account.
    Unattributed,
    /// Not user activity (Patrol, an unverified outside caller).
    Excluded,
}

tokio::task_local! {
    /// The attribution of the turn whose work runs on this task.
    static INHERITED_ATTRIBUTION: ActivityAttribution;
}

/// The attribution of a turn: its own exclusion or verified author first, else
/// the parent turn's (`inherited`), else the signed-in account. A sub-turn is
/// stamped with no author of its own, so without the inherited value a verified
/// user's delegated work would be credited to the signed-in account.
pub(crate) fn turn_attribution(
    agent_id: Option<&str>,
    untrusted_caller: bool,
    author_user_id: Option<&str>,
    inherited: Option<&ActivityAttribution>,
) -> ActivityAttribution {
    if !turn_counts_toward_activity(agent_id, untrusted_caller) {
        return ActivityAttribution::Excluded;
    }
    if let Some(author) = author_user_id.map(str::trim).filter(|id| !id.is_empty()) {
        return ActivityAttribution::Author(author.to_owned());
    }
    inherited
        .cloned()
        .unwrap_or(ActivityAttribution::Unattributed)
}

/// The attribution scoped over the current task, if a turn is running on it.
pub(crate) fn current_attribution() -> Option<ActivityAttribution> {
    INHERITED_ATTRIBUTION.try_with(Clone::clone).ok()
}

/// The attribution a tool call inherits: the task's own, else the one last
/// recorded for the host conversation (tool calls that arrive over the ACP
/// bridge or the Gateway exec plane run outside the turn's task).
pub(crate) fn dispatch_attribution(
    host_conversation_id: Option<&str>,
) -> Option<ActivityAttribution> {
    current_attribution().or_else(|| host_conversation_id.and_then(conversation_attribution))
}

/// Run `future` with `attribution` as the inherited attribution (unchanged
/// when `None`). Use it to carry a turn's attribution across a `tokio::spawn`.
/// Not an `async fn`, so a large turn future is not held twice in its state.
pub(crate) fn with_attribution<F: Future>(
    attribution: Option<ActivityAttribution>,
    future: F,
) -> Either<TaskLocalFuture<ActivityAttribution, F>, F> {
    match attribution {
        Some(attribution) => Either::Left(INHERITED_ATTRIBUTION.scope(attribution, future)),
        None => Either::Right(future),
    }
}

pub(super) fn remembered_conversations() -> &'static Mutex<HashMap<String, ActivityAttribution>> {
    static CONVERSATIONS: OnceLock<Mutex<HashMap<String, ActivityAttribution>>> = OnceLock::new();
    CONVERSATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn remember_conversation(conversation_id: &str, attribution: &ActivityAttribution) {
    let Ok(mut conversations) = remembered_conversations().lock() else {
        return;
    };
    if conversations.len() >= MAX_REMEMBERED_CONVERSATIONS
        && !conversations.contains_key(conversation_id)
    {
        conversations.clear();
    }
    conversations.insert(conversation_id.to_owned(), attribution.clone());
}

pub(super) fn conversation_attribution(conversation_id: &str) -> Option<ActivityAttribution> {
    remembered_conversations()
        .lock()
        .ok()?
        .get(conversation_id.trim())
        .cloned()
}
