//! The section 6 fail rules against GuardBreaker-style derailment: a
//! screener that answers outside its grammar, refuses, or never reads an
//! item must refuse the request, never serve it degraded or clean.

use std::sync::Arc;

use ryu_gw_screening::backends::test::TestBackend;
use ryu_gw_screening::{BackendError, CodeSet, TaxonomyId};
use serde_json::{json, Value};

use super::fixture::{
    ctx, floor, marked_parts, probe, qualification, runtime, screener, screening_config, state,
};
use super::{screen_chat, Surface};
use crate::custody::GatewayCustody;
use crate::error::GatewayError;
use crate::screening::breaker::BreakerState;

const DERAIL: &str = "DERAILMARKER";

fn derailing() -> Arc<TestBackend> {
    Arc::new(TestBackend::new("decision_local").fail_on(DERAIL, BackendError::Malformed))
}

/// One request whose every chunk derails the floor's screener is refused
/// with 503 and leaves the breaker closed: its own failures can neither open
/// the breaker nor buy it the degraded row, for it or any other tenant.
#[tokio::test]
async fn a_derailed_floor_screen_is_refused_and_never_opens_the_breaker() {
    let backend = derailing();
    let state = state(
        GatewayCustody::Fleet,
        runtime(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(screener(json!({})))),
        Default::default(),
    );
    probe(&state).await;
    for request in 0..3 {
        let body = marked_parts(DERAIL, 6);
        let result = screen_chat(
            &state,
            &ctx(&format!("derail-{request}")),
            &body,
            Surface::Chat,
        )
        .await;
        assert!(
            matches!(result, Err(GatewayError::ScreeningUnavailable { .. })),
            "{request}: {:?}",
            result.map(|r| r.degraded)
        );
    }
    let slot = state.screening.slot("decision_local").expect("slot");
    assert_eq!(slot.breaker_state(), BreakerState::Closed);
    // Other traffic is still screened by the backend, not the degraded row.
    let clean = json!({ "messages": [{ "role": "user", "content": "benign question" }] });
    let report = screen_chat(&state, &ctx("clean"), &clean, Surface::Chat)
        .await
        .expect("clean request passes");
    assert_eq!(report.degraded, None);
}

pub(super) fn node_state(
    fail_mode: &str,
    backend: Arc<TestBackend>,
) -> Arc<crate::state::AppState> {
    let config = screening_config(&format!("node_classifiers = true\n{fail_mode}"));
    state(
        GatewayCustody::SelfHosted,
        runtime(&config, std::slice::from_ref(&backend)),
        None,
        config,
    )
}

pub(super) fn chat(text: &str) -> Value {
    json!({ "messages": [{ "role": "user", "content": text }] })
}

/// `node_fail_mode` defaults to closed: a node screener derailed by content
/// refuses the request; `degraded` keeps the old forward-and-mark rule; an
/// engine that is unreachable still runs the degraded row either way.
#[tokio::test]
async fn a_node_fails_closed_on_a_derailed_screener_unless_it_opts_out() {
    let malformed =
        || Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Malformed));
    let closed = node_state("", malformed());
    let result = screen_chat(
        &closed,
        &ctx("node-closed"),
        &chat("question"),
        Surface::Chat,
    )
    .await;
    assert!(
        matches!(result, Err(GatewayError::ScreeningUnavailable { .. })),
        "{:?}",
        result.map(|r| r.degraded)
    );
    let refused = Arc::new(
        TestBackend::new("decision_local").fail_always(BackendError::Unavailable("judge_refused")),
    );
    let closed = node_state("node_fail_mode = \"closed\"", refused);
    let result = screen_chat(
        &closed,
        &ctx("node-refused"),
        &chat("question"),
        Surface::Chat,
    )
    .await;
    assert!(matches!(
        result,
        Err(GatewayError::ScreeningUnavailable { .. })
    ));

    let degraded = node_state("node_fail_mode = \"degraded\"", malformed());
    let report = screen_chat(
        &degraded,
        &ctx("node-degraded"),
        &chat("question"),
        Surface::Chat,
    )
    .await
    .expect("degraded mode forwards");
    assert_eq!(report.degraded, Some("t2"));

    let down = Arc::new(
        TestBackend::new("decision_local").fail_always(BackendError::Unavailable("connect")),
    );
    let outage = node_state("", down);
    let report = screen_chat(
        &outage,
        &ctx("node-outage"),
        &chat("question"),
        Surface::Chat,
    )
    .await
    .expect("an engine outage runs the degraded row");
    assert_eq!(report.degraded, Some("t2"));
}

/// An engine that answered with an error status or a 429 was reachable: on
/// a node that fails closed the request is refused, never served degraded,
/// so content that makes the engine reject it (a prompt over its context)
/// or a flood that makes it busy cannot buy the degraded row.
#[tokio::test]
async fn a_node_refuses_when_its_engine_answered_with_an_error() {
    for reason in ["http_status", "busy"] {
        let backend = Arc::new(
            TestBackend::new("decision_local").fail_always(BackendError::Unavailable(reason)),
        );
        let closed = node_state("", backend);
        let result = screen_chat(
            &closed,
            &ctx(&format!("node-{reason}")),
            &chat("question"),
            Surface::Chat,
        )
        .await;
        assert!(
            matches!(result, Err(GatewayError::ScreeningUnavailable { .. })),
            "{reason}: {:?}",
            result.map(|r| r.degraded)
        );
    }
}

pub(super) fn attack_floor(attack: Arc<TestBackend>, extra: Value) -> Arc<crate::state::AppState> {
    let mut roles = json!({
        "roles": {
            "textHazard": ["decision_local"],
            "promptAttack": ["attack"],
            "output": ["decision_local"],
        },
    });
    if let (Some(target), Some(extra)) = (roles.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    let backends = [Arc::new(TestBackend::new("decision_local")), attack];
    state(
        GatewayCustody::Fleet,
        runtime(&Default::default(), &backends),
        Some(floor(screener(roles))),
        Default::default(),
    )
}

pub(super) fn attack_backend() -> TestBackend {
    TestBackend::new("attack").covers(CodeSet::from([TaxonomyId::PROMPT_INJECTION]))
}

/// A prompt-attack screen that answered nothing marks the verdict degraded
/// (`t1`) instead of reading as clean; marked hard, it is refused like any
/// hard code a healthy qualified screener left undecided.
#[tokio::test]
async fn an_undecided_prompt_attack_is_marked_and_a_hard_one_refused() {
    let soft = attack_floor(
        Arc::new(attack_backend().fail_always(BackendError::Malformed)),
        json!({}),
    );
    let report = screen_chat(&soft, &ctx("attack-soft"), &chat("question"), Surface::Chat)
        .await
        .expect("a soft code is served");
    assert_eq!(report.degraded, Some("t1"));

    let code = TaxonomyId::PROMPT_INJECTION.as_str();
    let hard = attack_floor(
        Arc::new(attack_backend().fail_always(BackendError::Malformed)),
        json!({
            "hazards": { code: { "action": "block", "blockThreshold": 0.5, "flagThreshold": 0.3, "hard": true } },
            "qualifications": [
                qualification("decision_local", &["hazard.S4", "hazard.S9"]),
                qualification("attack", &[code]),
            ],
        }),
    );
    let result = screen_chat(&hard, &ctx("attack-hard"), &chat("question"), Surface::Chat).await;
    assert!(
        matches!(result, Err(GatewayError::ScreeningUnavailable { .. })),
        "{:?}",
        result.map(|r| r.degraded)
    );
}
