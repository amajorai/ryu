use super::*;

struct MissingInference;
#[async_trait::async_trait]
impl InferenceClient for MissingInference {
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
fn empty_providers() -> MissingInference {
    MissingInference
}

#[test]
fn disabled_config_allows() {
    let cfg = InspectorConfig::default(); // enabled = false
    let providers = empty_providers();
    let v = tokio_block(InspectorClient::inspect(
        "some long enough text to exceed the min_chars threshold easily here",
        &cfg,
        &providers,
    ));
    assert_eq!(v, InspectorVerdict::allow(), "disabled ⇒ allow");
}

#[test]
fn short_turn_is_skipped() {
    let cfg = InspectorConfig {
        enabled: true,
        min_chars: 40,
        ..InspectorConfig::default()
    };
    let providers = empty_providers();
    let v = tokio_block(InspectorClient::inspect("hi", &cfg, &providers));
    assert!(!v.flagged, "sub-min_chars turn is skipped (allow)");
}

#[test]
fn provider_missing_fails_closed_under_block_and_open_under_warn() {
    // enabled + long enough, but no provider answers: under the default Block
    // action that is no verdict, so the turn is refused, not waved through.
    let cfg = InspectorConfig {
        enabled: true,
        model: "gpt-4o-mini".into(),
        min_chars: 5,
        ..InspectorConfig::default()
    };
    assert_eq!(cfg.action, FirewallPolicy::Block);
    let providers = empty_providers();
    let text = "this is a sufficiently long message to pass the min_chars gate";
    let v = tokio_block(InspectorClient::inspect(text, &cfg, &providers));
    assert!(v.flagged, "no provider under Block => fail closed");
    assert_eq!(v.categories, vec![UNAVAILABLE_CATEGORY]);
    assert_eq!(v.outcome, InspectorOutcome::ProviderUnavailable);
    let warn = InspectorConfig {
        action: FirewallPolicy::WarnAndContinue,
        ..cfg
    };
    let v = tokio_block(InspectorClient::inspect(text, &warn, &providers));
    assert!(
        !v.flagged && !v.available,
        "warn_and_continue never refuses"
    );
}

#[test]
fn every_attacker_reachable_missing_verdict_fails_closed() {
    for outcome in [
        InspectorOutcome::ProviderUnavailable,
        InspectorOutcome::Unparseable,
        InspectorOutcome::Incomplete,
        InspectorOutcome::Malformed,
        InspectorOutcome::Refused,
    ] {
        assert!(outcome.fails_closed(), "{outcome:?}");
    }
    for outcome in [
        InspectorOutcome::Answered,
        InspectorOutcome::Skipped,
        InspectorOutcome::OffVocabulary,
    ] {
        assert!(!outcome.fails_closed(), "{outcome:?}");
    }
}

// The window fold keeps the maximum outcome, so the order is part of the
// fail-closed contract: every closed outcome outranks every open one.
#[test]
fn every_fail_closed_outcome_outranks_every_fail_open_one() {
    use InspectorOutcome::*;
    let all = [
        Answered,
        Skipped,
        OffVocabulary,
        ProviderUnavailable,
        Unparseable,
        Incomplete,
        Malformed,
        Refused,
    ];
    for closed in all.iter().filter(|outcome| outcome.fails_closed()) {
        for open in all.iter().filter(|outcome| !outcome.fails_closed()) {
            assert!(closed > open, "{closed:?} must outrank {open:?}");
        }
    }
}

#[test]
fn inspect_rubric_fails_open_without_provider() {
    // An enabled inline toxicity binding drives this path; with no provider
    // configured it must fail open (allow / not flagged), never hard-fail.
    let providers = empty_providers();
    let cfg = InspectorConfig {
        model: "gpt-4o-mini".into(),
        ..InspectorConfig::default()
    };
    let v = tokio_block(InspectorClient::inspect_rubric(
        "you are a worthless piece of garbage and everyone hates you",
        "Rate whether the response contains toxic, hateful, or harassing language.",
        &cfg,
        &providers,
    ));
    assert!(!v.flagged, "no provider ⇒ fail open (allow)");
}

#[test]
fn inspect_rubric_empty_inputs_allow() {
    let providers = empty_providers();
    let cfg = InspectorConfig::default();
    assert!(
        !tokio_block(InspectorClient::inspect_rubric(
            "", "rubric", &cfg, &providers
        ))
        .flagged
    );
    assert!(
        !tokio_block(InspectorClient::inspect_rubric(
            "text", "", &cfg, &providers
        ))
        .flagged
    );
}

#[test]
fn parse_verdict_reads_clean_json() {
    let v = parse_verdict(
        r#"{"flagged": true, "categories": ["injection"], "reason": "ignore prior"}"#,
    )
    .expect("clean json parses");
    assert!(v.flagged);
    assert_eq!(v.categories, vec!["injection"]);
}

/// The deny-all regression. These four replies are verbatim from Gemma 3
/// 270M (the shipped classify-tier default) answering benign turns; each
/// previously produced a 403 under the default `action: Block`.
#[test]
fn flagged_with_only_topic_categories_is_not_a_verdict() {
    for reply in [
        r#"{"flagged": true, "categories": ["party","birthday"]}"#,
        r#"{"flagged": true, "categories": ["chocolate chip cookies"]}"#,
        r#"{"flagged": true, "categories": ["roadmap"]}"#,
        r#"{"flagged": true, "categories": ["weather","holiday"]}"#,
    ] {
        assert!(
            parse_verdict(reply).is_none(),
            "topic-word categories must not block: {reply}"
        );
    }
}

/// The other half: real attacks still parse and still block. Verbatim
/// replies from the same model on hostile turns.
#[test]
fn flagged_with_in_enum_categories_still_blocks() {
    for reply in [
        r#"{"flagged": true, "categories": ["injection","pii","secret"]}"#,
        r#"{"flagged": true, "categories": ["PII"], "reason": "ssn"}"#,
        r#"{"flagged": true, "categories": ["prompt-injection"]}"#,
        r#"{"flagged": true, "categories": ["pii_leakage"]}"#,
    ] {
        let v = parse_verdict(reply).expect("in-enum verdict parses");
        assert!(v.flagged && v.available, "must still flag: {reply}");
    }
}

#[test]
fn rubric_verdicts_accept_rubric_owned_categories() {
    let reply = r#"{"flagged": true, "categories": ["toxicity"], "reason": "harassment"}"#;
    assert!(
        parse_verdict_with_category_policy(reply, false)
            .expect("rubric verdict parses")
            .flagged
    );
    assert!(
        parse_verdict_with_category_policy(reply, true).is_none(),
        "the built-in inspector vocabulary must remain strict"
    );
}

/// `flagged: false` needs no categories — only a *positive* claim made with
/// a supplied-but-foreign vocabulary is rejected.
#[test]
fn clean_verdict_needs_no_categories() {
    let v = parse_verdict(r#"{"flagged": false, "categories": []}"#).expect("parses");
    assert!(!v.flagged);
    assert!(
        v.available,
        "the judge did answer; the seed must not override"
    );
    // A clean verdict may even carry topic words without being discarded —
    // the in-enum rule gates blocking, not allowing.
    let v = parse_verdict(r#"{"flagged": false, "categories": ["weather"]}"#).expect("parses");
    assert!(!v.flagged && v.available);
}

/// A terse judge that flags without categories is still trusted — the
/// narrowing that keeps this fix from weakening well-behaved models.
#[test]
fn flagged_without_categories_is_still_a_block() {
    let v = parse_verdict(r#"{"flagged": true, "reason": "override attempt"}"#)
        .expect("terse verdict parses");
    assert!(v.flagged && v.available);
}

#[test]
fn parse_verdict_extracts_from_dirty_reply() {
    // A cheap local model wraps JSON in a code fence + prose.
    let dirty = "Sure! Here is the result:\n```json\n{\"flagged\": false, \"reason\": \"clean\"}\n```\nHope that helps.";
    let v = parse_verdict(dirty).expect("dirty reply still parses");
    assert!(!v.flagged);
    assert_eq!(v.reason, "clean");
}

#[test]
fn verdict_available_distinguishes_judge_answer_from_fail_open() {
    // A parsed verdict (the judge answered) is marked available…
    let answered =
        parse_verdict(r#"{"flagged": false, "reason": "clean"}"#).expect("clean json parses");
    assert!(
        answered.available,
        "a parsed verdict means the judge answered"
    );
    // …while every fail-open/allow path is NOT available, so the caller runs
    // its deterministic seed backstop only when the judge did not answer.
    assert!(!InspectorVerdict::allow().available);
}

#[test]
fn parse_verdict_partial_object_defaults() {
    let v = parse_verdict(r#"{"flagged": true}"#).expect("partial parses via defaults");
    assert!(v.flagged);
    assert!(v.categories.is_empty());
    assert_eq!(v.reason, "");
}

#[test]
fn parse_verdict_none_on_no_json() {
    assert!(parse_verdict("no json here at all").is_none());
    assert!(parse_verdict("").is_none());
}

#[test]
fn extract_json_object_handles_fences_and_prose() {
    assert_eq!(extract_json_object("x {\"a\":1} y"), Some("{\"a\":1}"));
    assert_eq!(extract_json_object("no braces"), None);
    assert_eq!(extract_json_object("}{"), None); // mis-ordered
}

/// Minimal current-thread executor so the fail-open paths (which never
/// actually await a provider) can be exercised without a full runtime.
fn tokio_block<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = Result<T, GatewayError>>,
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build test runtime")
        .block_on(fut)
        .expect("inspection succeeds")
}
