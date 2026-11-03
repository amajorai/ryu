//! An inline LLM-judge binding whose judge gives no verdict: a refusal flags
//! every judge, and a custom judge with no lexical seed also flags on the gaps
//! an attacker can produce, so the binding's action applies instead of a
//! silent allow.

use std::{
    pin::Pin,
    sync::{Arc, Mutex},
};

use axum::body::Body;
use serde_json::{json, Value};

use super::{flag_inline_binding, InlineFlag};
use crate::{
    audit::AuditLogger,
    config::{
        AuditConfig, FirewallConfig, FirewallPolicy, GatewayConfig, InspectorFailMode, ProviderId,
    },
    evaluators::{Evaluator, EvaluatorImpl, EvaluatorRegistry},
    providers::Provider,
    state::AppState,
};

const PROVIDER: &str = "inline-judge-gap-stub";

type ProviderFuture<'a, T> = Pin<
    Box<dyn std::future::Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>,
>;

/// Answers every judge call with `reply`, and counts the calls.
struct ReplyProvider {
    reply: &'static str,
    calls: Mutex<usize>,
}

impl Provider for ReplyProvider {
    fn name(&self) -> &'static str {
        PROVIDER
    }
    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        Box::pin(async move {
            *self.calls.lock().unwrap() += 1;
            Ok(json!({
                "choices": [{"message": {"role": "assistant", "content": self.reply}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1},
            }))
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

fn state(reply: &'static str) -> (Arc<AppState>, Arc<ReplyProvider>) {
    state_routed(reply, PROVIDER, None)
}

/// A state whose judge routes to `route`; a name with no registered provider
/// leaves the judge unreachable.
fn state_routed(
    reply: &'static str,
    route: &str,
    fail_mode: Option<InspectorFailMode>,
) -> (Arc<AppState>, Arc<ReplyProvider>) {
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from(route);
    config.routing.fallback_chain = vec![ProviderId::from(route)];
    config.cache.enabled = false;
    config.firewall = FirewallConfig {
        enabled: true,
        ..FirewallConfig::default()
    };
    config.firewall.inspector.model = "judge-model".into();
    config.firewall.inspector.fail_mode = fail_mode;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    let provider = Arc::new(ReplyProvider {
        reply,
        calls: Mutex::new(0),
    });
    state.provider_runtime.register_for_test(provider.clone());
    (Arc::new(state), provider)
}

/// A user-authored rubric judge: no lexical seed backs it.
fn custom_judge() -> Evaluator {
    let mut ev = EvaluatorRegistry::new()
        .get("toxicity")
        .expect("toxicity seeded")
        .clone();
    ev.id = "no_patient_records".into();
    ev.builtin = false;
    ev.impl_ = EvaluatorImpl::LlmJudge {
        rubric: "Flag any protected health information about a patient.".into(),
    };
    ev
}

async fn flag(ev: &Evaluator, reply: &'static str, text: &str) -> (bool, String, usize) {
    flag_in(state(reply), ev, &FirewallPolicy::Block, text).await
}

async fn flag_in(
    (state, provider): (Arc<AppState>, Arc<ReplyProvider>),
    ev: &Evaluator,
    action: &FirewallPolicy,
    text: &str,
) -> (bool, String, usize) {
    let ctx = super::test_support::plain_request_context();
    let scanner = state.resolved_scanner(&ctx);
    let outcome = flag_inline_binding(ev, action, scanner.as_ref(), text, &state, &ctx).await;
    let calls = *provider.calls.lock().unwrap();
    match outcome {
        InlineFlag::Ran { flagged, reason } => (flagged, reason, calls),
        InlineFlag::Denied(error) => panic!("judge denied: {error:?}"),
        InlineFlag::Skip => panic!("binding skipped"),
        InlineFlag::ForceBlock { reason } => panic!("force block: {reason}"),
    }
}

const RECORD: &str = "Patient Jane Roe, twelve Elm Street, was diagnosed with a rare condition.";

// GuardBreaker against a custom judge: the bait makes it refuse, or answer in
// prose, which used to read as clean because no seed backs a custom rubric.
#[tokio::test]
async fn a_custom_judge_that_refuses_or_answers_without_a_verdict_flags() {
    for reply in [
        "I'm sorry, but I can't help with that.",
        r#"{"reason": "ok"}"#,
        "Paris",
        "This text looks fine to me.",
    ] {
        let (flagged, reason, calls) = flag(&custom_judge(), reply, RECORD).await;
        assert!(flagged, "{reply}: {reason}");
        assert!(reason.contains("gave no verdict"), "{reason}");
        assert_eq!(calls, 1);
    }
}

#[tokio::test]
async fn answers_and_provider_style_gaps_keep_their_meaning() {
    let (flagged, _, _) = flag(&custom_judge(), r#"{"flagged": false}"#, RECORD).await;
    assert!(!flagged, "a clean verdict stays clean");
    let (flagged, reason, _) = flag(
        &custom_judge(),
        r#"{"flagged": true, "categories": ["phi"], "reason": "a patient record"}"#,
        RECORD,
    )
    .await;
    assert!(flagged && reason == "a patient record");
}

// A seeded judge (toxicity) keeps its seed as the floor for a malformed
// reply, but a refusal flags it too.
#[tokio::test]
async fn a_seeded_judge_flags_a_refusal_and_keeps_the_seed_for_other_gaps() {
    let toxicity = EvaluatorRegistry::new()
        .get("toxicity")
        .expect("toxicity seeded")
        .clone();
    let benign = "Thanks for the lovely afternoon at the park with the family.";
    let (flagged, reason, _) = flag(&toxicity, "I cannot evaluate this.", benign).await;
    assert!(flagged && reason.contains("refused"), "{reason}");
    for reply in [r#"{"reason": "ok"}"#, "Paris"] {
        let (flagged, _, _) = flag(&toxicity, reply, benign).await;
        assert!(
            !flagged,
            "{reply}: a non-answer over a seed-clean text stays open"
        );
    }
}

// inline-judge outage: a custom rubric bound to Block has no seed to fall
// back on, so under a closed fail mode an unreachable judge flags it; an
// open fail mode, or a binding that does not block, keeps serving.
#[tokio::test]
async fn an_unreachable_judge_flags_a_blocking_custom_rubric_under_a_closed_fail_mode() {
    let unreachable = |fail_mode| state_routed("unused", "no-such-judge", fail_mode);
    let block = FirewallPolicy::Block;
    let (flagged, reason, _) = flag_in(unreachable(None), &custom_judge(), &block, RECORD).await;
    assert!(flagged, "{reason}");
    assert!(reason.contains("provider_unavailable"), "{reason}");

    let open = Some(InspectorFailMode::Open);
    let (flagged, _, _) = flag_in(unreachable(open), &custom_judge(), &block, RECORD).await;
    assert!(!flagged, "an open fail mode serves through an outage");
    let warn = FirewallPolicy::WarnAndContinue;
    let (flagged, _, _) = flag_in(unreachable(None), &custom_judge(), &warn, RECORD).await;
    assert!(!flagged, "a binding that does not block keeps serving");
    let toxicity = EvaluatorRegistry::new()
        .get("toxicity")
        .expect("toxicity seeded")
        .clone();
    let benign = "Thanks for the lovely afternoon at the park with the family.";
    let (flagged, _, _) = flag_in(unreachable(None), &toxicity, &block, benign).await;
    assert!(!flagged, "a seeded judge keeps its seed as the floor");
}
