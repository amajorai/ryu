//! Classifying a failed turn, and the handles the streaming routes use to
//! report how it ended.

/// Why a turn ended, as far as the reactive path cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The gateway told us, in a typed way, that an upstream provider is rate
    /// limited (HTTP 429 / `provider_rate_limited` / `rate_limit_exceeded`).
    RateLimited,
    /// Anything else. Still worth a look on the ACP plane, where the vendor CLI
    /// reports a cap as an ordinary error, but never on its own a reason to
    /// reroute — [`super::decide`] confirms against the windows either way.
    Other,
}

/// What one failed attempt reported back, so the retry wrapper can decide
/// without re-parsing the SSE it just forwarded.
#[derive(Debug, Clone)]
pub struct TurnFailure {
    /// The agent that was running when it failed.
    pub agent_id: String,
    /// The model the turn was pinned to, when it was pinned.
    pub model: Option<String>,
    pub kind: FailureKind,
    /// Whether ANY assistant content (text delta or tool row) reached the client
    /// before the failure.
    ///
    /// This is recorded as a flag at the emit sites, never inferred from the
    /// byte stream: `error_ui_lines` is three lines and there is preamble, so
    /// counting is unreliable in exactly the direction that double-renders a
    /// half-written answer. A retry is only safe when this is false — which is
    /// the case that matters, because a vendor cap arrives as a banner at
    /// session start, before any content.
    pub emitted_content: bool,
    /// The vendor's own message, preserved for the surfaced error.
    pub detail: String,
}

/// A handle the streaming routes use to report how a turn ended, so the retry
/// wrapper can decide without re-parsing the SSE it already forwarded.
///
/// Cheap and clonable, and **disarmed by default**: [`TurnWatch::off`] holds no
/// allocation and every method is a no-op, so the four callers that do not want
/// retry semantics (voice, the three team paths) and every node that never
/// enabled the feature pay nothing. Only the retry wrapper arms one.
#[derive(Debug, Clone, Default)]
pub struct TurnWatch(Option<std::sync::Arc<std::sync::Mutex<WatchState>>>);

#[derive(Debug, Default)]
struct WatchState {
    emitted_content: bool,
    failure: Option<TurnFailure>,
}

impl TurnWatch {
    /// A disarmed handle. Every method is a no-op.
    pub fn off() -> Self {
        Self(None)
    }

    /// An armed handle that records what happens to the turn.
    pub fn armed() -> Self {
        Self(Some(std::sync::Arc::new(std::sync::Mutex::new(
            WatchState::default(),
        ))))
    }

    /// Whether anyone is listening — lets a hot path skip the work entirely.
    pub fn is_armed(&self) -> bool {
        self.0.is_some()
    }

    /// Record that assistant content (a text delta or a tool row) has reached
    /// the client. Called at the emit sites rather than inferred from the byte
    /// stream — see [`TurnFailure::emitted_content`].
    pub fn mark_content(&self) {
        let Some(state) = &self.0 else { return };
        if let Ok(mut state) = state.lock() {
            state.emitted_content = true;
        }
    }

    /// Record that the turn failed. The FIRST failure wins: a route that fails
    /// and then tears down must not have its cause overwritten by the teardown.
    pub fn record_failure(
        &self,
        agent_id: &str,
        model: Option<&str>,
        kind: FailureKind,
        detail: &str,
    ) {
        let Some(state) = &self.0 else { return };
        if let Ok(mut state) = state.lock() {
            if state.failure.is_some() {
                return;
            }
            state.failure = Some(TurnFailure {
                agent_id: agent_id.to_string(),
                model: model.map(str::to_string),
                kind,
                emitted_content: state.emitted_content,
                detail: detail.to_string(),
            });
        }
    }

    /// Whether any assistant content has reached the client yet. The retry
    /// wrapper uses this to decide when it can stop buffering and start
    /// forwarding: once the user is reading an answer, no retry is possible, so
    /// there is nothing left to hold back.
    pub fn saw_content(&self) -> bool {
        self.0
            .as_ref()
            .and_then(|s| s.lock().ok().map(|s| s.emitted_content))
            .unwrap_or(false)
    }

    /// Whether this turn is a candidate for a retry: it failed, and nothing has
    /// been shown to the user yet.
    ///
    /// The content check is the one that keeps a retry from double-rendering a
    /// half-written answer on top of a fresh one. It reads `emitted_content` as
    /// of *now* rather than as of the failure, because content can still be
    /// flushed between the two.
    pub fn retryable(&self) -> Option<TurnFailure> {
        let state = self.0.as_ref()?.lock().ok()?;
        let failure = state.failure.clone()?;
        if state.emitted_content || failure.emitted_content {
            return None;
        }
        Some(failure)
    }
}

/// What the retry wrapper should do with one frame it just took off attempt 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameAction {
    /// Hold it back. The turn might still be retried, and forwarding now would
    /// leave the error triple on screen underneath the retry's answer.
    Hold,
    /// Content has appeared: flush everything held so far (this frame last) and
    /// stay in passthrough from here.
    Flush,
    /// Already passing through; forward immediately.
    Pass,
}

/// The wrapper's frame gate, as a pure state machine.
///
/// Extracted from the stream generator because that is the one place in this
/// feature the compiler is the only reviewer: an off-by-one here either strands
/// frames the client needed or double-renders a half-written answer, and neither
/// shows up in a test of [`super::decide`].
///
/// The gate is monotonic — once content has been seen it never goes back to
/// holding — which is what bounds the buffer to the preamble rather than to the
/// size of an answer.
#[derive(Debug, Default, Clone, Copy)]
pub struct FrameGate {
    passthrough: bool,
}

impl FrameGate {
    /// Classify the frame just received, given whether any assistant content has
    /// been emitted by now.
    pub fn admit(&mut self, saw_content: bool) -> FrameAction {
        if self.passthrough {
            return FrameAction::Pass;
        }
        if saw_content {
            self.passthrough = true;
            return FrameAction::Flush;
        }
        FrameAction::Hold
    }

    /// Whether anything was forwarded to the client. A turn that never left the
    /// gate is the only one a retry may replace.
    pub fn forwarded_anything(&self) -> bool {
        self.passthrough
    }
}

/// Whether a gateway-plane response is a typed rate-limit refusal.
///
/// Reads the status and the OpenAI-shaped `error.type` the Gateway emits
/// (`apps/gateway/src/error.rs`), never the human message: the message is
/// prose that changes, the type is a contract.
pub fn gateway_failure_kind(status: u16, error_type: Option<&str>) -> FailureKind {
    const RATE_LIMIT_TYPES: &[&str] = &["provider_rate_limited", "rate_limit_exceeded"];
    if status == 429 || error_type.is_some_and(|t| RATE_LIMIT_TYPES.contains(&t)) {
        FailureKind::RateLimited
    } else {
        FailureKind::Other
    }
}

/// Pull the `error.type` out of a gateway error body, if it is one.
pub fn error_type_of(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("error")?
        .get("type")?
        .as_str()
        .map(str::to_owned)
}
