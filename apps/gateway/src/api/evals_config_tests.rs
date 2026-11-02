//! Evaluator configuration: online-eval validation, live custom evaluators,
//! builtin detectors scored offline, and the configured judge model.

use super::run_evals_tests::eval_state;
use crate::config::GatewayConfig;

#[test]
fn online_config_rejects_unknown_or_unavailable_evaluators() {
    let mut config = GatewayConfig::default();
    config.evals.online.enabled = true;
    config.evals.online.evaluators = vec!["does_not_exist".to_owned()];
    assert!(crate::state::validate_online_evals(&config)
        .unwrap_err()
        .contains("unknown evaluator"));
    config.evals.online.evaluators = vec!["code_checker".to_owned()];
    assert!(crate::state::validate_online_evals(&config).is_err());
    config.evals.online.evaluators = vec!["pii_leakage".to_owned()];
    assert!(crate::state::validate_online_evals(&config).is_ok());
}

/// Custom evaluators saved through `PUT /v1/config` apply to the live
/// registry without a restart.
#[test]
fn custom_evaluators_swap_live() {
    use crate::evaluators::{
        Capabilities, Evaluator, EvaluatorCategory, EvaluatorImpl, EvaluatorTarget, OfflineConfig,
    };
    let state = eval_state();
    assert!(state.evaluator_registry().get("no_refunds").is_none());
    state.update_custom_evaluators(vec![Evaluator {
        id: "no_refunds".to_owned(),
        name: "No refunds".to_owned(),
        description: "Flags refund promises".to_owned(),
        category: EvaluatorCategory::Custom,
        target: EvaluatorTarget::Output,
        capabilities: Capabilities {
            inline: true,
            offline: true,
        },
        impl_: EvaluatorImpl::Builtin {
            detector: "secret".to_owned(),
        },
        inline: None,
        offline: Some(OfflineConfig {
            threshold: 0.5,
            judge_model: None,
        }),
        builtin: false,
        enforced: true,
        higher_is_better: true,
    }]);
    let registry = state.evaluator_registry();
    let evaluator = registry.get("no_refunds").expect("live custom evaluator");
    assert!(!evaluator.builtin);
    assert!(evaluator.unavailable_offline_reason().is_none());
    assert!(evaluator.unavailable_inline_reason().is_none());
}

#[test]
fn builtin_evaluator_scores_offline_with_firewall_detectors() {
    let case = crate::evals::EvalCase {
        prompt: "q".to_owned(),
        ..Default::default()
    };
    let flagged = super::score_builtin(
        "secrets",
        "custom",
        crate::evaluators::EvaluatorTarget::Output,
        "secret",
        &case,
        "the key is sk-abcdefghijklmnopqrstuvwxyz0123",
    );
    assert!(flagged.executed && !flagged.pass);
    assert_eq!(flagged.score, 0.0);
    let clean = super::score_builtin(
        "secrets",
        "custom",
        crate::evaluators::EvaluatorTarget::Output,
        "secret",
        &case,
        "nothing sensitive",
    );
    assert!(clean.executed && clean.pass);
    let unknown = super::score_builtin(
        "x",
        "custom",
        crate::evaluators::EvaluatorTarget::Output,
        "nope",
        &case,
        "text",
    );
    assert!(!unknown.executed);
}

#[test]
fn configured_judge_model_is_trimmed_and_optional() {
    let mut config = GatewayConfig::default();
    assert_eq!(super::configured_judge_model(&config), None);
    config.evals.judge_model = Some("  ".to_owned());
    assert_eq!(super::configured_judge_model(&config), None);
    config.evals.judge_model = Some(" judge ".to_owned());
    assert_eq!(
        super::configured_judge_model(&config).as_deref(),
        Some("judge")
    );
}
