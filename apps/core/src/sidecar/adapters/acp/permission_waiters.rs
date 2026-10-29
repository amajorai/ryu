use super::*;

/// Mint a unique permission request id (process-local, collision-free).
pub(super) fn next_permission_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("perm-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Register a waiter for `request_id` and return the receiver the permission
/// handler awaits. Dropping the returned receiver (or never resolving) leaves
/// the handler to time out and cancel.
pub(super) fn register_permission(
    request_id: String,
    conversation_id: Option<String>,
) -> tokio::sync::oneshot::Receiver<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut map) = pending_permissions().lock() {
        map.insert(request_id, (tx, conversation_id.filter(|s| !s.is_empty())));
    }
    rx
}

/// The host conversation a pending permission request belongs to, WITHOUT consuming
/// the waiter — so `POST /api/chat/permission` can run its ACL before delivering the
/// decision.
///
/// `None` = no such pending request (already answered or timed out).
/// `Some(None)` = pending, but raised by an ephemeral instance with no conversation.
pub fn peek_permission_scope(request_id: &str) -> Option<Option<String>> {
    pending_permissions()
        .lock()
        .ok()
        .and_then(|map| map.get(request_id).map(|(_, cid)| cid.clone()))
}

/// Ask the connected desktop user to approve a synthetic tool action and wait
/// for their response. Used by Core-owned tools that run inside the ACP MCP
/// bridge, and by the ACP-native permission handler, which share the one
/// waiter map.
///
/// The prompt reaches the user as an event on `tx`. When the receiving side of
/// that stream is already gone, nobody can see the prompt or answer it, so the
/// request is refused at once (`None`) and its waiter dropped, instead of
/// holding the tool call for the whole ten-minute window.
pub async fn request_user_permission(
    tx: &mpsc::UnboundedSender<AcpEvent>,
    tool_call: serde_json::Value,
    options: serde_json::Value,
    conversation_id: Option<String>,
) -> Option<String> {
    let request_id = next_permission_id();
    let rx = register_permission(request_id.clone(), conversation_id);
    if tx
        .send(AcpEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_call,
            options,
        })
        .is_err()
    {
        let _ = resolve_permission(&request_id, None);
        return None;
    }
    let chosen = tokio::time::timeout(std::time::Duration::from_secs(600), rx)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    if chosen.is_none() {
        let _ = resolve_permission(&request_id, None);
    }
    chosen
}

/// Deliver the user's decision to the awaiting permission handler.
/// `option_id = None` cancels (reject). Returns `true` if a waiter was found.
pub fn resolve_permission(request_id: &str, option_id: Option<String>) -> bool {
    let sender = pending_permissions()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(request_id));
    match sender {
        Some((tx, _conversation_id)) => tx.send(option_id).is_ok(),
        None => false,
    }
}

// ── ACP session-config discovery (modes / models / config options) ───────────
//
// `ActiveSession` only surfaces `modes()`; the raw `NewSessionResponse` also
// carries `models` (feature-gated) and `config_options` (e.g. a reasoning-effort
// selector). To populate the desktop's per-agent pickers *before* the first
// turn, `probe_acp_config` opens a throwaway session (no prompt) over the
// low-level connection, reads the full response, and drops it.
//
// That spawn is expensive (up to the 30s ceiling below), and every agent picker
// in the product depends on it, so the result is cached per spawn command by
// [`probe_cache`] — persisted across restarts, TTL'd, single-flighted, and
// refreshed in the background. Read that module's header before changing the
// caching behaviour here; in particular, FAILURES are cached deliberately.
