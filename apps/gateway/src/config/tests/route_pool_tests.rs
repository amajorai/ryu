use super::*;

#[test]
fn glob_matching_is_case_insensitive_and_anchored() {
    assert!(glob_matches("claude-*", "Claude-Sonnet-4-5"));
    assert!(glob_matches(
        "*claude*",
        "openrouter/anthropic/claude-opus-4"
    ));
    assert!(glob_matches("gpt-4o", "gpt-4o"));
    assert!(!glob_matches("gpt-4o", "gpt-4o-mini"));
    assert!(glob_matches("gpt-*-mini", "gpt-4o-mini"));
    assert!(!glob_matches("claude-*", "openrouter/claude-x"));
    assert!(glob_matches("*", "anything"));
    assert!(glob_matches("a*b*c", "aXXbYYc"));
    assert!(!glob_matches("a*b*c", "aXXbYY"));
}

#[test]
fn pool_lists_combine_and_blank_lists_do_not_constrain() {
    let open = RoutePool {
        allowed_models: vec![" ".into()],
        allowed_providers: Vec::new(),
    };
    assert!(open.is_unrestricted());
    assert!(open.allows("anything", "any"));
    let pool = RoutePool {
        allowed_models: vec!["*claude*".into(), "gpt-*".into()],
        allowed_providers: vec!["OpenRouter".into(), "anthropic".into()],
    };
    assert!(pool.allows("claude-sonnet-4-5", "anthropic"));
    assert!(pool.allows("openrouter/anthropic/claude-opus-4", "openrouter"));
    assert!(
        !pool.allows("gpt-4o", "openai"),
        "provider outside the pool"
    );
    assert!(
        !pool.allows("gemini-2.5-pro", "openrouter"),
        "model outside the pool"
    );
}

#[test]
fn restriction_drops_rules_and_collapses_tiers() {
    let config = SmartRoutingConfig {
        rules: vec![
            SmartRule {
                description: "a".into(),
                model: "claude-x".into(),
                weight: 1.0,
            },
            SmartRule {
                description: "b".into(),
                model: "gpt-x".into(),
                weight: 1.0,
            },
        ],
        default_model: Some("gemini-x".into()),
        stage_capable_model: "claude-x".into(),
        stage_efficient_model: "gemini-x".into(),
        escalation_weak_model: "gemini-x".into(),
        escalation_strong_model: "llama-x".into(),
        escalation_judge_model: "judge-x".into(),
        ..Default::default()
    };
    let restricted =
        config.restricted_to(|model| model.starts_with("claude") || model.starts_with("gpt"));
    assert_eq!(
        restricted
            .rules
            .iter()
            .map(|rule| rule.model.as_str())
            .collect::<Vec<_>>(),
        ["claude-x", "gpt-x"]
    );
    assert_eq!(restricted.default_model, None);
    assert_eq!(restricted.stage_capable_model, "claude-x");
    assert_eq!(restricted.stage_efficient_model, "claude-x");
    assert!(restricted.escalation_weak_model.is_empty());
    assert!(restricted.escalation_strong_model.is_empty());
    assert_eq!(
        restricted.escalation_judge_model, "judge-x",
        "the judge is not a target"
    );

    // A router missing a tier does not become active through restriction.
    let half = SmartRoutingConfig {
        enabled: true,
        router_type: ModelRouterType::StageRouter,
        stage_capable_model: "claude-x".into(),
        ..Default::default()
    };
    assert!(!half.restricted_to(|_| true).is_active());
}
