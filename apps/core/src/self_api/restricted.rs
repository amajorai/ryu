//! The reviewed write allowlist for agents with a restricted account policy.

use super::*;

// ── Restricted-account agents (reviewed write allowlist) ──────────────────────

/// The only write routes (`METHOD`, OpenAPI path template) an agent with a
/// restricted account policy (an "Its own identity" or "Both" agent, or any
/// agent with an account allowlist) may call through the self-API.
///
/// The loopback runs with the node's full power, not the agent's account
/// policy, so every write not listed here is refused for those agents, and so
/// is every route added later until someone reviews it. Each entry edits
/// workspace content only. Deliberately left out, even under these prefixes:
/// - credentials, connections, accounts, the vault, plugins and their secrets,
///   agents and their records, triggers and automations;
/// - sharing (`…/access`, `…/visibility`, `…/export`, `/api/spaces/import`);
/// - anything that runs an agent, a tool or a workflow (conversation
///   participants, fork, regenerate, edit, pull requests, goal start/resume,
///   chat forms/questions/follow-ups);
/// - anything that spends on a model provider outside the agent's
///   `provider:` allowlist (retitle, model selection, retrieval, search,
///   suggestions, prompt-suite runs, learning score/merge/cycle);
/// - node settings (memory and download settings, new model downloads).
pub(super) const RESTRICTED_SAFE_WRITES: &[(&str, &str)] = &[
    // Spaces: notes, documents, pages, whiteboards, databases, files.
    ("POST", "/api/spaces"),
    ("DELETE", "/api/spaces/{id}"),
    ("POST", "/api/spaces/{id}/name"),
    ("POST", "/api/spaces/{id}/icon"),
    ("POST", "/api/spaces/{id}/documents"),
    ("PUT", "/api/spaces/{id}/documents/{doc_id}"),
    ("DELETE", "/api/spaces/{id}/documents/{doc_id}"),
    ("PUT", "/api/spaces/{id}/documents/{doc_id}/blob"),
    ("POST", "/api/spaces/{id}/documents/{doc_id}/icon"),
    ("POST", "/api/spaces/{id}/documents/{doc_id}/versions"),
    (
        "POST",
        "/api/spaces/{id}/documents/{doc_id}/versions/{version_id}/restore",
    ),
    ("POST", "/api/spaces/{id}/pages"),
    ("POST", "/api/spaces/{id}/whiteboards"),
    ("POST", "/api/spaces/{id}/databases"),
    ("POST", "/api/spaces/{id}/databases/{doc_id}/query"),
    ("POST", "/api/spaces/{id}/files"),
    // Memory entries and Dream proposals (not memory settings).
    ("PUT", "/api/memory/{id}"),
    ("POST", "/api/memory/dream/review/proposals/{id}/accept"),
    ("POST", "/api/memory/dream/review/proposals/{id}/reject"),
    // Undo an accepted proposal: restores the memory it replaced and archives
    // the one it wrote; nothing is deleted.
    ("POST", "/api/memory/dream/review/proposals/{id}/rollback"),
    // Conversation housekeeping.
    ("POST", "/api/conversations/{id}/title"),
    ("POST", "/api/conversations/{id}/icon"),
    ("POST", "/api/conversations/{id}/pinned"),
    ("POST", "/api/conversations/{id}/archived"),
    ("POST", "/api/conversations/{id}/folder"),
    ("POST", "/api/conversations/{id}/read"),
    ("POST", "/api/conversations/{id}/save"),
    ("POST", "/api/conversations/{id}/goal/pause"),
    ("DELETE", "/api/conversations/{id}/goal"),
    ("POST", "/api/conversations/{id}/history-preview"),
    ("POST", "/api/conversations/{id}/git-history"),
    ("PUT", "/api/conversations/{id}/ui-state/{tool_call_id}"),
    (
        "POST",
        "/api/conversations/{id}/messages/{message_id}/feedback",
    ),
    (
        "POST",
        "/api/conversations/{id}/messages/{message_id}/reactions",
    ),
    (
        "DELETE",
        "/api/conversations/{id}/messages/{message_id}/reactions",
    ),
    (
        "POST",
        "/api/conversations/{id}/messages/{message_id}/select",
    ),
    (
        "POST",
        "/api/conversations/{id}/checkpoints/{checkpoint_id}/restore",
    ),
    ("POST", "/api/chat/cancel"),
    // Notifications.
    ("POST", "/api/notifications/{id}/ack"),
    ("POST", "/api/notifications/{id}/read"),
    ("POST", "/api/notifications/{id}/archive"),
    ("POST", "/api/notifications/{id}/unarchive"),
    // Prompt-suite authoring and review (not runs).
    ("POST", "/api/prompt-suites"),
    ("PUT", "/api/prompt-suites/{id}"),
    ("DELETE", "/api/prompt-suites/{id}"),
    ("POST", "/api/prompt-suites/{id}/versions"),
    (
        "POST",
        "/api/prompt-suites/{id}/versions/{version_id}/restore",
    ),
    ("POST", "/api/prompt-suites/{id}/traces"),
    ("PUT", "/api/prompt-suites/{id}/runs/{run_id}"),
    ("DELETE", "/api/prompt-suites/{id}/runs/{run_id}"),
    ("POST", "/api/prompt-suites/{id}/runs/{run_id}/reviews"),
    // Learning capture, improvements, activity and presence.
    ("POST", "/api/learn/exclude"),
    ("POST", "/api/learn/sweep"),
    ("POST", "/api/improvements"),
    ("POST", "/api/improvements/{id}/transition"),
    ("POST", "/api/activity"),
    ("PUT", "/api/presence"),
    ("PUT", "/api/presence/gaming"),
    // Uploads and workspace folders.
    ("POST", "/api/uploads"),
    ("POST", "/api/media/upload"),
    ("POST", "/api/workspace/new-folder"),
    // Widget state (not the widget tool bridge, app opens or follow-ups).
    ("POST", "/api/widgets/state"),
    // Downloads already queued (not new model downloads or settings).
    ("POST", "/api/downloads/{id}/pause"),
    ("POST", "/api/downloads/{id}/resume"),
    ("POST", "/api/downloads/{id}/cancel"),
    ("POST", "/api/downloads/{id}/retry"),
    ("DELETE", "/api/downloads/{id}"),
    ("DELETE", "/api/downloads/history"),
];

/// Whether an agent with a restricted account policy may call this route
/// through the self-API. Reads are always allowed (they pass the same
/// denylist as everyone); a write must be on [`RESTRICTED_SAFE_WRITES`].
pub fn restricted_agent_may_write(path_template: &str, method: &str) -> bool {
    if method.eq_ignore_ascii_case("get") {
        return true;
    }
    RESTRICTED_SAFE_WRITES
        .iter()
        .any(|(m, p)| m.eq_ignore_ascii_case(method) && *p == path_template)
}

/// The refusal for a restricted-account agent calling `tool_id`, or `None`
/// when the call may proceed. Reads pass. A write passes only when it resolves
/// to a reviewed workspace-content route; an id that resolves to no route is
/// refused, so this fails closed.
pub fn restricted_write_refusal(tool_id: &str) -> Option<String> {
    if !is_mutating(tool_id) {
        return None;
    }
    let allowed = route_for(tool_id)
        .is_some_and(|route| restricted_agent_may_write(&route.path_template, &route.method));
    if allowed {
        return None;
    }
    Some(format!(
        "tool '{tool_id}' can reach accounts, credentials, connections, agents, plugins, \
         providers or automations with your full access, which this agent's account access \
         does not allow. It may still edit workspace content (Spaces, memory, conversations, \
         notifications)."
    ))
}

/// Creating a Space is on [`RESTRICTED_SAFE_WRITES`] only as private content: an
/// org- or team-visible Space would share what the agent then writes into it,
/// and sharing is not workspace housekeeping. `None` when the call may go ahead.
pub fn restricted_sharing_refusal(tool_id: &str, arguments: &serde_json::Value) -> Option<String> {
    let route = route_for(tool_id)?;
    if route.method != "POST" || route.path_template != "/api/spaces" {
        return None;
    }
    let visibility = arguments
        .get("body")
        .and_then(|body| body.get("visibility"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or("private");
    (visibility != "private").then(|| {
        format!(
            "this agent's account access is limited, so it may create only private Spaces, \
             not a '{visibility}' one; share it yourself if you want others to see it"
        )
    })
}
