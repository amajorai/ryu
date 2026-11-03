//! The Inspector stage follows `inspector.fail_mode`: a closed mode flags
//! every missing verdict, an open mode lets it through, whatever the action.
use super::*;

/// A judge with no provider behind it: every call is `ProviderUnavailable`.
struct NoJudge;

#[async_trait::async_trait]
impl InferenceClient for NoJudge {
    fn scope(&self) -> String {
        "test".into()
    }
    async fn complete(
        &self,
        _model: &str,
        _body: serde_json::Value,
        _timeout: u64,
    ) -> Result<Option<serde_json::Value>, GatewayError> {
        Ok(None)
    }
    async fn embed(
        &self,
        _model: &str,
        _text: &str,
        _timeout: u64,
    ) -> Result<Option<Vec<f32>>, GatewayError> {
        Ok(None)
    }
}

const TURN: &str = "this is a sufficiently long message to pass the min_chars gate";

fn cfg(action: FirewallPolicy, fail_mode: Option<InspectorFailMode>) -> InspectorConfig {
    InspectorConfig {
        enabled: true,
        model: "judge".into(),
        min_chars: 5,
        action,
        fail_mode,
        ..InspectorConfig::default()
    }
}

fn inspect(cfg: &InspectorConfig) -> InspectorVerdict {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(InspectorClient::inspect(TURN, cfg, &NoJudge))
        .unwrap()
}

const NON_ANSWERS: [InspectorOutcome; 5] = [
    InspectorOutcome::Refused,
    InspectorOutcome::Malformed,
    InspectorOutcome::Incomplete,
    InspectorOutcome::Unparseable,
    InspectorOutcome::ProviderUnavailable,
];

#[test]
fn explicit_open_lets_an_unjudged_turn_through_under_block() {
    let v = inspect(&cfg(FirewallPolicy::Block, Some(InspectorFailMode::Open)));
    assert!(!v.flagged, "{v:?}");
    assert!(!v.available);
    assert_eq!(v.outcome, InspectorOutcome::ProviderUnavailable);
}

#[test]
fn the_default_under_block_still_fails_closed() {
    let v = inspect(&cfg(FirewallPolicy::Block, None));
    assert!(v.flagged);
    assert_eq!(v.categories, vec![UNAVAILABLE_CATEGORY]);
}

#[test]
fn explicit_closed_flags_an_unjudged_turn_under_warn() {
    let v = inspect(&cfg(
        FirewallPolicy::WarnAndContinue,
        Some(InspectorFailMode::Closed),
    ));
    assert!(v.flagged, "{v:?}");
    assert_eq!(v.categories, vec![UNAVAILABLE_CATEGORY]);
    assert_eq!(v.outcome, InspectorOutcome::ProviderUnavailable);
}

#[test]
fn explicit_closed_keeps_the_unavailable_flag_under_sanitize() {
    let v = inspect(&cfg(
        FirewallPolicy::Sanitize,
        Some(InspectorFailMode::Closed),
    ));
    assert!(
        v.flagged,
        "an unavailable flag is not an injection-only flag"
    );
    assert_eq!(v.categories, vec![UNAVAILABLE_CATEGORY]);
}

#[test]
fn closed_flags_every_non_answer_and_open_flags_none() {
    for action in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        for outcome in NON_ANSWERS {
            let missing = || InspectorVerdict {
                outcome,
                ..InspectorVerdict::allow()
            };
            let closed = fail_closed(
                missing(),
                &cfg(action.clone(), Some(InspectorFailMode::Closed)),
            );
            assert!(closed.flagged, "{action:?} {outcome:?}");
            assert_eq!(closed.categories, vec![UNAVAILABLE_CATEGORY]);
            let open = fail_closed(
                missing(),
                &cfg(action.clone(), Some(InspectorFailMode::Open)),
            );
            assert!(!open.flagged, "{action:?} {outcome:?}");
        }
    }
}

#[test]
fn closed_never_flags_an_answer_a_skip_or_topic_words() {
    let closed = cfg(FirewallPolicy::Block, Some(InspectorFailMode::Closed));
    for outcome in [
        InspectorOutcome::Answered,
        InspectorOutcome::Skipped,
        InspectorOutcome::OffVocabulary,
    ] {
        let v = fail_closed(
            InspectorVerdict {
                outcome,
                ..InspectorVerdict::allow()
            },
            &closed,
        );
        assert!(!v.flagged, "{outcome:?}");
    }
}

#[test]
fn a_bare_action_keeps_the_action_default() {
    let missing = InspectorVerdict {
        outcome: InspectorOutcome::Refused,
        ..InspectorVerdict::allow()
    };
    assert!(fail_closed(missing.clone(), &FirewallPolicy::Block).flagged);
    assert!(!fail_closed(missing.clone(), &FirewallPolicy::Sanitize).flagged);
    assert!(!fail_closed(missing, &FirewallPolicy::WarnAndContinue).flagged);
}
