//! The registry of in-flight logins and the event log each one replays.

use super::*;

/// One in-flight login: the child process, its event history, and a live feed.
pub struct LoginSession {
    /// Live events for subscribers attached now.
    pub(super) tx: broadcast::Sender<Value>,
    /// Everything emitted so far. A client subscribes AFTER `start` returns, by
    /// which point the flow has usually already emitted its URL or first prompt —
    /// replaying the history is what stops that opening event from being lost.
    pub(super) history: Mutex<Vec<Value>>,
    /// Write half of the bridge's stdin, for answering prompts.
    pub(super) stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    /// Kept so the flow can be killed. Dropping a `tokio` `Child` does NOT reap
    /// it by default, and an orphaned flow keeps its OAuth callback port bound —
    /// `openai-codex` in particular listens on a fixed `localhost:1455` that its
    /// registered redirect URI depends on, so one leaked child makes every later
    /// ChatGPT login fail with `EADDRINUSE`. Every exit path kills.
    pub(super) child: Mutex<Option<Child>>,
    /// Native OAuth owns an async callback listener instead of a child process.
    pub(super) native_abort: Mutex<Option<tokio::task::AbortHandle>>,
    /// Set once the flow reached a terminal event, so late subscribers do not
    /// wait on a stream that will never speak again.
    pub(super) finished: AtomicBool,
    /// pi-ai provider id this login is for, so a second attempt at the same
    /// provider can retire the first before it re-binds the callback port.
    pub(super) provider: String,
    /// The bridge's most recent stderr lines, bounded to [`STDERR_TAIL_LINES`].
    /// This stays in process memory and is reduced to fixed diagnostics before
    /// it reaches a client; vendor error text may contain credentials.
    pub(super) stderr_tail: Mutex<VecDeque<String>>,
}

impl LoginSession {
    /// Append to the replay log and push to live subscribers.
    pub(super) fn emit(&self, event: Value) {
        if let Ok(mut history) = self.history.lock() {
            history.push(event.clone());
        }
        // `send` errs only when nobody is subscribed; the history still has it.
        let _ = self.tx.send(event);
    }

    /// Events already emitted, for a client that just attached.
    pub fn replay(&self) -> Vec<Value> {
        self.history.lock().map(|h| h.clone()).unwrap_or_default()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.tx.subscribe()
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// Record one stderr line from the bridge, dropping the oldest past the cap.
    pub(super) fn push_stderr(&self, line: String) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            while tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    }

    /// The recorded stderr, oldest line first, trimmed to [`STDERR_TAIL_CHARS`].
    ///
    /// Trimming keeps the END, not the start: Node prints the failing specifier
    /// and the `code:` field after the stack, so the tail is where the answer is.
    pub(super) fn recent_stderr(&self) -> String {
        let joined = self
            .stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        let chars = joined.chars().count();
        if chars <= STDERR_TAIL_CHARS {
            return joined;
        }
        let start = joined
            .char_indices()
            .nth(chars - STDERR_TAIL_CHARS)
            .map_or(0, |(index, _)| index);
        format!("…{}", &joined[start..])
    }

    /// Answer the prompt with the given id. The value is forwarded verbatim: a
    /// `select` prompt (Copilot asks one) expects the chosen option's **id**, not
    /// its index or label.
    pub async fn answer(&self, id: &str, value: &str) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| anyhow!("this login is no longer accepting input"))?;
        let line = format!("{}\n", json!({ "id": id, "value": value }));
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Kill the flow and release its callback port. Idempotent.
    ///
    /// `finished` is set FIRST, before the kill, and the order is load-bearing.
    /// It used to be set last, which left a window in which the reader task saw
    /// the killed child's stdout EOF while `finished` was still `false` and
    /// reported "the login flow exited before completing" for a flow the app had
    /// deliberately cancelled. That made the message ambiguous between "the
    /// bridge died" and "we killed it" — the two cases with opposite fixes.
    pub fn cancel(&self) {
        self.finished.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.native_abort.lock() {
            if let Some(task) = guard.take() {
                task.abort();
            }
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
            *guard = None;
        }
        if let Ok(mut guard) = self.stdin.try_lock() {
            *guard = None;
        }
    }
}

/// The message for a bridge whose stdout closed without a terminal event.
/// Only fixed classifications of vendor stderr may reach a client.
pub(super) fn exit_message(status: Option<std::process::ExitStatus>, stderr: &str) -> String {
    let mut message = String::from("the login flow exited before completing");
    if let Some(status) = status {
        message.push_str(&format!(" ({status})"));
    }
    // Vendor stderr is uncontrolled and can contain OAuth codes or credentials.
    // Return only known, fixed diagnostics to clients.
    let diagnostic =
        if stderr.contains("Cannot find package") || stderr.contains("ERR_MODULE_NOT_FOUND") {
            Some("the managed Pi package could not be loaded")
        } else if stderr.contains("EADDRINUSE") {
            Some("the sign-in callback port is already in use")
        } else {
            None
        };
    if let Some(diagnostic) = diagnostic {
        message.push_str(&format!(" — {diagnostic}"));
    }
    message
}

/// Wait up to `wait` for the exit status of a child whose stdout already EOF'd,
/// **killing it** if that wait does not reap it.
///
/// The kill is load-bearing, not belt-and-braces. By the time this runs the
/// child has been taken out of [`LoginSession::child`], so `cancel()` and the
/// 15-minute backstop can no longer reach it, and `tokio` does not kill a
/// `Child` on drop unless `kill_on_drop` is set. Both non-status paths —
/// the `wait` elapsing, and `wait()` itself returning `Err` — would otherwise
/// drop a live child, which is precisely the leak [`LoginSession::child`]
/// documents: an orphan holding the fixed OAuth callback port, so every later
/// login for that provider fails with `EADDRINUSE`.
pub(super) async fn reap_or_kill(
    child: &mut Child,
    wait: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    // A bridge can close stdout and exit before this function is reached. Reap
    // that common terminal path synchronously so a busy Tokio runtime cannot
    // spend the whole status ceiling waiting for an exit notification that is
    // already available from the OS.
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status);
    }
    match tokio::time::timeout(wait, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        _ => {
            let _ = child.start_kill();
            None
        }
    }
}

pub(super) type Registry = Mutex<HashMap<String, Arc<LoginSession>>>;

pub(super) fn sessions() -> &'static Registry {
    static SESSIONS: OnceLock<Registry> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get(session_id: &str) -> Option<Arc<LoginSession>> {
    sessions()
        .lock()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

/// Drop a session from the registry, killing its child first.
pub fn cancel(session_id: &str) -> bool {
    let removed = sessions()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(session_id));
    match removed {
        Some(session) => {
            session.cancel();
            true
        }
        None => false,
    }
}
