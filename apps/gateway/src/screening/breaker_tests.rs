//! Only engine health moves the breaker: content-driven non-answers from a
//! probed-ready engine (GuardBreaker-style derailment) never open it, and one
//! request cannot open it alone.

use std::sync::Arc;
use std::time::{Duration, Instant};

use ryu_gw_screening::backends::test::TestBackend;
use ryu_gw_screening::{
    BackendError, BackendHealth, CodeSet, Direction, LeafClass, ScreenItem, ScreenRequest,
    ScreenTier, ScreenerBackend, SegmentKey,
};

use super::*;

fn breakered(backend: TestBackend) -> Breakered {
    Breakered::new(Arc::new(backend))
}

async fn screen_once(backend: &Breakered, correlation_id: &str, text: &str) {
    let key = SegmentKey::for_text_in_context(&[1; 32], LeafClass::User, text, None);
    let items = [ScreenItem::text(key, LeafClass::User, text)];
    let wanted = CodeSet::hazards();
    let request = ScreenRequest {
        correlation_id,
        direction: Direction::Inbound,
        tier: ScreenTier::Floor,
        items: &items,
        wanted: &wanted,
        deadline: Instant::now() + Duration::from_secs(5),
    };
    let _ = backend.screen(&request).await;
}

#[test]
fn failures_are_classified_by_what_they_say_about_the_engine() {
    assert_eq!(failure_kind(&BackendError::Timeout), FailureKind::Health);
    for reason in ["connect", "transport", "busy", "redirect", "down"] {
        assert_eq!(
            failure_kind(&BackendError::Unavailable(reason)),
            FailureKind::Health,
            "{reason}"
        );
    }
    for error in [
        BackendError::Malformed,
        BackendError::Unavailable("judge_did_not_answer"),
        BackendError::Unavailable("judge_refused"),
        BackendError::Unavailable("text_only"),
        BackendError::Unavailable("http_status"),
    ] {
        assert_eq!(failure_kind(&error), FailureKind::Content, "{error:?}");
        assert!(!is_engine_outage(&error), "{error:?}");
    }
    assert_eq!(
        failure_kind(&BackendError::OverCapacity),
        FailureKind::Neutral
    );
    assert!(is_engine_outage(&BackendError::Unavailable("breaker_open")));
    assert!(is_engine_outage(&BackendError::Unavailable("connect")));
    assert!(!is_engine_outage(&BackendError::Timeout));
    // An engine that answered was not out, whatever it answered.
    for reason in ["busy", "redirect", "http_status"] {
        assert!(!is_engine_outage(&BackendError::Unavailable(reason)), "{reason}");
    }
}

/// An HTTP error status is what an engine answers a prompt it cannot take
/// (over its context, a token it rejects), so content can produce it: from a
/// probed-ready engine it never opens the breaker for every tenant.
#[tokio::test]
async fn an_error_status_from_a_probed_ready_engine_never_opens_the_breaker() {
    let backend = breakered(
        TestBackend::new("guard").fail_on("OVERLONG", BackendError::Unavailable("http_status")),
    );
    backend.breaker.record_probe(BackendHealth::Ready);
    for request in 0..10 {
        screen_once(&backend, &format!("req-{request}"), "OVERLONG prompt").await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Closed);
    assert!(backend.breaker.take_transitions().is_empty());
}

/// A ready engine whose replies are derailed by content keeps its breaker
/// closed, however many requests do it.
#[tokio::test]
async fn content_failures_from_a_probed_ready_engine_never_open_the_breaker() {
    for error in [
        BackendError::Malformed,
        BackendError::Unavailable("judge_did_not_answer"),
        BackendError::Unavailable("judge_refused"),
    ] {
        let backend = breakered(TestBackend::new("guard").fail_on("DERAIL", error.clone()));
        backend.breaker.record_probe(BackendHealth::Ready);
        for request in 0..10 {
            screen_once(&backend, &format!("req-{request}"), "DERAIL me").await;
        }
        assert_eq!(backend.breaker.state(), BreakerState::Closed, "{error:?}");
        assert!(backend.breaker.take_transitions().is_empty(), "{error:?}");
    }
}

/// Before any probe, content failures are the only evidence of a broken
/// engine, so they still count; a failed canary still force-opens.
#[tokio::test]
async fn unprobed_content_failures_and_a_malformed_canary_still_open() {
    let backend = breakered(TestBackend::new("guard").fail_always(BackendError::Malformed));
    for request in 0..5 {
        screen_once(&backend, &format!("req-{request}"), "anything").await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Open);

    let probed = Breaker::default();
    probed.record_probe(BackendHealth::Ready);
    probed.record_probe(BackendHealth::Down("canary_malformed"));
    assert_eq!(probed.state(), BreakerState::Open);
}

/// Transport failures are engine health: they open the breaker even after a
/// ready probe.
#[tokio::test]
async fn transport_failures_open_the_breaker() {
    let backend =
        breakered(TestBackend::new("decision").fail_always(BackendError::Unavailable("transport")));
    backend.breaker.record_probe(BackendHealth::Ready);
    for request in 0..5 {
        screen_once(&backend, &format!("req-{request}"), "anything").await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Open);
}

/// One request with many failing chunks adds one failure, so it cannot open
/// the breaker on its own.
#[tokio::test]
async fn one_request_adds_at_most_one_failure() {
    let backend =
        breakered(TestBackend::new("decision").fail_always(BackendError::Unavailable("transport")));
    for _ in 0..20 {
        screen_once(&backend, "one-request", "chunk").await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Closed);
    for request in 0..4 {
        screen_once(&backend, &format!("other-{request}"), "chunk").await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Open);
}
