use serde_json::json;

use crate::*;

fn config(rate: f32) -> EvalsConfig {
    EvalsConfig {
        enabled: true,
        max_latency_ms: 10_000,
        sample_rate: rate,
        stream_usage: true,
        default_model: None,
        judge_model: None,
        online: Default::default(),
    }
}

#[test]
fn sample_rate_one_always_samples() {
    let runner = EvalsRunner::new(config(1.0));
    for _ in 0..10 {
        assert!(runner.should_sample());
    }
}

#[test]
fn sample_rate_zero_never_samples() {
    let runner = EvalsRunner::new(config(0.0));
    for _ in 0..10 {
        assert!(!runner.should_sample());
    }
}

#[test]
fn sample_rate_quarter_keeps_roughly_one_in_four() {
    let runner = EvalsRunner::new(config(0.25));
    let kept = (0..100).filter(|_| runner.should_sample()).count();
    // Deterministic 1-in-4 spacing => exactly 25 of the first 100.
    assert_eq!(kept, 25);
}

#[test]
fn disabled_runner_never_samples() {
    let mut cfg = config(1.0);
    cfg.enabled = false;
    let runner = EvalsRunner::new(cfg);
    assert!(!runner.should_sample());
}

#[test]
fn provider_score_tracks_recorded_scores() {
    let runner = EvalsRunner::new(config(1.0));
    assert!(runner.provider_score("openai").is_none());

    runner.record_provider_score("openai", 0.9);
    let first = runner.provider_score("openai").expect("scored once");
    assert!((first - 0.9).abs() < 1e-3);

    // A lower follow-up pulls the EMA down but stays above the new sample.
    runner.record_provider_score("openai", 0.1);
    let second = runner.provider_score("openai").expect("scored twice");
    assert!(second < first);
    assert!(second > 0.1);
}

#[test]
fn all_provider_scores_snapshots_scored_providers() {
    let runner = EvalsRunner::new(config(1.0));
    assert!(runner.all_provider_scores().is_empty());

    runner.record_provider_score("openai", 0.8);
    runner.record_provider_score("anthropic", 0.6);
    let scores = runner.all_provider_scores();
    assert_eq!(scores.len(), 2);
    assert!((scores["openai"] - 0.8).abs() < 1e-3);
    assert!((scores["anthropic"] - 0.6).abs() < 1e-3);
}

#[test]
fn score_attaches_overall_in_range() {
    let runner = EvalsRunner::new(config(1.0));
    let response = json!({
        "usage": { "prompt_tokens": 100, "completion_tokens": 100 }
    });
    let result = runner.score(1000, &response, true).expect("scored");
    assert!(result.overall >= 0.0 && result.overall <= 1.0);
    assert!(result.policy_pass);
}
