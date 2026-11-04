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
    // An engine that answered was not out, whatever it answered; nor was
    // one that was reached and reset the request (a body can cause that).
    for reason in ["busy", "redirect", "http_status", "transport"] {
        assert!(
            !is_engine_outage(&BackendError::Unavailable(reason)),
            "{reason}"
        );
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

fn subject_ctx(org: &str) -> crate::pipeline::RequestContext {
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.org_id = Some(org.to_owned());
    ctx
}

/// review-timeout-still-counts-toward-breaker: a timeout is a health failure,
/// and a payload can be sized to cause one. One subject sending many such
/// requests adds one failure to the window, so it cannot open the breaker for
/// every tenant; failures from many subjects still open it.
#[tokio::test]
async fn one_subject_cannot_open_the_breaker_with_timeouts() {
    let slow = || breakered(TestBackend::new("guard").fail_on("STALL", BackendError::Timeout));
    let backend = slow();
    let attacker = subject_ctx("org-attacker");
    for request in 0..10 {
        super::for_subject(
            &attacker,
            screen_once(&backend, &format!("req-{request}"), "STALL payload"),
        )
        .await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Closed);

    let backend = slow();
    for request in 0..10 {
        let tenant = subject_ctx(&format!("org-{request}"));
        super::for_subject(
            &tenant,
            screen_once(&backend, &format!("req-{request}"), "STALL payload"),
        )
        .await;
    }
    assert_eq!(backend.breaker.state(), BreakerState::Open);

    // An unreachable engine still opens it from one subject.
    let down =
        breakered(TestBackend::new("guard").fail_on("STALL", BackendError::Unavailable("down")));
    for request in 0..10 {
        super::for_subject(
            &attacker,
            screen_once(&down, &format!("req-{request}"), "STALL payload"),
        )
        .await;
    }
    assert_eq!(down.breaker.state(), BreakerState::Open);
}

#[test]
fn the_subject_is_the_tenant_else_the_credential() {
    let mut first = crate::pipeline::test_support::plain_request_context();
    let mut second = first.clone();
    second.owner_binding = "another-credential".into();
    assert_ne!(super::subject_tag(&first), super::subject_tag(&second));
    first.org_id = Some("org-a".into());
    second.org_id = Some("org-a".into());
    assert_eq!(super::subject_tag(&first), super::subject_tag(&second));
}

/// A 429 (the caller's own flood) and a reset transport (a body the engine
/// aborts reading, or one that crashes a worker) are health failures a caller
/// can produce on a healthy engine: one subject adds one failure to the
/// window however often it causes them, while many subjects still open the
/// breaker. A refused connection still opens it from one subject.
#[tokio::test]
async fn one_subject_cannot_open_the_breaker_with_busy_or_reset_transport() {
    for reason in ["busy", "transport"] {
        assert!(counts_per_subject(&BackendError::Unavailable(reason)));
        let flood = || {
            breakered(TestBackend::new("guard").fail_on("FLOOD", BackendError::Unavailable(reason)))
        };
        let backend = flood();
        backend.breaker.record_probe(BackendHealth::Ready);
        let attacker = subject_ctx("org-attacker");
        for request in 0..10 {
            super::for_subject(
                &attacker,
                screen_once(&backend, &format!("req-{request}"), "FLOOD payload"),
            )
            .await;
        }
        assert_eq!(backend.breaker.state(), BreakerState::Closed, "{reason}");

        let backend = flood();
        backend.breaker.record_probe(BackendHealth::Ready);
        for request in 0..10 {
            let tenant = subject_ctx(&format!("org-{request}"));
            super::for_subject(
                &tenant,
                screen_once(&backend, &format!("req-{request}"), "FLOOD payload"),
            )
            .await;
        }
        assert_eq!(backend.breaker.state(), BreakerState::Open, "{reason}");
    }

    for reason in ["connect", "down", "unreachable", "redirect"] {
        assert!(
            !counts_per_subject(&BackendError::Unavailable(reason)),
            "{reason}"
        );
    }
    let refused =
        breakered(TestBackend::new("guard").fail_always(BackendError::Unavailable("connect")));
    refused.breaker.record_probe(BackendHealth::Ready);
    let attacker = subject_ctx("org-attacker");
    for request in 0..10 {
        super::for_subject(
            &attacker,
            screen_once(&refused, &format!("req-{request}"), "anything"),
        )
        .await;
    }
    assert_eq!(refused.breaker.state(), BreakerState::Open);
}
