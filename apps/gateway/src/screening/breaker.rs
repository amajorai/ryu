//! Per-backend circuit breaker (screener addendum section 6): more than 20%
//! failures over 30 s opens the breaker for 30 s, per backend per replica.
//!
//! [`Breakered`] wraps a backend so an open breaker answers at once with
//! `Unavailable("breaker_open")` and sends nothing. The breaker is a
//! screening state only: it never touches a provider circuit, and a failed
//! screen is never a provider health signal (spec 00.11).
//!
//! Only the engine's health moves the breaker. A reply outside the grammar,
//! a refusal or a judge that did not answer is produced from the request's
//! own content, so once a readiness probe has found the engine ready it
//! counts for nothing here: otherwise a few derailing requests would open
//! the breaker and send every tenant's traffic to the degraded row. A broken
//! engine is still caught by the 10 s readiness probe, whose canary failure
//! force-opens the breaker. One request adds at most one failure to the
//! window, so a request with hundreds of items cannot open it alone.

use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use ryu_gw_screening::{
    BackendDescriptor, BackendError, BackendHealth, BackendVerdict, ScreenRequest, ScreenTier,
    ScreenerBackend,
};

/// The failure-rate window.
pub const WINDOW: Duration = Duration::from_secs(30);
/// How long an opened breaker stays open before a trial call.
pub const OPEN_FOR: Duration = Duration::from_secs(30);
/// The failure share above which the breaker opens.
pub const FAILURE_SHARE: f64 = 0.2;
/// Calls the window needs before the share is judged, so one slow request
/// on an idle replica does not open the breaker.
pub const MIN_SAMPLES: usize = 5;

/// `Unavailable` reasons that say the engine could not be reached at all:
/// refused or reset connections, an engine marked down, a closed gate. These
/// say nothing about the request's content, so they are an outage.
const UNREACHABLE_REASONS: &[&str] = &[
    "connect",
    "transport",
    "gate_closed",
    "down",
    "unreachable",
    "probe_timeout",
];

/// `Unavailable` reasons from an engine that answered but is overloaded or
/// misrouted (a 429, a redirect). They move the breaker, so a sustained
/// overload sheds load, but one of them on a request is not an outage: the
/// engine was there.
const LOADED_REASONS: &[&str] = &["busy", "redirect"];

/// How one failed call bears on the engine's health.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The engine or its transport failed: unreachable, busy (429), a
    /// redirect, a timeout.
    Health,
    /// The engine answered, but not with a verdict: a reply outside the
    /// grammar, a refusal, a judge that did not answer, an HTTP error
    /// status. Content can drive these.
    Content,
    /// Not a statement about the engine (not permitted, over capacity).
    Neutral,
}

/// Classify a backend error for the breaker. An unknown `Unavailable`
/// reason is content: it never opens the breaker for every tenant, and an
/// engine that keeps failing is caught by its readiness probe. So is an HTTP
/// error status (`http_status`): an engine answers a prompt it cannot take
/// (over its context, a token it rejects) with a 4xx, so content can produce
/// it; an engine that keeps answering 5xx fails its canary instead.
pub fn failure_kind(error: &BackendError) -> FailureKind {
    match error {
        BackendError::Timeout => FailureKind::Health,
        BackendError::Unavailable(reason)
            if UNREACHABLE_REASONS.contains(reason) || LOADED_REASONS.contains(reason) =>
        {
            FailureKind::Health
        }
        BackendError::Unavailable(_) | BackendError::Malformed => FailureKind::Content,
        BackendError::NotPermitted | BackendError::OverCapacity => FailureKind::Neutral,
    }
}

/// Whether `error` says the engine was out (unreachable, or its breaker
/// open), so it could not have answered whatever the content was. An engine
/// that answered (an error status, a 429, a redirect) was not out: a node
/// that fails closed refuses that request rather than serve it degraded.
pub fn is_engine_outage(error: &BackendError) -> bool {
    matches!(error, BackendError::Unavailable(reason)
        if *reason == "breaker_open" || UNREACHABLE_REASONS.contains(reason))
}

fn request_tag(correlation_id: &str) -> Option<u64> {
    if correlation_id.is_empty() {
        return None;
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    correlation_id.hash(&mut hasher);
    Some(hasher.finish())
}

/// What the breaker reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerState {
    Closed,
    Open,
    /// The open period passed; the next call is a trial.
    HalfOpen,
}

impl BreakerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
            Self::HalfOpen => "half_open",
        }
    }
}

/// The last readiness probe.
#[derive(Debug, Clone)]
pub struct ProbeRecord {
    pub at: std::time::SystemTime,
    pub health: BackendHealth,
}

#[derive(Debug, Default)]
struct Inner {
    /// `(when, ok, request tag)`: a failure carries its request's tag so a
    /// request adds at most one failure to the window.
    samples: VecDeque<(Instant, bool, Option<u64>)>,
    opened_at: Option<Instant>,
    last_probe: Option<ProbeRecord>,
    /// Transitions not yet published as `screening_degraded` events.
    pending: Vec<BreakerState>,
}

/// One backend's breaker.
#[derive(Debug, Default)]
pub struct Breaker {
    inner: Mutex<Inner>,
}

impl Breaker {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn state(&self) -> BreakerState {
        let inner = self.lock();
        match inner.opened_at {
            None => BreakerState::Closed,
            Some(at) if at.elapsed() < OPEN_FOR => BreakerState::Open,
            Some(_) => BreakerState::HalfOpen,
        }
    }

    /// Whether a call may go out now (closed, or a half-open trial).
    pub fn allows(&self) -> bool {
        self.state() != BreakerState::Open
    }

    /// Record a call's outcome. A failure in the half-open state reopens at
    /// once; a success closes.
    pub fn record(&self, ok: bool) {
        self.record_tagged(ok, None);
    }

    /// Record a failed call made for `correlation_id`. While the breaker is
    /// closed a request's second and later failures in the window are not
    /// counted again.
    pub fn record_failure_for(&self, correlation_id: &str) {
        self.record_tagged(false, request_tag(correlation_id));
    }

    fn record_tagged(&self, ok: bool, tag: Option<u64>) {
        let now = Instant::now();
        let mut inner = self.lock();
        while inner
            .samples
            .front()
            .is_some_and(|(at, _, _)| now.duration_since(*at) > WINDOW)
        {
            inner.samples.pop_front();
        }
        let repeat = !ok
            && tag.is_some()
            && inner.opened_at.is_none()
            && inner
                .samples
                .iter()
                .any(|(_, sample_ok, sample_tag)| !sample_ok && *sample_tag == tag);
        if repeat {
            return;
        }
        inner.samples.push_back((now, ok, tag));
        match inner.opened_at {
            Some(at) if at.elapsed() >= OPEN_FOR => {
                if ok {
                    inner.opened_at = None;
                    inner.samples.clear();
                    inner.pending.push(BreakerState::Closed);
                } else {
                    inner.opened_at = Some(now);
                    inner.pending.push(BreakerState::Open);
                }
            }
            Some(_) => {}
            None => {
                let total = inner.samples.len();
                let failed = inner.samples.iter().filter(|(_, ok, _)| !ok).count();
                if total >= MIN_SAMPLES && failed as f64 / total as f64 > FAILURE_SHARE {
                    inner.opened_at = Some(now);
                    inner.pending.push(BreakerState::Open);
                }
            }
        }
    }

    /// Open now (an engine down at boot, a failed readiness probe).
    pub fn force_open(&self) {
        let mut inner = self.lock();
        if inner.opened_at.is_none() {
            inner.pending.push(BreakerState::Open);
        }
        inner.opened_at = Some(Instant::now());
    }

    pub fn record_probe(&self, health: BackendHealth) {
        let ready = health == BackendHealth::Ready;
        {
            let mut inner = self.lock();
            inner.last_probe = Some(ProbeRecord {
                at: std::time::SystemTime::now(),
                health,
            });
        }
        if ready {
            // A ready probe is a trial success only once the open period has
            // passed; it never shortens the open period.
            if self.state() == BreakerState::HalfOpen {
                self.record(true);
            }
        } else {
            self.force_open();
        }
    }

    pub fn last_probe(&self) -> Option<ProbeRecord> {
        self.lock().last_probe.clone()
    }

    /// Whether the last readiness probe found the engine ready. Until one
    /// has, a content failure is the only evidence of a broken engine, so it
    /// still counts.
    pub fn probed_ready(&self) -> bool {
        self.lock()
            .last_probe
            .as_ref()
            .is_some_and(|probe| probe.health == BackendHealth::Ready)
    }

    /// Transitions since the last call, oldest first.
    pub fn take_transitions(&self) -> Vec<BreakerState> {
        std::mem::take(&mut self.lock().pending)
    }
}

/// A backend behind its breaker.
pub struct Breakered {
    inner: Arc<dyn ScreenerBackend>,
    pub breaker: Breaker,
}

impl Breakered {
    pub fn new(inner: Arc<dyn ScreenerBackend>) -> Self {
        Self {
            inner,
            breaker: Breaker::default(),
        }
    }
}

#[async_trait::async_trait]
impl ScreenerBackend for Breakered {
    fn descriptor(&self) -> &BackendDescriptor {
        self.inner.descriptor()
    }

    fn permits(&self, tier: ScreenTier) -> bool {
        self.inner.permits(tier)
    }

    async fn screen(&self, req: &ScreenRequest<'_>) -> Result<BackendVerdict, BackendError> {
        if !self.breaker.allows() {
            return Err(BackendError::Unavailable("breaker_open"));
        }
        let result = self.inner.screen(req).await;
        match &result {
            Ok(_) => self.breaker.record(true),
            Err(error) => match failure_kind(error) {
                FailureKind::Health => self.breaker.record_failure_for(req.correlation_id),
                // Content-driven: the request that caused it is refused by the
                // fail rules; the engine's health is the probe's to judge.
                FailureKind::Content if !self.breaker.probed_ready() => {
                    self.breaker.record_failure_for(req.correlation_id)
                }
                FailureKind::Content | FailureKind::Neutral => {}
            },
        }
        result
    }

    async fn probe(&self) -> BackendHealth {
        self.inner.probe().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_above_the_failure_share_and_not_on_one_failure() {
        let breaker = Breaker::default();
        breaker.record(false);
        assert_eq!(breaker.state(), BreakerState::Closed);
        for _ in 0..3 {
            breaker.record(true);
        }
        assert_eq!(breaker.state(), BreakerState::Closed);
        breaker.record(false);
        assert_eq!(breaker.state(), BreakerState::Open);
        assert_eq!(breaker.take_transitions(), vec![BreakerState::Open]);
        assert!(breaker.take_transitions().is_empty());
    }

    #[test]
    fn a_failed_probe_opens_and_a_ready_probe_does_not_shorten_it() {
        let breaker = Breaker::default();
        breaker.record_probe(BackendHealth::Down("refused"));
        assert_eq!(breaker.state(), BreakerState::Open);
        breaker.record_probe(BackendHealth::Ready);
        assert_eq!(breaker.state(), BreakerState::Open);
        assert!(breaker.last_probe().is_some());
    }
}

#[cfg(test)]
#[path = "breaker_tests.rs"]
mod health_tests;
