use super::*;

fn enabled_config() -> OnlineEvalsConfig {
    OnlineEvalsConfig {
        enabled: true,
        sample_rate: 0.5,
        evaluators: vec!["pii_leakage".to_owned()],
        ..OnlineEvalsConfig::default()
    }
}

#[test]
fn disabled_by_default_and_without_evaluators() {
    assert!(OnlineEvalsConfig::default().resolve(LOCAL_TENANT).is_none());
    let mut config = enabled_config();
    config.evaluators.clear();
    assert!(config.resolve(LOCAL_TENANT).is_none());
}

#[test]
fn tenant_overrides_inherit_and_opt_out() {
    let mut config = enabled_config();
    config.judge_model = Some("judge-a".to_owned());
    config.tenants.insert(
        "org-1".to_owned(),
        OnlineTenantConfig {
            sample_rate: Some(1.0),
            judge_model: Some("judge-b".to_owned()),
            ..OnlineTenantConfig::default()
        },
    );
    config.tenants.insert(
        "org-2".to_owned(),
        OnlineTenantConfig {
            enabled: Some(false),
            ..OnlineTenantConfig::default()
        },
    );
    let base = config.resolve("other").expect("inherits global");
    assert_eq!(base.sample_rate, 0.5);
    assert_eq!(base.judge_model.as_deref(), Some("judge-a"));
    let org1 = config.resolve("org-1").expect("override");
    assert_eq!(org1.sample_rate, 1.0);
    assert_eq!(org1.judge_model.as_deref(), Some("judge-b"));
    assert_eq!(org1.evaluators, vec!["pii_leakage".to_owned()]);
    assert!(config.resolve("org-2").is_none());
}

#[test]
fn validate_rejects_out_of_range_rates_and_empty_ids() {
    let mut config = enabled_config();
    config.sample_rate = 1.5;
    assert!(config.validate().is_err());
    let mut config = enabled_config();
    config.evaluators.push(" ".to_owned());
    assert!(config.validate().is_err());
    assert!(enabled_config().validate().is_ok());
}

#[test]
fn sampling_is_deterministic_and_close_to_rate() {
    assert!(sampled("anything", 1.0));
    assert!(!sampled("anything", 0.0));
    assert_eq!(sampled("req-42", 0.3), sampled("req-42", 0.3));
    let hits = (0..10_000)
        .filter(|i| sampled(&format!("req-{i}"), 0.25))
        .count();
    assert!((2_200..=2_800).contains(&hits), "hits = {hits}");
}

#[test]
fn traceparent_parsing_rejects_invalid_ids() {
    assert_eq!(
        trace_id_from_traceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")
            .as_deref(),
        Some("4bf92f3577b34da6a3ce929d0e0e4736")
    );
    assert!(
        trace_id_from_traceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")
            .is_none()
    );
    assert!(trace_id_from_traceparent("garbage").is_none());
}

#[test]
fn clip_text_respects_char_boundaries() {
    assert_eq!(clip_text("héllo", 2), "hé");
    assert_eq!(clip_text("hi", 10), "hi");
}

#[test]
fn config_round_trips_through_toml_shaped_json() {
    let config: OnlineEvalsConfig = serde_json::from_value(serde_json::json!({
        "enabled": true,
        "evaluators": ["toxicity"],
        "tenants": { "org-9": { "sample_rate": 0.0 } }
    }))
    .expect("parse");
    assert_eq!(config.sample_rate, 0.05);
    assert!(config.resolve("org-9").is_none());
    assert!(config.resolve("other").is_some());
}
