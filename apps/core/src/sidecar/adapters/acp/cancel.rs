use super::*;

/// A single in-flight turn's cancellation signal, keyed by conversation id.
#[derive(Default)]
pub(super) struct TurnCancel {
    pub(super) flag: std::sync::atomic::AtomicBool,
    pub(super) notify: tokio::sync::Notify,
}

/// Every live turn's handle, per conversation. One conversation can run more
/// than one ACP turn at once (a different agent or a fresh session runs on its
/// own instance, and a superseded turn keeps running), so each turn owns its
/// own entry and a Stop reaches all of them.
fn cancel_registry() -> &'static Mutex<BTreeMap<String, Vec<Arc<TurnCancel>>>> {
    static REG: OnceLock<Mutex<BTreeMap<String, Vec<Arc<TurnCancel>>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Register a turn's cancel handle for a conversation, alongside any other
/// turn still live there.
pub(super) fn set_cancel(conversation: &str, cancel: Arc<TurnCancel>) {
    if let Ok(mut reg) = cancel_registry().lock() {
        if crate::execution_control::is_paused() {
            cancel.flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        reg.entry(conversation.to_owned()).or_default().push(cancel);
    }
}

/// Remove this turn's cancel handle (turn ended). Other turns' handles in the
/// same conversation stay registered.
pub(super) fn clear_cancel(conversation: &str, cancel: &Arc<TurnCancel>) {
    if let Ok(mut reg) = cancel_registry().lock() {
        if let Some(handles) = reg.get_mut(conversation) {
            handles.retain(|handle| !Arc::ptr_eq(handle, cancel));
            if handles.is_empty() {
                reg.remove(conversation);
            }
        }
    }
}

/// A turn's entry in the cancel registry, removed when the turn ends by ANY
/// exit: a lost agent connection or a failed responder returns early with `?`,
/// and an entry left behind keeps [`has_live_turn`] true, so a rewind is
/// refused until another message replaces it. Only this turn's own handle is
/// removed; another turn live in the same conversation keeps its entry.
pub(super) struct CancelRegistration {
    pub(super) conversation: String,
    pub(super) handle: Arc<TurnCancel>,
}

impl CancelRegistration {
    /// Register `handle` for `conversation`. `None` for an ephemeral instance
    /// (no conversation), which the desktop cannot target for cancellation.
    pub(super) fn register(conversation: &str, handle: &Arc<TurnCancel>) -> Option<Self> {
        if conversation.is_empty() {
            return None;
        }
        set_cancel(conversation, Arc::clone(handle));
        Some(Self {
            conversation: conversation.to_owned(),
            handle: Arc::clone(handle),
        })
    }
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        clear_cancel(&self.conversation, &self.handle);
    }
}

/// Request cancellation of a conversation's in-flight ACP turns. Returns `true`
/// if a live turn was signalled. Called by the chat-cancel HTTP handler.
pub fn request_cancel(conversation: &str) -> bool {
    let handles = cancel_registry()
        .lock()
        .ok()
        .and_then(|reg| reg.get(conversation).cloned())
        .unwrap_or_default();
    for cancel in &handles {
        cancel.flag.store(true, std::sync::atomic::Ordering::SeqCst);
        cancel.notify.notify_waiters();
    }
    let signalled = !handles.is_empty();
    // A turn parked on a permission or question prompt is awaiting that
    // handler, not the cancel signal, so it would not see the flag until the
    // prompt timed out. Answering the prompts lets it reach the flag check now.
    cancel_pending_prompts(Some(conversation));
    signalled
}

/// Answer the permission and question prompts waiting on a user: those scoped
/// to `conversation`, or every one for `None`. A permission resolves to `None`
/// (the handler responds `Cancelled`); a question's waiter is dropped (the
/// handler responds `cancelled`).
fn cancel_pending_prompts(conversation: Option<&str>) {
    if let Ok(mut map) = pending_permissions().lock() {
        let matching: Vec<String> = map
            .iter()
            .filter(|(_, (_, scope))| {
                conversation.is_none_or(|conversation| scope.as_deref() == Some(conversation))
            })
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in matching {
            if let Some((waiter, _)) = map.remove(&request_id) {
                let _ = waiter.send(None);
            }
        }
    }
    if let Ok(mut map) = pending_questions().lock() {
        map.retain(|_, (_, scope)| conversation.is_some_and(|conversation| scope != conversation));
    }
}

/// Whether a conversation has an ACP turn in flight. A rewind refuses to
/// restore files underneath an agent that is still writing them.
pub fn has_live_turn(conversation: &str) -> bool {
    cancel_registry().lock().is_ok_and(|reg| {
        reg.get(conversation)
            .is_some_and(|handles| !handles.is_empty())
    })
}

pub fn request_cancel_all() -> usize {
    let cancelled = {
        let registry = cancel_registry().lock().expect("cancel registry poisoned");
        let mut cancelled = 0;
        for cancel in registry.values().flatten() {
            cancel.flag.store(true, std::sync::atomic::Ordering::SeqCst);
            cancel.notify.notify_one();
            cancelled += 1;
        }
        cancelled
    };
    cancel_pending_prompts(None);
    cancelled
}

// ── Client-hosted file system (ACP `fs/read_text_file`, `fs/write_text_file`) ────
//
// ACP agents (Claude Code / Codex) route file reads and edits through the *client*
// rather than touching disk directly, so the client is the single mediation point
// — and the confinement point: requests are scoped to the session's workspace
// root. ACP agents are first-party binaries running as the user (SECURITY.md),
// so this is accident prevention (a prompt-injected turn must not read
// `~/.ssh/id_ed25519` or write `~/.zshrc` through the client seam), not process
// containment. Read honours ACP's 1-based `line` + `limit` window.
