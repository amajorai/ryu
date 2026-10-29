use super::*;

// ── Client-tool continuation registry ────────────────────────────────────────
//
// Browser tools execute in the extension, never in Core. A pending provider
// tool call parks on a one-shot waiter keyed by a server-minted nonce; the
// authenticated result endpoint below resolves that waiter after it checks the
// conversation ACL, owner, call id, nonce and expiry.

struct ClientToolWaiter {
    conversation_id: String,
    owner_user_id: Option<String>,
    tool_call_id: String,
    expires_at_ms: i64,
    sender: tokio::sync::oneshot::Sender<Value>,
}

fn client_tool_waiters(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, ClientToolWaiter>> {
    static WAITERS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, ClientToolWaiter>>,
    > = std::sync::OnceLock::new();
    WAITERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn client_tool_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn register_client_tool_waiter(
    conversation_id: &str,
    tool_call_id: &str,
    owner_user_id: Option<String>,
) -> (String, i64, tokio::sync::oneshot::Receiver<Value>) {
    let nonce = format!("browser_{}", uuid::Uuid::new_v4().simple());
    let expires_at_ms = client_tool_now_ms() + 120_000;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if let Ok(mut waiters) = client_tool_waiters().lock() {
        // Backstop for waiters whose stream ended without a result: once past
        // expiry a result is refused anyway, so the entry only holds memory.
        let now = client_tool_now_ms();
        waiters.retain(|_, waiter| waiter.expires_at_ms >= now);
        waiters.insert(
            nonce.clone(),
            ClientToolWaiter {
                conversation_id: conversation_id.to_owned(),
                owner_user_id,
                tool_call_id: tool_call_id.to_owned(),
                expires_at_ms,
                sender,
            },
        );
    }
    (nonce, expires_at_ms, receiver)
}

/// Removes a waiter when the stream waiting on it is done, whether it got a
/// result, timed out, or was dropped mid-wait. Removing an entry the result
/// endpoint already consumed is a no-op.
pub(crate) struct ClientToolWaiterCleanup(pub(crate) String);

impl Drop for ClientToolWaiterCleanup {
    fn drop(&mut self) {
        if let Ok(mut waiters) = client_tool_waiters().lock() {
            waiters.remove(&self.0);
        }
    }
}

pub fn resolve_client_tool_result(
    conversation_id: &str,
    tool_call_id: &str,
    nonce: &str,
    result: Value,
    provenance: &Value,
    caller_user_id: Option<&str>,
) -> Result<(), String> {
    if !provenance.is_object()
        || provenance.get("source").and_then(Value::as_str) != Some("browser-extension")
    {
        return Err("invalid browser tool provenance".to_owned());
    }
    if result.to_string().len() > 1_000_000 {
        return Err("browser tool result is too large".to_owned());
    }
    let waiter = client_tool_waiters()
        .lock()
        .map_err(|_| "client tool registry unavailable".to_owned())?
        .remove(nonce)
        .ok_or_else(|| "browser tool nonce is unknown or already used".to_owned())?;
    if waiter.expires_at_ms < client_tool_now_ms() {
        return Err("browser tool nonce expired".to_owned());
    }
    if waiter.conversation_id != conversation_id || waiter.tool_call_id != tool_call_id {
        return Err("browser tool result is bound to a different call".to_owned());
    }
    if waiter.owner_user_id.as_deref() != caller_user_id {
        return Err("browser tool result owner mismatch".to_owned());
    }
    waiter
        .sender
        .send(result)
        .map_err(|_| "browser tool stream is no longer waiting".to_owned())
}

pub(crate) fn allowed_client_tool_schema(value: &Value) -> bool {
    let name = value.get("name").and_then(Value::as_str).or_else(|| {
        value
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
    });
    name.is_some_and(|name| name.starts_with("browser_"))
}

#[cfg(test)]
mod client_tool_tests {
    use super::*;

    #[test]
    fn only_browser_namespace_is_eligible_for_client_continuation() {
        assert!(allowed_client_tool_schema(&serde_json::json!({
            "type": "function",
            "function": { "name": "browser_click" }
        })));
        assert!(!allowed_client_tool_schema(&serde_json::json!({
            "type": "function",
            "function": { "name": "delete_everything" }
        })));
    }

    #[tokio::test]
    async fn nonce_result_is_single_use_and_owner_bound() {
        let (nonce, _, receiver) = register_client_tool_waiter(
            "browser-conversation",
            "tool-call-1",
            Some("user-1".to_owned()),
        );
        resolve_client_tool_result(
            "browser-conversation",
            "tool-call-1",
            &nonce,
            serde_json::json!({ "ok": true }),
            &serde_json::json!({ "source": "browser-extension" }),
            Some("user-1"),
        )
        .expect("the matching owner should resume the waiter");
        assert_eq!(
            receiver.await.expect("waiter result"),
            serde_json::json!({ "ok": true })
        );
        assert!(resolve_client_tool_result(
            "browser-conversation",
            "tool-call-1",
            &nonce,
            serde_json::json!({ "ok": true }),
            &serde_json::json!({ "source": "browser-extension" }),
            Some("user-1"),
        )
        .is_err());
    }

    #[test]
    fn abandoned_and_expired_waiters_leave_the_registry() {
        let (abandoned, _, _receiver) =
            register_client_tool_waiter("browser-conversation", "tool-call-2", None);
        drop(ClientToolWaiterCleanup(abandoned.clone()));
        let (expired, _, _expired_receiver) =
            register_client_tool_waiter("browser-conversation", "tool-call-3", None);
        if let Some(waiter) = client_tool_waiters().lock().unwrap().get_mut(&expired) {
            waiter.expires_at_ms = 0;
        }
        let (live, _, _live_receiver) =
            register_client_tool_waiter("browser-conversation", "tool-call-4", None);
        let waiters = client_tool_waiters().lock().unwrap();
        assert!(!waiters.contains_key(&abandoned));
        assert!(!waiters.contains_key(&expired));
        assert!(waiters.contains_key(&live));
    }
}
