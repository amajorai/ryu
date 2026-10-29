use super::*;

/// How long abandoned provider work may hold the org's credit claim: a tool
/// round still running when its loop was abandoned (billed as its prompt
/// estimate after this, its late output unbilled), or a detached stream open
/// (refused after this).
///
/// Longer than any buffered call the built-in adapters make can live: at most
/// four attempts of a 300-second request timeout plus back-off, about 20
/// minutes. Those timeouts and retry counts are each adapter's constructor
/// arguments and are not visible through the `Provider` trait, so the bound is
/// a constant with headroom rather than derived per provider. It only keeps a
/// hung call from holding the claim forever.
pub(super) const ABANDONED_PROVIDER_WAIT: std::time::Duration =
    std::time::Duration::from_secs(30 * 60);

/// Settles a stream whose client goes away before its first byte.
///
/// `run_stream` returns its body only once the stream is open: an ordinary
/// stream when the provider answers with headers, a tool-loop stream when
/// every buffered round has run. A client that hangs up during that wait drops
/// `run_stream` before the body exists. So the observer is built first and
/// held here while the stream opens. Dropped there (a client hang-up, a pool
/// deadline), it settles what the provider was given:
///
///  - an ordinary stream: its prompt, estimated, once the provider accepts
///    it; nothing if the provider refuses it. The open runs on its own task
///    (see [`DetachedStreamOpen`]), so its outcome, not the hang-up, decides;
///  - a tool loop: the rounds the provider answered. A round still running is
///    left to finish (see [`tool_rounds::MeteredRounds`]) and billed from its
///    real usage. The loop itself stops, so no further tool runs.
///
/// Armed only for a request that debits a wallet. An unmetered stream keeps
/// cancel-on-drop: nothing reached the client, and nothing is recorded.
pub(super) struct StreamOpening {
    pub(super) observer: Option<StreamObserverState>,
    pub(super) rounds: Option<Arc<tool_rounds::ToolRoundLedger>>,
    pub(super) detached_open: Option<Arc<DetachedStreamOpen>>,
    pub(super) armed: bool,
}

impl StreamOpening {
    pub(super) fn new(
        observer: StreamObserverState,
        rounds: Option<Arc<tool_rounds::ToolRoundLedger>>,
        detached_open: Option<Arc<DetachedStreamOpen>>,
        armed: bool,
    ) -> Self {
        Self {
            observer: Some(observer),
            rounds,
            detached_open,
            armed,
        }
    }

    /// The stream opened, or failed to: the observer is the caller's again.
    pub(super) fn opened(mut self) -> StreamObserverState {
        self.observer
            .take()
            .expect("StreamOpening holds its observer until opened")
    }
}

impl Drop for StreamOpening {
    fn drop(&mut self) {
        let Some(mut observer) = self.observer.take() else {
            return;
        };
        if !self.armed {
            // Unmetered: release any claim without settling anything.
            observer.done = true;
            return;
        }
        let Some(ledger) = self.rounds.take() else {
            match self.detached_open.take() {
                // Settled when the open resolves: the prompt if accepted.
                Some(open) => open.abandon(observer),
                // Settled by the observer's own drop: the prompt, estimated.
                None => {
                    observer.interruption = Some(PRE_FIRST_BYTE_INTERRUPTION);
                }
            }
            return;
        };
        observer.interruption = Some("client disconnected during the tool loop");
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            // No runtime to wait on: settle the rounds answered so far.
            observer.tool_rounds = Some(ledger.totals());
            return;
        };
        handle.spawn(async move {
            observer.tool_rounds = Some(ledger.settled(ABANDONED_PROVIDER_WAIT).await);
            drop(observer);
        });
    }
}

pub(super) const PRE_FIRST_BYTE_INTERRUPTION: &str =
    "client disconnected before the first byte; usage estimated";

/// A metered stream's open, run on its own task.
///
/// Awaited inline, a client that hangs up before the first byte cancels the
/// open, and the Gateway cannot tell whether the provider accepted the prompt
/// or was still retrying a 5xx, a refused connection or a rate-limited
/// account. On its own task the open always resolves, and the outcome
/// decides: accepted, the prompt is billed as an estimate and the body is
/// dropped, which ends the generation; refused, nothing is charged and the
/// credit claim is released.
///
/// Whichever of the two happens second (the open resolving, the caller
/// abandoning it) settles, under one lock, so neither order can lose it.
#[derive(Default)]
pub(super) struct DetachedStreamOpen {
    pub(super) state: std::sync::Mutex<DetachedOpenState>,
    pub(super) resolved: tokio::sync::Notify,
}

#[derive(Default)]
pub(super) struct DetachedOpenState {
    /// The provider call has been started.
    pub(super) dispatched: bool,
    /// How the open resolved, while no caller has taken it.
    pub(super) outcome: Option<Result<Body, ryu_gw_providers::ProviderError>>,
    /// The observer of a caller that hung up before the open resolved.
    pub(super) abandoned: Option<StreamObserverState>,
}

impl DetachedStreamOpen {
    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, DetachedOpenState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Open the stream on its own task and wait for the outcome.
    pub(super) async fn open(
        self: &Arc<Self>,
        provider: Arc<dyn ryu_gw_providers::Provider>,
        model: String,
        body: Value,
        session: Option<String>,
    ) -> Result<Body, ryu_gw_providers::ProviderError> {
        use futures_util::FutureExt;
        use tracing::Instrument;
        self.lock().dispatched = true;
        let shared = Arc::clone(self);
        // A task-local trace scope does not follow `tokio::spawn`; carry it so
        // the provider request still carries the attempt's trace context.
        tokio::spawn(ryu_gw_providers::trace_context::carry(
            async move {
                let opening = std::panic::AssertUnwindSafe(provider.complete_stream_for_session(
                    &model,
                    &body,
                    session.as_deref(),
                ))
                .catch_unwind();
                let outcome = match tokio::time::timeout(ABANDONED_PROVIDER_WAIT, opening).await {
                    Ok(Ok(outcome)) => outcome,
                    Ok(Err(_)) => Err(ryu_gw_providers::ProviderError::Provider(
                        "stream open panicked".to_owned(),
                    )),
                    Err(_) => Err(ryu_gw_providers::ProviderError::Transport(
                        "stream open timed out".to_owned(),
                    )),
                };
                shared.resolve(outcome);
            }
            .in_current_span(),
        ));
        loop {
            let resolved = self.resolved.notified();
            tokio::pin!(resolved);
            // Register before reading, so a resolution in between still wakes us.
            resolved.as_mut().enable();
            if let Some(outcome) = self.lock().outcome.take() {
                return outcome;
            }
            resolved.await;
        }
    }

    pub(super) fn resolve(&self, outcome: Result<Body, ryu_gw_providers::ProviderError>) {
        let mut state = self.lock();
        if let Some(observer) = state.abandoned.take() {
            drop(state);
            settle_abandoned_open(observer, outcome);
            return;
        }
        state.outcome = Some(outcome);
        drop(state);
        self.resolved.notify_waiters();
    }

    /// The caller hung up while the stream was opening.
    pub(super) fn abandon(&self, mut observer: StreamObserverState) {
        let mut state = self.lock();
        if !state.dispatched {
            // Nothing reached the provider: release the claim, charge nothing.
            observer.done = true;
            return;
        }
        match state.outcome.take() {
            Some(outcome) => {
                drop(state);
                settle_abandoned_open(observer, outcome);
            }
            None => state.abandoned = Some(observer),
        }
    }
}

/// Settle a stream open its caller abandoned, by how the open resolved.
pub(super) fn settle_abandoned_open(
    mut observer: StreamObserverState,
    outcome: Result<Body, ryu_gw_providers::ProviderError>,
) {
    match outcome {
        // Accepted: the provider has the prompt and the client received
        // nothing. Dropping the observed body ends the generation and settles
        // the prompt, estimated.
        Ok(body) => {
            observer.interruption = Some(PRE_FIRST_BYTE_INTERRUPTION);
            drop(observe_stream(body, observer));
        }
        // Refused: nothing was served, so nothing is charged and the claim is
        // released.
        Err(_) => observer.done = true,
    }
}

/// Build a [`StreamObserverState`] and run `body` through it (tests).
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn attach_stream_observer(
    body: Body,
    state: Arc<AppState>,
    ctx: RequestContext,
    provider_name: String,
    model: String,
    prompt_cache_outcome: ryu_gw_providers::PromptCacheOutcome,
    estimated_input_tokens: u64,
    start: Instant,
    budget_alert_tier: Option<AlertTier>,
    // The admission credit claim. Released after this stream's debit resolves.
    credit_reservation: Option<CreditReservation>,
) -> Body {
    observe_stream(
        body,
        StreamObserverState::new(
            state,
            ctx,
            provider_name,
            model,
            prompt_cache_outcome,
            estimated_input_tokens,
            start,
            budget_alert_tier,
            credit_reservation,
        ),
    )
}
